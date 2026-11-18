import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    join(import.meta.dirname, 'run.mjs'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
