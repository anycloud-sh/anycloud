import { readFileSync, mkdirSync, existsSync, statSync, type Stats } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { CloudType } from '../cloud.js';
import { getAnycloudDir, toArray, withRetry } from '../utils.js';
import { PROVIDER_DATA } from '../providers.js';
import { gcpGpuMachineSelectionPriority } from '../gcp-machine-capabilities.js';
import {
  canonicalAzureQuotaResourceKey,
  createAzureQuotaIdentity,
} from '../quota-resolvers/azure-identity.js';
import { errorMessage } from '../log-diagnostics.js';
import { writeTextFileAtomicSync } from '../atomic-file.js';

export interface CatalogIndexes {
  /** Region-specific processor capability. Missing entries mean unknown. */
  nestedVirtualizationPerTypeRegion: Record<string, Record<string, boolean>>;
  typesPerRegion: Record<string, string[]>;
  regionsPerType: Record<string, string[]>;
  /** vCPU count per instance type (lowercased). */
  vCPUsPerType: Record<string, number>;
  /** Memory (GiB) per instance type (lowercased). */
  memoryPerType: Record<string, number>;
  /** Local instance disk per instance type (lowercased), when present in the catalog. */
  localDiskPerType: Record<string, CatalogLocalDisk>;
  /** Provider quota grouping key or family per instance type, when present. */
  quotaGroupPerType: Record<string, string>;
  /**
   * Whether an instance type supports Premium SSD storage (Azure only, from the
   * `PremiumIO` capability). Absent for types/clouds that don't report it —
   * consumers must treat a missing entry as "unknown", not "not capable".
   */
  premiumStorageCapablePerType: Record<string, boolean>;
  /** Instance types with no accelerator (CPU-only), original case, sorted. */
  cpuTypes: string[];
  /**
   * Instance types the catalog reports an accelerator COUNT for but no
   * accelerator NAME (e.g. Azure's RTX PRO 6000 and NP SKUs). They belong in
   * neither `cpuTypes` nor `typesPerAccelerator`: their runtime is unknown, not
   * absent. Lowercased.
   */
  unnamedAcceleratorTypes: string[];
  /** Cheapest on-demand price per (instanceType, region) pair */
  pricePerTypeRegion: Record<string, Record<string, number>>;
  /** Cheapest spot price per (instanceType, region) pair */
  spotPricePerTypeRegion: Record<string, Record<string, number>>;
  /**
   * Accelerator (GPU) name → instance types with GPU count, sorted by count
   * ascending then price ascending. Derived from AcceleratorName + AcceleratorCount.
   * e.g. { "H100": [{ instanceType: "p5.4xlarge", count: 1 }, { instanceType: "p5.48xlarge", count: 8 }] }
   */
  typesPerAccelerator: Record<
    string,
    { instanceType: string; count: number; vCPUs: number; memoryGiB: number }[]
  >;
}

interface CatalogLocalDisk {
  /** Size of one local disk device, in GB. */
  sizeGb: number;
  count: number;
  totalGb: number;
  type?: string;
}

const CATALOGS_DIR = 'catalogs';

// In-memory cache
const cache: Partial<Record<CloudType, CatalogIndexes>> = {};

function getCatalogsDir(): string {
  return join(getAnycloudDir(), CATALOGS_DIR);
}

function getCatalogPath(cloud: CloudType): string {
  const file = PROVIDER_DATA[cloud].compute?.catalogFile;
  if (!file) throw new Error(`No catalog for cloud provider: ${cloud}`);
  return join(getCatalogsDir(), file);
}

export interface CatalogDiskSource {
  path: string;
  revision: string;
}

/**
 * Stable identity for one atomically-written catalog file. Keeping this based
 * on file metadata lets account overlays detect replacement without hashing
 * the catalog on each read.
 */
function catalogRevisionFromStats(
  stats: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>,
): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

