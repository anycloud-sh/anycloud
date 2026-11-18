#!/usr/bin/env npx tsx
/**
 * Exercise every generated catalog through the same indexes and queries used at
 * runtime before publishing it.
 *
 * Usage:
 *   npx tsx scripts/validate-generated-catalog.ts \
 *     --catalog-root /tmp/catalogs \
 *     --previous-root /tmp/catalog
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { parse } from 'csv-parse/sync';
import {
  parseCatalogCSV,
  type CatalogIndexes,
} from '../src/shared/catalog/index.js';
import { getGpuOfferingsFromCatalog } from '../src/shared/catalog/queries.js';
import {
  gpuRuntimeForVMTypeFromCatalog,
  resolveVMTypeFromCatalog,
} from '../src/shared/cloud-config.js';
import { gcpGpuMachineCapability } from '../src/shared/gcp-machine-capabilities.js';
import { CATALOG_BACKED_CLOUDS } from '../src/shared/providers.js';
import { CloudType, GpuRuntime } from '../src/shared/cloud.js';

interface Args {
  catalogRoot: string;
  previousRoot?: string;
}

type CatalogRow = Record<string, string>;

export type GeneratedCatalogs = Partial<Readonly<Record<CloudType, string>>>;

export interface GeneratedCatalogValidationResult {
  cloud: CloudType;
  passed: boolean;
  message: string;
}

export interface GeneratedCatalogValidationOptions {
  clouds?: readonly CloudType[];
  previousCatalogs?: GeneratedCatalogs;
  previousClouds?: readonly CloudType[];
}

function parseArgs(args = process.argv.slice(2)): Args {
  let catalogRoot = '';
  let previousRoot: string | undefined;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--catalog-root' && args[index + 1]) {
      catalogRoot = args[++index];
    } else if (args[index] === '--previous-root' && args[index + 1]) {
      previousRoot = args[++index];
    }
  }

  if (!catalogRoot) {
    throw new Error(
      'Usage: validate-generated-catalog.ts --catalog-root <catalog-directory>',
    );
  }

  return { catalogRoot, previousRoot };
}

function parseRows(csv: string): CatalogRow[] {
  return parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as CatalogRow[];
}

function positiveNumber(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function summarize(failures: readonly string[], limit = 8): string {
  const displayed = failures.slice(0, limit).join('; ');
  return failures.length > limit
    ? `${displayed}; ... and ${failures.length - limit} more`
    : displayed;
}

function result(
  cloud: CloudType,
  label: string,
  failures: readonly string[],
): GeneratedCatalogValidationResult {
  return {
    cloud,
    passed: failures.length === 0,
    message: failures.length === 0 ? label : `${label}: ${summarize(failures)}`,
  };
}

function hasPositivePrice(
  indexes: CatalogIndexes,
  instanceType: string,
): boolean {
  const key = instanceType.toLowerCase();
  return [
    ...Object.values(indexes.pricePerTypeRegion[key] ?? {}),
    ...Object.values(indexes.spotPricePerTypeRegion[key] ?? {}),
  ].some((price) => Number.isFinite(price) && price > 0);
}

function validateRawGpuRows(
  cloud: CloudType,
  rows: readonly CatalogRow[],
): GeneratedCatalogValidationResult {
  const failures: string[] = [];
  const gpuRows = rows.filter((row) => row['AcceleratorName']?.trim());

  if (gpuRows.length === 0) failures.push('catalog has no GPU rows');

  gpuRows.forEach((row, index) => {
    const instanceType = row['InstanceType']?.trim() ?? '';
    const gpu = row['AcceleratorName']?.trim() ?? '';
    const rawCount = row['AcceleratorCount']?.trim() ?? '';
    const count = Number(rawCount);
    const label = `${gpu || 'unknown'}:${rawCount || 'unknown'}/${instanceType || 'unknown'} (GPU row ${index + 1})`;
    const location =
      cloud === CloudType.GCP
        ? row['AvailabilityZone']?.trim()
        : row['Region']?.trim();

    if (!instanceType) failures.push(`${label} is missing InstanceType`);
    if (!Number.isFinite(count) || count <= 0) {
      failures.push(`${label} has an invalid AcceleratorCount`);
    }
    if (!positiveNumber(row['vCPUs'])) {
      failures.push(`${label} has invalid vCPUs`);
    }
    if (!positiveNumber(row['MemoryGiB'])) {
      failures.push(`${label} has invalid MemoryGiB`);
    }
    if (!location) failures.push(`${label} has no runtime location`);
  });

  return result(
    cloud,
    `Raw GPU metadata is complete (${gpuRows.length} rows)`,
    failures,
  );
}

function validateIndexes(
  cloud: CloudType,
  indexes: CatalogIndexes,
): GeneratedCatalogValidationResult {
  const failures: string[] = [];
  const cpuTypes = new Set(indexes.cpuTypes.map((type) => type.toLowerCase()));
  let offeringCount = 0;

  for (const [gpu, entries] of Object.entries(indexes.typesPerAccelerator)) {
    if (!gpu.trim()) failures.push('accelerator index contains a blank name');

    for (const entry of entries) {
      offeringCount++;
      const key = entry.instanceType.toLowerCase();
      const label = `${gpu}:${entry.count}/${entry.instanceType}`;

      if (!entry.instanceType.trim()) {
        failures.push(`${label} has a blank instance type`);
      }
      if (!Number.isFinite(entry.count) || entry.count <= 0) {
        failures.push(`${label} has an invalid accelerator count`);
      }
      if (!Number.isFinite(entry.vCPUs) || entry.vCPUs <= 0) {
        failures.push(`${label} has invalid vCPUs`);
      }
      if (!Number.isFinite(entry.memoryGiB) || entry.memoryGiB <= 0) {
        failures.push(`${label} has invalid memory`);
      }
      if ((indexes.regionsPerType[key]?.length ?? 0) === 0) {
        failures.push(`${label} has no indexed location`);
      }
      if (!hasPositivePrice(indexes, entry.instanceType)) {
        failures.push(`${label} has no positive on-demand or spot price`);
      }
      if (cpuTypes.has(key)) {
        failures.push(`${label} leaked into the CPU index`);
      }
    }
  }

  if (offeringCount === 0) {
    failures.push('accelerator index has no offerings');
  }

  return result(
    cloud,
    `Runtime indexes contain ${offeringCount} priceable GPU machine offerings`,
    failures,
  );
}

function validateNestedVirtualization(
  cloud: CloudType,
  rows: readonly CatalogRow[],
  indexes: CatalogIndexes,
): GeneratedCatalogValidationResult {
  const failures: string[] = [];
  for (const row of rows) {
    const raw = row['NestedVirtualizationSupported'];
    if (!raw) continue; // Older catalogs and unavailable metadata are unknown.
    const region =
      cloud === CloudType.GCP ? row['AvailabilityZone'] : row['Region'];
    const type = row['InstanceType'];
    if (raw !== 'true' && raw !== 'false') {
      failures.push(
        `${type}/${region} has invalid NestedVirtualizationSupported`,
      );
    } else if (
      indexes.nestedVirtualizationPerTypeRegion[type.toLowerCase()]?.[
        region
      ] !==
      (raw === 'true')
    ) {
      failures.push(`${type}/${region} capability did not round-trip`);
    }
  }
  return result(
    cloud,
    'Nested virtualization capabilities round-trip with unknown values preserved',
    failures,
  );
}

function validateRuntimeQueries(
  cloud: CloudType,
  indexes: CatalogIndexes,
): GeneratedCatalogValidationResult {
  const failures: string[] = [];
  let pairCount = 0;

  for (const [gpu, entries] of Object.entries(indexes.typesPerAccelerator)) {
    const entriesByCount = new Map<number, typeof entries>();
    for (const entry of entries) {
      const matches = entriesByCount.get(entry.count) ?? [];
      matches.push(entry);
      entriesByCount.set(entry.count, matches);
    }

    const offerings = getGpuOfferingsFromCatalog(indexes, gpu);
    for (const [count, matchingEntries] of entriesByCount) {
      pairCount++;
      const matchingTypes = new Set(
        matchingEntries.map((entry) => entry.instanceType.toLowerCase()),
      );
      const listed = offerings.find((offering) => offering.count === count);

      if (!listed || !matchingTypes.has(listed.vmType.toLowerCase())) {
        failures.push(`${gpu}:${count} is missing from the GPU listing`);
      }

      // GPU aliases accept whole counts only. Fractional GPU slices on AWS and
      // Azure remain valid catalog offerings, but are selected by VM type.
      if (Number.isInteger(count)) {
        const alias = `${gpu}:${count}`;
        const resolved = resolveVMTypeFromCatalog(alias, indexes);
        if (!matchingTypes.has(resolved.toLowerCase())) {
          failures.push(
            `${alias} resolved outside its catalog entries (${resolved})`,
          );
        }
        if (count === 1) {
          const defaultCountResolved = resolveVMTypeFromCatalog(gpu, indexes);
          if (!matchingTypes.has(defaultCountResolved.toLowerCase())) {
            failures.push(
              `${gpu} resolved outside its count-1 catalog entries (${defaultCountResolved})`,
            );
          }
        }
      }
    }
  }

  return result(
    cloud,
    `GPU listing and alias resolution round-trip ${pairCount} accelerator/count pairs`,
    failures,
  );
}

function validateRuntimeClassification(
  cloud: CloudType,
  indexes: CatalogIndexes,
): GeneratedCatalogValidationResult {
  const failures: string[] = [];
  let classifiedCount = 0;

  for (const [gpu, entries] of Object.entries(indexes.typesPerAccelerator)) {
    for (const entry of entries) {
      const runtime = gpuRuntimeForVMTypeFromCatalog(
        cloud,
        entry.instanceType,
        indexes,
      );
      if (runtime === null) {
        failures.push(
          `${gpu}/${entry.instanceType} has no runtime classification`,
        );
      } else if (!Object.values(GpuRuntime).includes(runtime)) {
        failures.push(
          `${gpu}/${entry.instanceType} has an invalid runtime classification`,
        );
      } else {
        // Explicit `unsupported` is a valid fail-closed classification. It is
        // preferable to silently treating an unknown accelerator as CUDA.
        classifiedCount++;
      }
    }
  }

  return result(
    cloud,
    `${classifiedCount} GPU machine offerings have an explicit runtime classification`,
    failures,
  );
}

function validateGcpRuntimeContract(
  rows: readonly CatalogRow[],
  indexes: CatalogIndexes,
): GeneratedCatalogValidationResult[] {
  const capabilityFailures: string[] = [];
  const g4Failures: string[] = [];
  const g4Counts = new Set<number>();

  for (const [gpu, entries] of Object.entries(indexes.typesPerAccelerator)) {
    for (const entry of entries) {
      const capability = gcpGpuMachineCapability(entry.instanceType);
      if (!capability) {
        capabilityFailures.push(
          `${gpu}/${entry.instanceType} has no capability`,
        );
      } else if (!capability.launchQualified) {
        capabilityFailures.push(
          `${gpu}/${entry.instanceType} is not launch-qualified (${capability.reason})`,
        );
      }

      if (
        gpuRuntimeForVMTypeFromCatalog(
          CloudType.GCP,
          entry.instanceType,
          indexes,
        ) !== GpuRuntime.Cuda
      ) {
        capabilityFailures.push(
          `${gpu}/${entry.instanceType} is not CUDA-classified`,
        );
      }
    }
  }

  const g4OrRtxProRows = rows.filter(
    (row) =>
      row['InstanceType']?.trim().toLowerCase().startsWith('g4-') ||
      row['AcceleratorName']?.trim() === 'RTXPRO6000',
  );
  for (const row of g4OrRtxProRows) {
    const instanceType = row['InstanceType']?.trim().toLowerCase() ?? '';
    const count = Number(row['AcceleratorCount']);
    const vCPUs = Number(row['vCPUs']);
    const zone = row['AvailabilityZone']?.trim() ?? 'unknown-zone';
    const label = `${instanceType || 'unknown-type'}@${zone}`;

    if (
      row['AcceleratorName']?.trim() !== 'RTXPRO6000' ||
      ![1, 2, 4, 8].includes(count) ||
      instanceType !== `g4-standard-${48 * count}` ||
      vCPUs !== 48 * count
    ) {
      g4Failures.push(`${label} is not a whole-GPU RTXPRO6000 G4 shape`);
    } else {
      g4Counts.add(count);
    }
  }

  for (const count of [1, 2, 4, 8]) {
    if (!g4Counts.has(count)) {
      g4Failures.push(`RTXPRO6000:${count} has no valid G4 row`);
    }
  }

  return [
    result(
      CloudType.GCP,
      'Every GCP GPU machine is launch-qualified and CUDA-classified',
      capabilityFailures,
    ),
    result(
      CloudType.GCP,
      'G4 contains exactly the supported whole-GPU RTXPRO6000 shapes',
      g4Failures,
    ),
  ];
}

function gpuCountPairs(indexes: CatalogIndexes): Set<string> {
  const pairs = new Set<string>();
  for (const [gpu, entries] of Object.entries(indexes.typesPerAccelerator)) {
    for (const entry of entries) pairs.add(`${gpu}:${entry.count}`);
  }
  return pairs;
}

function validateGpuPairRegression(
  cloud: CloudType,
  current: CatalogIndexes,
  previousCsv: string,
): GeneratedCatalogValidationResult {
  try {
    const previous = parseCatalogCSV(previousCsv, cloud);
    const currentPairs = gpuCountPairs(current);
    const missing = [...gpuCountPairs(previous)]
      .filter((pair) => !currentPairs.has(pair))
      .sort();
    return result(
      cloud,
      'Previously published GPU/count pairs remain available',
      missing.map((pair) => `${pair} disappeared`),
    );
  } catch (error) {
    return {
      cloud,
      passed: false,
      message: `Previous catalog parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Validate in-memory artifacts without downloading, mutating process state, or
 * reading the user's catalog cache. The index-backed runtime functions share
 * implementation with their normal cloud wrappers.
 */
