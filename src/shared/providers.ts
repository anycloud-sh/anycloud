import { CloudType, GpuRuntime } from './cloud.js';
import { InvalidAnycloudConfigError } from './errors.js';

export enum ComputeCredentialMode {
  CloudCredentials = 'cloud-credentials',
  ApiInstance = 'api-instance',
}

/**
 * Granularity at which the optimizer identifies a provisioning target.
 *
 * A provider can expose availability zones at runtime without making them a
 * catalog placement dimension. AWS and Azure remain region-scoped here; GCP's
 * machine-type catalog is zone-scoped and therefore must select an exact zone.
 */
enum ProvisioningTargetScope {
  Region = 'region',
  AvailabilityZone = 'availability-zone',
}

export enum CheckpointStorageSource {
  ComputeCredential = 'compute-credential',
  ExplicitStorageCredential = 'explicit-storage-credential',
}

export const NEURON_RUNTIME_UNSUPPORTED_MESSAGE =
  'AWS Neuron instances (Trainium and Inferentia2) are recognized, but Neuron workloads are not supported yet.';

const ROCM_RUNTIME_UNSUPPORTED_MESSAGE =
  'AMD (ROCm) accelerators are recognized, but ROCm workloads are not supported yet.';

const UNKNOWN_ACCELERATOR_RUNTIME_UNSUPPORTED_MESSAGE =
  'This accelerator is recognized but not supported yet.';

interface AcceleratorRuntimeVMTypeRule {
  readonly prefixes: readonly string[];
  readonly runtime: GpuRuntime;
}

type AcceleratorRuntimeRejections = Readonly<Record<GpuRuntime, string | null>>;

interface AcceleratorRuntimeCapability {
  // null means supported; a string is the user-facing rejection. The special
  // value delegates compatibility to the provider/user environment.
  readonly rejectionByRuntime:
    | AcceleratorRuntimeRejections
    | 'provider-managed';
  // Provider-specific instance-family fallbacks used when the local catalog
  // has not learned a newly released size/generation yet.
  readonly vmTypeRules?: readonly AcceleratorRuntimeVMTypeRule[];
}

const CUDA_ONLY_RUNTIME_REJECTIONS = {
  [GpuRuntime.Cuda]: null,
  [GpuRuntime.Rocm]: ROCM_RUNTIME_UNSUPPORTED_MESSAGE,
  [GpuRuntime.Neuron]: NEURON_RUNTIME_UNSUPPORTED_MESSAGE,
  [GpuRuntime.Unsupported]: UNKNOWN_ACCELERATOR_RUNTIME_UNSUPPORTED_MESSAGE,
} as const satisfies AcceleratorRuntimeRejections;

const CUDA_ONLY_ACCELERATOR_RUNTIME_CAPABILITY = {
  rejectionByRuntime: CUDA_ONLY_RUNTIME_REJECTIONS,
} as const satisfies AcceleratorRuntimeCapability;

const AWS_ACCELERATOR_RUNTIME_CAPABILITY = {
  rejectionByRuntime: CUDA_ONLY_RUNTIME_REJECTIONS,
  vmTypeRules: [
    {
      prefixes: ['inf2.', 'trn1.', 'trn1n.', 'trn2.', 'trn2u.', 'trn3.'],
      runtime: GpuRuntime.Neuron,
    },
    { prefixes: ['inf1.'], runtime: GpuRuntime.Unsupported },
  ],
} as const satisfies AcceleratorRuntimeCapability;

const PROVIDER_MANAGED_ACCELERATOR_RUNTIME_CAPABILITY = {
  rejectionByRuntime: 'provider-managed',
} as const satisfies AcceleratorRuntimeCapability;

