import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';

import { GCP } from '../../../../src/api/services/gateways/gcp';
import { VMReleaseState } from '../../../../src/api/services/gateways/cloud';
import { getZonesForVMType } from '../../../../src/shared/cloud-config';
import { CloudType, type CloudConfig } from '../../../../src/shared/cloud.js';
import { makeNewVMProps, requirePreemptible } from '../../helpers/fixtures';
import { fakeSdkClient } from '../../helpers/sdk-client.js';

vi.mock('@google-cloud/compute', () => ({
  InstancesClient: vi.fn(),
  FirewallsClient: vi.fn(),
  GlobalOperationsClient: vi.fn(),
  ZoneOperationsClient: vi.fn(),
  ImagesClient: vi.fn(),
  DisksClient: vi.fn(),
  MachineTypesClient: vi.fn(),
  protos: { google: { cloud: { compute: { v1: {} } } } },
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn(),
}));

vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const configWithoutZone: CloudConfig = {
  cloudProvider: CloudType.GCP,
  region: 'us-central1',
  vmType: 'retired-gcp-machine-type',
  credentials: {
    projectId: 'test-project',
    privateKey: 'test-private-key',
    clientEmail: 'test@test-project.iam.gserviceaccount.com',
  },
};

type AggregatedScope = [
  string,
  {
    instances?: Array<{
      name?: string;
      zone?: string;
    }>;
  },
];

function aggregatedResult(
  scopes: AggregatedScope[],
): AsyncIterable<AggregatedScope> {
  return (async function* () {
    for (const scope of scopes) yield scope;
  })();
}

function failingAggregatedResult(error: Error): AsyncIterable<AggregatedScope> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw error;
        },
      };
    },
  };
}

function located(zone: string, name = 'legacy-vm'): AggregatedScope[] {
  return [
    [
      `zones/${zone}`,
      {
        instances: [
          {
            name,
            zone: `https://www.googleapis.com/compute/v1/projects/test-project/zones/${zone}`,
          },
        ],
      },
    ],
  ];
}

