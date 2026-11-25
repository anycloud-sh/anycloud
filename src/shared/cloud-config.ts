/**
 * CloudConfig utilities.
 * Functions for working with CloudConfig across CLI and API.
 */

import {
  CloudType,
  CloudConfig,
  CloudflareCreds,
  CloudCredentials,
  type ComputeCloudCredentials,
  type ComputeCreds,
  DiskTier,
  DISK_TIER_VALUES,
  isDiskTier,
  GpuRuntime,
} from './cloud.js';
import { DockerOptions } from './runtime.js';
import { DeployError, InvalidAnycloudConfigError } from './errors.js';
import { readCatalog, type CatalogIndexes } from './catalog/index.js';
import {
  ComputeCredentialMode,
  PROVIDER_DATA,
  acceleratorRuntimeForProviderVMType,
  CheckpointStorageSource,
  computeProviderData,
  isComputeProvider,
} from './providers.js';
import { assertNever } from './assert-never.js';
import { type ImageArchitecture, ImageRuntime } from './image.js';
import { toArray } from './utils.js';

function requireCatalog(cloud: CloudType) {
  const catalog = readCatalog(cloud);
  if (!catalog) {
    throw new Error(
      `No catalog data for ${cloud}. Catalogs are fetched on first run; check network access to raw.githubusercontent.com.`,
    );
  }
  return catalog;
}

export function normalizeDiskTier(
  value: string | null | undefined,
): DiskTier | undefined {
  if (value === null || value === undefined) return undefined;
  if (isDiskTier(value)) return value;
  throw new InvalidAnycloudConfigError(
    `--disk-tier must be one of: ${DISK_TIER_VALUES.join(', ')}`,
  );
}

export const DEFAULT_DISK_TIER = DiskTier.High;

/**
 * Whether a disk tier maps to premium/fast SSD-class storage (as opposed to the
 * standard-performance tier). `high` and `ultra` do; `medium` does not. On
 * Azure this determines whether the OS disk requests Premium_LRS (which requires
 * a premium-capable VM size); it is the single source of truth for the
 * high/ultra → premium mapping, reused by the Azure gateway's SKU selection and
 * by the optimizer's premium-capable candidate filter.
 */
export function diskTierRequiresPremiumStorage(tier?: DiskTier): boolean {
  return tier === DiskTier.High || tier === DiskTier.Ultra;
}

// Capability is no longer a central boolean table. Runtime services are exposed
// by explicit server-side factories/roles (for example CloudCompute and
// CloudStorage) and narrowed with capability guards only on the branded object
// that owns that role. Inert classifications/facts (credential mode, defaults,
// catalog file, quota-API) live in PROVIDER_DATA (./providers.ts).
// Capability validation that needs runtime providers lives server-side in
// api/services/cloud-config.ts.

/**
 * Whether compute selection for this provider requires a real compute
 * credential. Credentialless providers are selected as API-instance
 * capabilities, not as named or inline cloud credentials.
 */
export function requiresComputeCredentials(provider: CloudType): boolean {
  return (
    computeProviderData(provider).computeCredentialMode ===
    ComputeCredentialMode.CloudCredentials
  );
}

export function supportsRegionFailover(provider: CloudType): boolean {
  return computeProviderData(provider).supportsRegionFailover;
}

/**
 * Whether the provider honors `--disk-tier` for performance disk selection
 * (AWS, GCP, and Azure today). The single source of truth for the per-cloud gate — replaces
 * a hardcoded cloud list, so a future disk-tier cloud opts in via PROVIDER_DATA.
 */
export function supportsDiskTier(provider: CloudType): boolean {
  return computeProviderData(provider).supportsDiskTier;
}

export function requiresExplicitCheckpointStorage(
  provider: CloudType,
): boolean {
  return (
    computeProviderData(provider).checkpointStorageSource ===
    CheckpointStorageSource.ExplicitStorageCredential
  );
}

export function cloudCredentialIdentityKey(
  cloud: CloudType,
  credentials: Record<string, string> | undefined,
  fallback: string,
): string {
  const { tag, accountFields } = PROVIDER_DATA[cloud].credentialIdentity;
  if (accountFields.length === 0) return JSON.stringify([tag, fallback]);

  // The last account field falls back to the credential name; earlier fields to
  // '' (they qualify the identity but don't carry it on their own).
  const last = accountFields.length - 1;
  const components = accountFields.map(
    (field, i) => credentials?.[field] ?? (i === last ? fallback : ''),
  );
  return JSON.stringify([tag, ...components]);
}

/** Narrow an arbitrary string (raw query param, stored value) to a CloudType. */
export function isCloudType(value: string): value is CloudType {
  return (Object.values(CloudType) as string[]).includes(value);
}

/** S3 and GCS both refuse names formatted as an IPv4 address. */
function rejectIpAddressName(name: string, service: string): void {
  if (/^\d+(?:\.\d+){3}$/.test(name)) {
    throw new DeployError(
      `Invalid bucket name '${name}': ${service} bucket names must not be formatted as an IP address.`,
      400,
    );
  }
}

