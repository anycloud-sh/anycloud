import type { WorkloadAdmissionInput } from '../../shared/api-contract/workload-admission-schemas.js';
import {
  bindInlineCredentials,
  getRegions,
  DEFAULT_DISK_TIER,
  gpuRuntimeForVMType,
  extractCredentials,
  isCloudType,
  isComputeCredentials,
  nestedVirtualizationSupport,
  normalizeDiskTier,
  requiresComputeCredentials,
} from '../../shared/cloud-config.js';
import { validateDockerOptionsRequest } from '../../shared/docker-options.js';
import {
  DeployError,
  InvalidAnycloudConfigError,
} from '../../shared/errors.js';
import {
  diskMinimumSizeGb,
  diskPerformanceError,
} from '../../shared/disk-performance.js';
import { isHostedApiImage } from '../../shared/hosted-api.js';
import {
  computeProviderData,
  isComputeProvider,
  storageOnlyComputeMessage,
} from '../../shared/providers.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../shared/cloud.js';
import { WorkloadType } from '../../shared/workload.js';
import { toArray } from '../../shared/utils.js';
import {
  resolveCredentialByName,
  resolveStorageCredential,
} from './cloud-config.js';
import {
  resolveAvailableImplicitComputeProvider,
  type ResolvedComputeCredential,
} from './compute-validation.js';
import type { User } from './entities.js';
import { ensureCatalogReady } from './catalog-readiness.js';
import { JOB_HOST_DISK_GB } from './job-host.js';
import { getCredentialSecretStore } from './persistence.js';

const resolvedWorkloadAdmissionBrand: unique symbol = Symbol(
  'ResolvedWorkloadAdmission',
);

/**
 * Placement and credentials resolved from a validated transport request.
 * The private brand prevents later stages from accepting the parsed request
 * directly or fabricating a partially resolved value.
 */
export interface ResolvedWorkloadAdmission {
  readonly [resolvedWorkloadAdmissionBrand]: true;
  readonly actor: User;
  readonly input: WorkloadAdmissionInput;
  readonly requestedWorkloadType: WorkloadType;
  readonly requestedCredentiallessCompute?: CloudType;
  readonly resolvedComputeCredential?: ResolvedComputeCredential;
  readonly inlineComputeCredentials?: CloudCredentials;
  readonly usingInlineCompute: boolean;
  readonly cloudConfig: CloudConfig;
}

function parseWorkloadType(
  value: WorkloadAdmissionInput['workloadType'],
): WorkloadType {
  if (value === undefined || value === WorkloadType.Job) {
    return WorkloadType.Job;
  }
  if (value === 'service') {
    return WorkloadType.Service;
  }
  if (value === WorkloadType.Vm) return WorkloadType.Vm;
  throw new InvalidAnycloudConfigError(
    'workloadType must be "job", "service", or "vm"',
  );
}

function hasExplicitComputePlacement(
  cloudConfig: WorkloadAdmissionInput['cloudConfig'],
  gpuType: string | string[] | undefined,
): boolean {
  return Boolean(
    cloudConfig.region ||
      toArray(cloudConfig.vmType).length > 0 ||
      toArray(gpuType).length > 0 ||
      cloudConfig.spot ||
      cloudConfig.diskSizeGb !== undefined ||
      cloudConfig.diskTier !== undefined ||
      cloudConfig.availabilityZone,
  );
}

async function inferAvailableCredentiallessCompute(args: {
  cloudConfig: WorkloadAdmissionInput['cloudConfig'];
  credentialName?: string;
  gpuType?: string | string[];
}): Promise<void> {
  const { cloudConfig, credentialName, gpuType } = args;
  if (
    cloudConfig.cloudProvider ||
    cloudConfig.credentials ||
    credentialName ||
    hasExplicitComputePlacement(cloudConfig, gpuType)
  ) {
    return;
  }

  if (await hasSavedComputeCredential()) return;

  const availableProvider = await resolveAvailableImplicitComputeProvider();
  if (availableProvider) cloudConfig.cloudProvider = availableProvider;
}

/** The saved-credential providers implicit placement checks. */
interface SavedCredentials {
  listNamedCredentials(): Promise<{ cloudProvider: CloudType }[]>;
}

