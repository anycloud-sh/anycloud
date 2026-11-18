import {
  canonicalAwsQuotaResourceKey,
  awsQuotaResourceKeyFromName,
  awsQuotaSpotFromResourceKey,
  awsQuotaSpotFromResourceName,
  resolveAwsQuotaResources,
} from './quota-resolvers/aws.js';
import { canonicalAzureQuotaResourceKey } from './quota-resolvers/azure-identity.js';
import {
  azureQuotaSpotFromResourceKey,
  azureQuotaSpotFromResourceName,
  azureQuotaResourceKeyFromName,
  resolveAzureQuotaResources,
} from './quota-resolvers/azure.js';
import type {
  QuotaResolver,
  QuotaResource,
  QuotaResourceResolveOptions,
  QuotaTargetSpec,
} from './quota-resolvers/types.js';
import {
  type QuotaRequestEntry,
  type QuotaStatusEntry,
} from './api-contract/quota-schemas.js';
import { CloudType } from './cloud.js';
import { QuotaProviderStatus } from './quota.js';
import { normalizeResourceKeyPart } from './quota-resolvers/util.js';

const QUOTA_RESOLVERS: Partial<Record<CloudType, QuotaResolver>> = {
  [CloudType.AWS]: {
    resolve: resolveAwsQuotaResources,
    canonicalResourceKey: canonicalAwsQuotaResourceKey,
    resourceKeyFromName: awsQuotaResourceKeyFromName,
    spotFromResourceKey: awsQuotaSpotFromResourceKey,
    spotFromResourceName: awsQuotaSpotFromResourceName,
  },
  [CloudType.Azure]: {
    resolve: resolveAzureQuotaResources,
    canonicalResourceKey: canonicalAzureQuotaResourceKey,
    resourceKeyFromName: azureQuotaResourceKeyFromName,
    spotFromResourceKey: azureQuotaSpotFromResourceKey,
    spotFromResourceName: azureQuotaSpotFromResourceName,
  },
};

const ACCOUNT_REGIONAL_SPOT_QUOTA_POOL_KEYS: Partial<
  Record<CloudType, (vmType: string) => string>
> = {
  [CloudType.Azure]: () => 'regional',
  [CloudType.AWS]: awsSpotQuotaPoolFamily,
};

/**
 * Provider-native pool identity for an account/regional Spot quota failure.
 * Azure has one regional low-priority pool; AWS separates Spot quota by
 * instance family. Providers without a shared pool retain exact-SKU scope.
 */
export function accountRegionalSpotQuotaPoolKey(
  cloud: CloudType,
  vmType: string,
): string {
  const pool = ACCOUNT_REGIONAL_SPOT_QUOTA_POOL_KEYS[cloud]?.(vmType) ?? vmType;
  return `${cloud}:${pool}`;
}

function awsSpotQuotaPoolFamily(vmType: string): string {
  const family = vmType.toLowerCase().split('.')[0] ?? '';
  if (family.startsWith('vt') || family.startsWith('g')) return 'g-vt';
  if (family.startsWith('inf')) return 'inf';
  if (family.startsWith('trn')) return 'trn';
  if (family.startsWith('dl')) return 'dl';
  if (family.startsWith('p')) return 'p';
  if (family.startsWith('f')) return 'f';
  if (family.startsWith('x')) return 'x';
  return 'standard';
}

/** Canonicalize a provider resource key while preserving unknown wire values. */
export function canonicalQuotaResourceKey(
  cloud: CloudType,
  resourceKey: string,
): string {
  return (
    QUOTA_RESOLVERS[cloud]?.canonicalResourceKey?.(resourceKey) ?? resourceKey
  );
}

