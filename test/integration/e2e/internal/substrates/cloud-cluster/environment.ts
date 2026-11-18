import {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from '@kubernetes/client-node';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import * as semver from 'semver';
import { z } from 'zod';
import type { DeleteReport } from '../../../../../../src/cli/services/seed-delete.js';

import { OWNER_API_TAG } from '../../../../../../src/api/services/api-identity.js';
import { hostedApiIdentity } from '../../../../../../src/shared/hosted-api-identity.js';
import {
  clusterSummarySchema,
  type ClusterSummary,
} from '../../../../../../src/shared/api-contract/clusters-schemas.js';
import { seedInstallation, type SeedInstallation } from './seed.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../../../src/shared/workload.js';
import type { ArtifactStore } from '../../artifacts.js';
import type { CleanupStack } from '../../cleanup.js';
import type { CliClient } from '../../cli.js';
import { cliArgs, type CliPath } from '../../cli-surface.js';
import { CliDatabase, escapedSql } from '../../database.js';
import type { ProcessRunner } from '../../process.js';
import type { VmProfile } from '../../profiles.js';
import type { TargetHttpClient } from '../../transports/http.js';
import type { CommandResult } from '../../types.js';
import { errorMessage, isRecord } from '../../types.js';
import {
  retryTransientProbeError,
  WaitTimeoutError,
  type Waiter,
} from '../../wait.js';
import {
  type DnsResolutionOptions,
  resolveDnsRecord,
  sweepDnsRecords,
} from './dns-records.js';
import { createStorageProvider } from '../../../../../../src/api/services/cloud-config.js';
import {
  canListBuckets,
  type CloudBucketLister,
} from '../../../../../../src/api/services/gateways/cloud.js';
import { clusterApiUrl } from '../../../../../../src/shared/api-ingress.js';
import { SERVICE_ACCOUNT_ISSUER_DISCOVERY_PATH } from '../../../../../../src/api/services/kubernetes/service-account-issuer.js';
import type {
  DeadApiDeleteRecord,
  KeptBucketRecord,
  ServiceAccountIssuerRecord,
} from '../../contracts/cluster-cloud.js';
import { AzurePoolInventory } from './azure-pool.js';
import { GcpPoolInventory } from './gcp-pool.js';
import { E2E_CLUSTER_NAME_PREFIX } from './names.js';
import { credentialsNewArgs } from './hosted-stage.js';
import {
  hostedKubeConfig,
  readHelmState,
  readHostedPodLogs,
  withinDeadline,
} from './hosted-pod-logs.js';

type ClusterProvider = 'aws' | 'gcp' | 'azure';

/**
 * The management VM's resource scope (`clusterNetworkScope`): its
 * VM and network carry `anycloud_resource=<scope>` on GCP and Azure, which
 * the GCP and Azure inventories read.
 */
export function managementScope(clusterId: string): string {
  return `anycloud-cluster-${clusterId}`.slice(0, 63);
}

function providerOf(cloud: CloudType): ClusterProvider | null {
  return cloud === CloudType.GCP
    ? 'gcp'
    : cloud === CloudType.Azure
      ? 'azure'
      : cloud === CloudType.AWS
        ? 'aws'
        : null;
}

type ClusterInventory = Pick<
  GcpPoolInventory,
  'liveInstances' | 'networkLeftovers'
>;

/**
 * Every create and delete verb this tree's CLI runs lives here, typed against
 * the generated CLI surface, so a renamed verb is a compile error in this
 * file alone.
 */
const API_CREATE = 'api create' satisfies CliPath;
const API_DELETE = 'api delete' satisfies CliPath;

/** The group a `from_release` CLI creates and deletes with: 0.1.78 and earlier had `cluster create|delete`. */
const releasedLifecycleGroup = (version: string): 'cluster' | 'api' =>
  semver.lte(version, '0.1.78') ? 'cluster' : 'api';

/**
 * Lane S6's `api delete --json` report (`DeleteReport`): what was deleted
 * and what remains (RFC 0049 C26 (d), C28), each resource once.
 */
const deleteEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('managementVm'),
      id: z.string(),
      stopped: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cloudResource'),
      type: z.string(),
      id: z.string(),
      location: z.string().nullable(),
      selector: z.string().optional(),
      reason: z.string().optional(),
      error: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('dnsRecord'), name: z.string() }).strict(),
  z
    .object({
      kind: z.literal('checkpointBucket'),
      name: z.string(),
      managed: z.boolean(),
      reason: z.enum(['kept', 'supplied']).optional(),
      restoreCommand: z.string().optional(),
      deleteCommand: z.string().optional(),
    })
    .strict(),
]);
const deleteReportSchema = z
  .object({
    outcome: z.enum(['destroyed', 'abandoned', 'planned']),
    clusterId: z.string(),
    finalBackup: z.enum(['taken', 'failed', 'skipped']).nullable(),
    deleted: z.array(deleteEntrySchema),
    remaining: z.array(deleteEntrySchema),
  })
  .strict() satisfies z.ZodType<DeleteReport>;
type ParsedDeleteReport = z.output<typeof deleteReportSchema>;

/** S6 reports a deleted bucket as the cloud resource it was, never as a checkpointBucket. */
function deletedBucket(report: ParsedDeleteReport, name: string): boolean {
  return report.deleted.some(
    (entry) =>
      entry.kind === 'cloudResource' &&
      entry.type === 'bucket' &&
      entry.id === name,
  );
}

/** One entry as the dead-API record lists it. */
function entryName(entry: ParsedDeleteReport['deleted'][number]): string {
  return `${entry.kind}:${'name' in entry ? entry.name : entry.id}`;
}

const CLUSTER_LIST = 'cluster list' satisfies CliPath;
const API_UPGRADE = 'api upgrade' satisfies CliPath;

/** Tags the product puts on the AWS resources this member creates. */
const CLUSTER_TAG = 'anycloud_cluster';
const BACKUP_OBJECT_KEY = 'anycloud-api/database.sqlite';
/**
 * Every installer inventory read owns this budget, independent of the time an
 * outer wait has left: a read that fails must report how it failed, and the
 * wait that runs out reports that in its own words.
 */
const INVENTORY_READ_BUDGET_MS = 30_000;
/** The hosted Pod log capture's bound, so a hung read never holds the cleanup. */
const HOSTED_LOGS_DEADLINE_MS = 60_000;

export interface CloudClusterEnvironmentOptions {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: CleanupStack;
  readonly cli: Pick<CliClient, 'run'>;
  /**
   * `from_release`: the installer runs this published release, whose CLI
   * saves the credentials and creates the cluster; this tree's `api upgrade`
   * then moves the installer (its data in `installerDirectory`) to this tree.
   */
  readonly fromRelease?: {
    readonly cli: Pick<CliClient, 'run'>;
    readonly version: string;
    readonly installerDirectory: string;
  };
  readonly database: CliDatabase;
  /** `from_release`: the installer's data directory, whose cipher key opens its cluster connection. */
  readonly installerDirectory?: string;
  readonly http: Pick<TargetHttpClient, 'get'>;
  /**
   * The management VM's cloud credential; AWS, GCP or Azure. The runner's
   * cloud CLI is signed in as it, and this tree's `api create` and
   * `api delete` drive that CLI as the user's session (RFC 0049 C26 (e));
   * only a released installer saves it.
   */
  readonly profile: VmProfile;
  readonly region: string;
  readonly managementVmType: string;
  /** Test seams for a GCP or Azure management VM: its VM and network, and its checkpoint buckets. */
  readonly clusterInventory?: ClusterInventory;
  readonly clusterStorage?: CloudBucketLister;
  /** Tests: removes the bucket a delete kept, instead of the storage gateway. */
  readonly clusterBucketDeleter?: { deleteBucket(name: string): Promise<void> };
  readonly runId: string;
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly wait: Pick<Waiter, 'for'>;
  /** The account that published the installation's DNS record; `fetch`, the resolution and `lookup4` are test seams. */
  readonly dns: DnsResolutionOptions & {
    readonly token: string;
    readonly fetch?: typeof fetch;
    /** The runner's own resolver, IPv4 only, as the CLI's fetch sees it. */
    readonly lookup4?: (hostname: string) => Promise<unknown>;
  };
}

