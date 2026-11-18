import { createHash } from 'node:crypto';
import type { ResourceSku } from '@azure/arm-compute';
import type { CatalogIndexes } from '../../../shared/catalog/index.js';

export interface AzureSkuAvailabilityIndex {
  readonly usableTargets: Set<string>;
  totalEntries: number;
  vmEntries: number;
}

export interface AzureCatalogRegion {
  readonly region: string;
  readonly targetKeys: ReadonlySet<string>;
  readonly targetFingerprint: string;
}

export interface AzureCatalogDefinition {
  readonly regions: ReadonlyMap<string, AzureCatalogRegion>;
  readonly catalogTargets: number;
}

export interface AzureCatalogRegionObservation {
  readonly region: string;
  readonly observedAt: number;
  readonly restrictedTargets: readonly string[];
  readonly catalogTargets: number;
  readonly totalEntries: number;
  readonly vmEntries: number;
}

export function normalizeAzureCatalogLocation(location: string): string {
  return location.replace(/\s+/g, '').toLowerCase();
}

export function azureCatalogTargetKey(vmType: string, region: string): string {
  return `${vmType.toLowerCase()}\u0000${normalizeAzureCatalogLocation(region)}`;
}

/** Stable identity for the catalog targets covered by one regional observation. */
function azureCatalogTargetFingerprint(targetKeys: Iterable<string>): string {
  return createHash('sha256')
    .update(JSON.stringify([...targetKeys].sort()))
    .digest('hex');
}

/** Build the immutable target sets used by every subscription overlay. */
export function buildAzureCatalogDefinition(
  catalog: Pick<CatalogIndexes, 'typesPerRegion'>,
): AzureCatalogDefinition {
  const targetsByRegion = new Map<string, Set<string>>();

  for (const [catalogRegion, vmTypes] of Object.entries(
    catalog.typesPerRegion,
  )) {
    const region = normalizeAzureCatalogLocation(catalogRegion);
    let targetKeys = targetsByRegion.get(region);
    if (!targetKeys) {
      targetKeys = new Set<string>();
      targetsByRegion.set(region, targetKeys);
    }
    for (const vmType of vmTypes) {
      targetKeys.add(azureCatalogTargetKey(vmType, region));
    }
  }

  const regions = new Map<string, AzureCatalogRegion>();
  let catalogTargets = 0;
  for (const [region, targetKeys] of [...targetsByRegion].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    catalogTargets += targetKeys.size;
    regions.set(region, {
      region,
      targetKeys,
      targetFingerprint: azureCatalogTargetFingerprint(targetKeys),
    });
  }
  return { regions, catalogTargets };
}

function normalizedLocations(
  values: readonly string[] | undefined,
): Set<string> {
  return new Set((values ?? []).map(normalizeAzureCatalogLocation));
}

function skuLocations(sku: ResourceSku): Set<string> {
  const locations = normalizedLocations(sku.locations);
  for (const info of sku.locationInfo ?? []) {
    if (info.location) {
      locations.add(normalizeAzureCatalogLocation(info.location));
    }
  }
  return locations;
}

function restrictedLocations(sku: ResourceSku): Set<string> {
  const locations = new Set<string>();
  for (const restriction of sku.restrictions ?? []) {
    if (restriction.type !== 'Location') continue;
    for (const location of normalizedLocations(restriction.values)) {
      locations.add(location);
    }
    for (const location of normalizedLocations(
      restriction.restrictionInfo?.locations,
    )) {
      locations.add(location);
    }
  }
  return locations;
}

export function createAzureSkuAvailabilityIndex(): AzureSkuAvailabilityIndex {
  return { usableTargets: new Set(), totalEntries: 0, vmEntries: 0 };
}

/** Add one SDK result without retaining its capability-heavy object graph. */
export function indexAzureResourceSku(
  index: AzureSkuAvailabilityIndex,
  sku: ResourceSku,
): void {
  index.totalEntries += 1;
  if (sku.resourceType !== 'virtualMachines' || !sku.name) return;
  index.vmEntries += 1;
  const restricted = restrictedLocations(sku);
  for (const region of skuLocations(sku)) {
    if (!restricted.has(region)) {
      index.usableTargets.add(azureCatalogTargetKey(sku.name, region));
    }
  }
}

/** Diff one filtered Resource SKUs response against one catalog region. */
export function buildAzureCatalogRegionObservation(
  catalogRegion: AzureCatalogRegion,
  index: AzureSkuAvailabilityIndex,
  observedAt = Date.now(),
): AzureCatalogRegionObservation {
  const restrictedTargets = [...catalogRegion.targetKeys]
    .filter((target) => !index.usableTargets.has(target))
    .sort();

  return {
    region: catalogRegion.region,
    observedAt,
    restrictedTargets,
    catalogTargets: catalogRegion.targetKeys.size,
    totalEntries: index.totalEntries,
    vmEntries: index.vmEntries,
  };
}
