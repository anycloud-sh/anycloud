import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, onTestFinished, test } from 'vitest';

async function directory(): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), 'cleanup-manifest-'));
  onTestFinished(() => rm(result, { force: true, recursive: true }));
  return result;
}

describe('E2E cleanup manifest retention', () => {
  test.each([
    'aws-gpu-serve',
    'azure-gpu-serve',
    'gcp-gpu-serve',
    'lambda-gpu-serve',
    'aws-serve',
    'azure-serve',
    'gcp-serve',
    'lambda-serve',
    'aws-serve-upgrade',
    'local-smolvm-serve',
    'aws-vm',
  ])(
    'outer API cleanup cannot discharge retained native tracking for %s',
    async (member) => {
      const output = await directory();
      const manifest = path.join(output, 'workloads-to-clean');
      await writeFile(manifest, 'service-one\n');
      execFileSync(
        'bash',
        [
          '-c',
          'source "$PROJECT_ROOT/test/integration/helpers/common.sh"; mark_e2e_cleanup_workload_done service-one',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PROJECT_ROOT: process.cwd(),
            RESULTS_DIR: output,
            TEST_NAME: member,
            E2E_IMPLEMENTATION: 'vitest',
          },
          timeout: 5_000,
        },
      );
      expect(await readFile(manifest, 'utf8')).toBe('service-one\n');
    },
  );
});
