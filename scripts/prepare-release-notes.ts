#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { extractReleaseNotes } from '../src/shared/release-notes.js';

function main(): void {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      output: { type: 'string' },
    },
  });
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version?: unknown;
  };
  const version =
    values.version ??
    process.env.VERSION ??
    (typeof packageJson.version === 'string' ? packageJson.version : '');
  if (!version) throw new Error('could not resolve the release version');

  const changelog = readFileSync('docs/changelog.md', 'utf8');
  const notes = extractReleaseNotes(changelog, version);

  if (values.output) writeFileSync(values.output, `${notes}\n`, 'utf8');
  console.log(
    `release notes check passed for ${version} (${notes.length} characters)`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `release notes check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
