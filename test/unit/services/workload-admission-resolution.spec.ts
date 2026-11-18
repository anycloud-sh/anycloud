import { describe, expect, it } from 'vitest';
import {
  knownRegions,
  assertGp3Performance,
  nestedVmJobTypes,
  normalizeCredentiallessComputeRequest,
} from '../../../src/api/services/workload-admission-resolution';
import {
  type CloudConfig,
  CloudType,
  DiskTier,
} from '../../../src/shared/cloud.js';
import { TEST_AWS_CRED } from '../helpers/fixtures';
import { gp3VolumePerformance } from '../../../src/shared/gp3-performance.js';

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

describe('assertGp3Performance', () => {
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
      expect(() => assertGp3Performance(aws(fields))).not.toThrow();
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
        () => assertGp3Performance(aws(fields)),
        JSON.stringify(fields),
      ).toThrow(message);
    }
  });

  it("refuses IOPS a CPU VM Job's root is too small for, without growing it, and leaves a GPU AMI's root to launch", () => {
    const cpu = (fields: Partial<CloudConfig>) =>
      aws({ vmType: 't3.medium', ...fields });
    // A CPU VM Job's root is 30 GiB unless --disk-size says otherwise.
    expect(() => assertGp3Performance(cpu({ diskIops: 15000 }))).not.toThrow();
    expect(() => assertGp3Performance(cpu({ diskIops: 15001 }))).toThrow(
      '15001 IOPS needs a root volume of at least 31 GiB (500 IOPS per GiB); pass --disk-size 31 or more',
    );
    expect(() =>
      assertGp3Performance(cpu({ diskIops: 20000, diskSizeGb: 39 })),
    ).toThrow('at least 40 GiB');
    expect(() =>
      assertGp3Performance(cpu({ diskIops: 20000, diskSizeGb: 40 })),
    ).not.toThrow();
    // A GPU AMI's root is its own size; launch checks it.
    expect(() =>
      assertGp3Performance(aws({ vmType: 'g4dn.xlarge', diskIops: 20000 })),
    ).not.toThrow();
    // A tier's own IOPS keep their existing sizing, with a throughput too.
    expect(() =>
      assertGp3Performance(
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
      expect(() => assertGp3Performance(cpu3000(diskTier))).not.toThrow();
    expect(gp3VolumePerformance(DiskTier.High, { diskIops: 3000 })).toEqual({
      Iops: 3000,
      Throughput: 750,
    });
    // EBS takes whole MiB/s: rounded down, still within 0.25 per IOPS.
    expect(gp3VolumePerformance(DiskTier.High, { diskIops: 3750 })).toEqual({
      Iops: 3750,
      Throughput: 937,
    });
    expect(gp3VolumePerformance(DiskTier.Ultra, { diskIops: 6000 })).toEqual({
      Iops: 6000,
      Throughput: 1000,
    });
    expect(
      gp3VolumePerformance(DiskTier.High, { diskThroughputMibps: 500 }),
    ).toEqual({ Iops: 8000, Throughput: 500 });
    expect(gp3VolumePerformance(DiskTier.Medium, {})).toEqual({});
  });

  it('refuses them on every cloud but AWS', () => {
    for (const cloudProvider of [
      CloudType.GCP,
      CloudType.Azure,
      CloudType.Lambda,
      CloudType.Local,
    ]) {
      expect(() =>
        assertGp3Performance({ cloudProvider, diskIops: 3000 }),
      ).toThrow(
        '--disk-iops/--disk-throughput are AWS gp3 only; pin the Job to AWS',
      );
    }
    expect(() =>
      assertGp3Performance({ cloudProvider: CloudType.GCP }),
    ).not.toThrow();
  });
});
