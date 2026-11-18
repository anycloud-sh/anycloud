import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureCatalogFetcher } from '../../../../src/shared/catalog/azure.js';
import { entriesToCSV } from '../../../../src/shared/catalog/fetcher.js';
import { parseCatalogCSV } from '../../../../src/shared/catalog/index.js';
import { createAzureQuotaIdentity } from '../../../../src/shared/quota-resolvers/azure-identity.js';
import { CloudType } from '../../../../src/shared/cloud.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const CREDS = {
  subscriptionId: 'sub-123',
  tenantId: 'tenant-123',
  clientId: 'client-123',
  clientSecret: 'secret-123',
};

// --- Mock data factories ---

function makePricingItem(overrides: Record<string, unknown> = {}) {
  return {
    armSkuName: 'Standard_D4s_v5',
    armRegionName: 'eastus',
    unitPrice: 0.192,
    skuName: 'D4s v5',
    productName: 'Virtual Machines D Series',
    meterName: 'D4s v5',
    currencyCode: 'USD',
    ...overrides,
  };
}

function makePricingResponse(
  items: ReturnType<typeof makePricingItem>[],
  nextPageLink: string | null = null,
) {
  return {
    Items: items,
    NextPageLink: nextPageLink,
  };
}

function makeSKU(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Standard_D4s_v5',
    resourceType: 'virtualMachines',
    family: 'standardDSv5Family',
    capabilities: [
      { name: 'vCPUs', value: '4' },
      { name: 'MemoryGB', value: '16' },
      { name: 'HyperVGenerations', value: 'V2' },
    ],
    ...overrides,
  };
}

function makeSKUResponse(skus: ReturnType<typeof makeSKU>[]) {
  return { value: skus };
}

function makeTokenResponse() {
  return { access_token: 'mock-token-123' };
}

// Default /locations fixture — commercial Physical regions used across tests,
// plus a Logical alias to prove the filter excludes non-Physical entries.
function makeLocationsResponse(
  locations: { name: string; regionType: string }[] = [
    { name: 'eastus', regionType: 'Physical' },
    { name: 'westus2', regionType: 'Physical' },
    { name: 'westeurope', regionType: 'Physical' },
    { name: 'northcentralus', regionType: 'Physical' },
    { name: 'europe', regionType: 'Logical' },
  ],
) {
  return {
    value: locations.map((l) => ({
      name: l.name,
      metadata: { regionType: l.regionType },
    })),
  };
}

// Microsoft.Network provider fixture. NSG locations default to every region
// in the /locations fixture so the NSG filter is a no-op unless a test
// restricts it.
function makeProviderResponse(locations: string[]) {
  return {
    resourceTypes: [
      { resourceType: 'networkSecurityGroups', locations },
      { resourceType: 'virtualNetworks', locations },
    ],
  };
}

