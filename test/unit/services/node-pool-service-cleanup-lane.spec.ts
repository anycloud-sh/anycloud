import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkloadOutcomes } from '../../../src/api/services/persistence.js';

const serveRuntime = vi.hoisted(() => ({
  deploy: vi.fn(),
  update: vi.fn(),
  teardown: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('../../../src/api/services/serve/default-runtime.js', () => ({
  getDefaultServeRuntime: () => serveRuntime,
}));

import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  requireTestWorkload,
  seedTestWorkload,
} from '../../helpers/workload-store.js';

const SERVICE_ID = 'svc-cleanup';

async function seedTerminatedNodePoolService(): Promise<void> {
  await getDB().query(
    `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
     VALUES ('compute-gcp', 'opaque', 'GCP', 'gcp-compute', 1, 1)`,
  );
  await getPersistence().clusters.recordSelf({
    id: 'cluster-a',
    ownerUserId: 'owner-1',
    name: 'production',
    kubernetesIdentity: 'uid-cluster-a',
    connection:
      '{"apiVersion":"v1","kind":"Config","current-context":"cluster"}',
  });
  await getPersistence().nodePools.create({
    id: 'node-pool-gcp',
    clusterId: 'cluster-a',
    ownerUserId: 'owner-1',
    name: 'gcp-central',
    computeCredentialId: 'compute-gcp',
    region: 'us-central1',
    zone: null,
    vmTypes: ['n2-standard-4'],
    minVmCount: 1,
    maxVmCount: 1,
  });
  await getPersistence().nodePools.markReady('node-pool-gcp');
  await seedTestWorkload({
    id: SERVICE_ID,
    userId: 'alice',
    ownerUserId: 'owner-1',
    workloadType: 'service',
    image: 'ghcr.io/acme/api:v1',
    dockerCommand: '',
    nodePoolId: 'node-pool-gcp',
    state: WorkloadState.Running,
  });
  await getWorkloadOutcomes().requestTermination(SERVICE_ID, { kind: 'api' });
}

describe('node pool Service terminal cleanup lane', () => {
  beforeEach(async () => {
    resetPersistence();
    vi.clearAllMocks();
    await seedTerminatedNodePoolService();
  });

  it('asks the Serve runtime to remove native objects with the node pool cloud and then commits cleaned_at', async () => {
    serveRuntime.cleanup.mockResolvedValue(undefined);
    await runWorkloadReconcileOnce();

    expect(serveRuntime.cleanup).toHaveBeenCalledTimes(1);
    const request = serveRuntime.cleanup.mock.calls[0][0] as {
      workload: { id: string; cloudProvider: CloudType | null };
      placement: { cloudConfig: { cloudProvider: CloudType } };
    };
    expect(request.workload.id).toBe(SERVICE_ID);
    expect(request.workload.cloudProvider).toBe(CloudType.GCP);
    expect(request.placement.cloudConfig).toEqual({
      cloudProvider: CloudType.GCP,
    });
    const workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Terminated);
    expect(workload.cleanedAt).not.toBeNull();
    await expect(
      getPersistence().nodePoolServices.hasLiveNodePoolReferences(
        'node-pool-gcp',
      ),
    ).resolves.toBe(false);
  });

  it('keeps cleanup open while native objects remain and never marks it complete without the runtime', async () => {
    serveRuntime.cleanup.mockRejectedValue(
      new Error('Timed out deleting Namespace anycloud-serve-svc-cleanup'),
    );
    await runWorkloadReconcileOnce();
    expect(serveRuntime.cleanup).toHaveBeenCalledTimes(1);
    const workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.cleanedAt).toBeNull();
    await expect(
      getPersistence().nodePoolServices.hasLiveNodePoolReferences(
        'node-pool-gcp',
      ),
    ).resolves.toBe(true);
  });
});
