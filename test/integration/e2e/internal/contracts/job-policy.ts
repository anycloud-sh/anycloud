import { WorkloadState } from '../../../../../src/shared/workload.js';

import type { Environment } from '../environment.js';
import { isRecord } from '../types.js';
import { JOB_TARGET_PROFILES } from '../targets/job-profiles.js';
import { HOST_DOCKER_IMAGE } from '../targets/host-docker-probe.js';
import type {
  JobExtension,
  JobAdmissionCase,
  JobDiskTierCase,
  JobMember,
  JobMemberProfile,
  JobStageBudget,
} from '../targets/job-types.js';

/** A Debian image with python3, for small check Jobs. */
export const CHECK_IMAGE =
  'mirror.gcr.io/library/python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f';

const BUCKET_IMAGE =
  'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d';
export const FAKE_VM_TYPE = 'totally_fake_nonexistent_vm';
type JobEnvironment = Pick<Environment, 'optional' | 'milliseconds'>;

/** Every registered dedicated Job member: its kind and the targets it runs on. */
export const JOB_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'invalid-admission': ['aws', 'azure', 'gcp'],
  'bucket-sync': ['aws', 'azure', 'gcp', 'lambda'],
  'concurrent-output': ['aws', 'azure', 'gcp'],
  'host-recovery': ['aws', 'azure', 'gcp'],
  'input-hydration-recovery': ['aws'],
  'spot-request-cleanup': ['aws'],
  'spot-eviction': ['aws', 'azure', 'gcp'],
  'gpu-spot-eviction': ['azure'],
  'gpu-probe-rerun': ['aws', 'azure', 'gcp', 'lambda'],
  'gpu-health-fault': ['aws', 'azure', 'gcp', 'lambda'],
  'runtime-secrets': ['aws', 'azure', 'gcp', 'lambda'],
  // RFC 0047: the GCP (S8) member joins with its own restricted
  // identity; a Lambda API key has no permission model.
  'restricted-credential': ['aws', 'azure'],
  'disk-tier': ['gcp'],
  'host-docker': ['aws', 'azure', 'gcp'],
  'ghcr-probe': ['azure'],
  'mace-full-pull': ['aws', 'azure', 'gcp', 'lambda'],
  'local-held': ['local-smolvm'],
  'local-completed': ['local-smolvm'],
  'local-resubmitted': ['local-smolvm'],
};

function capturedMember(input: JobMember): JobMember {
  const candidate: unknown = input;
  if (
    !isRecord(candidate) ||
    Object.keys(candidate).sort().join(',') !== 'kind,target'
  )
    throw new Error(
      'Unknown dedicated Job member or unsupported member inputs',
    );
  const kind = candidate.kind;
  const target = candidate.target;
  if (
    typeof kind !== 'string' ||
    typeof target !== 'string' ||
    !Object.hasOwn(JOB_MEMBERS, kind) ||
    !JOB_MEMBERS[kind].includes(target)
  )
    throw new Error(
      'Unknown dedicated Job member or unsupported member inputs',
    );
  return Object.freeze({ kind, target }) as JobMember;
}

