import { resolveCheckpointTarget } from '../../shared/checkpoint.js';
import { type CloudConfig } from '../../shared/cloud.js';
import { validateNewBucketName } from '../../shared/cloud-config.js';
import { DeployError } from '../../shared/errors.js';
import { getApiBackupConfig } from '../config.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

export interface WorkloadBucketRoles {
  id: string;
  spot?: boolean | null;
  inputBucket?: string | null;
  outputBucket?: string | null;
  checkpointBucket?: string | null;
}

/**
 * Bucket roles use different sync strategies, so one workload cannot assign
 * the same bucket to more than one role. No role may use the API's own backup
 * bucket, which holds its cipher key and database.
 */
export function validateWorkloadBucketRoles(input: WorkloadBucketRoles): void {
  const checkpoint = resolveCheckpointTarget(input.id, input);
  const backup = getApiBackupConfig()?.bucket;
  for (const [role, bucket] of [
    ['Input', input.inputBucket],
    ['Output', input.outputBucket],
    ['Checkpoint', checkpoint?.name],
  ]) {
    if (backup && bucket === backup) {
      throw new DeployError(
        `${role} bucket "${bucket}" is this API's own backup bucket and cannot be used by a workload.`,
        400,
      );
    }
  }
  if (checkpoint && input.inputBucket === checkpoint.name) {
    throw new DeployError(
      `Input bucket name cannot be "${checkpoint.name}" (conflicts with checkpoint bucket)`,
      400,
    );
  }
  if (checkpoint && input.outputBucket === checkpoint.name) {
    throw new DeployError(
      `Output bucket name cannot be "${checkpoint.name}" (conflicts with checkpoint bucket)`,
      400,
    );
  }
  if (input.inputBucket && input.inputBucket === input.outputBucket) {
    throw new DeployError(
      'Input and output buckets must be different (conflicting sync strategies)',
      400,
    );
  }
}

/**
 * A Spot workload without `--checkpoint-bucket` gets a checkpoint bucket named
 * after its ID, which the workload ID rule alone does not make valid on every
 * cloud (for example `--` on Azure, or `goog` on GCS).
 */
export function validateImplicitCheckpointName(
  id: string,
  config: CloudConfig,
): void {
  const checkpoint = resolveCheckpointTarget(id, config);
  if (!checkpoint?.managed) return;
  try {
    validateNewBucketName(
      config.checkpointStorageCredentials?.cloudProvider ??
        config.cloudProvider,
      checkpoint.name,
    );
  } catch (error) {
    throw new DeployError(
      `A Spot workload without --checkpoint-bucket uses its ID as its checkpoint bucket name. ${errorMessage(error)} Pass --checkpoint-bucket or choose a different --id.`,
      400,
    );
  }
}
