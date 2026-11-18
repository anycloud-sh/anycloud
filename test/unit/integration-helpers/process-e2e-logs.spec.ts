import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeE2ERunRecord } from '../../integration/helpers/e2e-run-record.js';
import {
  parseJoblog,
  processE2ELogs,
} from '../../integration/helpers/process-e2e-logs.js';

interface ApiLine {
  timestamp: string;
  level: string;
  message: string;
  id?: string;
  state?: string;
  error?: string | { message: string };
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  vi.restoreAllMocks();
});

function makeFixtureDir(): { dir: string; apiLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anycloud-e2e-log-test-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'out'), { recursive: true });
  return { dir: join(dir, 'out'), apiLog: join(dir, 'api-e2e.log') };
}

function writeApiLog(path: string, lines: ApiLine[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
}

function writeJoblog(
  outDir: string,
  rows: Array<{ name: string; exitCode: number; durationSeconds?: number }>,
): void {
  const body = rows
    .map(
      (row, index) =>
        `${index + 1}\t:\t0\t${row.durationSeconds ?? 12.4}\t0\t0\t${row.exitCode}\t0\tbash ./test/integration/${row.name}.test.sh`,
    )
    .join('\n');
  writeFileSync(
    join(outDir, 'joblog.txt'),
    `Seq\tHost\tStarttime\tJobRuntime\tSend\tReceive\tExitval\tSignal\tCommand\n${body}\n`,
  );
}

function writeTestLog(
  outDir: string,
  name: string,
  content: string,
  implementation: 'bash' | 'vitest' = 'bash',
): void {
  writeFileSync(join(outDir, `${name}-${implementation}.log`), content);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeVitestRunRecord(outDir: string, exitCode: number): void {
  writeE2ERunRecord(outDir, {
    version: 1,
    testName: 'aws-vm-host-loss',
    implementation: 'vitest',
    command: 'vitest aws-vm-host-loss.spec.ts',
    logFile: 'aws-vm-host-loss-vitest.log',
    exitCode,
    durationSeconds: 31,
  });
}

function writeFixtureDirectory(
  outDir: string,
  name: string,
  files: Record<string, string>,
): void {
  const directory = join(outDir, 'vitest-fixture', name);
  mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(directory, file), content);
  }
}

function writeFixtureRecord(
  outDir: string,
  name: string,
  record: unknown,
  artifacts: Record<string, string> = {},
): void {
  writeFixtureDirectory(outDir, name, {
    'fixture-record.json': JSON.stringify(record, null, 2),
    ...artifacts,
  });
}

const failedFixtureRecord = {
  version: 1,
  testName: 'loses its host and fails terminally',
  runId: 'a1b2c3d4e5',
  outcome: 'failed',
  failures: ['expected state Failed, last observation Running'],
  workloads: [
    {
      id: 'vm-tracked-only',
      status: 'found',
      artifacts: [
        'diagnostic-status-vm-tracked-only.json',
        'diagnostic-docker-vm-tracked-only.log',
      ],
    },
  ],
  diagnosticErrors: [
    {
      workloadId: 'vm-tracked-only',
      operation: 'remote Docker diagnostics',
      error: 'SSH unavailable',
    },
  ],
};

const workloadLines = (id: string, state = 'retrying'): ApiLine[] => [
  {
    timestamp: '2026-06-05T10:00:00.000Z',
    level: 'INFO',
    message: 'State transition',
    id,
    state: 'provisioning',
  },
  {
    timestamp: '2026-06-05T10:01:00.000Z',
    level: 'ERROR',
    message: 'State transition',
    id,
    state,
    error: 'retrying: Unknown',
  },
  {
    timestamp: '2026-06-05T10:02:00.000Z',
    level: 'ERROR',
    message: 'Provisioning scheduler',
    id,
    error: { message: 'deploy failed: Unknown' },
  },
];

