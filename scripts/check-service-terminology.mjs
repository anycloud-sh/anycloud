#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkedExtensions = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
]);

const legacyPatterns = [
  {
    label: 'legacy Service discriminator',
    pattern: /(['"`])servers?\1/,
  },
  {
    label: 'removed WorkloadType.Server alias',
    pattern: /\bWorkloadType\.Server\b/,
  },
  {
    label: 'legacy totalServers aggregate',
    pattern: /\btotalServers\b/,
  },
  {
    label: 'legacy servers aggregate property',
    pattern: /(?:\.\s*servers\b|\bservers\s*:)/,
  },
];

const scanTargets = [
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'benchmarks',
  'docs',
  'migrations',
  'src',
  'test',
];

// The OpenAPI document is generated from the contract, whose source is checked.
const ignoredPaths = new Set([
  'docs/changelog.md',
  'src/shared/api-contract/openapi.generated.json',
]);

// This reviewed JSON trace uses server for TCP socket identity. Preserve its
// measured bytes instead of adding comments; edited copies get normal checks.
const archivedReportHashes = new Map([
  [
    'benchmarks/list-responsiveness/native-diagnosis-summary.json',
    '6d02c268b760af76017d72783a32f01555665e1327d53fb28e10d604107484a2',
  ],
]);

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

function listFiles(root, target) {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];
  const files = [];
  for (const entry of readdirSync(target)) {
    const path = join(target, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(root, path));
    else if (checkedExtensions.has(extname(path))) files.push(path);
  }
  return files;
}

function hasTechnicalException(lines, index) {
  const start = Math.max(0, index - 6);
  return lines
    .slice(start, index + 1)
    .some((line) => /service-terminology-ok:\s*\S/.test(line));
}

export function validateServiceTerminology(files) {
  const violations = [];
  for (const file of files) {
    const archivedHash = archivedReportHashes.get(normalizePath(file.path));
    if (
      archivedHash &&
      createHash('sha256').update(file.content).digest('hex') === archivedHash
    )
      continue;
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = legacyPatterns.find(({ pattern }) => pattern.test(line));
      if (!match || hasTechnicalException(lines, index)) return;
      violations.push({
        path: normalizePath(file.path),
        line: index + 1,
        label: match.label,
        text: line.trim(),
      });
    });
  }
  return violations;
}

function inspectRepository(root) {
  const paths = scanTargets.flatMap((target) =>
    listFiles(root, join(root, target)),
  );
  return validateServiceTerminology(
    paths
      .map((path) => ({
        path: normalizePath(relative(root, path)),
        content: readFileSync(path, 'utf8'),
      }))
      .filter(({ path }) => !ignoredPaths.has(path)),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = inspectRepository(root);
  if (violations.length > 0) {
    console.error('Canonical Service terminology check failed.');
    console.error(
      'Use service/services/totalServices for the workload primitive and its aggregates.',
    );
    console.error(
      'A genuinely technical occurrence requires a nearby `service-terminology-ok: reason` comment.',
    );
    for (const violation of violations) {
      console.error(
        `${violation.path}:${violation.line} [${violation.label}] ${violation.text}`,
      );
    }
    process.exit(1);
  }
}