/** Return the current on-disk catalog and revision, if it is present. */
export function getCatalogDiskSource(
  cloud: CloudType,
): CatalogDiskSource | undefined {
  if (!PROVIDER_DATA[cloud].compute?.catalogFile) return undefined;
  const path = getCatalogPath(cloud);
  if (!existsSync(path)) return undefined;
  return { path, revision: catalogRevisionFromStats(statSync(path)) };
}

function hasReadableCatalog(cloud: CloudType): boolean {
  if (PROVIDER_DATA[cloud].compute?.catalogFile == null) return true;
  if (!existsSync(getCatalogPath(cloud))) return false;

  try {
    readCatalog(cloud);
    return true;
  } catch {
    delete cache[cloud];
    return false;
  }
}

/**
 * Parse a vms.csv catalog into catalog indexes.
 * Column order varies per cloud — we parse by header name.
 *
 * For GCP, we use AvailabilityZone (full zone like us-central1-a) as the
 * region key in typesPerRegion to preserve getZoneSuffixes() behavior.
 * For AWS/Azure, we use Region.
 */
export function parseCatalogCSV(csv: string, cloud: CloudType): CatalogIndexes {
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) {
    throw new Error('CSV has no data rows');
  }

  const firstRow = records[0];
  if (!('InstanceType' in firstRow)) {
    throw new Error('Missing CSV column: InstanceType');
  }
  if (!('Region' in firstRow)) {
    throw new Error('Missing CSV column: Region');
  }

  const useAZAsRegionKey =
    cloud === CloudType.GCP && 'AvailabilityZone' in firstRow;

  const typesPerRegion: Record<string, Set<string>> = {};
  const regionsPerType: Record<string, Set<string>> = {};
  const vCPUsPerType: Record<string, number> = {};
  const memoryPerType: Record<string, number> = {};
  const localDiskPerType: Record<string, CatalogLocalDisk> = {};
  const quotaGroupPerType: Record<string, string> = {};
  const premiumStorageCapablePerType: Record<string, boolean> = {};
  const nestedVirtualizationPerTypeRegion: Record<
    string,
    Record<string, boolean>
  > = {};
  // Instance types seen with no AcceleratorName (CPU-only candidates). Filtered
  // against accelerator types at emit time so a type that appears both ways is
  // never misclassified as CPU.
  const cpuTypeSet: Set<string> = new Set();
  // Instance types seen with an accelerator COUNT but no AcceleratorName. The
  // accelerator exists; only its runtime is unknown, so these must not fall
  // through to cpuTypeSet.
  const unnamedAcceleratorTypeSet: Set<string> = new Set();
  // Track cheapest price per (instanceType, region) — multiple AZs may have
  // different prices, we keep the minimum.
  const pricePerTypeRegion: Record<string, Record<string, number>> = {};
  const spotPricePerTypeRegion: Record<string, Record<string, number>> = {};
  // AcceleratorName → Set of instance types (only rows with both fields populated)
  const accTypes: Record<string, Set<string>> = {};
  // Track lowest (accCount, minPrice) per (accelerator, instanceType) for sorting
  const accSortKey: Record<
    string,
    Record<
      string,
      { count: number; price: number; vCPUs: number; memoryGiB: number }
    >
  > = {};

  for (const row of records) {
    const instanceType = row['InstanceType'];
    const region = row['Region'];
    if (!instanceType || !region) continue;

    const regionKey = useAZAsRegionKey ? row['AvailabilityZone'] : region;
    if (!regionKey) continue;

    if (!typesPerRegion[regionKey]) typesPerRegion[regionKey] = new Set();
    typesPerRegion[regionKey].add(instanceType);

    // Normalize VM type key to lowercase for case-insensitive lookups.
    // Azure VM types have inconsistent casing (e.g. Standard_NC40ads_H100_v5
    // vs Standard_NC40ads_h100_v5) which causes lookup misses.
    const typeKey = instanceType.toLowerCase();

    if (!regionsPerType[typeKey]) regionsPerType[typeKey] = new Set();
    regionsPerType[typeKey].add(regionKey);

    if (vCPUsPerType[typeKey] === undefined) {
      const vCPUs = parseFloat(row['vCPUs']);
      if (!isNaN(vCPUs)) vCPUsPerType[typeKey] = vCPUs;
    }

    if (memoryPerType[typeKey] === undefined) {
      const mem = parseFloat(row['MemoryGiB']);
      if (!isNaN(mem)) memoryPerType[typeKey] = mem;
    }

    if (localDiskPerType[typeKey] === undefined) {
      const sizeGb = parseFloat(row['LocalDiskSize']);
      const count = parseFloat(row['LocalDiskCount']);
      if (!isNaN(sizeGb) && !isNaN(count) && sizeGb > 0 && count > 0) {
        localDiskPerType[typeKey] = {
          sizeGb,
          count,
          totalGb: sizeGb * count,
          ...(row['LocalDiskType'] && { type: row['LocalDiskType'] }),
        };
      }
    }

    const quotaGroup = row['QuotaGroup'] || row['QuotaFamily'];
    if (quotaGroupPerType[typeKey] === undefined && quotaGroup) {
      quotaGroupPerType[typeKey] =
        cloud === CloudType.Azure
          ? (canonicalAzureQuotaResourceKey(quotaGroup) ??
            createAzureQuotaIdentity(quotaGroup).resourceKey)
          : quotaGroup;
    }

    // Premium-storage capability (Azure `PremiumIO`). Only set when the column
    // is present with an explicit true/false; a blank/absent column leaves the
    // type unknown so consumers degrade to "allowed".
    if (premiumStorageCapablePerType[typeKey] === undefined) {
      const raw = row['PremiumStorageCapable'];
      if (raw === 'true') premiumStorageCapablePerType[typeKey] = true;
      else if (raw === 'false') premiumStorageCapablePerType[typeKey] = false;
    }

    const nested = row['NestedVirtualizationSupported'];
    if (nested === 'true' || nested === 'false') {
      nestedVirtualizationPerTypeRegion[typeKey] ??= {};
      nestedVirtualizationPerTypeRegion[typeKey][regionKey] = nested === 'true';
    }

    // Track cheapest price per (type, region)
    const price = parseFloat(row['Price']);
    if (!isNaN(price)) {
      if (!pricePerTypeRegion[typeKey]) pricePerTypeRegion[typeKey] = {};
      const prev = pricePerTypeRegion[typeKey][region];
      if (prev === undefined || price < prev) {
        pricePerTypeRegion[typeKey][region] = price;
      }
    }
    const spotPrice = parseFloat(row['SpotPrice']);
    if (!isNaN(spotPrice)) {
      if (!spotPricePerTypeRegion[typeKey])
        spotPricePerTypeRegion[typeKey] = {};
      const prev = spotPricePerTypeRegion[typeKey][region];
      if (prev === undefined || spotPrice < prev) {
        spotPricePerTypeRegion[typeKey][region] = spotPrice;
      }
    }

    // Build accelerator → instance type index
    const accName = row['AcceleratorName'];
    if (accName) {
      const key = accName.toUpperCase();
      if (!accTypes[key]) accTypes[key] = new Set();
      accTypes[key].add(instanceType);
      // Track sort key: lowest GPU count first, then cheapest price
      const accCount = parseFloat(row['AcceleratorCount']) || 1;
      const accVCPUs = parseFloat(row['vCPUs']) || 0;
      const accMemoryGiB = parseFloat(row['MemoryGiB']) || 0;
      const accPrice = price;
      if (!accSortKey[key]) accSortKey[key] = {};
      const prev = accSortKey[key][instanceType];
      if (
        !prev ||
        accCount < prev.count ||
        (accCount === prev.count && accPrice < prev.price)
      ) {
        accSortKey[key][instanceType] = {
          count: accCount,
          price: accPrice,
          vCPUs: accVCPUs,
          memoryGiB: accMemoryGiB,
        };
      }
    } else if (
      (parseFloat(row['AcceleratorCount']) || 0) > 0 ||
      row['GpuInfo']
    ) {
      unnamedAcceleratorTypeSet.add(typeKey);
    } else {
      cpuTypeSet.add(instanceType);
    }
  }

  // Convert sets to sorted arrays
  const typesPerRegionArr: Record<string, string[]> = {};
  for (const [region, types] of Object.entries(typesPerRegion)) {
    typesPerRegionArr[region] = [...types].sort();
  }

  const regionsPerTypeArr: Record<string, string[]> = {};
  for (const [type, regions] of Object.entries(regionsPerType)) {
    regionsPerTypeArr[type] = [...regions].sort();
  }

  // Build accelerator index sorted by (GPU count asc, price asc)
  const typesPerAccelerator: Record<
    string,
    { instanceType: string; count: number; vCPUs: number; memoryGiB: number }[]
  > = {};
  for (const [acc, types] of Object.entries(accTypes)) {
    const sortKeys = accSortKey[acc] || {};
    typesPerAccelerator[acc] = [...types]
      .sort((a, b) => {
        const ka = sortKeys[a] || { count: Infinity, price: Infinity };
        const kb = sortKeys[b] || { count: Infinity, price: Infinity };
        return (
          ka.count - kb.count ||
          ka.price - kb.price ||
          (cloud === CloudType.GCP
            ? gcpGpuMachineSelectionPriority(a) -
                gcpGpuMachineSelectionPriority(b) || a.localeCompare(b)
            : 0)
        );
      })
      .map((t) => ({
        instanceType: t,
        count: sortKeys[t]?.count ?? 1,
        vCPUs: sortKeys[t]?.vCPUs ?? 0,
        memoryGiB: sortKeys[t]?.memoryGiB ?? 0,
      }));
  }

  // CPU types: candidates seen with no accelerator, minus any type that also
  // appeared as an accelerator instance (defensive against inconsistent rows).
  // Compare case-insensitively — Azure catalog casing is inconsistent (e.g.
  // Standard_NC..._H100_v5 vs ..._h100_v5), so an exact-case check would let a
  // GPU VM leak into cpuTypes and show up as a CPU choice in the picker.
  const acceleratorTypesLower = new Set(
    Object.values(accTypes)
      .flatMap((set) => [...set])
      .map((t) => t.toLowerCase()),
  );
  // A named row anywhere wins over an unnamed one, so a type that appears both
  // ways classifies by its name rather than staying unknown.
  const unnamedAcceleratorTypes = [...unnamedAcceleratorTypeSet]
    .filter((t) => !acceleratorTypesLower.has(t))
    .sort();
  const unnamedAcceleratorLower = new Set(unnamedAcceleratorTypes);
  const cpuTypes = [...cpuTypeSet]
    .filter(
      (t) =>
        !acceleratorTypesLower.has(t.toLowerCase()) &&
        !unnamedAcceleratorLower.has(t.toLowerCase()),
    )
    .sort();

  return {
    typesPerRegion: typesPerRegionArr,
    regionsPerType: regionsPerTypeArr,
    vCPUsPerType,
    memoryPerType,
    localDiskPerType,
    quotaGroupPerType,
    premiumStorageCapablePerType,
    nestedVirtualizationPerTypeRegion,
    cpuTypes,
    unnamedAcceleratorTypes,
    pricePerTypeRegion,
    spotPricePerTypeRegion,
    typesPerAccelerator,
  };
}

