// Emits the committed OpenAPI document from the API contract, so reviewers see
// the wire in the diff and `yarn pr:sections` can compare it with the merge
// base. Run through tsx (`yarn generate:openapi`); `--check` regenerates and
// fails on drift.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateApiOpenApiDocument } from '../src/shared/api-contract/openapi.js';

export const OPENAPI_PATH = 'src/shared/api-contract/openapi.generated.json';

/** JSON with sorted keys at every level, so equal documents serialize equally. */
export function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalJson(entry) ?? 'null')
      .join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      // A fixed collation keeps the output the same in every locale.
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .flatMap(([key, entry]) => {
        const serialized = canonicalJson(entry);
        return serialized === undefined
          ? []
          : [`${JSON.stringify(key)}:${serialized}`];
      })
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? undefined;
}

/**
 * The document as committed. The version is fixed so a release bump does not
 * rewrite the file; the Python SDK stamps the package version itself.
 */
export async function renderOpenApi(): Promise<string> {
  const document = await generateApiOpenApiDocument({ version: 'unversioned' });
  return `${JSON.stringify(JSON.parse(canonicalJson(document)!), null, 2)}\n`;
}

async function main(): Promise<void> {
  const path = join(
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    OPENAPI_PATH,
  );
  const rendered = await renderOpenApi();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // A missing file is drift too.
    }
    if (current !== rendered) {
      console.error(
        `${OPENAPI_PATH} does not match the API contract; run \`yarn generate:openapi\`.`,
      );
      process.exit(1);
    }
    console.log('OpenAPI document matches the API contract.');
    return;
  }
  writeFileSync(path, rendered);
  console.log(`Wrote ${OPENAPI_PATH}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
