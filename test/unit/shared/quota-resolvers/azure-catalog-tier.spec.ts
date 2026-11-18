import { describe, expect, it } from 'vitest';
import { readCatalog } from '../../../../src/shared/catalog/index.js';
import { getAzureQuotaGroupForVMType } from '../../../../src/shared/quota-resolvers/azure.js';
import { CloudType } from '../../../../src/shared/cloud.js';

describe('getAzureQuotaGroupForVMType published-catalog tier', () => {
  it('uses the real catalog quota group when the VM name cannot encode it', () => {
    const catalog = readCatalog(CloudType.Azure);
    expect(catalog).toBeDefined();
    expect(catalog?.quotaGroupPerType.standard_nd96asr_v4).toBe(
      'azure:standardndasv4_a100family',
    );

    // The VM name has no A100 token, so this value can only come from the
    // published Resource SKU catalog rather than the fallback name parser.
    expect(getAzureQuotaGroupForVMType('Standard_ND96asr_v4')).toBe(
      'standardndasv4_a100family',
    );
  });

  it('looks up real catalog VM keys case-insensitively', () => {
    expect(getAzureQuotaGroupForVMType('STANDARD_ND96ASR_V4')).toBe(
      'standardndasv4_a100family',
    );
  });

  it('falls back to the parser for a type absent from the real catalog', () => {
    const vmType = 'Standard_NC4as_T4_v999';
    expect(
      readCatalog(CloudType.Azure)?.quotaGroupPerType[vmType.toLowerCase()],
    ).toBeUndefined();
    expect(getAzureQuotaGroupForVMType(vmType)).toBe(
      'standardncasv999_t4family',
    );
  });
});