/**
 * Read and parse a catalog from disk. Returns cached version if available.
 * Returns undefined if the catalog file doesn't exist yet.
 */
export function readCatalog(cloud: CloudType): CatalogIndexes | undefined {
  if (cache[cloud]) return cache[cloud];
  if (!PROVIDER_DATA[cloud].compute?.catalogFile) return undefined;

  const path = getCatalogPath(cloud);
  if (!existsSync(path)) return undefined;

  const csv = readFileSync(path, 'utf-8');
  const indexes = parseCatalogCSV(csv, cloud);
  cache[cloud] = indexes;
  return indexes;
}

/**
 * Look up the hourly price for a VM type in a region.
 * Returns undefined if catalog is unavailable or no price found.
 */
export function lookupPrice(
  cloud: CloudType,
  vmType: string,
  region: string,
  spot: boolean,
): number | undefined {
  const catalog = readCatalog(cloud);
  if (!catalog) return undefined;
  const priceMap = spot
    ? catalog.spotPricePerTypeRegion
    : catalog.pricePerTypeRegion;
  return priceMap[vmType.toLowerCase()]?.[region];
}

/**
 * Resolve the catalog hourly price for a provisioned VM, given the cloud +
 * region the VM actually landed in. Returns undefined when the catalog has no
 * matching entry. Called before an attempt is registered so the price rides
 * along the same INSERT that sets `region` — no UPDATE on `workloads` required.
 * For an ordered fallback vmType list, the first catalog-priced entry is used:
 * the head may be a fake/unavailable type (unpriceable on this cloud) while a
 * later fallback is what actually provisions. Genuinely unpriceable → undefined.
 */
