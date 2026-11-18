import { CloudType } from '../cloud.js';
import { readCatalog, type CatalogIndexes } from './index.js';

export interface DiskOffering {
  kind: 'local-ssd' | 'disk';
  totalGb: number;
  sizeGb?: number;
  count?: number;
  type?: string;
}

interface PricingEntry {
  region: string;
  pricePerHour: number;
}

export interface PricingResponse {
  vmType: string;
  spot: boolean;
  region?: string;
  pricePerHour?: number;
  regions?: PricingEntry[];
}

export interface GpuOffering {
  gpu: string;
  count: number;
  vmType: string;
  vCPUs: number;
  memoryGiB: number;
  onDemand: { region: string; pricePerHour: number } | null;
  spot: { region: string; pricePerHour: number } | null;
}

type GpuOfferingsPricingMode = 'on-demand-preferred' | 'spot';

export interface GetGpuOfferingsOptions {
  pricingMode?: GpuOfferingsPricingMode;
}

export interface CpuOffering {
  vmType: string;
  vCPUs: number;
  memoryGiB: number;
  onDemand: { region: string; pricePerHour: number } | null;
  spot: { region: string; pricePerHour: number } | null;
}

type RegionPrice = { region: string; pricePerHour: number } | null;

function cheapestRegion(
  priceMap: Record<string, number> | undefined,
): RegionPrice {
  if (!priceMap) return null;
  let best: RegionPrice = null;
  for (const [region, pricePerHour] of Object.entries(priceMap)) {
    if (!best || pricePerHour < best.pricePerHour) {
      best = { region, pricePerHour };
    }
  }
  return best;
}

/** Ranking rate for an offering: cheapest on-demand, else spot, else Infinity. */
function offeringRate(o: { onDemand: RegionPrice; spot: RegionPrice }): number {
  return o.onDemand?.pricePerHour ?? o.spot?.pricePerHour ?? Infinity;
}

function gpuOfferingRank(
  o: { onDemand: RegionPrice; spot: RegionPrice },
  pricingMode: GpuOfferingsPricingMode,
): number | undefined {
  if (pricingMode === 'spot') return o.spot?.pricePerHour;
  return o.onDemand?.pricePerHour ?? o.spot?.pricePerHour;
}

export function getDiskForVMType(
  cloud: CloudType,
  vmType: string,
): DiskOffering | undefined {
  const catalog = readCatalog(cloud);
  const disk = catalog?.localDiskPerType[vmType.toLowerCase()];
  if (!disk) return undefined;

  return {
    kind: 'local-ssd',
    totalGb: disk.totalGb,
    sizeGb: disk.sizeGb,
    count: disk.count,
    type: disk.type,
  };
}

/**
 * Raw local NVMe on H100 and A100 sizes, in GiB, for catalogs that don't
 * record it; 0 is a size without it. Azure from Microsoft Learn's size pages
 * (NC A100 v4's devices are 960 GB); GCP from its bundled Local SSD (375 GiB
 * each, none on A2 Standard or `-nolssd`). AWS's catalog records its instance
 * store, and Lambda's root disk is already local.
 */
export const NVME_GIB: Record<string, number> = {
  standard_nc24ads_a100_v4: 894,
  standard_nc48ads_a100_v4: 1788,
  standard_nc96ads_a100_v4: 3576,
  standard_nd96asr_v4: 6000,
  standard_nd96amsr_a100_v4: 6400,
  standard_nc40ads_h100_v5: 3576,
  standard_nc80adis_h100_v5: 7152,
  standard_ncc40ads_h100_v5: 0,
  standard_nd96isr_h100_v5: 28608,
  'a2-highgpu-1g': 0,
  'a2-highgpu-2g': 0,
  'a2-highgpu-4g': 0,
  'a2-highgpu-8g': 0,
  'a2-megagpu-16g': 0,
  'a2-ultragpu-1g': 375,
  'a2-ultragpu-2g': 750,
  'a2-ultragpu-4g': 1500,
  'a2-ultragpu-8g': 3000,
  'a3-highgpu-1g': 750,
  'a3-highgpu-2g': 1500,
  'a3-highgpu-4g': 3000,
  'a3-highgpu-8g': 6000,
  'a3-megagpu-8g': 6000,
  'a3-edgegpu-8g': 6000,
  'a3-edgegpu-8g-nolssd': 0,
};

/** An H100 or A100 VM type's raw local NVMe in GiB; undefined without it. */
export function getNvmeGibForVMType(
  cloud: CloudType,
  vmType: string,
): number | undefined {
  const key = vmType.toLowerCase();
  const catalog = readCatalog(cloud);
  const h100OrA100 = Object.entries(catalog?.typesPerAccelerator ?? {}).some(
    ([name, types]) =>
      /^(H100|A100)/i.test(name) &&
      types.some((type) => type.instanceType.toLowerCase() === key),
  );
  const disk = catalog?.localDiskPerType[key];
  const gib =
    NVME_GIB[key] ?? (disk && Math.floor((disk.totalGb * 1e9) / 2 ** 30));
  return (h100OrA100 && gib) || undefined;
}

/**
 * Whether a VM type supports Premium SSD storage (Azure `PremiumIO`). Returns
 * `undefined` when the catalog has no premium-capability data for this type
 * (unknown VM, or a catalog fetched before the column existed) — callers must
 * treat `undefined` as "unknown/allowed", not "not capable".
 */
