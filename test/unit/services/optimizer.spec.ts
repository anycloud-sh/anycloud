import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from 'vitest';
import { resolveProvisioningTarget } from '../../../src/api/services/optimizer';
import {
  pickTarget,
  type TargetCandidate,
} from '../../../src/api/services/launch-targets';
import {
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
  GpuRuntime,
} from '../../../src/shared/cloud.js';
import { candidateRegionKey } from '../../../src/api/services/gateways/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { ImageRuntime } from '../../../src/shared/image.js';
import { type CloudConfig } from '../../../src/shared/cloud.js';
import { type ProvisioningFailure } from '../../../src/api/services/provisioning-failure.js';
import { resetTestStore } from '../utils';
import {
  completeCloudConfig,
  DEFAULT_DISK_TIER,
  getRegionsForVMType,
  getZoneSuffixes,
  getZonesForVMType,
  resolveVMTypes,
  gpuRuntimeForVMType,
} from '../../../src/shared/cloud-config';
import {
  makeStoredWorkload,
  makeMockCloudCompute,
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
} from '../helpers/fixtures';
import {
  CandidateRegionAvailability,
  createCandidateRegionFilter,
} from '../../../src/api/services/gateways/cloud.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import {
  GCP,
  resetGcpCandidatePreflightCache,
} from '../../../src/api/services/gateways/gcp';
import type { MachineTypesClient } from '@google-cloud/compute';
import { CandidatePreflightCache } from '../../../src/api/services/candidate-preflight-cache';
import * as catalogModule from '../../../src/shared/catalog/index';
import config from '../../../src/api/config';
import { randomBytes } from 'crypto';
import { getWorkloadQueryStore as queries } from '../../../src/api/services/persistence.js';

const candidates: TargetCandidate[] = [
  { vmType: 'g4dn.xlarge', region: 'us-east-1' },
  { vmType: 'g4dn.xlarge', region: 'us-west-2' },
  { vmType: 'g4dn.xlarge', region: 'eu-west-1' },
];

function failedTarget(
  target: TargetCandidate,
  overrides: Partial<ProvisioningFailure> = {},
): ProvisioningFailure {
  return {
    credentialId: 'credential-a',
    vmType: target.vmType,
    region: target.region,
    availabilityZone: target.availabilityZone ?? null,
    diagnosis: null,
    disposition: null,
    spot: false,
    regionDenied: null,
    ...overrides,
  };
}

describe('pickTarget', () => {
  it('returns the first catalog candidate before this workload has failed', () => {
    expect(pickTarget(candidates)).toEqual(candidates[0]);
  });

  it('moves to the least-tried target using only the supplied history', () => {
    expect(pickTarget(candidates, [failedTarget(candidates[0]!)])).toEqual(
      candidates[1],
    );
    expect(
      pickTarget(
        candidates,
        candidates.slice(0, 2).map((target) => failedTarget(target)),
      ),
    ).toEqual(candidates[2]);
  });

  it('starts a new balanced pass after every candidate has failed', () => {
    expect(
      pickTarget(
        candidates,
        candidates.map((target) => failedTarget(target)),
      ),
    ).toEqual(candidates[0]);
    expect(
      pickTarget(
        candidates,
        [...candidates, candidates[0]!].map((target) => failedTarget(target)),
      ),
    ).toEqual(candidates[1]);
  });

  it('breaks a full-pass tie toward the least recently failed target', () => {
    // The Job ran on candidates[2] until preemption; the other candidates then
    // failed in turn. Catalog order would return to candidates[0], which just
    // failed, instead of the region that last had capacity.
    expect(
      pickTarget(
        candidates,
        [candidates[2]!, candidates[0]!, candidates[1]!].map((target) =>
          failedTarget(target),
        ),
      ),
    ).toEqual(candidates[2]);
  });

  it('does not let one workload history affect another selection', () => {
    const firstWorkloadFailures = [candidates[0]!, candidates[1]!].map(
      (target) => failedTarget(target),
    );
    expect(pickTarget(candidates, firstWorkloadFailures)).toEqual(
      candidates[2],
    );
    expect(pickTarget(candidates, [])).toEqual(candidates[0]);
  });

  it('prefers a region with verified live capacity over a less-tried one', () => {
    // Least-tried is the right default, but it outranks known-available once a
    // region has been tried even once — so a starved workload walks regions
    // the provider has already reported empty while ignoring the one with
    // capacity. Verified class wins first when the provider offers a live
    // signal.
    const verified = new Set([candidateRegionKey(candidates[2]!)]);
    const failures = [failedTarget(candidates[2]!)];

    expect(pickTarget(candidates, failures)).toEqual(candidates[0]);
    expect(
      pickTarget(candidates, failures, undefined, false, verified),
    ).toEqual(candidates[2]);
  });

  it('ignores an empty verified set', () => {
    // A cloud without a live capacity signal, or a snapshot that verified
    // nothing, must leave selection byte-identical to today.
    expect(pickTarget(candidates, [], undefined, false, new Set())).toEqual(
      candidates[0],
    );
    expect(
      pickTarget(
        candidates,
        [failedTarget(candidates[0]!)],
        undefined,
        false,
        new Set(),
      ),
    ).toEqual(candidates[1]);
  });

  it('still prefers the least-tried target within the verified class', () => {
    const verified = new Set([
      candidateRegionKey(candidates[1]!),
      candidateRegionKey(candidates[2]!),
    ]);
    expect(
      pickTarget(
        candidates,
        [failedTarget(candidates[1]!)],
        undefined,
        false,
        verified,
      ),
    ).toEqual(candidates[2]);
  });

  it('keeps catalog order as the tie-break within the verified class', () => {
    const verified = new Set([
      candidateRegionKey(candidates[1]!),
      candidateRegionKey(candidates[2]!),
    ]);
    expect(pickTarget(candidates, [], undefined, false, verified)).toEqual(
      candidates[1],
    );
  });

  it('does not rotate a failure classified to retry the same target', () => {
    expect(
      pickTarget(candidates, [
        failedTarget(candidates[0]!, {
          disposition: FailureDisposition.RetrySameTarget,
        }),
      ]),
    ).toEqual(candidates[0]);
  });

  it('applies Azure spot-pool exhaustion to every SKU in the region', () => {
    const azureCandidates = [
      { vmType: 'Standard_NC4as_T4_v3', region: 'eastus' },
      { vmType: 'Standard_ND96isr_H100_v5', region: 'eastus' },
      { vmType: 'Standard_NC4as_T4_v3', region: 'westus2' },
    ];
    const failure = failedTarget(azureCandidates[0]!, {
      diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
      disposition: FailureDisposition.FailoverTarget,
      spot: true,
    });

    expect(
      pickTarget(azureCandidates, [failure], CloudType.Azure, true),
    ).toEqual(azureCandidates[2]);
  });

  it('applies AWS spot-pool exhaustion only within its quota family', () => {
    const awsCandidates = [
      { vmType: 'g4dn.xlarge', region: 'us-east-1' },
      { vmType: 'g5.xlarge', region: 'us-east-1' },
      { vmType: 'p5.48xlarge', region: 'us-east-1' },
    ];
    const failure = failedTarget(awsCandidates[0]!, {
      diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
      disposition: FailureDisposition.FailoverTarget,
      spot: true,
    });

    expect(pickTarget(awsCandidates, [failure], CloudType.AWS, true)).toEqual(
      awsCandidates[2],
    );
  });
});

