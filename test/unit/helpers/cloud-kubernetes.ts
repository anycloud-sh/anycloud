import type { StatusWorkloadMetadata } from '../../../src/shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../../src/shared/runtime.js';
import type { StatusResponse } from '../../integration/e2e/internal/types.js';

function hostWorkload(
  id: string,
  state: WorkloadState,
  cleanedAt: number | null = null,
): StatusWorkloadMetadata {
  const terminal = state === WorkloadState.Terminated;
  return {
    id,
    userId: 'e2e-user',
    workloadType: WorkloadType.Service,
    image: 'alpine:3.20',
    cloudProvider: CloudType.Lambda,
    region: null,
    vmType: ['cpu_4x_general', 'gpu_1x_a10'],
    gpuType: null,
    spot: false,
    state,
    startedAt: 1,
    completedAt: terminal ? 100 : null,
    cleanedAt,
    endReason: null,
    lastAttemptEndReason: null,
    version: '1.0.0',
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: null,
    diskTier: null,
    diskIops: null,
    diskThroughputMibps: null,
    regions: null,
    dockerOptions: null,
    availabilityZone: null,
    vmCount: terminal ? 0 : 1,
    inputStorageRegion: null,
    outputStorageRegion: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    vmDurationMs: null,
    awaitingReleaseMs: null,
    totalCost: null,
    costSource: null,
    dnsRecordId: null,
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
  };
}

export function cloudHostStatusForTest(
  id: string,
  state: WorkloadState,
  cleanedAt: number | null = null,
): StatusResponse {
  return {
    workload: hostWorkload(id, state, cleanedAt),
    events: [
      {
        id: 1,
        workloadId: id,
        state,
        metadata: null,
        createdAt: 100,
      },
    ],
    status: WorkloadHealthStatus.Up,
    vms: [
      {
        cloudId: 'host-vm',
        region: 'us-east-1',
        endedAt: null,
        ip: '203.0.113.1',
      },
    ],
  };
}