export function validateGeneratedCatalogs(
  catalogs: GeneratedCatalogs,
  options: GeneratedCatalogValidationOptions = {},
): GeneratedCatalogValidationResult[] {
  const clouds = options.clouds ?? CATALOG_BACKED_CLOUDS;
  const previousClouds = new Set(
    options.previousClouds ??
      (options.previousCatalogs ? clouds : ([] as readonly CloudType[])),
  );
  const results: GeneratedCatalogValidationResult[] = [];
  const parsed = new Map<
    CloudType,
    { rows: CatalogRow[]; indexes: CatalogIndexes }
  >();

  for (const cloud of clouds) {
    const csv = catalogs[cloud];
    if (csv === undefined) {
      results.push({
        cloud,
        passed: false,
        message: 'Catalog artifact is missing',
      });
      continue;
    }

    try {
      const rows = parseRows(csv);
      const indexes = parseCatalogCSV(csv, cloud);
      parsed.set(cloud, { rows, indexes });
      results.push({
        cloud,
        passed: true,
        message: `Catalog parses through the runtime (${rows.length} rows)`,
      });
    } catch (error) {
      results.push({
        cloud,
        passed: false,
        message: `Catalog parse failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const cloud of clouds) {
    const catalog = parsed.get(cloud);
    if (!catalog) continue;

    results.push(validateRawGpuRows(cloud, catalog.rows));
    results.push(validateIndexes(cloud, catalog.indexes));
    results.push(
      validateNestedVirtualization(cloud, catalog.rows, catalog.indexes),
    );
    results.push(validateRuntimeQueries(cloud, catalog.indexes));
    results.push(validateRuntimeClassification(cloud, catalog.indexes));

    if (previousClouds.has(cloud)) {
      const previousCsv = options.previousCatalogs?.[cloud];
      results.push(
        previousCsv === undefined
          ? {
              cloud,
              passed: false,
              message: 'Previous catalog artifact is missing',
            }
          : validateGpuPairRegression(cloud, catalog.indexes, previousCsv),
      );
    }

    if (cloud === CloudType.GCP) {
      results.push(
        ...validateGcpRuntimeContract(catalog.rows, catalog.indexes),
      );
    }
  }

  return results;
}

export function loadGeneratedCatalogs(
  catalogRoot: string,
  label = 'Catalog',
): {
  catalogs: GeneratedCatalogs;
  failures: GeneratedCatalogValidationResult[];
} {
  const catalogs: Partial<Record<CloudType, string>> = {};
  const failures: GeneratedCatalogValidationResult[] = [];

  for (const cloud of CATALOG_BACKED_CLOUDS) {
    const path = join(catalogRoot, cloud.toLowerCase(), 'vms.csv');
    if (!existsSync(path)) {
      failures.push({
        cloud,
        passed: false,
        message: `${label} artifact does not exist: ${path}`,
      });
      continue;
    }
    try {
      catalogs[cloud] = readFileSync(path, 'utf8');
    } catch (error) {
      failures.push({
        cloud,
        passed: false,
        message: `${label} artifact could not be read (${path}): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { catalogs, failures };
}

export function main(): void {
  const { catalogRoot, previousRoot } = parseArgs();
  const loaded = loadGeneratedCatalogs(catalogRoot);
  const failedLoads = new Set(
    loaded.failures.map((validation) => validation.cloud),
  );
  const previous = previousRoot
    ? loadGeneratedCatalogs(previousRoot, 'Previous catalog')
    : undefined;
  const failedPreviousLoads = new Set(
    previous?.failures.map((validation) => validation.cloud) ?? [],
  );
  const results = [
    ...loaded.failures,
    ...(previous?.failures ?? []),
    ...validateGeneratedCatalogs(loaded.catalogs, {
      clouds: CATALOG_BACKED_CLOUDS.filter((cloud) => !failedLoads.has(cloud)),
      previousCatalogs: previous?.catalogs,
      previousClouds: previous
        ? CATALOG_BACKED_CLOUDS.filter(
            (cloud) => !failedPreviousLoads.has(cloud),
          )
        : [],
    }),
  ];

  console.log(`Validating generated catalogs under ${catalogRoot}\n`);
  for (const validation of results) {
    const icon = validation.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] [${validation.cloud}] ${validation.message}`);
  }

  const failures = results.filter((validation) => !validation.passed);
  console.log();
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} generated catalog validation(s) failed. Catalogs will not be published.`,
    );
  }
  console.log('All generated catalog validations passed.');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