describe('resolveProvisioningTarget — published GCP zone topology', () => {
  beforeEach(async () => {
    await resetTestStore();
    resetGcpCandidatePreflightCache();
  });
  afterEach(() => vi.restoreAllMocks());

  function requireG4Zones(region: string, minimum = 1): string[] {
    const zones = getZonesForVMType(region, 'g4-standard-48');
    if (zones.length < minimum) {
      throw new Error(
        `Published GCP catalog must offer g4-standard-48 in at least ${minimum} zones in ${region}; found ${zones.length}`,
      );
    }
    return zones;
  }

  function requireIncompatibleG4Zone(region: string): string {
    const compatibleZones = requireG4Zones(region);
    const zone = getZoneSuffixes(region).find(
      (candidate) => !compatibleZones.includes(candidate),
    );
    if (!zone) {
      throw new Error(
        `Published GCP catalog must offer a zone in ${region} without g4-standard-48 for incompatible-placement coverage`,
      );
    }
    return zone;
  }

  function requireG4RegionFailover() {
    const [region, nextRegion] = getRegionsForVMType(
      'g4-standard-48',
      CloudType.GCP,
      false,
    );
    if (!region || !nextRegion) {
      throw new Error(
        'Published GCP catalog must offer g4-standard-48 in at least two regions for region-failover coverage',
      );
    }
    return {
      region,
      zones: requireG4Zones(region, 2),
      nextRegion,
      nextZone: requireG4Zones(nextRegion)[0]!,
    };
  }

  const workload = (
    id: string,
    region: string | null,
    availabilityZone: string | null = null,
  ) =>
    makeStoredWorkload({
      id,
      cloudProvider: CloudType.GCP,
      vmType: 'g4-standard-48',
      gpuType: null,
      region,
      availabilityZone,
      state: WorkloadState.Queued,
    });

  const cloudConfig = (
    region: string | undefined,
    availabilityZone?: string,
  ): CloudConfig => ({
    cloudProvider: CloudType.GCP,
    vmType: 'g4-standard-48',
    region,
    availabilityZone,
    spot: false,
    credentials: {
      projectId: 'test-project',
      clientEmail: 'test@example.com',
      privateKey: 'test-key',
    },
  });

  it('selects the first exact compatible zone for a region-pinned G4 target', async () => {
    const [availabilityZone] = requireG4Zones('us-central1');
    const result = await resolveProvisioningTarget(
      workload('gcp-g4-zone-placement', 'us-central1'),
      cloudConfig('us-central1'),
      queries(),
      () => makeMockCloudCompute(),
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config).toMatchObject({
      vmType: 'g4-standard-48',
      region: 'us-central1',
      availabilityZone,
    });
  });

  it('keeps a nested VM Job within its region allow-list, and says when nesting left nothing there', async () => {
    const regions = getRegionsForVMType('n2-standard-4', CloudType.GCP)
      .filter((region) =>
        getRegionsForVMType('e2-standard-4', CloudType.GCP).includes(region),
      )
      .slice(0, 2);
    expect(regions).toHaveLength(2);
    const nestedJob = (vmType: string | string[], id: string) =>
      resolveProvisioningTarget(
        makeStoredWorkload({
          id,
          cloudProvider: CloudType.GCP,
          vmType,
          gpuType: null,
          region: null,
          regions,
          availabilityZone: null,
          state: WorkloadState.Queued,
          requireNestedVirtualization: true,
        }),
        {
          ...cloudConfig(undefined),
          vmType,
          regions,
          nestedVirtualization: true,
        },
        queries(),
        () => makeMockCloudCompute(),
      );
    const result = await nestedJob(
      ['e2-standard-4', 'n2-standard-4'],
      'gcp-nested-regions',
    );
    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe('n2-standard-4');
    expect(regions).toContain(result.config.region);
    // E2 can't nest anywhere: the message names nesting, not the regions.
    await expect(
      nestedJob('e2-standard-4', 'gcp-nested-regions-none'),
    ).resolves.toMatchObject({
      state: WorkloadState.Invalid,
      message: expect.stringContaining('with nested virtualization'),
    });
  });

  it('launches a nested VM Job only on a type the catalog reports nesting for', async () => {
    const region = getRegionsForVMType('n2-standard-4', CloudType.GCP).find(
      (candidate) =>
        getRegionsForVMType('e2-standard-4', CloudType.GCP).includes(candidate),
    );
    expect(region).toBeTruthy();
    if (!region) return;
    const config: CloudConfig = {
      ...cloudConfig(region),
      vmType: ['e2-standard-4', 'n2-standard-4'],
      nestedVirtualization: true,
    };
    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-nested-job',
        cloudProvider: CloudType.GCP,
        vmType: ['e2-standard-4', 'n2-standard-4'],
        gpuType: null,
        region,
        availabilityZone: null,
        state: WorkloadState.Queued,
        requireNestedVirtualization: true,
      }),
      config,
      queries(),
      () => makeMockCloudCompute(),
    );

    // E2 is first in the list but can't nest.
    expect(result).toMatchObject({
      state: WorkloadState.Provisioning,
      config: expect.objectContaining({ vmType: 'n2-standard-4', region }),
    });
    // The same list without the flag takes E2 first.
    const plain = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-plain-job',
        cloudProvider: CloudType.GCP,
        vmType: ['e2-standard-4', 'n2-standard-4'],
        gpuType: null,
        region,
        availabilityZone: null,
        state: WorkloadState.Queued,
      }),
      { ...config, nestedVirtualization: undefined },
      queries(),
      () => makeMockCloudCompute(),
    );
    expect(plain).toMatchObject({
      config: expect.objectContaining({ vmType: 'e2-standard-4' }),
    });
  });

  it('skips a disk-incompatible GCP target and provisions its fallback', async () => {
    const incompatibleVm = 'c4-standard-16';
    const fallbackVm = 'e2-standard-4';
    const fallbackRegions = new Set(
      getRegionsForVMType(fallbackVm, CloudType.GCP),
    );
    const region = getRegionsForVMType(incompatibleVm, CloudType.GCP).find(
      (candidate) => fallbackRegions.has(candidate),
    );
    expect(region).toBeTruthy();
    if (!region) return;

    const config: CloudConfig = {
      ...cloudConfig(region),
      vmType: incompatibleVm,
      diskTier: DiskTier.High,
      diskSizeGb: 15,
    };
    const get = vi.fn().mockResolvedValue([{ name: fallbackVm }]);
    const makeGateway = vi.fn(
      (vmType: string, targetRegion: string, availabilityZone?: string) => {
        const gcp = new GCP(
          completeCloudConfig({
            ...config,
            vmType,
            region: targetRegion,
            availabilityZone,
          }),
        );
        const machineTypesClient = { get };
        gcp.machineTypesClient =
          machineTypesClient as unknown as MachineTypesClient;
        return gcp.compute();
      },
    );

    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-disk-compatible-fallback',
        cloudProvider: CloudType.GCP,
        vmType: [incompatibleVm, fallbackVm],
        gpuType: null,
        region,
        availabilityZone: null,
        state: WorkloadState.Queued,
        diskTier: DiskTier.High,
        diskSizeGb: 15,
      }),
      config,
      queries(),
      makeGateway,
    );

    expect(result).toMatchObject({
      state: WorkloadState.Provisioning,
      config: expect.objectContaining({ vmType: fallbackVm, region }),
    });
    expect(get).toHaveBeenCalled();
    expect(get).not.toHaveBeenCalledWith(
      expect.objectContaining({ machineType: incompatibleVm }),
    );
  });

  it('returns the exact GCP disk reason when every expanded target is incompatible', async () => {
    const vmType = 'c4-standard-16';
    const region = getRegionsForVMType(vmType, CloudType.GCP)[0];
    expect(region).toBeTruthy();
    if (!region) return;

    const config: CloudConfig = {
      ...cloudConfig(region),
      vmType,
      diskTier: DiskTier.High,
      diskSizeGb: 15,
    };
    const get = vi.fn();

    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-disk-incompatible-expanded-targets',
        cloudProvider: CloudType.GCP,
        vmType: [vmType],
        gpuType: null,
        region,
        availabilityZone: null,
        state: WorkloadState.Queued,
        diskTier: DiskTier.High,
        diskSizeGb: 15,
      }),
      config,
      queries(),
      (targetVmType, targetRegion, availabilityZone) => {
        const gcp = new GCP(
          completeCloudConfig({
            ...config,
            vmType: targetVmType,
            region: targetRegion,
            availabilityZone,
          }),
        );
        const machineTypesClient = { get };
        gcp.machineTypesClient =
          machineTypesClient as unknown as MachineTypesClient;
        return gcp.compute();
      },
    );

    expect(result).toEqual({
      state: WorkloadState.Invalid,
      message:
        'GCP --disk-tier high on Hyperdisk Balanced requires --disk-size of at least 16 GB for VM type "c4-standard-16" (got 15 GB).',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves a fully pinned disk-incompatible GCP target on the provisioning path', async () => {
    const vmType = 'c4-standard-16';
    const region = getRegionsForVMType(vmType, CloudType.GCP)[0];
    expect(region).toBeTruthy();
    if (!region) return;
    const availabilityZone = getZonesForVMType(region, vmType)[0];
    expect(availabilityZone).toBeTruthy();
    if (!availabilityZone) return;
    const config: CloudConfig = {
      ...cloudConfig(region, availabilityZone),
      vmType,
      diskTier: DiskTier.High,
      diskSizeGb: 15,
    };
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-disk-incompatible-pinned-target',
        cloudProvider: CloudType.GCP,
        vmType,
        gpuType: null,
        region,
        availabilityZone,
        state: WorkloadState.Queued,
        diskTier: DiskTier.High,
        diskSizeGb: 15,
      }),
      config,
      queries(),
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('tries each remaining compatible zone while the region stays pinned', async () => {
    const zones = requireG4Zones('us-central1', 2);
    const store = queries();
    const failures = vi.spyOn(store, 'getProvisioningFailures');
    for (let index = 1; index < zones.length; index++) {
      failures.mockResolvedValue(
        zones.slice(0, index).map((availabilityZone) =>
          failedTarget(
            {
              vmType: 'g4-standard-48',
              region: 'us-central1',
              availabilityZone,
            },
            {
              diagnosis: CloudFailureDiagnosis.CapacityExhausted,
              disposition: FailureDisposition.FailoverTarget,
            },
          ),
        ),
      );

      const result = await resolveProvisioningTarget(
        workload('gcp-g4-zone-failover-' + index, 'us-central1'),
        cloudConfig('us-central1'),
        store,
        () => makeMockCloudCompute(),
      );

      expect(result).toMatchObject({
        state: WorkloadState.Provisioning,
        config: { region: 'us-central1', availabilityZone: zones[index] },
      });
    }
  });

  it('moves regions after a single regional quota failure', async () => {
    const { region, zones, nextRegion, nextZone } = requireG4RegionFailover();
    const store = queries();
    vi.spyOn(store, 'getProvisioningFailures').mockResolvedValue([
      failedTarget(
        {
          vmType: 'g4-standard-48',
          region,
          availabilityZone: zones[0],
        },
        {
          diagnosis: CloudFailureDiagnosis.QuotaExhaustedRegion,
          disposition: FailureDisposition.FailoverTarget,
        },
      ),
    ]);

    const result = await resolveProvisioningTarget(
      workload('gcp-g4-regional-quota', null),
      cloudConfig(undefined),
      store,
      () => makeMockCloudCompute(),
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config).toMatchObject({
      region: nextRegion,
      availabilityZone: nextZone,
    });
  });

  it('moves regions after every compatible zone in the first region has failed', async () => {
    const { region, zones, nextRegion, nextZone } = requireG4RegionFailover();
    const store = queries();
    vi.spyOn(store, 'getProvisioningFailures').mockResolvedValue(
      zones.map((availabilityZone) =>
        failedTarget(
          {
            vmType: 'g4-standard-48',
            region,
            availabilityZone,
          },
          {
            diagnosis: CloudFailureDiagnosis.CapacityExhausted,
            disposition: FailureDisposition.FailoverTarget,
          },
        ),
      ),
    );

    const result = await resolveProvisioningTarget(
      workload('gcp-g4-all-zones-failed', null),
      cloudConfig(undefined),
      store,
      () => makeMockCloudCompute(),
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config).toMatchObject({
      region: nextRegion,
      availabilityZone: nextZone,
    });
  });

  it('keeps legacy failures without zone metadata region-scoped', async () => {
    const { region, nextRegion, nextZone } = requireG4RegionFailover();
    const store = queries();
    vi.spyOn(store, 'getProvisioningFailures').mockResolvedValue([
      failedTarget(
        { vmType: 'g4-standard-48', region },
        {
          diagnosis: CloudFailureDiagnosis.CapacityExhausted,
          disposition: FailureDisposition.FailoverTarget,
        },
      ),
    ]);

    const result = await resolveProvisioningTarget(
      workload('gcp-g4-legacy-failure', null),
      cloudConfig(undefined),
      store,
      () => makeMockCloudCompute(),
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config).toMatchObject({
      region: nextRegion,
      availabilityZone: nextZone,
    });
  });

  it('preserves a compatible explicit zone and rejects an incompatible one', async () => {
    const zones = requireG4Zones('us-central1', 2);
    const compatibleZone = zones[1]!;
    const incompatibleZone = requireIncompatibleG4Zone('us-central1');
    const compatible = await resolveProvisioningTarget(
      workload('gcp-g4-pinned-compatible', 'us-central1', compatibleZone),
      cloudConfig('us-central1', compatibleZone),
      queries(),
      () => makeMockCloudCompute(),
    );
    expect(compatible.state).toBe(WorkloadState.Provisioning);
    if (compatible.state === WorkloadState.Provisioning) {
      expect(compatible.config.availabilityZone).toBe(compatibleZone);
    }

    const refreshCatalog = vi.fn().mockResolvedValue(undefined);
    const incompatible = await resolveProvisioningTarget(
      workload('gcp-g4-pinned-incompatible', 'us-central1', incompatibleZone),
      cloudConfig('us-central1', incompatibleZone),
      queries(),
      () => makeMockCloudCompute(),
      null,
      { refreshCatalog },
    );
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(incompatible).toMatchObject({
      state: WorkloadState.Invalid,
      message: `GCP zone "us-central1-${incompatibleZone}" does not offer VM type "g4-standard-48". Compatible zones after catalog refresh: ${zones.join(', ')}`,
    });
  });

  it('refreshes an explicit placement when the cached catalog is missing the entire VM type', async () => {
    const [availabilityZone] = requireG4Zones('us-central1');
    const catalog = catalogModule.readCatalog(CloudType.GCP);
    if (!catalog) throw new Error('published GCP catalog is unavailable');
    const typeKey = 'g4-standard-48';
    const publishedPlacements = catalog.regionsPerType[typeKey];
    expect(publishedPlacements).toContain(`us-central1-${availabilityZone}`);
    catalog.regionsPerType[typeKey] = [];
    const refreshCatalog = vi.fn(async () => {
      catalog.regionsPerType[typeKey] = publishedPlacements;
    });

    try {
      const result = await resolveProvisioningTarget(
        workload('gcp-g4-stale-missing-type', 'us-central1', availabilityZone),
        cloudConfig('us-central1', availabilityZone),
        queries(),
        () => makeMockCloudCompute(),
        null,
        { refreshCatalog },
      );

      expect(refreshCatalog).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        state: WorkloadState.Provisioning,
        config: expect.objectContaining({ availabilityZone }),
      });
    } finally {
      catalog.regionsPerType[typeKey] = publishedPlacements;
    }
  });

  it('runs image-runtime admission after a stale explicit placement refresh', async () => {
    const [availabilityZone] = requireG4Zones('us-central1', 2);
    const publishedPlacement = `us-central1-${availabilityZone}`;
    const catalog = catalogModule.readCatalog(CloudType.GCP);
    if (!catalog) throw new Error('published GCP catalog is unavailable');
    const typeKey = 'g4-standard-48';
    const publishedPlacements = catalog.regionsPerType[typeKey];
    expect(publishedPlacements).toContain(publishedPlacement);
    catalog.regionsPerType[typeKey] = publishedPlacements.filter(
      (placement) => placement !== publishedPlacement,
    );
    const refreshCatalog = vi.fn(async () => {
      catalog.regionsPerType[typeKey] = publishedPlacements;
    });

    try {
      const result = await resolveProvisioningTarget(
        makeStoredWorkload({
          id: 'gcp-g4-stale-runtime-mismatch',
          cloudProvider: CloudType.GCP,
          vmType: 'g4-standard-48',
          gpuType: null,
          region: 'us-central1',
          availabilityZone,
          state: WorkloadState.Queued,
          imageRuntime: ImageRuntime.Rocm,
        }),
        cloudConfig('us-central1', availabilityZone),
        queries(),
        () => makeMockCloudCompute(),
        null,
        { refreshCatalog },
      );

      expect(refreshCatalog).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        state: WorkloadState.Invalid,
        message: expect.stringContaining('ROCM'),
      });
    } finally {
      catalog.regionsPerType[typeKey] = publishedPlacements;
    }
  });

  it('validates an explicit zone after GPU-alias expansion against the published catalog', async () => {
    const zones = requireG4Zones('us-central1');
    const incompatibleZone = requireIncompatibleG4Zone('us-central1');
    const refreshCatalog = vi.fn().mockResolvedValue(undefined);
    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-g4-alias-pinned-incompatible',
        cloudProvider: CloudType.GCP,
        vmType: 'g4-standard-48',
        gpuType: 'RTXPRO6000:1',
        region: 'us-central1',
        availabilityZone: incompatibleZone,
        state: WorkloadState.Queued,
      }),
      cloudConfig('us-central1', incompatibleZone),
      queries(),
      () => makeMockCloudCompute(),
      null,
      { refreshCatalog },
    );

    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      state: WorkloadState.Invalid,
      message: `GCP zone "us-central1-${incompatibleZone}" does not offer VM type "g4-standard-48". Compatible zones after catalog refresh: ${zones.join(', ')}`,
    });
  });

  it('queues instead of launching an automatic target into an arbitrary zone', async () => {
    const makeGateway = vi.fn(() => makeMockCloudCompute());
    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        id: 'gcp-future-type-no-zones',
        cloudProvider: CloudType.GCP,
        vmType: 'future-gcp-type-not-yet-in-catalog',
        gpuType: null,
        region: null,
        availabilityZone: null,
        state: WorkloadState.Queued,
      }),
      {
        ...cloudConfig(undefined),
        vmType: 'future-gcp-type-not-yet-in-catalog',
      },
      queries(),
      makeGateway,
    );

    expect(result).toMatchObject({
      state: WorkloadState.Queued,
      message: expect.stringContaining('waiting for catalog refresh'),
    });
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('queues an explicit incompatible zone when its one validation refresh fails', async () => {
    const incompatibleZone = requireIncompatibleG4Zone('us-central1');
    const result = await resolveProvisioningTarget(
      workload('gcp-g4-refresh-failed', 'us-central1', incompatibleZone),
      cloudConfig('us-central1', incompatibleZone),
      queries(),
      () => makeMockCloudCompute(),
      null,
      {
        refreshCatalog: vi
          .fn()
          .mockRejectedValue(new Error('catalog endpoint unavailable')),
      },
    );

    expect(result).toMatchObject({
      state: WorkloadState.Queued,
      message: expect.stringContaining('catalog endpoint unavailable'),
    });
  });

  it('propagates explicit-placement refresh cancellation', async () => {
    const incompatibleZone = requireIncompatibleG4Zone('us-central1');
    const cancellation = new DOMException('resolution stopped', 'AbortError');

    await expect(
      resolveProvisioningTarget(
        workload('gcp-g4-refresh-cancelled', 'us-central1', incompatibleZone),
        cloudConfig('us-central1', incompatibleZone),
        queries(),
        () => makeMockCloudCompute(),
        null,
        {
          refreshCatalog: vi.fn().mockRejectedValue(cancellation),
        },
      ),
    ).rejects.toBe(cancellation);
  });
});