function positiveInteger(value: string, name: string): number {
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function freezeProfile(profile: JobMemberProfile): JobMemberProfile {
  return Object.freeze({
    ...profile,
    member: Object.freeze({ ...profile.member }),
    vmTypes: Object.freeze([...profile.vmTypes]),
    ...(profile.computeRegions && {
      computeRegions: Object.freeze([...profile.computeRegions]),
    }),
    requiredExtensions: Object.freeze([...profile.requiredExtensions]),
    ...(profile.ghcr
      ? {
          ghcr: Object.freeze({
            ...profile.ghcr,
            ladder: Object.freeze([...profile.ghcr.ladder]),
          }),
        }
      : {}),
    ...(profile.mace ? { mace: Object.freeze({ ...profile.mace }) } : {}),
    ...(profile.restrictedCredential
      ? {
          restrictedCredential: Object.freeze({
            ...(profile.restrictedCredential.regions && {
              regions: Object.freeze([...profile.restrictedCredential.regions]),
            }),
            cases: Object.freeze(
              profile.restrictedCredential.cases.map((restrictedCase) =>
                Object.freeze({ ...restrictedCase }),
              ),
            ),
          }),
        }
      : {}),
    ...(profile.diskTierCases
      ? {
          diskTierCases: Object.freeze(
            profile.diskTierCases.map((diskCase) =>
              Object.freeze({ ...diskCase }),
            ),
          ),
        }
      : {}),
    ...(profile.admissionCases
      ? {
          admissionCases: Object.freeze(
            profile.admissionCases.map((admissionCase) =>
              Object.freeze({
                ...admissionCase,
                ...(admissionCase.dockerOptions
                  ? {
                      dockerOptions: Object.freeze({
                        ...admissionCase.dockerOptions,
                      }),
                    }
                  : {}),
                expectedMessages: Object.freeze([
                  ...admissionCase.expectedMessages,
                ]),
              }),
            ),
          ),
        }
      : {}),
  });
}

/** Resolve fixed placement separately from storage/recovery capabilities. */
export function jobMemberProfile(
  input: JobMember,
  environment: JobEnvironment,
): JobMemberProfile {
  const member = capturedMember(input);
  const registration = JOB_TARGET_PROFILES[member.target];
  if (registration.kind === 'local-storage') {
    const requiredExtensions: JobExtension[] =
      member.kind === 'local-held'
        ? ['local-storage', 'local-configuration']
        : member.kind === 'local-resubmitted'
          ? ['same-id-resubmission']
          : [];
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [],
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: false,
      image: 'busybox:1.36',
      credentialMode: 'credentialless',
      storageProvider: 'local',
      storageRegion: 'local',
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions,
      expectedTerminalState:
        member.kind === 'local-held'
          ? WorkloadState.Terminated
          : member.kind === 'local-completed'
            ? WorkloadState.Completed
            : WorkloadState.Errored,
    });
  }
  const configured = (value: {
    readonly fallback: string;
    readonly variable?: string;
  }): string =>
    value.variable
      ? environment.optional(value.variable, value.fallback) || value.fallback
      : value.fallback;
  if (member.kind === 'ghcr-probe') {
    const capability = registration.ghcrProbe;
    if (!capability) throw new Error('Job target lacks GHCR probe coverage');
    const image = configured({
      variable: 'PROBE_IMAGE',
      fallback: BUCKET_IMAGE,
    });
    const vmType = configured({
      variable: 'PROBE_VM_TYPE',
      fallback: capability.vmType,
    });
    const region = configured({
      variable: 'PROBE_REGION',
      fallback: capability.region,
    });
    const tier = configured({ variable: 'PROBE_DISK_TIER', fallback: 'high' });
    const spot = configured({ variable: 'PROBE_SPOT', fallback: 'false' });
    const baseline = environment.optional('PROBE_MEASURE_BASELINE', '0');
    const ladder = configured({
      variable: 'PROBE_LADDER',
      fallback: '1 4 8 16',
    });
    if (
      !/^ghcr\.io\/[a-z0-9._/-]+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/u.test(
        image,
      ) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(vmType) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(region) ||
      !['medium', 'high', 'ultra'].includes(tier) ||
      !['true', 'false'].includes(spot) ||
      !['', '0', 'false', 'no', '1', 'true', 'yes'].includes(baseline) ||
      !/^[0-9]+(?:\s+[0-9]+)*$/u.test(ladder)
    )
      throw new Error(
        'GHCR probe requires its pinned image and valid explicit profile',
      );
    const rungs = ladder
      .split(/\s+/u)
      .map((value) => positiveInteger(value, 'GHCR ladder rung'));
    if (!rungs.includes(1))
      throw new Error('GHCR ladder requires its single-stream rung');
    const measureBaseline = ['1', 'true', 'yes'].includes(baseline);
    const number = (
      variable: string,
      fallback: string,
      maxDigits: number,
    ): number => {
      const value = configured({ variable, fallback });
      if (!new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`, 'u').test(value))
        throw new Error(`${variable} must be a bounded positive integer`);
      return positiveInteger(value, variable);
    };
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [vmType],
      computeRegion: region,
      diskSizeGb: number('PROBE_DISK_SIZE', '100', 9),
      diskTier: tier as JobMemberProfile['diskTier'],
      spot: spot === 'true',
      image: 'ubuntu:24.04',
      credentialMode: 'bootstrap',
      storageProvider: spot === 'true' ? registration.storage.provider : 'none',
      storageRegion: region,
      storageFollowsCompute: true,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      ghcr: {
        image,
        sampleBytes: number('PROBE_SAMPLE_BYTES', '268435456', 13),
        ladder: rungs,
        pullConcurrency: number('PROBE_PULL_CONCURRENCY', '3', 3),
        pullChunkBytes: number('PROBE_PULL_CHUNK_BYTES', '134217728', 13),
        measureBaseline,
        pullTimeoutMs:
          number(
            'PROBE_PULL_TIMEOUT_SECONDS',
            measureBaseline ? '2400' : '1200',
            5,
          ) * 1000,
        pollMs: number('PROBE_PULL_POLL_SECONDS', '15', 3) * 1000,
      },
      requiredExtensions: ['ghcr-probe'],
      expectedTerminalState: WorkloadState.Terminated,
    });
  }
  if (member.kind === 'gpu-probe-rerun') {
    const capability = registration.gpuProbeRerun;
    if (!capability)
      throw new Error('Job target lacks GPU probe rerun coverage');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [capability.vmType],
      computeRegion: capability.region,
      computeRegions: capability.regions,
      diskSizeGb: undefined,
      spot: false,
      image: CHECK_IMAGE,
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: 'none',
      storageRegion: '',
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['gpu-probe-rerun'],
      expectedTerminalState: WorkloadState.Errored,
    });
  }
  if (member.kind === 'gpu-health-fault') {
    const capability = registration.gpuHealthFault;
    if (!capability)
      throw new Error('Job target lacks GPU health fault coverage');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [capability.vmType],
      computeRegion: capability.region,
      computeRegions: capability.regions,
      diskSizeGb: undefined,
      spot: false,
      image: CHECK_IMAGE,
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: 'none',
      storageRegion: '',
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['gpu-health-fault'],
      expectedTerminalState: WorkloadState.Terminated,
    });
  }
  if (member.kind === 'mace-full-pull') {
    const capability = registration.maceFullPull;
    if (!capability)
      throw new Error('Job target lacks MACE full-pull coverage');
    const vmType = configured({
      variable: 'MACE_FULL_PULL_VM_TYPE',
      fallback: capability.vmType,
    });
    const region = configured({
      variable: 'MACE_FULL_PULL_REGION',
      fallback: capability.region ?? '',
    });
    const zone = environment.optional('MACE_FULL_PULL_ZONE');
    const image = configured({
      variable: 'MACE_FULL_PULL_IMAGE',
      fallback: BUCKET_IMAGE,
    });
    const disk = configured({
      variable: 'MACE_FULL_PULL_DISK_SIZE',
      fallback: capability.diskSizeGb?.toString() ?? '',
    });
    const tier = configured({
      variable: 'MACE_FULL_PULL_DISK_TIER',
      fallback: capability.diskTier ?? '',
    });
    const runLabel = environment.optional('MACE_FULL_PULL_RUN_LABEL');
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(vmType) ||
      (region && !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(region)) ||
      (zone && (!region || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(zone))) ||
      !/^[^\s]+@sha256:[a-f0-9]{64}$/u.test(image) ||
      !['', 'medium', 'high', 'ultra'].includes(tier) ||
      (runLabel && !/^[a-z0-9][a-z0-9-]{0,8}$/u.test(runLabel))
    )
      throw new Error(
        'MACE full-pull requires a pinned image and its valid explicit profile',
      );
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [vmType],
      computeRegion: region || undefined,
      ...(zone ? { computeZone: zone } : {}),
      diskSizeGb: disk ? positiveInteger(disk, 'MACE disk size') : undefined,
      ...(tier ? { diskTier: tier as JobMemberProfile['diskTier'] } : {}),
      spot: false,
      image,
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: 'none',
      storageRegion: '',
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      mace: {
        observerTimeoutMs: positiveInteger(
          environment.optional(
            'MACE_FULL_PULL_OBSERVER_TIMEOUT_MS',
            '5400000',
          ) || '5400000',
          'MACE observer timeout',
        ),
        runLabel,
      },
      requiredExtensions: ['mace-full-pull'],
      expectedTerminalState: WorkloadState.Completed,
    });
  }
  if (member.kind === 'disk-tier') {
    const capability = registration.diskTier;
    if (!capability) throw new Error('Job target lacks disk-tier coverage');
    const hyperdisk = configured({
      ...capability.hyperdiskVmType,
      fallback:
        environment.optional(
          'GCP_DISK_TIER_VM_TYPE',
          capability.hyperdiskVmType.fallback,
        ) || capability.hyperdiskVmType.fallback,
    });
    const persistent = configured({
      ...capability.persistentVmType,
      fallback:
        environment.optional(
          'GCP_DISK_TIER_LEGACY_VM_TYPE',
          capability.persistentVmType.fallback,
        ) || capability.persistentVmType.fallback,
    });
    const region = configured(capability.region);
    const zone = configured(capability.zone);
    if (
      ![hyperdisk, persistent].every((value) =>
        /^[a-z][a-z0-9-]+$/u.test(value),
      ) ||
      !/^[a-z]+-[a-z]+[1-9][0-9]*$/u.test(region) ||
      !/^[a-z]$/u.test(zone)
    )
      throw new Error(
        'Disk-tier Job requires its explicit VM types, region and zone',
      );
    const cases: JobDiskTierCase[] = [
      { key: 'u', vmType: persistent, expectedType: 'pd-ssd' },
      {
        key: 'hm',
        vmType: hyperdisk,
        tier: 'medium',
        expectedType: 'hyperdisk-balanced',
      },
      {
        key: 'hh',
        vmType: hyperdisk,
        tier: 'high',
        expectedType: 'hyperdisk-balanced',
        expectedIops: 8_000,
      },
      {
        key: 'hx',
        vmType: hyperdisk,
        tier: 'ultra',
        expectedType: 'hyperdisk-balanced',
        expectedIops: 16_000,
      },
      {
        key: 'pm',
        vmType: persistent,
        tier: 'medium',
        expectedType: 'pd-standard',
      },
      { key: 'px', vmType: persistent, tier: 'ultra', expectedType: 'pd-ssd' },
    ];
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [...new Set(cases.map((diskCase) => diskCase.vmType))],
      computeRegion: region,
      computeZone: zone,
      diskSizeGb: undefined,
      spot: false,
      image: 'ubuntu:24.04',
      credentialMode: 'bootstrap',
      storageProvider: registration.storage.provider,
      storageRegion: region,
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['disk-tier'],
      diskTierCases: cases,
      expectedTerminalState: WorkloadState.Terminated,
    });
  }
  if (member.kind === 'invalid-admission') {
    const capability = registration.invalidAdmission;
    if (!capability)
      throw new Error('Job target lacks invalid-admission coverage');
    const cases: JobAdmissionCase[] = [];
    if (capability.reservedBucket)
      cases.push({
        kind: 'reserved-bucket',
        outcome: 'rejected',
        vmType: capability.reservedBucket.vmType,
        bucketPrefix: capability.reservedBucket.prefix,
        image: 'nginx:alpine',
        expectedMessages: [
          'Input bucket "{bucket}" not found',
          'Invalid bucket name',
        ],
      });
    if (capability.unknownVmRegion)
      cases.push({
        kind: 'unknown-vm',
        outcome: 'rejected',
        vmType: FAKE_VM_TYPE,
        region: capability.unknownVmRegion,
        image: 'nginx:alpine',
        expectedMessages: ['is not available', 'is not offered'].map(
          (message) =>
            `VM type "${FAKE_VM_TYPE}" ${message} on ${registration.provider}`,
        ),
      });
    if (capability.cudaRuntime) {
      const vmType = configured(capability.cudaRuntime.vmType);
      const region = configured(capability.cudaRuntime.region);
      const image = configured(capability.cudaRuntime.image);
      if (
        !vmType.trim() ||
        !region.trim() ||
        !/^\S+@sha256:[a-f0-9]{64}$/u.test(image)
      )
        throw new Error('CUDA runtime admission requires its pinned profile');
      cases.push(
        {
          kind: 'cuda-runtime',
          outcome: 'invalid',
          vmType,
          region,
          image,
          expectedMessages: [
            `Image requires a CUDA GPU runtime but no compatible accelerator is available for VM type "${vmType}" on ${registration.provider}`,
          ],
        },
        {
          kind: 'docker-gpu',
          outcome: 'rejected',
          vmType,
          region,
          image: 'nginx:alpine',
          dockerOptions: { gpus: 'all' },
          expectedMessages: [`require an NVIDIA CUDA VM`],
        },
      );
    }
    if (!cases.length) throw new Error('Invalid-admission member has no cases');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: cases.map((admissionCase) => admissionCase.vmType),
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: false,
      image: 'nginx:alpine',
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion: registration.storage.region.fallback,
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['invalid-admission'],
      admissionCases: cases,
      expectedTerminalState: WorkloadState.Invalid,
    });
  }
  if (member.kind === 'host-recovery') {
    const capability = registration.hostRecovery;
    if (!capability)
      throw new Error('Job target lacks host-recovery capability');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: capability.vmTypes,
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: false,
      image: 'nginx:alpine',
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion:
        capability.checkpointRegion ?? registration.storage.region.fallback,
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      explicitCheckpoint: capability.checkpointRegion !== undefined,
      requiredExtensions: ['host-recovery'],
      expectedTerminalState: WorkloadState.Terminated,
    });
  }
  const storageRegion = configured(registration.storage.region);
  if (!storageRegion.trim())
    throw new Error('Job storage region must be explicit');
  if (member.kind === 'runtime-secrets') {
    const capability = registration.runtimeSecrets;
    if (!capability)
      throw new Error('Job target lacks runtime-secret capability');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: capability.vmTypes,
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: false,
      image: 'nginx:alpine',
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      // Its Jobs use no bucket; Lambda's storage is another cloud's.
      storageProvider: registration.storage.followsCompute
        ? registration.storage.provider
        : 'none',
      storageRegion: registration.storage.followsCompute ? storageRegion : '',
      storageFollowsCompute: registration.storage.followsCompute,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['runtime-secrets'],
      expectedTerminalState: WorkloadState.Terminated,
    });
  }
  if (member.kind === 'host-docker') {
    const capability = registration.hostDocker;
    if (!capability) throw new Error('Job target lacks host-docker coverage');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [capability.vmType],
      computeRegion: capability.region,
      diskSizeGb: undefined,
      spot: false,
      image: HOST_DOCKER_IMAGE,
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion,
      storageFollowsCompute: true,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      hostDockerPeer: capability.peer,
      diskIops: capability.gp3?.iops,
      diskThroughputMibps: capability.gp3?.throughputMibps,
      requiredExtensions: ['host-docker'],
      expectedTerminalState: WorkloadState.Completed,
    });
  }
  if (member.kind === 'restricted-credential') {
    const capability = registration.restrictedCredential;
    if (!capability)
      throw new Error('Job target lacks restricted-credential coverage');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: [
        ...new Set(
          capability.cases.map((restrictedCase) => restrictedCase.vmType),
        ),
      ],
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: false,
      image: 'alpine:3.20',
      credentialMode: `${member.target}-restricted` as const,
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion,
      storageFollowsCompute: true,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      restrictedCredential: capability,
      requiredExtensions: ['restricted-credential'],
      expectedTerminalState: WorkloadState.Completed,
    });
  }
  if (member.kind === 'spot-request-cleanup') {
    const capability = registration.spotCleanup;
    if (!capability)
      throw new Error('Job target lacks persistent Spot cleanup');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: capability.vmTypes,
      computeRegion: undefined,
      diskSizeGb: undefined,
      spot: true,
      image: 'nginx:alpine',
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion,
      storageFollowsCompute: true,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['spot-request-cleanup'],
      expectedTerminalState: WorkloadState.Terminated,
    });
  }
  if (member.kind === 'spot-eviction' || member.kind === 'gpu-spot-eviction') {
    const gpu = member.kind === 'gpu-spot-eviction';
    const capability = gpu
      ? registration.gpuSpotEviction
      : registration.spotEviction;
    if (!capability)
      throw new Error(`Job target lacks ${member.kind} coverage`);
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: capability.vmTypes,
      computeRegion: undefined,
      diskSizeGb: 100,
      spot: true,
      image: gpu ? BUCKET_IMAGE : 'alpine:3.20',
      credentialMode: 'bootstrap',
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion,
      storageFollowsCompute: true,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: [member.kind],
      expectedTerminalState: WorkloadState.Completed,
    });
  }
  if (member.kind === 'input-hydration-recovery') {
    const capability = registration.inputHydration;
    if (!capability)
      throw new Error('Job target lacks input-hydration capability');
    return freezeProfile({
      member,
      computeProvider: registration.provider,
      vmTypes: capability.vmTypes,
      computeRegion: storageRegion,
      diskSizeGb: 350,
      diskTier: 'medium',
      spot: false,
      image: 'alpine:3.20',
      // The on-demand Job runs on the imported AnycloudAccess key (RFC 0047 S12).
      credentialMode: registration.compute.credentialMode,
      reservationInventory: registration.compute.reservationInventory,
      storageProvider: registration.storage.provider,
      storageRegion,
      storageFollowsCompute: false,
      crossCloudStorageCredential: undefined,
      recursiveTransfers: false,
      requiredExtensions: ['input-hydration-recovery'],
      expectedTerminalState: WorkloadState.Completed,
    });
  }
  const concurrent = member.kind === 'concurrent-output';
  const primaryTypes = configured(registration.compute.types)
    .trim()
    .split(/\s+/u);
  if (primaryTypes.some((type) => !type.trim()))
    throw new Error('Job VM types must be nonempty');
  const types = concurrent
    ? registration.concurrentOutput?.vmTypes
    : [FAKE_VM_TYPE, ...primaryTypes, ...registration.compute.fallbacks];
  if (!types) throw new Error('Job target lacks concurrent-output capability');
  return freezeProfile({
    member,
    computeProvider: registration.provider,
    vmTypes: types,
    computeRegion: concurrent
      ? undefined
      : configured(registration.compute.region) || undefined,
    computeRegions: concurrent
      ? registration.concurrentOutput?.regions
      : undefined,
    launchFailover: concurrent
      ? registration.concurrentOutput?.launchFailover
      : undefined,
    diskSizeGb: concurrent
      ? 100
      : positiveInteger(
          configured(registration.compute.disk),
          registration.compute.disk.variable ?? 'Job disk size',
        ),
    spot: !concurrent && registration.compute.spot,
    // An on-demand bucket-sync Job (Lambda) passes its own checkpoint bucket,
    // so every leg checks checkpoint health in `status`.
    ...(!concurrent && !registration.compute.spot
      ? { explicitCheckpoint: true }
      : {}),
    image: concurrent ? 'nginx:alpine' : BUCKET_IMAGE,
    credentialMode: concurrent
      ? 'bootstrap'
      : registration.compute.credentialMode,
    reservationInventory: registration.compute.reservationInventory,
    storageProvider: registration.storage.provider,
    storageRegion,
    storageFollowsCompute: registration.storage.followsCompute,
    crossCloudStorageCredential: registration.storage.credential,
    recursiveTransfers: !concurrent && registration.storage.recursiveTransfers,
    requiredExtensions: concurrent
      ? ['concurrent-output']
      : registration.extensions,
    expectedTerminalState: concurrent
      ? WorkloadState.Terminated
      : WorkloadState.Completed,
  });
}

export function jobStageBudget(
  input: JobMember,
  environment: JobEnvironment,
): JobStageBudget {
  const member = capturedMember(input);
  if (member.kind === 'invalid-admission')
    return {
      runningMs: 120_000,
      cleanupMs: 300_000,
      storageMs: 60_000,
      completionMs: 120_000,
    };
  if (member.kind === 'ghcr-probe')
    return {
      runningMs: 1_800_000,
      cleanupMs: 2_700_000,
      completionMs: 2_700_000,
      // The original workflow bounds the whole probe at 3600/5400 seconds.
      // This is also the throughput ceiling; it does not add a new allowance.
      storageMs: environment.milliseconds(
        'E2E_TEST_TIMEOUT_SECONDS',
        ['1', 'true', 'yes'].includes(
          environment.optional('PROBE_MEASURE_BASELINE'),
        )
          ? 5_400
          : 3_600,
      ),
    };
  if (member.kind === 'mace-full-pull')
    return {
      runningMs: environment.milliseconds('MACE_FULL_PULL_WAIT_SECONDS', 5_400),
      cleanupMs: 2_700_000,
      storageMs: 60_000,
      completionMs: environment.milliseconds(
        'MACE_FULL_PULL_WAIT_SECONDS',
        5_400,
      ),
    };
  if (member.kind === 'disk-tier')
    return {
      runningMs: environment.milliseconds('GCP_DISK_TIER_WAIT_SECONDS', 1_200),
      cleanupMs: 2_700_000,
      storageMs: 60_000,
      completionMs: 2_700_000,
    };
  if (
    member.kind === 'runtime-secrets' ||
    member.kind === 'restricted-credential' ||
    member.kind === 'host-docker' ||
    member.kind === 'host-recovery'
  )
    return {
      runningMs: 900_000,
      cleanupMs: 2_700_000,
      storageMs: 180_000,
      completionMs: 1_200_000,
    };
  if (member.kind === 'spot-request-cleanup')
    return {
      runningMs: 1_200_000,
      cleanupMs: 600_000,
      storageMs: 120_000,
      completionMs: 600_000,
    };
  if (member.kind === 'input-hydration-recovery')
    return {
      runningMs: 1_200_000,
      cleanupMs: 2_700_000,
      storageMs: 1_200_000,
      completionMs: 3_600_000,
    };
  // Two runs of a small image on one VM, each followed by the GPU probe.
  if (member.kind === 'gpu-probe-rerun')
    return {
      runningMs: 1_800_000,
      cleanupMs: 2_700_000,
      storageMs: 60_000,
      completionMs: 1_200_000,
    };
  // A healthy read, the injected fault, an unhealthy read, then the fixed
  // two-minute report-only window the member itself waits out.
  if (member.kind === 'gpu-health-fault')
    return {
      runningMs: 1_200_000,
      cleanupMs: 2_700_000,
      storageMs: 60_000,
      completionMs: 1_200_000,
    };
  // The GPU member pulls the MACE image twice: at launch and on a fresh VM.
  if (member.kind === 'gpu-spot-eviction')
    return {
      runningMs: 3_600_000,
      cleanupMs: 2_700_000,
      storageMs: 300_000,
      completionMs: 3_600_000,
    };
  if (member.kind === 'spot-eviction')
    return {
      runningMs: 1_200_000,
      cleanupMs: 2_700_000,
      storageMs: 300_000,
      completionMs: 2_400_000,
    };
  return JOB_TARGET_PROFILES[member.target].kind === 'local-storage'
    ? {
        runningMs: member.kind === 'local-held' ? 300_000 : 180_000,
        cleanupMs: 300_000,
        storageMs: 90_000,
        completionMs: member.kind === 'local-completed' ? 240_000 : 300_000,
      }
    : {
        runningMs:
          member.kind === 'concurrent-output'
            ? 1_800_000
            : environment.milliseconds(
                'BUCKET_SYNC_RUNNING_TIMEOUT_SECONDS',
                3_600,
              ),
        cleanupMs: environment.milliseconds(
          'BUCKET_SYNC_CLEANUP_TIMEOUT_SECONDS',
          2_700,
        ),
        storageMs: 180_000,
        completionMs: 1_200_000,
      };
}
