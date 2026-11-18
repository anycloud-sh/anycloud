/** Where a Workload's checkpoint bucket is mounted inside its container. */
export const CHECKPOINT_MOUNT_PATH = '/mnt/checkpoint';

export interface CheckpointTargetConfig {
  checkpointBucket?: string | null;
  spot?: boolean | null;
  /** A Spot Job's `--no-checkpoint`: no managed bucket. */
  noCheckpoint?: boolean | null;
}

export interface CheckpointTarget {
  name: string;
  /** True only when workload cleanup owns and deletes this bucket. */
  managed: boolean;
}

/**
 * Resolve the effective checkpoint bucket for one workload.
 *
 * A persisted name is retained and therefore never deleted by workload
 * cleanup. It is user-supplied for Jobs and VM-backed Services, including
 * hosted APIs. Spot workloads retain their existing implicit workload-ID
 * bucket, whose lifecycle is managed by Anycloud.
 */
export function resolveCheckpointTarget(
  workloadId: string,
  config: CheckpointTargetConfig,
): CheckpointTarget | undefined {
  if (config.checkpointBucket) {
    return { name: config.checkpointBucket, managed: false };
  }
  if (config.spot && !config.noCheckpoint) {
    return { name: workloadId, managed: true };
  }
  return undefined;
}

/** Whether a request has checkpoint storage, even before its ID is allocated. */
export function hasCheckpointTarget(config: CheckpointTargetConfig): boolean {
  return Boolean(
    config.checkpointBucket || (config.spot && !config.noCheckpoint),
  );
}