// S3 refuses to create general purpose buckets with these, but access point
// aliases (`-s3alias`), directory buckets (`--x-s3`) and account regional
// namespace buckets (`-an`) are valid names for existing storage, so only
// names Anycloud creates are checked. S3 allows `-an` only for account
// regional namespace creates, which Anycloud's CreateBucketCommand doesn't do.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
const S3_RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const S3_RESERVED_SUFFIXES = [
  '-s3alias',
  '--ol-s3',
  '.mrap',
  '--x-s3',
  '--table-s3',
  '-an',
];

/**
 * Validate a name Anycloud will create a bucket under: the cloud's general
 * rule, plus S3's reserved prefixes and suffixes. Throws DeployError(400).
 */
export function validateNewBucketName(cloud: CloudType, name: string): void {
  validateBucketName(cloud, name);
  if (cloud !== CloudType.AWS) return;
  const prefix = S3_RESERVED_PREFIXES.find((p) => name.startsWith(p));
  const suffix = S3_RESERVED_SUFFIXES.find((s) => name.endsWith(s));
  if (prefix || suffix) {
    throw new DeployError(
      `Invalid bucket name '${name}': S3 reserves the ${prefix ? `prefix "${prefix}"` : `suffix "${suffix}"`} for new buckets.`,
      400,
    );
  }
}

/**
 * Validate a user-supplied bucket/container name against the target cloud's naming rules.
 * Throws DeployError(400) on violation so the workload transitions directly to Invalid
 * (no Retrying) via isUserError() in runStep.
 *
 * Catching bad names here avoids relying on the cloud SDK's error shape to classify
 * correctly — some SDK errors don't match the gateway's classifyError patterns and
 * end up as Transient, triggering a spurious retry.
 */
export function validateBucketName(cloud: CloudType, name: string): void {
  // GCS allows dotted (domain-named) buckets up to 222 chars, with each
  // dot-separated component <=63. AWS/Azure cap at 63.
  // https://cloud.google.com/storage/docs/buckets#name-requirements
  const hasDot = name.includes('.');
  const maxLen = cloud === CloudType.GCP && hasDot ? 222 : 63;
  if (name.length < 3 || name.length > maxLen) {
    throw new DeployError(
      `Invalid bucket name '${name}': must be 3–${maxLen} characters.`,
      400,
    );
  }
  switch (cloud) {
    case CloudType.AWS:
      // https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
      if (
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) ||
        /\.\./.test(name)
      ) {
        throw new DeployError(
          `Invalid bucket name '${name}': S3 bucket names must contain only lowercase letters, numbers, hyphens, and dots, must start/end with a letter or number, and must not contain consecutive dots.`,
          400,
        );
      }
      rejectIpAddressName(name, 'S3');
      break;
    case CloudType.Azure:
      // https://learn.microsoft.com/en-us/rest/api/storageservices/naming-and-referencing-containers--blobs--and-metadata
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || /--/.test(name)) {
        throw new DeployError(
          `Invalid bucket name '${name}': Azure container names must contain only lowercase letters, numbers, and hyphens, must start/end with a letter or number, and must not contain consecutive hyphens.`,
          400,
        );
      }
      break;
    case CloudType.GCP:
      if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name)) {
        throw new DeployError(
          `Invalid bucket name '${name}': GCS bucket names must contain only lowercase letters, numbers, hyphens, underscores, and dots, and must start/end with a letter or number.`,
          400,
        );
      }
      rejectIpAddressName(name, 'GCS');
      if (
        name.startsWith('goog') ||
        name.includes('google') ||
        name.includes('g00gle')
      ) {
        throw new DeployError(
          `Invalid bucket name '${name}': GCS bucket names cannot begin with "goog" or contain "google" or "g00gle".`,
          400,
        );
      }
      if (
        hasDot &&
        name.split('.').some((c) => c.length === 0 || c.length > 63)
      ) {
        throw new DeployError(
          `Invalid bucket name '${name}': GCS dot-separated components must be 1–63 characters each.`,
          400,
        );
      }
      break;
    case CloudType.Local:
      if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name)) {
        throw new DeployError(
          `Invalid bucket name '${name}': Local harness bucket names must contain only lowercase letters, numbers, hyphens, underscores, and dots, and must start/end with a letter or number.`,
          400,
        );
      }
      break;
    case CloudType.Cloudflare:
      // https://developers.cloudflare.com/r2/buckets/create-buckets/
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
        throw new DeployError(
          `Invalid bucket name '${name}': R2 bucket names must contain only lowercase letters, numbers, and hyphens, and must start/end with a letter or number.`,
          400,
        );
      }
      break;
    case CloudType.Lambda:
      // Lambda: no native storage — cross-cloud S3 bucket names
      // follow the AWS rules, validated under the AWS case.
      break;
    default:
      assertNever(cloud);
  }
}