/**
 * Per-provider inert data: credential mode, defaults, and catalog filename.
 * Pure data with no gateway/SDK imports, so it is safe to import from BOTH the
 * CLI (standalone `gpus`/`regions`/`pricing` + default-fill) and the server.
 *
 * This is the shared half of the provider registry. The server-only half — how
 * to construct a gateway and build credentials from raw inline env — lives in
 * `api/services/cloud-config.ts` (it imports the gateway classes, which pull in
 * cloud SDKs and must never reach the CLI bundle).
 *
 * Behavioral capabilities (a uniform service the gateway offers — storage,
 * scoped-token minting, preemption/spot, quota) are gateway interfaces detected
 * by capability guards. This registry holds inert declarations/facts, including
 * the required accelerator-runtime capability enforced by CloudCompute.
 *
 * A full `Record<CloudType, …>`: adding a `CloudType` won't compile until it has
 * an entry here.
 */
/** Facts only a provider that runs compute has. */
export interface ComputeProviderData {
  // Whether workload selection needs a named/inline cloud credential, or uses
  // an API-instance capability such as Local.
  readonly computeCredentialMode: ComputeCredentialMode;
  // Whether pinning a region disables provider-region failover.
  readonly supportsRegionFailover: boolean;
  // Whether catalog placement and failure identity stop at the region or
  // include an exact availability zone.
  readonly provisioningTargetScope: ProvisioningTargetScope;
  // Whether a missing-accelerator workload exit can be retried on replacement
  // capacity. Fixed CPU-only harnesses cannot recover by replacing their host.
  readonly supportsAcceleratorFailureRetry: boolean;
  // A host command printing `no-notice` only when the VM's own metadata says
  // it isn't being reclaimed; absent where that can't be read in time.
  readonly spotNoReclaimNoticeCommand?: string;
  // Whether the provider honors --disk-tier for performance disk selection
  // (e.g. AWS gp3 IOPS/throughput, Azure Premium_LRS OS disk).
  readonly supportsDiskTier: boolean;
  // Whether a CPU VM Job's host is Ubuntu minimal, prepared by cloud-config
  // user data that installs Docker and pre-pulls a public image while the API
  // waits for SSH (generateJobHostUserData).
  readonly preparesJobHosts: boolean;
  // The cloud's own Ubuntu mirror in a region, as `<name>.archive.ubuntu.com`
  // (and `<name>.ports.ubuntu.com`): a prepared Job host fetches its pinned
  // debs from it before archive.ubuntu.com. Some regions lack one (AWS ports
  // in several, GCP in a few) and fail at DNS into that fallback.
  readonly ubuntuMirror?: (region: string) => string;
  // Required, fail-closed runtime support declaration. Adding a CloudType must
  // choose a policy; adding a GpuRuntime must update every declared policy.
  readonly acceleratorRuntimeCapability: AcceleratorRuntimeCapability;
  // Default region/vmType used when the user omits them (completeCloudConfig).
  readonly defaultRegion: string;
  readonly defaultVmType: string;
  // Host path backing VM bucket data.
  readonly bucketHostRoot: string;
  // Catalog CSV filename under ~/.anycloud/catalogs, or null for providers with
  // no static catalog (Local; future scheduler-backed clouds).
  readonly catalogFile: string | null;
  // Where checkpoint storage credentials come from. Providers without a
  // native storage identity need explicit checkpoint storage credentials.
  readonly checkpointStorageSource: CheckpointStorageSource;
  // Optional copy for provider availability failure summaries.
  readonly exhaustedCandidateFilterMessage?: string;
}

export interface ProviderData {
  // Whether the provider has a native object store the API can drive directly
  // (create/list buckets, transfer and enumerate objects). Providers without
  // one can still mount buckets hosted on another cloud via explicit storage
  // credentials.
  readonly supportsObjectStorage: boolean;
  // Identity tuple used to dedup credentials: a stable tag plus the ordered
  // account fields that distinguish one credential from another. The last
  // account field falls back to the credential name, earlier fields to '';
  // an empty list means the credential has no account-level identity and is
  // keyed by name alone (Local has no creds; Lambda keys by name).
  readonly credentialIdentity: {
    readonly tag: string;
    readonly accountFields: readonly string[];
  };
  // Null for a storage-only provider: one whose credential can hold buckets
  // but never run a workload. Read through computeProviderData().
  readonly compute: ComputeProviderData | null;
}

