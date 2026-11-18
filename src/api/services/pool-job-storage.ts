import type { WorkloadExecution } from '../../shared/api-contract/deployment-workload-schemas.js';
import { CloudType, type CloudConfig } from '../../shared/cloud.js';
import {
  BucketAccessDeniedError,
  BucketNameTakenError,
  InvalidAnycloudConfigError,
} from '../../shared/errors.js';
import { WorkloadState } from '../../shared/workload.js';
import type { DedicatedWorkloadAdmissionInput } from '../../shared/api-contract/workload-admission-schemas.js';
import { extractCredentials } from '../../shared/cloud-config.js';
import config from '../config.js';
import type { StoredNodePool } from './cluster-store.js';
import type { PoolJobStorageColumns } from './repositories/targeted-job-creation.js';
import {
  decryptCredential,
  loadWorkloadStorageCredentials,
  resolveStorageCredential,
  validateWorkloadStorageRequest,
} from './cloud-config.js';
import { canMintScopedStorageToken } from './gateways/cloud.js';
import {
  getCredentialSecretStore,
  getWorkloadQueryStore,
} from './persistence.js';
import { rcloneGrantRemote } from './rclone-config.js';
import {
  validateImplicitCheckpointName,
  validateWorkloadBucketRoles,
} from './workload-bucket-validation.js';
import type { StoredWorkload } from './workload-record.js';
import {
  ensureWorkloadOutputStorage,
  resolveWorkloadStorage,
  validateExistingWorkloadStorage,
  type ResolvedWorkloadStorage,
  type WorkloadStorageMetadata,
} from './workload-storage.js';

type PoolJobStorage = WorkloadExecution['storage'];

/**
 * One credential per role (RFC 0043): the whole input bucket read-only, only
 * the Job's own `<job-id>/` of output and checkpoints, and the whole managed
 * checkpoint bucket of a spot pool's Job, each with `noDelete`.
 * The runner hands each grant's env to rclone alone, so none of it reaches a
 * Secret, the Pod spec, the command's env or a log.
 */
export async function mintPoolJobGrants(
  storage: ResolvedWorkloadStorage,
): Promise<PoolJobStorage> {
  const grants: PoolJobStorage = {};
  for (const target of Object.values(storage.targets)) {
    const { role, name, mode, provider } = target;
    if (!canMintScopedStorageToken(provider)) {
      throw new Error(`${provider.type} storage can't mint pool Job grants`);
    }
    const prefix =
      role === 'input' || target.cleanupPolicy === 'delete-with-workload'
        ? undefined
        : `${storage.workloadId}/`;
    const token = (await provider.mintScopedStorageToken([
      { bucket: name, prefix, mode, noDelete: true },
    ]))!;
    grants[role] = {
      ...rcloneGrantRemote(
        {
          name,
          cloudType: provider.type,
          region: provider.region,
          storageAccountName: provider.storageAccountName,
          credentials: token.credentials,
          credentialExpiresAt: token.expiresAt,
        },
        prefix,
      ),
      expiresAt: token.expiresAt,
    };
  }
  return grants;
}

/**
 * Create a spot pool Job's managed checkpoint bucket, or reuse the one its
 * account already holds under the Job's ID, and return its region (RFC 0043
 * D-managed). A name another owner holds is refused, never adopted.
 */
async function createManagedCheckpoint(
  storage: ResolvedWorkloadStorage,
  { version, userId }: WorkloadStorageMetadata,
): Promise<string | undefined> {
  const target = storage.targets.checkpoint;
  if (target?.cleanupPolicy !== 'delete-with-workload') return undefined;
  try {
    return await target.provider.createOwnedBucket(
      target.name,
      version,
      storage.workloadId,
      userId,
    );
  } catch (error) {
    if (error instanceof BucketNameTakenError) {
      error.message = `A Spot workload without --checkpoint-bucket uses its ID as its checkpoint bucket name. ${error.message} Pass --checkpoint-bucket or choose a different --id.`;
    } else if (error instanceof BucketAccessDeniedError) {
      error.message = `The checkpoint storage credential can't create the managed checkpoint bucket "${target.name}". ${error.message}`;
    }
    throw error;
  }
}

/**
 * Whether a pool Job owns a managed checkpoint bucket (D-managed): admission
 * selected checkpoint storage for it with no `--checkpoint-bucket`, which only
 * a spot pool's Job gets. It reads the Job's row alone, so it holds after the
 * pool is deleted, as `POOL_MANAGED_CHECKPOINT_SQL` does.
 */