// Regression for the e2e bucket-sync / target-array failure: the capability-probe
// gateway must be built from an already-resolved candidate, NOT the raw
// cloudConfig. cloudConfig.vmType is buildCloudConfig's collapsed fallback-list
// head (workload.vmType[0]); when it's a deliberately-fake entry (or a
// cross-cloud type in a vmType list) AND no region is pinned, constructing
// the gateway from it runs completeCloudConfig → getRegionByVMType → throws,
// which the old code never hit (it never built a compute gateway mid-resolution).
describe('resolveProvisioningTarget — capability-probe gateway', () => {
  // A recognized Neuron family no published catalog lists (AWS has no such size).
  const CATALOG_STALE_NEURON_VM = 'trn1n.2xlarge';

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });

  it('probes with a resolved candidate so an unresolvable collapsed vmType[0] never throws', async () => {
    const store = queries();
    // Fallback list fronted by a fake type; region omitted (the failing e2e
    // scenario). buildCloudConfig collapses cloudConfig.vmType to the fake head.
    const workload = makeStoredWorkload({
      id: 'probe-regression',
      cloudProvider: CloudType.AWS,
      vmType: ['totally_fake_nonexistent_vm', 'g4dn.xlarge'],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: 'totally_fake_nonexistent_vm',
      region: undefined,
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };

    const probeCalls: Array<[string, string]> = [];
    const makeGateway = (vmType: string, region: string) => {
      probeCalls.push([vmType, region]);
      // Mirror createComputeProvider: completeCloudConfig runs here and used to
      // throw when the probe carried the unresolved fake vmType + no region.
      completeCloudConfig({ ...cloudConfig, vmType, region });
      return makeMockCloudCompute(); // no CandidateRegionFilter → no AWS calls
    };

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    expect(probeCalls).toHaveLength(1);
    const [vmType, region] = probeCalls[0]!;
    // The probe must be a real, region-resolvable candidate — not the fake head.
    expect(vmType).not.toBe('totally_fake_nonexistent_vm');
    expect(getRegionsForVMType(vmType, CloudType.AWS).length).toBeGreaterThan(
      0,
    );
    expect(region).toBeTruthy();
  });

  it('classifies a pinned scalar VM type the catalog knows nowhere as Invalid (no gateway built)', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'pinned-fake-invalid',
      cloudProvider: CloudType.AWS,
      vmType: 'totally_fake_nonexistent_vm',
      gpuType: null,
      region: 'us-east-1',
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: 'totally_fake_nonexistent_vm',
      region: 'us-east-1',
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      () => {
        throw new Error(
          'makeGateway must not be called for an invalid pinned type',
        );
      },
    );

    expect(result.state).toBe(WorkloadState.Invalid);
  });

  it('uses the unsupported-runtime message for a catalog-stale recognized family', async () => {
    const store = queries();
    expect(getRegionsForVMType(CATALOG_STALE_NEURON_VM, CloudType.AWS)).toEqual(
      [],
    );
    expect(gpuRuntimeForVMType(CloudType.AWS, CATALOG_STALE_NEURON_VM)).toBe(
      GpuRuntime.Neuron,
    );
    const workload = makeStoredWorkload({
      id: 'pinned-neuron-invalid',
      cloudProvider: CloudType.AWS,
      vmType: CATALOG_STALE_NEURON_VM,
      gpuType: null,
      region: 'us-east-2',
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: CATALOG_STALE_NEURON_VM,
      region: 'us-east-2',
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toMatch(/Neuron.*recognized.*not supported/i);
    expect(result.message).not.toMatch(/check the name/i);
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('returns the runtime rejection for a region-unpinned catalog-stale family instead of waiting for refresh', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'region-unpinned-neuron-invalid',
      cloudProvider: CloudType.AWS,
      vmType: CATALOG_STALE_NEURON_VM,
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: CATALOG_STALE_NEURON_VM,
      region: undefined,
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toMatch(/Neuron.*recognized.*not supported/i);
    expect(result.message).not.toMatch(/catalog refresh/i);
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('returns the runtime rejection when list expansion has no catalog candidates', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'expanded-neuron-invalid',
      cloudProvider: CloudType.AWS,
      vmType: [CATALOG_STALE_NEURON_VM],
      gpuType: null,
      region: 'us-east-2',
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: CATALOG_STALE_NEURON_VM,
      region: 'us-east-2',
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toMatch(/Neuron.*recognized.*not supported/i);
    expect(result.message).not.toMatch(/does not offer/i);
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('keeps a valid catalog fallback when a stale Neuron family is first', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'mixed-neuron-valid-fallback',
      cloudProvider: CloudType.AWS,
      vmType: [CATALOG_STALE_NEURON_VM, 'g4dn.xlarge'],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: CATALOG_STALE_NEURON_VM,
      region: undefined,
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe('g4dn.xlarge');
    expect(makeGateway).toHaveBeenCalledOnce();
  });

  it('keeps an unknown region-unpinned VM type queued for catalog refresh', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'region-unpinned-fake-queued',
      cloudProvider: CloudType.AWS,
      vmType: 'totally_fake_nonexistent_vm',
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: 'totally_fake_nonexistent_vm',
      region: undefined,
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Queued);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toMatch(/catalog refresh/i);
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('provisions a pinned scalar VM type the catalog knows, without building a gateway', async () => {
    const store = queries();
    // Precondition: this type really is in the catalog.
    expect(
      getRegionsForVMType('g4dn.xlarge', CloudType.AWS).length,
    ).toBeGreaterThan(0);
    const workload = makeStoredWorkload({
      id: 'pinned-known-provision',
      cloudProvider: CloudType.AWS,
      vmType: 'g4dn.xlarge',
      gpuType: null,
      region: 'us-east-1',
      state: WorkloadState.Queued,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: 'g4dn.xlarge',
      region: 'us-east-1',
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      () => {
        throw new Error(
          'makeGateway must not be called on the pinned scalar fast path',
        );
      },
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
  });

  it('preflights every unpinned region and selects the cheapest verified region without geographic preference', async () => {
    const catalog = catalogModule.readCatalog(CloudType.AWS);
    if (!catalog) throw new Error('published AWS catalog is unavailable');
    const vmType = 'optimizer-region-ordering-test';
    const expectedRegions = ['eu-west-1', 'ap-south-1', 'us-east-1'];
    const previousRegions = catalog.regionsPerType[vmType];
    const previousPrices = catalog.pricePerTypeRegion[vmType];
    catalog.regionsPerType[vmType] = ['us-east-1', 'ap-south-1', 'eu-west-1'];
    catalog.pricePerTypeRegion[vmType] = {
      'us-east-1': 1,
      'ap-south-1': 0.75,
      'eu-west-1': 0.5,
    };

    try {
      const store = queries();
      const workload = makeStoredWorkload({
        id: 'global-region-ordering',
        cloudProvider: CloudType.AWS,
        vmType,
        gpuType: null,
        region: null,
        state: WorkloadState.Queued,
        spot: false,
      });
      const cloudConfig: CloudConfig = {
        cloudProvider: CloudType.AWS,
        vmType,
        region: undefined,
        spot: false,
        credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
      };
      const preflightCandidates: TargetCandidate[][] = [];
      const candidateRegionFilter = createCandidateRegionFilter({
        cache: new CandidatePreflightCache<boolean>(),
        cacheKey: () => 'global-region-ordering',
        runPreflight: async ({ candidates }) => {
          preflightCandidates.push(candidates);
          return true;
        },
        assess: () => CandidateRegionAvailability.Verified,
      });

      const result = await resolveProvisioningTarget(
        workload,
        cloudConfig,
        store,
        () => makeMockCloudCompute({}, { candidateRegionFilter }),
      );

      expect(preflightCandidates).toEqual([
        expectedRegions.map((region) => ({ vmType, region })),
      ]);
      expect(result.state).toBe(WorkloadState.Provisioning);
      if (result.state !== WorkloadState.Provisioning) return;
      expect(result.config.region).toBe('eu-west-1');
      expect(result.eligibleRegions).toEqual(expectedRegions);
      // With no failures yet, every other region is a failover's untried target.
      expect(result.untriedTargets).toBe(expectedRegions.length - 1);
    } finally {
      if (previousRegions) catalog.regionsPerType[vmType] = previousRegions;
      else delete catalog.regionsPerType[vmType];
      if (previousPrices) catalog.pricePerTypeRegion[vmType] = previousPrices;
      else delete catalog.pricePerTypeRegion[vmType];
    }
  });

  it('lets the candidate filter enforce the supplied deadline', async () => {
    vi.useFakeTimers();
    try {
      const store = queries();
      const workload = makeStoredWorkload({
        id: 'filter-owned-timeout',
        cloudProvider: CloudType.AWS,
        vmType: 'g4dn.xlarge',
        gpuType: null,
        region: null,
        state: WorkloadState.Queued,
      });
      const cloudConfig: CloudConfig = {
        cloudProvider: CloudType.AWS,
        vmType: 'g4dn.xlarge',
        region: undefined,
        spot: false,
        credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
      };

      let filterStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        filterStarted = resolve;
      });
      const runPreflight = vi.fn(() => {
        filterStarted();
        return new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), 15_000);
        });
      });
      const candidateRegionFilter = createCandidateRegionFilter({
        cache: new CandidatePreflightCache<boolean>(),
        cacheKey: () => 'filter-owned-timeout',
        runPreflight,
        assess: (_snapshot, candidate) =>
          candidate.region === 'us-west-2'
            ? CandidateRegionAvailability.Verified
            : CandidateRegionAvailability.Unavailable,
      });

      const resultPromise = resolveProvisioningTarget(
        workload,
        cloudConfig,
        store,
        () => makeMockCloudCompute({}, { candidateRegionFilter }),
      );

      await started;
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;

      expect(runPreflight).toHaveBeenCalledOnce();
      expect(result.state).toBe(WorkloadState.Provisioning);
      if (result.state === WorkloadState.Provisioning) {
        expect(result.config.region).toBe('us-west-2');
        expect(result.config.vmType).toBe('g4dn.xlarge');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the candidate filter only for the current resolution', async () => {
    const store = queries();
    const vmType = 'g4dn.xlarge';
    const blockedRegion = getRegionsForVMType(vmType, CloudType.AWS)[0]!;
    const openRegion = getRegionsForVMType(vmType, CloudType.AWS)[1]!;
    const workload = makeStoredWorkload({
      id: 'filter-current-availability',
      cloudProvider: CloudType.AWS,
      vmType,
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      spot: false,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType,
      region: undefined,
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const candidateRegionFilter = createCandidateRegionFilter({
      cache: new CandidatePreflightCache<boolean>(),
      cacheKey: () => 'filter-current-availability',
      runPreflight: async () => true,
      assess: (_snapshot, candidate) =>
        candidate.region === blockedRegion
          ? CandidateRegionAvailability.Unavailable
          : CandidateRegionAvailability.Verified,
    });

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      queries(),
      () => makeMockCloudCompute({}, { candidateRegionFilter }),
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state === WorkloadState.Provisioning) {
      expect(result.config.region).not.toBe(blockedRegion);
      expect(result.config.region).toBe(openRegion);
    }
    expect(
      await store.getProvisioningFailures(workload.id, null, CloudType.AWS),
    ).toEqual([]);
  });

  it('returns Invalid when the current filter removes every candidate', async () => {
    const store = queries();
    const vmType = 'g4dn.xlarge';
    const workload = makeStoredWorkload({
      id: 'filter-all-blocked',
      cloudProvider: CloudType.AWS,
      vmType,
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      spot: false,
    });
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType,
      region: undefined,
      spot: false,
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    };
    const candidateRegionFilter = createCandidateRegionFilter({
      cache: new CandidatePreflightCache<boolean>(),
      cacheKey: () => 'filter-all-blocked',
      runPreflight: async () => true,
      assess: () => CandidateRegionAvailability.Unavailable,
    });

    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      () => makeMockCloudCompute({}, { candidateRegionFilter }),
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Invalid) {
      expect(result.message).toContain('All AWS regions');
      expect(result.message).toContain(vmType);
    }
  });
});

