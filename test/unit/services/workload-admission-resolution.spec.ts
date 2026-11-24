import { describe, expect, it } from 'vitest';
import {
  knownRegions,
  assertDiskPerformance,
  nestedVmJobTypes,
  normalizeCredentiallessComputeRequest,
} from '../../../src/api/services/workload-admission-resolution';
import {
  type CloudConfig,
  CloudType,
  DiskTier,
} from '../../../src/shared/cloud.js';
import { TEST_AWS_CRED } from '../helpers/fixtures';
import {
  diskVolumePerformance,
  GP3_LIMITS,
  HYPERDISK_BALANCED_LIMITS,
} from '../../../src/shared/disk-performance.js';

describe('normalizeCredentiallessComputeRequest', () => {
  it('rejects invalid provider strings before provider metadata lookup', () => {
    expect(() =>
      normalizeCredentiallessComputeRequest({
        cloudConfig: { cloudProvider: 'bogus' as CloudType },
      }),
    ).toThrow('cloudConfig.cloudProvider is invalid');
  });

  it('normalizes Local defaults without credentials', () => {
    const cloudConfig = { cloudProvider: CloudType.Local };

    expect(normalizeCredentiallessComputeRequest({ cloudConfig })).toBe(
      CloudType.Local,
    );
    expect(cloudConfig).toEqual({
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    });
  });

  it('accepts Local runtime buckets without explicit storage credentials', () => {
    const cloudConfig = {
      cloudProvider: CloudType.Local,
      inputBucket: 'input',
      outputBucket: 'output',
      checkpointBucket: 'checkpoint',
    };

    expect(normalizeCredentiallessComputeRequest({ cloudConfig })).toBe(
      CloudType.Local,
    );
  });

  it('rejects Local with compute credentials', () => {
    expect(() =>
      normalizeCredentiallessComputeRequest({
        cloudConfig: {
          cloudProvider: CloudType.Local,
          credentials: TEST_AWS_CRED,
        },
      }),
    ).toThrow(/does not use compute credentials/i);
  });

  it('rejects Local with remote target knobs', () => {
    expect(() =>
      normalizeCredentiallessComputeRequest({
        cloudConfig: {
          cloudProvider: CloudType.Local,
          vmType: 't3.micro',
        },
      }),
    ).toThrow(/does not accept --vm-type/i);
  });

  it('rejects Local with disk tier', () => {
    expect(() =>
      normalizeCredentiallessComputeRequest({
        cloudConfig: {
          cloudProvider: CloudType.Local,
          diskTier: DiskTier.High,
        },
      }),
    ).toThrow(/does not accept --disk-tier/i);
  });

  it('rejects the retired Kubernetes provider value', () => {
    expect(() =>
      normalizeCredentiallessComputeRequest({
        cloudConfig: { cloudProvider: 'Kubernetes' as CloudType },
      }),
    ).toThrow('cloudConfig.cloudProvider is invalid');
  });
});

describe('nestedVmJobTypes', () => {
  it('keeps the GCP types the catalog reports nesting for, and refuses when none is left', () => {
    // Catalog data: N2 nests; E2 doesn't.
    expect(
      nestedVmJobTypes({
        cloudProvider: CloudType.GCP,
        vmType: ['e2-standard-4', 'n2-standard-4'],
      }),
    ).toBe('n2-standard-4');
    expect(() =>
      nestedVmJobTypes({
        cloudProvider: CloudType.GCP,
        vmType: 'e2-standard-4',
      }),
    ).toThrow(/none of e2-standard-4/);
    expect(() => nestedVmJobTypes({ cloudProvider: CloudType.GCP })).toThrow(
      '--require-nested-virtualization needs --vm-type',
    );
  });
});

describe('knownRegions', () => {
  it('dedupes catalog regions, and refuses unknown ones, globs, none, or more than 64', () => {
    expect(
      knownRegions(CloudType.AWS, ['us-east-1', 'us-west-2', 'us-east-1']),
    ).toEqual(['us-east-1', 'us-west-2']);
    // backmesh sends a list only for several regions, but one is accepted.
    expect(knownRegions(CloudType.AWS, ['us-east-1'])).toEqual(['us-east-1']);
    expect(() => knownRegions(CloudType.AWS, ['us-east-1', 'mars-1'])).toThrow(
      '--regions names mars-1, which AWS does not offer',
    );
    expect(() => knownRegions(CloudType.AWS, ['us-*'])).toThrow(
      '--regions names us-*',
    );
    expect(() => knownRegions(CloudType.AWS, [])).toThrow(
      '--regions takes 1 to 64 regions',
    );
    expect(() =>
      knownRegions(
        CloudType.AWS,
        Array.from({ length: 65 }, (_, i) => `r-${i}`),
      ),
    ).toThrow('--regions takes 1 to 64 regions');
  });
});