export interface NativeLeftovers {
  readonly instances: readonly string[];
  readonly securityGroups: readonly string[];
  readonly volumes: readonly string[];
  readonly buckets: readonly string[];
  /** The seed's stack, resource group or management VM, and what is still tagged `anycloud_cluster` for it but the kept bucket. */
  readonly installation: readonly string[];
  /** `<installation id>.anycloud.sh` still resolving after the destroy, or a check that could not be made. */
  readonly dnsRecords: readonly string[];
  /** True when the cluster was still live at sweep time: DNS is left to the workflow's post-teardown sweep. */
  readonly dnsDeferred: boolean;
}

export interface CloudClusterRunRecord {
  readonly runId: string;
  readonly region: string;
  readonly clusterProvider: ClusterProvider;
  readonly installationId: string | null;
  /**
   * The hosted API's `anycloud_owner_api` tag value, known once bootstrap
   * returns: every VM that API creates carries it. Absent with an
   * installation id, the cluster never reached running.
   */
  readonly hostedApiIdentity: string | null;
}

const versionSchema = z.object({ version: z.string().min(1) }).loose();
const issuerDiscoverySchema = z
  .object({ issuer: z.string(), jwks_uri: z.string() })
  .loose();
const jwksSchema = z
  .object({ keys: z.array(z.object({ kid: z.string() }).loose()) })
  .loose();
/** A released installer's cluster, read only for its id. */
const createdSchema = z.object({ id: z.string().min(1) }).loose();
/**
 * A released installer's cluster record, read loosely: 0.1.65 reports
 * `bootstrapping`, `ready`, `failed` and `destroyed`; 0.1.66 the workload
 * states, from `provisioning` to `running`, `failed` and `terminated`.
 */
const releasedClusterSchema = z
  .object({
    name: z.string(),
    state: z.string(),
    releasing: z.boolean().optional(),
    lastError: z.string().nullable().optional(),
    apiImage: z.string().nullable().optional(),
    release: z.object({ apiImage: z.string() }).loose().nullable().optional(),
  })
  .loose();
type ReleasedCluster = z.output<typeof releasedClusterSchema>;
/**
 * Creation still running (0.1.65's `bootstrapping`, then the workload states
 * a released or this tree's installer reports); `api delete` is refused
 * until it settles.
 */
const CLUSTER_CREATING: readonly string[] = [
  'bootstrapping',
  'provisioning',
  'initializing',
  'starting',
];
const RELEASED_CLUSTER_UP: readonly string[] = ['ready', 'running'];
/**
 * An installer released before this fix looks its host up before Cloudflare
 * serves it, and the runner's resolver caches that NXDOMAIN for the zone's
 * 1800 s negative TTL. Both bounds run from the Release step
 * (`starting`). Until the floor some caches behind the resolver still serve
 * that NXDOMAIN while others answer A, so no lookup can end the wait sooner.
 */
const RELEASED_NXDOMAIN_FLOOR_MS = (1800 + 90) * 1000;
const RELEASED_NXDOMAIN_DEADLINE_MS = 35 * 60_000;
const RELEASED_DNS_INTERVAL_MS = 15_000;
const CLUSTER_GONE: readonly string[] = ['destroyed', 'terminated'];
/**
 * Cleanup's own bound for a running creation to settle before delete. With
 * the 40-minute bootstrap and the 15-minute delete it leaves five minutes of
 * the 65-minute test budget (130 with from_release) for the sweeps.
 */
const CLEANUP_SETTLE_MS = 300_000;
/** Create prints the cluster's id once it is recorded, before any cloud mutation. */
const CREATED_ID = /\(ID: (?<id>[^)\s]+)\)/u;
/** This tree's delete of a cluster the hosted API doesn't know: create failed before the API answered. */
const NO_LEDGER = /create ledgers nor the active API know cluster/u;
/** The installer refuses a CLI of another version. */
const INSTALLER_VERSION_MISMATCH = /must exactly match API version/u;
/** Delete asks the hosted API for its node pools, and an older one refuses this CLI. */
const HOSTED_API_OLDER =
  /hosted API at (?<url>\S+) refused this CLI's version: the hosted API \([^)]+\) is older than this CLI \((?<cli>[^)]+)\)/u;

function isolatedAwsEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => /^AWS_/u.test(name))
      .map((name) => [name, undefined]),
  );
}

function successful(result: CommandResult, operation: string): CommandResult {
  if (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted &&
    !result.spawnError &&
    !result.outputTruncated
  ) {
    return result;
  }
  throw new Error(
    `${operation} failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}): ${result.combined}`,
  );
}