/** Canonicalize an explicit persisted key without inventing one for old rows. */
export function canonicalizeQuotaRequestEntry(
  cloud: CloudType,
  entry: QuotaRequestEntry,
): QuotaRequestEntry {
  if (!entry.resourceKey) return entry;
  const resourceKey = canonicalQuotaResourceKey(cloud, entry.resourceKey);
  return resourceKey === entry.resourceKey ? entry : { ...entry, resourceKey };
}

export function canonicalizeQuotaRequestEntries(
  cloud: CloudType,
  entries: QuotaRequestEntry[],
): QuotaRequestEntry[] {
  return entries.map((entry) => canonicalizeQuotaRequestEntry(cloud, entry));
}

export function resolveQuotaResourcesForTarget(
  input: QuotaTargetSpec,
  options: QuotaResourceResolveOptions = {},
): QuotaResource[] {
  return QUOTA_RESOLVERS[input.cloud]?.resolve(input, options) ?? [];
}

export function defaultIncludePublicIpQuotaForAvailabilityHints(
  cloud: CloudType,
): boolean {
  return cloud === CloudType.Azure;
}

export function quotaStatusResourceKey(entry: QuotaStatusEntry): string {
  if (entry.resourceKey) {
    return canonicalQuotaResourceKey(entry.cloud, entry.resourceKey);
  }
  const resolverKey = QUOTA_RESOLVERS[entry.cloud]?.resourceKeyFromName?.(
    entry.resourceName,
  );
  if (resolverKey) return resolverKey;
  return `${entry.cloud.toLowerCase()}:${normalizeResourceKeyPart(entry.resourceName)}`;
}

export function quotaStatusEntrySpot(
  entry: QuotaStatusEntry,
): boolean | undefined {
  // Quota-type views scope by what the quota GATES, so the resource itself is
  // authoritative: an Azure VM-family row belongs to the on-demand view even
  // when the request that created it was filed for a spot target (the old
  // behavior filed family increases spot never needed). The entry's stored
  // spot flag records filed intent — use it only for resources that don't
  // classify themselves (e.g. public IPs, which gate both pricing models).
  const resolver = QUOTA_RESOLVERS[entry.cloud];
  const resourceKeySpot = resolver?.spotFromResourceKey?.(
    quotaStatusResourceKey(entry),
  );
  if (resourceKeySpot !== undefined) return resourceKeySpot;

  const resourceNameSpot = resolver?.spotFromResourceName?.(entry.resourceName);
  if (resourceNameSpot !== undefined) return resourceNameSpot;

  return typeof entry.spot === 'boolean' ? entry.spot : undefined;
}

function isCurrentStatusEntry(entry: QuotaStatusEntry): boolean {
  return (
    entry.kind === 'current' ||
    ((entry.status || '').toUpperCase() === QuotaProviderStatus.Current &&
      typeof entry.currentLimit === 'number')
  );
}

function currentLimitByResourceKey(
  entries: QuotaStatusEntry[],
): Map<string, number> {
  const current = new Map<string, number>();
  for (const entry of entries) {
    if (!isCurrentStatusEntry(entry)) continue;
    current.set(
      `${entry.region}:${quotaStatusResourceKey(entry)}`,
      entry.currentLimit ?? 0,
    );
  }
  return current;
}

export function quotaSupportedRegionsForVmType(input: {
  cloud: CloudType;
  vmType: string;
  spot: boolean;
  regions: string[];
  entries: QuotaStatusEntry[];
  includePublicIpQuota?: boolean;
}): string[] {
  const resources = resolveQuotaResourcesForTarget({
    cloud: input.cloud,
    vmType: input.vmType,
    spot: input.spot,
    includePublicIpQuota: input.includePublicIpQuota,
  });
  if (resources.length === 0) return [];

  const current = currentLimitByResourceKey(input.entries);
  return input.regions.filter((region) =>
    resources.every((resource) => {
      const need = resource.required;
      if (need === undefined) return false;
      const currentLimit = current.get(`${region}:${resource.key}`);
      return currentLimit !== undefined && currentLimit >= need;
    }),
  );
}
