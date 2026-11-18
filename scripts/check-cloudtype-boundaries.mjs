#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const sourceRoot = join(root, 'src');

const allowedPaths = [
  /^src\/api\/services\/cloud-config\.ts$/,
  /^src\/api\/services\/credentials-domain\.ts$/,
  /^src\/api\/services\/cost-calculation\//,
  /^src\/api\/services\/gateways\//,
  /^src\/api\/services\/quota\//,
  /^src\/api\/services\/rclone-config\.ts$/,
  /^src\/api\/services\/role-connection-check\.ts$/,
  /^src\/cli\/commands\/credentials\//,
  /^src\/cli\/services\/credential-onboarding\//,
  // The seeds (RFC 0049 C26 (e)): one module per cloud's own CLI.
  /^src\/cli\/seed\/(aws|azure|gcp)\.ts$/,
  /^src\/cli\/services\/config\.ts$/,
  /^src\/cli\/services\/non-interactive\.ts$/,
  /^src\/cli\/utils\/providers\.ts$/,
  /^src\/shared\/catalog\//,
  /^src\/shared\/cloud\.ts$/,
  /^src\/shared\/cloud-config\.ts$/,
  /^src\/shared\/api-contract\/credentials-schemas\.ts$/,
  /^src\/shared\/api-contract\/workload-admission-schemas\.ts$/,
  /^src\/shared\/error-formatter\.ts$/,
  /^src\/shared\/providers\.ts$/,
  /^src\/shared\/quota-groups\.ts$/,
  /^src\/shared\/quota-resolvers\//,
];

// `CloudType.X` catches every dotted enum branch (including `cloudProvider === CloudType.X`
// comparisons); `Record<CloudType` catches the dotless mapped-type form the first
// alternative would otherwise miss.
const providerBoundaryPattern =
  /\b(?:CloudType\.[A-Za-z0-9_]+|Record\s*<\s*CloudType)/;

function listSourceFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (/\.(?:ts|tsx|js|mjs)$/.test(path)) {
      files.push(path);
    }
  }
  return files;
}

function normalizePath(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function isAllowedPath(path) {
  return allowedPaths.some((pattern) => pattern.test(path));
}

// An exception comment suppresses the flagged line if it sits ON that line or up
// to 16 lines ABOVE it (backward only) — enough to cover a comment block sitting
// above a switch/if while staying tight enough that an unrelated escape far below
// can't accidentally whitelist later code.
function hasInlineBoundaryException(lines, index) {
  const start = Math.max(0, index - 16);
  for (let i = start; i <= index; i += 1) {
    if (lines[i]?.includes('cloudtype-boundary-ok:')) return true;
  }
  return false;
}

const violations = [];

for (const file of listSourceFiles(sourceRoot)) {
  const rel = normalizePath(file);
  if (isAllowedPath(rel)) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!providerBoundaryPattern.test(line)) return;
    if (hasInlineBoundaryException(lines, index)) return;
    violations.push({
      path: rel,
      line: index + 1,
      text: line.trim(),
    });
  });
}

if (violations.length > 0) {
  console.error('CloudType boundary check failed.');
  console.error(
    'Product behavior should use provider metadata or branded capabilities, not provider-name branches.',
  );
  console.error(
    'Allowed cases belong in provider registries, gateways, credentials, catalogs, quota/cost adapters, or need a `// cloudtype-boundary-ok: reason` comment on the line or up to 16 lines above it.',
  );
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line} ${violation.text}`);
  }
  process.exit(1);
}