/**
 * Default host mount for a VM's bucket data.
 */
export const DEFAULT_BUCKET_HOST_ROOT = '/mnt';

/** Shared filesystem namespace mounted into Local smolvm guests. */
export const LOCAL_BUCKET_STORE_GUEST_ROOT = '/var/lib/anycloud/buckets';

export interface BucketHostPaths {
  readonly input: string;
  readonly output: string;
  readonly checkpoint: string;
}

export function bucketHostPathsForRoot(hostRoot: string): BucketHostPaths {
  return {
    input: `${hostRoot}/input`,
    output: `${hostRoot}/output`,
    checkpoint: `${hostRoot}/checkpoint`,
  };
}

export const DEFAULT_BUCKET_HOST_PATHS = bucketHostPathsForRoot(
  DEFAULT_BUCKET_HOST_ROOT,
);

export function normalizeBucketHostPaths(
  paths?: Partial<BucketHostPaths> | null,
): BucketHostPaths {
  return {
    input: paths?.input ?? DEFAULT_BUCKET_HOST_PATHS.input,
    output: paths?.output ?? DEFAULT_BUCKET_HOST_PATHS.output,
    checkpoint: paths?.checkpoint ?? DEFAULT_BUCKET_HOST_PATHS.checkpoint,
  };
}

