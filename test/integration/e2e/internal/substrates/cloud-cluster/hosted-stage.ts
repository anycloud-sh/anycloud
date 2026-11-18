import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';
import * as semver from 'semver';

import { apiAccessUsersResponseSchema } from '../../../../../../src/shared/api-contract/api-access-schemas.js';
import {
  systemReleaseStatusSchema,
  type SystemReleaseStatus,
} from '../../../../../../src/shared/api-contract/system-release-schemas.js';
import { workloadStatusResponseSchema } from '../../../../../../src/shared/api-contract/workload-management-schemas.js';
import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';
import {
  isTerminalState,
  WorkloadState,
} from '../../../../../../src/shared/workload.js';
import type { ArtifactStore, Redactor } from '../../artifacts.js';
import type { CleanupRegistration, CleanupStack } from '../../cleanup.js';
import { TRANSIENT_FAILURE, type CliClient } from '../../cli.js';
import { cliArgs, type CliPath } from '../../cli-surface.js';
import type {
  HostedHealthRecord,
  HostedRecursionRecord,
  HostedReleaseRecord,
  HostedStage,
  HostedVersion,
} from '../../contracts/cluster-cloud.js';
import { probeFailure, type TargetHttpClient } from '../../transports/http.js';
import type { ServiceDnsProbe } from '../../transports/service-dns.js';
import type { ProcessRunner } from '../../process.js';
import { FetchFailureCapture } from './hosted-fetch-failure.js';
import type { CommandResult } from '../../types.js';
import type { FixtureNames } from '../../names.js';
import { roleApplyCheck } from './role-apply-check.js';
import { completedCommand, rejectedCommand } from '../../api-assertions.js';
import { WaitTimeoutError, type Waiter } from '../../wait.js';

/**
 * Every verb the hosted-API stage drives against the API on the cluster,
 * typed against the generated CLI surface so an unknown flag is a compile
 * error. They run with `API_URL` pointed at the cluster's hostname; the
 * operator's `api use` is exercised once for the walk and the installer's
 * own target is never changed (its `API_URL` env wins over the saved file).
 */
const API_USE = 'api use' satisfies CliPath;
const API_UPGRADE = 'api upgrade' satisfies CliPath;
const API_STATUS = 'api status' satisfies CliPath;
const CLUSTER_LIST = 'cluster list' satisfies CliPath;
const API_ACCESS_ADD = 'api access add' satisfies CliPath;
const API_ACCESS_LIST = 'api access list' satisfies CliPath;
const API_ACCESS_REMOVE = 'api access remove' satisfies CliPath;
const CREDENTIALS_NEW = 'credentials new' satisfies CliPath;
const BUCKET_LIST = 'bucket list' satisfies CliPath;
const BUCKET_CREATE = 'bucket create' satisfies CliPath;
const BUCKET_UPLOAD = 'bucket upload' satisfies CliPath;
const BUCKET_DOWNLOAD = 'bucket download' satisfies CliPath;
const BUCKET_DELETE = 'bucket delete' satisfies CliPath;
const BUCKET_RM = 'bucket rm' satisfies CliPath;
const SECRETS_NEW = 'secrets new' satisfies CliPath;
const SECRETS_DELETE = 'secrets delete' satisfies CliPath;
const SERVICE_CREATE = 'service' satisfies CliPath;
const JOB_CREATE = 'job' satisfies CliPath;
const WORKLOAD_STATUS = 'status' satisfies CliPath;
const WORKLOAD_LOGS = 'logs' satisfies CliPath;
const WORKLOAD_TERMINATE = 'terminate' satisfies CliPath;

/**
 * The recursive parent runs the CLI from the API image itself (`node
 * dist/cli/index.js`); the child is the smallest Job that can complete.
 */
const CONTAINER_CLI = 'node /app/dist/cli/index.js';
const CHILD_IMAGE = 'mirror.gcr.io/library/alpine:3.20';
const CHILD_POLL_SECONDS = 10;

const CHILD_POLLS = 120;

const shellQuote = (arg: string): string => `'${arg.replace(/'/gu, `'\\''`)}'`;
const shellCommand = (args: readonly string[]): string =>
  `${CONTAINER_CLI} ${args.map(shellQuote).join(' ')}`;

/**
 * A GitHub user and an organization for the live `api access` walk. User IDs
 * are immutable, so octocat's is a constant.
 */
const ACCESS_USER = { username: 'octocat', userId: '583231' } as const;
const ACCESS_ORG = 'anycloud-sh';

/** Not the official repository: refused before anything is recorded. */
export const REFUSED_RELEASE_IMAGE = `docker.io/library/nginx:1.27@sha256:${'0123456789abcdef'.repeat(4)}`;

/**
 * Every hosted bucket create, delete and list. On Azure, a cold account cache
 * (per credential, 15 min) makes the API look the storage account up and list
 * its keys, and the Storage RP throttles both per subscription. The
 * SDK retries each of those ARM calls up to 10 times (`maxRetries`) and waits
 * out every 429's Retry-After, which it does not cap. Run 40934357557's create
 * waited about 280 s through Retry-Afters of 74, 35, 28, 30 and 30 s (39 s
 * mean); this bounds both calls' full retries at 45 s each. The CLI gives up
 * sooner, so `#bucketCall` reruns it until this bound.
 */
const BUCKET_TIMEOUT_MS = 2 * 10 * 45_000;

/** The CLI's own request timeout, or the API's `BUCKET_THROTTLED` answer. */
const BUCKET_CALL_TIMED_OUT = /aborted due to timeout|throttled credential/iu;

/**
 * The plain-line verdicts `anycloud api upgrade` prints for a hosted target
 * (`src/cli/commands/api.ts`): the started upgrade with its number, the
 * unchanged no-op, the refusal with the API's reason, and the local API's
 * lines, which a hosted upgrade must never print: it runs without Docker or
 * the local API. They are the primary signal;
 * `api status --json` and the backup count stay the definitive check.
 */
export const HOSTED_VERDICT = {
  started:
    /Hosted API upgrade (?<number>\d+) started: \S+ → (?<version>\S+)\./u,
  unchanged:
    /Hosted API \S+ already runs (?<image>\S+); nothing to do \(unchanged\)\./u,
  /** An API older than `Upgrade N` (0.1.65) accepts the upgrade without naming it. */
  accepted: /Hosted API \S+ accepted the upgrade to (?<image>\S+)\./u,
  refused: /Hosted API upgrade refused: (?<reason>.+)/u,
  localApi: /\blocal API server\b/iu,
  /** The K3s step this tree's API runs before it is asked (RFC 0049 C26 (b)). */
  kubernetes: /^\s*K3s step: configuration (changed|current)/mu,
} as const;

