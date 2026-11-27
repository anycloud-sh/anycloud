/**
 * Azure catalog fetcher.
 * Triple-joins the Retail Pricing API (public), the Resource SKUs API (needs
 * creds, provides specs), and the subscription /locations endpoint (needs
 * creds, provides the set of commercial Physical regions). Pricing advertises
 * (SKU, region) pairs Azure won't actually provision; /locations filters those
 * out without relying on the subscription's narrow per-SKU locationInfo view.
 * Physical regions are further intersected with the Microsoft.Network
 * provider's networkSecurityGroups locations: access-restricted regions
 * (e.g. australiacentral2) are Physical yet can never provision because
 * firewall setup requires an NSG in-region.
 */

import { withRetry } from '../utils.js';
import { retryAfterMs } from '../retry-after.js';
import type { CloudCatalogFetcher, VMCatalogEntry } from './fetcher.js';
import {
  AZURE_GPU_COMMUNITY_IMAGE_REGIONS,
  AZURE_FAMILY_TO_GPU,
  DEPRECATED_FAMILIES,
  FRACTIONAL_A10_GPU_COUNTS,
} from './azure-gpu-map.js';
import {
  createAzureQuotaIdentity,
  type AzureQuotaResourceKey,
} from '../quota-resolvers/azure-identity.js';
import { errorMessage } from '../log-diagnostics.js';
import { azureNestedVirtualization } from './nested-virtualization.js';

// --- Retail Pricing API types ---

interface PricingItem {
  armSkuName: string;
  armRegionName: string;
  unitPrice: number;
  skuName: string;
  productName: string;
  meterName: string;
  currencyCode: string;
}

interface PricingResponse {
  Items: PricingItem[];
  NextPageLink: string | null;
}

// --- Resource SKUs API types ---

interface SKUCapability {
  name: string;
  value: string;
}

interface ResourceSKU {
  name: string;
  resourceType: string;
  family: string;
  capabilities: SKUCapability[];
}

interface SKUResponse {
  value: ResourceSKU[];
  nextLink?: string;
}

// --- Usage API types (family-name ground truth; not quota levels) ---

interface UsageItem {
  name?: { value?: string; localizedValue?: string };
}

interface UsageResponse {
  value: UsageItem[];
}

export interface UsageFamilyObservation {
  rawNames: string[];
  regions: string;
}

// --- Token response ---

interface TokenResponse {
  access_token: string;
}

// --- Internal types ---

interface PricingData {
  price: number | null;
  spotPrice: number | null;
}

interface SKUData {
  vCPUs: number;
  memoryGiB: number;
  gpuCount: number;
  gpuName: string | null;
  generation: string | null;
  quotaGroup: string;
  // Whether the VM size supports Premium SSD (managed) storage. Azure reports
  // this as the `PremiumIO` SKU capability; used to gate --disk-tier high/ultra
  // (which provision a Premium OS disk) before provisioning. `undefined` when
  // Azure didn't report the capability (unknown → consumers degrade to allow).
  premiumStorageCapable: boolean | undefined;
  /** The `CpuArchitectureType` SKU capability: `Arm64` or `x64`. */
  arch: 'arm64' | 'x86_64' | null;
}

interface LocationMetadata {
  regionType?: string;
}

interface Location {
  name: string;
  metadata?: LocationMetadata;
}

interface LocationsResponse {
  value: Location[];
}

// --- Providers API types ---

interface ProviderResourceType {
  resourceType: string;
  locations?: string[];
}

interface ProviderResponse {
  resourceTypes?: ProviderResourceType[];
}

export interface AzureCredentials {
  subscriptionId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const PRICING_API_BASE = 'https://prices.azure.com/api/retail/prices';

/**
 * The Retail Prices API throttles a refresh for minutes at a time, so a 429
 * gets a longer budget than other failures and waits at least its
 * `Retry-After`.
 */
const PRICING_THROTTLED_ATTEMPTS = 10;
const PRICING_THROTTLED_MAX_WAIT_MS = 120_000;
const PRICING_OTHER_ATTEMPTS = 6;

class PricingThrottledError extends Error {
  constructor(readonly retryAfterMs: number | undefined) {
    super(
      'Pricing API HTTP 429' +
        (retryAfterMs === undefined
          ? ''
          : ` (Retry-After ${Math.ceil(retryAfterMs / 1000)}s)`),
    );
  }
}

const PRICING_FILTERS = [
  "serviceName eq 'Virtual Machines'",
  "priceType eq 'Consumption'",
  "currencyCode eq 'USD'",
].join(' and ');

const ARM_API_VERSION = '2021-07-01';
const PROVIDERS_API_VERSION = '2021-04-01';

// Physical-region filter canary. Pricing advertises (SKU, region) combos for
// sovereign and logical regions; /locations excludes those. A much larger drop
// usually means /locations came back empty or the Physical filter is wrong —
// abort loudly instead of shipping a collapsed catalog.
const MIN_MATCHED_FOR_DROP_GUARD = 100;
const MAX_REGION_DROP_RATIO = 0.25;

export class AzureCatalogFetcher implements CloudCatalogFetcher {
  constructor(private creds: AzureCredentials) {}