describe('GCP lifecycle placement independence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructs for a historical placement absent from the current catalog', () => {
    expect(
      getZonesForVMType('us-central1', 'retired-gcp-machine-type'),
    ).toEqual([]);

    expect(
      () =>
        new GCP(
          completeCloudConfig({ ...configWithoutZone, availabilityZone: 'a' }),
        ),
    ).not.toThrow();
  });

  it('constructs storage without a compute availability zone', () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));

    expect(gcp.storage()).toBeDefined();
  });

  it('requires a resolved zone when creating a new VM', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const getFromFamily = vi.fn();
    const imagesClient = { getFromFamily };
    gcp.imagesClient = imagesClient as any;

    await expect(
      gcp.compute().newVM(
        makeNewVMProps({
          vmId: 'new-vm',
          workloadId: 'new-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          version: '1.0.0',
          userId: 'test-user',
          gpuRuntime: null,
        }),
      ),
    ).rejects.toThrow(/availability zone.*new VM/i);
    expect(getFromFamily).not.toHaveBeenCalled();
  });

  it('discovers and deletes a legacy VM in its authoritative zone', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const aggregatedListAsync = vi
      .fn()
      .mockImplementationOnce(() => aggregatedResult(located('us-central1-f')))
      .mockImplementationOnce(() => aggregatedResult([]));
    const deleteInstance = vi.fn().mockResolvedValue([{ status: 'DONE' }]);
    const instancesClient = {
      aggregatedListAsync,
      delete: deleteInstance,
    };
    gcp.instancesClient = instancesClient as any;
    vi.spyOn(gcp as any, 'tagInstanceForDeletion').mockResolvedValue(undefined);

    await expect(gcp.compute().terminateVMs(['legacy-vm'])).resolves.toEqual([
      'legacy-vm',
    ]);

    expect(aggregatedListAsync).toHaveBeenCalledWith({
      project: 'test-project',
      filter: 'name = "legacy-vm"',
      returnPartialSuccess: false,
    });
    expect(deleteInstance).toHaveBeenCalledWith({
      project: 'test-project',
      zone: 'us-central1-f',
      instance: 'legacy-vm',
    });
  });

  it('treats completed project-wide absence as terminated without deleting', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const deleteInstance = vi.fn();
    const instancesClient = {
      aggregatedListAsync: vi.fn(() => aggregatedResult([])),
      delete: deleteInstance,
    };
    gcp.instancesClient = instancesClient as any;
    vi.spyOn(gcp as any, 'tagInstanceForDeletion').mockResolvedValue(undefined);

    await expect(gcp.compute().terminateVMs(['legacy-vm'])).resolves.toEqual([
      'legacy-vm',
    ]);
    expect(deleteInstance).not.toHaveBeenCalled();
  });

  it('keeps a legacy attempt active when project-wide lookup is ambiguous', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const deleteInstance = vi.fn();
    const instancesClient = {
      aggregatedListAsync: vi.fn(() =>
        aggregatedResult([
          ...located('us-central1-b'),
          ...located('us-central1-f'),
        ]),
      ),
      delete: deleteInstance,
    };
    gcp.instancesClient = instancesClient as any;

    await expect(gcp.compute().terminateVMs(['legacy-vm'])).resolves.toEqual(
      [],
    );
    expect(deleteInstance).not.toHaveBeenCalled();
  });

  it('keeps a legacy attempt active when project-wide lookup fails', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const deleteInstance = vi.fn();
    const instancesClient = {
      aggregatedListAsync: vi.fn(() =>
        failingAggregatedResult(new Error('aggregated lookup unavailable')),
      ),
      delete: deleteInstance,
    };
    gcp.instancesClient = instancesClient as any;

    await expect(gcp.compute().terminateVMs(['legacy-vm'])).resolves.toEqual(
      [],
    );
    expect(deleteInstance).not.toHaveBeenCalled();
  });

  it('reports legacy polling as alive, terminated, or unknown authoritatively', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const aggregatedListAsync = vi
      .fn()
      .mockImplementationOnce(() => aggregatedResult(located('us-central1-f')))
      .mockImplementationOnce(() => aggregatedResult([]))
      .mockImplementationOnce(() =>
        aggregatedResult([
          ...located('us-central1-b'),
          ...located('us-central1-f'),
        ]),
      );
    const instancesClient = { aggregatedListAsync };
    gcp.instancesClient = instancesClient as any;

    await expect(
      gcp.compute().observeVMReleaseOnce('legacy-vm'),
    ).resolves.toEqual({ state: VMReleaseState.Present });
    await expect(
      gcp.compute().observeVMReleaseOnce('legacy-vm'),
    ).resolves.toEqual({ state: VMReleaseState.Candidate });
    await expect(
      gcp.compute().observeVMReleaseOnce('legacy-vm'),
    ).resolves.toMatchObject({
      state: VMReleaseState.Unknown,
      error: expect.stringContaining('multiple zones'),
    });
  });

  it('discovers the exact legacy zone before checking preemption', async () => {
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    const aggregatedListAsync = vi.fn(() =>
      aggregatedResult(located('us-central1-f')),
    );
    const get = vi.fn().mockResolvedValue([{ status: 'TERMINATED' }]);
    gcp.instancesClient = fakeSdkClient({ aggregatedListAsync, get });

    const preempted = await requirePreemptible(
      gcp.compute(),
    ).verifyVMPreemption('legacy-vm');
    expect(preempted).toBe(true);
    expect(aggregatedListAsync).toHaveBeenCalledExactlyOnceWith({
      project: 'test-project',
      filter: 'name = "legacy-vm"',
      returnPartialSuccess: false,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith({
      project: 'test-project',
      zone: 'us-central1-f',
      instance: 'legacy-vm',
    });
  });

  it('restarts the legacy VM only in its discovered zone within the original budget', async () => {
    vi.useFakeTimers();
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    let running = false;
    const aggregatedListAsync = vi.fn(() =>
      aggregatedResult(located('us-central1-f')),
    );
    const get = vi.fn(async () => [
      {
        name: 'legacy-vm',
        id: 'original-numeric-id',
        status: running ? 'RUNNING' : 'TERMINATED',
        networkInterfaces: [{ accessConfigs: [{ natIP: '192.0.2.10' }] }],
      },
    ]);
    const start = vi.fn(async () => {
      running = true;
      return [{ status: 'DONE' }];
    });
    gcp.instancesClient = fakeSdkClient({ aggregatedListAsync, get, start });

    const pending = requirePreemptible(gcp.compute()).startVM('legacy-vm');
    await vi.runAllTimersAsync();

    expect(await pending).toBe('192.0.2.10');
    expect(aggregatedListAsync).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledExactlyOnceWith(
      {
        project: 'test-project',
        zone: 'us-central1-f',
        instance: 'legacy-vm',
        requestId: expect.any(String),
      },
      { retry: null },
    );
    expect(get).toHaveBeenCalledWith(
      {
        project: 'test-project',
        zone: 'us-central1-f',
        instance: 'legacy-vm',
      },
      expect.objectContaining({ timeout: expect.any(Number), retry: null }),
    );
  });

  it.each(['absent', 'ambiguous', 'unavailable'] as const)(
    'does not authorize legacy preemption or restart from %s zone discovery',
    async (observation) => {
      const gcp = new GCP(completeCloudConfig(configWithoutZone));
      const aggregatedListAsync = vi.fn(() => {
        if (observation === 'unavailable')
          return failingAggregatedResult(new Error('provider unavailable'));
        return aggregatedResult(
          observation === 'absent'
            ? []
            : [...located('us-central1-b'), ...located('us-central1-f')],
        );
      });
      const get = vi.fn();
      const start = vi.fn();
      gcp.instancesClient = fakeSdkClient({ aggregatedListAsync, get, start });

      const compute = requirePreemptible(gcp.compute());
      await expect(compute.verifyVMPreemption('legacy-vm')).resolves.toBe(
        false,
      );
      await expect(compute.startVM('legacy-vm')).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it('cannot start a legacy VM after its zone discovery exceeds the restart deadline', async () => {
    vi.useFakeTimers();
    const gcp = new GCP(completeCloudConfig(configWithoutZone));
    let finish!: (result: IteratorResult<AggregatedScope>) => void;
    const aggregatedListAsync = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<AggregatedScope>>((resolve) => {
            finish = resolve;
          }),
      }),
    }));
    const get = vi.fn();
    const start = vi.fn();
    gcp.instancesClient = fakeSdkClient({ aggregatedListAsync, get, start });

    const pending = requirePreemptible(gcp.compute()).startVM('legacy-vm');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(pending).resolves.toBeNull();
    finish({ done: false, value: located('us-central1-f')[0]! });
    await vi.runAllTimersAsync();
    expect(get).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