export const PROVIDER_DATA: Record<CloudType, ProviderData> = {
  [CloudType.AWS]: {
    supportsObjectStorage: true,
    credentialIdentity: { tag: 'aws', accountFields: ['accessKeyId'] },
    compute: {
      computeCredentialMode: ComputeCredentialMode.CloudCredentials,
      supportsRegionFailover: true,
      provisioningTargetScope: ProvisioningTargetScope.Region,
      supportsAcceleratorFailureRetry: true,
      // Best-effort, usually two minutes ahead; the systemd guard covers a gap.
      spotNoReclaimNoticeCommand: `t=$(curl -sf -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) && [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/spot/instance-action)" = 404 ] && echo no-notice`,
      supportsDiskTier: true,
      preparesJobHosts: true,
      ubuntuMirror: (region) => `${region}.ec2`,
      acceleratorRuntimeCapability: AWS_ACCELERATOR_RUNTIME_CAPABILITY,
      defaultRegion: 'us-east-1',
      defaultVmType: 't2.micro',
      bucketHostRoot: DEFAULT_BUCKET_HOST_ROOT,
      catalogFile: 'aws.csv',
      checkpointStorageSource: CheckpointStorageSource.ComputeCredential,
      exhaustedCandidateFilterMessage:
        'All AWS regions for "{vmLabel}" are either not opted-in or have a vCPU quota of 0 — request quota or enable a region',
    },
  },
  [CloudType.GCP]: {
    supportsObjectStorage: true,
    credentialIdentity: {
      tag: 'gcp',
      accountFields: ['projectId', 'clientEmail'],
    },
    compute: {
      computeCredentialMode: ComputeCredentialMode.CloudCredentials,
      supportsRegionFailover: true,
      provisioningTargetScope: ProvisioningTargetScope.AvailabilityZone,
      supportsAcceleratorFailureRetry: true,
      // `preempted` turns TRUE as preemption starts, before its ACPI shutdown.
      spotNoReclaimNoticeCommand: `[ "$(curl -sf -m 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/preempted)" = FALSE ] && echo no-notice`,
      supportsDiskTier: true,
      preparesJobHosts: true,
      ubuntuMirror: (region) => `${region}.gce`,
      acceleratorRuntimeCapability: CUDA_ONLY_ACCELERATOR_RUNTIME_CAPABILITY,
      defaultRegion: 'us-east4',
      defaultVmType: 'f1-micro',
      bucketHostRoot: DEFAULT_BUCKET_HOST_ROOT,
      catalogFile: 'gcp.csv',
      checkpointStorageSource: CheckpointStorageSource.ComputeCredential,
    },
  },
  [CloudType.Azure]: {
    supportsObjectStorage: true,
    credentialIdentity: { tag: 'azure', accountFields: ['subscriptionId'] },
    compute: {
      computeCredentialMode: ComputeCredentialMode.CloudCredentials,
      supportsRegionFailover: true,
      provisioningTargetScope: ProvisioningTargetScope.Region,
      supportsAcceleratorFailureRetry: true,
      supportsDiskTier: true,
      preparesJobHosts: true,
      ubuntuMirror: () => 'azure',
      acceleratorRuntimeCapability: CUDA_ONLY_ACCELERATOR_RUNTIME_CAPABILITY,
      defaultRegion: 'eastus',
      defaultVmType: 'Standard_B1s',
      bucketHostRoot: '/var/lib/anycloud/deployments',
      catalogFile: 'azure.csv',
      checkpointStorageSource: CheckpointStorageSource.ComputeCredential,
      exhaustedCandidateFilterMessage:
        'All Azure regions for "{vmLabel}" lack enough quota or Compute access for this VM shape — request quota or choose a region with available quota',
    },
  },
  [CloudType.Lambda]: {
    supportsObjectStorage: false,
    credentialIdentity: { tag: CloudType.Lambda, accountFields: [] },
    compute: {
      computeCredentialMode: ComputeCredentialMode.CloudCredentials,
      supportsRegionFailover: true,
      provisioningTargetScope: ProvisioningTargetScope.Region,
      supportsAcceleratorFailureRetry: true,
      supportsDiskTier: false,
      preparesJobHosts: false,
      acceleratorRuntimeCapability: CUDA_ONLY_ACCELERATOR_RUNTIME_CAPABILITY,
      defaultRegion: 'us-east-1',
      defaultVmType: 'gpu_1x_a100_sxm4',
      bucketHostRoot: DEFAULT_BUCKET_HOST_ROOT,
      catalogFile: 'lambda.csv',
      checkpointStorageSource:
        CheckpointStorageSource.ExplicitStorageCredential,
    },
  },
  [CloudType.Cloudflare]: {
    // R2. Containers compute is not built yet.
    supportsObjectStorage: true,
    // tokenId is never stored, so the key always falls back to the credential
    // name: one account can hold several tokens with different permissions.
    credentialIdentity: {
      tag: 'cloudflare',
      accountFields: ['accountId', 'tokenId'],
    },
    compute: null,
  },
  [CloudType.Local]: {
    // The harness has an internal filesystem CloudStorage implementation for
    // workload sync, but it is not a public named-credential bucket target.
    supportsObjectStorage: false,
    credentialIdentity: { tag: 'local', accountFields: [] },
    compute: {
      computeCredentialMode: ComputeCredentialMode.ApiInstance,
      supportsRegionFailover: false,
      provisioningTargetScope: ProvisioningTargetScope.Region,
      supportsAcceleratorFailureRetry: false,
      supportsDiskTier: false,
      preparesJobHosts: false,
      acceleratorRuntimeCapability:
        PROVIDER_MANAGED_ACCELERATOR_RUNTIME_CAPABILITY,
      defaultRegion: 'local',
      defaultVmType: 'local',
      bucketHostRoot: DEFAULT_BUCKET_HOST_ROOT,
      catalogFile: null,
      checkpointStorageSource: CheckpointStorageSource.ComputeCredential,
    },
  },
};

/** Whether this provider can run compute, as opposed to holding storage only. */
export function isComputeProvider(cloud: CloudType): boolean {
  return PROVIDER_DATA[cloud].compute !== null;
}

export function storageOnlyComputeMessage(cloud: CloudType): string {
  return `${cloud} credentials hold storage only and can't run workloads. Use them with --input-storage-credentials, --output-storage-credentials or --checkpoint-storage-credentials, and choose compute with another credential.`;
}