export function resolveWorkloadPrice(
  cloudProvider: CloudType | null,
  vmType: string | string[] | null | undefined,
  region: string | null | undefined,
  spot: boolean,
): number | undefined {
  if (!cloudProvider || !region) return undefined;
  for (const vt of toArray(vmType)) {
    const price = lookupPrice(cloudProvider, vt, region, spot);
    if (price !== undefined) return price;
  }
  return undefined;
}

/**
 * Write a raw CSV string to disk and invalidate the in-memory cache.
 */
export function writeCatalog(cloud: CloudType, csv: string): void {
  const dir = getCatalogsDir();
  mkdirSync(dir, { recursive: true });
  // Atomic write: write to a temp file then rename, so concurrent readers
  // never see a truncated/partial file (rename is atomic on POSIX).
  const finalPath = getCatalogPath(cloud);
  writeTextFileAtomicSync(finalPath, csv);
  // Invalidate cache so next readCatalog re-parses from disk
  delete cache[cloud];
}

/**
 * Clear all cached catalog data.
 */
export function clearCatalogCache(): void {
  for (const key of Object.keys(cache) as CloudType[]) {
    delete cache[key];
  }
}

const CATALOG_BASE =
  'https://raw.githubusercontent.com/anycloud-sh/catalog/main';