describe('resolveProvisioningTarget — Docker runtime compatibility', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });

  const awsCloudConfig = (vmType: string): CloudConfig => ({
    cloudProvider: CloudType.AWS,
    vmType,
    region: undefined,
    spot: false,
    credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
  });

  it('drops a CPU fallback and keeps a CUDA VM for NVIDIA Docker options', async () => {
    const workload = makeStoredWorkload({
      id: 'docker-gpu-compatible-fallback',
      cloudProvider: CloudType.AWS,
      vmType: ['t3.medium', 'g4dn.xlarge'],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      dockerOptions: { gpus: 'all', runtime: 'nvidia' },
    });

    const result = await resolveProvisioningTarget(
      workload,
      awsCloudConfig('t3.medium'),
      queries(),
      () => makeMockCloudCompute(),
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe('g4dn.xlarge');
  });

  it('marks an all-CPU fallback pool Invalid before building a gateway', async () => {
    const workload = makeStoredWorkload({
      id: 'docker-gpu-no-compatible-fallback',
      cloudProvider: CloudType.AWS,
      vmType: ['t3.medium', 't3.large'],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      dockerOptions: { gpus: 'all' },
    });
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      awsCloudConfig('t3.medium'),
      queries(),
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toContain('require an NVIDIA CUDA VM');
    expect(makeGateway).not.toHaveBeenCalled();
  });

  it('rejects a pinned CPU target before provider mutation', async () => {
    const workload = makeStoredWorkload({
      id: 'docker-gpu-pinned-cpu',
      cloudProvider: CloudType.AWS,
      vmType: 't3.medium',
      gpuType: null,
      region: 'us-east-1',
      state: WorkloadState.Queued,
      dockerOptions: { runtime: 'nvidia' },
    });
    const makeGateway = vi.fn(() => makeMockCloudCompute());

    const result = await resolveProvisioningTarget(
      workload,
      { ...awsCloudConfig('t3.medium'), region: 'us-east-1' },
      queries(),
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toContain('--runtime nvidia');
    expect(makeGateway).not.toHaveBeenCalled();
  });
});