const bucketEntriesSchema = z
  .object({ entries: z.array(z.object({ name: z.string() }).loose()) })
  .loose();

const apiStatusSchema = z
  .object({ release: systemReleaseStatusSchema.nullable() })
  .loose();

const versionSchema = z
  .object({ version: z.string().min(1), schemaVersion: z.string().nullable() })
  .loose();

/** `credentials new` for the cluster's credential, as the hosted stage and a released installer save it. */
export function credentialsNewArgs(
  name: string,
  material: CloudCredential,
): string[] {
  const secrets =
    material.cloudProvider === CloudType.AWS
      ? {
          provider: 'aws',
          'access-key-id': material.accessKeyId,
          'secret-access-key': material.secretAccessKey,
        }
      : material.cloudProvider === CloudType.Azure
        ? {
            provider: 'azure',
            'application-id': material.applicationId,
            secret: material.secret,
            'subscription-id': material.subscriptionId,
            'directory-id': material.directoryId,
          }
        : material.cloudProvider === CloudType.GCP
          ? {
              provider: 'gcp',
              'project-id': material.projectId,
              'client-email': material.clientEmail,
              'private-key': material.privateKey,
            }
          : material.cloudProvider === CloudType.Lambda
            ? { provider: 'lambda', 'api-key': material.apiKey }
            : undefined;
  if (!secrets) {
    throw new Error(
      'The hosted stage saves an AWS, Azure, GCP or Lambda credential',
    );
  }
  return cliArgs(CREDENTIALS_NEW, secrets, [name]);
}

export interface HostedStageOptions {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: CleanupStack;
  readonly cli: Pick<CliClient, 'run'>;
  /** Runs the `fetch failed` probes, which it records as command artifacts. */
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly http: Pick<TargetHttpClient, 'get'>;
  /** Wire queries to `anycloud.sh`'s authoritative nameservers. */
  readonly dns: Pick<ServiceDnsProbe, 'observe'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly names: Pick<FixtureNames, 'workload' | 'secret'>;
  readonly redactor: Pick<Redactor, 'add'>;
  /** The harness's sign-in token; the recursive parent's CLI reads it from a Secret. */
  readonly token: string;
  /** `from_release`: the published release's CLI, which drives the hosted API until the walk upgrades it. */
  readonly fromRelease?: { readonly cli: Pick<CliClient, 'run'> };
  /** The cluster's credential, saved again into the hosted API's own database. */
  readonly credential: {
    readonly name: string;
    readonly material: CloudCredential;
  };
  /** Where the hosted API's VM Services and Jobs run: the cluster's cloud and region. */
  readonly vm: {
    readonly region: string;
    readonly vmType: string;
  };
  readonly service: { readonly image: string; readonly port: number };
  readonly timeouts: {
    readonly workloadMs: number;
    readonly releaseMs: number;
    /** Two VM Jobs boot in sequence (the child inside the parent). */
    readonly recursionMs: number;
  };
  /** Test seam for the retry backoff and the served-version settle wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Validate the journey before any cloud resources are admitted: the hosted
 * stage (the release journey, which needs the alternate image) or else the
 * default journey. Each runs through the hosted API: no local API holds the
 * cluster since create runs in the CLI process (RFC 0049 C26 (e)).
 */
export function assertHostedStageConfiguration(options: {
  readonly hostedStage: boolean;
  readonly alternateImage: string | undefined;
}): { readonly alternateImage: string } | { readonly operator: true } {
  const { alternateImage, hostedStage } = options;
  if (!hostedStage) return { operator: true };
  if (!alternateImage) {
    throw new Error(
      'E2E_CLUSTER_HOSTED_STAGE needs E2E_CLUSTER_ALTERNATE_IMAGE (the digest-pinned b image)',
    );
  }
  return { alternateImage };
}

/** How long the served version may take to settle through the edge. */
const SERVED_VERSION_BUDGET_MS = 120_000;
/** `/health` is polled this often through an upgrade. */
const HEALTH_POLL_MS = 250;
/** How long the upgraded API's rollout is watched for a further generation. */
const STEADY_ROLLOUT_MS = 180_000;
/** Through that window a CLI read runs this often, riding out any restart. */
const STEADY_READ_MS = 10_000;
/** Two consecutive answers this far apart before the endpoint counts as settled. */
const SETTLE_GAP_MS = 5_000;
export interface WatchRequestsOptions {
  readonly dns: Pick<ServiceDnsProbe, 'observe'>;
  /** Test seams: the request, and the runner's resolver as `fetch` uses it. */
  readonly fetch?: typeof fetch;
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
}

/**
 * Polls `url` until stopped: what any caller saw through the edge, the
 * hosted API's `/health`. The longest gap is the
 * longest time between two good answers. Each failure is kept by kind, and
 * the first one also probes DNS, so a gap explains itself.
 */
export function watchRequests(
  url: URL,
  options: WatchRequestsOptions,
): () => Promise<HostedHealthRecord> {
  const request = options.fetch ?? fetch;
  const resolve =
    options.lookup ?? ((hostname) => lookup(hostname, { all: true }));
  let stopped = false;
  const record = { requests: 0, failed: 0, longestGapMs: 0 };
  const failures: Record<string, HostedHealthRecord['failures'][string]> = {};
  let probe: Promise<HostedHealthRecord['dns']> | undefined;
  let lastOk = Date.now();
  const polling = (async () => {
    while (!stopped) {
      const started = Date.now();
      const failure = await request(url, {
        signal: AbortSignal.timeout(5_000),
      }).then(
        (response) =>
          response.ok
            ? undefined
            : {
                kind: `HTTP ${response.status} ${response.headers.get('Server') ?? 'without Server header'}`,
                detail: `cf-ray ${response.headers.get('cf-ray') ?? 'none'}`,
              },
        (error: unknown) => ({
          kind: failureKind(error),
          detail: probeFailure(error),
        }),
      );
      record.requests += 1;
      if (!failure) {
        record.longestGapMs = Math.max(record.longestGapMs, started - lastOk);
        lastOk = started;
      } else {
        record.failed += 1;
        const at = new Date(started).toISOString();
        const seen = failures[failure.kind];
        failures[failure.kind] = seen
          ? { ...seen, count: seen.count + 1, lastAt: at }
          : { count: 1, firstAt: at, lastAt: at, detail: failure.detail };
        probe ??= probeDns(url.hostname, options.dns, resolve);
      }
      await delay(Math.max(0, HEALTH_POLL_MS - (Date.now() - started)));
    }
  })();
  let stopping: Promise<HostedHealthRecord> | undefined;
  return () =>
    (stopping ??= (async () => {
      stopped = true;
      await polling;
      const gap = Date.now() - lastOk;
      const dns = await probe;
      return {
        ...record,
        longestGapMs: Math.max(record.longestGapMs, gap),
        failures,
        ...(dns ? { dns } : {}),
      };
    })());
}

/** A request's error code (`ENOTFOUND`, `ECONNRESET`), or `timeout` at the 5 s abort. */
function failureKind(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('code' in cause && typeof cause.code === 'string') return cause.code;
  }
  return error instanceof Error ? error.name : 'error';
}

