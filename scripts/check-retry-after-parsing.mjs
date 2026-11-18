#!/usr/bin/env node

// `Retry-After` is parsed once, in src/shared/retry-after.ts, so every caller
// reads delay-seconds, HTTP-dates and Azure's millisecond headers alike.
// A quoted header name elsewhere is a private parser unless listed
// here with the reason it is not one.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitVisibleFiles } from './repository-policy/git-files.mjs';

// A template literal names it in lowercase; prose writes `Retry-After`.
const HEADER = [
  /(['"])(?:x-ms-)?retry-after(?:-ms)?\1/i,
  /`(?:x-ms-)?retry-after(?:-ms)?`/,
];
const SCANNED = /^(?:src|test\/integration|ci)\/.+\.[cm]?[jt]sx?$/;

const ALLOWED = new Map([
  ['src/shared/retry-after.ts', 'the shared parser'],
  ['src/api/server.ts', 'sends the header'],
  ['src/api/routes/bucket.ts', 'sends the header'],
  ['src/api/rpc/bucket-metadata.ts', 'sends the header'],
  ['src/shared/services/api-client/outage.ts', 'echoes it as a diagnostic'],
  ['src/api/services/gateways/github.ts', 'reads its presence as a rate limit'],
]);

export function validateRetryAfterParsing(files) {
  return files.flatMap(({ path, content }) => {
    if (!SCANNED.test(path) || ALLOWED.has(path)) return [];
    const line = content
      .split('\n')
      .findIndex((text) => HEADER.some((header) => header.test(text)));
    return line < 0
      ? []
      : [
          `${path}:${line + 1}: parse Retry-After with retryAfterMs from src/shared/retry-after.ts`,
        ];
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = validateRetryAfterParsing(
    gitVisibleFiles(root)
      .filter((path) => SCANNED.test(path))
      .map((path) => ({
        path,
        content: readFileSync(join(root, path), 'utf8'),
      })),
  );
  if (violations.length > 0) {
    console.error('Retry-After parsing check failed.');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
