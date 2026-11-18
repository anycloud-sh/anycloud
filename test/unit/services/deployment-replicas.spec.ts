import { describe, expect, it, vi } from 'vitest';
import type { V1Deployment, V1Pod } from '@kubernetes/client-node';
import {
  createReplicaPolicy,
  IN_FLIGHT_CAP,
  type ReplicaPolicyInput,
} from '../../../src/api/services/deployment-replicas.js';
import { DRAINING_COST } from '../../../src/api/services/kubernetes/pool-objects.js';
import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import type { ManagedDemand } from '../../../src/api/services/repositories/replica-demand.js';
import {
  makeClusterKubernetesClientFixture,
  makeContainerSpec,
  makeReplicaPolicyDependencies,
} from '../helpers/fixtures.js';

const COST = 'controller.kubernetes.io/pod-deletion-cost';

function deployment(overrides: Partial<StoredDeployment> = {}) {
  return {
    id: 'deployment',
    ownerUserId: 'owner',
    name: 'deployment',
    nodePoolId: 'pool',
    config: makeContainerSpec(),
    readinessProbe: null,
    gracePeriodSeconds: 30,
    secretNames: [],
    gpuCount: 0,
    maxConcurrentJobsPerReplica: 1,
    minReplicas: 1,
    maxReplicas: 3,
    managed: false,
    runnerRelease: null,
    generation: 1,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } satisfies StoredDeployment;
}

function pod(
  uid: string,
  ready = true,
  draining = false,
  phase = 'Running',
): V1Pod {
  return {
    metadata: {
      uid,
      name: uid,
      namespace: 'pool-ns',
      annotations: draining ? { [COST]: DRAINING_COST } : {},
    },
    status: {
      phase,
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
    },
  };
}

/** A native Deployment at `replicas`, settled unless `scaling`. */
function native(
  replicas: number,
  scaling = false,
  readyReplicas = replicas,
): V1Deployment {
  return {
    metadata: { generation: 2 },
    spec: { replicas, selector: {}, template: {} },
    status: { observedGeneration: scaling ? 1 : 2, replicas, readyReplicas },
  };
}

const idle = { queued: 0, running: 0, retrying: 0, terminal: 0, unreleased: 0 };

function harness(deps = makeReplicaPolicyDependencies()) {
  const patchNamespacedPod = vi.fn(async () => ({}));
  const cluster = makeClusterKubernetesClientFixture({
    core: { patchNamespacedPod },
  });
  const replicas = createReplicaPolicy(deps);
  return {
    deps,
    patchNamespacedPod,
    run: (input: Partial<ReplicaPolicyInput>) =>
      replicas({
        deployment: deployment(),
        current: undefined,
        pods: [],
        jobs: idle,
        template: {
          spec: {
            containers: [
              {
                name: 'workload',
                resources: {
                  requests: { 'nvidia.com/gpu': '1', cpu: '8', memory: '32Gi' },
                },
              },
            ],
          },
        },
        nodePool: {
          clusterId: 'cluster',
          nodePoolId: 'pool',
          nvidiaGpusPerNode: 8,
          nodeSize: { vCPUs: 64, memoryGiB: 256 },
        },
        cluster,
        ...input,
      }),
  };
}

