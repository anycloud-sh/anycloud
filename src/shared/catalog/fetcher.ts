/**
 * General cloud catalog fetcher interface.
 * Implement CloudCatalogFetcher per cloud provider.
 */

export interface VMCatalogEntry {
  instanceType: string;
  region: string;
  /** Only populated for clouds where it carries pricing/availability info (GCP). */
  availabilityZone: string | null;
  price: number | null;
  spotPrice: number | null;
  vCPUs: number | null;
  memoryGiB: number | null;
  acceleratorName: string | null;
  acceleratorCount: number | null;
  gpuInfo: string | null;
  generation: string | null;
  /** Provider-native quota grouping key when known. */
  quotaGroup?: string | null;
  /**
   * Whether the VM size supports Premium SSD storage (Azure only; from the
   * `PremiumIO` SKU capability). Undefined for clouds that don't report it.
   */
  premiumStorageCapable?: boolean;
  /** Provider-reported support; absent means unknown. */
  nestedVirtualizationSupported?: boolean;
  /** Provider-reported CPU architecture (GCP); absent means unknown. */
  arch?: 'arm64' | 'x86_64' | null;
}

export interface CloudCatalogFetcher {
  fetchAll(): Promise<VMCatalogEntry[]>;
}

const CSV_COLUMNS: (keyof VMCatalogEntry)[] = [
  'instanceType',
  'acceleratorName',
  'acceleratorCount',
  'vCPUs',
  'memoryGiB',
  'gpuInfo',
  'price',
  'spotPrice',
  'region',
  'availabilityZone',
  'generation',
  'quotaGroup',
  'premiumStorageCapable',
  'nestedVirtualizationSupported',
  'arch',
];

// Header names for the catalog CSV schema
const CSV_HEADERS = [
  'InstanceType',
  'AcceleratorName',
  'AcceleratorCount',
  'vCPUs',
  'MemoryGiB',
  'GpuInfo',
  'Price',
  'SpotPrice',
  'Region',
  'AvailabilityZone',
  'Generation',
  'QuotaGroup',
  'PremiumStorageCapable',
  'NestedVirtualizationSupported',
  'Arch',
];

function formatValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert catalog entries to a CSV string in catalog CSV format.
 */
export function entriesToCSV(entries: VMCatalogEntry[]): string {
  const lines: string[] = [CSV_HEADERS.join(',')];
  for (const entry of entries) {
    const values = CSV_COLUMNS.map((col) => formatValue(entry[col]));
    lines.push(values.join(','));
  }
  return lines.join('\n') + '\n';
}