// Wires the URL-switch mock dispatcher used by most tests.
function mockFetchResponses(opts: {
  pricing: ReturnType<typeof makePricingResponse>;
  skus: ReturnType<typeof makeSKUResponse>;
  locations?: ReturnType<typeof makeLocationsResponse>;
  nsgLocations?: string[];
  /** Answers to the first pricing requests, before the pricing page. */
  pricingFailures?: Response[];
}) {
  const pricingFailures = [...(opts.pricingFailures ?? [])];
  const locations = opts.locations ?? makeLocationsResponse();
  const nsgLocations = opts.nsgLocations ?? locations.value.map((l) => l.name);
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('prices.azure.com')) {
      const failure = pricingFailures.shift();
      if (failure) return Promise.resolve(failure);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(opts.pricing),
      });
    }
    if (url.includes('login.microsoftonline.com')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeTokenResponse()),
      });
    }
    if (url.includes('/locations?api-version=')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(locations),
      });
    }
    if (url.includes('/providers/Microsoft.Network?api-version=')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeProviderResponse(nsgLocations)),
      });
    }
    if (url.includes('management.azure.com')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(opts.skus),
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AzureCatalogFetcher', () => {
  it('fetches and merges pricing + SKU data', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem(),
        makePricingItem({
          armRegionName: 'westus2',
          unitPrice: 0.192,
        }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      instanceType: 'Standard_D4s_v5',
      region: 'eastus',
      price: 0.192,
      vCPUs: 4,
      memoryGiB: 16,
      acceleratorName: null,
      acceleratorCount: null,
      availabilityZone: null,
      generation: 'V2',
    });
    expect(entries[1].region).toBe('westus2');
  });

  it('captures the PremiumIO capability as premiumStorageCapable', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([makePricingItem()]),
      skus: makeSKUResponse([
        makeSKU({
          name: 'Standard_D4s_v5',
          capabilities: [
            { name: 'vCPUs', value: '4' },
            { name: 'MemoryGB', value: '16' },
            { name: 'PremiumIO', value: 'True' },
          ],
        }),
      ]),
    });

    const entries = await new AzureCatalogFetcher(CREDS).fetchAll();
    expect(entries[0].premiumStorageCapable).toBe(true);
  });

  it('marks premiumStorageCapable false when PremiumIO is False, undefined when absent', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armSkuName: 'Standard_A1' }),
        makePricingItem({ armSkuName: 'Standard_A2' }),
      ]),
      skus: makeSKUResponse([
        makeSKU({
          name: 'Standard_A1',
          capabilities: [
            { name: 'vCPUs', value: '1' },
            { name: 'MemoryGB', value: '2' },
            { name: 'PremiumIO', value: 'False' },
          ],
        }),
        makeSKU({
          name: 'Standard_A2',
          capabilities: [
            { name: 'vCPUs', value: '2' },
            { name: 'MemoryGB', value: '4' },
          ],
        }),
      ]),
    });

    const entries = await new AzureCatalogFetcher(CREDS).fetchAll();
    const a1 = entries.find((e) => e.instanceType === 'Standard_A1');
    const a2 = entries.find((e) => e.instanceType === 'Standard_A2');
    expect(a1?.premiumStorageCapable).toBe(false);
    expect(a2?.premiumStorageCapable).toBeUndefined();
  });

  describe('pricing-API retries', () => {
    const throttled = (headers?: Record<string, string>) =>
      new Response(null, { status: 429, headers });
    const pricingCalls = () =>
      mockFetch.mock.calls.filter(([url]) => url.includes('prices.azure.com'))
        .length;

    beforeEach(() => {
      // Whole seconds, so an HTTP-date Retry-After is exact.
      vi.useFakeTimers({ now: new Date('2026-10-12T00:33:00Z') });
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function fetchWith(pricingFailures: Response[]) {
      mockFetchResponses({
        pricing: makePricingResponse([makePricingItem()]),
        skus: makeSKUResponse([makeSKU()]),
        pricingFailures,
      });
      return new AzureCatalogFetcher(CREDS).fetchAll();
    }

    it('retries nine 429s on an unjittered backoff and produces the catalog', async () => {
      const entries = fetchWith(Array.from({ length: 9 }, () => throttled()));

      // 10s, 20s, 40s, 80s, then 120s: no wait is cut short by jitter.
      for (const [waitMs, calls] of [
        [10_000, 2],
        [20_000, 3],
        [40_000, 4],
        [80_000, 5],
        [120_000, 6],
      ]) {
        await vi.advanceTimersByTimeAsync(waitMs - 1);
        expect(pricingCalls()).toBe(calls - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(pricingCalls()).toBe(calls);
      }
      await vi.runAllTimersAsync();

      expect(await entries).toEqual([
        expect.objectContaining({
          instanceType: 'Standard_D4s_v5',
          region: 'eastus',
          price: 0.192,
        }),
      ]);
      expect(pricingCalls()).toBe(10);
    });

    it('fails after ten 429s', async () => {
      const entries = fetchWith(Array.from({ length: 10 }, () => throttled()));
      const failure = expect(entries).rejects.toThrow('Pricing API HTTP 429');
      await vi.runAllTimersAsync();

      await failure;
      expect(pricingCalls()).toBe(10);
    });

    it('waits out a delay-seconds Retry-After and logs the retry', async () => {
      const entries = fetchWith([throttled({ 'Retry-After': '90' })]);

      await vi.advanceTimersByTimeAsync(89_999);
      expect(pricingCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pricingCalls()).toBe(2);
      await vi.runAllTimersAsync();
      await entries;
      expect(console.log).toHaveBeenCalledWith(
        'Azure pricing page 1: attempt 1 failed: Pricing API HTTP 429 (Retry-After 90s); retrying in 90s',
      );
    });

    it('waits out an HTTP-date Retry-After, capped at two minutes', async () => {
      const entries = fetchWith([
        throttled({
          'Retry-After': new Date(Date.now() + 45_000).toUTCString(),
        }),
        throttled({ 'Retry-After': '600' }),
      ]);

      await vi.advanceTimersByTimeAsync(44_999);
      expect(pricingCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pricingCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(pricingCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(pricingCalls()).toBe(3);
      await vi.runAllTimersAsync();
      await entries;
    });

    it('gives each page its own budget for failures other than 429', async () => {
      const unavailable = () => new Response(null, { status: 503 });
      const firstPage = makePricingResponse(
        [makePricingItem()],
        'https://prices.azure.com/api/retail/prices?page=2',
      );
      const entries = fetchWith([
        ...Array.from({ length: 4 }, unavailable),
        throttled(),
        unavailable(),
        new Response(JSON.stringify(firstPage)),
        ...Array.from({ length: 5 }, unavailable),
      ]);
      await vi.runAllTimersAsync();

      expect(await entries).toHaveLength(1);
      expect(pricingCalls()).toBe(13);
    });

    it('keeps six attempts for failures other than 429', async () => {
      const entries = fetchWith(
        Array.from({ length: 6 }, () => new Response(null, { status: 503 })),
      );
      const failure = expect(entries).rejects.toThrow('Pricing API HTTP 503');
      await vi.runAllTimersAsync();

      await failure;
      expect(pricingCalls()).toBe(6);
    });
  });

  it('merges spot prices correctly', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ unitPrice: 0.192 }),
        makePricingItem({
          unitPrice: 0.038,
          meterName: 'D4s v5 Spot',
          skuName: 'D4s v5 Spot',
        }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].price).toBe(0.192);
    expect(entries[0].spotPrice).toBe(0.038);
  });

  it('maps GPU families correctly', async () => {
    const gpuSKU = makeSKU({
      name: 'Standard_NC40ads_H100_v5',
      family: 'StandardNCadsH100v5Family',
      capabilities: [
        { name: 'vCPUs', value: '40' },
        { name: 'MemoryGB', value: '320' },
        { name: 'GPUs', value: '1' },
        { name: 'HyperVGenerations', value: 'V2' },
      ],
    });

    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({
          armSkuName: 'Standard_NC40ads_H100_v5',
          unitPrice: 6.98,
        }),
      ]),
      skus: makeSKUResponse([gpuSKU]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      instanceType: 'Standard_NC40ads_H100_v5',
      acceleratorName: 'H100',
      acceleratorCount: 1,
      gpuInfo: 'H100',
      quotaGroup: 'standardncadsh100v5family',
      price: 6.98,
    });
  });

  it('drops unsupported pre-Turing GPU families but keeps V100', async () => {
    const gpuCaps = [
      { name: 'vCPUs', value: '6' },
      { name: 'MemoryGB', value: '56' },
      { name: 'GPUs', value: '1' },
      { name: 'HyperVGenerations', value: 'V2' },
    ];
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armSkuName: 'Standard_NC6' }), // K80 (Kepler)
        makePricingItem({ armSkuName: 'Standard_NC6s_v2' }), // P100 (Pascal)
        makePricingItem({ armSkuName: 'Standard_ND6s' }), // P40 (Pascal)
        makePricingItem({ armSkuName: 'Standard_NV6' }), // M60 (Maxwell)
        makePricingItem({ armSkuName: 'Standard_NC6s_v3' }), // V100 (Volta)
      ]),
      skus: makeSKUResponse([
        makeSKU({
          name: 'Standard_NC6',
          family: 'StandardNCFamily',
          capabilities: gpuCaps,
        }),
        makeSKU({
          name: 'Standard_NV6',
          family: 'StandardNVFamily',
          capabilities: gpuCaps,
        }),
        makeSKU({
          name: 'Standard_NC6s_v2',
          family: 'StandardNCSv2Family',
          capabilities: gpuCaps,
        }),
        makeSKU({
          name: 'Standard_ND6s',
          family: 'StandardNDSFamily',
          capabilities: gpuCaps,
        }),
        makeSKU({
          name: 'Standard_NC6s_v3',
          family: 'StandardNCSv3Family',
          capabilities: gpuCaps,
        }),
      ]),
    });

    const entries = await new AzureCatalogFetcher(CREDS).fetchAll();
    const types = entries.map((e) => e.instanceType);

    for (const retired of [
      'Standard_NC6',
      'Standard_NC6s_v2',
      'Standard_ND6s',
      'Standard_NV6',
    ]) {
      expect(types).not.toContain(retired);
    }
    // V100 (standardncsv3family) survives and routes to dstack-cuda-0.10.
    expect(types).toContain('Standard_NC6s_v3');
  });

  it('drops GPU rows outside community-gallery image regions but keeps CPU rows there', async () => {
    const gpuSKU = makeSKU({
      name: 'Standard_NC16as_T4_v3',
      family: 'StandardNCASv3_T4Family',
      capabilities: [
        { name: 'vCPUs', value: '16' },
        { name: 'MemoryGB', value: '110' },
        { name: 'GPUs', value: '1' },
        { name: 'HyperVGenerations', value: 'V2' },
      ],
    });

    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({
          armSkuName: 'Standard_NC16as_T4_v3',
          armRegionName: 'australiacentral',
          unitPrice: 1.565,
        }),
        makePricingItem({
          armSkuName: 'Standard_NC16as_T4_v3',
          armRegionName: 'eastus',
          unitPrice: 1.204,
        }),
        makePricingItem({
          armRegionName: 'australiacentral',
          unitPrice: 0.192,
        }),
      ]),
      skus: makeSKUResponse([makeSKU(), gpuSKU]),
      locations: makeLocationsResponse([
        { name: 'australiacentral', regionType: 'Physical' },
        { name: 'eastus', regionType: 'Physical' },
      ]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(
      entries
        .filter((e) => e.instanceType === 'Standard_NC16as_T4_v3')
        .map((e) => e.region),
    ).toEqual(['eastus']);
    expect(
      entries.find(
        (e) =>
          e.instanceType === 'Standard_D4s_v5' &&
          e.region === 'australiacentral',
      ),
    ).toMatchObject({
      acceleratorName: null,
      acceleratorCount: null,
    });
  });

  it('applies fractional A10 GPU counts', async () => {
    const a10SKU = makeSKU({
      name: 'Standard_NV6ads_A10_v5',
      family: 'StandardNVADSA10v5Family',
      capabilities: [
        { name: 'vCPUs', value: '6' },
        { name: 'MemoryGB', value: '55' },
        { name: 'GPUs', value: '1' },
        { name: 'HyperVGenerations', value: 'V2' },
      ],
    });

    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({
          armSkuName: 'Standard_NV6ads_A10_v5',
          unitPrice: 0.45,
        }),
      ]),
      skus: makeSKUResponse([a10SKU]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].acceleratorName).toBe('A10');
    expect(entries[0].acceleratorCount).toBe(0.167);
  });

  it('filters out Windows and Low Priority entries', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem(),
        makePricingItem({
          armSkuName: 'Standard_D4s_v5_Win',
          productName: 'Virtual Machines D Series Win',
        }),
        makePricingItem({
          armSkuName: 'Standard_D4s_v5_LP',
          skuName: 'D4s v5 Low Priority',
        }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].instanceType).toBe('Standard_D4s_v5');
  });

  it('drops entries without SKU data (inner join)', async () => {
    // Pricing may list SKUs our subscription's SKUs API has never seen
    // (subscription-scoped enrollment). Without specs we can't emit a row.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armSkuName: 'Standard_D4s_v5' }),
        makePricingItem({ armSkuName: 'Standard_Unknown_v99' }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].instanceType).toBe('Standard_D4s_v5');
  });

  it('keeps Physical regions and drops sovereign regions not in /locations', async () => {
    // /subscriptions/{id}/locations enumerates only the commercial Azure cloud
    // this subscription sits in. Sovereign clouds (usgov*, china*) are in
    // separate Azure instances, so they never appear and are naturally dropped.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armRegionName: 'eastus' }),
        makePricingItem({ armRegionName: 'usgovvirginia' }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].region).toBe('eastus');
  });

  it('drops logical-region aliases (regionType !== Physical)', async () => {
    // /locations returns both Physical regions and Logical geography/stage
    // aliases (`europe`, `eastusstage`). Azure won't provision to aliases.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armRegionName: 'eastus' }),
        makePricingItem({ armRegionName: 'europe' }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].region).toBe('eastus');
  });

  it('drops Physical regions without networkSecurityGroups support', async () => {
    // Access-restricted regions (CDC-operated australiacentral2) are Physical
    // in /locations and priced by the Pricing API, but the Microsoft.Network
    // provider doesn't offer NSGs there, so provisioning deterministically
    // fails at firewall setup. NSG locations come back as display names
    // ("East US"), which must be normalized to canonical region names.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armRegionName: 'eastus' }),
        makePricingItem({ armRegionName: 'australiacentral2' }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
      locations: makeLocationsResponse([
        { name: 'eastus', regionType: 'Physical' },
        { name: 'australiacentral2', regionType: 'Physical' },
      ]),
      nsgLocations: ['East US'],
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].region).toBe('eastus');
  });

  it('throws when the Network provider returns no NSG locations', async () => {
    // An empty NSG location list means a broken or reshaped provider response;
    // shipping a catalog where every region is filtered out must fail loudly.
    mockFetchResponses({
      pricing: makePricingResponse([makePricingItem()]),
      skus: makeSKUResponse([makeSKU()]),
      nsgLocations: [],
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    await expect(fetcher.fetchAll()).rejects.toThrow(
      /no networkSecurityGroups locations/,
    );
  });

  it('borrows SKU specs across regions (region-invariant)', async () => {
    // SKU-level fields (vCPUs, memory, gpu) are region-invariant for Azure VMs.
    // Even if the SKUs API only returns a SKU row from one region, specs still
    // apply to every Physical region where pricing advertises it.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armRegionName: 'eastus' }),
        makePricingItem({ armRegionName: 'westus2' }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.region).sort()).toEqual(['eastus', 'westus2']);
    for (const e of entries) {
      expect(e.vCPUs).toBe(4);
      expect(e.memoryGiB).toBe(16);
      expect(e.generation).toBe('V2');
    }
  });

  it('uses first SKU row for specs when the SKUs API repeats rows', async () => {
    // The SKUs API returns one row per (SKU, region) pair. Specs are identical
    // across rows; first-row-wins avoids redundant work and must not change
    // the emitted entries.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armRegionName: 'eastus' }),
      ]),
      skus: makeSKUResponse([makeSKU(), makeSKU(), makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      instanceType: 'Standard_D4s_v5',
      region: 'eastus',
      vCPUs: 4,
      memoryGiB: 16,
    });
  });

  it('normalizes /locations region casing to match pricing keys', async () => {
    // Pricing armRegionName is lowercased when building the key. /locations
    // sometimes returns camel/PascalCase — both must be normalized to match.
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ armRegionName: 'eastus' }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
      locations: makeLocationsResponse([
        { name: 'EastUS', regionType: 'Physical' },
      ]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].region).toBe('eastus');
  });

  it('filters out zero-price entries', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([
        makePricingItem({ unitPrice: 0.192 }),
        makePricingItem({
          armSkuName: 'Standard_Free_v1',
          unitPrice: 0,
        }),
      ]),
      skus: makeSKUResponse([makeSKU()]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const entries = await fetcher.fetchAll();

    expect(entries).toHaveLength(1);
    expect(entries[0].price).toBe(0.192);
  });

  it('throws when Physical-region filter drops > 25% of matched entries', async () => {
    // Drop-guard canary: if /locations collapses or the Physical filter is
    // misapplied, we'd ship a degraded catalog silently. Fabricate a pricing
    // set where > 25% of matched (SKU, region) pairs fall outside /locations.
    const physicalRegions = Array.from({ length: 90 }, (_, i) => ({
      name: `physical${i}`,
      regionType: 'Physical',
    }));
    const pricingItems = [
      ...Array.from({ length: 90 }, (_, i) =>
        makePricingItem({ armRegionName: `physical${i}` }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        makePricingItem({ armRegionName: `sovereign${i}` }),
      ),
    ];

    mockFetchResponses({
      pricing: makePricingResponse(pricingItems),
      skus: makeSKUResponse([makeSKU()]),
      locations: makeLocationsResponse(physicalRegions),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    await expect(fetcher.fetchAll()).rejects.toThrow(
      /Physical-region filter dropped 40\/130.*exceeds 25% threshold/,
    );
  });

  it('rejects a case-insensitive SKU mapped to conflicting quota families', async () => {
    mockFetchResponses({
      pricing: makePricingResponse([makePricingItem()]),
      skus: makeSKUResponse([
        makeSKU({ family: 'StandardDSv5Family' }),
        makeSKU({
          name: 'standard_d4s_v5',
          family: 'StandardESv5Family',
        }),
      ]),
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    await expect(fetcher.fetchAll()).rejects.toThrow(
      /SKU standard_d4s_v5 maps to conflicting quota families azure:standarddsv5family and azure:standardesv5family/,
    );
  });

  it('writes Usage API observations under canonical keys with sorted regions', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('login.microsoftonline.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeTokenResponse()),
        });
      }
      if (url.includes('/usages?api-version=')) {
        const rawName = url.includes('/eastus/')
          ? 'Standard NCASv3_T4 Family'
          : 'standardncasv3_t4family';
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              value: [
                { name: { value: rawName } },
                { name: { value: rawName } },
              ],
            }),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const familyKey = createAzureQuotaIdentity(
      'StandardNCASv3_T4Family',
    ).resourceKey;
    const artifact = await fetcher.fetchUsageFamilies(new Set([familyKey]), [
      'westus2',
      'eastus',
    ]);

    expect(artifact).toEqual({
      'azure:standardncasv3_t4family': {
        rawNames: ['Standard NCASv3_T4 Family', 'standardncasv3_t4family'],
        regions: 'eastus,westus2',
      },
    });
    expect(artifact['azure:standardncasv3_t4family']).not.toHaveProperty('raw');
  });

  it('rejects distinct Usage API names that collide within one region', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('login.microsoftonline.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeTokenResponse()),
        });
      }
      if (url.includes('/usages?api-version=')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              value: [
                { name: { value: 'Standard NCASv3_T4 Family' } },
                { name: { value: 'standardncasv3_t4family' } },
              ],
            }),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const fetcher = new AzureCatalogFetcher(CREDS);
    const familyKey = createAzureQuotaIdentity(
      'StandardNCASv3_T4Family',
    ).resourceKey;
    await expect(
      fetcher.fetchUsageFamilies(new Set([familyKey]), ['eastus']),
    ).rejects.toThrow(
      /Usage API returned an ambiguous canonical collision for azure:standardncasv3_t4family in eastus/,
    );
  });
});