  async fetchAll(): Promise<VMCatalogEntry[]> {
    const token = await this.getAccessToken();
    const [pricingMap, skuMap, physicalRegions, nsgRegions] = await Promise.all(
      [
        this.fetchPricing(),
        this.fetchSKUs(token),
        this.fetchPhysicalRegions(token),
        this.fetchNsgRegions(token),
      ],
    );

    const provisionableRegions = new Set(
      [...physicalRegions].filter((r) => nsgRegions.has(r)),
    );
    const droppedNsgRegions = physicalRegions.size - provisionableRegions.size;
    if (droppedNsgRegions > 0) {
      console.log(
        `Dropped ${droppedNsgRegions} Physical regions without networkSecurityGroups support`,
      );
    }

    const entries: VMCatalogEntry[] = [];
    let pricingMatched = 0;
    let droppedByRegion = 0;
    let droppedGpuOutsideCommunityRegion = 0;
    for (const [key, pricing] of pricingMap) {
      const [instanceType, region] = key.split('|');
      const sku = skuMap.get(instanceType);
      // Inner join: skip entries without SKU data
      if (!sku) continue;
      pricingMatched++;
      // Pricing API lists (SKU, region) pairs for sovereign clouds and
      // logical-region aliases that Azure won't provision. /locations'
      // Physical regions, minus NSG-incapable restricted regions, are the
      // authoritative provisionable set.
      if (!provisionableRegions.has(region)) {
        droppedByRegion++;
        continue;
      }

      // the public community-gallery GPU images (the Azure GPU default) are only
      // replicated to a subset of regions; a GPU VM scheduled where the image
      // isn't replicated fails with a gallery NotFound. Drop GPU (SKU, region)
      // entries outside the replicated set — CPU is unaffected.
      if (sku.gpuName && !AZURE_GPU_COMMUNITY_IMAGE_REGIONS.has(region)) {
        droppedGpuOutsideCommunityRegion++;
        continue;
      }

      const acceleratorCount =
        FRACTIONAL_A10_GPU_COUNTS[instanceType] ?? (sku.gpuCount || null);

      entries.push({
        instanceType,
        region,
        availabilityZone: null,
        price: pricing.price,
        spotPrice: pricing.spotPrice,
        vCPUs: sku.vCPUs,
        memoryGiB: sku.memoryGiB,
        acceleratorName: sku.gpuName,
        acceleratorCount,
        gpuInfo: sku.gpuName,
        generation: sku.generation,
        quotaGroup: sku.quotaGroup,
        premiumStorageCapable: sku.premiumStorageCapable,
        nestedVirtualizationSupported: azureNestedVirtualization(instanceType),
        arch: sku.arch,
      });
    }
    if (droppedByRegion > 0) {
      console.log(
        `Dropped ${droppedByRegion} (SKU, region) pricing entries whose region is not Physical in /locations`,
      );
    }
    if (droppedGpuOutsideCommunityRegion > 0) {
      console.log(
        `Dropped ${droppedGpuOutsideCommunityRegion} GPU (SKU, region) entries outside the community-gallery images' replicated regions`,
      );
    }

    if (pricingMatched >= MIN_MATCHED_FOR_DROP_GUARD) {
      const dropRatio = droppedByRegion / pricingMatched;
      if (dropRatio > MAX_REGION_DROP_RATIO) {
        throw new Error(
          `Azure catalog: Physical-region filter dropped ${droppedByRegion}/${pricingMatched} ` +
            `(${(dropRatio * 100).toFixed(1)}%) of matched (SKU, region) entries — exceeds ` +
            `${MAX_REGION_DROP_RATIO * 100}% threshold. ` +
            `Expect ~15% drop from pricing advertising sovereign and logical-region combos. ` +
            `A much higher ratio usually means /locations returned an unexpectedly narrow set.`,
        );
      }
    }

    // Sort for deterministic output
    entries.sort(
      (a, b) =>
        a.instanceType.localeCompare(b.instanceType) ||
        a.region.localeCompare(b.region),
    );

    return entries;
  }

