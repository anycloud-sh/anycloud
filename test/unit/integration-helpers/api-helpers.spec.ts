import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const projectRoot = join(__dirname, '../../..');
const scriptPath = join(projectRoot, 'test/integration/helpers/common.sh');
const lambdaApiScriptPath = join(
  projectRoot,
  'test/integration/helpers/lambda-api.sh',
);
const lambdaBootFailoverCleanupPath = join(
  projectRoot,
  'test/integration/helpers/lambda-boot-failover-cleanup.sh',
);
const lambdaBootFailoverWorkflowPath = join(
  projectRoot,
  '.github/workflows/lambda-boot-failover.yml',
);

const env = {
  ...process.env,
  API_URL: 'http://unused',
  PROJECT_ROOT: projectRoot,
};

/**
 * Source common.sh, override cli_status to echo canned JSON,
 * then call the real api_* helper and capture its output.
 */
const callHelper = (fn: string, json: string): string => {
  const escaped = json.replace(/'/g, "'\\''");
  const script = `
    source "${scriptPath}"
    cli_status() { echo '${escaped}'; }
    ${fn}
  `;
  return execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf-8',
    env,
  }).trim();
};

const callCommonScript = (body: string): string => {
  const script = `
    source "${scriptPath}"
    ${body}
  `;
  return execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf-8',
    env,
  }).trim();
};

const callLambdaTerminationHelper = (input: {
  listBody?: unknown;
  listStatus?: number;
  pointBody: unknown;
  pointStatus: number;
  secondObservationAt?: number;
}): number[] => {
  const script = `
    source "$LAMBDA_API_SCRIPT_PATH"
    print_warning() { :; }
    curl() {
      local url="\${@: -1}"
      if [[ "$url" == */instances/vm-1 ]]; then
        printf '%s\\n%s' "$MOCK_POINT_BODY" "$MOCK_POINT_STATUS"
      else
        printf '%s\\n%s' "$MOCK_LIST_BODY" "$MOCK_LIST_STATUS"
      fi
    }
    date() { printf '%s' "$MOCK_NOW"; }
    set +e
    lambda_api_is_vm_terminated vm-1 >/dev/null
    first_rc=$?
    if [ -n "$MOCK_SECOND_NOW" ]; then
      MOCK_NOW=$MOCK_SECOND_NOW
      lambda_api_is_vm_terminated vm-1 >/dev/null
      second_rc=$?
      printf '%s,%s' "$first_rc" "$second_rc"
    else
      printf '%s' "$first_rc"
    fi
  `;
  const output = execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: {
      ...env,
      LAMBDA_API_KEY: 'test-key',
      LAMBDA_API_SCRIPT_PATH: lambdaApiScriptPath,
      MOCK_LIST_BODY: JSON.stringify(input.listBody ?? { data: [] }),
      MOCK_LIST_STATUS: String(input.listStatus ?? 200),
      MOCK_NOW: '100',
      MOCK_POINT_BODY: JSON.stringify(input.pointBody),
      MOCK_POINT_STATUS: String(input.pointStatus),
      MOCK_SECOND_NOW:
        input.secondObservationAt === undefined
          ? ''
          : String(input.secondObservationAt),
    },
  });
  return output.split(',').map(Number);
};

const writeLambdaBootFailoverLedger = (input: {
  artifactName: string;
  workloadId: string;
  directory: string;
  instanceIds: string[];
  trial?: string;
}): void => {
  const artifactDirectory = join(input.directory, input.artifactName);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(
    join(
      artifactDirectory,
      `lambda-boot-failover-ledger-${input.trial ?? '01'}.json`,
    ),
    JSON.stringify({
      workloadId: input.workloadId,
      instanceIds: input.instanceIds,
    }),
  );
};

