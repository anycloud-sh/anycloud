import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_AZURE_PUBLIC_IP_QUOTA_PROVIDER_IDS,
  isAcceptedAzurePublicIpQuotaProviderId,
  resolveAzurePublicIpQuota,
} from '../../../../src/shared/quota-resolvers/azure-public-ip.js';
import {
  AZURE_QUOTA_RESOURCE_KEYS,
  createAzureQuotaIdentity,
  type AzureQuotaIdentity,
} from '../../../../src/shared/quota-resolvers/azure-identity.js';

function quota(providerId: string): AzureQuotaIdentity {
  return createAzureQuotaIdentity(providerId);
}

describe('resolveAzurePublicIpQuota', () => {
  // Invariant: the accepted provider IDs and the canonical-key aliases are two
  // tables that must agree. Every accepted name has to canonicalize to the
  // Standard IPv4 pool key, or the resolver would select a row that the rest of
  // the pipeline keys under a different resourceKey.
  it('every accepted provider ID canonicalizes to the Standard IPv4 pool key', () => {
    for (const providerId of ACCEPTED_AZURE_PUBLIC_IP_QUOTA_PROVIDER_IDS) {
      expect(createAzureQuotaIdentity(providerId).resourceKey).toBe(
        AZURE_QUOTA_RESOURCE_KEYS.standardSkuPublicIpAddresses,
      );
    }
  });

  it.each(['StandardSkuPublicIpAddresses', 'IPv4StandardSkuPublicIpAddresses'])(
    'selects exact current provider ID %s',
    (providerId) => {
      const candidate = quota(providerId);

      expect(resolveAzurePublicIpQuota([candidate])).toEqual({
        kind: 'selected',
        selected: candidate,
      });
      expect(isAcceptedAzurePublicIpQuotaProviderId(providerId)).toBe(true);
    },
  );

  it.each(['PublicIPAddresses', 'StaticPublicIPAddresses'])(
    'ignores known non-target provider ID %s',
    (providerId) => {
      expect(resolveAzurePublicIpQuota([quota(providerId)])).toEqual({
        kind: 'absent',
      });
      expect(isAcceptedAzurePublicIpQuotaProviderId(providerId)).toBe(false);
    },
  );

  it.each(['StandardSkuPublicIpAddresses', 'IPv4StandardSkuPublicIpAddresses'])(
    'selects %s when Basic also exists',
    (providerId) => {
      const selected = quota(providerId);

      expect(
        resolveAzurePublicIpQuota([quota('PublicIPAddresses'), selected]),
      ).toEqual({ kind: 'selected', selected });
    },
  );

  it('ignores all known non-target public-IP resources in the live Azure inventory', () => {
    const selected = quota('IPv4StandardSkuPublicIpAddresses');
    const resolution = resolveAzurePublicIpQuota([
      quota('PublicIPAddresses'),
      quota('StaticPublicIPAddresses'),
      quota('IPv4BasicSkuPublicIpAddresses'),
      quota('IPv4GlobalTierPublicIpAddresses'),
      quota('IPv4InternetRoutingPreferencePublicIpAddresses'),
      selected,
      quota('IPv6BasicSkuPublicIpAddresses'),
      quota('IPv6GlobalTierPublicIpAddresses'),
      quota('IPv6InternetRoutingPreferencePublicIpAddresses'),
      quota('IPv6StandardSkuPublicIpAddresses'),
      quota('PublicIpPrefixes'),
      quota('MinPublicIpInterNetworkPrefixLength'),
      quota('CustomIpPrefixes'),
    ]);

    expect(resolution).toEqual({ kind: 'selected', selected });
  });

  it('returns absent when only ignored or unrelated resources exist', () => {
    expect(
      resolveAzurePublicIpQuota([
        quota('PublicIPAddresses'),
        quota('StaticPublicIPAddresses'),
        quota('IPv4BasicSkuPublicIpAddresses'),
        quota('PublicIpPrefixes'),
        quota('VirtualNetworks'),
      ]),
    ).toEqual({ kind: 'absent' });
  });

  it.each([
    'PublicIPv4AddressesStandard',
    'PublicIPAddressesStandard',
    'IPv4StandardPublicIPs',
  ])(
    'returns unknown instead of selecting undocumented alias %s',
    (providerId) => {
      const unknown = quota(providerId);

      expect(resolveAzurePublicIpQuota([unknown])).toEqual({
        kind: 'unknown',
        unknownCandidates: [unknown],
      });
      expect(isAcceptedAzurePublicIpQuotaProviderId(providerId)).toBe(false);
    },
  );

  it.each([
    'ipv4standardskupublicipaddresses',
    'IPv4 Standard Sku Public Ip Addresses',
    'IPv4-Standard-Sku-Public-IP-Addresses',
    'IPv4 Standard SKU Public IP Addresses',
    'StandardSkuPublicIPAddresses',
  ])('does not select non-exact current-looking ID %s', (providerId) => {
    const candidate = quota(providerId);

    expect(resolveAzurePublicIpQuota([candidate])).toEqual({
      kind: 'unknown',
      unknownCandidates: [candidate],
    });
    expect(isAcceptedAzurePublicIpQuotaProviderId(providerId)).toBe(false);
  });

  it('does not trust a current semantic key when the raw provider ID is not exact', () => {
    const lookalike = quota('IPv4 Standard Sku Public Ip Addresses');

    expect(lookalike.resourceKey).toBe('azure:standardskupublicipaddresses');
    expect(resolveAzurePublicIpQuota([lookalike])).toEqual({
      kind: 'unknown',
      unknownCandidates: [lookalike],
    });
  });

  it('returns ambiguous when an unknown candidate coexists with an accepted candidate', () => {
    const accepted = quota('StandardSkuPublicIpAddresses');
    const unknown = quota('IPv4StandardPublicIPs');

    expect(resolveAzurePublicIpQuota([accepted, unknown])).toEqual({
      kind: 'ambiguous',
      acceptedCandidates: [accepted],
      unknownCandidates: [unknown],
    });
  });

  it('returns ambiguous when both accepted provider IDs coexist', () => {
    const first = quota('IPv4StandardSkuPublicIpAddresses');
    const second = quota('StandardSkuPublicIpAddresses');

    expect(resolveAzurePublicIpQuota([first, second])).toEqual({
      kind: 'ambiguous',
      acceptedCandidates: [first, second],
      unknownCandidates: [],
    });
    expect(resolveAzurePublicIpQuota([second, first])).toEqual({
      kind: 'ambiguous',
      acceptedCandidates: [second, first],
      unknownCandidates: [],
    });
  });

  it('preserves each accepted raw ID while sharing the current semantic key', () => {
    const ipv4 = quota('IPv4StandardSkuPublicIpAddresses');
    const standard = quota('StandardSkuPublicIpAddresses');

    expect(ipv4).toEqual({
      providerId: 'IPv4StandardSkuPublicIpAddresses',
      resourceKey: 'azure:standardskupublicipaddresses',
    });
    expect(standard).toEqual({
      providerId: 'StandardSkuPublicIpAddresses',
      resourceKey: 'azure:standardskupublicipaddresses',
    });
  });
});