describe('RA replica policy', () => {
  it('scales a claim-queue Deployment on queued plus held Jobs between its bounds', async () => {
    const { run } = harness();
    // Nothing queued keeps the minimum; one held and one queued take 1 → 2.
    await expect(run({ current: native(1) })).resolves.toBe(1);
    await expect(
      run({
        current: native(1),
        pods: [pod('a')],
        jobs: { ...idle, queued: 1, running: 1, unreleased: 1 },
      }),
    ).resolves.toBe(2);
    // A retrying Job is demand; slots per replica divide it; max caps it.
    await expect(
      run({
        deployment: deployment({ maxConcurrentJobsPerReplica: 2 }),
        current: native(1),
        jobs: { ...idle, queued: 2, retrying: 1 },
      }),
    ).resolves.toBe(2);
    await expect(
      run({ current: native(1), jobs: { ...idle, queued: 9 } }),
    ).resolves.toBe(3);
    // `--replicas N` is min = max = N: a fixed count, whatever the demand.
    const fixed = deployment({ minReplicas: 2, maxReplicas: 2 });
    await expect(run({ deployment: fixed })).resolves.toBe(2);
    await expect(
      run({
        deployment: fixed,
        current: native(2),
        jobs: { ...idle, queued: 9 },
      }),
    ).resolves.toBe(2);
  });

  it('holds a step-up while spend caps block the pool, but never below the minimum', async () => {
    const { deps, run } = harness();
    deps.capBlocked.mockResolvedValue(true);
    await expect(
      run({ current: native(1), jobs: { ...idle, queued: 5 } }),
    ).resolves.toBe(1);
    expect(deps.capBlocked).toHaveBeenCalledWith('pool');
    await expect(
      run({ deployment: deployment({ minReplicas: 2 }), current: native(1) }),
    ).resolves.toBe(2);
    deps.capBlocked.mockResolvedValue(false);
    await expect(
      run({ current: native(1), jobs: { ...idle, queued: 5 } }),
    ).resolves.toBe(3);
  });

  it('0044/14 drains Pending replicas first, then only idle started ones', async () => {
    const { deps, patchNamespacedPod, run } = harness();
    // Down to the minimum from 2 with one Pending replica: the ReplicaSet
    // removes it first, and it is drained and marked as a started one is.
    await expect(
      run({
        current: native(2, false, 1),
        pods: [pod('a'), pod('pending', false, false, 'Pending')],
      }),
    ).resolves.toBe(1);
    expect(deps.drainReplica.mock.calls.map(([, uid]) => uid)).toEqual([
      'pending',
    ]);
    expect(patchNamespacedPod).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'pending' }),
      expect.anything(),
    );
    deps.drainReplica.mockClear();
    patchNamespacedPod.mockClear();
    // From 3 ready replicas, one busy: the two idle ones are closed to
    // claims, get the lowest deletion cost, and only then is the count cut.
    deps.drainReplica.mockImplementation(async (_id, uid) => uid !== 'busy');
    await expect(
      run({
        current: native(3),
        pods: [pod('busy'), pod('b'), pod('c')],
        jobs: { ...idle, running: 1, unreleased: 1 },
      }),
    ).resolves.toBe(1);
    expect(deps.drainReplica.mock.calls.map(([, uid]) => uid)).toEqual([
      'busy',
      'b',
      'c',
    ]);
    expect(patchNamespacedPod).toHaveBeenCalledTimes(2);
    expect(patchNamespacedPod).toHaveBeenCalledWith(
      {
        namespace: 'pool-ns',
        name: 'b',
        body: [
          { op: 'test', path: '/metadata/uid', value: 'b' },
          {
            op: 'add',
            path: '/metadata/annotations/controller.kubernetes.io~1pod-deletion-cost',
            value: DRAINING_COST,
          },
        ],
      },
      expect.anything(),
    );
    // Every replica busy: none is removed, so the count stays.
    deps.drainReplica.mockResolvedValue(false);
    await expect(
      run({ current: native(2), pods: [pod('x'), pod('y')] }),
    ).resolves.toBe(2);
  });

  it('0044/14 keeps every replica while a busy not-ready one would go first', async () => {
    const { deps, patchNamespacedPod, run } = harness();
    // The ReplicaSet removes a not-ready replica before any ready one, so
    // with the not-ready one busy, an idle ready one can't be dropped.
    deps.drainReplica.mockImplementation(async (_id, uid) => uid !== 'stuck');
    await expect(
      run({
        current: native(2, false, 1),
        pods: [pod('stuck', false), pod('idle')],
        jobs: { ...idle, running: 1, unreleased: 1 },
      }),
    ).resolves.toBe(2);
    expect(patchNamespacedPod).not.toHaveBeenCalled();
    // An idle not-ready replica is drained and marked like a ready one.
    deps.drainReplica.mockResolvedValue(true);
    await expect(
      run({
        current: native(2, false, 1),
        pods: [pod('unready', false), pod('b')],
      }),
    ).resolves.toBe(1);
    expect(patchNamespacedPod).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'unready' }),
      expect.anything(),
    );
  });

  it('cuts nothing until the ReplicaSet has settled on the listed Pods', async () => {
    const { deps, run } = harness();
    const pods = [pod('a'), pod('b')];
    // The last cut not yet observed or carried out, a Pod the cache doesn't
    // list yet, and a replica the ReplicaSet still sees starting: each
    // would let it remove one RA never closed.
    for (const current of [
      native(2, true),
      { ...native(2), status: { observedGeneration: 2, replicas: 3 } },
      native(3),
      native(2, false, 1),
    ]) {
      await expect(run({ current, pods })).resolves.toBe(
        current.spec!.replicas,
      );
    }
    expect(deps.drainReplica).not.toHaveBeenCalled();
    await expect(run({ current: native(2), pods })).resolves.toBe(1);
  });

  it('0044/14 ignores evicted and finished Pods the ReplicaSet no longer counts', async () => {
    const { deps, patchNamespacedPod, run } = harness();
    const evicted = pod('f', false, false, 'Failed');
    await expect(
      run({
        current: native(2),
        pods: [
          evicted,
          pod('done', false, false, 'Succeeded'),
          pod('a'),
          pod('b'),
        ],
      }),
    ).resolves.toBe(1);
    expect(deps.drainReplica.mock.calls.map(([, uid]) => uid)).toEqual(['a']);
    expect(patchNamespacedPod).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'a' }),
      expect.anything(),
    );
    // A kept draining replica reopens though an evicted Pod is still listed.
    await expect(
      run({ current: native(1), pods: [evicted, pod('a', true, true)] }),
    ).resolves.toBe(1);
    expect(deps.reopenReplica).toHaveBeenCalledWith('a');
  });

  it('reopens a draining replica the settled ReplicaSet kept, and unmarks a busy one', async () => {
    const { deps, patchNamespacedPod, run } = harness();
    // Mid scale-down the mark stays, and so it does while the Pod cache
    // still lists the replica the settled ReplicaSet is removing.
    await expect(
      run({ current: native(1, true), pods: [pod('a', true, true)] }),
    ).resolves.toBe(1);
    await expect(
      run({ current: native(1), pods: [pod('a', true, true), pod('b')] }),
    ).resolves.toBe(1);
    expect(deps.reopenReplica).not.toHaveBeenCalled();
    await expect(
      run({ current: native(1), pods: [pod('a', true, true)] }),
    ).resolves.toBe(1);
    expect(deps.reopenReplica).toHaveBeenCalledWith('a');
    expect(patchNamespacedPod).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: [
          { op: 'test', path: '/metadata/uid', value: 'a' },
          {
            op: 'remove',
            path: '/metadata/annotations/controller.kubernetes.io~1pod-deletion-cost',
          },
        ],
      }),
      expect.anything(),
    );
    // A marked replica that claimed a Job (its in-process mark lost to a
    // restart) loses its cost rather than be removed while busy.
    patchNamespacedPod.mockClear();
    deps.drainReplica.mockResolvedValue(false);
    await expect(
      run({ current: native(2), pods: [pod('busy', true, true), pod('c')] }),
    ).resolves.toBe(2);
    expect(patchNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'busy' }),
      expect.anything(),
    );
  });

  it('releases a replica it closed if marking its Pod fails, and cuts nothing', async () => {
    const { deps, patchNamespacedPod, run } = harness();
    patchNamespacedPod.mockRejectedValue(new Error('apiserver down'));
    await expect(
      run({ current: native(2), pods: [pod('a'), pod('b')] }),
    ).rejects.toThrow('apiserver down');
    expect(deps.reopenReplica).toHaveBeenCalledWith('a');
  });

  describe('managed Deployments', () => {
    const managed = deployment({
      managed: true,
      minReplicas: 0,
      gpuCount: 1,
    });
    const job = (
      deploymentId: string,
      held = false,
      session: string | null = null,
    ): ManagedDemand => ({
      deploymentId,
      session,
      held,
      hourlyUsd: null,
    });

    it('scales from 0 on queued pool Jobs and back to 0', async () => {
      const { deps, run } = harness();
      await expect(run({ deployment: managed })).resolves.toBe(0);
      deps.listManagedDemand.mockResolvedValue([
        job('deployment', true),
        job('deployment'),
        job('other'),
      ]);
      await expect(
        run({ deployment: managed, current: native(0) }),
      ).resolves.toBe(2);
      deps.listManagedDemand.mockResolvedValue([]);
      await expect(
        run({
          deployment: managed,
          current: native(2),
          pods: [pod('a'), pod('b')],
        }),
      ).resolves.toBe(0);
    });

    it('fills the in-flight cap in global submit order of claimable Jobs', async () => {
      const { deps, run } = harness();
      const admit = vi.fn(async (session: string | null) =>
        session === 'capped' ? { kind: 'budget' } : null,
      );
      deps.demandAdmission.mockResolvedValue(admit);
      // 197 held and a capped session's backlog submitted first: the
      // backlog asks for nothing, and 3 slots go to the oldest claimable.
      deps.listManagedDemand.mockResolvedValue([
        ...Array.from({ length: IN_FLIGHT_CAP - 3 }, () => job('other', true)),
        ...Array.from({ length: 50 }, () => job('deployment', false, 'capped')),
        job('other'),
        job('deployment'),
        job('deployment'),
        job('deployment'),
      ]);
      await expect(
        run({ deployment: managed, current: native(0) }),
      ).resolves.toBe(2);
      // The claim's check prices each Job at its replica's share before
      // one exists: one of 8 GPUs and an eighth of the Node.
      deps.managedRoom.mockResolvedValue({
        maxVms: 4,
        reservedGpus: 0,
        vmPrice: 16,
      });
      admit.mockClear();
      await run({ deployment: managed, current: native(0) });
      expect(admit).toHaveBeenCalledWith(null, 2);
      expect(admit).toHaveBeenCalledWith(null, undefined);
      // A CPU pool's replica is not priced, though the pool VM has a size.
      admit.mockClear();
      await run({
        deployment: { ...managed, gpuCount: 0 },
        current: native(0),
        nodePool: {
          clusterId: 'cluster',
          nodePoolId: 'pool',
          nvidiaGpusPerNode: 0,
          nodeSize: { vCPUs: 16, memoryGiB: 64 },
        },
      });
      expect(admit).toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalledWith(null, expect.any(Number));
    });

    it('0044/S13 never takes GPUs that user Deployments reserve', async () => {
      const { deps, run } = harness();
      deps.listManagedDemand.mockResolvedValue(
        Array.from({ length: 100 }, () => job('deployment')),
      );
      // Two 8-GPU Nodes at most; a user Deployment reserves 3 GPUs.
      deps.managedRoom.mockResolvedValue({
        maxVms: 2,
        reservedGpus: 3,
        vmPrice: null,
      });
      await expect(
        run({ deployment: managed, current: native(0) }),
      ).resolves.toBe(13);
      deps.managedRoom.mockResolvedValue({
        maxVms: 1,
        reservedGpus: 9,
        vmPrice: null,
      });
      await expect(
        run({ deployment: managed, current: native(0) }),
      ).resolves.toBe(0);
    });
  });
});
