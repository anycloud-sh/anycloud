import { describe, expect, it } from 'vitest';
import {
  AZURE_QUOTA_RESOURCE_KEYS,
  azureQuotaResourceKey,
  canonicalAzureQuotaResourceKey,
  createAzureQuotaIdentity,
} from '../../../../src/shared/quota-resolvers/azure-identity.js';

describe('Azure quota identity', () => {
  it('preserves the exact provider name and creates a canonical key once', () => {
    expect(createAzureQuotaIdentity('Standard NCASv3_T4 Family')).toEqual({
      providerId: 'Standard NCASv3_T4 Family',
      resourceKey: 'azure:standardncasv3_t4family',
    });
  });

  it.each([
    'Standard NCASv3_T4 Family',
    'standardncasv3_t4family',
    ' STANDARD\tNCASv3_T4\nFAMILY ',
  ])('treats case and whitespace as identity-equivalent: %s', (providerId) => {
    expect(createAzureQuotaIdentity(providerId).resourceKey).toBe(
      'azure:standardncasv3_t4family',
    );
  });

  it('preserves meaningful provider punctuation', () => {
    expect(azureQuotaResourceKey('Standard NCASv3_T4 Family')).toBe(
      'azure:standardncasv3_t4family',
    );
  });

  it('aliases Azure live Standard IPv4 quota naming to the planned key', () => {
    expect(
      createAzureQuotaIdentity('IPv4StandardSkuPublicIpAddresses'),
    ).toEqual({
      providerId: 'IPv4StandardSkuPublicIpAddresses',
      resourceKey: 'azure:standardskupublicipaddresses',
    });
    expect(
      canonicalAzureQuotaResourceKey('azure:IPv4StandardSkuPublicIpAddresses'),
    ).toBe('azure:standardskupublicipaddresses');
  });

  it.each([
    'azure:publicipv4addressesstandard',
    'azure:publicipaddressesstandard',
    'azure:publicipaddresses',
  ])('keeps historical public-IP key %j distinct', (key) => {
    expect(canonicalAzureQuotaResourceKey(key)).toBe(key);
  });

  it('keeps raw legacy provider identities distinct for exact resolution', () => {
    expect(createAzureQuotaIdentity('PublicIPAddresses')).toEqual({
      providerId: 'PublicIPAddresses',
      resourceKey: 'azure:publicipaddresses',
    });
  });

  it.each(['', '  ', '\t\n'])(
    'rejects an empty provider identity: %j',
    (providerId) => {
      expect(() => createAzureQuotaIdentity(providerId)).toThrow(
        'Azure quota providerId must not be empty',
      );
    },
  );

  it('rejects a canonical key passed as a raw provider identity', () => {
    expect(() =>
      createAzureQuotaIdentity('azure:Standard NCASv3_T4 Family'),
    ).toThrow('must be a raw provider name');
  });

  it.each([
    ['azure:Standard NCASv3_T4 Family', 'azure:standardncasv3_t4family'],
    ['AZURE:standardncasv3_t4family', 'azure:standardncasv3_t4family'],
    ['  Azure:Standard\tNCASv3_T4 Family  ', 'azure:standardncasv3_t4family'],
    ['azure:standardncasv3_t4family', 'azure:standardncasv3_t4family'],
  ])('canonicalizes a persisted key %j', (value, expected) => {
    expect(canonicalAzureQuotaResourceKey(value)).toBe(expected);
  });

  it.each(['aws:l-3819a6df', 'azure:', 'azure:   ', '', 'ncasv3'])(
    'rejects a malformed or foreign persisted key: %j',
    (value) => {
      expect(canonicalAzureQuotaResourceKey(value)).toBeNull();
    },
  );

  it('centralizes aggregate and network resource keys', () => {
    expect(AZURE_QUOTA_RESOURCE_KEYS).toEqual({
      cores: 'azure:cores',
      lowPriorityCores: 'azure:lowprioritycores',
      standardSkuPublicIpAddresses: 'azure:standardskupublicipaddresses',
      basicPublicIpAddresses: 'azure:publicipaddresses',
    });
  });
});
