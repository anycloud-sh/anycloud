#!/usr/bin/env node

// Folds the per-change entry files in changelog-unreleased/ into a real
// `## X.Y.Z` section in docs/changelog.md. Run from the release PR, before
// dispatching the Release workflow.
//
// The directory sits at the repository root, not under docs/, so the site
// never sees an entry describing behavior nobody can use yet.
//
// Plain .mjs with no dependencies: scripts/verify-release-state.js imports
// listEntryFiles under bare `node` in the release workflow.

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRY_DIR = 'changelog-unreleased';

const collator = new Intl.Collator('en', { numeric: true });

/**
 * Entry filenames, newest first, so a folded section keeps the
 * newest-on-top order docs/changelog.md already uses.
 */
export function listEntryFiles(dir = ENTRY_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => collator.compare(b, a));
}

/**
 * The version the next release will carry.
 *
 * `release.yml` cuts every release with `npm version patch`, so the target is
 * derived rather than chosen. That is what keeps a fold off published history:
 * `released` is package.json's version, which the workflow bumps only as part
 * of publishing, so the target is always one patch beyond anything shipped.
 */
export function nextRelease(released) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(released ?? '');
  if (!parts) throw new Error(`invalid released version: ${released}`);
  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
}

/** Splice entry bodies into `changelog` as the next release's section. */
export function mergeEntries({ changelog, released, entries }) {
  const version = nextRelease(released);
  if (entries.length === 0) {
    throw new Error(`${ENTRY_DIR} holds no entries to release`);
  }
  for (const { path, content } of entries) {
    // A `## ` line inside an entry would splice in as a second release section
    // and silently steal every entry below it.
    if (/^## /m.test(content)) {
      throw new Error(`${path} must not contain a "## " heading`);
    }
  }

  const at = changelog.search(/^## /m);
  if (at < 0) throw new Error('docs/changelog.md has no release sections');
  const body = entries.map(({ content }) => content.trim()).join('\n\n');
  const heading = `## ${version}`;

  // Only a release PR already in flight can have written this heading, since
  // nothing else produces it — so append, absorbing an entry that landed after
  // the fold. Everything below is published and stays untouched either way.
  if (changelog.startsWith(`${heading}\n`, at)) {
    const next = changelog.indexOf('\n## ', at + 1);
    const end = next < 0 ? changelog.length : next + 1;
    const head = changelog.slice(0, end).trimEnd();
    const tail = changelog.slice(end);
    return tail ? `${head}\n\n${body}\n\n${tail}` : `${head}\n\n${body}\n`;
  }
  return `${changelog.slice(0, at)}${heading}\n\n${body}\n\n${changelog.slice(at)}`;
}

function main() {
  const names = listEntryFiles();
  const entries = names.map((name) => ({
    path: join(ENTRY_DIR, name),
    content: readFileSync(join(ENTRY_DIR, name), 'utf8'),
  }));
  const changelog = readFileSync('docs/changelog.md', 'utf8');
  const released = JSON.parse(readFileSync('package.json', 'utf8')).version;

  writeFileSync(
    'docs/changelog.md',
    mergeEntries({ changelog, released, entries }),
    'utf8',
  );
  for (const { path } of entries) rmSync(path);

  console.log(
    `folded ${entries.length} entry file(s) into "## ${nextRelease(released)}": ${names.join(', ')}`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  // Paths below are repository-relative, so run from the cluster regardless of
  // where the command was invoked (this file sits two levels down).
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  try {
    main();
  } catch (error) {
    console.error(
      `changelog fold failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