const cpu3000 = (diskTier: DiskTier | undefined): CloudConfig => ({
  cloudProvider: CloudType.AWS,
  vmType: 't3.medium',
  diskIops: 3000,
  ...(diskTier && { diskTier }),
});

describe('assertDiskPerformance on AWS gp3', () => {
  const aws = (fields: Partial<CloudConfig>): CloudConfig => ({
    cloudProvider: CloudType.AWS,
    ...fields,
  });

  it("admits backmesh's 500 MiB/s and 3,000 IOPS, and AWS's ranges", () => {
    for (const fields of [
      { diskIops: 3000, diskThroughputMibps: 500 },
      // 80,000 IOPS needs 160 GB; 2,000 MiB/s needs 8,000 IOPS.
      { diskIops: 80000, diskThroughputMibps: 2000, diskSizeGb: 160 },
      // The tier's 8,000 IOPS carries 2,000 MiB/s.
      { diskTier: DiskTier.High, diskThroughputMibps: 2000 },
      { diskThroughputMibps: 125 },
      // Unset, the tier is the default high one: 8,000 IOPS.
      { diskThroughputMibps: 2000 },
    ]) {
      expect(() => assertDiskPerformance(aws(fields))).not.toThrow();
    }
  });

  it('refuses values outside AWS gp3 limits', () => {
    for (const [fields, message] of [
      [
        { diskIops: 2999 },
        '--disk-iops must be a whole number from 3000 to 80000',
      ],
      [{ diskIops: 80001, diskSizeGb: 200 }, 'from 3000 to 80000'],
      [{ diskThroughputMibps: 124 }, 'from 125 to 2000'],
      [{ diskThroughputMibps: 2001, diskIops: 9000 }, 'from 125 to 2000'],
      // 3,000 baseline IOPS carry at most 750 MiB/s.
      [
        { diskTier: DiskTier.Medium, diskThroughputMibps: 751 },
        'needs at least 3004 IOPS',
      ],
      [
        { diskIops: 4000, diskThroughputMibps: 1001 },
        'needs at least 4004 IOPS',
      ],
    ] as const) {
      expect(
        () => assertDiskPerformance(aws(fields)),
        JSON.stringify(fields),
      ).toThrow(message);
    }
  });

  it("refuses IOPS a CPU VM Job's root is too small for, without growing it, and leaves a GPU AMI's root to launch", () => {
    const cpu = (fields: Partial<CloudConfig>) =>
      aws({ vmType: 't3.medium', ...fields });
    // A CPU VM Job's root is 30 GiB unless --disk-size says otherwise.
    expect(() => assertDiskPerformance(cpu({ diskIops: 15000 }))).not.toThrow();
    expect(() => assertDiskPerformance(cpu({ diskIops: 15001 }))).toThrow(
      '15001 IOPS needs a root volume of at least 31 GiB (500 IOPS per GiB); pass --disk-size 31 or more',
    );
    expect(() =>
      assertDiskPerformance(cpu({ diskIops: 20000, diskSizeGb: 39 })),
    ).toThrow('at least 40 GiB');
    expect(() =>
      assertDiskPerformance(cpu({ diskIops: 20000, diskSizeGb: 40 })),
    ).not.toThrow();
    // A GPU AMI's root is its own size; launch checks it.
    expect(() =>
      assertDiskPerformance(aws({ vmType: 'g4dn.xlarge', diskIops: 20000 })),
    ).not.toThrow();
    // A tier's own IOPS keep their existing sizing, with a throughput too.
    expect(() =>
      assertDiskPerformance(
        cpu({
          diskTier: DiskTier.Ultra,
          diskThroughputMibps: 500,
          diskSizeGb: 20,
        }),
      ),
    ).not.toThrow();
  });

  it('admits --disk-iops alone below the tier, whose throughput comes down to fit', () => {
    for (const diskTier of [DiskTier.High, DiskTier.Ultra, undefined])
      expect(() => assertDiskPerformance(cpu3000(diskTier))).not.toThrow();
    expect(
      diskVolumePerformance(GP3_LIMITS, DiskTier.High, { diskIops: 3000 }),
    ).toEqual({
      Iops: 3000,
      Throughput: 750,
    });
    // EBS takes whole MiB/s: rounded down, still within 0.25 per IOPS.
    expect(
      diskVolumePerformance(GP3_LIMITS, DiskTier.High, { diskIops: 3750 }),
    ).toEqual({
      Iops: 3750,
      Throughput: 937,
    });
    expect(
      diskVolumePerformance(GP3_LIMITS, DiskTier.Ultra, { diskIops: 6000 }),
    ).toEqual({
      Iops: 6000,
      Throughput: 1000,
    });
    expect(
      diskVolumePerformance(GP3_LIMITS, DiskTier.High, {
        diskThroughputMibps: 500,
      }),
    ).toEqual({ Iops: 8000, Throughput: 500 });
    expect(diskVolumePerformance(GP3_LIMITS, DiskTier.Medium, {})).toEqual({});
  });

  it('refuses them on every cloud but AWS and GCP', () => {
    for (const cloudProvider of [
      CloudType.Azure,
      CloudType.Lambda,
      CloudType.Local,
    ]) {
      expect(() =>
        assertDiskPerformance({ cloudProvider, diskIops: 3000 }),
      ).toThrow(
        '--disk-iops/--disk-throughput take AWS gp3 or GCP Hyperdisk Balanced; pin the Job to AWS or GCP',
      );
    }
    expect(() =>
      assertDiskPerformance({ cloudProvider: CloudType.Azure }),
    ).not.toThrow();
  });
});