  // --- Retail Pricing API ---

  private async fetchPricing(): Promise<Map<string, PricingData>> {
    const map = new Map<string, PricingData>();
    const filter = encodeURIComponent(PRICING_FILTERS);
    let url: string | null = `${PRICING_API_BASE}?$filter=${filter}`;
    let page = 0;

    while (url) {
      page++;
      if (page % 50 === 0) {
        console.log(`Fetched ${page} pricing pages...`);
      }

      let otherFailures = 0;
      const data = await withRetry(
        async () => {
          const res = await fetch(url!, {
            signal: AbortSignal.timeout(30_000),
          });
          if (res.status === 429) {
            throw new PricingThrottledError(
              retryAfterMs(res.headers, Date.now(), {
                maxMs: PRICING_THROTTLED_MAX_WAIT_MS,
              }),
            );
          }
          if (!res.ok) throw new Error(`Pricing API HTTP ${res.status}`);
          return (await res.json()) as PricingResponse;
        },
        'Fetch Azure pricing page',
        {
          maxAttempts: PRICING_THROTTLED_ATTEMPTS,
          waitMs: 10_000,
          maxWaitMs: 60_000,
          shouldRetry: (error) =>
            error instanceof PricingThrottledError ||
            ++otherFailures < PRICING_OTHER_ATTEMPTS,
          retryDelayMs: (error, attempt) =>
            error instanceof PricingThrottledError
              ? Math.min(
                  PRICING_THROTTLED_MAX_WAIT_MS,
                  Math.max(
                    10_000 * 2 ** (attempt - 1),
                    error.retryAfterMs ?? 0,
                  ),
                )
              : undefined,
          onRetry: (attempt, _maxAttempts, error, waitMs) =>
            console.log(
              `Azure pricing page ${page}: attempt ${attempt} failed: ` +
                `${errorMessage(error)}; retrying in ${Math.round(waitMs / 1000)}s`,
            ),
        },
      );

      for (const item of data.Items) {
        if (!item.armSkuName || !item.armRegionName) continue;
        // Filter out Windows and Low Priority
        if (/\bWin\b/.test(item.productName)) continue;
        if (item.skuName.includes('Low Priority')) continue;
        // Filter out zero-price entries
        if (item.unitPrice <= 0) continue;

        const key = `${item.armSkuName}|${item.armRegionName.toLowerCase()}`;
        const isSpot = item.meterName.includes('Spot');

        if (!map.has(key)) {
          map.set(key, { price: null, spotPrice: null });
        }
        const entry = map.get(key)!;
        if (isSpot) {
          if (entry.spotPrice === null || item.unitPrice < entry.spotPrice) {
            entry.spotPrice = item.unitPrice;
          }
        } else {
          if (entry.price === null || item.unitPrice < entry.price) {
            entry.price = item.unitPrice;
          }
        }
      }

      url = data.NextPageLink ?? null;
    }

    console.log(
      `Fetched ${page} pricing pages, ${map.size} (instanceType, region) pairs`,
    );
    return map;
  }

  // --- Resource SKUs API ---