/** Parse the shared `type[:positive-count]` GPU request syntax. */
export function parseGpuType(gpuType: string): {
  name: string;
  count: number;
} {
  const normalized = gpuType.trim();
  const parts = normalized.split(':');
  const name = parts[0]?.trim() ?? '';
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (parts.length > 2 || name.length === 0 || hasControlCharacter) {
    throw new InvalidAnycloudConfigError(
      `Invalid GPU request "${gpuType}". Use format: h100 or h100:8`,
    );
  }

  const countText = parts[1];
  if (countText !== undefined && !/^[1-9][0-9]*$/.test(countText)) {
    throw new InvalidAnycloudConfigError(
      `Invalid GPU count in "${gpuType}". Use format: h100 or h100:8`,
    );
  }
  const count = Number(countText ?? '1');
  if (!Number.isSafeInteger(count)) {
    throw new InvalidAnycloudConfigError(
      `Invalid GPU count in "${gpuType}". Use format: h100 or h100:8`,
    );
  }
  return { name: name.toUpperCase(), count };
}

/**
 * Resolve a GPU type string (e.g. "h100", "h100:8") to the cloud-specific
 * VM instance type. Uses the catalog's AcceleratorName index for every cloud.
 *
 * Returns the original string unchanged if it's not a known accelerator name.
 */
export function resolveVMType(
  gpuType: string,
  cloudProvider: CloudType,
): string {
  return resolveVMTypeFromCatalog(gpuType, readCatalog(cloudProvider));
}

/** Resolve a GPU alias against an already-parsed catalog. */
export function resolveVMTypeFromCatalog(
  gpuType: string,
  catalog: CatalogIndexes | undefined,
): string {
  const { name, count } = parseGpuType(gpuType);
  if (!catalog) return gpuType;

  const entries = catalog.typesPerAccelerator[name];
  if (!entries) return gpuType;

  // Filter by requested count, pick cheapest (already sorted by price)
  const match = entries.find((e) => e.count === count);
  if (match) return match.instanceType;

  return gpuType;
}

/**
 * Resolve a gpuType string to all interchangeable VM types.
 *
 * "Interchangeable" = same GPU name, same GPU count, same vCPUs. Host RAM may
 * differ: sibling SKUs of the same accelerator (e.g. Lambda's H100 pcie vs sxm5)
 * are valid capacity fallbacks for a GPU-alias request even when their attached
 * host memory differs slightly. The primary (cheapest) type is always first.
 */
export function resolveVMTypes(
  gpuType: string,
  cloudProvider: CloudType,
): string[] {
  const primary = resolveVMType(gpuType, cloudProvider);
  const { name, count } = parseGpuType(gpuType);

  const catalog = readCatalog(cloudProvider);
  if (!catalog) return [primary];

  const entries = catalog.typesPerAccelerator[name];
  if (!entries) return [primary];

  // Find primary's specs
  const primaryEntry = entries.find(
    (e) => e.instanceType.toLowerCase() === primary.toLowerCase(),
  );
  if (!primaryEntry) return [primary];

  // Find all matches: same GPU count and same vCPUs. Host RAM is intentionally
  // NOT required to match — that would exclude a same-accelerator sibling SKU
  // (Lambda H100 pcie=200GiB vs sxm5=225GiB) and strand the request on whichever
  // variant happens to be capacity-blocked. Equal vCPUs still keeps deliberate
  // size tiers apart (e.g. AWS g5.xlarge vs g5.2xlarge).
  const matches = entries
    .filter((e) => e.count === count && e.vCPUs === primaryEntry.vCPUs)
    .map((e) => e.instanceType);

  // Primary first, then alternatives (already price-sorted from catalog)
  if (matches.length === 0) return [primary];
  return [
    primary,
    ...matches.filter((m) => m.toLowerCase() !== primary.toLowerCase()),
  ];
}

/**
 * Get available GPU/accelerator names for a cloud provider.
 */
export function getAvailableGPUs(cloudProvider: CloudType): string[] {
  const gpus = new Set<string>();

  const catalog = readCatalog(cloudProvider);
  if (catalog) {
    for (const name of Object.keys(catalog.typesPerAccelerator)) {
      gpus.add(name);
    }
  }

  return [...gpus].sort();
}

// Provider defaults used when neither region nor vmType is defined by the user.
/**
 * Complete a CloudConfig with default values for missing region/vmType.
 * Returns a new object without mutating the input.
 *
 * `config.vmType` may be a fallback array — gateway-facing callers like
 * `validateCredentials` run before `resolveProvisioningConfig` collapses it,
 * so we walk the array here to find the first catalog-resolvable entry.
 */
declare const resolvedPlacement: unique symbol;

/**
 * Compile-time proof completeCloudConfig ran. Provider-dependent optionals may
 * remain absent; ownership lookup may deliberately clear availabilityZone.
 */
export interface ResolvedCloudConfig extends CloudConfig {
  readonly [resolvedPlacement]: true;
}

