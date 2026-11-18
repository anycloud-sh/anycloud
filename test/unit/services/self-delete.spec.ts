import { describe, expect, it, vi } from 'vitest';
import {
  createSelfDelete,
  type SelfDeleteDependencies,
} from '../../../src/api/services/self-delete';
import {
  createCloudResourceSweeper,
  type ResourceSweepOptions,
  type ResourceSweepResult,
} from '../../../src/api/services/gateways/resource-sweeper';
import { CloudType } from '../../../src/shared/cloud.js';

const clean = (): ResourceSweepResult => ({
  vmIds: [],
  otherResources: [],
  errors: [],
});

function world(
  overrides: Partial<SelfDeleteDependencies> & {
    sweep?: (options: ResourceSweepOptions) => ResourceSweepResult;
    storage?: (options: ResourceSweepOptions) => ResourceSweepResult;
  } = {},
) {
  const order: string[] = [];
  const calls: ResourceSweepOptions[] = [];
  let removed!: () => void;
  const gone = new Promise<void>((resolve) => (removed = resolve));
  const deps: SelfDeleteDependencies = {
    clusterId: 'prod-1',
    installation: {
      clusterId: 'prod-1',
      cloud: 'aws',
      region: 'us-east-1',
      bucket: { name: 'prod-1', managed: true },
    },
    requireOwner: async (actorId) => {
      if (actorId !== 'owner') throw new Error('not the owner');
    },
    liveDependents: async () => ({ pools: [], workloads: [] }),
    backup: { run: vi.fn(async () => order.push('backup')) },
    sweeperFor: () =>
      createCloudResourceSweeper({
        type: CloudType.AWS,
        region: 'us-east-1',
        rawSweepResources: async (options) => {
          calls.push(options);
          if (!options.dryRun) order.push('sweep');
          return overrides.sweep?.(options) ?? { ...clean(), vmIds: ['i-job'] };
        },
        rawSweepStorage: async (options) => {
          calls.push(options);
          if (!options.dryRun) order.push('buckets');
          return (
            overrides.storage?.(options) ?? {
              ...clean(),
              otherResources: [{ type: 'bucket', id: 'job-1-out' }],
            }
          );
        },
      }),
    removeSelf: async () => {
      order.push('remove');
      removed();
    },
    cleanupPending: async () => [],
    sleep: async () => undefined,
    now: () => Date.parse('2026-11-07T10:00:00Z'),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, order, calls, gone, selfDelete: createSelfDelete(deps) };
}

