#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const sourceRoot = join(root, 'src');

function listTypeScriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listTypeScriptFiles(path));
    else if (/\.tsx?$/.test(path)) files.push(path);
  }
  return files;
}

function normalize(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function imports(source) {
  const values = [];
  const pattern = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) values.push(match[1]);
  return values;
}

function isRepositoryOrGateway(specifier) {
  return /(?:^|\/)(?:repositories|gateways)(?:\/|$)/.test(specifier);
}

const violations = [];

const legacyClientFacade = join(sourceRoot, 'shared/services/api-client.ts');
if (existsSync(legacyClientFacade)) {
  violations.push({
    path: normalize(legacyClientFacade),
    specifier: 'legacy API client facade',
    rule: 'contract-derived client ownership',
  });
}

for (const file of listTypeScriptFiles(sourceRoot)) {
  const path = normalize(file);
  const source = readFileSync(file, 'utf8');
  const specifiers = imports(source);

  if (path.startsWith('src/shared/api-contract/')) {
    for (const specifier of specifiers) {
      if (
        ![
          'src/shared/api-contract/base.ts',
          'src/shared/api-contract/inspection.ts',
        ].includes(path) &&
        specifier === '@orpc/contract'
      ) {
        violations.push({
          path,
          specifier,
          rule: 'query/command endpoint builders',
        });
      }
      if (
        specifier === 'express' ||
        specifier.startsWith('@orpc/server') ||
        isRepositoryOrGateway(specifier) ||
        /(?:^|\/)api\/(?!api-contract)/.test(specifier)
      ) {
        violations.push({ path, specifier, rule: 'shared contract isolation' });
      }
      if (path.endsWith('-schemas.ts') && specifier.startsWith('@orpc/')) {
        violations.push({ path, specifier, rule: 'transport-free schemas' });
      }
    }
  }

  if (path.startsWith('src/api/rpc/')) {
    for (const specifier of specifiers) {
      if (isRepositoryOrGateway(specifier)) {
        violations.push({ path, specifier, rule: 'thin RPC procedures' });
      }
      if (/(?:^|\/)middleware(?:\/|$)/.test(specifier)) {
        violations.push({
          path,
          specifier,
          rule: 'transport-independent RPC procedures',
        });
      }
    }
    if (/\bgetDB\s*\(/.test(source)) {
      violations.push({
        path,
        specifier: 'getDB()',
        rule: 'thin RPC procedures',
      });
    }
  }

  if (/^src\/api\/services\/[^/]+-domain\.ts$/.test(path)) {
    for (const specifier of specifiers) {
      if (specifier === 'express' || specifier.startsWith('@orpc/')) {
        violations.push({ path, specifier, rule: 'transport-free domain' });
      }
    }
  }

  if (path.startsWith('src/shared/services/api-client/')) {
    for (const specifier of specifiers) {
      if (specifier === 'express' || specifier.startsWith('@orpc/server')) {
        violations.push({ path, specifier, rule: 'client/server separation' });
      }
      if (
        specifier === '../api-client.js' ||
        specifier.startsWith('../../cli/')
      ) {
        violations.push({
          path,
          specifier,
          rule: 'acyclic client infrastructure',
        });
      }
    }
  }

  for (const specifier of specifiers) {
    if (specifier.endsWith('/shared/services/api-client.js')) {
      violations.push({
        path,
        specifier,
        rule: 'contract-derived client ownership',
      });
    }
  }

  // A /v1/ path on Anycloud's API, whose origin the CLI only knows at run
  // time. A literal fixed to another host (a cloud's REST API) is not it,
  // nor GCP Resource Manager's overridable base (src/cli/seed/accounts.ts).
  const anycloudV1Fetch = [
    ...source.matchAll(/\bfetch\s*\(\s*(?:`([^`]*)`|['"]([^'"]*)['"])/gs),
  ].some(([, template, plain]) => {
    const url = template ?? plain;
    if (url.startsWith('${resourceManagerEndpoint()}/')) return false;
    const host = /^https?:\/\/([^/$`'"]+)\//.exec(url)?.[1];
    return (
      url.includes('/v1/') &&
      (host === undefined || /(^|\.)anycloud\.sh$/.test(host))
    );
  });
  if (path.startsWith('src/cli/') && anycloudV1Fetch) {
    violations.push({
      path,
      specifier: 'fetch(.../v1/...)',
      rule: 'typed JSON control-plane client',
    });
  }
}

if (violations.length > 0) {
  console.error('API contract boundary check failed.');
  console.error(
    'Schemas define structure, RPC procedures authenticate and delegate, and domain services own stateful semantics.',
  );
  for (const violation of violations) {
    console.error(
      `${violation.path}: ${violation.rule} forbids import/use ${violation.specifier}`,
    );
  }
  process.exit(1);
}
