import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs a repository check script with its working directory set to a
 * throwaway tree built from `files` (repo-relative path → contents).
 *
 * @param {string} script repo-relative path, e.g. `scripts/check-x.mjs`
 * @param {Record<string, string>} files
 * @param {{ git?: boolean }} [options] `git` makes the tree a Git repository
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runScriptInTree(script, files, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'repo-check-'));
  try {
    if (git) execFileSync('git', ['init', '--quiet', root]);
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`../../${script}`, import.meta.url))],
      { cwd: root, encoding: 'utf8' },
    );
    return { status, stdout, stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