export function completeCloudConfig(
  config: CloudConfig,
  /** `zone: false` for configs with no placement, such as storage clients. */
  options: { readonly zone?: boolean } = {},
): ResolvedCloudConfig {
  // A storage-only provider has no placement to complete.
  if (!isComputeProvider(config.cloudProvider)) {
    const storageOnly = { ...config };
    return storageOnly as ResolvedCloudConfig;
  }
  // Walk fallback arrays to the first entry that exists in the catalog (after
  // GPU-alias resolution). Mirrors buildCloudConfig's gpuType walk: a list
  // like ['fake', 'real'] would otherwise crash below in getRegionByVMType
  // when region is omitted. Fall back to vmType[0] if nothing resolves so
  // single-fake-vmType errors surface unchanged downstream.
  let result: CloudConfig = config;
  if (Array.isArray(config.vmType)) {
    const resolvable = config.vmType.find(
      (vt) =>
        getRegionsForVMType(
          resolveVMType(vt, config.cloudProvider),
          config.cloudProvider,
        ).length > 0,
    );
    result = { ...config, vmType: resolvable ?? config.vmType[0] };
  }
  // Resolve GPU aliases (e.g. "h100" → "p5.48xlarge" on AWS)
  if (typeof result.vmType === 'string') {
    const resolved = resolveVMType(result.vmType, result.cloudProvider);
    if (resolved !== result.vmType) {
      result = { ...result, vmType: resolved };
    }
  }
  if (!result.vmType && !result.region) {
    const defaults = computeProviderData(result.cloudProvider);
    result = {
      ...result,
      region: defaults.defaultRegion,
      vmType: defaults.defaultVmType,
    };
  } else if (!result.vmType && result.region) {
    result = {
      ...result,
      vmType: computeProviderData(result.cloudProvider).defaultVmType,
    };
  } else if (!result.region && typeof result.vmType === 'string') {
    result = {
      ...result,
      region: getRegionByVMType(result.vmType, result.cloudProvider),
    };
  }
  // Resolve zone if region was resolved but zone wasn't specified
  if (options.zone !== false && result.region && !result.availabilityZone) {
    const zone = resolveZone(
      result.region,
      result.cloudProvider,
      typeof result.vmType === 'string' ? result.vmType : undefined,
    );
    if (zone) result = { ...result, availabilityZone: zone };
  }
  if (result.diskTier === undefined && supportsDiskTier(result.cloudProvider)) {
    result = { ...result, diskTier: DEFAULT_DISK_TIER };
  }
  const completed = { ...result };
  return completed as ResolvedCloudConfig;
}

/**
 * Get all regions that offer a given VM type.
 * Used by the provisioning scheduler to build a failover candidate list
 * when the user omits region.
 */
export function getRegionsForVMType(
  vmType: string,
  cloudProvider: CloudType,
  spot?: boolean,
): string[] {
  const provider = computeProviderData(cloudProvider);
  if (provider.catalogFile === null) return [provider.defaultRegion];
  const catalog = requireCatalog(cloudProvider);
  const typeKey = vmType.toLowerCase();
  const entries = catalog.regionsPerType[typeKey] ?? [];
  // GCP catalog uses zones (us-central1-a) as keys — extract regions
  const regions =
    cloudProvider === CloudType.GCP
      ? [...new Set(entries.map(extractGCPRegion))]
      : entries;
  // Rank every region by catalog price without a geographic preference.
  // Region name is the deterministic tie-breaker, including when pricing is
  // unavailable (missing prices sort after priced regions).
  const prices = spot
    ? catalog.spotPricePerTypeRegion[typeKey]
    : catalog.pricePerTypeRegion[typeKey];
  return [...regions].sort((a, b) => {
    const aPrice = prices?.[a] ?? Infinity;
    const bPrice = prices?.[b] ?? Infinity;
    if (aPrice < bPrice) return -1;
    if (aPrice > bPrice) return 1;
    return a.localeCompare(b);
  });
}

/**
 * vCPU count for a VM type from the catalog. Used for quota checks and resource mapping (quotas are measured in vCPUs).
 */
export function getVCPUsForVMType(
  vmType: string,
  cloudProvider: CloudType,
): number | undefined {
  const catalog = readCatalog(cloudProvider);
  if (!catalog) return undefined;
  return catalog.vCPUsPerType[vmType.toLowerCase()];
}

/**
 * Get the cheapest available region for a VM type.
 * Delegates to getRegionsForVMType to ensure GCP zones are converted to regions.
 */
export function getRegionByVMType(
  vmType: string,
  cloudProvider: CloudType,
): string {
  const regions = getRegionsForVMType(vmType, cloudProvider);
  if (!regions.length) {
    throw new Error(
      `No regions available for VM type "${vmType}" on ${cloudProvider}`,
    );
  }
  return regions[0]; // Already globally price-sorted by getRegionsForVMType
}

/**
 * Extract region from GCP zone
 * GCP zones follow the pattern: {region}-{zone-letter}
 * where zone-letter is a single lowercase letter (a-z)
 *
 * Examples:
 *   - 'us-central1-a' -> 'us-central1'
 *   - 'europe-west1-b' -> 'europe-west1'
 *   - 'asia-east1-c' -> 'asia-east1'
 */
export function extractGCPRegion(zone: string): string {
  const parts = zone.split('-');
  // Check if last part is a single letter (zone suffix)
  if (parts.length >= 3 && /^[a-z]$/.test(parts[parts.length - 1])) {
    // Remove zone suffix to get region
    return parts.slice(0, -1).join('-');
  }
  // If not a standard zone format, return as-is
  return zone;
}

