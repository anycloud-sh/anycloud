#!/usr/bin/env npx tsx
/**
 * Validate a generated catalog before publishing.
 *
 * Usage:
 *   npx tsx scripts/validate-catalog.ts \
 *     --input /tmp/catalogs/azure/vms.csv \
 *     --cloud azure \
 *     --usage-families /tmp/catalogs/azure/usage-families-v2.json
 *   npx tsx scripts/validate-catalog.ts \
 *     --input /tmp/catalogs/gcp/vms.csv \
 *     --cloud gcp
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { parse } from 'csv-parse/sync';
import { parseCatalogCSV } from '../src/shared/catalog/index.js';
import {
  canonicalAzureQuotaResourceKey,
  createAzureQuotaIdentity,
  type AzureQuotaResourceKey,
} from '../src/shared/quota-resolvers/azure-identity.js';
import { CloudType } from '../src/shared/cloud.js';

interface Args {
  input: string;
  cloud: string;
  usageFamilies?: string;
}

export interface ValidationResult {
  passed: boolean;
  message: string;
}

type CatalogRow = Record<string, string>;

function parseArgs(args = process.argv.slice(2)): Args {
  let input = '';
  let cloud = '';
  let usageFamilies: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i];
    } else if (args[i] === '--cloud' && args[i + 1]) {
      cloud = args[++i];
    } else if (args[i] === '--usage-families' && args[i + 1]) {
      usageFamilies = args[++i];
    }
  }

  if (!input || !cloud || (cloud === 'azure' && !usageFamilies)) {
    throw new Error(
      'Usage: validate-catalog.ts --input <csv-path> --cloud <azure|gcp> ' +
        '[--usage-families <json-path>]',
    );
  }

  return { input, cloud, usageFamilies };
}

function parseRows(csv: string): CatalogRow[] {
  return parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as CatalogRow[];
}

function summarize(values: Iterable<string>, limit = 10): string {
  const sorted = [...values].sort();
  if (sorted.length === 0) return 'none';
  const displayed = sorted.slice(0, limit).join(', ');
  return sorted.length > limit ? `${displayed}, ...` : displayed;
}

function catalogFamilyKey(value: string): AzureQuotaResourceKey {
  return (
    canonicalAzureQuotaResourceKey(value) ??
    createAzureQuotaIdentity(value).resourceKey
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REQUIRED_GCP_GPU_COUNTS: Readonly<Record<string, readonly number[]>> = {
  A100: [1, 2, 4, 8, 16],
  'A100-80GB': [1, 2, 4, 8],
  H100: [1, 2, 4, 8],
  'H100-MEGA': [8],
  H200: [8],
  B200: [8],
  L4: [1, 2, 4, 8],
  RTXPRO6000: [1, 2, 4, 8],
};

function gpuPair(row: CatalogRow): string | null {
  const name = row['AcceleratorName']?.trim();
  const count = Number(row['AcceleratorCount']);
  return name && Number.isInteger(count) && count > 0
    ? `${name}:${count}`
    : null;
}

/** GCP-specific completeness checks. */
export function validateGcpCatalog(rows: CatalogRow[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const currentPairs = new Set(
    rows.map(gpuPair).filter((pair): pair is string => pair !== null),
  );

  for (const [name, counts] of Object.entries(REQUIRED_GCP_GPU_COUNTS)) {
    const missing = counts.filter(
      (count) => !currentPairs.has(`${name}:${count}`),
    );
    results.push({
      passed: missing.length === 0,
      message:
        `GCP GPU baseline ${name} counts present: ` +
        (missing.length === 0
          ? counts.join('/')
          : `missing ${missing.join('/')}`),
    });
  }

  const invalidGpuRows = new Set<string>();
  const gpuInstanceTypes = new Set<string>();
  for (const row of rows) {
    const name = row['AcceleratorName']?.trim();
    if (!name) continue;
    const instanceType = row['InstanceType']?.trim();
    const count = Number(row['AcceleratorCount']);
    const vCpus = Number.parseFloat(row['vCPUs']);
    const memoryGiB = Number.parseFloat(row['MemoryGiB']);
    const price = Number.parseFloat(row['Price']);
    const spotPrice = Number.parseFloat(row['SpotPrice']);
    if (instanceType) gpuInstanceTypes.add(instanceType.toLowerCase());
    if (
      !instanceType ||
      !row['Region']?.trim() ||
      !row['AvailabilityZone']?.trim() ||
      !Number.isInteger(count) ||
      count <= 0 ||
      !Number.isFinite(vCpus) ||
      vCpus <= 0 ||
      !Number.isFinite(memoryGiB) ||
      memoryGiB <= 0 ||
      !(
        (Number.isFinite(price) && price > 0) ||
        (Number.isFinite(spotPrice) && spotPrice > 0)
      )
    ) {
      invalidGpuRows.add(
        `${row['AvailabilityZone'] || 'unknown zone'}/${instanceType || 'unknown type'}`,
      );
    }
  }
  results.push({
    passed: invalidGpuRows.size === 0,
    message:
      `GCP GPU rows have complete metadata and pricing: ${invalidGpuRows.size === 0}` +
      (invalidGpuRows.size ? ` (invalid: ${summarize(invalidGpuRows)})` : ''),
  });

  const cpuGpuLeaks = new Set(
    rows
      .filter(
        (row) =>
          !row['AcceleratorName']?.trim() &&
          gpuInstanceTypes.has(row['InstanceType']?.trim().toLowerCase()),
      )
      .map((row) => row['InstanceType']),
  );
  results.push({
    passed: cpuGpuLeaks.size === 0,
    message:
      `GCP GPU machine types absent from CPU rows: ${cpuGpuLeaks.size === 0}` +
      (cpuGpuLeaks.size ? ` (leaked: ${summarize(cpuGpuLeaks)})` : ''),
  });

  const invalidG4Rows = new Set<string>();
  for (const row of rows) {
    if (!row['InstanceType']?.toLowerCase().startsWith('g4-')) continue;
    const count = Number(row['AcceleratorCount']);
    const vCpus = Number.parseFloat(row['vCPUs']);
    if (
      row['AcceleratorName'] !== 'RTXPRO6000' ||
      !Number.isInteger(count) ||
      vCpus !== 48 * count
    ) {
      invalidG4Rows.add(row['InstanceType']);
    }
  }
  results.push({
    passed: invalidG4Rows.size === 0,
    message:
      `GCP G4 rows are whole RTXPRO6000 machines: ${invalidG4Rows.size === 0}` +
      (invalidG4Rows.size ? ` (invalid: ${summarize(invalidG4Rows)})` : ''),
  });

  return results;
}

/**
 * Cross-check Resource-SKU-derived catalog families against the independent
 * per-region Compute Usage API artifact produced in the same workflow run.
 */
export function validateAzureUsageFamilies(
  rows: CatalogRow[],
  rawArtifact: unknown,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const familyKeysBySku = new Map<string, Set<AzureQuotaResourceKey>>();
  const regionsBySku = new Map<string, Set<string>>();
  const displayNameBySku = new Map<string, string>();
  const catalogRegions = new Set<string>();
  const missingFamilySkus = new Set<string>();

  for (const row of rows) {
    const instanceType = row['InstanceType']?.trim();
    const region = row['Region']?.trim();
    if (!instanceType) continue;

    const skuKey = instanceType.toLowerCase();
    displayNameBySku.set(skuKey, instanceType);
    if (region) {
      catalogRegions.add(region);
      const regions = regionsBySku.get(skuKey) ?? new Set<string>();
      regions.add(region);
      regionsBySku.set(skuKey, regions);
    }

    const family = (row['QuotaGroup'] || row['QuotaFamily'])?.trim();
    if (!family) {
      missingFamilySkus.add(instanceType);
      continue;
    }
    const families = familyKeysBySku.get(skuKey) ?? new Set();
    families.add(catalogFamilyKey(family));
    familyKeysBySku.set(skuKey, families);
  }

  results.push({
    passed: missingFamilySkus.size === 0,
    message:
      `Azure SKUs with a quota family: ${displayNameBySku.size - missingFamilySkus.size}/` +
      `${displayNameBySku.size}` +
      (missingFamilySkus.size
        ? ` (missing: ${summarize(missingFamilySkus)})`
        : ''),
  });

  const ambiguousSkus = new Set<string>();
  for (const [skuKey, keys] of familyKeysBySku) {
    if (keys.size > 1) {
      ambiguousSkus.add(
        `${displayNameBySku.get(skuKey) ?? skuKey} => ${[...keys].sort().join(' | ')}`,
      );
    }
  }
  results.push({
    passed: ambiguousSkus.size === 0,
    message:
      `Case-insensitive SKU family mappings unambiguous: ` +
      `${familyKeysBySku.size - ambiguousSkus.size}/${familyKeysBySku.size}` +
      (ambiguousSkus.size ? ` (conflicts: ${summarize(ambiguousSkus)})` : ''),
  });

  if (!isRecord(rawArtifact)) {
    results.push({
      passed: false,
      message: 'Usage-family artifact is a non-array JSON object: false',
    });
    return results;
  }

  const regionsByFamilyKey = new Map<AzureQuotaResourceKey, Set<string>>();
  const invalidEntries = new Set<string>();
  const hasVersionedWrapper =
    'version' in rawArtifact || 'families' in rawArtifact;
  const isV2 =
    rawArtifact.version === 2 &&
    isRecord(rawArtifact.families) &&
    Object.keys(rawArtifact).every(
      (key) => key === 'version' || key === 'families',
    );
  const format = isV2 ? 'v2' : 'v1';
  let artifactEntries: Record<string, unknown>;
  if (hasVersionedWrapper && !isV2) {
    invalidEntries.add('artifact wrapper (expected version: 2 and families)');
    artifactEntries = {};
  } else {
    artifactEntries = isV2
      ? (rawArtifact.families as Record<string, unknown>)
      : rawArtifact;
  }

  for (const [rawKey, rawEntry] of Object.entries(artifactEntries)) {
    let canonicalKey: AzureQuotaResourceKey | null;
    let rawNames: string[];
    if (isV2) {
      canonicalKey = canonicalAzureQuotaResourceKey(rawKey);
      if (canonicalKey === null || canonicalKey !== rawKey) {
        invalidEntries.add(`${rawKey} (noncanonical v2 key)`);
        continue;
      }
      if (
        !isRecord(rawEntry) ||
        !Array.isArray(rawEntry.rawNames) ||
        !rawEntry.rawNames.every(
          (rawName): rawName is string =>
            typeof rawName === 'string' && rawName.trim().length > 0,
        ) ||
        typeof rawEntry.regions !== 'string' ||
        Object.keys(rawEntry).some(
          (key) => key !== 'rawNames' && key !== 'regions',
        )
      ) {
        invalidEntries.add(
          `${rawKey} (expected only rawNames[] and a regions string)`,
        );
        continue;
      }
      rawNames = rawEntry.rawNames;
      const sortedRawNames = [...new Set(rawNames)].sort();
      if (
        sortedRawNames.length === 0 ||
        sortedRawNames.length !== rawNames.length ||
        sortedRawNames.some((rawName, index) => rawName !== rawNames[index])
      ) {
        invalidEntries.add(`${rawKey} (rawNames must be nonempty and sorted)`);
        continue;
      }
    } else {
      canonicalKey = canonicalAzureQuotaResourceKey(`azure:${rawKey}`);
      if (
        canonicalKey === null ||
        canonicalKey.slice('azure:'.length) !== rawKey
      ) {
        invalidEntries.add(`${rawKey} (noncanonical legacy key)`);
        continue;
      }
      if (
        !isRecord(rawEntry) ||
        typeof rawEntry.raw !== 'string' ||
        !rawEntry.raw.trim() ||
        typeof rawEntry.regions !== 'string' ||
        Object.keys(rawEntry).some((key) => key !== 'raw' && key !== 'regions')
      ) {
        invalidEntries.add(
          `${rawKey} (expected only a raw name and regions string)`,
        );
        continue;
      }
      rawNames = [rawEntry.raw];
    }

    if (
      rawNames.some(
        (rawName) =>
          createAzureQuotaIdentity(rawName).resourceKey !== canonicalKey,
      )
    ) {
      invalidEntries.add(`${rawKey} (raw name does not derive to key)`);
      continue;
    }

    const rawRegions = rawEntry.regions
      .split(',')
      .map((region) => region.trim())
      .filter(Boolean);
    const normalizedRegions = [...new Set(rawRegions)].sort();
    if (
      normalizedRegions.length === 0 ||
      normalizedRegions.join(',') !== rawEntry.regions
    ) {
      invalidEntries.add(
        `${rawKey} (regions must be nonempty, unique, sorted)`,
      );
      continue;
    }
    regionsByFamilyKey.set(canonicalKey, new Set(normalizedRegions));
  }

  results.push({
    passed: invalidEntries.size === 0 && regionsByFamilyKey.size > 0,
    message:
      `Usage-family artifact ${format} entries canonical and valid: ${regionsByFamilyKey.size}` +
      (invalidEntries.size ? ` (invalid: ${summarize(invalidEntries)})` : ''),
  });

  const catalogFamilyKeys = new Set<AzureQuotaResourceKey>();
  for (const keys of familyKeysBySku.values()) {
    for (const key of keys) catalogFamilyKeys.add(key);
  }

  const unexpectedArtifactKeys = new Set(
    [...regionsByFamilyKey.keys()].filter((key) => !catalogFamilyKeys.has(key)),
  );
  results.push({
    passed: unexpectedArtifactKeys.size === 0,
    message:
      `Usage-family artifact has no unexpected keys: ${unexpectedArtifactKeys.size === 0}` +
      (unexpectedArtifactKeys.size
        ? ` (${summarize(unexpectedArtifactKeys)})`
        : ''),
  });

  const missingArtifactKeys = new Set(
    [...catalogFamilyKeys].filter((key) => !regionsByFamilyKey.has(key)),
  );
  results.push({
    passed: missingArtifactKeys.size === 0,
    message:
      `Catalog families observed by Usage API: ` +
      `${catalogFamilyKeys.size - missingArtifactKeys.size}/${catalogFamilyKeys.size}` +
      (missingArtifactKeys.size
        ? ` (missing: ${summarize(missingArtifactKeys)})`
        : ''),
  });

  const uncoveredSkus = new Set<string>();
  for (const [skuKey, offeredRegions] of regionsBySku) {
    const familyKeys = familyKeysBySku.get(skuKey);
    if (!familyKeys || familyKeys.size !== 1) {
      uncoveredSkus.add(displayNameBySku.get(skuKey) ?? skuKey);
      continue;
    }
    const familyKey = [...familyKeys][0];
    const observedRegions = regionsByFamilyKey.get(familyKey);
    if (
      !observedRegions ||
      ![...offeredRegions].some((region) => observedRegions.has(region))
    ) {
      uncoveredSkus.add(displayNameBySku.get(skuKey) ?? skuKey);
    }
  }
  results.push({
    passed: uncoveredSkus.size === 0,
    message:
      `Catalog SKUs observed in an offered region: ` +
      `${regionsBySku.size - uncoveredSkus.size}/${regionsBySku.size}` +
      (uncoveredSkus.size ? ` (missing: ${summarize(uncoveredSkus)})` : ''),
  });

  const capturedCatalogRegions = new Set<string>();
  for (const regions of regionsByFamilyKey.values()) {
    for (const region of regions) {
      if (catalogRegions.has(region)) capturedCatalogRegions.add(region);
    }
  }
  const regionCoverage =
    catalogRegions.size === 0
      ? 0
      : capturedCatalogRegions.size / catalogRegions.size;
  results.push({
    passed: regionCoverage >= 0.9,
    message:
      `Usage API catalog-region coverage: ${capturedCatalogRegions.size}/` +
      `${catalogRegions.size} (${(regionCoverage * 100).toFixed(1)}%, minimum: 90%)`,
  });

  return results;
}

export function validateCatalog(
  csv: string,
  cloud: string,
  usageFamilies?: unknown,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  let rows: CatalogRow[];
  try {
    rows = parseRows(csv);
  } catch (err) {
    return [
      {
        passed: false,
        message: `CSV parse failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const minRows = 10_000;
  results.push({
    passed: rows.length >= minRows,
    message: `Row count: ${rows.length} (minimum: ${minRows})`,
  });

  const regions = new Set(rows.map((row) => row['Region']).filter(Boolean));
  const minRegions = 30;
  results.push({
    passed: regions.size >= minRegions,
    message: `Regions: ${regions.size} (minimum: ${minRegions})`,
  });

  if (cloud === 'azure') {
    for (const region of ['australiacentral2']) {
      results.push({
        passed: !regions.has(region),
        message: `Restricted region "${region}" absent: ${!regions.has(region)}`,
      });
    }
  }

  const requiredGPUs =
    cloud === 'gcp'
      ? ['H100', 'A100', 'RTXPRO6000']
      : ['H100', 'A100', 'T4', 'V100'];
  const gpuNames = new Set(
    rows.map((row) => row['AcceleratorName']).filter(Boolean),
  );
  for (const gpu of requiredGPUs) {
    results.push({
      passed: gpuNames.has(gpu),
      message: `GPU family "${gpu}" present: ${gpuNames.has(gpu)}`,
    });
  }

  for (const gpu of ['H100', 'A100']) {
    const gpuRows = rows.filter((row) => row['AcceleratorName'] === gpu);
    const withPrice = gpuRows.filter(
      (row) => row['Price'] && parseFloat(row['Price']) > 0,
    );
    results.push({
      passed: withPrice.length > 0,
      message: `${gpu} with non-zero price: ${withPrice.length}/${gpuRows.length}`,
    });
  }

  const withVCPUs = rows.filter((row) => row['vCPUs']).length;
  const vcpuPercent = rows.length === 0 ? 0 : (withVCPUs / rows.length) * 100;
  results.push({
    passed: vcpuPercent > 95,
    message: `vCPUs populated: ${vcpuPercent.toFixed(1)}% (minimum: 95%)`,
  });

  const withMemory = rows.filter((row) => row['MemoryGiB']).length;
  const memoryPercent =
    rows.length === 0 ? 0 : (withMemory / rows.length) * 100;
  results.push({
    passed: memoryPercent > 95,
    message: `MemoryGiB populated: ${memoryPercent.toFixed(1)}% (minimum: 95%)`,
  });

  try {
    const cloudType =
      cloud === 'azure'
        ? CloudType.Azure
        : cloud === 'aws'
          ? CloudType.AWS
          : cloud === 'gcp'
            ? CloudType.GCP
            : CloudType.Lambda;
    const indexes = parseCatalogCSV(csv, cloudType);
    const typeCount = Object.keys(indexes.regionsPerType).length;
    results.push({
      passed: typeCount > 0,
      message: `Round-trip parse: ${typeCount} instance types indexed`,
    });
  } catch (err) {
    results.push({
      passed: false,
      message: `Round-trip parse failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (cloud === 'azure') {
    results.push(...validateAzureUsageFamilies(rows, usageFamilies));
  }
  if (cloud === 'gcp') {
    results.push(...validateGcpCatalog(rows));
  }

  return results;
}

export function main(): void {
  const { input, cloud, usageFamilies } = parseArgs();
  const csv = readFileSync(input, 'utf-8');
  const usageArtifact = usageFamilies
    ? JSON.parse(readFileSync(usageFamilies, 'utf-8'))
    : undefined;

  console.log(`Validating ${cloud} catalog: ${input}\n`);
  const results = validateCatalog(csv, cloud, usageArtifact);
  let allPassed = true;

  for (const result of results) {
    const icon = result.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${result.message}`);
    if (!result.passed) allPassed = false;
  }

  console.log();
  if (!allPassed) {
    throw new Error('Validation failed. Catalog will not be published.');
  }
  console.log('All validations passed.');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
