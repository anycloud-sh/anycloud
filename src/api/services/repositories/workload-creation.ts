/**
 * Admission's Workload insert: the row, its owned container spec and, for
 * test fixtures only, an initial-state event, in one transaction. Only the
 * admission writer may call it (dependency-cruiser); consumers import types.
 */

import { GHCR_TOKEN_USERNAME } from '../../../shared/image.js';
import { type DB } from './db.js';
import { nodePoolGpuReservationSql } from './node-pool-references.js';
import { CloudType, type DiskTier } from '../../../shared/cloud.js';
import {
  WorkloadState,
  isTerminalState,
  type WorkloadTypeValue,
} from '../../../shared/workload.js';
import { ImageRuntime } from '../../../shared/image.js';
import { type DockerOptions } from '../../../shared/runtime.js';
import { validateWorkloadBucketRoles } from '../workload-bucket-validation.js';
import { encryptSecret } from '../secret-crypto.js';
import { encodeContainerSpec, insertContainerSpec } from '../container-spec.js';
import { eventMetadataColumn } from '../workload-event-metadata.js';

// vmType / gpuType columns are TEXT and accept either a scalar string (legacy
// rows + single-value users) or a JSON-encoded array (ordered fallback list).
// Arrays are stringified on write and detected by a leading `[` on read.
function serializeStringOrArray(
  v: string | string[] | undefined,
): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? JSON.stringify(v) : v;
}

// Input for creating a new workload
export interface CreateWorkloadInput {
  id: string;
  /** Historical/provider-facing GitHub username stored in user_id. */
  userId: string;
  /** Immutable authorization id. Omitted only by legacy/test seeders. */
  ownerUserId?: string;
  workloadType: WorkloadTypeValue;
  image: string;
  region?: string;
  vmType?: string | string[];
  gpuType?: string | string[];
  spot?: boolean;
  dockerCommand: string;
  inputBucket?: string;
  outputBucket?: string;
  checkpointBucket?: string;
  diskSizeGb?: number;
  diskTier?: DiskTier;
  dockerOptions?: DockerOptions;
  availabilityZone?: string;
  env?: Record<string, string>;
  githubToken?: string;
  sshPrivateKey: string;
  credentialId?: string | null;
  requestedComputeProvider?: CloudType | null;
  /** Explicit node pool target; the insert is refused unless it is ready. */
  nodePoolId?: string;
  /** GPUs the node pool's ready VMs hold; the insert is refused if `dockerOptions.gpus` no longer fits. */
  nodePoolGpuBound?: number;
  inputStorageCredentialId?: string;
  inputStorageRegion?: string;
  outputStorageCredentialId?: string;
  outputStorageRegion?: string;
  checkpointStorageCredentialId?: string;
  checkpointStorageRegion?: string;
  command?: string[];
  imageDigest?: string;
  imageRuntime?: ImageRuntime;
  secretNames?: string[];
  session?: string;
  agent?: string;
  sessionLabel?: string;
  maxRetries?: number;
  /** A Spot VM Job without the managed checkpoint bucket (0166). */
  noCheckpoint?: boolean;
  /** A VM Job launched with nested virtualization on (0166). */
  requireNestedVirtualization?: boolean;
  /** A VM Job given the host's Docker socket (0167). */
  hostDocker?: boolean;
  /** A VM Job's own AWS gp3 root volume IOPS and MiB/s (0168). */
  diskIops?: number;
  diskThroughputMibps?: number;
  /** A VM Job's region allow-list (0169). */
  regions?: string[];
}

/**
 * Create a new workload record. `initialState` is test-only; production
 * admission omits it and always creates Queued work.
 */