/** The runner's resolver against each authoritative answer; it never rejects. */
async function probeDns(
  hostname: string,
  dns: Pick<ServiceDnsProbe, 'observe'>,
  resolve: (hostname: string) => Promise<readonly LookupAddress[]>,
): Promise<HostedHealthRecord['dns']> {
  const at = new Date().toISOString();
  const [resolver, authoritative] = await Promise.all([
    resolve(hostname).then(
      (addresses) => addresses.map((a) => a.address).join(', '),
      probeFailure,
    ),
    dns.observe(hostname).then(
      (observed) =>
        observed.answers.map((a) => `${a.authority}: ${a.diagnostic}`),
      (error: unknown) => [probeFailure(error)],
    ),
  ]);
  return { at, resolver, authoritative };
}

/**
 * The hosted-API stage of the live cluster run: the operator walk against the
 * API on the cluster (`api use`, `credentials new`), a VM Service run
 * **through the hosted API**, the
 * self-update path with a real image change both ways, the unchanged and
 * refused cases, and teardown through the product.
 */
/** What the stage borrows from the cluster substrate. */
export interface HostedApiTarget {
  /** Known only after bootstrap: the installation's hostname URL. */
  readonly url: () => string;
  readonly backupVersions: () => Promise<number>;
  /** The installation's checkpoint bucket, which holds the API's database backups. */
  readonly bucket: () => string;
  /** Before `api upgrade`: cleanup then waits for an older hosted API to roll out. */
  readonly upgradeRequested: () => void;
}

export class HostedApiStage implements HostedStage {
  readonly #o: HostedStageOptions;
  readonly #hosted: HostedApiTarget;
  /** Deferred cleanups by object id, completed when the journey tears the object down itself. */
  readonly #workloadIds = new Set<string>();
  readonly #cleanups = new Map<string, CleanupRegistration>();
  /** Every hosted-API cleanup not yet completed, in registration order. */
  readonly #owed = new Map<CleanupRegistration, () => Promise<void>>();
  /** The released CLI with `fromRelease` until the walk upgrades; this tree's after. */
  #cli: Pick<CliClient, 'run'>;
  readonly #fetchFailures: FetchFailureCapture;

  constructor(options: HostedStageOptions, hosted: HostedApiTarget) {
    this.#o = options;
    this.#hosted = hosted;
    this.#cli = options.fromRelease?.cli ?? options.cli;
    this.#fetchFailures = new FetchFailureCapture(options.runner, hosted.url);
  }