describe('resolveProvisioningTarget — image-runtime compat filter', () => {
  // Real bundled Azure catalog SKUs (verified via gpuRuntimeForVMType):
  //   MI300X  -> rocm,  H100 -> cuda,  D1 -> CPU (null). MI300X + H100 share
  //   regions (eastus2/centralus), so a mixed list yields both candidate sets.
  const ROCM_VM = 'Standard_ND96isr_MI300X_v5';
  const CUDA_VM = 'Standard_NC40ads_H100_v5';
  const CPU_VM = 'Standard_D1';

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });

  // Sanity-check the catalog preconditions the assertions below rely on so a
  // catalog drift surfaces as a clear failure here, not a confusing one later.
  it('catalog precondition: the test SKUs resolve to the expected runtimes', () => {
    expect(gpuRuntimeForVMType(CloudType.Azure, ROCM_VM)).toBe(GpuRuntime.Rocm);
    expect(gpuRuntimeForVMType(CloudType.Azure, CUDA_VM)).toBe(GpuRuntime.Cuda);
    expect(gpuRuntimeForVMType(CloudType.Azure, CPU_VM)).toBeNull();
    expect(
      getRegionsForVMType(CUDA_VM, CloudType.Azure).length,
    ).toBeGreaterThan(0);
    expect(
      getRegionsForVMType(ROCM_VM, CloudType.Azure).length,
    ).toBeGreaterThan(0);
  });

  const azureCloudConfig = (): CloudConfig => ({
    cloudProvider: CloudType.Azure,
    vmType: ROCM_VM, // collapsed fallback head; resolveProvisioningTarget overwrites it
    region: undefined,
    spot: false,
    credentials: TEST_AZURE_CRED,
  });

  // Mock gateway with no CandidateRegionFilter, isolating compatibility
  // filter as the only thing dropping candidates.
  const makeGateway = () => makeMockCloudCompute();

  it('drops the rocm candidate and keeps the cuda SKU for a CUDA image', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-cuda-mixed',
      cloudProvider: CloudType.Azure,
      vmType: [ROCM_VM, CUDA_VM],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Cuda,
    });

    const result = await resolveProvisioningTarget(
      workload,
      azureCloudConfig(),
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(CUDA_VM);
  });

  it('keeps the rocm SKU for a ROCm image', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-rocm-mixed',
      cloudProvider: CloudType.Azure,
      vmType: [ROCM_VM, CUDA_VM],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Rocm,
    });

    const result = await resolveProvisioningTarget(
      workload,
      azureCloudConfig(),
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(ROCM_VM);
  });

  it('returns a TERMINAL Invalid (not catalog-stale Queued) when a CUDA image has only rocm candidates', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-cuda-only-rocm',
      cloudProvider: CloudType.Azure,
      vmType: [ROCM_VM],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Cuda,
    });

    const result = await resolveProvisioningTarget(
      workload,
      azureCloudConfig(),
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    // Specific runtime-mismatch wording — NOT the catalog-refresh wording.
    expect(result.message).toContain('CUDA');
    expect(result.message).not.toContain('catalog refresh');
  });

  it('rejects a pinned ROCm VM for a CUDA image', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-pinned-cuda-rocm',
      cloudProvider: CloudType.Azure,
      vmType: ROCM_VM,
      gpuType: null,
      region: 'eastus2',
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Cuda,
    });
    const makePinnedGateway = vi.fn(makeGateway);

    const result = await resolveProvisioningTarget(
      workload,
      { ...azureCloudConfig(), vmType: ROCM_VM, region: 'eastus2' },
      store,
      makePinnedGateway,
    );

    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state === WorkloadState.Provisioning) return;
    expect(result.message).toContain('CUDA');
    expect(makePinnedGateway).not.toHaveBeenCalled();
  });

  it('keeps a pinned ROCm VM for a ROCm image', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-pinned-rocm-rocm',
      cloudProvider: CloudType.Azure,
      vmType: ROCM_VM,
      gpuType: null,
      region: 'eastus2',
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Rocm,
    });

    const result = await resolveProvisioningTarget(
      workload,
      { ...azureCloudConfig(), vmType: ROCM_VM, region: 'eastus2' },
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(ROCM_VM);
  });

  it.each([ImageRuntime.Unknown, null] as const)(
    'keeps pinned scalar targets when imageRuntime is %s',
    async (imageRuntime) => {
      const store = queries();
      const workload = makeStoredWorkload({
        id: `compat-pinned-${imageRuntime ?? 'null'}`,
        cloudProvider: CloudType.Azure,
        vmType: ROCM_VM,
        gpuType: null,
        region: 'eastus2',
        state: WorkloadState.Queued,
        imageRuntime,
      });

      const result = await resolveProvisioningTarget(
        workload,
        { ...azureCloudConfig(), vmType: ROCM_VM, region: 'eastus2' },
        store,
        makeGateway,
      );

      expect(result.state).toBe(WorkloadState.Provisioning);
      if (result.state !== WorkloadState.Provisioning) return;
      expect(result.config.vmType).toBe(ROCM_VM);
    },
  );

  it('keeps all candidates for an unknown-runtime image (conservative keep-all)', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-unknown',
      cloudProvider: CloudType.Azure,
      vmType: [ROCM_VM, CUDA_VM],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Unknown,
    });

    const result = await resolveProvisioningTarget(
      workload,
      azureCloudConfig(),
      store,
      makeGateway,
    );

    // Nothing dropped: the first candidate (rocm, list order) is picked.
    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(ROCM_VM);
  });

  it('keeps all candidates when imageRuntime is null (legacy rows)', async () => {
    const store = queries();
    const workload = makeStoredWorkload({
      id: 'compat-null',
      cloudProvider: CloudType.Azure,
      vmType: [ROCM_VM, CUDA_VM],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: null,
    });

    const result = await resolveProvisioningTarget(
      workload,
      azureCloudConfig(),
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(ROCM_VM);
  });

  it('leaves a CPU candidate untouched under a CUDA image', async () => {
    const store = queries();
    // CPU first in the list — it must survive the CUDA-image filter (runtime null).
    const workload = makeStoredWorkload({
      id: 'compat-cpu-untouched',
      cloudProvider: CloudType.Azure,
      vmType: [CPU_VM, CUDA_VM],
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Cuda,
    });

    const result = await resolveProvisioningTarget(
      workload,
      azureCloudConfig(),
      store,
      makeGateway,
    );

    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    // CPU candidate kept → first in list order is the picked target.
    expect(result.config.vmType).toBe(CPU_VM);
  });
});

