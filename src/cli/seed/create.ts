/**
 * `api create` through the seed (RFC 0049 C26 (e)): the user's own cloud
 * CLI stands up the management VM, whose startup script brings up K3s and
 * the API. This drives it: sign-in and rights, the cluster's ID (a re-run
 * resumes it by name), the release values and boot script, the deploy, the
 * DNS record once the VM's address is known, and the wait for the API and
 * its first backup.
 */

import type { ClusterSummary } from '../../shared/api-contract/clusters-schemas.js';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';
import * as semver from 'semver';
import { resolveApiImage } from '../../shared/api-image.js';
import {
  ensureCatalogBootstrapped,
  readCatalog,
} from '../../shared/catalog/index.js';
import type { CloudType } from '../../shared/cloud.js';
import { UsageError } from '../utils/lifecycle-result.js';
import { clusterApiUrl, clusterHostname } from '../../shared/api-ingress.js';
import {
  DNS_WORKER_URL,
  publicARecordExists,
  upsertDNSRecord,
} from '../../shared/dns-worker.js';
import { hostedApiIdentity } from '../../shared/hosted-api-identity.js';
import {
  API_BACKUP_MANIFEST_KEY,
  checkRestoreAccount,
  parseApiBackupManifest,
  type ApiBackupManifest,
} from '../../shared/api-backup-manifest.js';
import { clusterNetworkScope } from '../../shared/clusters.js';
import { generateClusterId } from '../../shared/id-generator.js';
import {
  BOOT_PLACEHOLDERS,
  managementBootScript,
} from '../../shared/management-boot.js';
import {
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
  SYSTEM_RELEASE_KUBERNETES_PORT,
  apiImageTagReference,
  pinnedApiImage,
} from '../../shared/system-release.js';
import { systemReleaseValues } from '../../shared/system-release-values.js';
import { sleep } from '../../shared/utils.js';
import type {
  CloudSeed,
  SeedAccount,
  SeedParams,
  SeedReleaseValues,
} from './types.js';
import { seedCloudType } from './types.js';

/**
 * A fresh hostname's first lookup must wait until Cloudflare serves it: a
 * resolver that sees NXDOMAIN caches it for the zone's 1800 s negative TTL.
 */
const PUBLIC_RECORD_FIRST_QUERY_MS = 10_000;
const PUBLIC_RECORD_POLL_MS = 5_000;
const PUBLIC_RECORD_TIMEOUT_MS = 35 * 60_000;
/** The boot script installs K3s and the API; past this the VM isn't coming up. */
const API_READY_TIMEOUT_MS = 25 * 60_000;
const API_POLL_MS = 10_000;
/**
 * The API reports its first backup `failed` once its own per-cloud budget
 * ends (src/api/services/first-backup.ts, 15 minutes at most); past this it
 * is stuck.
 */
const FIRST_BACKUP_STALL_MS = 20 * 60_000;

/** Create stopped with a reason a re-run or a fix addresses; `code` is the `--json` error code. */
export class SeedCreateError extends Error {
  constructor(
    readonly code:
      | 'CLOUD_RIGHTS_MISSING'
      | 'RESTORE_REFUSED'
      | 'FIRST_BACKUP_FAILED'
      | 'API_NOT_READY',
    message: string,
  ) {
    super(message);
    this.name = 'SeedCreateError';
  }
}

export interface SeedCreateInput {
  seed: CloudSeed;
  name: string;
  region: string;
  zone: string | null;
  vmType: string;
  /** A bucket the user owns; without it a managed one named after the cluster. */
  checkpointBucket: string | null;
  githubToken: string;
  owner: { id: string; username: string };
  version: string;
  /** The hosted API's client at its hostname; fails until the API answers. */
  hostedApi(apiUrl: string): Promise<ApiClient>;
  progress(message: string): void;
  signal?: AbortSignal;
}

export interface SeedCreateDependencies {
  resolveApiImage: typeof resolveApiImage;
  publish: typeof upsertDNSRecord;
  publicARecordExists: typeof publicARecordExists;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** `ANYCLOUD_E2E_ACCESS=1`, test-only: the harness's kubeconfig hand-off. */
  e2eAccess: boolean;
  /** Downloads the cloud's catalog on a fresh machine; the seeds read it. */
  bootstrapCatalog: (
    cloud: CloudType,
    progress: (message: string) => void,
  ) => Promise<void>;
}

