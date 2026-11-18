import { describe, expect, it, vi } from 'vitest';
import {
  createCloudResourceSweeper,
  type ResourceSweepOptions,
  type ResourceSweepResult,
} from '../../../src/api/services/gateways/resource-sweeper';
import { planInstallationSweep } from '../../../src/api/services/installation-sweep';
import { CloudType } from '../../../src/shared/cloud.js';

function result(
  partial: Partial<ResourceSweepResult> = {},
): ResourceSweepResult {
  return { vmIds: [], otherResources: [], errors: [], ...partial };
}

/** One fake account: a sweeper per location that records what it was asked. */
function account(
  byLocation: Record<
    string,
    (options: ResourceSweepOptions) => ResourceSweepResult
  >,
  options: { locations?: () => Promise<string[]>; storage?: boolean } = {},
) {
  const calls: Array<{ location: string | undefined } & ResourceSweepOptions> =
    [];
  const storage = vi.fn(async (_options: ResourceSweepOptions) =>
    result({ otherResources: [{ type: 'bucket', id: 'prod-1' }] }),
  );
  const sweeperFor = (location?: string) =>
    createCloudResourceSweeper({
      type: CloudType.AWS,
      region: location ?? 'us-east-1',
      rawSweepResources: async (sweep) => {
        calls.push({ location, ...sweep });
        const run = byLocation[location ?? 'default'];
        if (!run) throw new Error(`no ${location}`);
        return run(sweep);
      },
      ...(options.storage !== false && { rawSweepStorage: storage }),
      ...(options.locations && { rawSweepLocations: options.locations }),
    });
  return { calls, storage, sweeperFor };
}

describe('planInstallationSweep', () => {
  it('discovers running workloads in every location, then spares their resources in every pass', async () => {
    const fake = account(
      {
        'us-east-1': (sweep) =>
          result({
            vmIds: ['i-mgmt'],
            ...(sweep.policy.installation!.spareWorkloadIds.length === 0 && {
              spared: [{ type: 'vm', id: 'i-svc', workloadId: 'svc-1' }],
            }),
          }),
        'eu-west-1': () =>
          result({ otherResources: [{ type: 'volume', id: 'vol-1' }] }),
      },
      { locations: async () => ['us-east-1', 'eu-west-1'] },
    );

    const plan = await planInstallationSweep({
      clusterId: 'prod-1',
      sweeperFor: fake.sweeperFor,
      resourceOwnerIds: ['pool-a'],
      deleteWorkloadVms: false,
    });
    expect(plan.spareWorkloadIds).toEqual(['svc-1']);

    const pass = await plan.resources({ dryRun: false });
    expect(pass.vms).toEqual([{ location: 'us-east-1', id: 'i-mgmt' }]);
    expect(pass.resources).toEqual([
      { location: 'eu-west-1', type: 'volume', id: 'vol-1' },
    ]);
    const real = fake.calls.filter((call) => !call.dryRun);
    expect(real.map((call) => call.location).sort()).toEqual([
      'eu-west-1',
      'us-east-1',
    ]);
    for (const call of real) {
      expect(call.policy.installation).toMatchObject({
        clusterId: 'prod-1',
        resourceOwnerIds: ['anycloud-cluster-prod-1', 'pool-a'],
        spareRunningWorkloads: true,
        spareWorkloadIds: ['svc-1'],
      });
    }
    // Buckets wait for their own pass.
    expect(fake.storage).not.toHaveBeenCalled();
    await expect(plan.storage({ dryRun: true })).resolves.toMatchObject({
      resources: [{ location: null, type: 'bucket', id: 'prod-1' }],
    });
    expect(fake.storage.mock.calls[0]![0]).toMatchObject({ dryRun: true });
  });

  it('lifts the exception under --delete-workload-vms', async () => {
    const fake = account({ default: () => result() });
    const plan = await planInstallationSweep({
      clusterId: 'prod-1',
      sweeperFor: fake.sweeperFor,
      deleteWorkloadVms: true,
    });
    await plan.resources({ dryRun: true });
    expect(
      fake.calls.every(
        (call) => call.policy.installation?.spareRunningWorkloads === false,
      ),
    ).toBe(true);
  });

  it('refuses to plan when a location or its VMs cannot be read, since a missed workload would lose its resources', async () => {
    for (const failing of [
      () => {
        throw new Error('endpoint unreachable');
      },
      () =>
        result({
          errors: [
            {
              resourceType: 'vm',
              resourceId: 'list-instances',
              error: 'denied',
            },
          ],
        }),
      // Azure reads the region's group before its VMs.
      () =>
        result({
          errors: [
            {
              resourceType: 'resourceGroup',
              resourceId: 'anycloud-southindia',
              error: 'throttled',
            },
          ],
        }),
    ]) {
      const fake = account(
        {
          'us-east-1': () => result({ vmIds: ['i-1'] }),
          'ap-south-2': failing,
        },
        { locations: async () => ['us-east-1', 'ap-south-2'] },
      );
      await expect(
        planInstallationSweep({
          clusterId: 'prod-1',
          sweeperFor: fake.sweeperFor,
          deleteWorkloadVms: false,
        }),
      ).rejects.toThrow(/ap-south-2/);
      expect(fake.calls.every((call) => call.dryRun)).toBe(true);
    }
  });

  it('reports a location that fails after planning, and keeps the others', async () => {
    let planned = false;
    const fake = account(
      {
        'us-east-1': () => result({ vmIds: ['i-1'] }),
        'ap-south-2': () => {
          if (planned) throw new Error('throttled');
          return result();
        },
      },
      { locations: async () => ['us-east-1', 'ap-south-2'] },
    );
    const plan = await planInstallationSweep({
      clusterId: 'prod-1',
      sweeperFor: fake.sweeperFor,
      deleteWorkloadVms: false,
    });
    planned = true;
    const pass = await plan.resources({ dryRun: false });
    expect(pass.vms).toEqual([{ location: 'us-east-1', id: 'i-1' }]);
    expect(pass.errors).toEqual([
      {
        location: 'ap-south-2',
        resourceType: 'location',
        resourceId: 'ap-south-2',
        error: 'throttled',
      },
    ]);
  });

  it('fails the plan when the locations cannot be listed', async () => {
    const fake = account(
      {},
      {
        locations: async () => {
          throw new Error('DescribeRegions denied');
        },
      },
    );
    await expect(
      planInstallationSweep({
        clusterId: 'prod-1',
        sweeperFor: fake.sweeperFor,
        deleteWorkloadVms: false,
      }),
    ).rejects.toThrow('DescribeRegions denied');
  });
});
