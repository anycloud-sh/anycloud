import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files Git would commit under `root` — tracked, plus untracked files that are
 * not ignored — that still exist on disk (a tracked file can be deleted in the
 * working tree).
 */
export function gitVisibleFiles(root) {
  const paths = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0');
  return [...new Set(paths)].filter(
    (path) => path && existsSync(join(root, path)),
  );
}