// A scalar GPU alias (H100:1) must NOT collapse to the single cheapest SKU on the
// pinned fast path — it expands to its interchangeable family (pcie + sxm5) and
// rotates to the sibling when the cheapest target fails. This is the fix
// for the reported bug where H100:1 pinned a region and looped on pcie forever.
describe('resolveProvisioningTarget — GPU alias expands to the SKU family', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });
  afterEach(() => vi.restoreAllMocks());

  it('routes a pinned GPU alias through expansion and rotates using workload history', async () => {
    // Real Lambda catalog: H100:1 → the pcie + sxm5 family, both offered in the
    // first catalog-ranked region. buildCloudConfig collapses the alias to the
    // cheapest head (pcie) before resolveProvisioningTarget runs.
    const family = resolveVMTypes('H100:1', CloudType.Lambda);
    expect(family).toContain('gpu_1x_h100_pcie');
    expect(family).toContain('gpu_1x_h100_sxm5');
    const region = getRegionsForVMType(
      'gpu_1x_h100_sxm5',
      CloudType.Lambda,
    )[0]!;

    const store = queries();
    const workload = () =>
      makeStoredWorkload({
        id: 'lambda-h100-alias',
        cloudProvider: CloudType.Lambda,
        vmType: null,
        gpuType: 'H100:1',
        region,
        state: WorkloadState.Queued,
      });
    const cloudConfig = (): CloudConfig => ({
      cloudProvider: CloudType.Lambda,
      vmType: 'gpu_1x_h100_pcie',
      region,
      spot: false,
      credentials: { apiKey: 'lambda-test-key' },
    });

    const first = await resolveProvisioningTarget(
      workload(),
      cloudConfig(),
      store,
      () => makeMockCloudCompute(),
    );
    expect(first.state).toBe(WorkloadState.Provisioning);
    if (first.state !== WorkloadState.Provisioning) return;
    expect(first.config.vmType).toBe('gpu_1x_h100_pcie'); // cheapest first

    vi.spyOn(store, 'getProvisioningFailures').mockResolvedValue([
      failedTarget({ vmType: 'gpu_1x_h100_pcie', region }),
    ]);

    const second = await resolveProvisioningTarget(
      workload(),
      cloudConfig(),
      store,
      () => makeMockCloudCompute(),
    );
    expect(second.state).toBe(WorkloadState.Provisioning);
    if (second.state !== WorkloadState.Provisioning) return;
    expect(second.config.vmType).toBe('gpu_1x_h100_sxm5'); // rotated to sibling
    expect(second.config.region).toBe(region);
  });

  // An AWS spot Job listing p5, p5e and p5en launched only p5, region
  // by region. The account has P Spot quota only in the four US regions.
  it("tries each type's first eligible region before retrying a type elsewhere", async () => {
    const types = ['p5.48xlarge', 'p5e.48xlarge', 'p5en.48xlarge'];
    const us = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'];
    const candidateRegionFilter = createCandidateRegionFilter({
      cache: new CandidatePreflightCache<boolean>(),
      cacheKey: () => 'us-only-p-spot-quota',
      runPreflight: async () => true,
      assess: (_snapshot, candidate) =>
        us.includes(candidate.region)
          ? CandidateRegionAvailability.Verified
          : CandidateRegionAvailability.Unavailable,
    });
    const store = queries();
    const failures: ProvisioningFailure[] = [];
    vi.spyOn(store, 'getProvisioningFailures').mockImplementation(async () => [
      ...failures,
    ]);

    // Every launch reports no capacity, so one pass walks every candidate.
    const regions = types.map((type) =>
      getRegionsForVMType(type, CloudType.AWS, true).filter((region) =>
        us.includes(region),
      ),
    );
    const attempts: string[] = [];
    for (const _ of regions.flat()) {
      const result = await resolveProvisioningTarget(
        makeStoredWorkload({
          id: 'spot-p5-family',
          cloudProvider: CloudType.AWS,
          vmType: types,
          gpuType: null,
          region: null,
          state: WorkloadState.Queued,
        }),
        {
          cloudProvider: CloudType.AWS,
          vmType: types,
          spot: true,
          credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
        },
        store,
        () => makeMockCloudCompute({}, { candidateRegionFilter }),
        'credential-a',
      );
      expect(result.state).toBe(WorkloadState.Provisioning);
      if (result.state !== WorkloadState.Provisioning) return;
      const vmType = result.config.vmType as string;
      const region = result.config.region!;
      attempts.push(`${vmType}@${region}`);
      failures.push(
        failedTarget(
          { vmType, region },
          { diagnosis: CloudFailureDiagnosis.CapacityExhausted, spot: true },
        ),
      );
    }

    // Round robin by region rank, in the requested type order. p5e has only
    // two US regions, so ranks 2 and 3 alternate p5 and p5en.
    const [p5, p5e, p5en] = regions as [string[], string[], string[]];
    expect([p5.length, p5e.length, p5en.length]).toEqual([4, 2, 4]);
    expect(attempts).toEqual([
      `p5.48xlarge@${p5[0]}`,
      `p5e.48xlarge@${p5e[0]}`,
      `p5en.48xlarge@${p5en[0]}`,
      `p5.48xlarge@${p5[1]}`,
      `p5e.48xlarge@${p5e[1]}`,
      `p5en.48xlarge@${p5en[1]}`,
      `p5.48xlarge@${p5[2]}`,
      `p5en.48xlarge@${p5en[2]}`,
      `p5.48xlarge@${p5[3]}`,
      `p5en.48xlarge@${p5en[3]}`,
    ]);
  });
});