export function managesPoolCheckpoint(
  workload: Pick<
    StoredWorkload,
    'checkpointBucket' | 'checkpointStorageCredentialId'
  >,
): boolean {
  return (
    !workload.checkpointBucket &&
    workload.checkpointStorageCredentialId !== null
  );
}

const ROLES = ['input', 'output', 'checkpoint'] as const;
const ROLE_NAMES = {
  input: 'Input',
  output: 'Output',
  checkpoint: 'Checkpoint',
} as const;

/**
 * A pool Job's storage: each role's credential and region as admission
 * selected and persisted them (RFC 0043 invariant 8), never its node pool's
 * current credential or region, so neither an API restart nor a deleted pool
 * changes the identity that signs. Null when no role has a credential.
 */
export async function loadPoolJobConfigs(
  workload: StoredWorkload,
): Promise<CloudConfig | null> {
  const credentials = await loadWorkloadStorageCredentials(
    workload,
    getCredentialSecretStore(),
  );
  const spot = managesPoolCheckpoint(workload);
  const config: Omit<CloudConfig, 'cloudProvider'> = { ...credentials, spot };
  for (const role of ROLES) {
    const bucket = workload[`${role}Bucket`];
    if (!bucket && !(role === 'checkpoint' && spot)) continue;
    if (!credentials[`${role}StorageCredentials`]) {
      throw new Error(
        `Pool Job ${workload.id} has no ${role} storage credential`,
      );
    }
    config[`${role}Bucket`] = bucket ?? undefined;
    config[`${role}StorageRegion`] =
      workload[`${role}StorageRegion`] ?? undefined;
  }
  // Every role signs with its own credential; the base names no other.
  const signer = ROLES.map(
    (role) => credentials[`${role}StorageCredentials`],
  ).find(Boolean);
  return signer ? { ...config, cloudProvider: signer.cloudProvider } : null;
}

/**
 * Each execution read mints afresh, so a renewal is the same fenced read.
 * While the Job stages, a read also ensures the managed checkpoint bucket
 * admission created, so a claim gets back the bucket cleanup deleted; a name
 * lost since admission throws BucketNameTakenError, which ends the Job
 * `invalid`. Once it runs, a renewal only re-mints for the persisted selection.
 */
export async function mintPoolJobStorage(
  jobId: string,
): Promise<PoolJobStorage> {
  const job = await getWorkloadQueryStore().getWorkload(jobId);
  // A Job with no storage credential has no storage.
  const cloudConfig = job && (await loadPoolJobConfigs(job));
  if (!cloudConfig) return {};
  const storage = await resolveWorkloadStorage(cloudConfig, jobId);
  // Never after the Job ended, which would recreate what cleanup deleted.
  if (job!.state === WorkloadState.Syncing) {
    await createManagedCheckpoint(storage, {
      version: config.currVersion,
      userId: job!.userId,
    });
  }
  return mintPoolJobGrants(storage);
}

// cloudtype-boundary-ok: O26, the storage backends with a per-Job prefix
// minter (invariant 7); R2 waits for CF3.
const POOL_STORAGE_CLOUDS: readonly CloudType[] = [
  CloudType.Azure,
  CloudType.AWS,
  CloudType.GCP,
];

/**
 * Refuse, before the Job is stored, storage its runner couldn't use (RFC 0043
 * § Admission): a backend with no prefix minter, VM Jobs' storage checks, one
 * bucket in two roles, a missing input or checkpoint bucket, or a signing
 * credential that can't mint. A missing output bucket is created, as for VM
 * Jobs, and a managed checkpoint bucket last, once every check has passed.
 * `config` is the node pool's compute credential, region and spot mode with
 * the request's buckets and storage credentials. Returns it resolved, with
 * each bucket's own region.
 */
export async function assertPoolJobStorage(
  id: string,
  config: CloudConfig,
  metadata: WorkloadStorageMetadata,
): Promise<CloudConfig> {
  // The signing credential decides, never the pool's compute provider.
  for (const role of ROLES) {
    const cloud = (config[`${role}StorageCredentials`] ?? config).cloudProvider;
    if (POOL_STORAGE_CLOUDS.includes(cloud)) continue;
    if (config[`${role}Bucket`] || (role === 'checkpoint' && config.spot)) {
      throw new InvalidAnycloudConfigError(
        `The ${role} storage is on ${cloud}, but storage for Jobs on a node pool is on Azure, AWS or GCP. Name a credential for one of them with --${role}-storage-credentials.`,
      );
    }
  }
  // The trial mint below proves an explicit storage credential can sign.
  validateWorkloadStorageRequest(config, false);
  validateWorkloadBucketRoles({ ...config, id });
  validateImplicitCheckpointName(id, config);
  const storage = await resolveWorkloadStorage(config, id);
  await validateExistingWorkloadStorage(storage);
  // Signing needs no container, so an account that can't sign creates none.
  await mintPoolJobGrants(storage);
  await ensureWorkloadOutputStorage(storage, metadata);
  const managedRegion = await createManagedCheckpoint(storage, metadata);
  // A bucket with no region of its own, such as the output bucket created
  // above, is in its provider's: the pool's, else the cloud's default.
  const resolved = { ...storage.cloudConfig };
  for (const { role, provider } of Object.values(storage.targets)) {
    resolved[`${role}StorageRegion`] ??= provider.region;
  }
  if (managedRegion) resolved.checkpointStorageRegion = managedRegion;
  return resolved;
}