async function hasSavedComputeCredential(): Promise<boolean> {
  const credentials: SavedCredentials = getCredentialSecretStore();
  const savedCredentials = await credentials.listNamedCredentials();
  return savedCredentials.some(
    ({ cloudProvider }) =>
      isComputeProvider(cloudProvider) &&
      requiresComputeCredentials(cloudProvider),
  );
}

/**
 * Naming a credential is not actionable advice to an operator who has none, so
 * distinguish an unselected pool from an empty one. Read on the rejection path
 * only, and independently of the inference short-circuits above, so a request
 * that named a VM type still gets the first-run answer.
 */
async function credentialRequiredMessage(): Promise<string> {
  return (await hasSavedComputeCredential())
    ? 'Remote compute requires a selected credential. Pass --credentials or provide inline credentials.'
    : 'No compute credentials configured. Use "anycloud credentials new" to add credentials.';
}

export function normalizeCredentiallessComputeRequest(args: {
  cloudConfig: WorkloadAdmissionInput['cloudConfig'];
  credentialName?: string;
  gpuType?: string | string[];
}): CloudType | undefined {
  const { cloudConfig, credentialName, gpuType } = args;
  const provider = cloudConfig.cloudProvider;
  if (!provider) return undefined;
  if (!isCloudType(provider)) {
    throw new InvalidAnycloudConfigError(
      'cloudConfig.cloudProvider is invalid',
    );
  }
  const providerData = computeProviderData(provider);
  if (requiresComputeCredentials(provider)) return undefined;

  const defaultRegion = providerData.defaultRegion;
  const defaultVmType = providerData.defaultVmType;

  if (credentialName || cloudConfig.credentials) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not use compute credentials.`,
    );
  }
  if (cloudConfig.region && cloudConfig.region !== defaultRegion) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --region.`,
    );
  }
  const vmTypes = toArray(cloudConfig.vmType);
  if (
    vmTypes.length > 0 &&
    (vmTypes.length !== 1 || vmTypes[0] !== defaultVmType)
  ) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --vm-type.`,
    );
  }
  if (toArray(gpuType).length > 0) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --gpu-type.`,
    );
  }
  if (cloudConfig.spot) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --spot.`,
    );
  }
  if (cloudConfig.diskSizeGb !== undefined) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --disk-size.`,
    );
  }
  if (cloudConfig.diskTier !== undefined) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --disk-tier.`,
    );
  }
  if (cloudConfig.availabilityZone) {
    throw new InvalidAnycloudConfigError(
      `${provider} compute does not accept --zone.`,
    );
  }

  cloudConfig.region = defaultRegion;
  cloudConfig.vmType = defaultVmType;
  return provider;
}

function validateServiceCapacity(
  value: number | undefined,
  field: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidAnycloudConfigError(`${field} must be a positive integer`);
  }
  if (value > 1) {
    throw new InvalidAnycloudConfigError(
      `${field}>1 is not supported for service workloads; launch one Service per VM`,
    );
  }
}

function validateServiceWorkloadShape(args: {
  cloudConfig: CloudConfig;
  inputStorageCredentialName?: string;
  outputStorageCredentialName?: string;
}): void {
  const { cloudConfig } = args;
  if (cloudConfig.spot) {
    throw new InvalidAnycloudConfigError(
      '--spot is not supported for service workloads',
    );
  }
  if (cloudConfig.inputBucket || cloudConfig.outputBucket) {
    throw new InvalidAnycloudConfigError(
      'input/output buckets are not supported for service workloads',
    );
  }
  if (
    args.inputStorageCredentialName ||
    args.outputStorageCredentialName ||
    cloudConfig.inputStorageCredentials ||
    cloudConfig.outputStorageCredentials ||
    cloudConfig.inputStorageRegion ||
    cloudConfig.outputStorageRegion
  ) {
    throw new InvalidAnycloudConfigError(
      'input/output storage credentials are not supported for service workloads',
    );
  }
  validateServiceCapacity(cloudConfig.minVmCount, 'minVmCount');
  validateServiceCapacity(cloudConfig.maxVmCount, 'maxVmCount');
}

function validateVmCapacity(value: number | undefined, field: string): void {
  if (value !== undefined && value !== 1) {
    throw new InvalidAnycloudConfigError(
      `${field} must be exactly 1 for vm workloads`,
    );
  }
}

function validateVmWorkloadShape(args: {
  cloudConfig: CloudConfig;
  dockerOptions?: WorkloadAdmissionInput['dockerOptions'];
  command?: string[];
  inputStorageCredentialName?: string;
  outputStorageCredentialName?: string;
  checkpointStorageCredentialName?: string;
}): void {
  const { cloudConfig, dockerOptions, command } = args;
  if (cloudConfig.spot) {
    throw new InvalidAnycloudConfigError(
      '--spot is not supported for vm workloads',
    );
  }
  if (
    cloudConfig.inputBucket ||
    cloudConfig.outputBucket ||
    cloudConfig.checkpointBucket
  ) {
    throw new InvalidAnycloudConfigError(
      'Buckets are not supported for vm workloads',
    );
  }
  if (
    args.inputStorageCredentialName ||
    args.outputStorageCredentialName ||
    args.checkpointStorageCredentialName ||
    cloudConfig.inputStorageCredentials ||
    cloudConfig.outputStorageCredentials ||
    cloudConfig.checkpointStorageCredentials ||
    cloudConfig.inputStorageRegion ||
    cloudConfig.outputStorageRegion ||
    cloudConfig.checkpointStorageRegion
  ) {
    throw new InvalidAnycloudConfigError(
      'Storage credentials and regions are not supported for vm workloads',
    );
  }
  if (command && command.length > 0) {
    throw new InvalidAnycloudConfigError(
      'Startup commands are not supported for vm workloads; use exec or ssh after creation',
    );
  }
  if (dockerOptions && Object.keys(dockerOptions).length > 0) {
    throw new InvalidAnycloudConfigError(
      'Custom Docker options are not supported for vm workloads',
    );
  }
  validateVmCapacity(cloudConfig.minVmCount, 'minVmCount');
  validateVmCapacity(cloudConfig.maxVmCount, 'maxVmCount');
}

/**
 * A VM Job's `--require-nested-virtualization`: only the
 * VM types the catalog reports nesting for, so GCP's insert isn't refused and
 * AWS and Azure launch with KVM. Refuses when none is left.
 */
export function nestedVmJobTypes(
  config: Pick<
    CloudConfig,
    'cloudProvider' | 'vmType' | 'region' | 'availabilityZone'
  >,
): string | string[] {
  const vmTypes = toArray(config.vmType);
  if (vmTypes.length === 0) {
    throw new InvalidAnycloudConfigError(
      '--require-nested-virtualization needs --vm-type',
    );
  }
  const { cloudProvider: cloud, region, availabilityZone: zone } = config;
  // The types, in order, that the catalog reports nested virtualization for
  // in the region or zone (anywhere when unpinned).
  const kept = vmTypes.filter(
    (vmType) =>
      nestedVirtualizationSupport(cloud, vmType, region, zone) === true,
  );
  if (kept.length === 0) {
    throw new DeployError(
      `--require-nested-virtualization: the ${cloud} catalog reports nested virtualization for none of ${vmTypes.join(', ')}${region ? ` in ${zone ?? region}` : ''}; anycloud vm-types --details shows each type's support`,
      400,
    );
  }
  return kept.length === 1 ? kept[0]! : kept;
}