// Published-catalog contract: a Lambda region added by the provider-native
// fetcher remains usable by runtime placement, including sibling-SKU rotation.
describe('resolveProvisioningTarget — published Lambda catalog', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });

  it('makes us-southeast-1 resolvable from the published catalog', () => {
    expect(getRegionsForVMType('gpu_1x_h100_sxm5', CloudType.Lambda)).toContain(
      'us-southeast-1',
    );
    expect(resolveVMTypes('H100:1', CloudType.Lambda)).toEqual([
      'gpu_1x_h100_pcie',
      'gpu_1x_h100_sxm5',
    ]);
  });

  it('honors a pin to us-southeast-1 and rotates H100 pcie→sxm5 there', async () => {
    const store = queries();
    const workload = () =>
      makeStoredWorkload({
        id: 'lambda-h100-southeast',
        cloudProvider: CloudType.Lambda,
        vmType: null,
        gpuType: 'H100:1',
        region: 'us-southeast-1',
        state: WorkloadState.Queued,
      });
    const cloudConfig = (): CloudConfig => ({
      cloudProvider: CloudType.Lambda,
      vmType: 'gpu_1x_h100_pcie',
      region: 'us-southeast-1',
      spot: false,
      credentials: { apiKey: 'lambda-test-key' },
    });

    const first = await resolveProvisioningTarget(
      workload(),
      cloudConfig(),
      store,
      () => makeMockCloudCompute(),
    );
    expect(first.state).toBe(WorkloadState.Provisioning);
    if (first.state !== WorkloadState.Provisioning) return;
    expect(first.config.region).toBe('us-southeast-1');
    expect(first.config.vmType).toBe('gpu_1x_h100_pcie');

    vi.spyOn(store, 'getProvisioningFailures').mockResolvedValue([
      failedTarget({
        vmType: 'gpu_1x_h100_pcie',
        region: 'us-southeast-1',
      }),
    ]);

    const second = await resolveProvisioningTarget(
      workload(),
      cloudConfig(),
      store,
      () => makeMockCloudCompute(),
    );
    expect(second.state).toBe(WorkloadState.Provisioning);
    if (second.state !== WorkloadState.Provisioning) return;
    expect(second.config.vmType).toBe('gpu_1x_h100_sxm5');
    expect(second.config.region).toBe('us-southeast-1');
  });
});