describe('entriesToCSV', () => {
  it('produces CSV matching catalog schema', () => {
    const entries = [
      {
        instanceType: 'Standard_D4s_v5',
        region: 'eastus',
        price: 0.192,
        spotPrice: 0.038,
        vCPUs: 4,
        memoryGiB: 16,
        acceleratorName: null,
        acceleratorCount: null,
        gpuInfo: null,
        availabilityZone: null,
        generation: 'V2',
        quotaGroup: 'standarddsv5family',
      },
    ];

    const csv = entriesToCSV(entries);
    const lines = csv.trim().split('\n');

    expect(lines[0]).toBe(
      'InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,AvailabilityZone,Generation,QuotaGroup,PremiumStorageCapable,NestedVirtualizationSupported',
    );
    expect(lines[1]).toBe(
      'Standard_D4s_v5,,,4,16,,0.192,0.038,eastus,,V2,standarddsv5family,,',
    );
  });

  it('round-trips through parseCatalogCSV', () => {
    const entries = [
      {
        instanceType: 'Standard_D4s_v5',
        region: 'eastus',
        price: 0.192,
        spotPrice: 0.038,
        vCPUs: 4,
        memoryGiB: 16,
        acceleratorName: null,
        acceleratorCount: null,
        gpuInfo: null,
        availabilityZone: null,
        generation: 'V2',
        quotaGroup: 'standarddsv5family',
      },
      {
        instanceType: 'Standard_NC40ads_H100_v5',
        region: 'eastus',
        price: 6.98,
        spotPrice: 2.1,
        vCPUs: 40,
        memoryGiB: 320,
        acceleratorName: 'H100',
        acceleratorCount: 1,
        gpuInfo: 'H100',
        availabilityZone: null,
        generation: 'V2',
        quotaGroup: 'standardncadsh100v5family',
      },
    ];

    const csv = entriesToCSV(entries);
    const indexes = parseCatalogCSV(csv, CloudType.Azure);

    expect(indexes.regionsPerType['standard_d4s_v5']).toEqual(['eastus']);
    expect(indexes.pricePerTypeRegion['standard_d4s_v5']['eastus']).toBe(0.192);
    expect(indexes.spotPricePerTypeRegion['standard_d4s_v5']['eastus']).toBe(
      0.038,
    );
    expect(indexes.typesPerAccelerator['H100']).toEqual([
      {
        instanceType: 'Standard_NC40ads_H100_v5',
        count: 1,
        vCPUs: 40,
        memoryGiB: 320,
      },
    ]);
    expect(indexes.quotaGroupPerType['standard_nc40ads_h100_v5']).toBe(
      'azure:standardncadsh100v5family',
    );
  });
});
