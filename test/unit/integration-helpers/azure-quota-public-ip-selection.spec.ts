import { describe, expect, it } from 'vitest';
import { selectAzurePublicIpQuota } from '../../integration/helpers/azure-quota-public-ip-selection.js';

function row(value: string, localizedValue: string, limit: number | undefined) {
  return {
    properties: {
      name: { value, localizedValue },
      ...(limit === undefined ? {} : { limit: { value: limit } }),
    },
  };
}

describe('selectAzurePublicIpQuota', () => {
  it('selects the Standard IPv4 pool while ignoring the Basic pool', () => {
    expect(
      selectAzurePublicIpQuota([
        row('PublicIPAddresses', 'Public IP Addresses', 20),
        row(
          'IPv4StandardSkuPublicIpAddresses',
          'Public IPv4 Addresses - Standard',
          80,
        ),
      ]),
    ).toEqual({
      key: 'azure:standardskupublicipaddresses',
      limit: 80,
      name: 'Public IPv4 Addresses - Standard',
      providerId: 'IPv4StandardSkuPublicIpAddresses',
    });
  });

  it.each(['IPv4StandardSkuPublicIpAddresses', 'StandardSkuPublicIpAddresses'])(
    'selects exact provider ID %s without depending on an English localized name',
    (providerId) => {
      expect(
        selectAzurePublicIpQuota([
          row(providerId, 'Nicht der englische Anzeigename', 40),
        ]),
      ).toEqual({
        key: 'azure:standardskupublicipaddresses',
        limit: 40,
        name: 'Nicht der englische Anzeigename',
        providerId,
      });
    },
  );

  it('coalesces byte-identical duplicate provider rows', () => {
    expect(
      selectAzurePublicIpQuota([
        row('IPv4StandardSkuPublicIpAddresses', 'First page', 80),
        row('IPv4StandardSkuPublicIpAddresses', 'Second page', 80),
      ]),
    ).toEqual({
      key: 'azure:standardskupublicipaddresses',
      limit: 80,
      name: 'First page',
      providerId: 'IPv4StandardSkuPublicIpAddresses',
    });
  });

  it('rejects conflicting duplicate rows for the same exact provider ID', () => {
    expect(() =>
      selectAzurePublicIpQuota([
        row('IPv4StandardSkuPublicIpAddresses', 'First page', 80),
        row('IPv4StandardSkuPublicIpAddresses', 'Second page', 81),
      ]),
    ).toThrow(
      'Azure quota limits returned conflicting duplicate rows for IPv4StandardSkuPublicIpAddresses',
    );
  });

  it('does not select Basic or non-applicable static public-IP rows', () => {
    expect(
      selectAzurePublicIpQuota([
        row('PublicIPAddresses', 'Public IP Addresses', 20),
        row('StaticPublicIPAddresses', 'Static Public IP Addresses', 20),
        row(
          'IPv4BasicSkuPublicIpAddresses',
          'Basic IPv4 Public IP Addresses',
          1000,
        ),
      ]),
    ).toBeUndefined();
  });

  it('does not select an undocumented public-IP-shaped provider ID', () => {
    expect(
      selectAzurePublicIpQuota([
        row(
          'PublicIpStandardWidgetAddresses',
          'Public IP Standard Widget Addresses',
          40,
        ),
      ]),
    ).toBeUndefined();
  });

  it('returns no row when a limit-less unknown candidate makes an accepted row ambiguous', () => {
    expect(
      selectAzurePublicIpQuota([
        row(
          'IPv4StandardSkuPublicIpAddresses',
          'Public IPv4 Addresses - Standard',
          80,
        ),
        row('PublicIPAddressesStandard', 'Undocumented alias', undefined),
      ]),
    ).toBeUndefined();
  });

  it('resolves rows before limit validation so a limit-less second accepted ID remains ambiguous', () => {
    expect(
      selectAzurePublicIpQuota([
        row('IPv4StandardSkuPublicIpAddresses', 'Current spelling', 80),
        row('StandardSkuPublicIpAddresses', 'Second spelling', undefined),
      ]),
    ).toBeUndefined();
  });

  it('returns no row when the selected provider row has no numeric limit', () => {
    expect(
      selectAzurePublicIpQuota([
        row(
          'IPv4StandardSkuPublicIpAddresses',
          'Public IPv4 Addresses - Standard',
          undefined,
        ),
      ]),
    ).toBeUndefined();
  });

  it('returns undefined when the inventory is empty', () => {
    expect(selectAzurePublicIpQuota([])).toBeUndefined();
  });
});