/**
 * Resolve placement and credentials without performing any durable writes or
 * mutating the caller's request.
 */
export async function resolveWorkloadAdmission(args: {
  actor: User;
  input: WorkloadAdmissionInput;
}): Promise<ResolvedWorkloadAdmission> {
  const { actor, input } = args;
  const cloudConfig = { ...input.cloudConfig };
  const requestedWorkloadType = parseWorkloadType(input.workloadType);
  if (
    requestedWorkloadType === WorkloadType.Service &&
    isHostedApiImage(input.image)
  ) {
    throw new InvalidAnycloudConfigError(
      'VM-hosted APIs are no longer supported. Use `anycloud api create` to host an API, then `anycloud api use` to select it.',
    );
  }

  await inferAvailableCredentiallessCompute({
    cloudConfig,
    credentialName: input.credentialName,
    gpuType: input.gpuType,
  });
  const requestedCredentiallessCompute = normalizeCredentiallessComputeRequest({
    cloudConfig,
    credentialName: input.credentialName,
    gpuType: input.gpuType,
  });

  let resolvedComputeCredential: ResolvedComputeCredential | undefined;
  if (input.credentialName) {
    const resolved = await resolveCredentialByName(input.credentialName);
    if (!resolved) {
      throw new InvalidAnycloudConfigError(
        `Credential "${input.credentialName}" not found`,
      );
    }
    if (!isComputeCredentials(resolved.creds)) {
      throw new InvalidAnycloudConfigError(
        storageOnlyComputeMessage(resolved.cloudProvider),
      );
    }
    resolvedComputeCredential = {
      id: resolved.id,
      name: input.credentialName,
      creds: resolved.creds,
      cloudProvider: resolved.cloudProvider,
    };
    // A saved role connection rides in the resolved config, which only ever
    // accepts keys inline.
    cloudConfig.credentials = extractCredentials(
      resolved.creds,
    ) as typeof cloudConfig.credentials;
    cloudConfig.cloudProvider = resolved.cloudProvider;
  }

  const usingInlineCompute =
    !resolvedComputeCredential && !!cloudConfig.credentials;
  if (
    !resolvedComputeCredential &&
    !usingInlineCompute &&
    !requestedCredentiallessCompute
  ) {
    throw new InvalidAnycloudConfigError(await credentialRequiredMessage());
  }

  if (!cloudConfig.cloudProvider) {
    throw new InvalidAnycloudConfigError(
      usingInlineCompute
        ? '"cloudConfig.cloudProvider" is required when using inline credentials'
        : '"cloudConfig.cloudProvider" could not be resolved',
    );
  }
  const inlineComputeCredentials =
    usingInlineCompute && cloudConfig.credentials
      ? bindInlineCredentials(
          cloudConfig.cloudProvider,
          cloudConfig.credentials,
        )
      : undefined;
  if (cloudConfig.regions) {
    await ensureCatalogReady(cloudConfig.cloudProvider);
  }
  const resolvedCloudConfig: CloudConfig = {
    ...cloudConfig,
    cloudProvider: cloudConfig.cloudProvider,
    credentials: inlineComputeCredentials
      ? extractCredentials(inlineComputeCredentials)
      : cloudConfig.credentials,
    diskTier: normalizeDiskTier(cloudConfig.diskTier),
    ...(cloudConfig.regions && {
      regions: knownRegions(cloudConfig.cloudProvider, cloudConfig.regions),
    }),
    ...(input.noCheckpoint && { noCheckpoint: true }),
  };
  if (input.requireNestedVirtualization) {
    resolvedCloudConfig.vmType = nestedVmJobTypes(resolvedCloudConfig);
  }
  assertDiskPerformance(resolvedCloudConfig);
  // No other checkpoint option goes with --no-checkpoint.
  if (
    input.noCheckpoint &&
    (cloudConfig.checkpointBucket ||
      cloudConfig.checkpointStorageRegion ||
      input.checkpointStorageCredentialName)
  ) {
    throw new InvalidAnycloudConfigError(
      '--no-checkpoint takes no checkpoint storage options.',
    );
  }

  validateDockerOptionsRequest(input.dockerOptions, resolvedCloudConfig);
  if (requestedWorkloadType === WorkloadType.Service) {
    validateServiceWorkloadShape({
      cloudConfig: resolvedCloudConfig,
      inputStorageCredentialName: input.inputStorageCredentialName,
      outputStorageCredentialName: input.outputStorageCredentialName,
    });
  }
  if (requestedWorkloadType === WorkloadType.Vm) {
    validateVmWorkloadShape({
      cloudConfig: resolvedCloudConfig,
      dockerOptions: input.dockerOptions,
      command: input.command,
      inputStorageCredentialName: input.inputStorageCredentialName,
      outputStorageCredentialName: input.outputStorageCredentialName,
      checkpointStorageCredentialName: input.checkpointStorageCredentialName,
    });
  }

  if (input.inputStorageCredentialName) {
    resolvedCloudConfig.inputStorageCredentials = (
      await resolveStorageCredential(input.inputStorageCredentialName, 'Input')
    ).creds;
  }
  if (input.outputStorageCredentialName) {
    resolvedCloudConfig.outputStorageCredentials = (
      await resolveStorageCredential(
        input.outputStorageCredentialName,
        'Output',
      )
    ).creds;
  }
  if (input.checkpointStorageCredentialName) {
    resolvedCloudConfig.checkpointStorageCredentials = (
      await resolveStorageCredential(
        input.checkpointStorageCredentialName,
        'Checkpoint',
      )
    ).creds;
  }

  return {
    [resolvedWorkloadAdmissionBrand]: true,
    actor,
    input,
    requestedWorkloadType,
    requestedCredentiallessCompute,
    resolvedComputeCredential,
    inlineComputeCredentials,
    usingInlineCompute,
    cloudConfig: resolvedCloudConfig,
  };
}

