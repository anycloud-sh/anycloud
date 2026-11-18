/**
 * The admission-only targeted-Job inserts: a Job on a user Deployment, and a
 * pool Job on its node pool's managed Deployment (RFC 0044 decision 26).
 */

import { type DB, type DBTransaction } from './db.js';
import type { JobChanges } from '../job-changes.js';
import { WorkloadState } from '../../../shared/workload.js';
import { commitWorkloadChanges } from './workload-lifecycle.js';
import {
  encodeContainerSpec,
  insertContainerSpec,
  type ContainerSpec,
} from '../container-spec.js';
import {
  insertDeployment,
  renewRegistryToken,
  type CreateDeploymentInput,
} from '../deployment-store.js';
import type { OwnershipScope } from './ownership-filter.js';

/** A Job on a user Deployment persists identity and attribution; its runtime configuration belongs to the Deployment. */
export interface CreateTargetedWorkloadInput {
  claimDeadlineAt?: number | null;
  maxRetries?: number;
  id: string;
  userId: string;
  ownerUserId?: string;
  deploymentId: string;
  session?: string;
  agent?: string;
  sessionLabel?: string;
}

/**
 * A pool Job's buckets, with each role's selected storage credential and
 * region, as its row keeps them; execution minting reads them back.
 */
export interface PoolJobStorageColumns {
  inputBucket?: string;
  outputBucket?: string;
  checkpointBucket?: string;
  inputStorageCredentialId?: string;
  outputStorageCredentialId?: string;
  checkpointStorageCredentialId?: string;
  inputStorageRegion?: string;
  outputStorageRegion?: string;
  checkpointStorageRegion?: string;
}

/** A pool Job also has its own container spec: image, command and env. */
export interface CreatePoolJobInput
  extends Omit<CreateTargetedWorkloadInput, 'deploymentId'> {
  spec: ContainerSpec;
  storage: PoolJobStorageColumns;
  /** Inserted when the node pool has no live managed Deployment with its key. */
  deployment: CreateDeploymentInput & {
    managedKey: string;
    runnerRelease: string;
  };
  scope: OwnershipScope;
}

function insertTargetedJob(
  tx: DBTransaction,
  input: CreateTargetedWorkloadInput,
  storage: PoolJobStorageColumns = {},
): boolean {
  const now = Date.now();
  const inserted = tx.query<{ rowsAffected: number }>(
    `INSERT INTO workloads (
      id, user_id, owner_user_id, deployment_id, workload_type,
      state, started_at, submitted_at, claim_deadline_at, max_retries, docker_command, session, agent, session_label,
      input_bucket, output_bucket, checkpoint_bucket,
      input_storage_credential_id, output_storage_credential_id,
      checkpoint_storage_credential_id,
      input_storage_region, output_storage_region, checkpoint_storage_region
    ) SELECT ?, ?, ?, target.id, 'job', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM deployments target WHERE target.id = ?
      AND target.deletion_requested_at IS NULL AND target.deleted_at IS NULL`,
    [
      input.id,
      input.userId,
      input.ownerUserId ?? null,
      WorkloadState.Queued,
      now,
      now,
      input.claimDeadlineAt ?? null,
      input.maxRetries ?? null,
      input.session ?? null,
      input.agent ?? null,
      input.sessionLabel ?? null,
      storage.inputBucket ?? null,
      storage.outputBucket ?? null,
      storage.checkpointBucket ?? null,
      storage.inputStorageCredentialId ?? null,
      storage.outputStorageCredentialId ?? null,
      storage.checkpointStorageCredentialId ?? null,
      storage.inputStorageRegion ?? null,
      storage.outputStorageRegion ?? null,
      storage.checkpointStorageRegion ?? null,
      input.deploymentId,
    ],
  );
  return inserted[0]?.rowsAffected === 1;
}

/** Admit a Job on a user Deployment; false when the Deployment is draining. */
export async function createTargetedWorkload(
  db: DB,
  jobChanges: JobChanges,
  input: CreateTargetedWorkloadInput,
): Promise<boolean> {
  return commitWorkloadChanges(db, jobChanges, (tx, changed) => {
    if (!insertTargetedJob(tx, input)) return false;
    const specs = tx.query<{ found: number }>(
      'SELECT 1 AS found FROM container_specs WHERE workload_id = ?',
      [input.id],
    );
    if (specs.length !== 0) {
      throw new Error(
        `Workload ${input.id}: container spec ownership is incomplete`,
      );
    }
    changed(input.id);
    return true;
  });
}

/**
 * Admit a pool Job on the managed Deployment for its node pool and key,
 * creating that Deployment in the same transaction if none is live. Null
 * when the node pool stopped accepting work first.
 */
export async function createPoolJob(
  db: DB,
  jobChanges: JobChanges,
  input: CreatePoolJobInput,
): Promise<string | null> {
  const { deployment } = input;
  const [spec, config] = await Promise.all([
    encodeContainerSpec(input.spec, `Workload ${input.id}`),
    encodeContainerSpec(deployment.config, `Deployment ${deployment.id}`),
  ]);
  return commitWorkloadChanges(db, jobChanges, (tx, changed) => {
    const [found] = tx.query<{ id: string }>(
      `SELECT id FROM deployments WHERE node_pool_id = ? AND managed_key = ?
         AND deletion_requested_at IS NULL`,
      [deployment.nodePoolId, deployment.managedKey],
    );
    if (!found && !insertDeployment(tx, deployment, config, input.scope)) {
      return null;
    }
    const deploymentId = found?.id ?? deployment.id;
    // The newest Job's registry token renews the replicas' pull Secret.
    if (found && config.registry_token !== null) {
      renewRegistryToken(tx, found.id, config.registry_token);
    }
    if (!insertTargetedJob(tx, { ...input, deploymentId }, input.storage)) {
      throw new Error(`Managed Deployment ${deploymentId} is not live`);
    }
    insertContainerSpec(tx, { workloadId: input.id }, spec);
    changed(input.id);
    return deploymentId;
  });
}