export function getPremiumStorageCapable(
  cloud: CloudType,
  vmType: string,
): boolean | undefined {
  return readCatalog(cloud)?.premiumStorageCapablePerType[vmType.toLowerCase()];
}

/**
 * Look up pricing for a VM type across regions (or one region).
 * Returns undefined if no catalog data exists for the cloud, or if the VM
 * type has no pricing entries. Returns null for `pricePerHour` (single
 * region) when the region exists in the catalog but lacks a price.
 */
export function getPricing(
  cloud: CloudType,
  vmType: string,
  region: string | undefined,
  spot: boolean,
): PricingResponse | undefined {
  const catalog = readCatalog(cloud);
  if (!catalog) return undefined;

  const prices = spot
    ? catalog.spotPricePerTypeRegion[vmType.toLowerCase()]
    : catalog.pricePerTypeRegion[vmType.toLowerCase()];
  if (!prices) return undefined;

  if (region) {
    const price = prices[region];
    if (price === undefined) return undefined;
    return { vmType, region, spot, pricePerHour: price };
  }

  const regions = Object.entries(prices)
    .map(([r, p]) => ({ region: r, pricePerHour: p }))
    .sort((a, b) => a.pricePerHour - b.pricePerHour);
  return { vmType, spot, regions };
}

/**
 * List GPU offerings for a cloud, one row per (gpu, count) pair. Picks the
 * cheapest VM type by the requested pricing mode when multiple VM types share
 * the same gpu+count. Returns an empty array when catalog data is missing.
 */
export function getGpuOfferings(
  cloud: CloudType,
  gpuFilter?: string,
  options: GetGpuOfferingsOptions = {},
): GpuOffering[] {
  const catalog = readCatalog(cloud);
  return getGpuOfferingsFromCatalog(catalog, gpuFilter, options);
}

/**
 * Index-backed form of getGpuOfferings for callers that already parsed a
 * catalog (for example pre-publication validation). The public cloud wrapper
 * above and validation therefore share the exact ranking and filtering logic.
 */
export function getGpuOfferingsFromCatalog(
  catalog: CatalogIndexes | undefined,
  gpuFilter?: string,
  options: GetGpuOfferingsOptions = {},
): GpuOffering[] {
  if (!catalog) return [];

  const results: GpuOffering[] = [];
  const pricingMode = options.pricingMode ?? 'on-demand-preferred';

  // Catalog stores GPU keys uppercase; mirror getGPUVMTypes (in
  // shared/cloud-config.ts) which normalizes its `accelerator` arg to
  // uppercase so callers can pass lowercase per the docs (e.g.
  // `--type h100`). Without this, lowercase input silently returned [].
  const gpuFilterUpper = gpuFilter?.toUpperCase();
  for (const [gpu, entries] of Object.entries(catalog.typesPerAccelerator)) {
    if (gpuFilterUpper && gpu.toUpperCase() !== gpuFilterUpper) continue;

    const byCount = new Map<number, typeof entries>();
    for (const entry of entries) {
      const list = byCount.get(entry.count) ?? [];
      list.push(entry);
      byCount.set(entry.count, list);
    }

    for (const [count, vms] of byCount) {
      let best: GpuOffering | null = null;
      for (const vm of vms) {
        const key = vm.instanceType.toLowerCase();
        const onDemand = cheapestRegion(catalog.pricePerTypeRegion[key]);
        const spot = cheapestRegion(catalog.spotPricePerTypeRegion[key]);
        const rank = gpuOfferingRank({ onDemand, spot }, pricingMode);
        if (pricingMode === 'spot' && rank === undefined) continue;
        const bestRank =
          best === null ? undefined : gpuOfferingRank(best, pricingMode);
        if (
          best === null ||
          (rank !== undefined && (bestRank === undefined || rank < bestRank))
        ) {
          best = {
            gpu,
            count,
            vmType: vm.instanceType,
            vCPUs: vm.vCPUs,
            memoryGiB: vm.memoryGiB,
            onDemand,
            spot,
          };
        }
      }
      if (best) results.push(best);
    }
  }

  results.sort((a, b) => a.gpu.localeCompare(b.gpu) || a.count - b.count);
  return results;
}

/**
 * List CPU (non-accelerator) offerings for a cloud — one per instance type (NOT
 * shape-deduped), so a family search like "t3" finds every t3 size. Skips types
 * with no pricing. Sorted cheapest-first. Returns an empty array when catalog
 * data is missing. (The submit picker shows a short curated default and uses
 * this full list for type-to-search; deduping here would hide whole families
 * whose cheapest-per-shape survivor is a different family, e.g. t3a/t4g vs t3.)
 */
export function getCpuOfferings(cloud: CloudType): CpuOffering[] {
  const catalog = readCatalog(cloud);
  if (!catalog) return [];

  const offerings: CpuOffering[] = [];
  for (const vmType of catalog.cpuTypes) {
    const key = vmType.toLowerCase();
    const onDemand = cheapestRegion(catalog.pricePerTypeRegion[key]);
    const spot = cheapestRegion(catalog.spotPricePerTypeRegion[key]);
    if (!onDemand && !spot) continue;
    offerings.push({
      vmType,
      vCPUs: catalog.vCPUsPerType[key] ?? 0,
      memoryGiB: catalog.memoryPerType[key] ?? 0,
      onDemand,
      spot,
    });
  }

  return offerings.sort(
    (a, b) =>
      offeringRate(a) - offeringRate(b) || a.vmType.localeCompare(b.vmType),
  );
}
