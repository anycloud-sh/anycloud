#!/usr/bin/env node

// Entry files in changelog-unreleased/ must be named for their pull request:
// `975.md`, not `lambda-launch-pacing.md`.
//
// This is not only convention. `listEntryFiles` in ci/fold-changelog-entries.mjs
// orders entries with a numeric collator so the folded release section keeps
// docs/changelog.md's newest-on-top order. A non-numeric name has no defined
// position in that ordering, so it lands somewhere arbitrary in the released
// section — a silent, permanent mistake in published notes.
//
// The number also makes an entry traceable back to the change that justified it
// without reading its prose, which is what review needs when deciding whether
// an entry belongs at all.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRY_DIR = 'changelog-unreleased';

/** Keeps the directory in git while it holds no pending entries. */
const ALLOWED_NON_ENTRY = new Set(['.gitkeep']);

const ENTRY_NAME = /^\d+\.md$/;

export function validateChangelogEntryNames(names) {
  const violations = [];
  for (const name of [...names].sort()) {
    if (ALLOWED_NON_ENTRY.has(name)) continue;
    if (ENTRY_NAME.test(name)) continue;
    violations.push(
      `${ENTRY_DIR}/${name} is not named for a pull request; rename it to ` +
        `<pr-number>.md (for example 975.md).`,
    );
  }
  return violations;
}

export function inspectEntryDirectory(root) {
  const dir = resolve(root, ENTRY_DIR);
  if (!existsSync(dir)) return [];
  return validateChangelogEntryNames(readdirSync(dir));
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = inspectEntryDirectory(root);
  if (violations.length > 0) {
    console.error('Changelog entry naming check failed.');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
