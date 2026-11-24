import { describe, expect, test } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import {
  jobMemberProfile,
  jobStageBudget,
} from '../integration/e2e/internal/contracts/job-policy.js';
import type {
  DedicatedJobTarget,
  JobMember,
} from '../integration/e2e/internal/targets/job-types.js';
import { JOB_TARGET_PROFILES } from '../integration/e2e/internal/targets/job-profiles.js';

function environment(values: NodeJS.ProcessEnv = {}): Environment {
  return new Environment(values, new Redactor());
}

describe('dedicated Job member policies', () => {
  test('Azure GHCR retains the original probe inputs, disabled baseline and live cleanup budgets', () => {
    const member = { kind: 'ghcr-probe', target: 'azure' } as const;
    const profile = jobMemberProfile(member, environment());
    expect(profile).toMatchObject({
      vmTypes: ['Standard_NC4as_T4_v3'],
      computeRegion: 'westus2',
      image: 'ubuntu:24.04',
      diskSizeGb: 100,
      diskTier: 'high',
      spot: false,
      credentialMode: 'bootstrap',
      storageProvider: 'none',
      requiredExtensions: ['ghcr-probe'],
      expectedTerminalState: WorkloadState.Terminated,
      ghcr: {
        image:
          'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d',
        sampleBytes: 268435456,
        ladder: [1, 4, 8, 16],
        pullConcurrency: 3,
        pullChunkBytes: 134217728,
        measureBaseline: false,
        pullTimeoutMs: 1_200_000,
        pollMs: 15_000,
      },
    });
    expect(Object.isFrozen(profile.ghcr?.ladder)).toBe(true);
    expect(jobStageBudget(member, environment())).toEqual({
      runningMs: 1_800_000,
      cleanupMs: 2_700_000,
      completionMs: 2_700_000,
      storageMs: 3_600_000,
    });
    const pinned = jobMemberProfile(
      member,
      environment({
        PROBE_MEASURE_BASELINE: 'yes',
        PROBE_SPOT: 'true',
        PROBE_REGION: 'eastus',
        PROBE_VM_TYPE: 'Standard_NC8as_T4_v3',
        PROBE_DISK_SIZE: '200',
        PROBE_SAMPLE_BYTES: '1048576',
        PROBE_LADDER: '1 2 4',
        PROBE_PULL_CONCURRENCY: '4',
        PROBE_PULL_CHUNK_BYTES: '8388608',
      }),
    );
    expect(pinned).toMatchObject({
      vmTypes: ['Standard_NC8as_T4_v3'],
      computeRegion: 'eastus',
      storageProvider: 'azure',
      storageRegion: 'eastus',
      spot: true,
      diskSizeGb: 200,
      ghcr: {
        measureBaseline: true,
        pullTimeoutMs: 2_400_000,
        sampleBytes: 1048576,
        ladder: [1, 2, 4],
        pullConcurrency: 4,
        pullChunkBytes: 8388608,
      },
    });
    expect(
      jobStageBudget(member, environment({ PROBE_MEASURE_BASELINE: '1' }))
        .storageMs,
    ).toBe(5_400_000);
    for (const values of [
      { PROBE_IMAGE: 'mace:latest' },
      { PROBE_REGION: 'West US 2' },
      { PROBE_DISK_SIZE: '0' },
      { PROBE_DISK_TIER: 'low' },
      { PROBE_SPOT: '1' },
      { PROBE_SAMPLE_BYTES: '9007199254740992' },
      { PROBE_LADDER: '4 8' },
      { PROBE_LADDER: '1 0' },
      { PROBE_PULL_CONCURRENCY: '1000' },
      { PROBE_PULL_CHUNK_BYTES: 'NaN' },
      { PROBE_MEASURE_BASELINE: 'sometimes' },
      { PROBE_PULL_TIMEOUT_SECONDS: '-1' },
      { PROBE_PULL_POLL_SECONDS: '0' },
    ])
      expect(() => jobMemberProfile(member, environment(values))).toThrow();
  });

  test.each([
    ['aws', 'g6e.xlarge', undefined, 100, 'high'],
    ['azure', 'Standard_NC4as_T4_v3', undefined, 100, 'high'],
    ['gcp', 'g2-standard-4', 'us-east4', 100, 'medium'],
    ['lambda', 'gpu_1x_a10', undefined, undefined, undefined],
  ] as const)(
    '%s MACE preserves its pinned on-demand profile without acquiring storage',
    (target, vmType, region, diskSizeGb, diskTier) => {
      const member = { kind: 'mace-full-pull', target } as const;
      const profile = jobMemberProfile(member, environment());
      expect(profile).toMatchObject({
        vmTypes: [vmType],
        computeRegion: region,
        diskSizeGb,
        spot: false,
        storageProvider: 'none',
        credentialMode: 'bootstrap',
        crossCloudStorageCredential: undefined,
        recursiveTransfers: false,
        requiredExtensions: ['mace-full-pull'],
        expectedTerminalState: WorkloadState.Completed,
        mace: { observerTimeoutMs: 5_400_000, runLabel: '' },
      });
      expect(profile.diskTier).toBe(diskTier);
      expect(profile.image).toBe(
        'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d',
      );
      expect(Object.isFrozen(profile.mace)).toBe(true);
      expect(jobStageBudget(member, environment())).toEqual({
        runningMs: 5_400_000,
        completionMs: 5_400_000,
        cleanupMs: 2_700_000,
        storageMs: 60_000,
      });
    },
  );

  test('MACE keeps explicit placement, disk and observer inputs and rejects malformed or unsupported selections before allocation', () => {
    const member = { kind: 'mace-full-pull', target: 'aws' } as const;
    const profile = jobMemberProfile(
      member,
      environment({
        MACE_FULL_PULL_VM_TYPE: 'g6e.2xlarge',
        MACE_FULL_PULL_REGION: 'us-east-1',
        MACE_FULL_PULL_ZONE: 'a',
        MACE_FULL_PULL_DISK_SIZE: '200',
        MACE_FULL_PULL_DISK_TIER: 'ultra',
        MACE_FULL_PULL_OBSERVER_TIMEOUT_MS: '1200000',
        MACE_FULL_PULL_RUN_LABEL: 'candidate',
      }),
    );
    expect(profile).toMatchObject({
      vmTypes: ['g6e.2xlarge'],
      computeRegion: 'us-east-1',
      computeZone: 'a',
      diskSizeGb: 200,
      diskTier: 'ultra',
      mace: { observerTimeoutMs: 1_200_000, runLabel: 'candidate' },
    });
    for (const values of [
      { MACE_FULL_PULL_IMAGE: 'mace:latest' },
      { MACE_FULL_PULL_REGION: 'West US' },
      { MACE_FULL_PULL_ZONE: 'a' },
      { MACE_FULL_PULL_DISK_SIZE: '0' },
      { MACE_FULL_PULL_DISK_TIER: 'low' },
      { MACE_FULL_PULL_OBSERVER_TIMEOUT_MS: 'NaN' },
      { MACE_FULL_PULL_VM_TYPE: 'g6e.xlarge --spot' },
      { MACE_FULL_PULL_RUN_LABEL: 'long-label-too-long' },
    ])
      expect(() => jobMemberProfile(member, environment(values))).toThrow();
    const unsupported = { kind: 'mace-full-pull', target: 'local-smolvm' };
    expect(() =>
      jobMemberProfile(unsupported as JobMember, environment()),
    ).toThrow('Unknown dedicated Job member');
    expect(
      jobStageBudget(
        member,
        environment({ MACE_FULL_PULL_WAIT_SECONDS: '600' }),
      ).runningMs,
    ).toBe(600_000);
  });

  test('disk-tier retains seven ordered cases, omitted default tier, explicit placement and independent legacy budgets', () => {
    const member = { kind: 'disk-tier', target: 'gcp' } as const;
    const profile = jobMemberProfile(member, environment());
    expect(profile).toMatchObject({
      computeRegion: 'us-east4',
      computeZone: 'c',
      image: 'ubuntu:24.04',
      diskSizeGb: undefined,
      spot: false,
      credentialMode: 'bootstrap',
      requiredExtensions: ['disk-tier'],
      expectedTerminalState: WorkloadState.Terminated,
    });
    expect(profile.diskTierCases).toEqual([
      { key: 'u', vmType: 'e2-standard-2', expectedType: 'pd-ssd' },
      {
        key: 'hm',
        vmType: 'c4-standard-2',
        tier: 'medium',
        expectedType: 'hyperdisk-balanced',
      },
      {
        key: 'hh',
        vmType: 'c4-standard-2',
        tier: 'high',
        expectedType: 'hyperdisk-balanced',
        expectedIops: 8000,
      },
      {
        key: 'hx',
        vmType: 'c4-standard-2',
        tier: 'ultra',
        expectedType: 'hyperdisk-balanced',
        expectedIops: 16000,
      },
      {
        key: 'ho',
        vmType: 'c4-standard-2',
        diskIops: 3000,
        diskThroughputMibps: 750,
        expectedType: 'hyperdisk-balanced',
        expectedIops: 3000,
        expectedThroughputMibps: 750,
      },
      {
        key: 'pm',
        vmType: 'e2-standard-2',
        tier: 'medium',
        expectedType: 'pd-standard',
      },
      {
        key: 'px',
        vmType: 'e2-standard-2',
        tier: 'ultra',
        expectedType: 'pd-ssd',
      },
    ]);
    expect(Object.isFrozen(profile.diskTierCases)).toBe(true);
    expect(profile.diskTierCases?.every(Object.isFrozen)).toBe(true);
    expect(
      jobStageBudget(
        member,
        environment({ BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '1' }),
      ),
    ).toEqual({
      runningMs: 1_200_000,
      cleanupMs: 2_700_000,
      storageMs: 60_000,
      completionMs: 2_700_000,
    });
    expect(
      jobStageBudget(member, environment({ GCP_DISK_TIER_WAIT_SECONDS: '600' }))
        .runningMs,
    ).toBe(600_000);
  });

  test('disk-tier preserves its named legacy VM overrides and rejects invalid explicit placement', () => {
    const member = { kind: 'disk-tier', target: 'gcp' } as const;
    const legacy = jobMemberProfile(
      member,
      environment({
        GCP_DISK_TIER_VM_TYPE: 'c4-standard-4',
        GCP_DISK_TIER_LEGACY_VM_TYPE: 'e2-standard-4',
      }),
    );
    expect(legacy.vmTypes).toEqual(['e2-standard-4', 'c4-standard-4']);
    expect(
      jobMemberProfile(
        member,
        environment({
          GCP_DISK_TIER_VM_TYPE: 'c4-standard-4',
          GCP_DISK_TIER_HYPERDISK_VM_TYPE: 'c4-standard-8',
        }),
      ).diskTierCases?.[1].vmType,
    ).toBe('c4-standard-8');
    for (const values of [
      { GCP_DISK_TIER_REGION: 'foreign' },
      { GCP_DISK_TIER_ZONE: 'c d' },
      { GCP_DISK_TIER_HYPERDISK_VM_TYPE: 'c4-standard-2 c4-standard-4' },
    ])
      expect(() => jobMemberProfile(member, environment(values))).toThrow(
        'explicit VM types, region and zone',
      );
  });

  test.each([
    [
      'aws',
      ['reserved-bucket', 'unknown-vm'],
      ['t3.small', 'totally_fake_nonexistent_vm'],
      'us-east-1',
    ],
    [
      'gcp',
      ['reserved-bucket', 'unknown-vm'],
      ['n2-standard-2', 'totally_fake_nonexistent_vm'],
      'us-central1',
    ],
    [
      'azure',
      ['unknown-vm', 'cuda-runtime', 'docker-gpu'],
      [
        'totally_fake_nonexistent_vm',
        'Standard_ND96isr_MI300X_v5',
        'Standard_ND96isr_MI300X_v5',
      ],
      'eastus',
    ],
  ] as const)(
    'preserves all named %s admission cases and their independent deadlines',
    (target, kinds, types, unknownVmRegion) => {
      const member = { kind: 'invalid-admission', target } as const;
      const env = environment({
        BUCKET_SYNC_VM_TYPES: 'unrelated',
        BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '1',
      });
      const profile = jobMemberProfile(member, env);
      expect(profile.admissionCases?.map((item) => item.kind)).toEqual(kinds);
      expect(profile.vmTypes).toEqual(types);
      expect(
        profile.admissionCases?.find((item) => item.kind === 'unknown-vm')
          ?.region,
      ).toBe(unknownVmRegion);
      expect(profile).toMatchObject({
        credentialMode: 'bootstrap',
        spot: false,
        requiredExtensions: ['invalid-admission'],
        expectedTerminalState: WorkloadState.Invalid,
        crossCloudStorageCredential: undefined,
      });
      expect(jobStageBudget(member, env)).toEqual({
        runningMs: 120_000,
        cleanupMs: 300_000,
        storageMs: 60_000,
        completionMs: 120_000,
      });
      expect(Object.isFrozen(profile.admissionCases)).toBe(true);
      for (const item of profile.admissionCases ?? []) {
        expect(Object.isFrozen(item)).toBe(true);
        expect(Object.isFrozen(item.expectedMessages)).toBe(true);
      }
    },
  );

  test('keeps the Azure image guard distinct from the submit-time Docker GPU rejection', () => {
    const profile = jobMemberProfile(
      { kind: 'invalid-admission', target: 'azure' },
      environment(),
    );
    expect(profile.admissionCases?.[1]).toMatchObject({
      kind: 'cuda-runtime',
      outcome: 'invalid',
      region: 'eastus2',
      image:
        'mirror.gcr.io/nvidia/cuda@sha256:8767a245ed2c481eb245d8f6c625accc3788e1fb8612403d6b4cd4645a4f09c7',
    });
    expect(profile.admissionCases?.[1].dockerOptions).toBeUndefined();
    expect(profile.admissionCases?.[2]).toMatchObject({
      kind: 'docker-gpu',
      outcome: 'rejected',
      image: 'nginx:alpine',
      dockerOptions: { gpus: 'all' },
    });
    expect(Object.isFrozen(profile.admissionCases?.[2].dockerOptions)).toBe(
      true,
    );
    expect(() =>
      jobMemberProfile(
        { kind: 'invalid-admission', target: 'azure' },
        environment({ AZURE_AMD_CUDA_IMAGE: 'nvidia/cuda:latest' }),
      ),
    ).toThrow('pinned profile');
  });

  test('preserves reserved bucket prefixes', () => {
    expect(
      jobMemberProfile(
        { kind: 'invalid-admission', target: 'aws' },
        environment(),
      ).admissionCases?.[0].bucketPrefix,
    ).toBe('sthree-reserved-test-');
    expect(
      jobMemberProfile(
        { kind: 'invalid-admission', target: 'gcp' },
        environment(),
      ).admissionCases?.[0].bucketPrefix,
    ).toBe('goog-reserved-test-');
    for (const target of ['lambda', 'local-smolvm']) {
      const invalidMember = { kind: 'invalid-admission', target };
      expect(() =>
        jobMemberProfile(invalidMember as JobMember, environment()),
      ).toThrow('Unknown dedicated Job member');
    }
  });

  test('runtime secrets retain the legacy two-Job t3.small profile and independent 900-second Running budget', () => {
    const member = { kind: 'runtime-secrets', target: 'aws' } as const;
    const env = environment({
      BUCKET_SYNC_VM_TYPES: 't3.nano',
      BUCKET_SYNC_COMPUTE_REGION: 'wrong-region',
      BUCKET_SYNC_DISK_SIZE_GB: '1',
      BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '1',
    });
    expect(jobMemberProfile(member, env)).toMatchObject({
      vmTypes: ['t3.small'],
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: false,
      image: 'nginx:alpine',
      credentialMode: 'bootstrap',
      requiredExtensions: ['runtime-secrets'],
      expectedTerminalState: WorkloadState.Terminated,
    });
    expect(jobStageBudget(member, env).runningMs).toBe(900_000);
    // Lambda's storage is another cloud's, and these Jobs use no bucket.
    expect(
      jobMemberProfile({ kind: 'runtime-secrets', target: 'lambda' }, env),
    ).toMatchObject({
      vmTypes: ['cpu_4x_general', 'gpu_1x_a10'],
      storageProvider: 'none',
      storageFollowsCompute: false,
    });
    const invalid: unknown = {
      kind: 'runtime-secrets',
      target: 'local-smolvm',
    };
    expect(() => jobMemberProfile(invalid as JobMember, env)).toThrow(
      'Unknown dedicated Job member',
    );
  });

  test('Spot cleanup retains its fixed persistent t3.large profile and independent production budgets', () => {
    const member = { kind: 'spot-request-cleanup', target: 'aws' } as const;
    const env = environment({
      BUCKET_SYNC_COMPUTE_REGION: 'wrong-region',
      BUCKET_SYNC_DISK_SIZE_GB: '1',
      BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '1',
      BUCKET_SYNC_CLEANUP_TIMEOUT_SECONDS: '1',
    });
    expect(jobMemberProfile(member, env)).toMatchObject({
      vmTypes: ['t3.large'],
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: true,
      image: 'nginx:alpine',
      credentialMode: 'bootstrap',
      requiredExtensions: ['spot-request-cleanup'],
      expectedTerminalState: WorkloadState.Terminated,
    });
    expect(jobStageBudget(member, env)).toEqual({
      runningMs: 1_200_000,
      cleanupMs: 600_000,
      storageMs: 120_000,
      completionMs: 600_000,
    });
    const invalid: unknown = { kind: 'spot-request-cleanup', target: 'azure' };
    expect(() => jobMemberProfile(invalid as JobMember, env)).toThrow(
      'Unknown dedicated Job member',
    );
  });
  test('restricted credential fixes the pilot credential, its regions and the three RFC 0047 cases', () => {
    const member = { kind: 'restricted-credential', target: 'aws' } as const;
    const env = environment({ BUCKET_SYNC_COMPUTE_REGION: 'ap-south-1' });
    expect(jobMemberProfile(member, env)).toMatchObject({
      vmTypes: ['t3.small', 'c6i.xlarge'],
      computeRegion: undefined,
      spot: false,
      credentialMode: 'aws-restricted',
      storageProvider: 'aws',
      storageRegion: 'us-east-1',
      restrictedCredential: {
        regions: ['us-east-1', 'us-east-2', 'us-west-2'],
        cases: [
          {
            key: 'pinned',
            scenario: 'S1',
            vmType: 't3.small',
            region: 'us-east-1',
          },
          { key: 'unpinned', scenario: 'S2', vmType: 'c6i.xlarge' },
          {
            key: 'output',
            scenario: 'S3',
            vmType: 't3.small',
            region: 'us-east-1',
          },
        ],
      },
      requiredExtensions: ['restricted-credential'],
      expectedTerminalState: WorkloadState.Completed,
    });
    const invalid: unknown = { kind: 'restricted-credential', target: 'gcp' };
    expect(() => jobMemberProfile(invalid as JobMember, env)).toThrow(
      'Unknown dedicated Job member',
    );
  });
  test('restricted credential leaves the Azure cases unpinned, so placement can fail over', () => {
    const member = { kind: 'restricted-credential', target: 'azure' } as const;
    const profile = jobMemberProfile(member, environment());
    expect(profile.credentialMode).toBe('azure-restricted');
    expect(profile.restrictedCredential?.regions).toBeUndefined();
    expect(
      profile.restrictedCredential?.cases.map(({ key, region }) => [
        key,
        region,
      ]),
    ).toEqual([
      ['unpinned', undefined],
      ['output', undefined],
    ]);
  });
  test.each([
    ['aws', 't3.large'],
    ['azure', 'Standard_D2s_v5'],
    ['gcp', 'e2-standard-2'],
  ] as const)(
    'keeps the %s spot-eviction profile unpinned, spot and Completed',
    (target, vmType) => {
      const member = { kind: 'spot-eviction', target } as const;
      const env = environment({ BUCKET_SYNC_COMPUTE_REGION: 'wrong-region' });
      expect(jobMemberProfile(member, env)).toMatchObject({
        vmTypes: [vmType],
        computeRegion: undefined,
        diskSizeGb: 100,
        spot: true,
        requiredExtensions: ['spot-eviction'],
        expectedTerminalState: WorkloadState.Completed,
      });
      const invalid: unknown = { kind: 'spot-eviction', target: 'lambda' };
      expect(() => jobMemberProfile(invalid as JobMember, env)).toThrow(
        'Unknown dedicated Job member',
      );
    },
  );
  test('keeps the Azure GPU spot-eviction profile unpinned on the MACE image', () => {
    const member = { kind: 'gpu-spot-eviction', target: 'azure' } as const;
    expect(jobMemberProfile(member, environment({}))).toMatchObject({
      vmTypes: ['Standard_NC4as_T4_v3'],
      computeRegion: undefined,
      spot: true,
      image: expect.stringMatching(/^ghcr\.io\/anycloud-sh\/mace@sha256:/u),
      requiredExtensions: ['gpu-spot-eviction'],
      expectedTerminalState: WorkloadState.Completed,
    });
  });
  test('keeps the real hydration profile and production deadlines independent of bucket tuning', () => {
    const member = { kind: 'input-hydration-recovery', target: 'aws' } as const;
    const env = environment({
      AWS_STORAGE_REGION: 'us-west-2',
      BUCKET_SYNC_VM_TYPES: 't3.nano',
      BUCKET_SYNC_COMPUTE_REGION: 'us-east-1',
      BUCKET_SYNC_DISK_SIZE_GB: '1',
      BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '1',
      BUCKET_SYNC_CLEANUP_TIMEOUT_SECONDS: '1',
    });
    expect(jobMemberProfile(member, env)).toMatchObject({
      vmTypes: ['t3.large'],
      computeRegion: 'us-west-2',
      storageRegion: 'us-west-2',
      diskSizeGb: 350,
      diskTier: 'medium',
      spot: false,
      image: 'alpine:3.20',
      credentialMode: 'aws-import',
      requiredExtensions: ['input-hydration-recovery'],
      expectedTerminalState: WorkloadState.Completed,
    });
    expect(jobStageBudget(member, env)).toEqual({
      runningMs: 1_200_000,
      cleanupMs: 2_700_000,
      storageMs: 1_200_000,
      completionMs: 3_600_000,
    });
  });

  test.each([
    ['aws', 't3.large', false],
    ['azure', 'Standard_D2s_v5', true],
    ['gcp', 'e2-standard-2', false],
  ] as const)(
    'preserves %s host-loss capabilities and production budgets independently of bucket tuning',
    (target, vmType, explicitCheckpoint) => {
      const member = { kind: 'host-recovery', target } as const;
      const env = environment({
        BUCKET_SYNC_COMPUTE_REGION: 'wrong-region',
        BUCKET_SYNC_DISK_SIZE_GB: '1',
        BUCKET_SYNC_CLEANUP_TIMEOUT_SECONDS: '1',
        BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '1',
        AZURE_STORAGE_REGION: 'wrong-storage-region',
      });
      expect(jobMemberProfile(member, env)).toMatchObject({
        vmTypes: [vmType],
        computeRegion: undefined,
        diskSizeGb: undefined,
        spot: false,
        image: 'nginx:alpine',
        credentialMode: 'bootstrap',
        explicitCheckpoint,
        requiredExtensions: ['host-recovery'],
        expectedTerminalState: WorkloadState.Terminated,
      });
      if (explicitCheckpoint)
        expect(jobMemberProfile(member, env).storageRegion).toBe('eastus');
      expect(jobStageBudget(member, env)).toEqual({
        runningMs: 900_000,
        cleanupMs: 2_700_000,
        storageMs: 180_000,
        completionMs: 1_200_000,
      });
    },
  );

  test.each([
    ['aws', 'matched-attempts'],
    ['azure', undefined],
    ['gcp', undefined],
    ['lambda', undefined],
  ] as const)(
    '%s exposes only its registered reservation inventory capability',
    (target, capability) => {
      expect(
        jobMemberProfile({ kind: 'bucket-sync', target }, environment())
          .reservationInventory,
      ).toBe(capability);
    },
  );

  test.each([
    ['aws', undefined],
    ['azure', undefined],
    ['gcp', undefined],
    ['lambda', true],
  ] as const)(
    '%s bucket-sync passes an explicit checkpoint only when it is not Spot',
    (target, explicitCheckpoint) => {
      expect(
        jobMemberProfile({ kind: 'bucket-sync', target }, environment())
          .explicitCheckpoint,
      ).toBe(explicitCheckpoint);
    },
  );

  test('declares an exhaustive capability class for all six Job targets', () => {
    const expected = {
      aws: 'object-storage',
      azure: 'object-storage',
      gcp: 'object-storage',
      lambda: 'object-storage',
      'local-smolvm': 'local-storage',
    } satisfies Record<DedicatedJobTarget, 'object-storage' | 'local-storage'>;
    expect(
      Object.fromEntries(
        Object.entries(JOB_TARGET_PROFILES).map(([target, profile]) => [
          target,
          profile.kind,
        ]),
      ),
    ).toEqual(expected);
  });

  test.each([
    ['aws', ['t3.large', 't3.xlarge'], 'aws-import', 'us-east-1'],
    [
      'azure',
      ['Standard_D2s_v5', 'Standard_D4s_v5'],
      'azure-generate',
      'eastus',
    ],
    ['gcp', ['e2-standard-2', 'e2-standard-4'], 'gcp-import', 'us-central1'],
  ] as const)(
    'preserves %s bucket optimizer ordering, imported credential boundary and recovery requirements',
    (target, orderedTypes, credentialMode, storageRegion) => {
      const profile = jobMemberProfile(
        { kind: 'bucket-sync', target },
        environment({
          VM_SMOKE_REGION: 'wrong-smoke-region',
          VM_SMOKE_DISK_SIZE_GB: 'invalid',
          SERVE_SMOKE_REGION: 'wrong-service-region',
          SERVE_SMOKE_DISK_SIZE_GB: '1',
        }),
      );
      expect(profile.vmTypes).toEqual([
        'totally_fake_nonexistent_vm',
        ...orderedTypes,
      ]);
      expect(profile.computeRegion).toBeUndefined();
      expect(profile.diskSizeGb).toBe(100);
      expect(profile.spot).toBe(true);
      expect(profile.credentialMode).toBe(credentialMode);
      expect(profile.storageProvider).toBe(target);
      expect(profile.storageRegion).toBe(storageRegion);
      expect(profile.recursiveTransfers).toBe(true);
      expect(profile.requiredExtensions).toEqual([
        'bucket-storage',
        'in-place-recovery',
      ]);
      expect(profile.expectedTerminalState).toBe(WorkloadState.Completed);
      expect(profile.image).toBe(
        'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d',
      );
    },
  );

  test('keeps Lambda capacity alternatives and explicit cross-cloud input/output storage', () => {
    const profile = jobMemberProfile(
      { kind: 'bucket-sync', target: 'lambda' },
      environment({ AWS_STORAGE_REGION: 'must-not-change-lambda' }),
    );
    expect(profile.vmTypes).toEqual([
      'totally_fake_nonexistent_vm',
      'cpu_4x_general',
      'gpu_1x_a10',
      'gpu_1x_a100_sxm4',
    ]);
    expect(profile.computeRegion).toBeUndefined();
    expect(profile.spot).toBe(false);
    expect(profile.storageProvider).toBe('aws');
    expect(profile.crossCloudStorageCredential).toBe('aws-storage');
    expect(profile.storageRegion).toBe('us-east-1');
    expect(profile.requiredExtensions).toEqual(['bucket-storage']);
    expect(profile.recursiveTransfers).toBe(false);
  });

  test.each([
    ['aws', ['t3.large'], ['us-east-2', 'us-west-2']],
    ['azure', ['Standard_D2s_v3'], ['eastus2', 'westus2']],
    // The refused head type fails over.
    ['gcp', ['a2-highgpu-1g', 'e2-standard-2'], ['us-east1', 'us-west1']],
  ] as const)(
    'keeps %s concurrent output separate from the Spot bucket profile',
    (target, vmTypes, regions) => {
      const profile = jobMemberProfile(
        { kind: 'concurrent-output', target },
        environment({
          BUCKET_SYNC_DISK_SIZE_GB: '200',
          BUCKET_SYNC_COMPUTE_REGION: 'bucket-only',
        }),
      );
      expect(profile.vmTypes).toEqual(vmTypes);
      expect(profile.diskSizeGb).toBe(100);
      expect(profile.computeRegion).toBeUndefined();
      expect(profile.computeRegions).toEqual(regions);
      expect(profile.launchFailover).toBe(target === 'gcp' || undefined);
      expect(profile.spot).toBe(false);
      expect(profile.image).toBe('nginx:alpine');
      expect(profile.requiredExtensions).toEqual(['concurrent-output']);
      expect(profile.credentialMode).toBe('bootstrap');
      expect(profile.expectedTerminalState).toBe(WorkloadState.Terminated);
    },
  );

  test('keeps local storage/configuration, natural completion and same-ID resubmission distinct', () => {
    const local = (
      kind: 'local-held' | 'local-completed' | 'local-resubmitted',
    ) =>
      jobMemberProfile(
        { kind, target: 'local-smolvm' },
        environment({
          BUCKET_SYNC_DISK_SIZE_GB: 'invalid',
        }),
      );
    const held = local('local-held');
    expect(held.computeProvider).toBe(CloudType.Local);
    expect(held.vmTypes).toEqual([]);
    expect(held.computeRegion).toBeUndefined();
    expect(held.credentialMode).toBe('credentialless');
    expect(held.image).toBe('busybox:1.36');
    expect(held.diskSizeGb).toBeUndefined();
    expect(held.requiredExtensions).toEqual([
      'local-storage',
      'local-configuration',
    ]);
    expect(local('local-completed').expectedTerminalState).toBe(
      WorkloadState.Completed,
    );
    expect(local('local-resubmitted').requiredExtensions).toEqual([
      'same-id-resubmission',
    ]);
    expect(local('local-resubmitted').expectedTerminalState).toBe(
      WorkloadState.Errored,
    );
  });

  test('freezes a copied member and its authority-bearing arrays before submission', () => {
    const member = { kind: 'bucket-sync', target: 'aws' } as const;
    const profile = jobMemberProfile(member, environment());
    expect(profile.member).not.toBe(member);
    for (const value of [
      profile,
      profile.member,
      profile.vmTypes,
      profile.requiredExtensions,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test.each([
    { kind: 'bucket-sync', target: 'kubernetes' },
    { kind: 'concurrent-output', target: 'lambda' },
    { kind: 'local-held', target: 'aws' },
    { kind: 'bucket-sync', target: 'aws', vmTypes: ['different'] },
  ])('rejects unsupported membership or override inputs %#', (value) => {
    expect(() => jobMemberProfile(value as JobMember, environment())).toThrow(
      'Unknown dedicated Job member',
    );
  });

  test.each([
    { kind: 'bucket-sync', target: { toString: (): string => 'aws' } },
    { kind: { toString: (): string => 'local-held' }, target: 'local-smolvm' },
  ])('rejects coercible authority inputs %#', (value) => {
    expect(() =>
      jobMemberProfile(value as unknown as JobMember, environment()),
    ).toThrow('Unknown dedicated Job member');
    expect(() =>
      jobStageBudget(value as unknown as JobMember, environment()),
    ).toThrow('Unknown dedicated Job member');
  });

  test('captures a member getter once before selecting its policy', () => {
    let reads = 0;
    const value = {
      kind: 'bucket-sync' as const,
      get target() {
        reads += 1;
        return reads === 1 ? ('aws' as const) : ('gcp' as const);
      },
    };
    const profile = jobMemberProfile(value, environment());
    expect(reads).toBe(1);
    expect(profile.member).toEqual({ kind: 'bucket-sync', target: 'aws' });
    expect(profile.spot).toBe(true);
    expect(profile.requiredExtensions).toEqual([
      'bucket-storage',
      'in-place-recovery',
    ]);
  });

  test.each(['aws', 'azure', 'gcp'] as const)(
    'retains the separate %s concurrent output running budget',
    (target) => {
      const budgets = jobStageBudget(
        { kind: 'concurrent-output', target },
        environment({ BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '31' }),
      );
      expect(budgets.runningMs).toBe(1_800_000);
    },
  );

  test('retains the bounded legacy cloud budgets without applying them to Local', () => {
    const env = environment({
      BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS: '31',
      BUCKET_SYNC_CLEANUP_TIMEOUT_SECONDS: '41',
    });
    const cloud = jobStageBudget({ kind: 'bucket-sync', target: 'aws' }, env);
    expect(cloud.runningMs).toBe(31_000);
    expect(cloud.cleanupMs).toBe(41_000);
    const local = jobStageBudget(
      { kind: 'local-held', target: 'local-smolvm' },
      env,
    );
    expect(local.runningMs).toBe(300_000);
    expect(local.cleanupMs).toBe(300_000);
  });
});
