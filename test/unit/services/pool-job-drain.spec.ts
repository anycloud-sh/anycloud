import { describe, expect, it, vi } from 'vitest';
import { createPoolJobDrain } from '../../../src/api/services/pool-job-drain.js';
import { kubernetesWorkloadPodSelector } from '../../../src/api/services/kubernetes/identity.js';
import type { PoolJobInFlight } from '../../../src/api/services/repositories/pool-job-store.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { makeClusterKubernetesClientFixture } from '../helpers/fixtures.js';

const job: PoolJobInFlight = {
  id: 'job-1',
  state: WorkloadState.Running,
  deploymentId: 'managed-1',
  nodePoolId: 'pool-a',
  nodePool: 'gpu',
  executionId: 'execution-1',
  podUid: 'uid-1',
  runnerRelease: '0.1.70',
};

function harness(pods: { name: string; uid: string; deleting?: boolean }[]) {
  const listNamespacedPod = vi.fn(async () => ({
    items: pods.map((pod) => ({
      metadata: {
        name: pod.name,
        uid: pod.uid,
        ...(pod.deleting && { deletionTimestamp: new Date() }),
      },
    })),
  }));
  const deleteNamespacedPod = vi.fn(async () => ({}));
  const executions = {
    pauseManagedClaims: vi.fn(),
    markForcedStop: vi.fn(),
  };
  const drain = createPoolJobDrain({
    executions,
    inFlight: async () => [job],
    runtimes: {
      resolve: vi.fn(async () => ({
        config: { namespace: 'anycloud-pool-a' },
        cluster: makeClusterKubernetesClientFixture({
          core: { listNamespacedPod, deleteNamespacedPod },
        }),
        nodePool: {
          clusterId: 'c',
          nodePoolId: 'pool-a',
          nvidiaGpusPerNode: 0,
        },
      })),
    },
  });
  return { drain, executions, listNamespacedPod, deleteNamespacedPod };
}

describe('the upgrade drain (decision 30)', () => {
  it('holds managed claims for ten minutes and lists the pool Jobs in flight, stopping nothing', async () => {
    const f = harness([{ name: 'replica-1', uid: 'uid-1' }]);
    const before = Date.now();
    await expect(f.drain(false)).resolves.toEqual([job]);
    const until = f.executions.pauseManagedClaims.mock.calls[0]![0] as number;
    expect(until - before).toBeGreaterThanOrEqual(600_000);
    expect(f.executions.markForcedStop).not.toHaveBeenCalled();
    expect(f.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('with force marks each execution and deletes its replica by UID, once', async () => {
    const f = harness([
      { name: 'replica-0', uid: 'uid-0' },
      { name: 'replica-1', uid: 'uid-1' },
    ]);
    await f.drain(true);
    expect(f.executions.markForcedStop).toHaveBeenCalledExactlyOnceWith(
      'execution-1',
    );
    expect(f.listNamespacedPod).toHaveBeenCalledWith(
      {
        namespace: 'anycloud-pool-a',
        labelSelector: kubernetesWorkloadPodSelector('managed-1'),
      },
      expect.anything(),
    );
    expect(f.deleteNamespacedPod).toHaveBeenCalledExactlyOnceWith(
      {
        namespace: 'anycloud-pool-a',
        name: 'replica-1',
        body: { preconditions: { uid: 'uid-1' } },
      },
      expect.anything(),
    );
    const again = harness([
      { name: 'replica-1', uid: 'uid-1', deleting: true },
    ]);
    await again.drain(true);
    expect(again.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('with force leaves a Job whose runner release the new release keeps (RFC 0049 C27)', async () => {
    const f = harness([{ name: 'replica-1', uid: 'uid-1' }]);
    await expect(f.drain(true, ['0.1.71', '0.1.70'])).resolves.toEqual([job]);
    expect(f.executions.markForcedStop).not.toHaveBeenCalled();
    expect(f.deleteNamespacedPod).not.toHaveBeenCalled();

    await f.drain(true, ['0.1.72', '0.1.71']);
    expect(f.deleteNamespacedPod).toHaveBeenCalledOnce();
  });
});