/**
 * Get available zone suffixes for a GCP region
 * Returns just the suffix letters (e.g., ["a", "b", "c", "f"])
 * Only returns zones that have at least one VM type available
 */
export function getZoneSuffixes(region: string): string[] {
  const catalog = requireCatalog(CloudType.GCP);
  const allZones = Object.keys(catalog.typesPerRegion);
  const matchingZones = allZones.filter((zone) =>
    zone.startsWith(`${region}-`),
  );

  // Extract suffixes (everything after "region-") and filter out zones with no VM types
  const suffixes = matchingZones
    .filter((zone) => catalog.typesPerRegion[zone].length > 0)
    .map((zone) => zone.substring(region.length + 1))
    .filter((suffix) => /^[a-z]$/.test(suffix))
    .sort();

  return suffixes;
}

/**
 * Return GCP zone suffixes in a region that offer this exact VM type.
 *
 * Unlike getZoneSuffixes(), this query never falls back to a zone merely
 * because some unrelated machine type is present there. GCP catalogs retain
 * AvailabilityZone in regionsPerType, so no catalog schema change is needed.
 */
export function getZonesForVMType(region: string, vmType: string): string[] {
  const catalog = requireCatalog(CloudType.GCP);
  const zones = catalog.regionsPerType[vmType.toLowerCase()] ?? [];
  return zones
    .filter((zone) => extractGCPRegion(zone) === region)
    .map((zone) => zone.substring(region.length + 1))
    .filter((suffix) => /^[a-z]$/.test(suffix))
    .sort();
}

/**
 * Resolve availability zone for a region.
 * GCP: picks the first zone that offers vmType when supplied; legacy callers
 * without a type receive the first generally available zone.
 * AWS/Azure/others: returns undefined (zones handled by provider or skipped).
 */
export function resolveZone(
  region: string,
  cloudProvider: CloudType,
  vmType?: string,
): string | undefined {
  if (cloudProvider !== CloudType.GCP) return undefined;
  const suffixes = vmType
    ? getZonesForVMType(region, vmType)
    : getZoneSuffixes(region);
  return suffixes[0];
}

/**
 * Validate only the provider-level shape of a GCP zone suffix. Lifecycle
 * gateways use this check because an existing resource must remain addressable
 * even after its placement disappears from the current catalog.
 */
export function validateGCPZoneSuffixSyntax(zoneSuffix: string): void {
  if (!/^[a-z]$/.test(zoneSuffix)) {
    throw new Error(
      `Invalid GCP zone suffix "${zoneSuffix}". Must be a single letter (e.g., "a", "b", "c")`,
    );
  }
}

/**
 * Get all available regions for a cloud provider.
 */
export function getRegions(cloudProvider: CloudType): string[] {
  const provider = computeProviderData(cloudProvider);
  if (provider.catalogFile === null) return [provider.defaultRegion];

  const catalog = requireCatalog(cloudProvider);
  if (cloudProvider === CloudType.GCP) {
    // Extract unique regions from zones
    const zones = Object.keys(catalog.typesPerRegion);
    const regions = new Set(zones.map((zone) => extractGCPRegion(zone)));
    return Array.from(regions).sort();
  }
  return Object.keys(catalog.typesPerRegion);
}

/**
 * Get available VM types for a cloud provider and region.
 */
export function getVMTypes(cloudProvider: CloudType, region: string): string[] {
  const provider = computeProviderData(cloudProvider);
  if (provider.catalogFile === null) return [provider.defaultVmType];

  const catalog = requireCatalog(cloudProvider);
  const types = catalog.typesPerRegion[region];
  if (types || cloudProvider !== CloudType.GCP) return types || [];
  // GCP offerings are keyed by zone; a region offers what any of its zones does.
  return [
    ...new Set(
      Object.entries(catalog.typesPerRegion).flatMap(([zone, zoneTypes]) =>
        extractGCPRegion(zone) === region ? zoneTypes : [],
      ),
    ),
  ].sort();
}

/**
 * Catalog-reported nested virtualization support at a placement: a GCP zone,
 * a region (on GCP, true when any of its zones is), or anywhere when
 * unpinned; null when unknown. `region` may name a GCP zone, as in vm-types.
 */
export function nestedVirtualizationSupport(
  cloudProvider: CloudType,
  vmType: string,
  region?: string | null,
  zone?: string | null,
): boolean | null {
  const gcp = cloudProvider === CloudType.GCP;
  // Launch targets name a GCP zone by its suffix (`a`); the catalog keys
  // zones in full (`us-central1-a`).
  const gcpZone =
    gcp && zone && region && !zone.startsWith(`${region}-`)
      ? `${region}-${zone}`
      : zone;
  const known = Object.entries(
    readCatalog(cloudProvider)?.nestedVirtualizationPerTypeRegion[
      vmType.toLowerCase()
    ] ?? {},
  )
    .filter(([key]) =>
      gcp && gcpZone
        ? key === gcpZone
        : !region ||
          key === region ||
          (gcp && extractGCPRegion(key) === region),
    )
    .map(([, supported]) => supported);
  return known.includes(true) ? true : known.length > 0 ? false : null;
}

