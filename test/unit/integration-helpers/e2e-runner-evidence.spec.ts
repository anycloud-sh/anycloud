import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import { readE2ERunRecord } from '../../integration/helpers/e2e-run-record.js';

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function resultsDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'anycloud-runner-evidence-'));
  tempDirs.push(directory);
  return directory;
}

describe('isolated E2E runner evidence traps', () => {
  test.each(
    ['aws', 'azure', 'gcp', 'lambda', 'local-smolvm']
      .flatMap((provider) => [`${provider}-vm`, `${provider}-vm-host-loss`])
      .concat(
        'local-held-job',
        'local-completed-job',
        'local-resubmitted-job',
        ...['aws', 'azure', 'gcp', 'lambda'].map(
          (provider) => `${provider}-bucket-sync`,
        ),
        ...['aws', 'azure', 'gcp'].flatMap((provider) => [
          `${provider}-concurrent-output`,
          `${provider}-job-host-unreachable`,
          `${provider}-spot-eviction`,
        ]),
        ...['aws', 'azure', 'gcp'].map((provider) => `${provider}-invalid`),
        'aws-input-hydration-recovery',
        'aws-spot-request-cleanup',
        ...['aws', 'azure', 'gcp', 'lambda'].map(
          (provider) => `${provider}-runtime-secrets`,
        ),
        'aws-restricted-credential',
        'azure-restricted-credential',
        ...['aws', 'azure', 'gcp'].map((provider) => `${provider}-host-docker`),
        ...['aws', 'azure', 'gcp', 'lambda'].map(
          (provider) => `${provider}-mace-full-pull`,
        ),
        'gcp-disk-tier',
        'azure-ghcr-probe',
      ),
  )(
    'API-only outer cleanup cannot release native tracking retained by %s',
    (member) => {
      for (const implementation of ['vitest', 'bash']) {
        const output = resultsDir();
        const result = spawnSync(
          'bash',
          [
            '-c',
            `
              set -e
              PROJECT_ROOT=$1
              RESULTS_DIR=$2
              TEST_NAME=$3
              E2E_IMPLEMENTATION=$4
              API_URL=http://unused.invalid
              source "$PROJECT_ROOT/test/integration/helpers/common.sh"
              api_get_status() { printf '{}'; }
              api_terminate() { printf terminated > "$RESULTS_DIR/api-termination"; }
              wait_for_no_live_vms() { printf checked > "$RESULTS_DIR/ledger-check"; }
              printf 'vm-native-unknown\n' > "$RESULTS_DIR/workloads-to-clean"
              cleanup_workload_via_api vm-native-unknown 1
            `,
            'fixture',
            projectRoot,
            output,
            member,
            implementation,
          ],
          { cwd: projectRoot, encoding: 'utf8', timeout: 5_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readFileSync(join(output, 'api-termination'), 'utf8')).toBe(
          'terminated',
        );
        expect(readFileSync(join(output, 'ledger-check'), 'utf8')).toBe(
          'checked',
        );
        expect(readFileSync(join(output, 'workloads-to-clean'), 'utf8')).toBe(
          implementation === 'vitest' ? 'vm-native-unknown\n' : '',
        );
      }
    },
  );

  test.each([0, 1, 77, 124])(
    'preserves exit %s through evidence capture and cleanup',
    (exitCode) => {
      const output = resultsDir();
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
      set -euo pipefail
      PROJECT_ROOT=$1
      RESULTS_DIR=$2
      TEST_NAME=command-status
      E2E_IMPLEMENTATION=bash
      LOG_FILE="$RESULTS_DIR/command-status-bash.log"
      TEST_COMMAND_DESCRIPTION="fixture command"
      RUNNER_START_SECONDS=$SECONDS
      source "$PROJECT_ROOT/test/integration/helpers/e2e-evidence.sh"
      trap 'printf cleaned > "$RESULTS_DIR/cleanup"' EXIT
      e2e_run_command bash -c 'echo executed; exit "$1"' fixture "$3"
    `,
          'fixture',
          projectRoot,
          output,
          String(exitCode),
        ],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: { ...process.env, E2E_FAIL_ON_SKIP: 'false' },
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exitCode);
      expect(readE2ERunRecord(output)).toMatchObject({ exitCode });
      expect(
        readFileSync(join(output, 'command-status-bash.log'), 'utf8'),
      ).toContain('executed');
      expect(readFileSync(join(output, 'cleanup'), 'utf8')).toBe('cleaned');
    },
  );

  test('fails Azure prerequisite validation without starting the cloud test', () => {
    const output = resultsDir();
    const result = spawnSync(
      'bash',
      ['test/integration/e2e.sh', 'azure-ghcr-probe', '--vitest'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          RESULTS_DIR: output,
          AZURE_CLIENT_ID: '',
          AZURE_CLIENT_SECRET: '',
          AZURE_TENANT_ID: '',
          AZURE_SUBSCRIPTION_ID: '',
          E2E_FAIL_ON_SKIP: 'false',
        },
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Azure auth preflight failed');
    expect(readE2ERunRecord(output)).toMatchObject({ exitCode: 2 });
    expect(readFileSync(join(output, 'failures.json'), 'utf8')).toContain(
      'azure-ghcr-probe',
    );
  });

  test.each([
    {
      args: ['missing-candidate'],
      expectedExit: 2,
      runner: 'test/integration/run-constrained-vitest.sh',
    },
    {
      args: ['missing-candidate', '--vitest'],
      expectedExit: 1,
      runner: 'test/integration/e2e.sh',
    },
  ])('$runner records failures before test execution', (example) => {
    const output = resultsDir();
    const result = spawnSync('bash', [example.runner, ...example.args], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, RESULTS_DIR: output },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(example.expectedExit);
    expect(readE2ERunRecord(output)).toMatchObject({
      version: 1,
      testName: 'missing-candidate',
      implementation: 'vitest',
      exitCode: example.expectedExit,
    });
    expect(
      readFileSync(join(output, 'missing-candidate-vitest.log'), 'utf8'),
    ).toContain('Runner exited before the test command');
    expect(existsSync(join(output, 'joblog.txt'))).toBe(true);
    expect(existsSync(join(output, 'START_HERE.md'))).toBe(true);
    expect(existsSync(join(output, 'failures.json'))).toBe(true);
  });
});