const runLambdaBootFailoverCleanup = (input: {
  directory: string;
  expectedTrialCount?: number;
  firstDiscoveryBody?: unknown;
  secondDiscoveryBody?: unknown;
  verificationBody?: unknown;
}): string => {
  const script = `
    FAKE_NOW=100
    export FAKE_NOW
    curl() {
      local url="\${@: -1}"
      if [[ "$*" == *"--request POST"* ]]; then
        printf '{"data":{}}\\n200'
      elif [[ "$url" == */instances/* ]]; then
        printf '{"error":"not found"}\\n404'
      elif [ "$FAKE_NOW" -lt 110 ]; then
        printf '%s\\n200' "$FIRST_DISCOVERY_BODY"
      elif [ "$FAKE_NOW" -eq 110 ]; then
        printf '%s\\n200' "$SECOND_DISCOVERY_BODY"
      else
        printf '%s\\n200' "$VERIFICATION_BODY"
      fi
    }
    date() { printf '%s' "$FAKE_NOW"; }
    sleep() { FAKE_NOW=$((FAKE_NOW + $1)); export FAKE_NOW; }
    export -f curl date sleep
    bash "$CLEANUP_SCRIPT"
  `;

  return execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: {
      ...env,
      CLEANUP_SCRIPT: lambdaBootFailoverCleanupPath,
      EXPECTED_TRIAL_COUNT: String(input.expectedTrialCount ?? 1),
      FIRST_DISCOVERY_BODY: JSON.stringify(
        input.firstDiscoveryBody ?? { data: [] },
      ),
      LAMBDA_API_KEY: 'test-key',
      LAMBDA_BOOT_FAILOVER_AUDIT_SECONDS: '60',
      LAMBDA_BOOT_FAILOVER_LEDGER_ROOT: input.directory,
      RUN_PREFIX: 'lbto-run-',
      SECOND_DISCOVERY_BODY: JSON.stringify(
        input.secondDiscoveryBody ?? { data: [] },
      ),
      VERIFICATION_BODY: JSON.stringify(input.verificationBody ?? { data: [] }),
    },
  });
};

describe('lambda_api_is_vm_terminated', () => {
  it('omits notebook credentials from malformed account-inventory diagnostics', () => {
    const script = `
      source "$LAMBDA_API_SCRIPT_PATH"
      print_warning() { printf '%s\\n' "$*"; }
      curl() {
        local url="\${@: -1}"
        if [[ "$url" == */instances/vm-1 ]]; then
          printf '%s\\n404' '{}'
        else
          printf '%s\\n200' "$MOCK_INVENTORY"
        fi
      }
      set +e
      lambda_api_is_vm_terminated vm-1
      printf 'helper-exit=%s\\n' "$?"
    `;
    const output = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...env,
        LAMBDA_API_KEY: 'test-key',
        LAMBDA_API_SCRIPT_PATH: lambdaApiScriptPath,
        MOCK_INVENTORY: JSON.stringify({
          data: {
            id: 'unrelated',
            notebook_url:
              'https://notebook.invalid/?token=never-retain-this-notebook-token',
          },
        }),
      },
    });
    expect(output).toContain(
      'Lambda instance list got an unexpected body for vm-1',
    );
    expect(output).toContain('helper-exit=3');
    expect(output).not.toContain('never-retain-this-notebook-token');
    expect(output).not.toContain('notebook_url');
  });
  it('requires two point/list absence observations ten seconds apart', () => {
    expect(
      callLambdaTerminationHelper({
        pointBody: { error: 'not found' },
        pointStatus: 404,
        secondObservationAt: 110,
      }),
    ).toEqual([2, 0]);
  });

  it.each([
    [
      'a live point response',
      {
        pointBody: { data: { id: 'vm-1', status: 'active' } },
        pointStatus: 200,
      },
      1,
    ],
    [
      'the exact ID remaining live in the list',
      {
        listBody: { data: [{ id: 'vm-1', status: 'active' }] },
        pointBody: { error: 'not found' },
        pointStatus: 404,
      },
      1,
    ],
    [
      'a terminating list record',
      {
        listBody: { data: [{ id: 'vm-1', status: 'terminating' }] },
        pointBody: { error: 'not found' },
        pointStatus: 404,
      },
      2,
    ],
    [
      'a transient list response',
      {
        listBody: { error: 'unavailable' },
        listStatus: 503,
        pointBody: { error: 'not found' },
        pointStatus: 404,
      },
      2,
    ],
    [
      'a malformed list response',
      {
        listBody: {},
        pointBody: { error: 'not found' },
        pointStatus: 404,
      },
      3,
    ],
    [
      'a partial list page',
      {
        listBody: { data: [], page_token: 'p2' },
        pointBody: { error: 'not found' },
        pointStatus: 404,
      },
      3,
    ],
  ])('classifies %s', (_label, input, expected) => {
    expect(callLambdaTerminationHelper(input)).toEqual([expected]);
  });
});