/** The CPU architecture of a VM type: arm64 when its catalog says so, else amd64. */
export function vmArchitecture(
  cloudProvider: CloudType,
  vmType: string,
): ImageArchitecture {
  return readCatalog(cloudProvider)?.arm64Types.includes(vmType.toLowerCase())
    ? 'arm64'
    : 'amd64';
}

/** A workload's architecture: admission keeps its type list to one. */
export function workloadArchitecture(workload: {
  cloudProvider: CloudType | null;
  vmType: string | string[] | null;
}): ImageArchitecture {
  const [vmType] = toArray(workload.vmType);
  return workload.cloudProvider && vmType
    ? vmArchitecture(workload.cloudProvider, vmType)
    : 'amd64';
}

/**
 * Get GPU VM types available in a region, optionally filtered by accelerator name.
 * Pass a specific accelerator (e.g. "H100") or "*" for all GPU types.
 */
export function getGPUVMTypes(
  cloudProvider: CloudType,
  region: string,
  accelerator?: string,
): string[] {
  const allTypes = new Set(getVMTypes(cloudProvider, region));
  if (allTypes.size === 0) return [];

  const gpuTypes = new Set<string>();
  const filterName =
    accelerator && accelerator !== '*' ? accelerator.toUpperCase() : undefined;

  const catalog = readCatalog(cloudProvider);
  if (catalog) {
    const accelerators = filterName
      ? [[filterName, catalog.typesPerAccelerator[filterName]] as const]
      : Object.entries(catalog.typesPerAccelerator);

    for (const [, entries] of accelerators) {
      if (!entries) continue;
      for (const entry of entries) {
        if (allTypes.has(entry.instanceType)) gpuTypes.add(entry.instanceType);
      }
    }
  }

  return [...gpuTypes].sort();
}

/**
 * True when a VM type appears in the catalog's accelerator index.
 * Case-insensitive because Azure catalog casing can vary between sources.
 */
export function isGPUVMType(cloudProvider: CloudType, vmType: string): boolean {
  const catalog = readCatalog(cloudProvider);
  if (!catalog) return false;

  const target = vmType.toLowerCase();
  return Object.values(catalog.typesPerAccelerator).some((entries) =>
    entries.some((entry) => entry.instanceType.toLowerCase() === target),
  );
}

/** True when the catalog explicitly classifies a VM type as CPU-only. */
export function isCPUVMType(cloudProvider: CloudType, vmType: string): boolean {
  const catalog = readCatalog(cloudProvider);
  if (!catalog) return false;

  const target = vmType.toLowerCase();
  return catalog.cpuTypes.some((entry) => entry.toLowerCase() === target);
}

/**
 * Reverse-lookup the catalog accelerator NAME for a resolved instance type.
 *
 * The catalog only indexes types per accelerator NAME (typesPerAccelerator),
 * not the raw per-entry acceleratorName, so we scan the index for the key whose
 * entries contain this instance type. Case-insensitive (Azure catalog casing is
 * inconsistent). Returns undefined for CPU types and types absent from the
 * accelerator index (e.g. an Azure SKU with a blank acceleratorName field).
 */
export function gpuAcceleratorName(
  cloudProvider: CloudType,
  vmType: string,
): string | undefined {
  return gpuAcceleratorNameFromCatalog(readCatalog(cloudProvider), vmType);
}

/** Reverse-lookup an accelerator in an already-parsed catalog. */
function gpuAcceleratorNameFromCatalog(
  catalog: CatalogIndexes | undefined,
  vmType: string,
): string | undefined {
  if (!catalog) return undefined;

  const target = vmType.toLowerCase();
  for (const [name, entries] of Object.entries(catalog.typesPerAccelerator)) {
    if (entries.some((entry) => entry.instanceType.toLowerCase() === target)) {
      return name;
    }
  }
  return undefined;
}

// Accelerator-name classifiers, validated against the live AWS/GCP/Azure/Lambda
// catalogs (getAvailableGPUs enumerates the real names). Anything that is not
// recognized NVIDIA, AMD, or AWS Neuron is 'unsupported' — we DO NOT default
// unknown → cuda, which would silently boot a CUDA image on the wrong
// accelerator.
const AMD_ACCELERATOR = /\bMI\d|instinct|radeon/i;
// Inferentia1 deliberately stays unsupported: current Neuron DLAMIs no longer
// support it. Inferentia2 and the Trainium generations use the Neuron runtime.
const NEURON_ACCELERATOR = /^(?:Inferentia2|Trainium|Trainium2|Trainium3)$/i;
// NVIDIA datacenter + workstation accelerator families present in the catalog:
// A100/A100-80GB, A10/A10G, H100/H100-MEGA, H200, V100/V100-32GB, T4/T4g, L4,
// L40/L40S, K80, P100, P40, M60, A40, A6000, GH200, B200/B300, RTX* (RTX6000,
// RTXPRO6000, RTX-PRO-6000, etc.).
const NVIDIA_ACCELERATOR =
  /^(A100|A10G?|H100|H200|V100|T4G?|L4|L40S?|K80|P100|P40|M60|A40|A6000|GH200|B[23]00|RTX)/i;