const CATALOG_API_BASE =
  'https://api.github.com/repos/anycloud-sh/catalog/contents';

// Clouds that have catalogs (derived from PROVIDER_DATA: non-null catalogFile)
const CATALOG_CLOUDS = (Object.keys(PROVIDER_DATA) as CloudType[]).filter(
  (cloud) => PROVIDER_DATA[cloud].compute?.catalogFile != null,
);

function getCatalogGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function getCatalogFetchHeaders(url: string): HeadersInit | undefined {
  const token = getCatalogGitHubToken();
  if (!token || !url.startsWith(CATALOG_API_BASE)) return undefined;
  return {
    Accept: 'application/vnd.github.raw',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function getCatalogSources(cloud: CloudType): string[] {
  const path = `${cloud.toLowerCase()}/vms.csv`;
  const sources = [`${CATALOG_BASE}/${path}`];
  if (getCatalogGitHubToken()) {
    sources.push(`${CATALOG_API_BASE}/${path}?ref=main`);
  }
  return sources;
}

async function fetchCSV(
  urls: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return withRetry(
    async () => {
      const errors: string[] = [];
      for (const url of urls) {
        signal?.throwIfAborted();
        try {
          const headers = getCatalogFetchHeaders(url);
          const requestTimeoutSignal = AbortSignal.timeout(30_000);
          const res = await fetch(url, {
            signal: signal
              ? AbortSignal.any([signal, requestTimeoutSignal])
              : requestTimeoutSignal,
            ...(headers ? { headers } : {}),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.text();
        } catch (err) {
          // A caller/shared cancellation is terminal. Per-request timeouts do
          // not abort the shared signal, so they still fall through to the
          // alternate source and the existing retry policy.
          signal?.throwIfAborted();
          errors.push(`${url}: ${errorMessage(err)}`);
        }
      }
      throw new Error(`All catalog sources failed:\n  ${errors.join('\n  ')}`);
    },
    'Fetch catalog CSV',
    { maxAttempts: 3, waitMs: 5_000, signal },
  );
}

/**
 * True if any catalog CSV is missing on disk. CLI commands use this to
 * decide whether to show a "downloading catalog" spinner before falling
 * through to their normal flow.
 */
export function needsCatalogBootstrap(): boolean {
  return CATALOG_CLOUDS.some((cloud) => !hasReadableCatalog(cloud));
}

async function fetchAndWriteCatalog(
  cloud: CloudType,
  signal?: AbortSignal,
): Promise<void> {
  const csv = await fetchCSV(getCatalogSources(cloud), signal);
  signal?.throwIfAborted();
  parseCatalogCSV(csv, cloud);
  signal?.throwIfAborted();
  writeCatalog(cloud, csv);
}

export interface CatalogRefreshOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

interface InFlightCatalogRefresh {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
}

const inFlightCatalogRefreshes = new Map<CloudType, InFlightCatalogRefresh>();

function refreshWaitSignal(
  options: CatalogRefreshOptions,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (options.deadlineAt !== undefined) {
    const remainingMs = Math.floor(options.deadlineAt - Date.now());
    if (remainingMs <= 0) {
      throw new DOMException(
        'The catalog refresh deadline elapsed',
        'TimeoutError',
      );
    }
    signals.push(AbortSignal.timeout(remainingMs));
  }
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function startCatalogRefresh(cloud: CloudType): InFlightCatalogRefresh {
  const controller = new AbortController();
  const entry: InFlightCatalogRefresh = {
    controller,
    promise: Promise.resolve(),
    waiters: 0,
    settled: false,
  };

  entry.promise = fetchAndWriteCatalog(cloud, controller.signal).then(
    () => {
      entry.settled = true;
      if (inFlightCatalogRefreshes.get(cloud) === entry) {
        inFlightCatalogRefreshes.delete(cloud);
      }
    },
    (error) => {
      entry.settled = true;
      if (inFlightCatalogRefreshes.get(cloud) === entry) {
        inFlightCatalogRefreshes.delete(cloud);
      }
      throw error;
    },
  );
  inFlightCatalogRefreshes.set(cloud, entry);
  return entry;
}

async function waitForCatalogRefresh(
  cloud: CloudType,
  entry: InFlightCatalogRefresh,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  entry.waiters += 1;
  let removeAbortListener: (() => void) | undefined;
  try {
    if (!signal) {
      await entry.promise;
      return;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The catalog refresh was aborted', 'AbortError'),
        );
      };
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    await Promise.race([entry.promise, aborted]);
  } finally {
    removeAbortListener?.();
    entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled) {
      // Delete before aborting. Abort handlers can synchronously initiate new
      // work, and they must never join this already-abandoned promise.
      if (inFlightCatalogRefreshes.get(cloud) === entry) {
        inFlightCatalogRefreshes.delete(cloud);
      }
      entry.promise.catch(() => {});
      entry.controller.abort(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException(
              'The catalog refresh has no remaining callers',
              'AbortError',
            ),
      );
    }
  }
}

/** Force-refresh one cloud catalog even when a readable cached copy exists. */
export async function refreshCatalog(
  cloud: CloudType,
  options: CatalogRefreshOptions = {},
): Promise<void> {
  if (PROVIDER_DATA[cloud].compute?.catalogFile == null) return;
  const signal = refreshWaitSignal(options);
  signal?.throwIfAborted();
  const entry =
    inFlightCatalogRefreshes.get(cloud) ?? startCatalogRefresh(cloud);
  await waitForCatalogRefresh(cloud, entry, signal);
}

/** Test-only cleanup for cases that intentionally abandon an in-flight fetch. */
export function resetCatalogRefreshCoordinatorForTest(): void {
  const cancellation = new DOMException(
    'Catalog refresh coordinator reset',
    'AbortError',
  );
  for (const [cloud, entry] of inFlightCatalogRefreshes) {
    inFlightCatalogRefreshes.delete(cloud);
    if (!entry.settled) {
      entry.promise.catch(() => {});
      entry.controller.abort(cancellation);
    }
  }
}

/**
 * Bootstrap any missing catalog CSVs by calling getCatalogs() once.
 * No-op if every catalog file already exists on disk. Used by the CLI so
 * read-only catalog commands work standalone, without the API running.
 *
 * Freshness is not the CLI's job — the API monitor refreshes hourly. This
 * only handles the cold-start case where the user has installed the CLI
 * but never started the API.
 *
 * Stricter than getCatalogs() (which only fails hard when a cloud has no
 * cached catalog to fall back to): this throws if any cloud's download failed
 * at all — bootstrap is the one-shot CLI cold-start path, so reporting success
 * while a catalog is still missing would mislead the next read.
 */
export async function ensureCatalogsBootstrapped(): Promise<void> {
  if (!needsCatalogBootstrap()) return;
  const errors = await getCatalogs();
  const failed = Object.entries(errors);
  if (failed.length > 0) {
    const detail = failed.map(([cloud, err]) => `${cloud}: ${err}`).join('; ');
    throw new Error(`Failed to download catalog(s): ${detail}`);
  }
}

/**
 * Bootstrap a single cloud's catalog if it's missing. Used by server paths that
 * need only one cloud's data (e.g. quota status for AWS or Azure), so an
 * unrelated cloud's missing or failing catalog can't fail the request. Throws
 * only if THIS cloud's download fails. No-op when the cloud has no catalog file
 * or its CSV is already on disk.
 */
export async function ensureCatalogBootstrapped(
  cloud: CloudType,
): Promise<void> {
  if (PROVIDER_DATA[cloud].compute?.catalogFile == null) return;
  if (hasReadableCatalog(cloud)) return;
  await refreshCatalog(cloud);
}

/**
 * Fetch latest catalogs and write to disk.
 * Called by the API monitor on startup + hourly, and by tests.
 *
 * A download failure is tolerated only when that cloud already has a usable
 * catalog on disk to fall back to: those are returned as soft errors
 * (cloud -> message) so the caller can keep serving the stale-but-present data.
 * When a cloud has no catalog at all this throws — "keep existing data" keeps
 * nothing, and a swallowed failure would leave every later read throwing a
 * misleading "<vmType> not in catalog" attributed to whoever reads next.
 */
export async function getCatalogs(): Promise<Record<string, string>> {
  const results = await Promise.all(
    CATALOG_CLOUDS.map(async (cloud) => {
      try {
        await refreshCatalog(cloud);
        return { cloud, error: null };
      } catch (error) {
        return {
          cloud,
          error: error,
        };
      }
    }),
  );
  const errors: Record<string, string> = {};
  const unusable: string[] = [];
  for (const { cloud, error } of results) {
    if (!error) continue;
    // A failed download is survivable only when a previously-fetched catalog is
    // still on disk to fall back to. With no catalog at all there is nothing to
    // keep, so fail hard instead of returning a soft error the caller ignores.
    if (hasReadableCatalog(cloud)) {
      errors[cloud] = errorMessage(error);
    } else {
      unusable.push(`${cloud}: ${errorMessage(error)}`);
    }
  }
  if (unusable.length > 0) {
    throw new Error(
      `Catalog download failed and no cached catalog is available for: ${unusable.join('; ')}`,
    );
  }
  return errors;
}
