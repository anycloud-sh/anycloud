import { describe, expect, it, vi } from 'vitest';
import { PoolScalingLocalContract } from '../integration/e2e/internal/contracts/pool-scaling-local.js';
import { errorMessage } from '../integration/e2e/internal/types.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { trackedNodePoolRefForTest } from './helpers/e2e.js';

type Dependencies = ConstructorParameters<typeof PoolScalingLocalContract>[0];

describe('pool scaling contract', () => {
  it('terminates its submitted Jobs when a scenario fails, keeping the failure', async () => {
    const failure = new Error('the burst never launched');
    const terminatePoolJob = vi.fn(async (id: string) => {
      // A termination that fails must not replace the scenario's error.
      if (id === 'burst-1') throw new Error('terminate refused');
    });
    const ref = trackedNodePoolRefForTest('scaling');
    const status = {
      state: WorkloadState.Running,
      capacity: { readyVmCount: 1 },
    };
    const dependencies = {
      names: {
        nodePool: (name: string) => name,
        workload: (name: string) => name,
      },
      policy: {
        nodePoolTimeoutMs: 1_000,
        workloadTimeoutMs: 1_000,
        idleWindowMs: 1_000,
      },
      progress: { mark: () => undefined },
      clock: { now: () => 0 },
      nodePools: {
        reserve: async () => ref,
        waitForState: async () => undefined,
        status: async () => status,
      },
      wait: {
        async for(
          label: string,
          probe: (attempt: number) => Promise<unknown>,
        ): Promise<unknown> {
          if (label.startsWith('the burst launched')) throw failure;
          return probe(0);
        },
      },
      target: {
        prepare: async () => undefined,
        nodePoolRequest: () => ({}),
        create: async () => ({ id: 'np' }),
        recordNodePool: () => undefined,
        nodePoolReadyByCli: async () => true,
        capacity: async () => ({
          nodePoolId: 'np',
          totalVmCount: 1,
          liveVmCount: 1,
          failedLaunches: [],
        }),
        poolNodeFreeMillicores: async () => 2_000,
        submitPoolJob: async () => ({ exitCode: 0, output: '' }),
        terminatePoolJob,
      },
    };

    await expect(
      new PoolScalingLocalContract(dependencies as unknown as Dependencies).run(
        'e2e-pool-scaling-local',
      ),
    ).rejects.toBe(failure);
    expect(terminatePoolJob.mock.calls.map(([id]) => id).sort()).toEqual([
      'burst-0',
      'burst-1',
      'burst-2',
      'burst-3',
    ]);
  });

  it("deletes its pool only once the last scenario's Jobs stopped holding it", async () => {
    // A Job holds the pool while it runs and, once terminated, for two more
    // pool status reads, until its execution is cleaned up.
    const holding = new Map<string, number | null>();
    const deleted = new Error('pool deleted');
    const ref = trackedNodePoolRefForTest('scaling');
    let node = 0;
    const dependencies = {
      names: {
        nodePool: (name: string) => name,
        workload: (name: string) => name,
      },
      policy: {
        nodePoolTimeoutMs: 1_000,
        workloadTimeoutMs: 1_000,
        idleWindowMs: 1_000,
      },
      progress: { mark: () => undefined },
      clock: { now: () => 0 },
      nodePools: {
        reserve: async () => ref,
        waitForState: async () => undefined,
        status: async () => {
          for (const [id, reads] of holding) {
            if (reads === null) continue;
            if (reads <= 1) holding.delete(id);
            else holding.set(id, reads - 1);
          }
          return {
            state: WorkloadState.Running,
            capacity: { readyVmCount: 1 },
            lastError: 'scale-out blocked by account cap: spent',
            liveReferences: holding.size,
          };
        },
      },
      wait: {
        // The scenarios' waits aren't under test: each passes by its fifth
        // probe.
        async for(
          _label: string,
          probe: (attempt: number) => Promise<unknown>,
          options: { unmet?: (value: unknown) => string | undefined },
        ): Promise<unknown> {
          let value: unknown;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            value = await probe(attempt);
            if (options.unmet?.(value) === undefined) break;
          }
          return value;
        },
      },
      target: {
        prepare: async () => undefined,
        nodePoolRequest: () => ({}),
        create: async () => ({ id: 'np' }),
        recordNodePool: () => undefined,
        nodePoolReadyByCli: async () => true,
        capacity: async () => ({
          nodePoolId: 'np',
          totalVmCount: 1,
          liveVmCount: 1,
          failedLaunches: [],
        }),
        poolNodeFreeMillicores: async () => 2_000,
        submitPoolJob: async (_pool: string, { id }: { id: string }) => {
          holding.set(id, null);
          return { exitCode: 0, output: '' };
        },
        terminatePoolJob: async (id: string) => {
          if (holding.get(id) === null) holding.set(id, 2);
        },
        poolJobStatus: async (id: string) => ({
          workload: {
            state: holding.has(id)
              ? WorkloadState.Running
              : WorkloadState.Terminated,
          },
          events: [],
        }),
        poolJobPod: async (_pool: string, id: string) => ({
          deploymentId: `deployment-${id}`,
          podUid: `pod-${id}`,
        }),
        replicaNode: async () => {
          node += 1;
          return { name: `node-${String(node)}`, vmRowId: node };
        },
        scaleOutPass: () => ({ at: 1, bought: 3 }),
        poolVms: async () => [],
        replaceController: async () => undefined,
        holdNodeWithFinalizer: async () => ({ release: async () => undefined }),
        deploymentPodCount: async () => 0,
        deleteOneCapacityHost: async () => undefined,
        accountBudget: async () => undefined,
        delete: async () => {
          if (holding.size > 0) {
            throw new Error(
              `Node pool delete failed: Node pool still has live references (${[...holding.keys()].join(', ')})`,
            );
          }
          throw deleted;
        },
      },
    };

    await expect(
      new PoolScalingLocalContract(dependencies as unknown as Dependencies).run(
        'e2e-pool-scaling-local',
      ),
    ).rejects.toBe(deleted);
  });
});

describe('harness error messages', () => {
  it("reads a Vitest serialized test error's message", () => {
    expect(
      errorMessage({
        name: 'Error',
        message: 'timed out after 150000ms',
        stack: 'Error: timed out',
      }),
    ).toBe('timed out after 150000ms');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});