// --disk-tier high/ultra provisions a Premium OS disk, valid only on
// premium-capable VM sizes. Exercise this against real Azure Resource SKU data:
// Standard_B1ms is PremiumIO-capable; Standard_A1_v2 is not.
describe('resolveProvisioningTarget — premium-storage (disk-tier) compat filter', () => {
  const PREMIUM_VM = 'Standard_B1ms';
  const NON_PREMIUM_VM = 'Standard_A1_v2';

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });

  const azureCloudConfig = (diskTier?: DiskTier): CloudConfig => ({
    cloudProvider: CloudType.Azure,
    vmType: PREMIUM_VM,
    region: undefined,
    spot: false,
    diskTier,
    credentials: TEST_AZURE_CRED,
  });

  const makeGateway = () => makeMockCloudCompute();

  const azureWorkload = (id: string, vmType: string | string[]) =>
    makeStoredWorkload({
      id,
      cloudProvider: CloudType.Azure,
      vmType,
      gpuType: null,
      region: null,
      state: WorkloadState.Queued,
      imageRuntime: ImageRuntime.Unknown,
    });

  it('drops a non-premium-capable VM and keeps the capable sibling for --disk-tier high', async () => {
    const result = await resolveProvisioningTarget(
      azureWorkload('premium-mixed', [NON_PREMIUM_VM, PREMIUM_VM]),
      azureCloudConfig(DiskTier.High),
      queries(),
      makeGateway,
    );
    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(PREMIUM_VM);
  });

  it('returns a terminal Invalid when only a non-premium-capable VM is offered for high/ultra', async () => {
    const result = await resolveProvisioningTarget(
      azureWorkload('premium-only-incapable', [NON_PREMIUM_VM]),
      azureCloudConfig(DiskTier.Ultra),
      queries(),
      makeGateway,
    );
    expect(result.state).toBe(WorkloadState.Invalid);
  });

  it('applies the shared high default to premium-storage filtering', async () => {
    const result = await resolveProvisioningTarget(
      azureWorkload('premium-default', [NON_PREMIUM_VM]),
      azureCloudConfig(DEFAULT_DISK_TIER),
      queries(),
      makeGateway,
    );
    expect(result.state).toBe(WorkloadState.Invalid);
    if (result.state !== WorkloadState.Invalid) return;
    expect(result.message).toContain('Premium-capable VM size');
  });

  it('does not filter an explicit medium tier on a non-capable VM', async () => {
    const result = await resolveProvisioningTarget(
      azureWorkload('premium-medium', [NON_PREMIUM_VM]),
      azureCloudConfig(DiskTier.Medium),
      queries(),
      makeGateway,
    );
    expect(result.state).toBe(WorkloadState.Provisioning);
    if (result.state !== WorkloadState.Provisioning) return;
    expect(result.config.vmType).toBe(NON_PREMIUM_VM);
  });
});

describe('resolveProvisioningTarget — a VM Job region allow-list', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
  });
  afterEach(() => vi.restoreAllMocks());

  const vmType = 'm5.large';
  const offered = getRegionsForVMType(vmType, CloudType.AWS);
  const allowed = offered.slice(1, 3);
  const workload = () =>
    makeStoredWorkload({
      id: 'aws-regions',
      cloudProvider: CloudType.AWS,
      vmType,
      region: null,
      regions: allowed,
      state: WorkloadState.Queued,
    });
  const cloudConfig = (): CloudConfig => ({
    cloudProvider: CloudType.AWS,
    vmType,
    spot: false,
    regions: allowed,
    credentials: TEST_AWS_CRED,
  });

  it('launches only in the allowed regions, and rotates across them after a regional failure', async () => {
    expect(allowed).toHaveLength(2);
    const store = queries();
    const first = await resolveProvisioningTarget(
      workload(),
      cloudConfig(),
      store,
      () => makeMockCloudCompute(),
    );
    expect(first.state).toBe(WorkloadState.Provisioning);
    if (first.state !== WorkloadState.Provisioning) return;
    expect(allowed).toContain(first.config.region);
    expect(
      first.eligibleRegions?.every((region) => allowed.includes(region)),
    ).toBe(true);
    // Only the other allowed region is untried, however many the type has.
    expect(offered.length).toBeGreaterThan(allowed.length);
    expect(first.untriedTargets).toBe(1);

    vi.spyOn(store, 'getProvisioningFailures').mockResolvedValue([
      failedTarget({
        vmType,
        region: first.config.region!,
        availabilityZone: first.config.availabilityZone,
      }),
    ]);
    const second = await resolveProvisioningTarget(
      workload(),
      cloudConfig(),
      store,
      () => makeMockCloudCompute(),
    );
    expect(second.state).toBe(WorkloadState.Provisioning);
    if (second.state !== WorkloadState.Provisioning) return;
    expect(allowed).toContain(second.config.region);
    expect(second.config.region).not.toBe(first.config.region);
    expect(second.untriedTargets).toBe(0);
  });

  it('is invalid when no allowed region offers the VM type', async () => {
    const result = await resolveProvisioningTarget(
      makeStoredWorkload({
        ...workload(),
        regions: ['not-a-region-1'],
      }),
      { ...cloudConfig(), regions: ['not-a-region-1'] },
      queries(),
      () => makeMockCloudCompute(),
    );
    expect(result).toMatchObject({
      state: WorkloadState.Invalid,
      message: expect.stringContaining(
        'None of the regions not-a-region-1 offers VM type "m5.large"',
      ),
    });
  });
});
