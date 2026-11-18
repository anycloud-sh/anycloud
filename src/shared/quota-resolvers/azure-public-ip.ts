import type { AzureQuotaResourceKey } from './azure-identity.js';

/** Stable machine-readable signal consumed by the credentialed live canary. */
export const AZURE_PUBLIC_IP_QUOTA_SCHEMA_DRIFT_EVENT_CODE =
  'azure_public_ip_quota_schema_drift';

/**
 * Byte-exact Azure provider IDs accepted as the regional Standard IPv4 pool
 * (the mutation target). Every entry MUST canonicalize to
 * AZURE_QUOTA_RESOURCE_KEYS.standardSkuPublicIpAddresses via createAzureQuotaIdentity
 * (i.e. have a matching SEMANTIC_KEY_ALIASES fold); the invariant is enforced by
 * a unit test so a new accepted name cannot silently miss its alias.
 */
export const ACCEPTED_AZURE_PUBLIC_IP_QUOTA_PROVIDER_IDS = Object.freeze([
  'IPv4StandardSkuPublicIpAddresses',
  'StandardSkuPublicIpAddresses',
] as const);

const ACCEPTED_PROVIDER_IDS = new Set<string>(
  ACCEPTED_AZURE_PUBLIC_IP_QUOTA_PROVIDER_IDS,
);

/**
 * Public-IP-related resources observed live that are not the regional Standard
 * IPv4 address pool consumed by provisioned VMs.
 */
const IGNORED_PROVIDER_IDS = new Set([
  'PublicIPAddresses',
  'StaticPublicIPAddresses',
  'IPv4BasicSkuPublicIpAddresses',
  'IPv4GlobalTierPublicIpAddresses',
  'IPv4InternetRoutingPreferencePublicIpAddresses',
  'IPv6BasicSkuPublicIpAddresses',
  'IPv6GlobalTierPublicIpAddresses',
  'IPv6InternetRoutingPreferencePublicIpAddresses',
  'IPv6StandardSkuPublicIpAddresses',
  'PublicIpPrefixes',
  'MinPublicIpInterNetworkPrefixLength',
  'CustomIpPrefixes',
]);

export interface AzurePublicIpQuotaCandidate {
  /** Azure's exact provider-native resource name. */
  providerId: string;
  /** AnyCloud's canonical identity for the provider-native name. */
  resourceKey: AzureQuotaResourceKey;
}

export type AzurePublicIpQuotaResolution<
  T extends AzurePublicIpQuotaCandidate,
> =
  | { kind: 'selected'; selected: T }
  | { kind: 'absent' }
  | { kind: 'unknown'; unknownCandidates: T[] }
  | {
      kind: 'ambiguous';
      acceptedCandidates: T[];
      unknownCandidates: T[];
    };

/** True only for byte-exact provider IDs that are safe mutation targets. */
export function isAcceptedAzurePublicIpQuotaProviderId(
  providerId: string,
): boolean {
  return ACCEPTED_PROVIDER_IDS.has(providerId);
}

/** Diagnostic-only shape check; never sufficient to select a mutation target. */
export function looksLikeAzurePublicIpQuotaProviderId(
  providerId: string,
): boolean {
  const diagnosticId = providerId.toLowerCase();
  return diagnosticId.includes('public') && diagnosticId.includes('ip');
}

/**
 * Resolve Azure's Network quota inventory without guessing a mutation target.
 *
 * Unknown public-IP-shaped rows are kept separate from known ignored
 * variants. An accepted row plus an unknown candidate is deliberately
 * ambiguous because the unknown row may be Azure's new name for the real
 * Standard pool. Multiple accepted rows are also ambiguous because there is
 * no order-independent basis for choosing an outbound provider ID.
 */
export function resolveAzurePublicIpQuota<
  T extends AzurePublicIpQuotaCandidate,
>(quotas: readonly T[]): AzurePublicIpQuotaResolution<T> {
  const acceptedCandidates: T[] = [];
  const unknownCandidates: T[] = [];

  for (const quota of quotas) {
    if (isAcceptedAzurePublicIpQuotaProviderId(quota.providerId)) {
      acceptedCandidates.push(quota);
      continue;
    }
    if (IGNORED_PROVIDER_IDS.has(quota.providerId)) continue;
    if (looksLikeAzurePublicIpQuotaProviderId(quota.providerId)) {
      unknownCandidates.push(quota);
    }
  }

  if (
    acceptedCandidates.length > 1 ||
    (acceptedCandidates.length > 0 && unknownCandidates.length > 0)
  ) {
    return {
      kind: 'ambiguous',
      acceptedCandidates,
      unknownCandidates,
    };
  }
  if (acceptedCandidates.length === 1) {
    return { kind: 'selected', selected: acceptedCandidates[0] };
  }
  if (unknownCandidates.length > 0) {
    return { kind: 'unknown', unknownCandidates };
  }
  return { kind: 'absent' };
}
