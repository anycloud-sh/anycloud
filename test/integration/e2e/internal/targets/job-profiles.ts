import { CloudType } from '../../../../../src/shared/cloud.js';
import type {
  DedicatedJobTarget,
  JobExtension,
  JobMemberProfile,
  JobRestrictedCredentialProfile,
  JobStorageProvider,
} from './job-types.js';

interface ConfiguredValue {
  readonly fallback: string;
  readonly variable?: string;
}

export const JOB_BUCKET_MOLECULES = Object.freeze([
  'H2O',
  'CH4',
  'NH3',
  'CO2',
  'C2H6',
  'H2',
  'O2',
  'N2',
  'CH3OH',
  'C2H4',
]);

/**
 * The spot-eviction Job's final output. At three times the 8 GiB of RAM on
 * each member's VM, its final sync reads from disk for minutes, far longer
 * than an eviction takes to land.
 */
export const JOB_EVICTION_PAYLOAD_MIB = 24_576;
/** The spot-eviction member's clean-exit sibling runs this long. */
export const JOB_SPOT_EXIT_SECONDS = 600;

interface ObjectStorageJobProfile {
  readonly kind: 'object-storage';
  readonly provider: JobMemberProfile['computeProvider'];
  readonly compute: {
    readonly types: ConfiguredValue;
    readonly fallbacks: readonly string[];
    readonly region: ConfiguredValue;
    readonly disk: ConfiguredValue;
    readonly credentialMode: JobMemberProfile['credentialMode'];
    readonly reservationInventory?: JobMemberProfile['reservationInventory'];
    readonly spot: boolean;
  };
  readonly storage: {
    readonly provider: JobStorageProvider;
    readonly region: ConfiguredValue;
    readonly credential: JobMemberProfile['crossCloudStorageCredential'];
    readonly recursiveTransfers: boolean;
    readonly followsCompute: boolean;
  };
  readonly extensions: readonly JobExtension[];
  readonly concurrentOutput?: {
    readonly vmTypes: readonly string[];
    /** `--regions`: each child lands in one of these. */
    readonly regions: readonly string[];
    /** The head type is refused for quota, so each child fails over. */
    readonly launchFailover?: boolean;
  };
  readonly hostRecovery?: {
    readonly vmTypes: readonly string[];
    readonly checkpointRegion?: string;
  };
  readonly inputHydration?: { readonly vmTypes: readonly string[] };
  readonly spotCleanup?: { readonly vmTypes: readonly string[] };
  readonly spotEviction?: { readonly vmTypes: readonly string[] };
  readonly gpuSpotEviction?: { readonly vmTypes: readonly string[] };
  /** The in-place rerun's smallest one-GPU CUDA type. */
  readonly gpuProbeRerun?: {
    readonly vmType: string;
    readonly region?: string;
    readonly regions?: readonly string[];
  };
  readonly runtimeSecrets?: { readonly vmTypes: readonly string[] };
  readonly restrictedCredential?: JobRestrictedCredentialProfile;
  readonly ghcrProbe?: { readonly vmType: string; readonly region: string };
  /** `--host-docker` with nesting: a type the catalog reports KVM for. */
  readonly hostDocker?: {
    readonly vmType: string;
    readonly region: string;
    /** A prober Job in the same network tries the listener's ports. */
    readonly peer: boolean;
    /** The listener's own gp3 root performance. */
    readonly gp3?: { readonly iops: number; readonly throughputMibps: number };
  };
  /** A spot Job of a multi-arch image on an arm64 type. */
  readonly arm64?: { readonly vmType: string; readonly region: string };
  readonly maceFullPull?: {
    readonly vmType: string;
    readonly region?: string;
    readonly diskSizeGb?: number;
    readonly diskTier?: JobMemberProfile['diskTier'];
  };
  readonly diskTier?: {
    readonly hyperdiskVmType: ConfiguredValue;
    readonly persistentVmType: ConfiguredValue;
    readonly region: ConfiguredValue;
    readonly zone: ConfiguredValue;
  };
  readonly invalidAdmission?: {
    readonly unknownVmRegion?: string;
    readonly reservedBucket?: {
      readonly prefix: string;
      readonly vmType: string;
    };
    readonly cudaRuntime?: {
      readonly vmType: ConfiguredValue;
      readonly region: ConfiguredValue;
      readonly image: ConfiguredValue;
    };
  };
}

interface LocalJobProfile {
  readonly kind: 'local-storage';
  readonly provider: CloudType.Local;
}

/** Provider registrations describe capabilities; the shared family does not infer them from names. */
export const JOB_TARGET_PROFILES: Readonly<
  Record<DedicatedJobTarget, ObjectStorageJobProfile | LocalJobProfile>
