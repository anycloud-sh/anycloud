import { describe, expect, it } from 'vitest';
import { findAzureComputeProviderLimit } from '../../integration/helpers/azure-quota-compute-limit.js';

describe('findAzureComputeProviderLimit', () => {
  it('matches the reported spaced T4 family and keeps Compute Usage numeric ownership at limit 0', () => {
    const usageRows = [
      {
        name: {
          value: 'Standard NCASv3_T4 Family',
          localizedValue: 'Standard NCASv3_T4 Family vCPUs',
        },
        limit: 0,
      },
    ];
    const quotaRows = [
      {
        properties: {
          name: { value: 'Standard NCASv3_T4 Family' },
          limit: { value: 41 },
        },
      },
    ];

    expect(
      findAzureComputeProviderLimit(
        'azure:standardncasv3_t4family',
        usageRows,
        quotaRows,
      ),
    ).toBe(0);
  });

  it('falls back to the Quota API shape using the same canonical family key', () => {
    const quotaRows = [
      {
        properties: {
          name: { value: 'STANDARD NCASv3_T4 FAMILY' },
          limit: { value: 41 },
        },
      },
    ];

    expect(
      findAzureComputeProviderLimit(
        'azure:standardncasv3_t4family',
        [],
        quotaRows,
      ),
    ).toBe(41);
  });

  it('falls back to the Quota API when the matching Usage row has no numeric limit', () => {
    const usageRows = [
      { name: { value: 'Standard NCASv3_T4 Family' } }, // no limit field
    ];
    const quotaRows = [
      {
        properties: {
          name: { value: 'Standard NCASv3_T4 Family' },
          limit: { value: 41 },
        },
      },
    ];

    expect(
      findAzureComputeProviderLimit(
        'azure:standardncasv3_t4family',
        usageRows,
        quotaRows,
      ),
    ).toBe(41);
  });

  it('returns undefined when neither file has a matching row', () => {
    const usageRows = [
      { name: { value: 'Standard D4s v3 Family' }, limit: 10 },
    ];
    const quotaRows = [
      {
        properties: {
          name: { value: 'Standard D4s v3 Family' },
          limit: { value: 10 },
        },
      },
    ];

    expect(
      findAzureComputeProviderLimit(
        'azure:standardncasv3_t4family',
        usageRows,
        quotaRows,
      ),
    ).toBeUndefined();
  });

  it('returns undefined for a malformed (non azure:-prefixed) resource key instead of throwing', () => {
    expect(
      findAzureComputeProviderLimit('not-a-canonical-key', [], []),
    ).toBeUndefined();
  });
});