function classifyAcceleratorName(name: string): GpuRuntime {
  if (NEURON_ACCELERATOR.test(name)) return GpuRuntime.Neuron;
  if (AMD_ACCELERATOR.test(name)) return GpuRuntime.Rocm;
  if (NVIDIA_ACCELERATOR.test(name)) return GpuRuntime.Cuda;
  return GpuRuntime.Unsupported;
}

/**
 * Classify the GPU runtime a RESOLVED vm-host target requires from its base
 * image. Returns `null` for CPU vm types, where there is no decision to make.
 *
 * Otherwise classify by the resolved accelerator: AMD → 'rocm', NVIDIA →
 * 'cuda', AWS Inferentia2/Trainium → 'neuron', everything else →
 * 'unsupported'. Built from REAL catalog accelerator names; unknown is NEVER
 * treated as cuda.
 *
 * Azure data-quality fallback: a few MI300X SKUs (e.g. Standard_ND96is_MI300X_v5,
 * no trailing 'r') ship with a blank acceleratorName and are missing from
 * typesPerAccelerator, so the reverse-lookup returns undefined and isGPUVMType
 * is false. Catch those by instance-type NAME so they classify 'rocm', not null.
 */
export function gpuRuntimeForVMType(
  cloudProvider: CloudType,
  vmType: string,
): GpuRuntime | null {
  return gpuRuntimeForVMTypeFromCatalog(
    cloudProvider,
    vmType,
    readCatalog(cloudProvider),
  );
}

/**
 * True when the catalog reports an accelerator on this VM type but no name for
 * it, so `gpuRuntimeForVMType` returns null for "unknown runtime" rather than
 * "no accelerator". Callers that reject non-CUDA targets must not treat these
 * as CPU-only.
 */
export function hasUnclassifiedAccelerator(
  cloudProvider: CloudType,
  vmType: string,
): boolean {
  const catalog = readCatalog(cloudProvider);
  if (!catalog) return false;
  return catalog.unnamedAcceleratorTypes.includes(vmType.toLowerCase());
}

/** GPU count for a concrete catalog VM type, or undefined when unknown. */
export function gpuCountForVMType(
  cloudProvider: CloudType,
  vmType: string,
): number | undefined {
  const catalog = readCatalog(cloudProvider);
  if (!catalog) return undefined;

  const target = vmType.toLowerCase();
  let count: number | undefined;
  for (const entries of Object.values(catalog.typesPerAccelerator)) {
    for (const entry of entries) {
      if (entry.instanceType.toLowerCase() !== target) continue;
      count = Math.max(count ?? 0, entry.count);
    }
  }
  return count;
}

type GpuCapability =
  | { kind: 'cpu' }
  | { kind: 'nvidia'; count: number | undefined }
  | { kind: 'non-cuda'; runtime: GpuRuntime }
  | { kind: 'unknown' };

/** Distinguish verified CPU capacity from missing accelerator facts. */
export function gpuCapabilityForVMType(
  cloudProvider: CloudType,
  vmType: string,
): GpuCapability {
  const runtime = gpuRuntimeForVMType(cloudProvider, vmType);
  if (runtime === GpuRuntime.Cuda) {
    const count = gpuCountForVMType(cloudProvider, vmType);
    return {
      kind: 'nvidia',
      count:
        count !== undefined && Number.isSafeInteger(count) && count > 0
          ? count
          : undefined,
    };
  }
  if (runtime !== null) return { kind: 'non-cuda', runtime };
  return isCPUVMType(cloudProvider, vmType)
    ? { kind: 'cpu' }
    : { kind: 'unknown' };
}

/** Image runtime constrains accelerator compatibility without granting GPUs. */
export function isImageRuntimeCompatible(
  cloudProvider: CloudType,
  vmType: string,
  imageRuntime: ImageRuntime | null | undefined,
): boolean {
  if (
    imageRuntime !== ImageRuntime.Cuda &&
    imageRuntime !== ImageRuntime.Rocm
  ) {
    return true;
  }
  const runtime = gpuRuntimeForVMType(cloudProvider, vmType);
  if (runtime === null) return true;
  return (
    (runtime === GpuRuntime.Cuda && imageRuntime === ImageRuntime.Cuda) ||
    (runtime === GpuRuntime.Rocm && imageRuntime === ImageRuntime.Rocm)
  );
}