describe('lambda boot-failover cleanup audit', () => {
  it('downloads every workflow attempt into a separate artifact directory', () => {
    const workflow = readFileSync(lambdaBootFailoverWorkflowPath, 'utf8');

    expect(workflow).toMatch(
      /^\s+pattern: lambda-boot-failover-\$\{\{ github\.run_id \}\}-\*\s*$/m,
    );
    expect(workflow).toMatch(/^\s+merge-multiple: false\s*$/m);
  });

  it('fails tagged-instance discovery on a partial list page', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lambda-ledger-partial-'));
    writeLambdaBootFailoverLedger({
      artifactName: 'lambda-boot-failover-run-01-1',
      workloadId: 'lbto-run-01',
      directory,
      instanceIds: [],
    });

    try {
      const error = (() => {
        try {
          runLambdaBootFailoverCleanup({
            directory,
            firstDiscoveryBody: { data: [], page_token: 'p2' },
          });
        } catch (caught) {
          return caught as { status: number; stdout: string; stderr: string };
        }
        throw new Error('cleanup audit accepted a partial page');
      })();
      expect(error.status).not.toBe(0);
      expect(`${error.stdout}${error.stderr}`).toContain(
        'tagged-instance discovery observation 1 was malformed',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('terminates and point/list verifies every exact ledger ID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lambda-ledger-audit-'));
    const instanceId = '11111111222233334444555555555555';
    writeLambdaBootFailoverLedger({
      artifactName: 'lambda-boot-failover-run-01-1',
      workloadId: 'lbto-run-01',
      directory,
      instanceIds: [instanceId],
    });

    try {
      const output = runLambdaBootFailoverCleanup({ directory });
      expect(output).toContain(`LAMBDA_FAILOVER_AUDIT released=${instanceId}`);
      expect(output).toContain('LAMBDA_FAILOVER_AUDIT result=clean');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('unions exact instance ledgers across rerun attempts by unique trial', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lambda-ledger-rerun-'));
    const firstInstanceId = '11111111222233334444555555555555';
    const retryInstanceId = '66666666777788889999000000000000';
    writeLambdaBootFailoverLedger({
      artifactName: 'lambda-boot-failover-run-01-1',
      workloadId: 'lbto-run-01',
      directory,
      instanceIds: [firstInstanceId],
    });
    writeLambdaBootFailoverLedger({
      artifactName: 'lambda-boot-failover-run-01-2',
      workloadId: 'lbto-run-01',
      directory,
      instanceIds: [retryInstanceId],
    });

    try {
      const output = runLambdaBootFailoverCleanup({ directory });
      expect(output).toContain(
        `LAMBDA_FAILOVER_AUDIT released=${firstInstanceId}`,
      );
      expect(output).toContain(
        `LAMBDA_FAILOVER_AUDIT released=${retryInstanceId}`,
      );
      expect(output).toContain('LAMBDA_FAILOVER_AUDIT result=clean');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'appears only in the second discovery snapshot',
      { data: [] },
      {
        data: [
          {
            id: '11111111222233334444555555555555',
            status: 'active',
            tags: [{ key: 'anycloud:deployment-id', value: 'lbto-run-01' }],
          },
        ],
      },
    ],
    [
      'has a tagged terminal record in the first snapshot',
      {
        data: [
          {
            id: '11111111222233334444555555555555',
            status: 'terminated',
            tags: [{ key: 'anycloud:deployment-id', value: 'lbto-run-01' }],
          },
        ],
      },
      { data: [] },
    ],
  ])('cleans up an unrecorded instance that %s', (_label, first, second) => {
    const directory = mkdtempSync(join(tmpdir(), 'lambda-ledger-discovery-'));
    const instanceId = '11111111222233334444555555555555';
    writeLambdaBootFailoverLedger({
      artifactName: 'lambda-boot-failover-run-01-1',
      workloadId: 'lbto-run-01',
      directory,
      instanceIds: [],
    });

    try {
      const output = runLambdaBootFailoverCleanup({
        directory,
        firstDiscoveryBody: first,
        secondDiscoveryBody: second,
      });
      expect(output).toContain(`LAMBDA_FAILOVER_AUDIT released=${instanceId}`);
      expect(output).toContain('LAMBDA_FAILOVER_AUDIT result=clean');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Sample StatusResponse payloads matching the real API shape
const STATUS_RUNNING = JSON.stringify({
  events: [
    {
      id: 1,
      workloadId: 'test-123',
      state: 'provisioning',
      metadata: null,
      createdAt: 1000,
    },
    {
      id: 2,
      workloadId: 'test-123',
      state: 'running',
      metadata: null,
      createdAt: 2000,
    },
  ],
  status: 'up',
  vms: [{ ip: '10.0.0.1', container: { state: 'running', uptime: '5m' } }],
});

const STATUS_COMPLETED = JSON.stringify({
  events: [
    {
      id: 1,
      workloadId: 'test-123',
      state: 'provisioning',
      metadata: null,
      createdAt: 1000,
    },
    {
      id: 2,
      workloadId: 'test-123',
      state: 'running',
      metadata: null,
      createdAt: 2000,
    },
    {
      id: 3,
      workloadId: 'test-123',
      state: 'completed',
      metadata: null,
      createdAt: 3000,
    },
  ],
  status: 'down',
  vms: [],
});

const STATUS_MULTI_VM = JSON.stringify({
  events: [
    {
      id: 1,
      workloadId: 'test-123',
      state: 'running',
      metadata: null,
      createdAt: 1000,
    },
  ],
  status: 'up',
  vms: [
    { ip: '10.0.0.1', container: { state: 'running', uptime: '5m' } },
    { ip: '10.0.0.2', container: { state: 'running', uptime: '3m' } },
  ],
});

const STATUS_NO_EVENTS = JSON.stringify({
  events: [],
  status: '-',
});

describe('api_get_state', () => {
  it('extracts running from last event', () => {
    expect(callHelper('api_get_state test-123', STATUS_RUNNING)).toBe(
      'running',
    );
  });

  it('extracts completed from last event', () => {
    expect(callHelper('api_get_state test-123', STATUS_COMPLETED)).toBe(
      'completed',
    );
  });

  it('returns empty for no events', () => {
    expect(callHelper('api_get_state test-123', STATUS_NO_EVENTS)).toBe('');
  });
});

describe('api_count_vms', () => {
  it('counts single VM', () => {
    expect(callHelper('api_count_vms test-123', STATUS_RUNNING)).toBe('1');
  });

  it('counts multiple VMs', () => {
    expect(callHelper('api_count_vms test-123', STATUS_MULTI_VM)).toBe('2');
  });

  it('returns 0 for no VMs', () => {
    expect(callHelper('api_count_vms test-123', STATUS_COMPLETED)).toBe('0');
  });

  it('preserves status failures for cleanup callers', () => {
    const output = callCommonScript(`
      cli_status() { echo "Workload not found" >&2; return 1; }
      set +e
      count_output=$(api_count_vms missing-workload 2>&1)
      count_rc=$?
      set -e
      echo "rc:$count_rc"
      echo "output:$count_output"
    `);

    expect(output.split('\n')).toEqual(['rc:1', 'output:Workload not found']);
  });
});

describe('api_count_cleanup_targets', () => {
  it('counts all selected ledger rows in one query without requiring an IP', () => {
    const output = callCommonScript(`
      node() {
        sql=""
        for arg in "$@"; do sql="$arg"; done
        case "$sql" in
          *"workload_id IN ('dep-a','dep''b')"*) ;;
          *) return 4 ;;
        esac
        case "$sql" in
          *"ended_at IS NULL"*) ;;
          *) return 2 ;;
        esac
        case "$sql" in
          *"ip IS NOT NULL"*) return 3 ;;
        esac
        echo '{"rows":[{"count":2}]}'
      }
      api_count_cleanup_targets dep-a "dep'b"
    `);

    expect(output).toBe('2');
  });

  it('returns zero without calling the API when no IDs are selected', () => {
    const output = callCommonScript(`
      node() { echo "unexpected API call"; return 1; }
      api_count_cleanup_targets
    `);

    expect(output).toBe('0');
  });
});

describe('fallback workload cleanup CLI selection', () => {
  it.each(['candidate', 'workspace'] as const)(
    'uses the %s CLI for status, termination and cleanup confirmation',
    (source) => {
      const directory = mkdtempSync(join(tmpdir(), 'e2e-cleanup-cli-'));
      try {
        const cliPath =
          source === 'candidate'
            ? join(directory, 'candidate cli')
            : join(directory, 'dist/cli/index.js');
        if (source === 'workspace')
          mkdirSync(join(directory, 'dist/cli'), { recursive: true });
        writeFileSync(
          cliPath,
          `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLI_TRACE, JSON.stringify({
  args, apiUrl: process.env.API_URL, token: process.env.GITHUB_TOKEN
}) + '\\n');
if (args[0] === 'status') console.log('{"vms":[]}');
else if (args[0] === 'db') console.log('{"rows":[{"count":0}]}');
else if (args[0] !== 'terminate') process.exit(1);
`,
          { mode: 0o755 },
        );
        const manifest = join(directory, 'workloads-to-clean');
        const trace = join(directory, 'cli-trace.jsonl');
        writeFileSync(manifest, 'dep-1\n');
        execFileSync(
          'bash',
          ['-c', 'source "$COMMON_SCRIPT"; cleanup_workload_via_api dep-1 0'],
          {
            encoding: 'utf8',
            env: {
              ...env,
              COMMON_SCRIPT: scriptPath,
              PROJECT_ROOT: directory,
              RESULTS_DIR: directory,
              CLI_TRACE: trace,
              E2E_CANDIDATE_CLI: source === 'candidate' ? cliPath : undefined,
              GITHUB_TOKEN: 'cleanup-test-token',
            },
          },
        );
        const calls = readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(calls).toEqual(
          [
            ['status', '--history', 'dep-1', '--json', '--verbose'],
            ['terminate', 'dep-1'],
            [
              'db',
              'query',
              '--json',
              "SELECT COUNT(*) AS count FROM vms WHERE ended_at IS NULL AND workload_id IN ('dep-1')",
            ],
          ].map((args) => ({
            args,
            apiUrl: env.API_URL,
            token: 'cleanup-test-token',
          })),
        );
        expect(readFileSync(manifest, 'utf8')).toBe('');
        if (source === 'candidate')
          expect(existsSync(join(directory, 'dist'))).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('no-live-VM wait', () => {
  it('uses one batched ledger query per polling cycle', () => {
    const output = callCommonScript(`
      trace=$(mktemp)
      fake_now=100
      date() { echo "$fake_now"; }
      sleep() { fake_now=$((fake_now + $1)); }
      print_info() { :; }
      print_warning() { :; }
      print_error() { :; }
      progress_tick() { :; }
      api_count_cleanup_targets() {
        echo "query:$*" >> "$trace"
        if [ "$fake_now" -ge 105 ]; then
          echo 0
        else
          echo 2
        fi
      }
      set +e
      wait_for_workloads_no_live_vms_until 110 dep-a dep-b
      wait_rc=$?
      set -e
      cat "$trace"
      echo "rc:$wait_rc"
      echo "now:$fake_now"
      rm -f "$trace"
    `);

    expect(output.split('\n')).toEqual([
      'query:dep-a dep-b',
      'query:dep-a dep-b',
      'rc:0',
      'now:105',
    ]);
  });

  it('does not treat transient ledger failures as completed cleanup', () => {
    const output = callCommonScript(`
      fake_now=100
      date() { echo "$fake_now"; }
      sleep() { fake_now=$((fake_now + $1)); }
      print_info() { :; }
      print_warning() { :; }
      print_error() { :; }
      progress_tick() { :; }
      api_count_cleanup_targets() {
        echo "cleanup ledger unavailable" >&2
        return 1
      }
      set +e
      wait_for_workloads_no_live_vms_until 100 dep-unknown
      wait_rc=$?
      set -e
      echo "rc:$wait_rc"
    `);

    expect(output).toBe('rc:1');
  });

  it('treats an absent workload ledger as already cleaned without sleeping', () => {
    const output = callCommonScript(`
      api_count_cleanup_targets() { echo 0; }
      sleep() { echo "unexpected sleep"; return 1; }
      wait_for_no_live_vms missing-workload 90
      echo "rc:$?"
    `);

    expect(output).toBe('rc:0');
  });
});

describe('common.sh syntax', () => {
  it('parses without error', () => {
    expect(() => execFileSync('bash', ['-n', scriptPath])).not.toThrow();
  });
});