  /** A cleanup through the hosted API, owed until it completes. */
  #defer(label: string, action: () => Promise<void>): CleanupRegistration {
    const deferred = this.#o.cleanup.defer(label, action);
    const owed = {
      complete: () => {
        this.#owed.delete(owed);
        deferred.complete();
      },
    };
    this.#owed.set(owed, action);
    return owed;
  }

  /**
   * The hosted API goes with the cluster, so a cleanup still owed when the
   * stack runs gets HTTP 530 (run 40934349682): run each now, newest first.
   */
  async settleCleanups(): Promise<void> {
    for (const [owed, action] of [...this.#owed].reverse()) {
      // An earlier action can complete a later registration.
      if (!this.#owed.has(owed)) continue;
      await action();
      owed.complete();
    }
  }

  /**
   * One CLI call against the hosted API. The CLI itself rides out an API
   * restart on every replayable call for about two minutes, inside
   * this timeout; nothing here retries. A `fetch failed` starts its probes
   * in the background, so the result and its timing are unchanged.
   */
  async #send(
    args: readonly string[],
    label: string,
    timeoutMs = 180_000,
    cli = this.#cli,
  ): Promise<CommandResult> {
    const result = await cli.run(args, {
      env: { API_URL: this.#hosted.url() },
      label: `hosted-${label}`,
      timeoutMs,
    });
    this.#fetchFailures.observe(result);
    return result;
  }

  /**
   * A bucket create, delete or list, rerun until `BUCKET_TIMEOUT_MS` while it
   * times out or fails transiently: the CLI gives up on its own after its 60 s
   * request timeout × 3 attempts, about 182 s, and the API memoizes
   * the throttled account lookup, so a later run joins it. Create and delete
   * are idempotent in the API, so a rerun finds the bucket created or gone
   * and succeeds. Any other failure returns at once; the deadline returns the
   * last result.
   */
  async #bucketCall(
    args: readonly string[],
    label: string,
  ): Promise<CommandResult> {
    let last: CommandResult | undefined;
    try {
      return await this.#o.wait.for(
        label,
        async (deadlineAt) =>
          (last = await this.#send(
            args,
            label,
            Math.max(1, deadlineAt - Date.now()),
          )),
        {
          timeoutMs: BUCKET_TIMEOUT_MS,
          intervalMs: 10_000,
          probeError: 'fail',
          unmet: (result) =>
            result.timedOut ||
            (result.exitCode !== 0 &&
              (TRANSIENT_FAILURE.test(result.combined) ||
                BUCKET_CALL_TIMED_OUT.test(result.combined)))
              ? `timed out: ${result.combined.trim().split('\n').at(-1) ?? ''}`
              : undefined,
        },
      );
    } catch (error) {
      if (error instanceof WaitTimeoutError && last) return last;
      throw error;
    }
  }

  /**
   * After a release reports applied and rolled out, the served endpoint can
   * still answer 503 through the edge for a few seconds; the next step waits
   * until `/v1/version` answers the expected version twice, five seconds apart.
   */
  async #awaitServedVersion(
    expected: string,
    budgetMs = SERVED_VERSION_BUDGET_MS,
  ): Promise<HostedVersion> {
    const sleep =
      this.#o.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + budgetMs;
    let consecutive = 0;
    let last: HostedVersion | null = null;
    // eslint-disable-next-line local/no-hand-written-retry-loops -- needs the expected version twice in a row, not one accepted probe
    while (Date.now() < deadline) {
      try {
        const version = await this.#hostedVersion();
        if (version.version === expected) {
          consecutive += 1;
          last = version;
          if (consecutive === 2) return version;
        } else {
          consecutive = 0;
        }
      } catch {
        consecutive = 0;
      }
      await sleep(SETTLE_GAP_MS);
    }
    throw new Error(
      `the hosted API did not serve ${expected} steadily through the edge within ${budgetMs / 1_000} s${last ? ` (last answer ${last.version})` : ''}`,
    );
  }

  /** A `--json` read (built by the caller) against the hosted API; `'absent'` when the object is gone. */
  async #read<T>(
    args: readonly string[],
    schema: z.ZodType<T>,
    label: string,
    absent?: RegExp,
  ): Promise<T | 'absent'> {
    const result =
      args[0] === 'bucket'
        ? await this.#bucketCall(args, label)
        : await this.#send(args, label);
    if (result.exitCode !== 0 && absent?.test(result.combined)) {
      return 'absent';
    }
    completedCommand(result, label);
    try {
      return schema.parse(JSON.parse(result.stdout));
    } catch (error) {
      throw new Error(`${label} returned invalid JSON`, { cause: error });
    }
  }

  #workloadStatus(id: string) {
    return this.#read(
      cliArgs(WORKLOAD_STATUS, { json: true }, [id]),
      workloadStatusResponseSchema,
      'workload-status',
      /\bWorkload not found\b/u,
    );
  }

  #poll<T>(
    label: string,
    read: () => Promise<T>,
    timeoutMs: number,
    unmet: (value: T) => string | undefined,
    reject?: (value: T) => string | undefined,
  ): Promise<T> {
    return this.#o.wait.for(label, read, {
      timeoutMs,
      intervalMs: 5_000,
      probeError: 'fail',
      unmet,
      ...(reject ? { reject } : {}),
    });
  }

  /**
   * `api use` and `credentials new` against the hosted API. With
   * `fromRelease` both run on the released CLI the cluster was bootstrapped
   * with, and the walk ends with this tree's `api upgrade` (returned) and the
   * credential saved before it decrypting after it; the access walk follows.
   * `beforeUpgrade` runs on the released CLI just before that upgrade.
   */
  async operatorWalk(
    beforeUpgrade?: () => Promise<void>,
  ): Promise<HostedReleaseRecord | undefined> {
    const { credential, fromRelease } = this.#o;
    const cli = this.#cli;
    // `api use <url>` probes the hostname through Cloudflare and saves it;
    // the installer's own target stays in force through its API_URL env.
    completedCommand(
      await cli.run(cliArgs(API_USE, {}, [this.#hosted.url()]), {
        label: 'hosted-api-use',
        timeoutMs: 60_000,
      }),
      'api use',
    );
    completedCommand(
      await this.#send(
        credentialsNewArgs(credential.name, credential.material),
        'credentials-new',
        120_000,
        cli,
      ),
      'credentials new (hosted)',
    );
    await beforeUpgrade?.();
    const upgraded = fromRelease ? await this.release() : undefined;
    if (upgraded) await this.#credentialDecrypts();
    await this.#accessWalk();
    return upgraded;
  }

  async roleApply(): Promise<void> {
    await roleApplyCheck(
      {
        send: (args, label, timeoutMs) => this.#send(args, label, timeoutMs),
        runner: this.#o.runner,
        artifacts: this.#o.artifacts,
        cleanup: this.#o.cleanup,
        env: process.env,
      },
      this.#hosted.url(),
    );
  }

  /**
   * `api access` against live GitHub: a user is shared under its immutable
   * ID, an organization is refused, and the user is removed again.
   */
  async #accessWalk(): Promise<void> {
    const listed = async () => {
      const access = await this.#read(
        cliArgs(API_ACCESS_LIST, { json: true }),
        apiAccessUsersResponseSchema,
        'api-access-list',
      );
      return access === 'absent' ? [] : access.users;
    };
    completedCommand(
      await this.#send(
        cliArgs(API_ACCESS_ADD, {}, [ACCESS_USER.username]),
        'api-access-add',
      ),
      'api access add (hosted)',
    );
    const shared = (await listed()).find(
      (user) => user.username === ACCESS_USER.username,
    );
    if (shared?.userId !== ACCESS_USER.userId) {
      throw new Error(
        `api access list shows ${ACCESS_USER.username} as ${shared?.userId ?? 'absent'}, expected GitHub ID ${ACCESS_USER.userId}`,
      );
    }
    rejectedCommand(
      await this.#send(
        cliArgs(API_ACCESS_ADD, {}, [ACCESS_ORG]),
        'api-access-add-org',
      ),
      'not a user account',
    );
    completedCommand(
      await this.#send(
        cliArgs(API_ACCESS_REMOVE, {}, [ACCESS_USER.username]),
        'api-access-remove',
      ),
      'api access remove (hosted)',
    );
    if ((await listed()).some((user) => user.userId === ACCESS_USER.userId)) {
      throw new Error(`api access remove left ${ACCESS_USER.username} listed`);
    }
  }

  /**
   * After a release, what was created before it survives: the VM Service
   * still runs under its id, and a saved credential still decrypts (`bucket
   * list` resolves it by name inside the API with its cipher key).
   */
  async stateSurvives(serviceId: string): Promise<void> {
    // A short poll: the Service may reconcile briefly after the API restart.
    await this.#o.wait.for(
      `Service ${serviceId} running after the release`,
      () => this.#workloadStatus(serviceId),
      {
        timeoutMs: 120_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (s) =>
          s !== 'absent' &&
          s.workload.id === serviceId &&
          s.workload.state === WorkloadState.Running
            ? undefined
            : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
        reject: (s) =>
          s !== 'absent' && isTerminalState(s.workload.state)
            ? `Service ${serviceId} ended ${s.workload.state}`
            : undefined,
      },
    );
    await this.#credentialDecrypts();
  }

  /**
   * Listing buckets decrypts the credential inside the API; the list names the
   * API's backup bucket, which the API itself refuses to open.
   */
  async #credentialDecrypts(): Promise<void> {
    const { credential, vm } = this.#o;
    const list = cliArgs(BUCKET_LIST, {
      credentials: credential.name,
      region: vm.region,
      all: true,
      json: true,
    });
    const buckets = await this.#read(list, bucketEntriesSchema, 'bucket-list');
    const backup = this.#hosted.bucket();
    if (buckets === 'absent' || !buckets.entries.some((b) => b.name === backup))
      throw new Error(
        `bucket list with ${credential.name} does not list the API backup bucket ${backup}`,
      );
    rejectedCommand(
      await this.#send(
        [...list, backup, 'anycloud-api/'],
        'bucket-list-backup',
      ),
      `Bucket "${backup}" is this API's own backup bucket`,
    );
  }

  /** A VM Service through the hosted API, waited to running. */
  async runService(label = 'service'): Promise<string> {
    const { credential, vm, service, timeouts, names } = this.#o;
    const id = names.workload(label);
    this.#workloadIds.add(id);
    this.#cleanups.set(
      id,
      this.#defer(`hosted Service ${id}`, () => this.terminate(id, 'Service')),
    );
    const created = await this.#send(
      cliArgs(
        SERVICE_CREATE,
        {
          credentials: credential.name,
          region: vm.region,
          'vm-type': vm.vmType,
          id,
          // The product probes `$PORT`; the image must be told where it listens.
          env: [`PORT=${String(service.port)}`],
        },
        [service.image],
      ),
      'service-create',
    );
    completedCommand(created, 'service (hosted)');
    if (!created.combined.includes(`ID: ${id}`)) {
      throw new Error(`service did not acknowledge ${id}: ${created.combined}`);
    }
    await this.#poll(
      `hosted Service ${id} to be running`,
      () => this.#workloadStatus(id),
      timeouts.workloadMs,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Running
          ? undefined
          : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Failed
          ? 'Service failed'
          : undefined,
    );
    return id;
  }

  /** {@link watchRequests} with this run's DNS probe. */
  watchRequests(url: URL): () => Promise<HostedHealthRecord> {
    return watchRequests(url, { dns: this.#o.dns });
  }

  async #hostedVersion(): Promise<HostedVersion> {
    const response = await this.#o.http.get(
      'hosted-api-version',
      new URL('/v1/version', this.#hosted.url()),
      { timeoutMs: 30_000 },
    );
    if (response.status !== 200) {
      throw new Error(`hosted API version read returned ${response.status}`);
    }
    return versionSchema.parse(response.body);
  }

  /**
   * `api upgrade --image <image>` starts Upgrade N; `api status --json`
   * reports it `running` only once the release's ready check Job succeeded
   * (the Pod for that revision runs the pinned image, is Ready and serves
   * its version) and `starting` before that; the pre-upgrade backup added an
   * object version, and `cluster list` shows the API's own cluster
   * `running` on the new version. Both legs (a → b and back b → a)
   * come through here; without `image`, the upgrade from a published release
   * to this CLI's own (`a`), as an operator runs it.
   *
   * `rollsOnce`: the upgrade is between two images that both name their
   * chart, and the charts differ, so the one HelmChart write rolls the API
   * exactly once: one generation from before the request to running, and
   * none after it.
   */
  async release(
    image?: string,
    rollsOnce = false,
  ): Promise<HostedReleaseRecord> {
    // Upgraded to this tree's release, the API is this tree's CLI's from here.
    this.#cli = this.#o.cli;
    const stopWatching = this.watchRequests(
      new URL('/health', this.#hosted.url()),
    );
    try {
      const before = rollsOnce
        ? (await this.#releaseStatus())?.rollout?.observedGeneration
        : undefined;
      const { running, servedBefore, ...released } = await this.#release(image);
      // From a published release before 0.1.68, whose upgrade sets only the
      // image, the new API's chart repair may restart it once more.
      if (servedBefore) {
        await this.#rolloutSteady(
          running,
          semver.lt(servedBefore, '0.1.68') ? 1 : 0,
        );
      }
      if (rollsOnce) {
        const upgraded = running.rollout?.observedGeneration;
        if (before == null || upgraded !== before + 1) {
          throw new Error(
            `the upgrade did not roll the hosted API exactly once before it ran: generation ${String(before)} → ${String(upgraded)}`,
          );
        }
        await this.#rolloutSteady(running, 0);
      }
      const health = await stopWatching();
      if (health.requests === 0 || !Number.isFinite(health.longestGapMs)) {
        throw new Error(`/health was not measured: ${JSON.stringify(health)}`);
      }
      await this.#o.artifacts.json(
        `hosted-upgrade-${released.upgrade}-health`,
        health,
      );
      return { ...released, health };
    } finally {
      await stopWatching();
    }
  }

  async #release(image?: string): Promise<
    Omit<HostedReleaseRecord, 'health'> & {
      running: SystemReleaseStatus;
      servedBefore: string | undefined;
    }
  > {
    const backupVersionsBefore = await this.#hosted.backupVersions();
    // Only the from_release upgrade can meet an API older than this CLI.
    const servedBefore =
      this.#o.fromRelease && !image
        ? (await this.#hostedVersion()).version
        : undefined;
    this.#hosted.upgradeRequested();
    const requested = await this.#send(
      cliArgs(API_UPGRADE, image ? { image } : {}),
      'api-upgrade',
      // The K3s step (RFC 0049 C26 (b)) pulls the target image, may restart
      // K3s and waits up to 5 minutes for it before the request.
      900_000,
    );
    completedCommand(requested, 'api upgrade (hosted)');
    // `api upgrade` leaves the local API alone and prints the hosted verdict
    // as a plain line: the upgrade number and its target version.
    this.#localApiUntouched(requested);
    const verdict =
      HOSTED_VERDICT.started.exec(requested.combined)?.groups ??
      (servedBefore
        ? await this.#startedOnOlderApi(requested.combined, servedBefore)
        : undefined);
    if (!verdict) {
      throw new Error(
        `api upgrade did not report a started hosted upgrade: ${requested.combined}`,
      );
    }
    // This tree's API runs the K3s step through its host-step Job; an
    // older from_release API has no route for it, and the CLI skips it.
    if (!servedBefore && !HOSTED_VERDICT.kubernetes.test(requested.combined)) {
      throw new Error(
        `api upgrade did not report a finished K3s step: ${requested.combined}`,
      );
    }
    const upgrade = Number(verdict.number);
    const label = `Upgrade ${upgrade}`;
    const ofThis = (status: SystemReleaseStatus | null) =>
      status?.upgrade?.number === upgrade ? status.upgrade : null;
    const status = await this.#poll(
      `hosted ${label} to run`,
      () => this.#releaseStatus(),
      this.#o.timeouts.releaseMs,
      (read) => {
        const reported = ofThis(read);
        if (reported?.state === WorkloadState.Running) {
          // From a published release this status anchors `#rolloutSteady`.
          return servedBefore && read?.rollout?.observedGeneration == null
            ? `status shows ${label} running without a Deployment generation`
            : undefined;
        }
        return `status does not yet show ${label} running: ${reported ? `${reported.state}${reported.lastError ? `: ${reported.lastError}` : ''}` : 'no such upgrade'}`;
      },
      // A failed ready check fails at once rather than waiting out the budget.
      (read) => {
        const reported = ofThis(read);
        return reported?.state === WorkloadState.Failed
          ? `the upgrade failed: ${reported.lastError ?? 'no reason reported'}`
          : undefined;
      },
    );
    await this.#o.artifacts.json(`hosted-upgrade-${upgrade}`, {
      image,
      requested: requested.combined,
      status,
    });
    const backupVersionsAfter = await this.#hosted.backupVersions();
    if (backupVersionsAfter <= backupVersionsBefore) {
      throw new Error(
        `the pre-upgrade backup did not add an object version (${backupVersionsBefore} → ${backupVersionsAfter})`,
      );
    }
    const servedAfter = await this.#awaitServedVersion(verdict.version);
    await this.#clusterListShowsRunning(verdict.version);
    return {
      image: image ?? ofThis(status)!.apiImage,
      upgrade,
      backupVersionsBefore,
      backupVersionsAfter,
      servedAfter,
      running: status!,
      servedBefore,
    };
  }

  /**
   * A published API older than `Upgrade N` (v0.1.65) answers the request with
   * `{ unchanged: false, release }` and no `upgrade`, which this CLI prints as
   * accepted. That is a started upgrade once the API serves this CLI's
   * version; its status then names the upgrade. From 0.1.66 the API names
   * the upgrade, so its started verdict is required.
   */
  async #startedOnOlderApi(
    output: string,
    servedBefore: string,
  ): Promise<{ number: string; version: string } | undefined> {
    const image = HOSTED_VERDICT.accepted.exec(output)?.groups?.image;
    const version = image?.slice(image.lastIndexOf(':') + 1);
    // From 0.1.66 the API answers with `upgrade`: it must print the started verdict.
    if (
      !version ||
      version === servedBefore ||
      !semver.lt(servedBefore, '0.1.66')
    ) {
      return undefined;
    }
    await this.#awaitServedVersion(version, this.#o.timeouts.releaseMs);
    const upgrade = (await this.#releaseStatus())?.upgrade;
    if (upgrade?.apiVersion !== version) {
      throw new Error(
        `the hosted API serves ${version} but its status shows ${upgrade ? `Upgrade ${upgrade.number} to ${upgrade.apiVersion}` : 'no upgrade'}`,
      );
    }
    return { number: String(upgrade.number), version };
  }

  /**
   * After an upgrade from a release that inlined its chart, the new API's
   * chart repair may roll it once (`repairRolls` 1) but must not keep rolling
   * it; after an upgrade that set the chart, nothing rolls it (0). From the
   * status that first showed the upgrade running (before a repair's Helm run,
   * which waits for the ready check), three minutes on and settled, the
   * Deployment may be that many generations later, on the same release, and
   * no more: a loop rolling faster than every ninety seconds shows as two.
   * Through those minutes a CLI read every ten seconds must ride out any
   * restart.
   */
  async #rolloutSteady(
    running: SystemReleaseStatus,
    repairRolls: 0 | 1,
  ): Promise<void> {
    const generation = (status: SystemReleaseStatus | null) =>
      status?.rollout?.observedGeneration ?? undefined;
    const steady = (status: SystemReleaseStatus | null) =>
      status?.rollout?.replicas === 1 &&
      status.rollout.readyReplicas === 1 &&
      status.rollout.updatedReplicas === 1 &&
      generation(status) !== undefined
        ? status
        : undefined;
    const release = ({ servedVersion, upgrade }: SystemReleaseStatus) =>
      `${servedVersion} (Upgrade ${String(upgrade?.number)}, ${String(upgrade?.apiImage)})`;
    const baseline = generation(running);
    if (baseline === undefined) {
      throw new Error(
        `the running upgrade's status has no Deployment generation: ${JSON.stringify(running.rollout)}`,
      );
    }
    const sleep =
      this.#o.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let read = 0; read * STEADY_READ_MS < STEADY_ROLLOUT_MS; read += 1) {
      await sleep(STEADY_READ_MS);
      await this.#read(
        cliArgs(API_ACCESS_LIST, { json: true }),
        apiAccessUsersResponseSchema,
        'api-access-list',
      );
    }
    const after = steady(
      await this.#poll(
        'hosted API rollout settled after the upgrade',
        () => this.#releaseStatus(),
        this.#o.timeouts.releaseMs,
        (status) =>
          steady(status)
            ? undefined
            : `rollout ${JSON.stringify(status?.rollout ?? null)}`,
      ),
    )!;
    if (release(after) !== release(running)) {
      throw new Error(
        `the hosted API rolled to another release after the upgrade: ${release(running)} → ${release(after)}`,
      );
    }
    if (generation(after)! > baseline + repairRolls) {
      throw new Error(
        `the hosted API rolled again after the upgrade: generation ${baseline} → ${generation(after)!}, ${repairRolls ? "more than the chart repair's one roll" : 'though the upgrade set its chart'}`,
      );
    }
  }

  async #releaseStatus(): Promise<SystemReleaseStatus | null> {
    const read = await this.#read(
      cliArgs(API_STATUS, { json: true }),
      apiStatusSchema,
      'api-status',
    );
    return read === 'absent' ? null : read.release;
  }

  /**
   * An upgrade leaves the API running: the human `cluster list` row for the
   * API's own cluster reads `running` on the new version.
   */
  async #clusterListShowsRunning(version: string): Promise<void> {
    const id = new URL(this.#hosted.url()).hostname.split('.')[0];
    const listed = completedCommand(
      await this.#send(cliArgs(CLUSTER_LIST, {}), 'cluster-list'),
      'cluster list (hosted)',
    );
    const row = listed.split('\n').find((line) => line.includes(` ${id} `));
    if (
      !row ||
      !/\brunning\s*$/u.test(row) ||
      !row.split(/\s+/u).includes(version)
    ) {
      throw new Error(
        `cluster list does not show ${id} running on ${version}: ${listed}`,
      );
    }
  }

  /** The latest upgrade `api status` reports, plus the backup count: what a no-op must leave alone. */
  async #releaseState(): Promise<{ latest: string; backups: number }> {
    const upgrade = (await this.#releaseStatus())?.upgrade;
    return {
      latest: upgrade
        ? `Upgrade ${upgrade.number} (${upgrade.apiImage})`
        : 'no upgrade',
      backups: await this.#hosted.backupVersions(),
    };
  }

  /** With a hosted target active, the local API (and Docker) is not touched. */
  #localApiUntouched(result: CommandResult): void {
    if (HOSTED_VERDICT.localApi.test(result.combined)) {
      throw new Error(
        `api upgrade of a hosted API reconciled the local API: ${result.combined}`,
      );
    }
  }

  /**
   * A no-op upgrade: the plain verdict line is the primary signal (F runs 16
   * and 18 showed the spinner alone prints nothing in a non-TTY run); the
   * definitive check is that the latest upgrade and the backup count are as
   * they were.
   */
  async #releaseNoop(
    args: readonly string[],
    label: string,
    check: (result: CommandResult) => string | undefined,
  ): Promise<void> {
    const before = await this.#releaseState();
    const result = await this.#send(args, label, 180_000);
    this.#localApiUntouched(result);
    const problem = check(result);
    if (problem) throw new Error(`${problem}: ${result.combined}`);
    const after = await this.#releaseState();
    if (after.latest !== before.latest) {
      throw new Error(
        `${label} started an upgrade: latest moved from ${before.latest} to ${after.latest}`,
      );
    }
    if (after.backups !== before.backups) {
      throw new Error(`${label} still backed the database up`);
    }
  }

  /** The image the API already runs: no upgrade, no rollout, no backup. */
  async releaseUnchanged(image: string): Promise<void> {
    await this.#releaseNoop(
      cliArgs(API_UPGRADE, { image }),
      'api-upgrade-unchanged',
      (result) => {
        if (result.exitCode !== 0) return 'api upgrade (unchanged) failed';
        const verdict = HOSTED_VERDICT.unchanged.exec(result.combined)?.groups;
        if (verdict?.image !== image) {
          return `api upgrade did not report ${image} unchanged`;
        }
        return undefined;
      },
    );
  }

  /** A non-official image is refused before anything is written. */
  async releaseRefused(): Promise<void> {
    await this.#releaseNoop(
      cliArgs(API_UPGRADE, { image: REFUSED_RELEASE_IMAGE }),
      'api-upgrade-refused',
      (result) => {
        if (result.exitCode === 0) {
          return 'api upgrade accepted a non-official image';
        }
        if (!HOSTED_VERDICT.refused.test(result.combined)) {
          return 'api upgrade failed without the refusal verdict';
        }
        if (
          !HOSTED_VERDICT.refused
            .exec(result.combined)
            ?.groups?.reason.includes(
              'digest-pinned reference from the official repository',
            )
        ) {
          return 'api upgrade failed without the official image-policy refusal';
        }
        return undefined;
      },
    );
  }

  /**
   * The recursion property the retired `aws-recursion` member proved: an API
   * that hosts workloads that drive it. A parent Job submitted through the
   * hosted API runs the CLI from the API image and submits the child Job back
   * through the same API, then waits for it; the harness observes the child
   * complete, then the parent, and tears down child → parent. Both are VM
   * Jobs on the cluster's credential, in its region.
   */
  async recursion(apiImage: string): Promise<HostedRecursionRecord> {
    const { vm, credential, names, timeouts } = this.#o;
    // Anycloud passes no sign-in token into workloads, so the parent's CLI
    // gets the harness's token the way a user would: through a Secret.
    const secret = names.secret('recursion');
    this.#o.redactor.add(this.#o.token);
    completedCommand(
      await this.#send(
        cliArgs(SECRETS_NEW, {}, [secret, `GITHUB_TOKEN=${this.#o.token}`]),
        'secrets-new-recursion',
      ),
      'secrets new (hosted, recursion)',
    );
    // LIFO: the Jobs registered below are torn down before their Secret.
    const secretCleanup = this.#defer(`hosted Secret ${secret}`, async () => {
      await this.#send(
        cliArgs(SECRETS_DELETE, { force: true }, [secret]),
        'secrets-delete-recursion',
      );
    });
    const parentId = names.workload('rec-parent');
    const childId = names.workload('rec-child');
    this.#workloadIds.add(parentId);
    this.#workloadIds.add(childId);
    // On failure stop the producer first: a starting parent could submit its
    // child after an earlier child-absence read. Success still tears down
    // child → parent inline after both have completed.
    for (const id of [childId, parentId]) {
      this.#cleanups.set(
        id,
        this.#defer(`hosted Job ${id}`, () => this.terminate(id, 'Job')),
      );
    }
    const job = {
      credentials: credential.name,
      region: vm.region,
      'vm-type': vm.vmType,
    };
    const submitChild = shellCommand(
      cliArgs(
        JOB_CREATE,
        { ...job, id: childId },
        [CHILD_IMAGE],
        ['sh', '-c', 'echo child-done'],
      ),
    );
    const childState = `${shellCommand(cliArgs(WORKLOAD_STATUS, { json: true }, [childId]))} | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).workload.state)'`;
    const script = [
      'set -e',
      submitChild,
      `for i in $(seq 1 ${String(CHILD_POLLS)}); do state=$(${childState}) || state=unreachable; echo "child $state"`,
      'case "$state" in completed) exit 0;; failed|errored|invalid|terminated|terminating) exit 1;; esac',
      `sleep ${String(CHILD_POLL_SECONDS)}; done; echo "child did not complete in time"; exit 1`,
    ].join('\n');
    completedCommand(
      await this.#send(
        cliArgs(
          JOB_CREATE,
          {
            ...job,
            id: parentId,
            env: [`API_URL=${this.#hosted.url()}`],
            secret: [secret],
          },
          [apiImage],
          ['sh', '-c', script],
        ),
        'job-create-parent',
      ),
      'job (hosted, recursive parent)',
    );
    const parent = await this.#poll(
      `hosted recursive parent ${parentId} to complete`,
      () => this.#workloadStatus(parentId),
      timeouts.recursionMs,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Completed
          ? undefined
          : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
      (s) =>
        s !== 'absent' &&
        s.workload.state !== WorkloadState.Completed &&
        isTerminalState(s.workload.state)
          ? `parent ended ${s.workload.state}`
          : undefined,
    );
    const child = await this.#workloadStatus(childId);
    if (
      child === 'absent' ||
      child.workload.state !== WorkloadState.Completed
    ) {
      throw new Error(
        `the child Job ${childId} is ${child === 'absent' ? 'absent' : child.workload.state}, not completed`,
      );
    }
    await this.#o.artifacts.json('hosted-recursion', { parent, child });
    await this.terminate(childId, 'Job');
    await this.terminate(parentId, 'Job');
    completedCommand(
      await this.#send(
        cliArgs(SECRETS_DELETE, {}, [secret]),
        'secrets-delete-recursion',
      ),
      'secrets delete (hosted, recursion)',
    );
    secretCleanup.complete();
    return {
      parentId,
      childId,
    };
  }

  /** Terminate through the hosted API, waited until cleaned up or gone. */
  async terminate(id: string, kind: 'Service' | 'Job'): Promise<void> {
    // Idempotent: the journey terminates first and the deferred cleanup
    // repeats it; a workload the hosted API no longer knows is already done.
    const result = await this.#send(
      cliArgs(WORKLOAD_TERMINATE, {}, [id]),
      `${kind.toLowerCase()}-terminate`,
    );
    if (
      result.exitCode !== 0 &&
      /\bWorkload not found\b/u.test(result.combined)
    ) {
      this.#cleanups.get(id)?.complete();
      return;
    }
    completedCommand(result, 'terminate (hosted)');
    await this.#poll(
      `hosted ${kind} ${id} to be cleaned up`,
      () => this.#workloadStatus(id),
      this.#o.timeouts.workloadMs,
      (s) =>
        s === 'absent' || typeof s.workload.cleanedAt === 'number'
          ? undefined
          : `${s.workload.state}, cleanup pending`,
    );
    // Torn down by the journey: the deferred cleanup has nothing left to do
    // (and the hosted API may be gone by the time the stack runs, F run 17).
    this.#cleanups.get(id)?.complete();
  }

  /**
   * A fresh bucket signed by `where`'s credential, holding a small
   * object at each key. The returned call empties and deletes it; cleanup
   * does so if the caller never does.
   */
  async seedBucket(
    bucket: string,
    keys: readonly string[],
    where: { readonly credentials: string; readonly region: string },
  ): Promise<() => Promise<void>> {
    const remove = async () => {
      for (const prefix of new Set(keys.map((key) => key.split('/')[0])))
        await this.#send(
          cliArgs(BUCKET_RM, { ...where, recursive: true, yes: true }, [
            bucket,
            `${prefix}/`,
          ]),
          'bucket-rm',
        );
      const result = await this.#bucketCall(
        cliArgs(BUCKET_DELETE, where, [bucket]),
        'bucket-delete',
      );
      if (
        result.exitCode !== 0 &&
        !/not found|does not exist/iu.test(result.combined)
      )
        completedCommand(result, `bucket delete ${bucket} (token bucket)`);
    };
    const owed = this.#defer(`token bucket ${bucket}`, remove);
    completedCommand(
      await this.#bucketCall(
        cliArgs(BUCKET_CREATE, where, [bucket]),
        'bucket-create',
      ),
      'bucket create (token bucket)',
    );
    const local = await mkdtemp(path.join(tmpdir(), 'token-bucket-'));
    try {
      const file = path.join(local, 'ref.txt');
      await writeFile(file, bucket);
      for (const key of keys)
        completedCommand(
          await this.#send(
            cliArgs(BUCKET_UPLOAD, where, [bucket, file, key]),
            'bucket-upload',
          ),
          'bucket upload (token bucket)',
        );
    } finally {
      await rm(local, { recursive: true, force: true });
    }
    return async () => {
      await remove();
      owed.complete();
    };
  }

  /**
   * A check's VM Job on the cluster's credential and in its region;
   * terminated at cleanup.
   */
  async checkJob(
    label: string,
    spec: {
      readonly image: string;
      readonly command: readonly string[];
      readonly outputBucket?: string;
      /** The output bucket signed by this named credential instead of the cluster's. */
      readonly outputStorage?: {
        readonly credentials: string;
        readonly region: string;
      };
    },
  ): Promise<string> {
    const { credential, vm } = this.#o;
    const id = this.#o.names.workload(label);
    this.#workloadIds.add(id);
    this.#cleanups.set(
      id,
      this.#defer(`hosted Job ${id}`, () => this.terminate(id, 'Job')),
    );
    completedCommand(
      await this.#send(
        cliArgs(
          JOB_CREATE,
          {
            id,
            credentials: credential.name,
            region: vm.region,
            'vm-type': vm.vmType,
            ...(spec.outputBucket
              ? { 'output-bucket': spec.outputBucket }
              : {}),
            ...(spec.outputStorage
              ? {
                  'output-storage-credentials': spec.outputStorage.credentials,
                  'output-storage-region': spec.outputStorage.region,
                }
              : {}),
          },
          [spec.image],
          [...spec.command],
        ),
        'job-create-check',
      ),
      'job (hosted check)',
    );
    return id;
  }

  /**
   * A bucket the API creates at a Job's admission, signed by `where`'s
   * credential: owed to cleanup now, and deleted at once by the function
   * returned, while that credential still works.
   */
  bucketDeletion(
    bucket: string,
    where: { readonly credentials: string; readonly region: string },
  ): () => Promise<void> {
    const remove = async () => {
      const result = await this.#bucketCall(
        cliArgs(BUCKET_DELETE, where, [bucket]),
        'bucket-delete',
      );
      if (
        result.exitCode !== 0 &&
        !/not found|does not exist/iu.test(result.combined)
      )
        completedCommand(result, `bucket delete ${bucket} (hosted)`);
    };
    const owed = this.#defer(`bucket ${bucket}`, remove);
    return async () => {
      await remove();
      owed.complete();
    };
  }

  /** One object of a bucket, as text; `where` signs with another credential. */
  async readBucketObject(
    bucket: string,
    key: string,
    where?: { readonly credentials: string; readonly region: string },
  ): Promise<string> {
    const { credential, vm } = this.#o;
    const local = await mkdtemp(path.join(tmpdir(), 'hosted-check-output-'));
    try {
      const file = path.join(local, 'object');
      completedCommand(
        await this.#send(
          cliArgs(
            BUCKET_DOWNLOAD,
            where ?? { credentials: credential.name, region: vm.region },
            [bucket, key, file],
          ),
          'bucket-download',
        ),
        `bucket download ${bucket}/${key}`,
      );
      return await readFile(file, 'utf8');
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }

  /** A workload's status through the hosted API; `'absent'` once it is gone. */
  status(id: string) {
    return this.#workloadStatus(id);
  }

  async logs(id: string): Promise<string> {
    const result = await this.#send(cliArgs(WORKLOAD_LOGS, {}, [id]), 'logs');
    return completedCommand(result, `logs ${id}`);
  }

  /** Capture each read independently before cleanup removes the evidence. */
  async captureDiagnostics(): Promise<void> {
    // A `fetch failed`'s probes are recorded before the run can end.
    await this.#fetchFailures.settled();
    const attempt = async (read: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await read();
      } catch (error) {
        return {
          unavailable: error instanceof Error ? error.message : String(error),
        };
      }
    };
    // The released CLI until the walk upgrades: this one is refused by an older API.
    const read = (args: readonly string[], label: string) =>
      attempt(() =>
        this.#cli.run(args, {
          env: { API_URL: this.#hosted.url() },
          label: `hosted-${label}`,
          timeoutMs: 60_000,
        }),
      );
    const record = {
      url: this.#hosted.url(),
      releaseStatus: await read(
        cliArgs(API_STATUS, { json: true }),
        'api-status-diagnostic',
      ),
      version: await attempt(() => this.#hostedVersion()),
      workloads: await Promise.all(
        [...this.#workloadIds].map(async (id) => ({
          id,
          status: await read(
            cliArgs(WORKLOAD_STATUS, { json: true }, [id]),
            `status-diagnostic-${id}`,
          ),
          logs: await read(
            cliArgs(WORKLOAD_LOGS, {}, [id]),
            `logs-diagnostic-${id}`,
          ),
        })),
      ),
    };
    await attempt(() =>
      this.#o.artifacts.json('hosted-stage-diagnostics', record),
    );
  }
}