> = {
  aws: {
    kind: 'object-storage',
    provider: CloudType.AWS,
    compute: {
      types: { fallback: 't3.large' },
      fallbacks: ['t3.xlarge'],
      region: { variable: 'BUCKET_SYNC_COMPUTE_REGION', fallback: '' },
      disk: { variable: 'BUCKET_SYNC_DISK_SIZE_GB', fallback: '100' },
      credentialMode: 'aws-import',
      reservationInventory: 'matched-attempts',
      spot: true,
    },
    storage: {
      provider: 'aws',
      region: { variable: 'AWS_STORAGE_REGION', fallback: 'us-east-1' },
      credential: undefined,
      recursiveTransfers: true,
      followsCompute: true,
    },
    extensions: ['bucket-storage', 'in-place-recovery'],
    concurrentOutput: {
      vmTypes: ['t3.large'],
      // Sets that exclude the type's cheapest region, where an
      // unfiltered placement would land, so the check fails without --regions.
      regions: ['us-east-2', 'us-west-2'],
    },
    hostRecovery: { vmTypes: ['t3.large'] },
    inputHydration: { vmTypes: ['t3.large'] },
    spotCleanup: { vmTypes: ['t3.large'] },
    spotEviction: { vmTypes: ['t3.large'] },
    runtimeSecrets: { vmTypes: ['t3.small'] },
    // Neither gp3's baseline (3,000/125) nor a disk tier's.
    hostDocker: {
      vmType: 'm7i.xlarge',
      region: 'us-east-1',
      peer: true,
      gp3: { iops: 4000, throughputMibps: 500 },
    },
    // The 0.1.66 pilot: c6i.xlarge's cheapest catalog region is outside these.
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
    arm64: { vmType: 'm8g.large', region: 'us-east-1' },
    maceFullPull: { vmType: 'g6e.xlarge', diskSizeGb: 100, diskTier: 'high' },
    gpuProbeRerun: { vmType: 'g4dn.xlarge' },
    invalidAdmission: {
      unknownVmRegion: 'us-east-1',
      reservedBucket: { prefix: 'sthree-reserved-test-', vmType: 't3.small' },
    },
  },
  azure: {
    kind: 'object-storage',
    provider: CloudType.Azure,
    compute: {
      types: { fallback: 'Standard_D2s_v5' },
      fallbacks: ['Standard_D4s_v5'],
      region: { variable: 'BUCKET_SYNC_COMPUTE_REGION', fallback: '' },
      disk: { variable: 'BUCKET_SYNC_DISK_SIZE_GB', fallback: '100' },
      credentialMode: 'azure-generate',
      spot: true,
    },
    storage: {
      provider: 'azure',
      region: { variable: 'AZURE_STORAGE_REGION', fallback: 'eastus' },
      credential: undefined,
      recursiveTransfers: true,
      followsCompute: true,
    },
    extensions: ['bucket-storage', 'in-place-recovery'],
    concurrentOutput: {
      vmTypes: ['Standard_D2s_v3'],
      // Sets that exclude the type's cheapest region, where an
      // unfiltered placement would land, so the check fails without --regions.
      regions: ['eastus2', 'westus2'],
    },
    hostRecovery: { vmTypes: ['Standard_D2s_v5'], checkpointRegion: 'eastus' },
    runtimeSecrets: { vmTypes: ['Standard_D2s_v5'] },
    spotEviction: { vmTypes: ['Standard_D2s_v5'] },
    // The customer's VM type, which came back from an in-place restart without a usable GPU.
    gpuSpotEviction: { vmTypes: ['Standard_NC4as_T4_v3'] },
    gpuProbeRerun: { vmType: 'Standard_NC4as_T4_v3', region: 'westus2' },
    // A principal holding only the published Anycloud role, a subset of
    // Contributor: no bucket (S4), and a same-account output bucket that
    // syncs with a minted container SAS (S11). Both are unpinned, so
    // placement fails over from a region without capacity (train 6).
    restrictedCredential: {
      cases: [
        { key: 'unpinned', scenario: 'S4', vmType: 'Standard_D2s_v5' },
        { key: 'output', scenario: 'S11', vmType: 'Standard_D2s_v5' },
      ],
    },
    ghcrProbe: { vmType: 'Standard_NC4as_T4_v3', region: 'westus2' },
    // No prober: each Azure Job has its own VNet, and every one is
    // 10.0.0.0/16, so a peer's probe of 10.0.0.4 would reach itself. The
    // per-Job VNet and NSG isolate it instead.
    hostDocker: {
      vmType: 'Standard_D4s_v5',
      region: 'westus2',
      peer: false,
    },
    maceFullPull: {
      vmType: 'Standard_NC4as_T4_v3',
      diskSizeGb: 100,
      diskTier: 'high',
    },
    invalidAdmission: {
      unknownVmRegion: 'eastus',
      cudaRuntime: {
        vmType: {
          variable: 'AZURE_AMD_VM_TYPE',
          fallback: 'Standard_ND96isr_MI300X_v5',
        },
        region: { variable: 'AZURE_AMD_REGION', fallback: 'eastus2' },
        image: {
          variable: 'AZURE_AMD_CUDA_IMAGE',
          fallback:
            'mirror.gcr.io/nvidia/cuda@sha256:8767a245ed2c481eb245d8f6c625accc3788e1fb8612403d6b4cd4645a4f09c7',
        },
      },
    },
  },
  gcp: {
    kind: 'object-storage',
    provider: CloudType.GCP,
    compute: {
      types: { fallback: 'e2-standard-2' },
      fallbacks: ['e2-standard-4'],
      region: { variable: 'BUCKET_SYNC_COMPUTE_REGION', fallback: '' },
      disk: { variable: 'BUCKET_SYNC_DISK_SIZE_GB', fallback: '100' },
      credentialMode: 'gcp-import',
      spot: true,
    },
    storage: {
      provider: 'gcp',
      region: { variable: 'GCP_STORAGE_REGION', fallback: 'us-central1' },
      credential: undefined,
      recursiveTransfers: true,
      followsCompute: true,
    },
    extensions: ['bucket-storage', 'in-place-recovery'],
    // With no A100 quota in either region, which the member reads before it
    // submits, every a2 launch is refused and fails over.
    concurrentOutput: {
      vmTypes: ['a2-highgpu-1g', 'e2-standard-2'],
      // Sets that exclude the type's cheapest region, where an
      // unfiltered placement would land, so the check fails without --regions.
      regions: ['us-east1', 'us-west1'],
      launchFailover: true,
    },
    hostRecovery: { vmTypes: ['e2-standard-2'] },
    spotEviction: { vmTypes: ['e2-standard-2'] },
    runtimeSecrets: { vmTypes: ['e2-standard-2'] },
    maceFullPull: {
      vmType: 'g2-standard-4',
      region: 'us-east4',
      diskSizeGb: 100,
      diskTier: 'medium',
    },
    // us-east4 alone often has no L4 capacity.
    gpuProbeRerun: {
      vmType: 'g2-standard-4',
      regions: ['us-east4', 'us-central1'],
    },
    hostDocker: {
      vmType: 'n2-standard-4',
      region: 'us-central1',
      peer: true,
    },
    arm64: { vmType: 'c4a-standard-4', region: 'europe-west4' },
    diskTier: {
      hyperdiskVmType: {
        variable: 'GCP_DISK_TIER_HYPERDISK_VM_TYPE',
        fallback: 'c4-standard-2',
      },
      persistentVmType: {
        variable: 'GCP_DISK_TIER_PD_VM_TYPE',
        fallback: 'e2-standard-2',
      },
      region: { variable: 'GCP_DISK_TIER_REGION', fallback: 'us-east4' },
      zone: { variable: 'GCP_DISK_TIER_ZONE', fallback: 'c' },
    },
    invalidAdmission: {
      unknownVmRegion: 'us-central1',
      reservedBucket: {
        prefix: 'goog-reserved-test-',
        vmType: 'n2-standard-2',
      },
    },
  },
  lambda: {
    kind: 'object-storage',
    provider: CloudType.Lambda,
    compute: {
      types: { fallback: 'cpu_4x_general gpu_1x_a10 gpu_1x_a100_sxm4' },
      fallbacks: [],
      region: { variable: 'BUCKET_SYNC_COMPUTE_REGION', fallback: '' },
      disk: { variable: 'BUCKET_SYNC_DISK_SIZE_GB', fallback: '100' },
      credentialMode: 'public-token-import',
      spot: false,
    },
    storage: {
      provider: 'aws',
      region: { fallback: 'us-east-1' },
      credential: 'aws-storage',
      recursiveTransfers: false,
      followsCompute: false,
    },
    extensions: ['bucket-storage'],
    maceFullPull: { vmType: 'gpu_1x_a10' },
    gpuProbeRerun: { vmType: 'gpu_1x_a10' },
    runtimeSecrets: { vmTypes: ['cpu_4x_general', 'gpu_1x_a10'] },
  },
  'local-smolvm': { kind: 'local-storage', provider: CloudType.Local },
} satisfies Readonly<
  Record<DedicatedJobTarget, ObjectStorageJobProfile | LocalJobProfile>
>;