/** Classify a VM against an already-parsed catalog. */
export function gpuRuntimeForVMTypeFromCatalog(
  cloudProvider: CloudType,
  vmType: string,
  catalog: CatalogIndexes | undefined,
): GpuRuntime | null {
  const accelerator = gpuAcceleratorNameFromCatalog(catalog, vmType);
  if (accelerator) return classifyAcceleratorName(accelerator);

  // Provider capability-owned family rules preserve recognition when a newly
  // released size/generation has not landed in the local catalog yet.
  const providerRuntime = acceleratorRuntimeForProviderVMType(
    cloudProvider,
    vmType,
  );
  if (providerRuntime !== null) return providerRuntime;

  // Catalog data-quality fallback for AMD SKUs with a blank acceleratorName
  // field (so absent from the accelerator index) — recover them by name.
  if (/MI300X|MI25/i.test(vmType)) return GpuRuntime.Rocm;

  return null;
}

function usesNvidiaGpuAccess(
  cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
  dockerOptions: DockerOptions | null,
): boolean {
  const gpuRuntime =
    typeof cloudConfig.vmType === 'string'
      ? gpuRuntimeForVMType(cloudConfig.cloudProvider, cloudConfig.vmType)
      : null;
  const explicitDockerGpuFallback =
    gpuRuntime === null && !!dockerOptions?.gpus;

  return gpuRuntime === 'cuda' || explicitDockerGpuFallback;
}

/** Default GPU access on one resolved NVIDIA capacity VM, without host options. */
export function defaultGpuAccess(
  cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
  dockerOptions: DockerOptions | null,
): DockerOptions | null {
  if (!usesNvidiaGpuAccess(cloudConfig, dockerOptions) || dockerOptions?.gpus) {
    return dockerOptions;
  }
  return { ...dockerOptions, gpus: 'all' };
}

/** Apply shared GPU defaults and Docker-only host IPC defaults for VM Jobs. */
export function defaultRuntimeGpuAccess(
  cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
  dockerOptions: DockerOptions | null,
): DockerOptions | null {
  const next = defaultGpuAccess(cloudConfig, dockerOptions);
  if (!usesNvidiaGpuAccess(cloudConfig, next) || next?.ipc || next?.shmSize) {
    return next;
  }
  return { ...next, ipc: 'host' };
}

/**
 * Bind untagged inline credential material to its selected provider. The
 * outer cloudProvider is authoritative on workload requests; reject a
 * structurally valid credential shape for a different provider.
 */
export function bindInlineCredentials(
  cloudProvider: CloudType,
  credentials: ComputeCreds,
): CloudCredentials {
  const mismatch = (): never => {
    throw new InvalidAnycloudConfigError(
      'Inline credentials do not match cloudConfig.cloudProvider',
    );
  };

  // The management VM's identity is never inline: only the hosted API's
  // own configuration names it.
  if ('kind' in credentials && credentials.kind === 'instance')
    throw new InvalidAnycloudConfigError(
      'Inline credentials cannot name an instance identity',
    );
  if ('accessKeyId' in credentials) {
    if (cloudProvider !== CloudType.AWS) return mismatch();
    return { ...credentials, cloudProvider: CloudType.AWS };
  }
  if ('projectId' in credentials) {
    if (cloudProvider !== CloudType.GCP) return mismatch();
    return { ...credentials, cloudProvider: CloudType.GCP };
  }
  if ('applicationId' in credentials) {
    if (cloudProvider !== CloudType.Azure) return mismatch();
    return { ...credentials, cloudProvider: CloudType.Azure };
  }
  if (cloudProvider === CloudType.Lambda && 'apiKey' in credentials) {
    return { ...credentials, cloudProvider: CloudType.Lambda };
  }
  return mismatch();
}

/** Narrow to credentials that can run compute; storage-only ones fail. */
export function isComputeCredentials(
  credentials: CloudCredentials,
): credentials is ComputeCloudCredentials {
  return isComputeProvider(credentials.cloudProvider);
}

/**
 * Extract credential fields from CloudCredentials (removes cloudProvider discriminator).
 * Used when building CloudConfig from credentials.
 */
export function extractCredentials(
  credentials: ComputeCloudCredentials,
): ComputeCreds;
export function extractCredentials(
  credentials: CloudCredentials,
): ComputeCreds | CloudflareCreds;
export function extractCredentials(
  credentials: CloudCredentials,
): ComputeCreds | CloudflareCreds {
  // A role connection holds no secret; its identifiers pass through.
  if ('kind' in credentials) {
    const { cloudProvider: _, ...role } = credentials;
    return role;
  }
  switch (credentials.cloudProvider) {
    case CloudType.AWS:
      return {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken
          ? { sessionToken: credentials.sessionToken }
          : {}),
      };
    case CloudType.GCP:
      return {
        projectId: credentials.projectId,
        privateKey: credentials.privateKey,
        clientEmail: credentials.clientEmail,
      };
    case CloudType.Azure:
      return {
        applicationId: credentials.applicationId,
        secret: credentials.secret,
        directoryId: credentials.directoryId,
        subscriptionId: credentials.subscriptionId,
      };
    case CloudType.Lambda:
      return {
        apiKey: credentials.apiKey,
      };
    case CloudType.Cloudflare:
      return {
        accountId: credentials.accountId,
        apiToken: credentials.apiToken,
        ...(credentials.jurisdiction
          ? { jurisdiction: credentials.jurisdiction }
          : {}),
      };
    default:
      return assertNever(credentials);
  }
}