  private async fetchSKUs(token: string): Promise<Map<string, SKUData>> {
    const map = new Map<string, SKUData>();
    const familyKeyBySku = new Map<string, AzureQuotaResourceKey>();

    let url: string | null =
      `https://management.azure.com/subscriptions/${this.creds.subscriptionId}` +
      `/providers/Microsoft.Compute/skus?api-version=${ARM_API_VERSION}` +
      `&$filter=resourceType eq 'virtualMachines'`;

    while (url) {
      const data = await withRetry(
        async () => {
          const res = await fetch(url!, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`SKU API HTTP ${res.status}`);
          return (await res.json()) as SKUResponse;
        },
        'Fetch Azure SKUs page',
        { maxAttempts: 6, waitMs: 10_000, maxWaitMs: 60_000 },
      );

      for (const sku of data.value) {
        if (sku.resourceType !== 'virtualMachines') continue;
        if (!sku.family?.trim()) {
          throw new Error(
            `Azure catalog: SKU ${sku.name || '(unnamed)'} has no quota family`,
          );
        }
        const familyIdentity = createAzureQuotaIdentity(sku.family);
        const normalizedFamily = familyIdentity.resourceKey.slice(
          'azure:'.length,
        );

        // Azure repeats Resource SKU rows by region. A case-insensitive SKU
        // must resolve to one family across every row; otherwise first-row-wins
        // would make the published catalog depend on API ordering.
        const skuKey = sku.name.toLowerCase();
        const previousFamilyKey = familyKeyBySku.get(skuKey);
        if (
          previousFamilyKey !== undefined &&
          previousFamilyKey !== familyIdentity.resourceKey
        ) {
          throw new Error(
            `Azure catalog: SKU ${sku.name} maps to conflicting quota families ` +
              `${previousFamilyKey} and ${familyIdentity.resourceKey}`,
          );
        }
        familyKeyBySku.set(skuKey, familyIdentity.resourceKey);
        if (DEPRECATED_FAMILIES.has(normalizedFamily)) continue;

        // The SKUs API returns one row per (SKU, region) pair. Static fields
        // (vCPUs, memory, gpu) are region-invariant for Azure VMs, so
        // first-row-wins is safe.
        if (map.has(sku.name)) continue;

        const caps: Record<string, string> = {};
        for (const c of sku.capabilities) {
          caps[c.name] = c.value;
        }

        const vCPUs = parseFloat(caps['vCPUs'] || '');
        const memoryGiB = parseFloat(caps['MemoryGB'] || '');
        if (isNaN(vCPUs) || isNaN(memoryGiB)) continue;

        let gpuCount = 0;
        let gpuName: string | null = null;
        if (caps['GPUs']) {
          gpuCount = parseInt(caps['GPUs'], 10);
          gpuName = AZURE_FAMILY_TO_GPU[normalizedFamily] ?? null;
          if (gpuName === null && gpuCount > 0) {
            console.warn(
              `Unknown GPU family ${familyIdentity.resourceKey} for ${sku.name} (${gpuCount} GPUs)`,
            );
          }
        }

        map.set(sku.name, {
          vCPUs,
          memoryGiB,
          gpuCount,
          gpuName,
          generation: caps['HyperVGenerations'] ?? null,
          quotaGroup: normalizedFamily,
          premiumStorageCapable:
            caps['PremiumIO'] === undefined
              ? undefined
              : caps['PremiumIO'].toLowerCase() === 'true',
          arch:
            caps['CpuArchitectureType'] === 'Arm64'
              ? 'arm64'
              : caps['CpuArchitectureType'] === 'x64'
                ? 'x86_64'
                : null,
        });
      }

      url = data.nextLink ?? null;
    }

    console.log(`Fetched ${map.size} VM SKUs`);
    return map;
  }

  // --- Usage API ---

  /**
   * Per-region live confirmation of what Azure's Compute Usage API — the
   * endpoint production actually checks for quota headroom
   * (getInsufficientQuotaRegions in quota/azure.ts) — calls each VM family.
   * Deliberately independent from fetchSKUs' Resource SKUs data: the two APIs
   * can spell the same family differently (root cause of the 2026-07-09 T4
   * false-quota-block bug — Resource SKUs and Usage API disagreed on
   * whitespace), so Resource-SKU-derived quotaGroup data cannot stand in for
   * this. `neededFamilyKeys` restricts the result to families this fetch run
   * actually resolved into the catalog — Azure's full per-region usage list
   * includes ~50x more rows, mostly irrelevant CPU series.
   */
  async fetchUsageFamilies(
    neededFamilyKeys: ReadonlySet<AzureQuotaResourceKey>,
    regions: Iterable<string>,
  ): Promise<Record<string, UsageFamilyObservation>> {
    const token = await this.getAccessToken();
    const regionsByKey = new Map<AzureQuotaResourceKey, Set<string>>();
    const rawNamesByKey = new Map<AzureQuotaResourceKey, Set<string>>();
    const regionList = [...regions].sort();
    const CONCURRENCY = 5;

    for (let i = 0; i < regionList.length; i += CONCURRENCY) {
      const batch = regionList.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (region) => {
          let data: UsageResponse;
          try {
            data = await withRetry(
              async () => {
                const res = await fetch(
                  `https://management.azure.com/subscriptions/${this.creds.subscriptionId}` +
                    `/providers/Microsoft.Compute/locations/${region}/usages?api-version=${ARM_API_VERSION}`,
                  {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(30_000),
                  },
                );
                if (!res.ok) throw new Error(`Usage API HTTP ${res.status}`);
                return (await res.json()) as UsageResponse;
              },
              `Fetch Azure usage families for ${region}`,
              { maxAttempts: 3, waitMs: 5_000, maxWaitMs: 20_000 },
            );
          } catch (err) {
            console.warn(
              `  skipped usage-family fetch for ${region}: ${errorMessage(err)}`,
            );
            return;
          }

          const providerIdByKey = new Map<AzureQuotaResourceKey, string>();
          for (const item of data.value) {
            const raw = item.name?.value;
            if (!raw?.trim()) continue;
            const identity = createAzureQuotaIdentity(raw);
            const previousProviderId = providerIdByKey.get(
              identity.resourceKey,
            );
            if (
              previousProviderId !== undefined &&
              previousProviderId !== identity.providerId
            ) {
              throw new Error(
                `Azure catalog: Usage API returned an ambiguous canonical collision ` +
                  `for ${identity.resourceKey} in ${region}`,
              );
            }
            providerIdByKey.set(identity.resourceKey, identity.providerId);
            if (!neededFamilyKeys.has(identity.resourceKey)) continue;

            const regionSet =
              regionsByKey.get(identity.resourceKey) ?? new Set<string>();
            regionSet.add(region);
            regionsByKey.set(identity.resourceKey, regionSet);
            const rawNames =
              rawNamesByKey.get(identity.resourceKey) ?? new Set<string>();
            rawNames.add(identity.providerId);
            rawNamesByKey.set(identity.resourceKey, rawNames);
          }
        }),
      );
    }