export async function createWorkload(
  db: DB,
  input: CreateWorkloadInput,
  options?: { initialState: WorkloadState },
): Promise<void> {
  const now = Date.now();
  const initialState = options?.initialState ?? WorkloadState.Queued;
  validateWorkloadBucketRoles(input);
  const [encryptedSshKey, spec] = await Promise.all([
    encryptSecret(input.sshPrivateKey),
    encodeContainerSpec(
      {
        image: input.image,
        imageDigest: input.imageDigest ?? null,
        command: input.command ?? null,
        dockerOptions: input.dockerOptions ?? null,
        env: input.env ?? null,
        registryUsername: GHCR_TOKEN_USERNAME,
        registryToken: input.githubToken ?? null,
      },
      `Workload ${input.id}`,
    ),
  ]);

  // Owner and admitted configuration commit together. submitted_at remains
  // the original submission even when started_at changes on a later attempt.
  await db.transaction((tx) => {
    if (input.nodePoolGpuBound !== undefined) {
      const [row] = tx.query<{ reserved: number }>(
        `SELECT ${nodePoolGpuReservationSql('?')} AS reserved`,
        [input.nodePoolId ?? null, input.nodePoolId ?? null],
      );
      if (
        (row?.reserved ?? 0) + Number(input.dockerOptions?.gpus ?? 0) >
        input.nodePoolGpuBound
      ) {
        throw new Error('node pool GPU capacity is reserved');
      }
    }
    const inserted = tx.query<{ rowsAffected: number }>(
      `INSERT INTO workloads (
        id, user_id, owner_user_id, workload_type,
        region, vm_type, gpu_type, spot, state, started_at, submitted_at,
        completed_at, docker_command, input_bucket, output_bucket, checkpoint_bucket,
        disk_size_gb, disk_tier, availability_zone, ssh_private_key,
        credential_id, requested_compute_provider, node_pool_id,
        input_storage_credential_id, input_storage_region,
        output_storage_credential_id, output_storage_region,
        checkpoint_storage_credential_id, checkpoint_storage_region,
        image_runtime, secret_names, session, agent, session_label, max_retries,
        no_checkpoint, require_nested_virtualization, host_docker,
        disk_iops, disk_throughput_mibps, regions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.userId,
        input.ownerUserId ?? null,
        input.workloadType,
        input.region ?? null,
        serializeStringOrArray(input.vmType),
        serializeStringOrArray(input.gpuType),
        input.spot ? 1 : 0,
        initialState,
        now,
        now,
        isTerminalState(initialState) ? now : null,
        input.dockerCommand,
        input.inputBucket ?? null,
        input.outputBucket ?? null,
        input.checkpointBucket ?? null,
        input.diskSizeGb ?? null,
        input.diskTier ?? null,
        input.availabilityZone ?? null,
        encryptedSshKey,
        input.credentialId ?? null,
        input.requestedComputeProvider ?? null,
        input.nodePoolId ?? null,
        input.inputStorageCredentialId ?? null,
        input.inputStorageRegion ?? null,
        input.outputStorageCredentialId ?? null,
        input.outputStorageRegion ?? null,
        input.checkpointStorageCredentialId ?? null,
        input.checkpointStorageRegion ?? null,
        input.imageRuntime ?? null,
        input.secretNames?.length ? JSON.stringify(input.secretNames) : null,
        input.session ?? null,
        input.agent ?? null,
        input.sessionLabel ?? null,
        input.maxRetries ?? null,
        input.noCheckpoint ? 1 : 0,
        input.requireNestedVirtualization ? 1 : 0,
        input.hostDocker ? 1 : 0,
        input.diskIops ?? null,
        input.diskThroughputMibps ?? null,
        input.regions?.length ? JSON.stringify(input.regions) : null,
      ],
    );
    if (inserted[0]?.rowsAffected !== 1) {
      throw new Error(
        `Workload ${input.id}: expected exactly one workload insert`,
      );
    }
    insertContainerSpec(tx, { workloadId: input.id }, spec);
    if (initialState !== WorkloadState.Queued) {
      tx.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, ?, ?)`,
        [input.id, initialState, eventMetadataColumn(null), now],
      );
    }
  });
}
