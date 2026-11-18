import { describe, expect, it } from 'vitest';
import {
  readCatalog,
  type CatalogIndexes,
} from '../../../../src/shared/catalog/index.js';
import {
  getCpuOfferings,
  getDiskForVMType,
  getGpuOfferings,
  getPremiumStorageCapable,
  getPricing,
} from '../../../../src/shared/catalog/queries.js';
import { CloudType } from '../../../../src/shared/cloud.js';

function requireCatalog(cloud: CloudType): CatalogIndexes {
  const catalog = readCatalog(cloud);
  expect(catalog, `${cloud} published catalog was not loaded`).toBeDefined();
  return catalog!;
}

function firstEntry<T>(record: Record<string, T>): [string, T] {
  const entry = Object.entries(record)[0];
  expect(entry).toBeDefined();
  return entry!;
}

function cheapest(
  prices: Record<string, number> | undefined,
): { region: string; pricePerHour: number } | null {
  if (!prices) return null;
  const entries = Object.entries(prices);
  if (entries.length === 0) return null;
  const [region, pricePerHour] = entries.reduce((best, current) =>
    current[1] < best[1] ? current : best,
  );
  return { region, pricePerHour };
}

describe('catalog queries against published catalogs', () => {
  describe('getPricing', () => {
    it('returns an exact real on-demand price', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const [vmType, prices] = firstEntry(catalog.pricePerTypeRegion);
      const [region, pricePerHour] = firstEntry(prices);

      expect(getPricing(CloudType.AWS, vmType, region, false)).toEqual({
        vmType,
        region,
        spot: false,
        pricePerHour,
      });
    });

    it('sorts a real VM type across regions cheapest-first', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const [vmType, prices] = Object.entries(catalog.pricePerTypeRegion).find(
        ([, priceMap]) => Object.keys(priceMap).length > 1,
      )!;
      const expected = Object.entries(prices)
        .map(([region, pricePerHour]) => ({ region, pricePerHour }))
        .sort((a, b) => a.pricePerHour - b.pricePerHour);

      expect(
        getPricing(CloudType.AWS, vmType, undefined, false)?.regions,
      ).toEqual(expected);
    });

    it('reads the real spot-price index', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const [vmType, prices] = firstEntry(catalog.spotPricePerTypeRegion);
      const [region, pricePerHour] = firstEntry(prices);

      expect(getPricing(CloudType.AWS, vmType, region, true)).toEqual({
        vmType,
        region,
        spot: true,
        pricePerHour,
      });
    });

    it('matches real VM type keys case-insensitively', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const [vmType, prices] = firstEntry(catalog.pricePerTypeRegion);
      const [region, pricePerHour] = firstEntry(prices);

      expect(
        getPricing(CloudType.AWS, vmType.toUpperCase(), region, false)
          ?.pricePerHour,
      ).toBe(pricePerHour);
    });

    it('returns undefined for unknown targets or a catalog-less cloud', () => {
      expect(
        getPricing(CloudType.AWS, 'not-a-real-vm-type', undefined, false),
      ).toBeUndefined();
      const catalog = requireCatalog(CloudType.AWS);
      const [vmType] = firstEntry(catalog.pricePerTypeRegion);
      expect(
        getPricing(CloudType.AWS, vmType, 'not-a-real-region', false),
      ).toBeUndefined();
      expect(
        getPricing(CloudType.Local, 'local', undefined, false),
      ).toBeUndefined();
    });
  });

  describe('getDiskForVMType', () => {
    it('returns real AWS local-disk metadata', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const [vmType, disk] = firstEntry(catalog.localDiskPerType);

      expect(getDiskForVMType(CloudType.AWS, vmType)).toEqual({
        kind: 'local-ssd',
        sizeGb: disk.sizeGb,
        count: disk.count,
        totalGb: disk.totalGb,
        ...(disk.type ? { type: disk.type } : {}),
      });
    });

    it('returns undefined for a real type without local-disk metadata', () => {
      const catalog = requireCatalog(CloudType.GCP);
      const vmType = Object.keys(catalog.regionsPerType).find(
        (type) => catalog.localDiskPerType[type] === undefined,
      );
      expect(vmType).toBeDefined();
      expect(getDiskForVMType(CloudType.GCP, vmType!)).toBeUndefined();
    });
  });

  describe('getPremiumStorageCapable', () => {
    it('returns both true and false values from the real Azure catalog', () => {
      const catalog = requireCatalog(CloudType.Azure);
      const capable = Object.entries(catalog.premiumStorageCapablePerType).find(
        ([, value]) => value === true,
      );
      const incapable = Object.entries(
        catalog.premiumStorageCapablePerType,
      ).find(([, value]) => value === false);
      expect(capable).toBeDefined();
      expect(incapable).toBeDefined();

      expect(
        getPremiumStorageCapable(CloudType.Azure, capable![0].toUpperCase()),
      ).toBe(true);
      expect(
        getPremiumStorageCapable(CloudType.Azure, incapable![0].toUpperCase()),
      ).toBe(false);
    });

    it('returns undefined for an unknown type or catalog-less cloud', () => {
      expect(
        getPremiumStorageCapable(CloudType.Azure, 'not-a-real-vm-type'),
      ).toBeUndefined();
      expect(
        getPremiumStorageCapable(CloudType.Local, 'local'),
      ).toBeUndefined();
    });
  });

  describe('getGpuOfferings', () => {
    it('projects real accelerator rows with cheapest-region pricing', () => {
      const catalog = requireCatalog(CloudType.GCP);
      const [gpu] = firstEntry(catalog.typesPerAccelerator);
      const rows = getGpuOfferings(CloudType.GCP, gpu);
      const counts = new Set(
        catalog.typesPerAccelerator[gpu]!.map((entry) => entry.count),
      );

      expect(rows).toHaveLength(counts.size);
      for (const row of rows) {
        const source = catalog.typesPerAccelerator[gpu]!.find(
          (entry) => entry.instanceType === row.vmType,
        );
        expect(source).toBeDefined();
        expect(row).toMatchObject({
          gpu,
          count: source!.count,
          vCPUs: source!.vCPUs,
          memoryGiB: source!.memoryGiB,
          onDemand: cheapest(
            catalog.pricePerTypeRegion[row.vmType.toLowerCase()],
          ),
          spot: cheapest(
            catalog.spotPricePerTypeRegion[row.vmType.toLowerCase()],
          ),
        });
      }
    });

    it('matches real accelerator names case-insensitively', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const [gpu] = firstEntry(catalog.typesPerAccelerator);
      expect(getGpuOfferings(CloudType.AWS, gpu.toLowerCase())).toEqual(
        getGpuOfferings(CloudType.AWS, gpu.toUpperCase()),
      );
    });

    it('chooses the cheapest real sibling for a shared GPU/count', () => {
      const catalog = requireCatalog(CloudType.Lambda);
      const entries = catalog.typesPerAccelerator.H100?.filter(
        (entry) => entry.count === 1,
      );
      expect(entries?.length).toBeGreaterThan(1);
      const expected = entries!
        .map((entry) => ({
          entry,
          price:
            cheapest(
              catalog.pricePerTypeRegion[entry.instanceType.toLowerCase()],
            )?.pricePerHour ?? Infinity,
        }))
        .sort((a, b) => a.price - b.price)[0]!.entry.instanceType;

      const row = getGpuOfferings(CloudType.Lambda, 'H100').find(
        (offering) => offering.count === 1,
      );
      expect(row?.vmType).toBe(expected);
    });

    it('emits every real count and handles unknown/missing catalogs', () => {
      const catalog = requireCatalog(CloudType.GCP);
      const accelerator = Object.entries(catalog.typesPerAccelerator).find(
        ([, entries]) => new Set(entries.map((entry) => entry.count)).size > 1,
      );
      expect(accelerator).toBeDefined();
      const [gpu, entries] = accelerator!;
      expect(
        getGpuOfferings(CloudType.GCP, gpu).map((row) => row.count),
      ).toEqual(
        [...new Set(entries.map((entry) => entry.count))].sort((a, b) => a - b),
      );
      expect(getGpuOfferings(CloudType.GCP, 'not-a-real-accelerator')).toEqual(
        [],
      );
      expect(getGpuOfferings(CloudType.Local)).toEqual([]);
    });
  });

  describe('getCpuOfferings', () => {
    it('projects every priced real CPU type with its specs', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const rows = getCpuOfferings(CloudType.AWS);
      const expectedTypes = catalog.cpuTypes.filter((vmType) => {
        const key = vmType.toLowerCase();
        return Boolean(
          catalog.pricePerTypeRegion[key] ??
            catalog.spotPricePerTypeRegion[key],
        );
      });

      expect(rows).toHaveLength(expectedTypes.length);
      for (const row of rows.slice(0, 20)) {
        const key = row.vmType.toLowerCase();
        expect(row).toMatchObject({
          vCPUs: catalog.vCPUsPerType[key] ?? 0,
          memoryGiB: catalog.memoryPerType[key] ?? 0,
          onDemand: cheapest(catalog.pricePerTypeRegion[key]),
          spot: cheapest(catalog.spotPricePerTypeRegion[key]),
        });
      }
    });

    it('keeps same-shape real instance families and sorts cheapest-first', () => {
      const catalog = requireCatalog(CloudType.AWS);
      const rows = getCpuOfferings(CloudType.AWS);
      const shapeCounts = new Map<string, number>();
      for (const row of rows) {
        const shape = `${row.vCPUs}:${row.memoryGiB}`;
        shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
      }
      expect([...shapeCounts.values()].some((count) => count > 1)).toBe(true);

      const rates = rows.map(
        (row) =>
          row.onDemand?.pricePerHour ?? row.spot?.pricePerHour ?? Infinity,
      );
      expect(rates).toEqual([...rates].sort((a, b) => a - b));
      expect(catalog.cpuTypes.length).toBeGreaterThan(0);
    });

    it('returns an empty list for a catalog-less cloud', () => {
      expect(getCpuOfferings(CloudType.Local)).toEqual([]);
    });
  });
});