function parseJson(result: CommandResult, operation: string): unknown {
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

/**
 * Real-cloud sibling of the local cluster: this tree's CLI bootstraps the
 * management VM in its own process (a `from_release` run, the released
 * installer), node pools join it through the hosted API and the production
 * join path, and every resource is swept natively afterwards.
 */
export class CloudClusterEnvironment {
  readonly #options: CloudClusterEnvironmentOptions;
  readonly #clusterName: string;
  /** A GCP or Azure management VM's VM and network; null on AWS, which reads them with the AWS CLI. */
  readonly #clusterInventory: ClusterInventory | null;
  #cluster: ClusterSummary | undefined;
  #destroyed = false;
  /** What this tree's `api delete` deleted and kept (RFC 0049 C26 (d), C28). */
  #deleteResult: ParsedDeleteReport | undefined;
  #keptBucketRemoved = false;
  /** `from_release`: set once this CLI's `api upgrade` has moved the installer to this tree. */
  #installerUpgraded = false;
  /** The hosted stage sent `api upgrade`: an older hosted API may still be rolling out. */
  #hostedUpgradeRequested = false;
  /** This run's installation id, known once `api create` returns it. */
  #installationId: string | undefined;
  /** Bootstrap waited out its budget for creation to settle: cleanup does not wait again. */
  #creationStuck = false;
  /** This tree's `api create` ran: its installation may need deleting. */
  #createStarted = false;
  /** The runner's cloud CLI session, signed in once per run. */
  #session: Promise<Record<string, string | undefined>> | undefined;
  /** The e2e access kubeconfig, read from the checkpoint bucket after create. */
  #accessKubeConfig: string | undefined;
  #objectFile: Promise<string> | undefined;
  #prepared = false;

  constructor(options: CloudClusterEnvironmentOptions) {
    this.#options = options;
    this.#clusterName = `${E2E_CLUSTER_NAME_PREFIX}-${options.runId}`;
    const cluster = options.profile;
    this.#clusterInventory =
      cluster.provider === CloudType.GCP
        ? (options.clusterInventory ?? new GcpPoolInventory(cluster.credential))
        : cluster.provider === CloudType.Azure
          ? (options.clusterInventory ??
            new AzurePoolInventory(cluster.credential, options.region))
          : null;
  }

  /** The management VM's cloud; everything cluster-side is read there. */
  get clusterProvider(): ClusterProvider {
    const provider = providerOf(this.#options.profile.provider);
    if (!provider) {
      throw new Error(
        `The live cluster member runs no cluster on ${this.#options.profile.provider}`,
      );
    }
    return provider;
  }

  /**
   * The managed checkpoint bucket is named after the installation id; the
   * product creates it during bootstrap and deletes it with the installation.
   */
  get bucket(): string {
    return this.cluster().id;
  }

  /**
   * `from_release`: the released installer's `cluster create --credentials`
   * reads the cluster's credential, which its own CLI saves (it refuses this
   * tree's client version). This tree's create drives the runner's
   * signed-in cloud CLI instead.
   */
  async prepare(): Promise<void> {
    if (this.#prepared) return;
    this.#prepared = true;
    const { profile, fromRelease } = this.#options;
    if (!fromRelease) return;
    successful(
      await fromRelease.cli.run(
        credentialsNewArgs(profile.credentialName, profile.credential),
        { label: 'released-credentials-new' },
      ),
      'credentials new (released installer)',
    );
  }

  /**
   * The user's cloud session for the seed (RFC 0049 C26 (e)): the runner's
   * own `aws`, `gcloud` or `az`, signed in as the cluster credential in a
   * private configuration directory, so neither the runner's default sign-in
   * nor another run's reaches this one. AWS's CLI reads the keys from the
   * environment.
   */
  #sessionEnvironment(): Promise<Record<string, string | undefined>> {
    // One sign-in, however many reads ask for it at once.
    return (this.#session ??= this.#signIn());
  }

  async #signIn(): Promise<Record<string, string | undefined>> {
    const credential = this.#options.profile.credential;
    if (credential.cloudProvider === CloudType.AWS) {
      return { ...this.#awsEnvironment(), AWS_REGION: this.#options.region };
    }
    if ('kind' in credential) {
      throw new Error(
        `The ${credential.cloudProvider} cluster member needs a key, not a role`,
      );
    }
    const directory = await mkdtemp(join(tmpdir(), 'e2e-cloud-session-'));
    this.#options.cleanup.defer('cloud CLI session', () =>
      rm(directory, { recursive: true, force: true }),
    );
    // The sign-in carries a secret: never an artifact.
    const signIn = async (
      executable: string,
      args: string[],
      env: Record<string, string>,
    ) =>
      successful(
        await this.#options.runner.run(executable, args, {
          env,
          label: `${executable}-sign-in`,
          recordArtifact: false,
          timeoutMs: 120_000,
        }),
        `${executable} sign-in`,
      );
    if (credential.cloudProvider === CloudType.GCP) {
      const env = {
        CLOUDSDK_CONFIG: directory,
        CLOUDSDK_CORE_PROJECT: credential.projectId,
      };
      const key = join(directory, 'key.json');
      await writeFile(
        key,
        JSON.stringify({
          type: 'service_account',
          project_id: credential.projectId,
          client_email: credential.clientEmail,
          private_key: credential.privateKey,
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
        { mode: 0o600 },
      );
      await signIn(
        'gcloud',
        [
          'auth',
          'activate-service-account',
          credential.clientEmail,
          `--key-file=${key}`,
          '--quiet',
        ],
        env,
      );
      // gcloud keeps its own copy in CLOUDSDK_CONFIG.
      await rm(key, { force: true });
      return env;
    }
    if (credential.cloudProvider === CloudType.Azure) {
      const env = { AZURE_CONFIG_DIR: directory };
      await signIn(
        'az',
        [
          'login',
          '--service-principal',
          '--username',
          credential.applicationId,
          '--password',
          credential.secret,
          '--tenant',
          credential.directoryId,
          '--output',
          'none',
        ],
        env,
      );
      await signIn(
        'az',
        ['account', 'set', '--subscription', credential.subscriptionId],
        env,
      );
      return env;
    }
    throw new Error(
      `The cluster member runs no cluster on ${credential.cloudProvider}`,
    );
  }

  /** The GCP project or Azure subscription the seed creates in. */
  #seedAccount(): string {
    const credential = this.#options.profile.credential;
    if ('kind' in credential) return '';
    if ('projectId' in credential) return credential.projectId;
    if ('subscriptionId' in credential) return credential.subscriptionId;
    return '';
  }

  /** The installation as the cloud shows it, through the runner's CLI session. */
  #seed(): SeedInstallation {
    return seedInstallation(
      this.clusterProvider,
      async (executable, args, options) =>
        this.#options.runner.run(executable, args, {
          ...options,
          env: await this.#sessionEnvironment(),
          timeoutMs: options?.timeoutMs ?? 120_000,
        }),
      { region: this.#options.region, account: this.#seedAccount() },
      async () => {
        // One download file per run, reused by every poll.
        this.#objectFile ??= mkdtemp(join(tmpdir(), 'e2e-seed-object-')).then(
          (directory) => {
            this.#options.cleanup.defer('seed object download', () =>
              rm(directory, { recursive: true, force: true }),
            );
            return join(directory, 'object');
          },
        );
        const path = await this.#objectFile;
        return { path, read: () => readFile(path, 'utf8') };
      },
    );
  }

  /**
   * Where this tree's CLI reads the cluster once create returns: the hosted
   * API, until delete removes it.
   */
  #clusterApiEnvironment(): Record<string, string> {
    if (this.#destroyed) return {};
    // A create that failed after recording its id still has its hostname.
    const url =
      this.#cluster?.managementApiUrl ??
      (this.#installationId ? clusterApiUrl(this.#installationId) : undefined);
    return url ? { API_URL: url } : {};
  }

  /**
   * `anycloud api create`, the seed: it drives the runner's cloud CLI,
   * signed in as the cluster's credential, and returns once the hosted API
   * answers; without `--checkpoint-bucket` the product manages the bucket. A
   * released installer's create is polled to running instead. Destroy is
   * registered before the request so a half-finished installation is still
   * torn down through the product's own path.
   */
  async bootstrap(
    timeoutMs: number,
    destroyTimeoutMs = 900_000,
  ): Promise<ClusterSummary> {
    if (this.#cluster) throw new Error('Cluster already created');
    const { fromRelease } = this.#options;
    // Cleanup runs newest first: the cloud CLI session is made before the
    // cluster's delete is registered, so that delete (this tree's, also after
    // a from_release upgrade) still has it.
    await this.#sessionEnvironment();
    this.#options.cleanup.defer(`cluster ${this.#clusterName}`, () =>
      this.#destroyIfPresent(destroyTimeoutMs),
    );
    // One budget for the whole bootstrap, however its steps divide it; a wait
    // never gets less than its 10 s poll interval.
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(10_000, deadline - Date.now());
    if (!fromRelease) return this.#bootstrapInProcess(remaining());
    // The released create waits for the cluster itself.
    const group = releasedLifecycleGroup(fromRelease.version);
    const result = successful(
      // The released CLI's own surface: it creates through its local API.
      await fromRelease.cli.run(
        [
          group,
          'create',
          this.#clusterName,
          '--credentials',
          this.#options.profile.credentialName,
          '--region',
          this.#options.region,
          '--vm-type',
          this.#options.managementVmType,
          '--json',
        ],
        { timeoutMs: remaining(), label: 'released-create' },
      ),
      `${group} create (released)`,
    );
    const { id } = createdSchema.parse(
      parseJson(result, `${group} create (released)`),
    );
    this.#installationId = id;
    // Recorded before bootstrap runs: the workflow sweep scopes to this id.
    await this.#recordRun();
    let releasedAt: number | undefined;
    const created = await this.#noteStuck(
      this.#settled(
        'released cluster creation settled',
        async () => {
          const released = await this.#releasedCluster(fromRelease.cli);
          // From `starting` on, its Release step has published DNS.
          const state = released?.state ?? 'bootstrapping';
          if (state === 'starting' || !CLUSTER_CREATING.includes(state))
            releasedAt ??= Date.now();
          return released;
        },
        remaining(),
        'fail',
      ),
    );
    if (!created || !RELEASED_CLUSTER_UP.includes(created.state)) {
      throw new Error(
        `the ${fromRelease.version} installer's cluster is ${created?.state ?? 'absent'}: ${created?.lastError ?? ''}`,
      );
    }
    // The operator's path: this CLI's `api upgrade` restarts the local API
    // on its own release over the same data (`ANYCLOUD_UPDATE_BIN`).
    const ran = await this.#options.cli.run(cliArgs(API_UPGRADE, {}), {
      env: { ANYCLOUD_DIR: fromRelease.installerDirectory },
      timeoutMs: 300_000,
      label: 'installer-upgrade',
    });
    // From here the installer is presumed this tree's; cleanup falls back
    // to the released CLI if it still refuses this one.
    this.#installerUpgraded = true;
    const upgraded = successful(ran, 'api upgrade (installer)');
    if (
      !upgraded.combined.includes(
        `Local API server is on ${fromRelease.version};`,
      )
    ) {
      throw new Error(
        `api upgrade did not restart the ${fromRelease.version} installer: ${upgraded.combined}`,
      );
    }
    // The upgraded installer holds the record, and this tree's `cluster list`
    // reads hosted APIs: the cluster is read at its hosted API, with the
    // pinned image the released installer reported.
    const hosted = (
      await this.#clusterList(
        { API_URL: clusterApiUrl(id) },
        'cluster-list-after-upgrade',
      )
    ).find((entry) => entry.id === id);
    if (!hosted) {
      throw new Error(`the hosted API of cluster ${id} does not list it`);
    }
    const cluster: ClusterSummary = {
      ...hosted,
      apiImage: created.apiImage ?? created.release?.apiImage ?? null,
    };
    await this.#resolvesAtRunner(cluster.managementApiUrl!, releasedAt!);
    this.#cluster = cluster;
    await this.#recordRun();
    return cluster;
  }

  /**
   * This tree's create: the CLI prints the cluster's id first, which is
   * recorded for the workflow's sweep even when create then fails or runs out
   * of time, and on failure prints the failed cluster.
   */
  async #bootstrapInProcess(timeoutMs: number): Promise<ClusterSummary> {
    const deadline = Date.now() + timeoutMs;
    this.#createStarted = true;
    const access = await mkdtemp(join(tmpdir(), 'e2e-access-'));
    this.#options.cleanup.defer('e2e access kubeconfig', () =>
      rm(access, { recursive: true, force: true }),
    );
    this.#accessKubeConfig = join(access, 'kubeconfig');
    const result = await this.#options.cli.run(
      cliArgs(
        API_CREATE,
        {
          cloud: this.clusterProvider,
          region: this.#options.region,
          'vm-type': this.#options.managementVmType,
          json: true,
        },
        [this.#clusterName],
      ),
      {
        env: {
          ...(await this.#sessionEnvironment()),
          // The startup script then leaves an e2e access kubeconfig in the
          // checkpoint bucket (lane S5).
          ANYCLOUD_E2E_ACCESS: '1',
        },
        timeoutMs,
        label: 'api-create',
      },
    );
    // A running cluster is the one JSON document; a failed or cut-short
    // create leaves only its printed id.
    const printed = clusterSummarySchema.safeParse(
      (() => {
        try {
          return JSON.parse(result.stdout) as unknown;
        } catch {
          return undefined;
        }
      })(),
    );
    const cluster = printed.success ? printed.data : undefined;
    this.#installationId =
      cluster?.id ?? CREATED_ID.exec(result.combined)?.groups?.id;
    if (this.#installationId) await this.#recordRun();
    if (result.timedOut) this.#creationStuck = true;
    if (
      !cluster ||
      cluster.state !== WorkloadState.Running ||
      !cluster.connected ||
      !cluster.kubernetesIdentity ||
      !cluster.managementApiUrl
    ) {
      await this.#captureConsole();
      throw new Error(
        `api create failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}): ${cluster ? `${cluster.state}: ${cluster.lastError ?? ''}` : result.combined}`,
      );
    }
    this.#installationId = cluster.id;
    this.#cluster = cluster;
    await this.#recordRun();
    await this.#readAccessKubeConfig(
      cluster,
      Math.min(300_000, Math.max(10_000, deadline - Date.now())),
    );
    return cluster;
  }

  /**
   * The management VM's boot log after a failed create, for the run's
   * artifacts: what the startup script did when the API never served.
   * Best effort; a failed read is noted in the artifact instead.
   */
  async #captureConsole(): Promise<void> {
    const id = this.#installationId;
    if (!id) return;
    const output = await this.#seed()
      .consoleOutput(id)
      .catch(
        (error: unknown) =>
          `console output unavailable: ${errorMessage(error)}`,
      );
    // Never in place of the create error it explains.
    await this.#options.artifacts
      .json('management-vm-console', {
        clusterId: id,
        cloud: this.clusterProvider,
        output,
      })
      .catch(() => undefined);
  }

  /** The e2e access kubeconfig the startup script wrote to the checkpoint bucket, read with the runner's session. */
  async #readAccessKubeConfig(
    cluster: ClusterSummary,
    timeoutMs: number,
  ): Promise<void> {
    const bucket = cluster.checkpointBucket?.name;
    if (!bucket)
      throw new Error(`cluster ${cluster.id} names no checkpoint bucket`);
    const seed = this.#seed();
    const kubeconfig = await this.#options.wait.for(
      `the e2e access kubeconfig in ${bucket}`,
      async () => (await seed.accessKubeconfig(bucket)) ?? undefined,
      {
        timeoutMs,
        probeError: 'fail',
        unmet: (value) => (value ? undefined : 'not written yet'),
      },
    );
    await writeFile(this.#accessKubeConfig!, kubeconfig!, { mode: 0o600 });
  }

  /** Waits out the cached NXDOMAIN, then for the runner's resolver to answer an A record for the hosted API. */
  async #resolvesAtRunner(url: string, releasedAt: number): Promise<void> {
    const host = new URL(url).hostname;
    const lookup4 =
      this.#options.dns.lookup4 ??
      ((hostname: string) => lookup(hostname, { family: 4 }));
    const floor = new Date(releasedAt + RELEASED_NXDOMAIN_FLOOR_MS);
    process.stderr.write(
      `Waiting until ${floor.toISOString()}, when ${host}'s cached NXDOMAIN has expired, then for the runner's resolver to answer an A record\n`,
    );
    await this.#options.wait.for(
      `${host} A record at the runner's resolver`,
      async () =>
        Date.now() < floor.getTime()
          ? `the cached NXDOMAIN may be served until ${floor.toISOString()}`
          : lookup4(host).then(
              () => undefined,
              (error: unknown) =>
                `no A record: ${(error as { code?: string }).code ?? errorMessage(error)}`,
            ),
      {
        timeoutMs: Math.max(
          RELEASED_DNS_INTERVAL_MS,
          releasedAt + RELEASED_NXDOMAIN_DEADLINE_MS - Date.now(),
        ),
        intervalMs: RELEASED_DNS_INTERVAL_MS,
        probeError: 'fail',
        unmet: (failure) => failure,
      },
    );
    process.stderr.write(
      `${host} answered an A record at ${new Date().toISOString()}\n`,
    );
  }

  cluster(): ClusterSummary {
    if (!this.#cluster) throw new Error('Cluster is not created');
    return this.#cluster;
  }

  /**
   * The installation as this tree's CLI lists it, re-read at the hosted API,
   * until delete removes it.
   */
  async clusters(): Promise<readonly ClusterSummary[]> {
    return this.#clusterList(this.#clusterApiEnvironment(), 'cluster-list');
  }

  async #clusterList(
    env: Record<string, string>,
    label: string,
  ): Promise<readonly ClusterSummary[]> {
    // `cluster list --json` prints the array, not the API response.
    return z.array(clusterSummarySchema).parse(
      parseJson(
        successful(
          await this.#options.cli.run(cliArgs(CLUSTER_LIST, { json: true }), {
            env,
            timeoutMs: 60_000,
            label,
          }),
          'cluster list',
        ),
        'cluster list',
      ),
    );
  }

  /**
   * Unauthenticated readiness read of the hosted API on the management-node
   * route, until a 200 within a minute, as the edge may answer otherwise just
   * after origin TLS turns strict. Each non-200's status, body and edge
   * headers are kept as its HTTP artifact.
   */
  async hostedVersion(): Promise<string> {
    const url = new URL('/v1/version', this.cluster().managementApiUrl!);
    const response = await this.#options.wait.for(
      'hosted API version read',
      () =>
        this.#options.http.get('hosted-api-version', url, {
          timeoutMs: 30_000,
        }),
      {
        timeoutMs: 60_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ status }) =>
          status === 200
            ? undefined
            : `hosted API version read returned ${status}`,
      },
    );
    return versionSchema.parse(response.body).version;
  }

  /**
   * What a cloud reads to validate a role connection's token: Node's fetch is
   * no browser, so a Cloudflare challenge answers it with a non-200 HTML page.
   */
  async serviceAccountIssuer(): Promise<ServiceAccountIssuerRecord> {
    const read = async (label: string, url: URL) => {
      const response = await this.#options.http.get(label, url, {
        timeoutMs: 30_000,
      });
      if (response.status !== 200) {
        throw new Error(
          `${url.href} answered ${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`,
        );
      }
      return response.body;
    };
    const discovery = issuerDiscoverySchema.parse(
      await read(
        'hosted-issuer-discovery',
        new URL(SERVICE_ACCOUNT_ISSUER_DISCOVERY_PATH, this.hostedUrl),
      ),
    );
    const jwks = jwksSchema.parse(
      await read('hosted-issuer-jwks', new URL(discovery.jwks_uri)),
    );
    return {
      issuer: discovery.issuer,
      jwksUri: discovery.jwks_uri,
      keyIds: jwks.keys.map((key) => key.kid),
    };
  }

  /**
   * Versions of the hosted API's backup object in the checkpoint bucket, on
   * AWS. Only the hosted journeys assert on it, and they run only on an AWS
   * management VM, so a GCP or Azure run records null.
   */
  async backupObjectVersions(): Promise<number | null> {
    if (this.#clusterInventory) return null;
    const listing = parseJson(
      await this.#aws(
        [
          's3api',
          'list-object-versions',
          '--bucket',
          this.bucket,
          '--prefix',
          BACKUP_OBJECT_KEY,
        ],
        'backup object versions',
      ),
      'backup object versions',
    );
    return isRecord(listing) && Array.isArray(listing.Versions)
      ? listing.Versions.length
      : 0;
  }

  /** The hosted API's public URL from the cluster record. */
  get hostedUrl(): string {
    return this.cluster().managementApiUrl!;
  }

  noteHostedUpgrade(): void {
    this.#hostedUpgradeRequested = true;
  }

  /**
   * `api delete`, through the runner's signed-in cloud CLI as the
   * user's session; it returns once the cluster is gone. It keeps the managed
   * checkpoint bucket after a final backup unless `deleteBuckets` (RFC 0049
   * C28), which needs `--confirm` without a terminal.
   */
  async destroy(
    timeoutMs: number,
    deleteBuckets = false,
  ): Promise<ClusterSummary> {
    await this.#delete(timeoutMs, deleteBuckets);
    return {
      ...this.cluster(),
      state: WorkloadState.Terminated,
      releasing: false,
    };
  }

  /** The delete itself, also for cleanup, when create may have recorded no cluster. */
  async #delete(timeoutMs: number, deleteBuckets: boolean): Promise<void> {
    const id = this.#installationId ?? this.#clusterName;
    const result = deleteReportSchema.parse(
      parseJson(
        successful(
          await this.#options.cli.run(
            cliArgs(
              API_DELETE,
              {
                json: true,
                // Used only when the hosted API no longer answers.
                cloud: this.clusterProvider,
                region: this.#options.region,
                ...(deleteBuckets
                  ? { 'delete-buckets': true, confirm: id }
                  : {}),
              },
              [id],
            ),
            {
              env: {
                ...(await this.#sessionEnvironment()),
                ...this.#clusterApiEnvironment(),
              },
              timeoutMs,
              label: 'api-delete',
            },
          ),
          'api delete',
        ),
        'api delete',
      ),
    );
    if (
      result.outcome !== 'destroyed' ||
      (this.#installationId !== undefined &&
        result.clusterId !== this.#installationId)
    ) {
      throw new Error(
        `api delete reported ${result.outcome} for ${result.clusterId}: ${JSON.stringify(result.remaining)}`,
      );
    }
    this.#destroyed = true;
    this.#deleteResult = result;
  }

  /**
   * The cluster deleted as from a second machine once its API is gone (RFC
   * 0049 C26 (c), lane S6): the runner's cloud CLI stops the management VM,
   * and once `https://<id>.anycloud.sh` no longer answers, this tree's CLI,
   * in a fresh home that knows only the cluster's hostname, runs `api delete
   * <id> --cloud --region`, which plans and deletes nothing, then with
   * `--delete-vms`, `--delete-buckets` and `--skip-cloud`.
   */
  async destroyWithoutApi(timeoutMs: number): Promise<DeadApiDeleteRecord> {
    const cluster = this.cluster();
    const id = cluster.id;
    const home = await mkdtemp(join(tmpdir(), 'e2e-second-machine-'));
    this.#options.cleanup.defer('second machine home', () =>
      rm(home, { recursive: true, force: true }),
    );
    const steps: DeadApiDeleteRecord['steps'][number][] = [];
    const run = async (flags: string[], expected: string | undefined) => {
      const result = await this.#options.cli.run(
        cliArgs(
          API_DELETE,
          {
            cloud: this.clusterProvider,
            region: this.#options.region,
            'delete-vms': flags.includes('--delete-vms'),
            'delete-buckets': flags.includes('--delete-buckets'),
            'skip-cloud': flags.includes('--skip-cloud'),
            ...(flags.includes('--confirm') ? { confirm: id } : {}),
            json: true,
          },
          [id],
        ),
        {
          env: {
            ...(await this.#sessionEnvironment()),
            HOME: home,
            ANYCLOUD_DIR: join(home, '.anycloud'),
            // What a second machine knows: the hostname, nothing stored.
            API_URL: cluster.managementApiUrl!,
          },
          timeoutMs,
          label: `api-delete-dead-api${flags[0] ?? ''}`,
        },
      );
      const report = deleteReportSchema.parse(
        parseJson(successful(result, 'api delete'), 'api delete'),
      );
      if (expected !== undefined && report.outcome !== expected) {
        throw new Error(
          `api delete ${flags.join(' ')} with the API gone: ${report.outcome}, not ${expected}`,
        );
      }
      const deleted = report.deleted.map(entryName);
      steps.push({ flags, outcome: report.outcome, deleted });
      return report;
    };
    // Registered before the VM stops, so it runs before the home goes: a
    // journey that fails past this point still deletes everything.
    let cloudGone = false;
    let stopped = false;
    this.#options.cleanup.defer(`cluster ${id} without its API`, async () => {
      if (cloudGone || !stopped) return;
      await run(
        ['--delete-vms', '--delete-buckets', '--confirm', id],
        undefined,
      );
      // Gone through the dead-API path: cleanup's normal delete has nothing left.
      this.#destroyed = true;
    });
    // Set first: a stop issued whose wait then fails still needs the fallback.
    stopped = true;
    await this.#seed().stopManagementVm(id);
    // Cloudflare answers 52x for a gone origin: the API is up only when its
    // health route says `ok` (as lane S6's delete judges it).
    await this.#options.wait.for(
      `${id}'s hosted API gone`,
      async () =>
        fetch(new URL('/health', cluster.managementApiUrl!), {
          signal: AbortSignal.timeout(10_000),
        }).then(
          async (response) =>
            response.ok && (await response.text()).trim() === 'ok'
              ? 'answers ok'
              : undefined,
          () => undefined,
        ),
      {
        timeoutMs: CLEANUP_SETTLE_MS,
        probeError: 'fail',
        unmet: (answer) => answer,
      },
    );
    if ((await run([], 'planned')).deleted.length > 0) {
      throw new Error('api delete without --delete-vms deleted something');
    }
    await run(['--delete-vms', '--confirm', id], 'destroyed');
    const buckets = await run(
      ['--delete-buckets', '--confirm', id],
      'destroyed',
    );
    // The sweep reads the cloud for the bucket, after its own settle wait.
    if (!deletedBucket(buckets, id)) {
      throw new Error(
        `api delete --delete-buckets did not report the bucket ${id} deleted`,
      );
    }
    // Nothing left in the cloud: cleanup's fallback would only be refused.
    cloudGone = true;
    await run(['--skip-cloud', '--confirm', id], 'abandoned');
    this.#destroyed = true;
    return { steps };
  }

  async keptBucket(): Promise<KeptBucketRecord> {
    const kept = await this.#keptAfterDelete();
    await this.#deleteKeptBucket();
    return kept;
  }

  /**
   * The kept bucket deleted once its API is gone (lane S6): `api delete
   * <id> --delete-buckets --confirm <id>` with `--cloud` and `--region`, which
   * the CLI needs when no hosted API can name them.
   */
  async #deleteKeptBucket(): Promise<void> {
    const id = this.cluster().id;
    const report = deleteReportSchema.parse(
      parseJson(
        successful(
          await this.#options.cli.run(
            cliArgs(
              API_DELETE,
              {
                'delete-buckets': true,
                confirm: id,
                cloud: this.clusterProvider,
                region: this.#options.region,
                json: true,
              },
              [id],
            ),
            {
              env: {
                ...(await this.#sessionEnvironment()),
                // Its hostname, which no longer answers.
                API_URL: this.cluster().managementApiUrl!,
              },
              timeoutMs: 300_000,
              label: 'api-delete-kept-bucket',
            },
          ),
          'api delete --delete-buckets (kept bucket)',
        ),
        'api delete --delete-buckets (kept bucket)',
      ),
    );
    if (!deletedBucket(report, id)) {
      throw new Error(
        `api delete --delete-buckets did not delete the kept bucket ${id}: ${JSON.stringify(report)}`,
      );
    }
    this.#keptBucketRemoved = true;
  }

  /** The managed bucket the last delete kept after a final backup, still there. */
  async #keptAfterDelete(): Promise<Extract<KeptBucketRecord, { kept: true }>> {
    const id = this.cluster().id;
    const kept = this.#deleteResult?.remaining.find(
      (resource) => resource.kind === 'checkpointBucket',
    );
    if (
      kept?.kind !== 'checkpointBucket' ||
      kept.name !== id ||
      !kept.managed ||
      this.#deleteResult?.finalBackup !== 'taken'
    ) {
      throw new Error(
        `api delete did not keep the managed bucket ${id} after a final backup: ${JSON.stringify(kept ?? null)}`,
      );
    }
    if (!(await this.#checkpointBuckets()).includes(id)) {
      throw new Error(`api delete deleted the kept bucket ${id}`);
    }
    return { name: id, kept: true, finalBackup: 'taken' };
  }

  /**
   * RFC 0049 C28's restore, on the seed: after the delete that kept the
   * managed bucket, `api create --checkpoint-bucket <id>` brings the
   * cluster back from it under the same ID and hostname, its record read
   * back from the restored database, then `api delete --delete-buckets`
   * removes it with the bucket.
   */
  async restoreFromKeptBucket(
    bootstrapTimeoutMs: number,
    destroyTimeoutMs: number,
  ): Promise<KeptBucketRecord> {
    const kept = await this.#keptAfterDelete();
    const lost = this.cluster();
    // The restore publishes DNS and a VM again: cleanup deletes them if it fails.
    this.#destroyed = false;
    const result = await this.#options.cli.run(
      cliArgs(
        API_CREATE,
        {
          cloud: this.clusterProvider,
          region: this.#options.region,
          'vm-type': this.#options.managementVmType,
          'checkpoint-bucket': kept.name,
          json: true,
        },
        [this.#clusterName],
      ),
      {
        env: await this.#sessionEnvironment(),
        timeoutMs: bootstrapTimeoutMs,
        label: 'cluster-restore',
      },
    );
    if (
      result.exitCode !== 0 &&
      (await this.#seed().installation(lost.id)).kind === 'absent'
    ) {
      // Refused before it made anything: cleanup removes the kept bucket.
      this.#destroyed = true;
    }
    const restored = clusterSummarySchema.parse(
      parseJson(
        successful(result, 'api create --checkpoint-bucket (restore)'),
        'api create --checkpoint-bucket (restore)',
      ),
    );
    if (
      restored.id !== lost.id ||
      restored.state !== WorkloadState.Running ||
      !restored.managementApiUrl ||
      restored.managementApiUrl !== lost.managementApiUrl ||
      !restored.checkpointBucket?.managed
    ) {
      throw new Error(
        `the restore did not bring back ${lost.id} at ${lost.managementApiUrl ?? ''} with its managed bucket: ${JSON.stringify(restored)}`,
      );
    }
    this.#cluster = restored;
    // Its hosted API lists the cluster from the restored database's record.
    const listed = (await this.clusters()).find(
      (entry) => entry.id === lost.id,
    );
    if (!listed) {
      throw new Error(
        `the restored hosted API does not list cluster ${lost.id}`,
      );
    }
    const servedVersion = await this.hostedVersion();
    await this.destroy(destroyTimeoutMs, true);
    await this.bucketDeleted();
    return {
      name: kept.name,
      kept: false,
      restored: { managementApiUrl: restored.managementApiUrl, servedVersion },
    };
  }

  bucketDeleted(): Promise<KeptBucketRecord> {
    const id = this.cluster().id;
    const result = this.#deleteResult;
    if (
      !result ||
      !deletedBucket(result, id) ||
      result.remaining.some((entry) => entry.kind === 'checkpointBucket')
    ) {
      return Promise.reject(
        new Error(
          `api delete --delete-buckets left ${JSON.stringify(result?.remaining ?? null)} and deleted ${JSON.stringify(result?.deleted ?? null)}`,
        ),
      );
    }
    return Promise.resolve({ name: id, kept: false });
  }

  /**
   * Cleanup's backstop for a bucket a failed run's delete kept: removed
   * through the product's storage gateway.
   */
  async #removeKeptBucket(): Promise<void> {
    const id = this.#installationId;
    if (!id || this.#keptBucketRemoved) return;
    const { profile, region } = this.#options;
    await (
      this.#options.clusterBucketDeleter ??
      createStorageProvider({
        cloudProvider: profile.provider,
        credentials: profile.credential,
        region,
      })
    ).deleteBucket(id);
    this.#keptBucketRemoved = true;
  }

  /**
   * Native sweep by the product's own tags: nothing tagged for this run's
   * installation or hosted API may remain. The
   * checkpoint bucket is named after the installation id; before create
   * returns one there is none of this run's, and every other `e2e-clust-`
   * bucket may be a concurrent run's.
   */
  async sweep(): Promise<NativeLeftovers> {
    // A GCP or Azure management VM has no EC2 resources.
    const aws = !this.#clusterInventory;
    const filters = [
      ...(this.#installationId && aws
        ? [`Name=tag:${CLUSTER_TAG},Values=${this.#installationId}`]
        : []),
      ...(this.#cluster && aws
        ? [
            `Name=tag:${OWNER_API_TAG},Values=${hostedApiIdentity(this.#cluster.id)}`,
          ]
        : []),
    ];
    const leftovers = {
      instances: [] as string[],
      securityGroups: [] as string[],
      volumes: [] as string[],
      buckets: await this.#checkpointBuckets(),
    };
    // ListBuckets can briefly include a just-deleted bucket. Only wait after
    // successful destroy; failed journeys must retain their live resources.
    if (this.#destroyed && leftovers.buckets.length > 0) {
      try {
        await this.#options.wait.for(
          'checkpoint bucket deletion',
          async (deadlineAt) => {
            leftovers.buckets = await this.#checkpointBuckets(
              Math.max(1, deadlineAt - Date.now()),
            );
            return leftovers.buckets;
          },
          {
            timeoutMs: 60_000,
            probeError: 'fail',
            unmet: (buckets) =>
              buckets.length
                ? `Buckets remain: ${buckets.join(', ')}`
                : undefined,
          },
        );
      } catch (error) {
        // Preserve named leftovers in the sweep artifact on bounded expiry.
        // Failed inventory commands and invalid output still fail immediately.
        if (!(error instanceof WaitTimeoutError)) throw error;
      }
    }
    for (const filter of filters) {
      leftovers.instances.push(...(await this.#liveInstances(filter)));
      leftovers.securityGroups.push(
        ...(await this.#awsList(
          [
            'ec2',
            'describe-security-groups',
            '--filters',
            filter,
            '--query',
            'SecurityGroups[].GroupId',
          ],
          'sweep security groups',
        )),
      );
      leftovers.volumes.push(
        ...(await this.#awsList(
          [
            'ec2',
            'describe-volumes',
            '--filters',
            filter,
            '--query',
            'Volumes[].VolumeId',
          ],
          'sweep volumes',
        )),
      );
    }
    // A GCP or Azure management VM and its network, by its resource scope.
    if (this.#clusterInventory && this.#installationId) {
      const cloud = this.clusterProvider;
      const scope = managementScope(this.#installationId);
      leftovers.instances.push(
        ...(await this.#clusterInventory.liveInstances(scope)).map(
          (id) => `${cloud}:${id}`,
        ),
      );
      leftovers.securityGroups.push(
        ...(await this.#clusterInventory.networkLeftovers(scope)).map(
          (id) => `${cloud}:${id}`,
        ),
      );
    }
    // The Worker's delete is idempotent (2xx proves nothing): it purges; DNS
    // answers whether the destroy left the record. Only once the cluster is
    // destroyed: on a failed journey the sweep runs before the cleanup stack,
    // whose `api delete` still needs `https://<id>.anycloud.sh` — the
    // workflow's own DNS sweep step covers that path after teardown.
    const dnsRecords: string[] = [];
    if (!this.#cluster || this.#destroyed) {
      const ids = [
        ...(this.#cluster ? [this.#cluster.id] : []),
        ...leftovers.buckets,
      ];
      for (const result of await sweepDnsRecords(ids, this.#options.dns)) {
        if (result.outcome === 'failed')
          dnsRecords.push(
            `dns:${result.subdomain} (unverified: ${result.reason ?? ''})`,
          );
      }
      if (this.#cluster) {
        const id = this.#cluster.id;
        const dns = await resolveDnsRecord(id, this.#options.dns);
        if (dns.outcome !== 'clean')
          dnsRecords.push(
            `dns:${id} (${dns.outcome === 'leftover' ? `still resolves to ${dns.addresses.join(', ')}` : `unverified: ${dns.reason}`})`,
          );
      }
    }
    const swept = {
      ...leftovers,
      installation: await this.#installationLeftovers(),
      dnsRecords,
      dnsDeferred: Boolean(this.#cluster && !this.#destroyed),
    };
    await this.#options.artifacts.json('cluster-native-sweep', {
      runId: this.#options.runId,
      region: this.#options.region,
      clusterProvider: this.clusterProvider,
      filters,
      ...swept,
    });
    return swept;
  }

  async #liveInstances(
    filter: string,
    states = 'pending,running,stopping,stopped,shutting-down',
  ): Promise<string[]> {
    return this.#awsList(
      [
        'ec2',
        'describe-instances',
        '--filters',
        filter,
        `Name=instance-state-name,Values=${states}`,
        '--query',
        'Reservations[].Instances[].InstanceId',
      ],
      'describe instances',
    );
  }

  /** This run's checkpoint bucket, none before its installation id is known. */
  async #checkpointBuckets(timeoutMs = 120_000): Promise<string[]> {
    const id = this.#installationId;
    if (!id) return [];
    if (this.#clusterInventory) {
      // The product's own bucket listing for the management VM's cloud (GCS
      // buckets; containers of the shared Azure storage account).
      const { clusterStorage } = this.#options;
      const storage = clusterStorage ?? this.#clusterBucketLister();
      const signal = AbortSignal.timeout(timeoutMs);
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await storage.listBuckets(
          { pageSize: 1000, ...(cursor ? { cursor } : {}) },
          { signal },
        );
        names.push(...page.buckets.map((bucket) => bucket.name));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return names.filter((name) => name === id);
    }
    return this.#awsList(
      ['s3api', 'list-buckets', '--query', `Buckets[?Name=='${id}'].Name`],
      'sweep buckets',
      timeoutMs,
    );
  }

  /** The product's storage gateway for the management VM's cloud, as a bucket lister. */
  #clusterBucketLister(): CloudBucketLister {
    const { profile, region } = this.#options;
    const storage = createStorageProvider({
      cloudProvider: profile.provider,
      credentials: profile.credential,
      region,
    });
    if (!canListBuckets(storage)) {
      throw new Error(`${this.clusterProvider} storage cannot list buckets`);
    }
    return storage;
  }

  async #awsList(
    args: readonly string[],
    operation: string,
    timeoutMs = 120_000,
  ): Promise<string[]> {
    return stringList(
      parseJson(
        await this.#aws(args, operation, undefined, timeoutMs),
        operation,
      ),
    );
  }

  /**
   * After a hosted-stage failure, while the cluster still runs, through the
   * installer's own cluster connection: the hosted API's, Traefik's and the
   * `helm-install-*` Pods' logs, current and previous, and the Helm Jobs and
   * HelmCharts. Each part has its own minute, so a hung log read keeps the
   * Helm state. It records why it couldn't, and never throws over the failure
   * that called it.
   */
  async captureHostedApiLogs(): Promise<void> {
    const part = (read: () => Promise<unknown>) =>
      withinDeadline(
        read().catch((error: unknown) => ({
          unavailable: errorMessage(error),
        })),
        HOSTED_LOGS_DEADLINE_MS,
      );
    const config = await part(() => this.hostedKubeConfig());
    const [pods, helm] =
      config instanceof KubeConfig
        ? await Promise.all([
            part(() => readHostedPodLogs(config.makeApiClient(CoreV1Api))),
            part(() =>
              readHelmState(
                config.makeApiClient(CoreV1Api),
                config.makeApiClient(BatchV1Api),
                config.makeApiClient(CustomObjectsApi),
              ),
            ),
          ])
        : [config, config];
    await this.#options.artifacts
      .json('e2e-cluster-cloud-hosted-pod-logs', { pods, helm })
      .catch((error: unknown) => {
        process.stderr.write(
          `hosted Pod logs artifact not written: ${errorMessage(error)}\n`,
        );
      });
  }

  /**
   * The harness's connection to the cluster, for the live checks:
   * the e2e access identity this tree's create made, or the connection a
   * `from_release` installer still holds.
   */
  async hostedKubeConfig(): Promise<KubeConfig> {
    if (this.#accessKubeConfig) {
      const config = new KubeConfig();
      config.loadFromString(await readFile(this.#accessKubeConfig, 'utf8'));
      return config;
    }
    const directory = this.#options.installerDirectory;
    if (!directory)
      throw new Error('no installer directory for its cipher key');
    const [row] = await this.#inventory(
      `SELECT encrypted_connection AS connection FROM clusters WHERE id = '${escapedSql(this.cluster().id)}'`,
      'cluster connection',
    );
    if (typeof row?.connection !== 'string') {
      throw new Error('the cluster has no stored connection');
    }
    return hostedKubeConfig(
      row.connection,
      await readFile(join(directory, 'cipher.key'), 'utf8'),
    );
  }

  #inventory(
    sql: string,
    label: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.#options.database.queryComplete(
      sql,
      label,
      Date.now() + INVENTORY_READ_BUDGET_MS,
    );
  }

  /** This run's cluster as the released installer reports it, if it lists one. */
  async #releasedCluster(
    cli: Pick<CliClient, 'run'>,
  ): Promise<ReleasedCluster | undefined> {
    const label = 'cluster list (released)';
    return z
      .array(releasedClusterSchema)
      .parse(
        parseJson(
          successful(
            await cli.run(cliArgs(CLUSTER_LIST, { json: true }), {
              timeoutMs: 60_000,
              label: 'released-cluster-list',
            }),
            label,
          ),
          label,
        ),
      )
      .find((cluster) => cluster.name === this.#clusterName);
  }

  /** Waits until the hosted API at `url` serves `version`. */
  async #hostedServes(
    url: string,
    version: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.#options.wait.for(
      `hosted API serving ${version} before delete`,
      async () => {
        const response = await this.#options.http.get(
          'hosted-api-version',
          new URL('/v1/version', url),
          { timeoutMs: 30_000 },
        );
        return response.status === 200
          ? versionSchema.parse(response.body).version
          : `HTTP ${String(response.status)}`;
      },
      {
        timeoutMs,
        intervalMs: 10_000,
        probeError: retryTransientProbeError,
        unmet: (served) =>
          served === version ? undefined : `it serves ${served}`,
      },
    );
  }

  /** Marks a bootstrap that waited out its budget for creation to settle. */
  async #noteStuck<T>(waiting: Promise<T>): Promise<T> {
    try {
      return await waiting;
    } catch (error) {
      if (error instanceof WaitTimeoutError) this.#creationStuck = true;
      throw error;
    }
  }

  /** Waits until this run's cluster is no longer being created: up, failed or gone. */
  #settled<T extends { readonly state: string } | undefined>(
    label: string,
    read: () => Promise<T>,
    timeoutMs: number,
    probeError: 'fail' | typeof retryTransientProbeError,
  ): Promise<T> {
    return this.#options.wait.for(label, read, {
      timeoutMs,
      intervalMs: 10_000,
      probeError,
      unmet: (cluster) =>
        cluster && CLUSTER_CREATING.includes(cluster.state)
          ? `cluster is ${cluster.state}`
          : undefined,
    });
  }

  /**
   * This tree's cluster is deleted through its hosted API's record. A released
   * installer's runs the released API, which refuses this CLI (versions must
   * match exactly), so the released CLI deletes it until this CLI's
   * `api upgrade` moves the installer; after that, a cluster a released
   * local API created is deleted through the hosted API's record (RFC 0049
   * C26 (a)) and the released CLI
   * is the fallback. A refusal sends the delete through the other CLI once.
   */
  async #destroyIfPresent(destroyTimeoutMs: number): Promise<void> {
    const released = this.#options.fromRelease?.cli;
    if (!released) {
      await this.#destroyInProcess(destroyTimeoutMs);
      return;
    }
    const first = !this.#installerUpgraded ? released : undefined;
    try {
      await this.#destroyThrough(first, destroyTimeoutMs);
    } catch (error) {
      const message = errorMessage(error);
      if (
        !INSTALLER_VERSION_MISMATCH.test(message) &&
        !(first === undefined && NO_LEDGER.test(message))
      ) {
        throw error;
      }
      await this.#destroyThrough(
        first ? undefined : released,
        destroyTimeoutMs,
      ).catch((fallback: unknown) => {
        throw new Error(
          `${errorMessage(error)}; through the other CLI: ${errorMessage(fallback)}`,
          { cause: error },
        );
      });
    }
  }

  /**
   * This tree's delete. Create ran to its end in a process of its own, so
   * nothing is still running here; a create that failed before the hosted API
   * answered is left to the seed's dead-API fallback (lane S6) and the sweep.
   */
  async #destroyInProcess(destroyTimeoutMs: number): Promise<void> {
    // A run never leaves the bucket its delete kept.
    if (this.#destroyed) {
      if (
        this.#deleteResult?.remaining.some(
          (entry) => entry.kind === 'checkpointBucket',
        )
      )
        await this.#removeKeptBucket();
      return;
    }
    if (!this.#createStarted && !this.#installerUpgraded) return;
    // A failed run's delete takes the bucket too: nothing else removes it.
    try {
      await this.#delete(destroyTimeoutMs, true);
    } catch (error) {
      if (
        this.#createStarted &&
        !this.#cluster &&
        NO_LEDGER.test(errorMessage(error))
      ) {
        return;
      }
      // An upgrade the hosted API accepted is still rolling out: wait,
      // briefly, until it serves this CLI's version, then delete again.
      const older = HOSTED_API_OLDER.exec(errorMessage(error))?.groups;
      if (!older?.url || !older.cli) throw error;
      // Never requested, it never comes (run 40815323572 waited 300 s).
      if (!this.#hostedUpgradeRequested) {
        throw new Error(
          `${errorMessage(error)}; no hosted api upgrade was requested, so cleanup does not wait for one`,
          { cause: error },
        );
      }
      await this.#hostedServes(
        older.url,
        older.cli,
        Math.min(destroyTimeoutMs, CLEANUP_SETTLE_MS),
      );
      await this.destroy(destroyTimeoutMs, true);
    }
  }

  /**
   * Deletes a released installer's cluster through the released CLI, after a
   * short wait for a running creation to settle (unless bootstrap already
   * waited out its own budget; the workflow's sweep removes what a stuck
   * creation made), or through this one.
   */
  async #destroyThrough(
    released: Pick<CliClient, 'run'> | undefined,
    destroyTimeoutMs: number,
  ): Promise<void> {
    if (!released) {
      await this.#destroyInProcess(destroyTimeoutMs);
      return;
    }
    const read = () => this.#releasedCluster(released);
    const cluster = this.#creationStuck
      ? await read()
      : await this.#settled(
          'cluster creation settled before delete',
          read,
          Math.min(destroyTimeoutMs, CLEANUP_SETTLE_MS),
          retryTransientProbeError,
        );
    if (
      !cluster ||
      (CLUSTER_GONE.includes(cluster.state) && !cluster.releasing)
    ) {
      return;
    }
    if (CLUSTER_CREATING.includes(cluster.state)) {
      throw new Error(
        `cluster ${this.#clusterName} is still ${cluster.state}; delete is refused while its creation runs, and the workflow's sweep removes what it made`,
      );
    }
    successful(
      // The released CLI's own surface: it waits for `destroyed` within
      // a budget inside the process timeout.
      await released.run(
        [
          releasedLifecycleGroup(this.#options.fromRelease!.version),
          'delete',
          this.#clusterName,
          '--json',
          '--timeout',
          String(Math.max(60, Math.floor(destroyTimeoutMs / 1000) - 60)),
        ],
        { timeoutMs: destroyTimeoutMs, label: 'released-delete' },
      ),
      'delete (released)',
    );
    this.#destroyed = true;
  }

  /**
   * The Helm-hosted API derives its identity from the installation id (its
   * chart's `WORKLOAD_ID`), so the harness can compute the owner tag without
   * asking the API.
   */
  #hostedApiIdentity(): string | null {
    return this.#cluster ? hostedApiIdentity(this.#cluster.id) : null;
  }

  /**
   * What the seed made that is still in the cloud after delete, through the
   * runner's CLI: the stack, group or VM by its seed name, and anything tagged
   * for the cluster but the checkpoint bucket delete keeps (RFC 0049 C28).
   * Nothing to read before create named an installation, or while it lives.
   */
  async #installationLeftovers(): Promise<string[]> {
    const id = this.#installationId;
    if (!id || (this.#cluster && !this.#destroyed)) return [];
    const seed = this.#seed();
    // The API deletes its installation last; its stack, group or VM may
    // still be going when delete returns.
    let installation = await seed.installation(id);
    if (this.#destroyed && installation.kind === 'present') {
      try {
        installation = await this.#options.wait.for(
          `installation ${id} gone`,
          () => seed.installation(id),
          {
            // A stack with a VM and its network takes minutes to delete.
            timeoutMs: CLEANUP_SETTLE_MS,
            probeError: 'fail',
            unmet: (state) =>
              state.kind === 'present' ? state.detail : undefined,
          },
        );
      } catch (error) {
        if (!(error instanceof WaitTimeoutError)) throw error;
        installation = await seed.installation(id);
      }
    }
    const kept = this.#cluster?.checkpointBucket?.name;
    return [
      ...(installation.kind === 'present'
        ? [`${seed.cloud}:installation ${id} (${installation.detail})`]
        : []),
      ...(await seed.leftovers(id, kept ? [kept] : [])).map(
        (leftover) => `${seed.cloud}:${leftover.kind} ${leftover.id}`,
      ),
    ];
  }

  /** Written for the workflow's `if: always()` sweep, which reads the same tags. */
  async #recordRun(): Promise<void> {
    const record: CloudClusterRunRecord = {
      runId: this.#options.runId,
      region: this.#options.region,
      clusterProvider: this.clusterProvider,
      installationId: this.#installationId ?? null,
      hostedApiIdentity: this.#hostedApiIdentity(),
    };
    await this.#options.artifacts.json('e2e-cluster-cloud-resources', record);
  }

  async #aws(
    args: readonly string[],
    operation: string,
    tolerate?: RegExp,
    timeoutMs = 120_000,
  ): Promise<CommandResult> {
    const result = await this.#options.runner.run(
      'aws',
      [
        ...args,
        '--region',
        this.#options.region,
        '--output',
        'json',
        '--no-cli-pager',
      ],
      {
        timeoutMs,
        label: `aws-${operation.replaceAll(' ', '-')}`,
        env: this.#awsEnvironment(),
      },
    );
    if (tolerate && result.exitCode !== 0 && tolerate.test(result.combined)) {
      return result;
    }
    return successful(result, operation);
  }

  #awsEnvironment(): Record<string, string | undefined> {
    const credential = this.#options.profile.credential;
    if (credential.cloudProvider !== CloudType.AWS) {
      throw new Error('AWS cluster member requires an AWS credential');
    }
    return {
      ...isolatedAwsEnvironment(),
      AWS_ACCESS_KEY_ID: credential.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
      ...(credential.sessionToken
        ? { AWS_SESSION_TOKEN: credential.sessionToken }
        : {}),
    };
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