    const byKey = Object.fromEntries(
      [...regionsByKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, seenRegions]) => [
          key,
          {
            rawNames: [...(rawNamesByKey.get(key) ?? [])].sort(),
            regions: [...seenRegions].sort().join(','),
          },
        ]),
    );

    console.log(
      `Fetched ${Object.keys(byKey).length}/${neededFamilyKeys.size} needed usage families from ${regionList.length} regions`,
    );
    return byKey;
  }

  // --- Locations API ---

  // Returns the set of lowercased Physical region names for this subscription.
  // Unlike the per-SKU locationInfo, /locations is not gated by SKU enrollment:
  // it enumerates every region reachable from this sub's Azure cloud instance.
  // Sovereign clouds (AzureUSGovernment, AzureChinaCloud) are separate
  // instances and naturally excluded. Logical regions (geography/stage aliases
  // like `europe`, `eastusstage`) have regionType !== 'Physical' and are
  // filtered out here.
  private async fetchPhysicalRegions(token: string): Promise<Set<string>> {
    const url =
      `https://management.azure.com/subscriptions/${this.creds.subscriptionId}` +
      `/locations?api-version=2022-12-01`;

    const data = await withRetry(
      async () => {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Locations API HTTP ${res.status}`);
        return (await res.json()) as LocationsResponse;
      },
      'Fetch Azure locations',
      { maxAttempts: 6, waitMs: 10_000, maxWaitMs: 60_000 },
    );

    const regions = new Set<string>();
    for (const loc of data.value) {
      if (loc.metadata?.regionType === 'Physical' && loc.name) {
        regions.add(loc.name.toLowerCase());
      }
    }
    console.log(`Fetched ${regions.size} Physical regions`);
    return regions;
  }

  // --- Providers API ---

  // Returns the set of regions where Microsoft.Network/networkSecurityGroups
  // is available, normalized to canonical form. Access-restricted regions
  // (e.g. CDC-operated australiacentral2) are Physical in /locations but
  // absent here, and provisioning requires an NSG before any VM is created,
  // so they can never succeed. Provider locations are display names
  // ("Australia Central 2"); canonical names are the same lowercased with
  // spaces removed.
  private async fetchNsgRegions(token: string): Promise<Set<string>> {
    const url =
      `https://management.azure.com/subscriptions/${this.creds.subscriptionId}` +
      `/providers/Microsoft.Network?api-version=${PROVIDERS_API_VERSION}`;

    const data = await withRetry(
      async () => {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Providers API HTTP ${res.status}`);
        return (await res.json()) as ProviderResponse;
      },
      'Fetch Azure Network provider',
      { maxAttempts: 6, waitMs: 10_000, maxWaitMs: 60_000 },
    );

    const nsgType = data.resourceTypes?.find(
      (t) => t.resourceType === 'networkSecurityGroups',
    );
    const regions = new Set<string>();
    for (const loc of nsgType?.locations ?? []) {
      regions.add(loc.toLowerCase().replace(/\s+/g, ''));
    }
    if (regions.size === 0) {
      throw new Error(
        'Azure catalog: Microsoft.Network provider returned no networkSecurityGroups locations — refusing to ship a catalog with zero provisionable regions',
      );
    }
    console.log(`Fetched ${regions.size} NSG-capable regions`);
    return regions;
  }

  // --- Auth ---

  private async getAccessToken(): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${this.creds.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: 'https://management.azure.com/.default',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Azure token request failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as TokenResponse;
    return data.access_token;
  }
}
