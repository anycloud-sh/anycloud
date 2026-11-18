import {
  InvalidAnycloudConfigError,
  TransientInfraError,
} from '../../shared/errors.js';
import { type StoredWorkload } from './workload-record.js';
import { type StatusWorkloadMetadata } from '../../shared/api-contract/workload-management-schemas.js';
import {
  createCheckpointStorageProvider,
  loadWorkloadConfigs,
} from './cloud-config.js';
import { getCredentialSecretStore } from './persistence.js';
import {
  isTransientTransportError,
  type CloudStorage,
} from './gateways/cloud.js';

export function normalizeAttribution(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length === 0 ? null : normalized;
}

export function toStatusWorkloadMetadata(
  workload: StoredWorkload,
): StatusWorkloadMetadata {
  return {
    id: workload.id,
    userId: workload.userId,
    deploymentId: workload.deploymentId,
    nodePoolId: workload.nodePoolId,
    nodePoolName: workload.nodePoolName,
    submissionRevision: workload.submissionRevision,
    claimDeadlineAt: workload.claimDeadlineAt,
    claimed: workload.firstClaimedAt !== null,
    workloadType: workload.workloadType,
    image: workload.image,
    cloudProvider: workload.cloudProvider,
    region: workload.region,
    vmType: workload.vmType,
    gpuType: workload.gpuType,
    spot: workload.spot,
    state: workload.state,
    startedAt: workload.startedAt,
    completedAt: workload.completedAt,
    cleanedAt: workload.cleanedAt,
    cleanupError: workload.cleanupError ?? null,
    endReason: workload.endReason,
    lastAttemptEndReason: workload.lastAttemptEndReason,
    // Retired: the submitted-with version is no longer stored (RFC 0031);
    // the wire field stays for older CLIs and always reads null.
    version: null,
    dockerCommand: workload.dockerCommand,
    inputBucket: workload.inputBucket,
    outputBucket: workload.outputBucket,
    checkpointBucket: workload.checkpointBucket,
    diskSizeGb: workload.diskSizeGb,
    diskTier: workload.diskTier,
    diskIops: workload.diskIops,
    diskThroughputMibps: workload.diskThroughputMibps,
    regions: workload.regions,
    dockerOptions: workload.dockerOptions,
    availabilityZone: workload.availabilityZone,
    vmCount: workload.vmCount,
    inputStorageRegion: workload.inputStorageRegion,
    outputStorageRegion: workload.outputStorageRegion,
    checkpointStorageRegion: workload.checkpointStorageRegion,
    command: workload.command,
    imageDigest: workload.imageDigest,
    vmDurationMs: workload.vmDurationMs,
    awaitingReleaseMs: workload.awaitingReleaseMs,
    totalCost: workload.totalCost,
    costSource: workload.costSource,
    dnsRecordId: workload.dnsRecordId,
    publicEndpoint: workload.publicEndpoint,
    secretNames: workload.secretNames,
    session: workload.session,
    agent: workload.agent,
    sessionLabel: workload.sessionLabel,
  };
}

export async function bucketExistsForRequest(
  storage: CloudStorage,
  bucketName: string,
): Promise<boolean> {
  try {
    return await storage.hasBucket(bucketName);
  } catch (error) {
    if (isTransientTransportError(error)) {
      throw new TransientInfraError(
        'Cloud storage is temporarily unavailable while validating the bucket — please retry.',
      );
    }
    throw error;
  }
}

export async function prepareStoredServiceCheckpoint(
  workload: StoredWorkload,
  operation: 'upgrade' | 'terminate',
): Promise<void> {
  const operationVerb = operation === 'upgrade' ? 'upgrading' : 'terminating';

  if (!workload.checkpointBucket) return;

  const cloudConfig = await loadWorkloadConfigs(workload);
  if (!cloudConfig) {
    throw new InvalidAnycloudConfigError(
      `Stored credentials for checkpoint bucket "${workload.checkpointBucket}" are unavailable. Restore them before ${operationVerb} this Service.`,
    );
  }

  const storage = createCheckpointStorageProvider(cloudConfig);
  if (!(await bucketExistsForRequest(storage, workload.checkpointBucket))) {
    throw new InvalidAnycloudConfigError(
      `Checkpoint bucket "${workload.checkpointBucket}" not found. Recreate it before ${operationVerb} this Service so its state can be flushed safely.`,
    );
  }
}

/** The named-secret read that proves each requested secret exists. */
interface RuntimeSecrets {
  getSecretValues(name: string): Promise<Record<string, string> | null>;
}

export async function preflightRuntimeSecrets(
  secretNames: readonly string[] | null | undefined,
): Promise<void> {
  const store: RuntimeSecrets = getCredentialSecretStore();
  for (const name of secretNames ?? []) {
    if ((await store.getSecretValues(name)) === null) {
      throw new InvalidAnycloudConfigError(`Secret "${name}" not found`);
    }
  }
}
