declare const azureQuotaResourceKeyBrand: unique symbol;

/** Stable AnyCloud-owned identity for an Azure quota resource. */
export type AzureQuotaResourceKey = string & {
  readonly [azureQuotaResourceKeyBrand]: true;
};

/**
 * Azure's exact resource name paired with AnyCloud's canonical identity.
 * `providerId` is retained verbatim for outbound Azure API calls only.
 */
export interface AzureQuotaIdentity {
  providerId: string;
  resourceKey: AzureQuotaResourceKey;
}

const SEMANTIC_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Microsoft.Network's live Quota API name for the same Standard IPv4 pool
  // represented by the catalog/planner as StandardSkuPublicIpAddresses.
  ipv4standardskupublicipaddresses: 'standardskupublicipaddresses',
});

function canonicalKeyPart(value: string): string {
  const mechanical = value.replace(/\s+/gu, '').toLowerCase();
  return SEMANTIC_KEY_ALIASES[mechanical] ?? mechanical;
}

/**
 * Create an Azure quota identity at a provider-ingestion boundary.
 *
 * Azure's raw name is preserved byte-for-byte while case and whitespace are
 * ignored by AnyCloud's internal identity.
 */
export function createAzureQuotaIdentity(
  rawProviderId: string,
): AzureQuotaIdentity {
  if (/^\s*azure:/iu.test(rawProviderId)) {
    throw new Error(
      'Azure quota providerId must be a raw provider name, not a resource key',
    );
  }
  const keyPart = canonicalKeyPart(rawProviderId);
  if (!keyPart) {
    throw new Error('Azure quota providerId must not be empty');
  }
  return {
    providerId: rawProviderId,
    resourceKey: `azure:${keyPart}` as AzureQuotaResourceKey,
  };
}

/**
 * Read a persisted or wire-format Azure resource key into its canonical form.
 * This is the compatibility boundary for historical spaced/case-varied keys.
 */
export function canonicalAzureQuotaResourceKey(
  value: string,
): AzureQuotaResourceKey | null {
  const match = value.trim().match(/^azure:(.*)$/is);
  if (!match) return null;
  const keyPart = canonicalKeyPart(match[1]);
  return keyPart ? (`azure:${keyPart}` as AzureQuotaResourceKey) : null;
}

/** Compatibility shorthand for callers that only need the canonical key. */
export function azureQuotaResourceKey(
  providerId: string,
): AzureQuotaResourceKey {
  return createAzureQuotaIdentity(providerId).resourceKey;
}

export const AZURE_QUOTA_RESOURCE_KEYS = Object.freeze({
  cores: azureQuotaResourceKey('cores'),
  lowPriorityCores: azureQuotaResourceKey('lowprioritycores'),
  standardSkuPublicIpAddresses: azureQuotaResourceKey(
    'standardskupublicipaddresses',
  ),
  // Basic SKU public-IP pool (Azure provider name 'PublicIPAddresses'), shown
  // as a distinct read-only status column and never a mutation target.
  basicPublicIpAddresses: azureQuotaResourceKey('publicipaddresses'),
});