describe('processE2ELogs failure triage', () => {
  it('parses Bash and Vitest compatibility joblog rows without dropping either', () => {
    const header =
      'Seq\tHost\tStarttime\tJobRuntime\tSend\tReceive\tExitval\tSignal\tCommand';
    expect(
      parseJoblog(
        `${header}\n1\t:\t0\t12\t0\t0\t1\t0\tbash ./test/integration/aws-vm.test.sh\n2\t:\t0\t13\t0\t0\t1\t0\tvitest ./test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts\n`,
      ),
    ).toEqual([
      {
        name: 'aws-vm',
        implementation: 'bash',
        exitCode: 1,
        durationSeconds: 12,
        testLog: 'aws-vm-bash.log',
      },
      {
        name: 'aws-vm',
        implementation: 'vitest',
        exitCode: 1,
        durationSeconds: 13,
        testLog: 'aws-vm-vitest.log',
      },
    ]);
    expect(() =>
      parseJoblog(`${header}\n1\t:\t0\t12\t0\t0\t1\t0\tunknown runner\n`),
    ).toThrow('Unrecognized E2E joblog command');
  });

  it('uses explicit Vitest run metadata instead of inferring identity from the command', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, workloadLines('vm-host-loss-aws-run'));
    writeE2ERunRecord(dir, {
      version: 1,
      testName: 'aws-vm-host-loss',
      implementation: 'vitest',
      command: 'opaque runner command with no recognizable filename',
      logFile: 'aws-vm-host-loss-vitest.log',
      exitCode: 1,
      durationSeconds: 19,
    });
    writeTestLog(
      dir,
      'aws-vm-host-loss',
      'Workload vm-host-loss-aws-run\n✗ host loss did not fail\n',
      'vitest',
    );

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests[0]).toMatchObject({
      name: 'aws-vm-host-loss',
      implementation: 'vitest',
      testLog: 'aws-vm-host-loss-vitest.log',
      workloads: [{ id: 'vm-host-loss-aws-run' }],
    });
  });

  it('rejects run metadata that can escape the results directory', () => {
    const { dir } = makeFixtureDir();

    expect(() =>
      writeE2ERunRecord(dir, {
        version: 1,
        testName: 'aws-vm',
        implementation: 'bash',
        command: 'bash ./test/integration/aws-vm.test.sh',
        logFile: '../aws-vm-bash.log',
        exitCode: 1,
        durationSeconds: 12,
      }),
    ).toThrow('logFile must be a basename');
  });

  it('keeps the first run record instead of allowing later evidence to replace it', () => {
    const { dir } = makeFixtureDir();
    writeE2ERunRecord(dir, {
      version: 1,
      testName: 'cli-exit',
      implementation: 'vitest',
      command: 'first command',
      logFile: 'cli-exit-vitest.log',
      exitCode: 1,
      durationSeconds: 2,
    });

    expect(() =>
      writeE2ERunRecord(dir, {
        version: 1,
        testName: 'cli-exit',
        implementation: 'vitest',
        command: 'replacement command',
        logFile: 'cli-exit-vitest.log',
        exitCode: 0,
        durationSeconds: 3,
      }),
    ).toThrow();
    expect(readJson(join(dir, 'e2e-run.json'))).toMatchObject({
      command: 'first command',
      exitCode: 1,
    });
  });

  it('rejects a missing declared log instead of silently losing triage', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, []);
    writeE2ERunRecord(dir, {
      version: 1,
      testName: 'aws-vm',
      implementation: 'bash',
      command: 'bash ./test/integration/aws-vm.test.sh',
      logFile: 'aws-vm-bash.log',
      exitCode: 1,
      durationSeconds: 12,
    });

    await expect(
      processE2ELogs(dir, {
        inputLog: apiLog,
        emitConsole: false,
      }),
    ).rejects.toThrow('Declared test log is missing: aws-vm-bash.log');
  });

  it('rejects missing runner metadata', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, []);

    await expect(
      processE2ELogs(dir, {
        inputLog: apiLog,
        emitConsole: false,
      }),
    ).rejects.toThrow('Missing e2e-run.json');
  });

  it('rejects malformed runner metadata', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, []);
    writeFileSync(
      join(dir, 'e2e-run.json'),
      JSON.stringify({
        version: 2,
        testName: 'cli-exit',
        implementation: 'vitest',
        command: 'vitest cli-exit.spec.ts',
        logFile: 'cli-exit-vitest.log',
        exitCode: 0,
        durationSeconds: 1,
      }),
    );
    writeTestLog(dir, 'cli-exit', 'passed\n', 'vitest');

    await expect(
      processE2ELogs(dir, {
        inputLog: apiLog,
        emitConsole: false,
      }),
    ).rejects.toThrow();
  });

  it('still writes triage when an API log does not apply', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeE2ERunRecord(dir, {
      version: 1,
      testName: 'cli-exit',
      implementation: 'vitest',
      command: 'vitest cli-exit.spec.ts',
      logFile: 'cli-exit-vitest.log',
      exitCode: 1,
      durationSeconds: 4,
    });
    writeTestLog(dir, 'cli-exit', '✗ CLI command timed out\n', 'vitest');

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests).toHaveLength(1);
    expect(readFileSync(join(dir, 'START_HERE.md'), 'utf8')).toContain(
      'CLI command timed out',
    );
  });

  it('links one failed test to one related workload', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, workloadLines('bsync-test-aws'));
    writeJoblog(dir, [
      { name: 'aws-bucket-sync', exitCode: 1, durationSeconds: 15.6 },
    ]);
    writeTestLog(
      dir,
      'aws-bucket-sync',
      '[10:03:00] ✗ Workload did not reach running within 2400s\nWorkload: bsync-test-aws\n',
    );

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests).toHaveLength(1);
    expect(report.failedTests[0]).toMatchObject({
      name: 'aws-bucket-sync',
      implementation: 'bash',
      exitCode: 1,
      durationSeconds: 16,
      testLog: 'aws-bucket-sync-bash.log',
      workloads: [
        {
          id: 'bsync-test-aws',
          state: 'retrying',
          firstError: 'State transition: retrying: Unknown',
          lastError: 'Provisioning scheduler: deploy failed: Unknown',
          log: 'per-workload/bsync-test-aws.log',
        },
      ],
    });
    expect(readFileSync(join(dir, 'START_HERE.md'), 'utf8')).toContain(
      'per-workload/bsync-test-aws.log',
    );
    expect(readJson(join(dir, 'failures.json'))).toEqual(report);
  });

  it('links one failed test to multiple related workloads', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, [
      ...workloadLines('bsync-test-aws'),
      ...workloadLines('bsync-test-gcp', 'exited'),
    ]);
    writeJoblog(dir, [{ name: 'aws-bucket-sync', exitCode: 1 }]);
    writeTestLog(
      dir,
      'aws-bucket-sync',
      'created bsync-test-aws\ncreated bsync-test-gcp\n✗ output bucket never updated\n',
    );

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests[0].workloads.map((d) => d.id)).toEqual([
      'bsync-test-aws',
      'bsync-test-gcp',
    ]);
  });

  it('keeps a failed test even when no workload id appears in its log', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, workloadLines('unmentioned-workload'));
    writeJoblog(dir, [{ name: 'gcp-job-host-unreachable', exitCode: 1 }]);
    writeTestLog(
      dir,
      'gcp-job-host-unreachable',
      '✗ Workload ID required with --json. Pass as argument or set ANYCLOUD_WORKLOAD_ID.\n',
    );

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests).toHaveLength(1);
    expect(report.failedTests[0].workloads).toEqual([]);
    expect(report.failedTests[0].failureLines).toEqual([
      '✗ Workload ID required with --json. Pass as argument or set ANYCLOUD_WORKLOAD_ID.',
    ]);
  });

  it('treats an exhausted HTTP response as the failure instead of trailing info', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, []);
    writeJoblog(dir, [{ name: 'aws-recursion', exitCode: 1 }]);
    writeTestLog(
      dir,
      'aws-recursion',
      [
        '[10:00:00]    ⚠ Remote API GET returned HTTP 530 (attempt 1/2) cf-ray=ray-1',
        '[10:00:05]    ✗ Remote API GET returned HTTP 530 (attempt 2/2) cf-ray=ray-2 cloudflare-error-code=1016 retryable=true',
        '[10:00:06]    Starting catalog-refresh',
      ].join('\n'),
    );

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests[0].failureLines).toEqual([
      '[10:00:00]    ⚠ Remote API GET returned HTTP 530 (attempt 1/2) cf-ray=ray-1',
      '[10:00:05]    ✗ Remote API GET returned HTTP 530 (attempt 2/2) cf-ray=ray-2 cloudflare-error-code=1016 retryable=true',
    ]);
  });

  it('keeps a primary test failure ahead of secondary cleanup noise', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, []);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeJoblog(dir, [{ name: 'azure-bucket-sync', exitCode: 1 }]);
    writeTestLog(
      dir,
      'azure-bucket-sync',
      [
        '[10:00:00]    ✗ Object delete failed: The operation was aborted due to timeout',
        '[10:00:01]    ⚠ Could not capture pre-cleanup status for bucket-job',
        '[10:00:02]    ⚠ Secondary cleanup failure: credential delete returned HTTP 500',
      ].join('\n'),
    );

    await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
      githubActions: true,
    });

    const annotation = logSpy.mock.calls
      .flat()
      .find((line) => String(line).startsWith('::error'));
    expect(String(annotation)).toContain(
      'Object delete failed: The operation was aborted due to timeout',
    );
    expect(String(annotation)).not.toContain('Secondary cleanup failure');
  });

  it('reports exit 77 as a failure because the test did not execute', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeApiLog(apiLog, workloadLines('lambda-skip'));
    writeJoblog(dir, [{ name: 'lambda-bucket-sync', exitCode: 77 }]);
    writeTestLog(dir, 'lambda-bucket-sync', 'skipped\n');

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests).toHaveLength(1);
    expect(readJson(join(dir, 'failures.json'))).toMatchObject({
      failedTests: [
        expect.objectContaining({ name: 'lambda-bucket-sync', exitCode: 77 }),
      ],
    });
  });

  it('emits one GitHub error annotation per failed test', async () => {
    const { dir, apiLog } = makeFixtureDir();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeApiLog(apiLog, workloadLines('bsync-test-aws'));
    writeJoblog(dir, [{ name: 'aws-bucket-sync', exitCode: 1 }]);
    writeTestLog(
      dir,
      'aws-bucket-sync',
      'Workload bsync-test-aws\n✗ Workload did not reach running within 2400s\n',
    );

    await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
      githubActions: true,
    });

    const annotations = logSpy.mock.calls
      .flat()
      .filter((line) => String(line).startsWith('::error'));
    expect(annotations).toHaveLength(1);
    expect(String(annotations[0])).toContain(
      'title=aws-bucket-sync (bash) failed::bsync-test-aws [retrying]',
    );
  });

  it('surfaces fixture-tracked workloads the API log never mentioned', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeVitestRunRecord(dir, 1);
    writeTestLog(
      dir,
      'aws-vm-host-loss',
      'FAIL test/integration/e2e/specs/contracts/persistent-vm/aws-vm-host-loss.spec.ts\n',
      'vitest',
    );
    writeFixtureRecord(dir, 'loses-its-host-a1b2c3d4e5', failedFixtureRecord, {
      'diagnostic-status-vm-tracked-only.json': '{}\n',
      'diagnostic-docker-vm-tracked-only.log': 'docker ps -a\n',
    });

    const report = await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
    });

    expect(report.failedTests[0]?.workloads).toEqual([
      {
        id: 'vm-tracked-only',
        state: null,
        firstError: null,
        lastError: null,
        log: null,
      },
    ]);
    const summary = readFileSync(join(dir, 'START_HERE.md'), 'utf8');
    expect(summary).not.toContain('none found in the test log');
    expect(summary).toContain(
      'expected state Failed, last observation Running',
    );
    expect(summary).toContain(
      '[diagnostic-docker-vm-tracked-only.log](vitest-fixture/loses-its-host-a1b2c3d4e5/diagnostic-docker-vm-tracked-only.log)',
    );
    expect(summary).toContain(
      'Diagnostic error (remote Docker diagnostics) for `vm-tracked-only`: SSH unavailable',
    );
  });

  it('prefers the fixture failure over a scraped log line as the root cause', async () => {
    const { dir, apiLog } = makeFixtureDir();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeVitestRunRecord(dir, 1);
    writeTestLog(
      dir,
      'aws-vm-host-loss',
      'Error: Vitest caught 1 error; the test run failed\n',
      'vitest',
    );
    writeFixtureRecord(dir, 'loses-its-host-a1b2c3d4e5', failedFixtureRecord);

    await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
      githubActions: true,
    });

    const annotations = logSpy.mock.calls
      .flat()
      .filter((line) => String(line).startsWith('::error'));
    expect(annotations).toHaveLength(1);
    expect(String(annotations[0])).toContain(
      'expected state Failed, last observation Running',
    );
  });

  it('says diagnostics were not captured when a failed run has no fixture record', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeVitestRunRecord(dir, 1);
    writeTestLog(dir, 'aws-vm-host-loss', 'Cannot find module\n', 'vitest');

    await processE2ELogs(dir, { inputLog: apiLog, emitConsole: false });

    expect(readFileSync(join(dir, 'START_HERE.md'), 'utf8')).toContain(
      'Fixture diagnostics: not captured — the run failed before the fixture initialized',
    );
  });

  it('reports a fixture directory whose lifecycle never finalized', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeVitestRunRecord(dir, 124);
    writeTestLog(dir, 'aws-vm-host-loss', 'Timed out after 6600s\n', 'vitest');
    writeFixtureDirectory(dir, 'loses-its-host-a1b2c3d4e5', {
      'metadata.json': '{"testName":"loses its host"}\n',
    });

    await processE2ELogs(dir, { inputLog: apiLog, emitConsole: false });

    expect(readFileSync(join(dir, 'START_HERE.md'), 'utf8')).toContain(
      '`vitest-fixture/loses-its-host-a1b2c3d4e5/` — the fixture never finalized',
    );
  });

  it('rejects a malformed fixture record instead of dropping its diagnostics', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeVitestRunRecord(dir, 1);
    writeTestLog(dir, 'aws-vm-host-loss', 'failed\n', 'vitest');
    writeFixtureRecord(dir, 'loses-its-host-a1b2c3d4e5', {
      ...failedFixtureRecord,
      version: 2,
    });

    await expect(
      processE2ELogs(dir, { inputLog: apiLog, emitConsole: false }),
    ).rejects.toThrow();
  });

  it('rejects a fixture artifact path that escapes its directory', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeVitestRunRecord(dir, 1);
    writeTestLog(dir, 'aws-vm-host-loss', 'failed\n', 'vitest');
    writeFixtureRecord(dir, 'loses-its-host-a1b2c3d4e5', {
      ...failedFixtureRecord,
      workloads: [
        {
          id: 'vm-tracked-only',
          status: 'found',
          artifacts: ['../../../etc/passwd'],
        },
      ],
    });

    await expect(
      processE2ELogs(dir, { inputLog: apiLog, emitConsole: false }),
    ).rejects.toThrow('artifact must be a basename');
  });

  it('refuses to attribute fixture diagnostics to a Bash run', async () => {
    const { dir, apiLog } = makeFixtureDir();
    writeJoblog(dir, [{ name: 'aws-vm', exitCode: 1 }]);
    writeTestLog(dir, 'aws-vm', 'failed\n');
    writeFixtureRecord(dir, 'loses-its-host-a1b2c3d4e5', failedFixtureRecord);

    await expect(
      processE2ELogs(dir, { inputLog: apiLog, emitConsole: false }),
    ).rejects.toThrow('evidence cannot be attributed');
  });

  it('reports explicit recovered-test failures before earlier provider errors', async () => {
    const { dir, apiLog } = makeFixtureDir();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeApiLog(apiLog, [
      {
        timestamp: '2026-06-05T10:00:00.000Z',
        level: 'ERROR',
        message: 'State transition',
        id: 'bsync-test-azure',
        state: 'retrying',
        error: 'SkuNotAvailable in northcentralus',
      },
      {
        timestamp: '2026-06-05T10:01:00.000Z',
        level: 'INFO',
        message: 'State transition',
        id: 'bsync-test-azure',
        state: 'running',
      },
    ]);
    writeJoblog(dir, [{ name: 'azure-bucket-sync', exitCode: 1 }]);
    writeTestLog(
      dir,
      'azure-bucket-sync',
      [
        'Workload: bsync-test-azure',
        '✗ Pre-preemption: 2 molecules',
        '✗ Post-recovery:  1 molecules',
        '✗ Checkpoint data lost during recovery (regression)',
      ].join('\n'),
    );

    await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
      githubActions: true,
    });

    const annotation = logSpy.mock.calls
      .flat()
      .find((line) => String(line).startsWith('::error'));
    expect(String(annotation)).toContain(
      'Checkpoint data lost during recovery (regression)',
    );
    expect(String(annotation)).not.toContain('SkuNotAvailable');
  });

  it('reports checkpoint cleanup failures before related workload timeout noise', async () => {
    const { dir, apiLog } = makeFixtureDir();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeApiLog(apiLog, [
      {
        timestamp: '2026-06-05T10:00:00.000Z',
        level: 'INFO',
        message: 'State transition',
        id: 'bsync-test-gcp',
        state: 'completed',
      },
      {
        timestamp: '2026-06-05T10:01:00.000Z',
        level: 'ERROR',
        message: 'Error checking job completion',
        id: 'bsync-test-gcp',
        error: 'checkJobCompletion timed out',
      },
    ]);
    writeJoblog(dir, [{ name: 'gcp-bucket-sync', exitCode: 1 }]);
    writeTestLog(
      dir,
      'gcp-bucket-sync',
      [
        'Workload: bsync-test-gcp',
        '✓ All 10 molecules computed successfully (checkpoint)',
        '✗ Checkpoint bucket still exists (should have been auto-deleted)',
      ].join('\n'),
    );

    await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
      githubActions: true,
    });

    const annotation = logSpy.mock.calls
      .flat()
      .find((line) => String(line).startsWith('::error'));
    expect(String(annotation)).toContain(
      'Checkpoint bucket still exists (should have been auto-deleted)',
    );
    expect(String(annotation)).not.toContain('checkJobCompletion timed out');
    expect(readFileSync(join(dir, 'START_HERE.md'), 'utf8')).toContain(
      'checkJobCompletion timed out',
    );
  });

  it('writes a no-failure summary without GitHub error annotations on green runs', async () => {
    const { dir, apiLog } = makeFixtureDir();
    const summaryPath = join(dir, 'github-summary.md');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeApiLog(apiLog, workloadLines('green-workload', 'completed'));
    writeJoblog(dir, [{ name: 'aws-bucket-sync', exitCode: 0 }]);
    writeTestLog(dir, 'aws-bucket-sync', '✓ passed\n');

    await processE2ELogs(dir, {
      inputLog: apiLog,
      emitConsole: false,
      githubActions: true,
      githubStepSummary: summaryPath,
    });

    expect(readFileSync(join(dir, 'START_HERE.md'), 'utf8')).toContain(
      'No failed tests.',
    );
    expect(readFileSync(summaryPath, 'utf8')).toContain('No failed tests.');
    expect(
      logSpy.mock.calls
        .flat()
        .some((line) => String(line).startsWith('::error')),
    ).toBe(false);
  });
});