/** A compute provider's facts; a storage-only provider is refused. */
export function computeProviderData(cloud: CloudType): ComputeProviderData {
  const compute = PROVIDER_DATA[cloud].compute;
  if (!compute) {
    throw new InvalidAnycloudConfigError(storageOnlyComputeMessage(cloud));
  }
  return compute;
}

/** Apply a provider capability's catalog-independent VM-family recognition. */
export function acceleratorRuntimeForProviderVMType(
  cloud: CloudType,
  vmType: string,
): GpuRuntime | null {
  const normalized = vmType.toLowerCase();
  const rules =
    computeProviderData(cloud).acceleratorRuntimeCapability.vmTypeRules;
  for (const rule of rules ?? []) {
    if (rule.prefixes.some((prefix) => normalized.startsWith(prefix))) {
      return rule.runtime;
    }
  }
  return null;
}

/** Return the cloud's user-facing rejection, or null when supported/delegated. */
export function acceleratorRuntimeRejectionMessage(
  cloud: CloudType,
  runtime: GpuRuntime | null | undefined,
): string | null {
  if (runtime == null) return null;
  const rejections =
    computeProviderData(cloud).acceleratorRuntimeCapability.rejectionByRuntime;
  return rejections === 'provider-managed' ? null : rejections[runtime];
}

export const CATALOG_BACKED_CLOUDS: readonly CloudType[] = (
  Object.keys(PROVIDER_DATA) as CloudType[]
).filter((cloud) => PROVIDER_DATA[cloud].compute?.catalogFile != null);

/**
 * Whether the API can drive this provider's object store directly — creating
 * and enumerating buckets, and transferring and listing their objects.
 */
export function supportsObjectStorage(cloud: CloudType): boolean {
  return PROVIDER_DATA[cloud].supportsObjectStorage;
}

/** Whether optimizer targets for this provider include an exact zone. */
export function usesAvailabilityZoneTargets(cloud: CloudType): boolean {
  return (
    computeProviderData(cloud).provisioningTargetScope ===
    ProvisioningTargetScope.AvailabilityZone
  );
}

/**
 * A spot VM's no-reclaim-notice probe, run on the host: it prints no-notice
 * only while the host isn't shutting down and the cloud's metadata says it
 * isn't being reclaimed. Azure has none: its Scheduled Events
 * start only on their first request, which can take two minutes to answer.
 */
export function spotNoReclaimNoticeCommand(
  cloud: CloudType,
): string | undefined {
  const notice = computeProviderData(cloud).spotNoReclaimNoticeCommand;
  // A reclaim stops dockerd in the host's shutdown: systemd then says
  // `stopping`, even when AWS's best-effort notice is missing.
  return notice
    ? `case "$(systemctl is-system-running 2>/dev/null)" in running | degraded) ;; *) exit 1 ;; esac; ${notice}`
    : undefined;
}

/** Whether replacement capacity can recover a missing-accelerator exit. */
export function supportsAcceleratorFailureRetry(cloud: CloudType): boolean {
  return computeProviderData(cloud).supportsAcceleratorFailureRetry;
}

export function bucketHostPathsForProvider(
  computeCloud: CloudType,
): BucketHostPaths {
  return bucketHostPathsForRoot(
    computeProviderData(computeCloud).bucketHostRoot,
  );
}

/**
 * Whether this provider routes VM-host bucket data away from the default /mnt
 * root into provider-managed storage.
 */
export function usesManagedBucketHostRoot(computeCloud: CloudType): boolean {
  return (
    computeProviderData(computeCloud).bucketHostRoot !==
    DEFAULT_BUCKET_HOST_ROOT
  );
}

export function formatExhaustedCandidateFilterMessage(
  cloud: CloudType,
  vmLabel: string,
): string {
  const template = computeProviderData(cloud).exhaustedCandidateFilterMessage;
  if (template) return template.split('{vmLabel}').join(vmLabel);
  return `All ${cloud} regions for "${vmLabel}" are unavailable for this account — request access or choose a different region`;
}
