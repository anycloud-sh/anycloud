#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const testRoot = join(root, 'test');

// These specs test parsing, provider-response normalization, cache I/O, and
// catalog serialization themselves. Raw input samples are appropriate there;
// they must not be injected into optimizer or other runtime-behavior specs.
const catalogMechanicsSpecs = [
  /^test\/unit\/shared\/catalog\.spec\.ts$/,
  /^test\/unit\/shared\/catalog\/(?!queries\.spec\.ts$).+\.spec\.ts$/,
  /^test\/unit\/scripts\/catalog-aws\.spec\.ts$/,
];

const placementSpecs = new Set([
  'test/unit/services/azure-t4-unpinned-regression.spec.ts',
  'test/unit/services/gpu-resolution.spec.ts',
  'test/unit/services/monitor.spec.ts',
  'test/unit/services/optimizer.spec.ts',
  'test/unit/services/region-failover.spec.ts',
  'test/unit/services/gateways/gcp.spec.ts',
  'test/unit/shared/gcp-catalog-contract.spec.ts',
]);

const syntheticCatalogPatterns = [
  { pattern: /\bparseCatalogCSV\s*\(/, label: 'parseCatalogCSV' },
  { pattern: /\bentriesToCSV\s*\(/, label: 'entriesToCSV' },
  { pattern: /\bwriteCatalog\s*\(/, label: 'writeCatalog' },
  {
    pattern:
      /(?:spyOn\([^\n]*['"]readCatalog['"]|readCatalog(?:Mock)?[^\n]*(?:mockReturnValue|mockImplementation))/,
    label: 'mocked readCatalog',
  },
];

const syntheticPlacementPatterns = [
  {
    pattern:
      /(?:getRegionsForVMType|getZoneSuffixes|getZonesForVMType)[^\n]*(?:mockReturnValue|mockImplementation|:\s*vi\.)/,
    label: 'mocked catalog placement query',
  },
];

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(path)) files.push(path);
  }
  return files;
}

function normalize(path) {
  return relative(root, path).replaceAll('\\', '/');
}

const violations = [];
for (const file of listFiles(testRoot)) {
  const path = normalize(file);
  const source = readFileSync(file, 'utf8');
  const patterns = catalogMechanicsSpecs.some((allowed) => allowed.test(path))
    ? []
    : [...syntheticCatalogPatterns];
  if (placementSpecs.has(path)) patterns.push(...syntheticPlacementPatterns);

  for (const { pattern, label } of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    if (
      label === 'mocked readCatalog' &&
      source
        .slice(match.index, match.index + 200)
        .includes('mockReturnValue(undefined)')
    ) {
      continue;
    }
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    violations.push({ path, line, label });
  }
}

if (violations.length > 0) {
  console.error('Catalog test boundary check failed.');
  console.error(
    'Runtime and placement behavior must consume the published catalogs loaded by test/global-setup.ts. Keep raw samples confined to catalog parser/fetcher/I/O mechanics specs.',
  );
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line} ${violation.label}`);
  }
  process.exit(1);
}