/**
 * A pool Job's storage at admission (RFC 0043 O11): each role signs with its
 * named `--<role>-storage-credentials`, else with the node pool's compute
 * credential. The selection is checked, then returned as the columns its row
 * keeps. A Job with no bucket on an on-demand pool, or on a spot pool with
 * `--no-checkpoint`, has none.
 */
export async function admitPoolJobStorage(
  nodePool: Pick<
    StoredNodePool,
    | 'computeCredentialId'
    | 'cloudProvider'
    | 'region'
    | 'clusterRegion'
    | 'spot'
  >,
  input: DedicatedWorkloadAdmissionInput,
  id: string,
  userId: string,
): Promise<PoolJobStorageColumns> {
  const { cloudConfig } = input;
  if (
    input.noCheckpoint &&
    (cloudConfig.checkpointBucket ||
      cloudConfig.checkpointStorageRegion ||
      input.checkpointStorageCredentialName)
  ) {
    throw new InvalidAnycloudConfigError(
      '--no-checkpoint takes no checkpoint storage options.',
    );
  }
  // A spot pool's Job has checkpoint storage even without a bucket, unless
  // `--no-checkpoint` drops it.
  const spot = nodePool.spot && !input.noCheckpoint;
  const region = nodePool.region ?? nodePool.clusterRegion ?? undefined;
  const request: Omit<CloudConfig, 'cloudProvider'> = {};
  const columns: PoolJobStorageColumns = {};
  for (const role of ROLES) {
    const bucket = cloudConfig[`${role}Bucket`];
    const storageRegion = cloudConfig[`${role}StorageRegion`];
    const name = input[`${role}StorageCredentialName`];
    if (cloudConfig[`${role}StorageCredentials`]) {
      throw new InvalidAnycloudConfigError(
        `A Job on a node pool takes a saved credential's name with --${role}-storage-credentials, not inline credentials.`,
      );
    }
    if (!bucket && !(role === 'checkpoint' && spot)) {
      if (storageRegion || name) {
        throw new InvalidAnycloudConfigError(
          `Storage options for the ${role} bucket need --${role}-bucket.`,
        );
      }
      continue;
    }
    const named = name
      ? await resolveStorageCredential(name, ROLE_NAMES[role])
      : undefined;
    request[`${role}Bucket`] = columns[`${role}Bucket`] = bucket;
    request[`${role}StorageCredentials`] = named?.creds;
    // A managed bucket is created in the pool's region when it signs on the
    // pool's cloud, so its name, which another owner may hold, is never
    // looked up.
    const poolCloud =
      !named || named.creds.cloudProvider === nodePool.cloudProvider;
    request[`${role}StorageRegion`] =
      storageRegion ?? (bucket || !poolCloud ? undefined : region);
    columns[`${role}StorageCredentialId`] =
      named?.id ?? nodePool.computeCredentialId;
  }
  if (Object.keys(columns).length === 0) return {};
  const row = await getCredentialSecretStore().getCredentialWithCloudProvider(
    nodePool.computeCredentialId,
  );
  if (!row) throw new Error('The node pool has no compute credential');
  const compute = await decryptCredential(row.encryptedData);
  const resolved = await assertPoolJobStorage(
    id,
    {
      ...request,
      cloudProvider: row.cloudProvider,
      credentials: extractCredentials(compute),
      region,
      spot,
    },
    { version: config.currVersion, userId },
  );
  for (const role of ROLES) {
    if (!columns[`${role}StorageCredentialId`]) continue;
    // Each bucket's own (an S3 bucket's, a reused managed one's), else its
    // provider's, as Azure and GCS have no bucket region lookup.
    columns[`${role}StorageRegion`] = resolved[`${role}StorageRegion`];
  }
  return columns;
}
