#!/usr/bin/env node

// Anycloud state directory boundary.
//
// Anything that resolves Anycloud's own state must go through getAnycloudDir()
// in src/shared/utils.ts, which honours ANYCLOUD_DIR. Hosted APIs run with
// ANYCLOUD_DIR pointing at their checkpoint mount while HOME stays on the
// container's ephemeral layer, so a hardcoded join(homedir(), '.anycloud')
// resolves to a directory that every upgrade discards.
//
// That is not hypothetical: Slack notification config and its delivery
// receipts were the one state module doing this, and the result was that
// hosted APIs silently never sent a notification. The failure is invisible at
// runtime and invisible to tests that write and read through the same helper,
// which is why it belongs here rather than in a spec.
//
// Home-directory paths that are genuinely about the user's home — .aws,
// .config/gcloud, .claude — are unaffected. This check is only about
// Anycloud's own state directory.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Paths permitted to resolve the state directory from the home directory. */
export const ALLOWED_HOME_DIR_PATHS = [
  // Defines the accessor every other module must use.
  'src/shared/utils.ts',
  // Reads the pre-database notification config from where older releases
  // wrote it. Delete this entry with the importer it guards.
  'src/api/services/notifications-legacy-import.ts',
];

// join(homedir(), '.anycloud') and any spelling that reaches the same place.
const PATTERN = /homedir\(\)\s*,\s*['"`]\.anycloud['"`]/;

/**
 * @param {Array<{ path: string, source: string }>} files
 * @param {string[]} allowed
 * @returns {string[]} violations as `path:line`
 */
export function findAnycloudDirViolations(
  files,
  allowed = ALLOWED_HOME_DIR_PATHS,
) {
  const exempt = new Set(allowed);
  const violations = [];
  for (const { path, source } of files) {
    if (exempt.has(path)) continue;
    const match = PATTERN.exec(source);
    if (!match) continue;
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    violations.push(`${path}:${line}`);
  }
  return violations;
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(path)) files.push(path);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const violations = findAnycloudDirViolations(
    listFiles(join(root, 'src')).map((file) => ({
      path: relative(root, file).replaceAll('\\', '/'),
      source: readFileSync(file, 'utf8'),
    })),
  );

  if (violations.length > 0) {
    console.error('Anycloud state directory boundary check failed.');
    console.error(
      "Resolve Anycloud's state directory with getAnycloudDir() from src/shared/utils.ts. Hardcoding the home directory ignores ANYCLOUD_DIR, so the path is wrong on a hosted API and the state is lost on every upgrade.",
    );
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }

  console.log(
    `Anycloud state directory boundary check passed (${ALLOWED_HOME_DIR_PATHS.length} reviewed exception(s)).`,
  );
}
