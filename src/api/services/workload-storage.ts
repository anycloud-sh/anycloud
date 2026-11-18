import { resolveCheckpointTarget } from '../../shared/checkpoint.js';
import { DeployError } from '../../shared/errors.js';
import { type CloudConfig, type CloudType } from '../../shared/cloud.js';
import { validateBucketName } from '../../shared/cloud-config.js';
import {
  createCheckpointStorageProvider,
  createInputStorageProvider,
  createOutputStorageProvider,
  resolveRuntimeBucketStorageRegions,
  type RuntimeBucketStorageRole,
  type RuntimeBucketStorageProviderFactories,
} from './cloud-config.js';
import { canListObjects, type CloudStorage } from './gateways/cloud.js';
import type { CheckpointHealth } from '../../shared/api-contract/workload-management-schemas.js';
import { isApiBackupBucket } from './bucket-storage-operation.js';
import { log } from './logger.js';

export type WorkloadStorageRole = RuntimeBucketStorageRole;
type WorkloadStorageCleanupPolicy = 'retain' | 'delete-with-workload';
type WorkloadStorageMode = 'read' | 'readwrite';

interface ResolvedWorkloadStorageTarget {
  role: WorkloadStorageRole;
  name: string;
  mode: WorkloadStorageMode;
  cleanupPolicy: WorkloadStorageCleanupPolicy;
  provider: CloudStorage;
}

export interface ResolvedWorkloadStorage {
  cloudConfig: CloudConfig;
  workloadId: string;
  targets: Partial<Record<WorkloadStorageRole, ResolvedWorkloadStorageTarget>>;
}

export interface WorkloadStorageMetadata {
  version: string;
  userId: string;
}

export type WorkloadStorageProviderFactories =
  RuntimeBucketStorageProviderFactories;

const DEFAULT_STORAGE_PROVIDER_FACTORIES: WorkloadStorageProviderFactories = {
  input: (cloudConfig) => createInputStorageProvider(cloudConfig),
  output: (cloudConfig) => createOutputStorageProvider(cloudConfig),
  checkpoint: (cloudConfig) => createCheckpointStorageProvider(cloudConfig),
};

const ALL_WORKLOAD_STORAGE_ROLES: readonly WorkloadStorageRole[] = [
  'input',
  'output',
  'checkpoint',
];

/** A role's cloud: its storage credential's, else the compute cloud's. */
function storageCloud(
  cloudConfig: CloudConfig,
  role: WorkloadStorageRole,
): CloudType {
  return (cloudConfig[`${role}StorageCredentials`] ?? cloudConfig)
    .cloudProvider;
}

/**
 * Resolve only the requested storage roles for one workload operation.
 *
 * The result is an operation-local cache, not durable state. Every operation can
 * reconstruct it from the workload row and credentials after an API restart.
 */
export async function resolveWorkloadStorage(
  cloudConfig: CloudConfig,
  workloadId: string,
  roles: readonly WorkloadStorageRole[] = ALL_WORKLOAD_STORAGE_ROLES,
  providers: WorkloadStorageProviderFactories = DEFAULT_STORAGE_PROVIDER_FACTORIES,
): Promise<ResolvedWorkloadStorage> {
  const checkpoint = resolveCheckpointTarget(workloadId, cloudConfig);
  const names = {
    input: cloudConfig.inputBucket,
    output: cloudConfig.outputBucket,
    checkpoint: checkpoint?.name,
  };
  // Before any provider call, so not even a region lookup reaches it.
  for (const role of roles) {
    const name = names[role] ?? undefined;
    if (isApiBackupBucket(name, storageCloud(cloudConfig, role))) {
      throw new DeployError(
        `The ${role} bucket "${name}" is this API's own backup bucket and cannot be used by a workload.`,
        400,
      );
    }
  }
  const resolved = await resolveRuntimeBucketStorageRegions(
    cloudConfig,
    checkpoint?.name,
    roles,
    providers,
  );
  const selected = new Set(roles);
  const targets: ResolvedWorkloadStorage['targets'] = {};

  if (selected.has('input') && resolved.inputBucket) {
    targets.input = {
      role: 'input',
      name: resolved.inputBucket,
      mode: 'read',
      cleanupPolicy: 'retain',
      provider: providers.input(resolved),
    };
  }
  if (selected.has('output') && resolved.outputBucket) {
    targets.output = {
      role: 'output',
      name: resolved.outputBucket,
      mode: 'readwrite',
      cleanupPolicy: 'retain',
      provider: providers.output(resolved),
    };
  }
  if (selected.has('checkpoint') && checkpoint) {
    targets.checkpoint = {
      role: 'checkpoint',
      name: checkpoint.name,
      mode: 'readwrite',
      cleanupPolicy: checkpoint.managed ? 'delete-with-workload' : 'retain',
      provider: providers.checkpoint(resolved),
    };
  }

  return { cloudConfig: resolved, workloadId, targets };
}

