import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../src/api/services/kubernetes/identity.js';
import { ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE } from '../../../src/api/services/kubernetes/pool-objects.js';
import {
  getDeploymentStore,
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import config from '../../../src/api/config.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { claimSpendBlock } from '../../../src/api/services/spend-controls.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import {
  makeClusterKubernetesClientFixture,
  makeContainerSpec,
} from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

// Each replica's token names its own Pod, which the real store then sees.
function replicas() {
  const persistence = getPersistence();
  const broken = new Set<string>();
  const discover = vi.spyOn(
    persistence.deploymentExecutions,
    'discoverTargetedJob',
  );
  const cluster = makeClusterKubernetesClientFixture({
    authentication: {
      createTokenReview: vi.fn(
        async ({ body }: { body: { spec: { token: string } } }) => ({
          spec: body.spec,
          status: {
            authenticated: true,
            audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
            user: {
              username: `system:serviceaccount:namespace:${kubernetesWorkloadResourceName('deployment', 'deployment')}`,
              extra: {
                'authentication.kubernetes.io/pod-uid': [body.spec.token],
                'authentication.kubernetes.io/pod-name': [body.spec.token],
              },
            },
          },
        }),
      ),
    },
    core: {
      readNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
        if (broken.has(name)) throw new Error('apiserver unavailable');
        return {
          metadata: {
            name,
            uid: name,
            labels: Object.fromEntries([
              kubernetesWorkloadPodSelector('deployment').split('='),
            ]) as Record<string, string>,
            annotations: { 'anycloud.sh/generation': '1' },
          },
          status: {
            phase: 'Running',
            containerStatuses: [
              {
                name: 'workload',
                ready: true,
                // Before kubelet reports it, the replica is unready (full).
                containerID: name.startsWith('unready')
                  ? undefined
                  : `container-${name}`,
                image: 'image',
                imageID: 'image-id',
                restartCount: 0,
              },
            ],
          },
        };
      }),
    },
  });
  const domain = createDeploymentWorkloadDomain({
    reconcile: () => undefined,
    jobChanges: persistence.jobChanges,
    claimSpendBlock,
    mintStorage: async () => ({}),
    deployments: persistence.deployments,
    jobs: persistence.deploymentExecutions,
    runtimes: {
      resolve: vi.fn().mockResolvedValue({
        config: { namespace: 'namespace' },
        nodePool: {
          clusterId: 'cluster',
          nodePoolId: 'pool',
          nvidiaGpusPerNode: 0,
        },
        cluster,
      }),
    },
  });
  const conflicts: string[] = [];
  /** The runner's loop: discover, claim, and discover again after a 409. */
  async function claimOne(pod: string): Promise<string> {
    for (;;) {
      const found = await domain.candidate(
        'deployment',
        20_000,
        `Bearer ${pod}`,
        {
          signal: new AbortController().signal,
          startedAt: performance.now(),
          deadlineAt: Infinity,
        },
        config.currVersion,
      );
      if (found.status !== 200) continue;
      try {
        await domain.claim(
          'deployment',
          found.body.jobId,
          randomUUID(),
          found.body,
          `Bearer ${pod}`,
          undefined,
          config.currVersion,
        );
        return found.body.jobId;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 409) throw error;
        conflicts.push(pod);
      }
    }
  }
  return { domain, discover, conflicts, claimOne, broken };
}

/** A managed Deployment on which only `pod` has its slot bound. */
async function managedWithOnlyPodBound(): Promise<void> {
  await getDB().query(
    "UPDATE deployments SET managed = 1 WHERE id = 'deployment'",
  );
  const vm = await getPersistence().nodePoolVms.beginVmAttempt('pool', {
    cloudId: 'node',
    region: 'us-east-1',
    availabilityZone: null,
    vmType: 't3.large',
    pricePerHour: 1,
    desiredVmCount: 1,
  });
  await getPersistence().deployments.recordOccupancy(
    'deployment',
    [{ podUid: 'pod', vmId: vm!.vmRowId, share: 1, gpus: 0 }],
    ['pod'],
  );
}

async function admit(id: string): Promise<void> {
  expect(
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id,
      deploymentId: 'deployment',
      userId: 'owner',
      ownerUserId: 'owner',
    }),
  ).toBe(true);
}

beforeEach(async () => {
  resetPersistence();
  await seedReadyNodePool({ nodePoolId: 'pool', ownerUserId: 'owner' });
  await getDeploymentStore().create(
    {
      id: 'deployment',
      ownerUserId: 'owner',
      name: 'deployment',
      nodePoolId: 'pool',
      config: makeContainerSpec(),
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
    },
    { kind: 'api' },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPersistence();
});

describe('claim queue de-herd', () => {
  it('hands N waiting replicas N distinct Jobs without a conflict', async () => {
    const n = 12;
    const f = replicas();
    const pods = Array.from({ length: n }, (_, i) => `pod-${i}`);
    const claimed = Promise.all(pods.map((pod) => f.claimOne(pod)));
    await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(n));
    f.discover.mockClear();
    await Promise.all(pods.map((_, i) => admit(`job-${i}`)));
    expect(new Set(await claimed).size).toBe(n);
    expect(f.conflicts).toEqual([]);
    // Main woke every waiter on every change: n² discoveries.
    expect(f.discover.mock.calls.length).toBeLessThanOrEqual(2 * n);
  });

  it.each([
    ['unready', 'full'],
    ['unbound', 'full'],
    ['failing', 'its pass throws'],
  ])(
    'hands on the wake of a longest waiting replica that is %s',
    async (first, outcome) => {
      const f = replicas();
      if (first === 'unbound') await managedWithOnlyPodBound();
      const stop = new AbortController();
      const waiting = f.domain.candidate(
        'deployment',
        20_000,
        `Bearer ${first}`,
        {
          signal: stop.signal,
          startedAt: performance.now(),
          deadlineAt: Infinity,
        },
        config.currVersion,
      );
      void waiting.catch(() => undefined);
      await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(1));
      const claimed = f.claimOne('pod');
      await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(2));
      if (first === 'failing') f.broken.add(first);
      await admit('job');
      // Swallowed, the wake would leave it to the 20 s renewal.
      await expect(
        Promise.race([claimed, delay(2_000).then(() => 'stalled')]),
      ).resolves.toBe('job');
      if (outcome === 'full')
        await expect(f.discover.mock.results[2]!.value).resolves.toEqual({
          kind: 'full',
        });
      else await expect(waiting).rejects.toMatchObject({ statusCode: 503 });
      stop.abort(new Error('done'));
    },
  );

  it('offers again a Job whose replica took its candidate and never claimed', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'],
    });
    const f = replicas();
    await admit('job');
    expect(
      await f.domain.candidate('deployment', 0, 'Bearer gone'),
    ).toMatchObject({ status: 200, body: { jobId: 'job' } });
    const startedAt = performance.now();
    let claimedAt = 0;
    const claimed = f.claimOne('pod').then((jobId) => {
      claimedAt = performance.now();
      return jobId;
    });
    for (let s = 0; s < 60 && !claimedAt; s++)
      await vi.advanceTimersByTimeAsync(1_000);
    expect(await claimed).toBe('job');
    // The 30 s offer, then at most one 20 s long-poll renewal.
    expect(claimedAt - startedAt).toBeGreaterThanOrEqual(30_000);
    expect(claimedAt - startedAt).toBeLessThanOrEqual(50_000);
  });
});