/** At most this many regions in a VM Job's allow-list. */
const MAX_REGIONS = 64;

/**
 * A VM Job's region allow-list, deduped: 1 to 64 regions, each one the
 * provider's catalog names. No globs.
 */
export function knownRegions(
  cloudProvider: CloudType,
  regions: readonly string[],
): string[] {
  const unique = [...new Set(regions)];
  if (unique.length === 0 || unique.length > MAX_REGIONS) {
    throw new InvalidAnycloudConfigError(
      `--regions takes 1 to ${MAX_REGIONS} regions`,
    );
  }
  const catalog = new Set(getRegions(cloudProvider));
  const unknown = unique.filter((region) => !catalog.has(region));
  if (unknown.length > 0) {
    throw new InvalidAnycloudConfigError(
      `--regions names ${unknown.join(', ')}, which ${cloudProvider} does not offer; see anycloud regions ${cloudProvider.toLowerCase()}`,
    );
  }
  return unique;
}

/**
 * A VM Job's own root volume IOPS and MiB/s: on a cloud whose root volume
 * takes them, within its limits, and on a root big enough for the IOPS. The
 * root is never grown to fit, since that changes the Job's cost.
 */
export function assertDiskPerformance(config: CloudConfig): void {
  if (
    config.diskIops === undefined &&
    config.diskThroughputMibps === undefined
  ) {
    return;
  }
  const limits = isComputeProvider(config.cloudProvider)
    ? computeProviderData(config.cloudProvider).diskPerformance
    : undefined;
  if (!limits) {
    throw new InvalidAnycloudConfigError(
      '--disk-iops/--disk-throughput take AWS gp3 or GCP Hyperdisk Balanced; pin the Job to AWS or GCP',
    );
  }
  // The launch fills the default tier the same way.
  const invalid = diskPerformanceError(
    limits,
    config,
    config.diskTier ?? DEFAULT_DISK_TIER,
  );
  if (invalid) throw new InvalidAnycloudConfigError(invalid);
  const vmTypes = toArray(config.vmType);
  const { bootsVmType } = limits;
  if (bootsVmType && vmTypes.length > 0 && !vmTypes.some(bootsVmType)) {
    throw new InvalidAnycloudConfigError(
      `--disk-iops/--disk-throughput set ${limits.volume}, which none of ${vmTypes.join(', ')} boots from`,
    );
  }
  if (config.diskIops === undefined) return;
  // The Job's own IOPS never grow its root. Without --disk-size, a GCP
  // Job's Hyperdisk is 100 GiB; an AWS CPU VM Job's root is 30 GiB and a GPU
  // AMI's is its own, checked at launch.
  const minimumSizeGb = diskMinimumSizeGb(config.diskIops);
  // Any CPU type in the list may be the one launched, with a 30 GiB root.
  const anyCpu =
    vmTypes.length > 0 &&
    vmTypes.some(
      (type) => gpuRuntimeForVMType(config.cloudProvider, type) === null,
    );
  const sizeGb =
    config.diskSizeGb ??
    limits.defaultSizeGb ??
    (anyCpu ? JOB_HOST_DISK_GB : undefined);
  if (sizeGb !== undefined && sizeGb < minimumSizeGb) {
    throw new InvalidAnycloudConfigError(
      `${config.diskIops} IOPS needs a root volume of at least ${minimumSizeGb} GiB (500 IOPS per GiB); pass --disk-size ${minimumSizeGb} or more`,
    );
  }
}