describe('the hosted API deleting itself', () => {
  it('backs up, answers, waits for Workload cleanups, sweeps leftover VMs keeping its own scope and bucket, and removes itself last', async () => {
    let cleanups = [{ id: 'job-1', error: null }];
    const { selfDelete, order, calls, gone } = world({
      cleanupPending: async () => {
        const pending = cleanups;
        cleanups = [];
        return pending;
      },
    });
    const answer = await selfDelete.request('owner', {
      clusterId: 'prod-1',
      deleteBuckets: false,
    });
    expect(answer).toMatchObject({
      state: 'sweeping',
      finalBackup: 'taken',
      backedUpAt: '2026-11-07T10:00:00.000Z',
    });
    await gone;
    expect(order).toEqual(['backup', 'sweep', 'remove']);
    expect(selfDelete.status()).toMatchObject({
      state: 'removing',
      deleted: [{ type: 'vm', id: 'i-job', location: null }],
      remaining: [],
    });
    for (const { policy } of calls) {
      expect(policy.installation).toMatchObject({
        clusterId: 'prod-1',
        // Ended VM-host VMs go; nothing may still serve (refused first).
        spareRunningWorkloads: false,
        keep: {
          resourceOwnerIds: ['anycloud-cluster-prod-1'],
          names: ['prod-1'],
        },
      });
      expect(policy.installation?.resourceOwnerIds).toEqual([]);
    }
  });

  it('reports a Workload whose cleanup never commits, and still deletes itself', async () => {
    let now = 0;
    const { selfDelete, gone } = world({
      cleanupPending: async () => [
        { id: 'job-2', error: 'credential aws-old was deleted' },
      ],
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await selfDelete.request('owner', {
      clusterId: 'prod-1',
      deleteBuckets: false,
    });
    await gone;
    expect(selfDelete.status().remaining).toEqual([
      {
        type: 'workload',
        id: 'job-2',
        location: null,
        error: 'credential aws-old was deleted',
      },
    ]);
  });

  it('under --delete-buckets takes no backup and still leaves the bucket, which only the CLI deletes', async () => {
    const { selfDelete, deps, order, calls, gone } = world();
    await expect(
      selfDelete.request('owner', { clusterId: 'prod-1', deleteBuckets: true }),
    ).resolves.toMatchObject({ finalBackup: 'skipped', backedUpAt: null });
    await gone;
    expect(deps.backup!.run).not.toHaveBeenCalled();
    expect(order).toEqual(['sweep', 'remove']);
    expect(calls.at(-1)!.policy.installation?.keep?.names).toEqual(['prod-1']);
  });
  it('backs up a supplied bucket even under --delete-buckets, since it is kept', async () => {
    const { selfDelete, deps, gone } = world({
      installation: {
        clusterId: 'prod-1',
        cloud: 'aws',
        region: 'us-east-1',
        bucket: { name: 'mine', managed: false },
      },
    });
    await expect(
      selfDelete.request('owner', { clusterId: 'prod-1', deleteBuckets: true }),
    ).resolves.toMatchObject({ finalBackup: 'taken' });
    expect(deps.backup!.run).toHaveBeenCalledOnce();
    await gone;
  });
  it('refuses while node pools or live VM workloads remain, naming what to run first and deleting nothing', async () => {
    const { selfDelete, order } = world({
      liveDependents: async () => ({
        pools: [{ name: 'gpu', liveReferences: 1 }],
        workloads: ['svc-1'],
      }),
    });
    await expect(
      selfDelete.request('owner', {
        clusterId: 'prod-1',
        deleteBuckets: false,
      }),
    ).rejects.toMatchObject({
      name: 'SelfDeleteRefusedError',
      message:
        "Node pool gpu still has Deployments or Services. Workload svc-1 still runs. With the CLI of the hosted API's release, run anycloud deployment delete <id> / anycloud terminate <id>, then anycloud node-pool delete <name>, then anycloud cluster delete prod-1 again.",
    });
    expect(order).toEqual([]);
    expect(selfDelete.status().state).toBe('idle');
  });

  it('stays, failed and answering, when a resource could not be deleted, so nothing leaks unknown', async () => {
    const remove = vi.fn();
    const { selfDelete } = world({
      sweep: (options) =>
        options.dryRun
          ? clean()
          : {
              ...clean(),
              errors: [
                {
                  resourceType: 'securityGroup',
                  resourceId: 'sg-1',
                  error: 'DependencyViolation',
                },
              ],
            },
      removeSelf: remove,
    });
    await selfDelete.request('owner', {
      clusterId: 'prod-1',
      deleteBuckets: false,
    });
    await vi.waitFor(() => expect(selfDelete.status().state).toBe('failed'));
    expect(remove).not.toHaveBeenCalled();
    expect(selfDelete.status()).toMatchObject({
      remaining: [
        {
          type: 'securityGroup',
          id: 'sg-1',
          location: null,
          error: 'DependencyViolation',
        },
      ],
      error: '1 resource(s) could not be deleted',
    });
  });

  it('refuses anyone but the owner, and another cluster’s ID, deleting nothing', async () => {
    const { selfDelete, order } = world();
    await expect(
      selfDelete.request('member', {
        clusterId: 'prod-1',
        deleteBuckets: false,
      }),
    ).rejects.toThrow('not the owner');
    await expect(
      selfDelete.request('owner', {
        clusterId: 'prod-2',
        deleteBuckets: false,
      }),
    ).rejects.toMatchObject({ name: 'SelfDeleteRefusedError' });
    expect(order).toEqual([]);
  });

  it('on GCP and Azure leaves VMs to the Workloads’ own cleanups, and re-checks dependents before removing itself', async () => {
    let calls = 0;
    const { selfDelete, order } = world({
      sweeperFor: null,
      liveDependents: async () => ({
        pools: ++calls > 2 ? [{ name: 'late', liveReferences: 0 }] : [],
        workloads: [],
      }),
    });
    await selfDelete.request('owner', {
      clusterId: 'prod-1',
      deleteBuckets: false,
    });
    await vi.waitFor(() => expect(selfDelete.status().state).toBe('failed'));
    expect(order).toEqual(['backup']);
    expect(selfDelete.status().error).toBe(
      "Node pool late still exists. With the CLI of the hosted API's release, run anycloud node-pool delete <name>, then anycloud cluster delete prod-1 again.",
    );
  });

  it('reports a failed final backup and still deletes; a repeat joins the delete running', async () => {
    const { selfDelete, gone, order } = world({
      backup: { run: async () => Promise.reject(new Error('bucket 503')) },
    });
    const input = { clusterId: 'prod-1', deleteBuckets: false };
    // Two at once: one backup and one run.
    const [first, second] = await Promise.all([
      selfDelete.request('owner', input),
      selfDelete.request('owner', input),
    ]);
    expect(first.finalBackup).toBe('failed');
    expect(second.finalBackup).toBe('failed');
    await gone;
    expect(order.filter((step) => step === 'remove')).toEqual(['remove']);
  });
});