describe('assertDiskPerformance on GCP Hyperdisk Balanced', () => {
  const gcp = (fields: Partial<CloudConfig>): CloudConfig => ({
    cloudProvider: CloudType.GCP,
    vmType: 'c4d-standard-4',
    ...fields,
  });

  it("admits backmesh's spot c4d 3,000 IOPS and 750 MiB/s, and GCP's ranges", () => {
    for (const fields of [
      { diskIops: 3000, diskThroughputMibps: 750 },
      { diskIops: 3000 },
      // The default high tier's 8,000 IOPS carry 2,000 MiB/s.
      { diskThroughputMibps: 2000 },
      { diskThroughputMibps: 140 },
      // 160,000 IOPS need 320 GiB and at least 625 MiB/s.
      { diskIops: 160000, diskThroughputMibps: 625, diskSizeGb: 320 },
      { diskIops: 9600, diskThroughputMibps: 2400 },
    ]) {
      expect(
        () => assertDiskPerformance(gcp(fields)),
        JSON.stringify(fields),
      ).not.toThrow();
    }
  });

  it("refuses values outside GCP's limits before launch", () => {
    for (const [fields, message] of [
      [
        { diskIops: 2999 },
        '--disk-iops must be a whole number from 3000 to 160000 on GCP Hyperdisk Balanced',
      ],
      [{ diskIops: 160001, diskSizeGb: 400 }, 'from 3000 to 160000'],
      [{ diskThroughputMibps: 139 }, 'from 140 to 2400'],
      [{ diskThroughputMibps: 2401, diskIops: 10000 }, 'from 140 to 2400'],
      // GCP refuses more than a quarter of the IOPS (anycloud#45).
      [
        { diskIops: 3000, diskThroughputMibps: 1000 },
        '--disk-throughput 1000 MiB/s needs at least 4000 IOPS',
      ],
      [
        { diskTier: DiskTier.Medium, diskThroughputMibps: 751 },
        'needs at least 3004 IOPS',
      ],
      // ... and fewer than 1/256 MiB/s per IOPS.
      [
        { diskIops: 160000, diskThroughputMibps: 624, diskSizeGb: 320 },
        '160000 IOPS need at least 625 MiB/s on GCP Hyperdisk Balanced',
      ],
    ] as const) {
      expect(
        () => assertDiskPerformance(gcp(fields)),
        JSON.stringify(fields),
      ).toThrow(message);
    }
  });

  it('admits a list with a Persistent Disk fallback, and refuses one no type of which boots from Hyperdisk', () => {
    const own = { diskIops: 3000, diskThroughputMibps: 750 };
    expect(() =>
      assertDiskPerformance(
        gcp({ ...own, vmType: ['c4d-standard-4', 'n2-standard-4'] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertDiskPerformance(
        gcp({ ...own, vmType: ['n2-standard-4', 'n2d-standard-4'] }),
      ),
    ).toThrow(
      '--disk-iops/--disk-throughput set GCP Hyperdisk Balanced, which none of n2-standard-4, n2d-standard-4 boots from',
    );
  });

  it('refuses IOPS the 100 GiB default Hyperdisk is too small for, without growing it', () => {
    expect(() => assertDiskPerformance(gcp({ diskIops: 50000 }))).not.toThrow();
    expect(() => assertDiskPerformance(gcp({ diskIops: 50001 }))).toThrow(
      '50001 IOPS needs a root volume of at least 101 GiB (500 IOPS per GiB); pass --disk-size 101 or more',
    );
    expect(() =>
      assertDiskPerformance(gcp({ diskIops: 3000, diskSizeGb: 5 })),
    ).toThrow('at least 6 GiB');
  });

  it("fills the throughput the Job leaves out from the tier, within GCP's range for the IOPS", () => {
    const volume = (diskTier: DiskTier, diskIops: number) =>
      diskVolumePerformance(HYPERDISK_BALANCED_LIMITS, diskTier, { diskIops });
    expect(volume(DiskTier.High, 3000)).toEqual({
      Iops: 3000,
      Throughput: 750,
    });
    expect(volume(DiskTier.High, 160000)).toEqual({
      Iops: 160000,
      Throughput: 1000,
    });
    expect(volume(DiskTier.Medium, 160000)).toEqual({
      Iops: 160000,
      Throughput: 625,
    });
  });
});