/** Validate storage that must already exist without mutating provider state. */
export async function validateExistingWorkloadStorage(
  storage: ResolvedWorkloadStorage,
): Promise<void> {
  const input = storage.targets.input;
  if (input && !(await input.provider.hasBucket(input.name))) {
    throw new DeployError(
      `Bucket '${input.name}' does not exist. Please create it before deploying.`,
      400,
    );
  }

  const checkpoint = storage.targets.checkpoint;
  if (
    checkpoint?.cleanupPolicy === 'retain' &&
    !(await checkpoint.provider.hasBucket(checkpoint.name))
  ) {
    throw new DeployError(
      `Checkpoint bucket '${checkpoint.name}' does not exist. Please create it before deploying.`,
      400,
    );
  }
}

/** Ensure the retained output target exists. The operation is idempotent. */
export async function ensureWorkloadOutputStorage(
  storage: ResolvedWorkloadStorage,
  metadata: WorkloadStorageMetadata,
): Promise<void> {
  const output = storage.targets.output;
  if (!output) return;
  await output.provider.upsertBucket(
    output.name,
    metadata.version,
    storage.workloadId,
    metadata.userId,
  );
  log.info('Output bucket ready', {
    id: storage.workloadId,
    bucket: output.name,
  });
}

/** Ensure the workload-owned implicit checkpoint exists. Idempotent. */
export async function ensureManagedWorkloadCheckpoint(
  storage: ResolvedWorkloadStorage,
  metadata: WorkloadStorageMetadata,
): Promise<void> {
  const checkpoint = storage.targets.checkpoint;
  if (checkpoint?.cleanupPolicy !== 'delete-with-workload') return;
  await checkpoint.provider.upsertBucket(
    checkpoint.name,
    metadata.version,
    storage.workloadId,
    metadata.userId,
  );
  log.info('Checkpoint bucket ready', {
    id: storage.workloadId,
    bucket: checkpoint.name,
  });
}

/** Delete only storage whose lifecycle belongs to this workload. */
export async function cleanupManagedWorkloadStorage(
  cloudConfig: CloudConfig,
  workloadId: string,
  providers: WorkloadStorageProviderFactories = DEFAULT_STORAGE_PROVIDER_FACTORIES,
): Promise<void> {
  const checkpoint = resolveCheckpointTarget(workloadId, cloudConfig);
  if (!checkpoint) return;
  if (!checkpoint.managed) {
    log.info('Retained checkpoint bucket preserved', {
      id: workloadId,
      bucket: checkpoint.name,
    });
    return;
  }
  // Refused at admission; a record from before that must not retry forever.
  if (
    isApiBackupBucket(checkpoint.name, storageCloud(cloudConfig, 'checkpoint'))
  ) {
    log.warn('Checkpoint bucket is the API backup bucket; not deleting it', {
      id: workloadId,
      bucket: checkpoint.name,
    });
    return;
  }

  const storage = await resolveWorkloadStorage(
    cloudConfig,
    workloadId,
    ['checkpoint'],
    providers,
  );
  const target = storage.targets.checkpoint;
  if (!target || target.cleanupPolicy !== 'delete-with-workload') return;
  // The cloud never created a bucket under a name its rule rejects, and its
  // delete call errors rather than reporting not-found, which would keep the
  // workload a cleanup candidate forever.
  try {
    validateBucketName(target.provider.type, target.name);
  } catch {
    log.info('Checkpoint bucket name is invalid; nothing to delete', {
      id: workloadId,
      bucket: target.name,
    });
    return;
  }
  await target.provider.deleteBucket(target.name);
  log.info('Checkpoint bucket deleted', {
    id: workloadId,
    bucket: target.name,
  });
}

const CHECKPOINT_HEALTH_PAGE_SIZE = 1000;

/**
 * Summarize what has reached a Workload's checkpoint bucket from one recursive
 * page: the bucket is the source of truth for sync, on any substrate.
 */
export async function readWorkloadCheckpointHealth(
  cloudConfig: CloudConfig,
  workloadId: string,
  prefix = '',
  providers: WorkloadStorageProviderFactories = DEFAULT_STORAGE_PROVIDER_FACTORIES,
): Promise<CheckpointHealth> {
  const { targets } = await resolveWorkloadStorage(
    cloudConfig,
    workloadId,
    ['checkpoint'],
    providers,
  );
  const target = targets.checkpoint;
  if (!target) throw new Error(`Workload ${workloadId} has no checkpoint`);
  if (!canListObjects(target.provider)) {
    throw new Error(`${target.provider.type} storage cannot list objects`);
  }
  const page = await target.provider.listObjects(target.name, {
    prefix,
    recursive: true,
    pageSize: CHECKPOINT_HEALTH_PAGE_SIZE,
  });
  let objects = 0;
  let bytes = 0;
  let lastModifiedAt: number | null = null;
  for (const entry of page.entries) {
    if (entry.kind !== 'object') continue;
    objects += 1;
    bytes += entry.sizeBytes ?? 0;
    if (
      entry.lastModifiedAt !== null &&
      (lastModifiedAt === null || entry.lastModifiedAt > lastModifiedAt)
    ) {
      lastModifiedAt = entry.lastModifiedAt;
    }
  }
  return {
    objects,
    bytes,
    lastModifiedAt,
    truncated: page.nextCursor !== null,
  };
}