export const DEFAULT_DEPENDENCIES: SeedCreateDependencies = {
  resolveApiImage,
  publish: upsertDNSRecord,
  publicARecordExists,
  sleep,
  now: () => Date.now(),
  e2eAccess: process.env.ANYCLOUD_E2E_ACCESS === '1',
  bootstrapCatalog: async (cloud, progress) => {
    if (!readCatalog(cloud))
      progress(`First run: downloading the ${cloud} catalog`);
    await ensureCatalogBootstrapped(cloud);
  },
};

/** Run create to a running cluster with backups; a re-run resumes it. */
export async function runSeedCreate(
  input: SeedCreateInput,
  dependencies: SeedCreateDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClusterSummary> {
  const { seed, progress } = input;
  // The seeds resolve zones and images from it, before any rights check.
  await dependencies.bootstrapCatalog(seedCloudType(seed.cloud), progress);
  const account = await seed.discoverAccount();
  progress(
    `Using ${seed.cloud} account ${account.account} as ${account.principal}`,
  );
  const missing = await seed.checkRights(account);
  if (missing === null) {
    progress(`Could not check ${account.principal}'s rights; continuing`);
  } else if (missing.length > 0) {
    throw new SeedCreateError(
      'CLOUD_RIGHTS_MISSING',
      `${account.principal} lacks ${missing.join(', ')} in ${seed.cloud} account ${account.account}; grant them and retry (https://anycloud.sh/reference/cli/api-utilities#cloud-rights)`,
    );
  }
  // A supplied bucket holding a backup makes this a restore under the
  // backup's cluster ID, so its hostname and DNS record carry over.
  // Nothing on this machine records a create: the cloud's name tag does.
  const resumed = await seed.findByName(input.name, input.region);
  // Whether the installation this name resumes already holds its own bucket.
  let ownBucketHeld = false;
  if (resumed) {
    // A resume must keep the bucket the installation was made with.
    const held = await seed.status(resumed, input.region);
    const asked = input.checkpointBucket ?? resumed;
    if (held.kind === 'deployed' && held.outputs.bucket !== asked) {
      // Its own managed bucket resumes with or without the flag.
      const flag =
        held.outputs.bucket === resumed
          ? `with --checkpoint-bucket ${resumed}, or without the flag`
          : `with --checkpoint-bucket ${held.outputs.bucket}`;
      throw new UsageError(
        `cluster ${input.name} backs up to ${held.outputs.bucket}; re-run create ${flag} to resume it`,
      );
    }
    ownBucketHeld = held.kind === 'deployed' && held.outputs.bucket === resumed;
  }
  const restore = input.checkpointBucket
    ? await restorableBackup(seed, input, account, resumed)
    : null;
  const clusterId =
    restore?.clusterId ?? resumed ?? generateClusterId(input.name);
  progress(
    restore && resumed !== restore.clusterId
      ? `Restoring cluster ${input.name} (ID: ${clusterId}) from the backup in ${input.checkpointBucket}`
      : `${resumed ? 'Resuming' : 'Creating'} cluster ${input.name} (ID: ${clusterId})`,
  );

  // Before anything is bought: an API version with no pinned image or chart fails here.
  const { digest, chart } = await dependencies.resolveApiImage(
    apiImageTagReference(input.version),
  );
  // The bucket Anycloud made for this cluster stays managed. The seed
  // creates it only on a first create: never for a restore from it, nor for
  // a resume of an installation that already holds it.
  const bucket: SeedParams['bucket'] =
    (!input.checkpointBucket && ownBucketHeld) ||
    input.checkpointBucket === clusterId
      ? { name: clusterId, managed: true, exists: true }
      : !input.checkpointBucket
        ? { name: clusterId, managed: true }
        : { name: input.checkpointBucket, managed: false };
  const location = { clusterId, region: input.region, zone: input.zone };
  // backup.json records where the installation runs, for delete and restore.
  const backup = {
    ...seed.backupValues({ ...location, bucket }, account),
    account: account.account,
    target: { name: input.name, region: input.region, vmType: input.vmType },
  };
  const values: SeedReleaseValues = {
    ...systemReleaseValues({
      installationId: clusterId,
      cluster: {
        name: input.name,
        kubernetesIdentity: BOOT_PLACEHOLDERS.kubernetesIdentity,
        joinEndpoint: `https://${BOOT_PLACEHOLDERS.publicIp}:${SYSTEM_RELEASE_KUBERNETES_PORT}`,
        certificateAuthorityData: BOOT_PLACEHOLDERS.certificateAuthorityData,
        // What delete and upgrade need (RFC 0049 C26 (a)); the VM fills in
        // its own ID at boot.
        record: {
          cloudProvider: backup.cloudProvider,
          cloudAccount: account.account,
          region: input.region,
          zone: input.zone,
          vmType: input.vmType,
          managementVmId: BOOT_PLACEHOLDERS.managementVmId,
          // The scope the API names and tags network resources with.
          networkScope: clusterNetworkScope(clusterId),
          k3s: {
            version: SYSTEM_RELEASE_K3S_VERSION,
            sha256: SYSTEM_RELEASE_K3S_SHA256,
          },
          checkpointBucket: { name: bucket.name, managed: bucket.managed },
        },
      },
      revision: 1,
      operationId: `op-${clusterId}`,
      apiImage: pinnedApiImage(input.version, digest),
      apiVersion: input.version,
      ownerUsername: input.owner.username,
      ownerUserId: input.owner.id,
      apiUrl: clusterApiUrl(clusterId),
      chart,
      helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      backup,
      restoreFromBackup: restore !== null,
    }),
    backup,
    selfDelete: seed.selfDeleteValues(location, account),
    // The chart mounts the hand-off directory and the script writes the
    // kubeconfig into it: both or neither.
    ...(dependencies.e2eAccess ? { e2eAccess: true as const } : {}),
  };
  const startupScript = managementBootScript({
    cloud: seed.cloud,
    clusterId,
    k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
    k3sSha256: SYSTEM_RELEASE_K3S_SHA256,
    release: {
      values,
      chart,
      jobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      revision: 1,
      operationId: `op-${clusterId}`,
    },
    workerUrl: DNS_WORKER_URL,
    ...(dependencies.e2eAccess ? { e2eAccess: true } : {}),
  });

  progress(`Deploying the management VM in ${input.region}`);
  const outputs = await seed.deploy(
    {
      clusterId,
      clusterName: input.name,
      region: input.region,
      zone: input.zone,
      vmType: input.vmType,
      bucket,
      releaseValues: values,
      startupScript,
      tags: {
        anycloud_cluster: clusterId,
        // Raw: each seed normalizes it for its cloud.
        anycloud_cluster_name: input.name,
        anycloud_owner_api: hostedApiIdentity(clusterId),
      },
    },
    input.signal,
  );

  // The Worker marks the record awaiting bootstrap: the VM asks for its own
  // origin certificate from this address.
  await dependencies.publish(clusterId, outputs.publicIp, input.githubToken, {
    proxied: true,
    bootstrap: true,
  });
  const publishedAt = dependencies.now();
  progress(`Published ${clusterHostname(clusterId)} at ${outputs.publicIp}`);
  await waitForPublicRecord(
    clusterHostname(clusterId),
    publishedAt,
    dependencies,
    input.signal,
  );

  progress('Waiting for the API and its first backup');
  const api = await waitForFirstBackup(
    () => input.hostedApi(clusterApiUrl(clusterId)),
    bucket.name,
    dependencies,
    input.signal,
  );
  return (await api.clusters.get({ params: { id: clusterId } })).cluster;
}

/**
 * The backup in a supplied bucket, once restore's guard passes: the backup
 * names this session's cloud and account and no newer API wrote it, and
 * the backed-up installation is gone, or is the one this name already
 * resumes (a re-run of this restore, or of a create into this bucket).
 * Seeds name resources from the cluster ID, so a resume redeploys that same
 * installation: two APIs never write one bucket. Null when the bucket holds
 * no backup.
 */
async function restorableBackup(
  seed: CloudSeed,
  input: Pick<
    SeedCreateInput,
    'checkpointBucket' | 'region' | 'name' | 'version'
  >,
  account: SeedAccount,
  resumed: string | null,
): Promise<ApiBackupManifest | null> {
  const bucket = input.checkpointBucket!;
  const raw = await seed.readObject(
    bucket,
    API_BACKUP_MANIFEST_KEY,
    input.region,
  );
  if (raw === null) return null;
  const refuse = (message: string): never => {
    throw new SeedCreateError('RESTORE_REFUSED', message);
  };
  let manifest: ApiBackupManifest;
  try {
    manifest = parseApiBackupManifest(raw);
    checkRestoreAccount(manifest, {
      cloud: seed.cloud,
      account: account.account,
    });
  } catch (error) {
    return refuse((error as Error).message);
  }
  const written = manifest.schemaAppVersion;
  if (
    written &&
    semver.valid(written) &&
    semver.valid(input.version) &&
    semver.gt(written, input.version)
  ) {
    refuse(
      `The backup in ${bucket} was written by anycloud ${written}, newer than this CLI (${input.version}); run anycloud update and retry`,
    );
  }
  if (resumed !== null && resumed !== manifest.clusterId) {
    refuse(
      `Cluster ${input.name} already exists as ${resumed}, but the backup in ${bucket} is of cluster ${manifest.clusterId}; restore under another name`,
    );
  }
  const own = resumed === manifest.clusterId;
  const installation = await seed.status(
    manifest.clusterId,
    own ? input.region : (manifest.region ?? input.region),
  );
  const subject = `Cluster ${manifest.clusterId}'s installation`;
  switch (installation.kind) {
    case 'absent':
      return manifest;
    case 'in-progress':
      // This name's own deploy resumes; anyone else's must settle first.
      if (own) return manifest;
      return refuse(
        `${subject} is still changing (${installation.detail}); wait for it to finish, then delete it before restoring, since two APIs must never write one bucket`,
      );
    case 'deployed':
      // A running installation this name holds is resumed as it is.
      if (own && !installation.stopped) return manifest;
      return refuse(
        `${subject} ${installation.stopped ? 'has a stopped management VM' : 'still runs'}; delete it (anycloud api delete ${manifest.clusterId}) before restoring, since two APIs must never write one bucket`,
      );
    case 'failed':
      // A lost VM leaves its stack or group behind, which a resume would
      // adopt without a VM.
      return refuse(
        `${subject} is broken (${installation.detail}); delete it (anycloud api delete ${manifest.clusterId}) before restoring`,
      );
  }
}

async function waitForPublicRecord(
  hostname: string,
  publishedAt: number,
  dependencies: SeedCreateDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await dependencies.sleep(
    Math.max(
      0,
      publishedAt + PUBLIC_RECORD_FIRST_QUERY_MS - dependencies.now(),
    ),
    signal,
  );
  while (dependencies.now() < publishedAt + PUBLIC_RECORD_TIMEOUT_MS) {
    signal?.throwIfAborted();
    // A failed lookup is retried like an absent record.
    const found = await dependencies
      .publicARecordExists(hostname, signal)
      .catch(() => false);
    if (found) return;
    await dependencies.sleep(PUBLIC_RECORD_POLL_MS, signal);
  }
  throw new SeedCreateError(
    'API_NOT_READY',
    `${hostname} did not resolve at 1.1.1.1 within ${PUBLIC_RECORD_TIMEOUT_MS / 60_000} minutes of its DNS record being published`,
  );
}

/**
 * Until the API answers, then until its first backup lands through the VM's
 * identity: create never reports a running cluster without backups. The
 * client is built inside the loop, since building it exchanges a token with
 * the API.
 */
async function waitForFirstBackup(
  connect: () => Promise<ApiClient>,
  bucket: string,
  dependencies: SeedCreateDependencies,
  signal?: AbortSignal,
): Promise<ApiClient> {
  const started = dependencies.now();
  let api: ApiClient | null = null;
  let answeredAt: number | null = null;
  let last = 'the API did not answer';
  for (;;) {
    signal?.throwIfAborted();
    const now = dependencies.now();
    if (answeredAt === null && now - started > API_READY_TIMEOUT_MS) {
      throw new SeedCreateError(
        'API_NOT_READY',
        `The API did not answer within ${API_READY_TIMEOUT_MS / 60_000} minutes (${last}); re-run create to resume, or delete the cluster`,
      );
    }
    if (answeredAt !== null && now - answeredAt > FIRST_BACKUP_STALL_MS) {
      throw new SeedCreateError(
        'FIRST_BACKUP_FAILED',
        `The first backup to ${bucket} did not land within ${FIRST_BACKUP_STALL_MS / 60_000} minutes (${last})`,
      );
    }
    try {
      api ??= await connect();
      const status = await api.systemRelease.status();
      answeredAt ??= dependencies.now();
      const backup = status.firstBackup;
      if (backup?.state === 'landed') return api;
      if (backup?.state === 'failed') {
        throw new SeedCreateError(
          'FIRST_BACKUP_FAILED',
          `The first backup to ${bucket} failed: ${backup.lastError}. Check that the management VM's identity can write the bucket`,
        );
      }
      last = backup?.lastError ?? 'no backup yet';
    } catch (error) {
      if (error instanceof SeedCreateError) throw error;
      last = (error as Error).message;
      // Rebuilt next time: a client holds the bearer it was built with.
      api = null;
    }
    await dependencies.sleep(API_POLL_MS, signal);
  }
}
