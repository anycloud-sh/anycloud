import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { type StoredWorkload } from '../../../src/api/services/workload-record.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { ContainerState, ServiceState } from '../../../src/shared/runtime.js';

const api = vi.hoisted(() => ({
  listWorkloads: vi.fn(),
  getWorkloadStatus: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({ start: () => ({ stop: () => undefined }) }),
    printWorkloadHeader: vi.fn(),
    printInfo: vi.fn(),
    printError: vi.fn(),
  };
});
vi.mock('../../../src/cli/utils/workload-picker.js', () => ({
  selectWorkload: vi.fn(),
  selectWorkloads: vi.fn(),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: (
    _accessToken: string,
    options: { requestTimeoutMs?: number } = {},
  ) => ({
    workloads: {
      list: api.listWorkloads,
      status: (input: unknown, callOptions?: { signal?: AbortSignal }) =>
        callOptions?.signal
          ? api.getWorkloadStatus(input, options.requestTimeoutMs, callOptions)
          : api.getWorkloadStatus(input, options.requestTimeoutMs),
    },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

import { createStatusCommand } from '../../../src/cli/commands/status.js';
import {
  printError,
  printWorkloadHeader,
  setJsonMode,
} from '../../../src/cli/utils/output.js';
import { selectWorkload } from '../../../src/cli/utils/workload-picker.js';
import { makeStoredWorkload } from '../helpers/fixtures';

const listWorkloads = api.listWorkloads;
const getWorkloadStatus = api.getWorkloadStatus;

function makeWorkload(overrides: Partial<StoredWorkload> = {}): StoredWorkload {
  return makeStoredWorkload({
    id: 'dep-1',
    userId: 'user',
    workloadType: 'job',
    image: 'nginx:alpine',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.micro',
    gpuType: null,
    spot: false,
    startedAt: Date.now(),
    completedAt: null,
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: null,
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 1,
    sshPrivateKey: '',
    credentialId: 'cred-1',
    totalCost: null,
    state: WorkloadState.Running,
    ...overrides,
  });
}

const okStatus = {
  events: [],
  status: 'up' as const,
  vms: [],
  workload: makeWorkload(),
};

function upgradedServiceHistory() {
  return [
    {
      id: 1,
      workloadId: 'dep-1',
      state: WorkloadState.Running,
      metadata: null,
      createdAt: 1,
    },
    {
      id: 2,
      workloadId: 'dep-1',
      state: WorkloadState.Recovering,
      metadata: {
        reason: 'serve-upgrade',
        previousImage: 'app:v1',
        image: 'app:v2',
      },
      createdAt: 2,
    },
    {
      id: 3,
      workloadId: 'dep-1',
      state: WorkloadState.Recovering,
      metadata: {
        reason: 'serve-upgrade',
        previousImage: 'app:v2',
        image: 'app:v3',
      },
      createdAt: 3,
    },
  ];
}

describe('createStatusCommand', () => {
  const savedEnv = process.env.ANYCLOUD_WORKLOAD_ID;
  const savedExitCode = process.exitCode;
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    delete process.env.ANYCLOUD_WORKLOAD_ID;
    process.exitCode = undefined;
    vi.clearAllMocks();
    setJsonMode(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getWorkloadStatus).mockResolvedValue(okStatus);
    vi.mocked(listWorkloads).mockResolvedValue([]);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANYCLOUD_WORKLOAD_ID;
    else process.env.ANYCLOUD_WORKLOAD_ID = savedEnv;
    process.exitCode = savedExitCode;
    setJsonMode(false);
    vi.useRealTimers();
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('passes the explicit id arg to getWorkloadStatus', async () => {
    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);
    expect(getWorkloadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: 'dep-1' },
        query: { verbose: undefined },
      }),
      undefined, // not verbose
    );
    expect(selectWorkload).not.toHaveBeenCalled();
  });

  it('renders a truncated history like a complete one, plus a hidden-events hint', async () => {
    const events = upgradedServiceHistory().slice(-2);
    const render = async (eventsTotal?: number) => {
      logSpy.mockClear();
      vi.mocked(getWorkloadStatus).mockResolvedValue({
        ...okStatus,
        events,
        eventsTotal,
      });
      await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);
      return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    };
    const complete = await render();
    expect(await render(events.length)).toBe(complete);
    expect(await render(events.length + 41)).toBe(
      `${complete}\n\n41 earlier events hidden. Run with --history to show all.`,
    );
  });

  it('does not invent upgrade numbers or version counts from a partial Service history', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      workload: makeWorkload({ workloadType: 'service' }),
      events: upgradedServiceHistory().slice(-2),
      eventsTotal: 43,
    });
    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Upgrade · app:v2 → app:v3');
    expect(output).not.toMatch(/Upgrade \d/u);
    expect(output).not.toContain('earlier workload version');
    expect(output).toContain('41 earlier events hidden');
  });

  it('uses 20s timeout when --verbose', async () => {
    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);
    expect(getWorkloadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: 'dep-1' },
        query: { verbose: 'true' },
      }),
      20_000,
    );
  });

  it('-p routes the picker fetch through a started-at window (no explicit limit)', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload()]);
    vi.mocked(selectWorkload).mockResolvedValue(makeWorkload());
    await createStatusCommand().parseAsync(['node', 'test', '-p', '7d']);
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.query.limit).toBeUndefined();
    expect(typeof call?.query.sinceMs).toBe('string');
  });

  it('-n routes the picker fetch through an explicit limit', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload()]);
    vi.mocked(selectWorkload).mockResolvedValue(makeWorkload());
    await createStatusCommand().parseAsync(['node', 'test', '-n', '500']);
    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ limit: '500' }),
      }),
    );
  });

  it('default picker fetch sends no explicit limit (the server picks)', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload()]);
    vi.mocked(selectWorkload).mockResolvedValue(makeWorkload());
    await createStatusCommand().parseAsync(['node', 'test']);
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.query.limit).toBeUndefined();
  });

  it('renders the header from the workload in the status response', async () => {
    const dep = makeWorkload({
      id: 'dep-1',
      state: WorkloadState.Retrying,
    });
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      workload: dep,
    });
    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);
    expect(printWorkloadHeader).toHaveBeenCalledWith(dep, expect.anything());
  });

  it('renders compact unhealthy container details without logs by default', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Exited,
            exitCode: 1,
            logs: 'Container logs:\nError: missing DATABASE_URL',
          },
        },
      ],
    });

    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ container    exited [exit: 1]');
    expect(output).toContain('Run with --verbose for container logs.');
    expect(output).not.toContain('missing DATABASE_URL');
  });

  it('renders OOM in compact unhealthy container details', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Exited,
            exitCode: 137,
            oomKilled: true,
          },
        },
      ],
    });

    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ container    exited [exit: 137, OOM]');
    expect(output).not.toContain('Run with --verbose for container logs.');
  });

  it('renders unhealthy container logs in verbose mode', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Exited,
            exitCode: 1,
            logs: 'Container logs:\nError: missing DATABASE_URL',
          },
        },
      ],
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ container    exited [exit: 1]');
    expect(output).toContain('│ Container logs:');
    expect(output).toContain('│ Error: missing DATABASE_URL');
    expect(output).not.toContain('Run with --verbose for container logs.');
  });

  it('renders compact rclone diagnostics without logs by default', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      workload: makeWorkload({ outputBucket: 'results-bucket' }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            output: {
              status: ServiceState.Stopped,
              logs: 'rclone: Failed to upload results.json',
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ output-sync  stopped');
    expect(output).toContain('Run with --verbose for output-sync logs.');
    expect(output).not.toContain('Failed to upload');
  });

  it('renders rclone diagnostics in verbose mode', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      workload: makeWorkload({ outputBucket: 'results-bucket' }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            output: {
              status: ServiceState.Running,
              logs: [
                'Transferred: 0 B',
                'ERROR : results.json: Failed to copy: permission denied',
              ].join('\n'),
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ output-sync  running (errors)');
    expect(output).toContain('│ Transferred: 0 B');
    expect(output).toContain(
      '│ ERROR : results.json: Failed to copy: permission denied',
    );
    expect(output).not.toContain('Run with --verbose for output-sync logs.');
  });

  it('does not report an active rclone service as errored for an ignored systemd cleanup warning', async () => {
    // Old VMs can still serve journalctl content (log-file fallback), whose
    // lifecycle lines contain "Failed …" without any transfer failing.
    const warning =
      'Jul 10 23:26:13 vm-1 systemd[1]: rclone-output.service: Failed to kill control group /system.slice/rclone-output.service, ignoring: Invalid argument';
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      workload: makeWorkload({ outputBucket: 'results-bucket' }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            output: {
              status: ServiceState.Running,
              logs: warning,
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✓ output-sync  running');
    expect(output).not.toContain('running (errors)');
    expect(output).not.toContain('Failed to kill control group');
  });

  it('labels a crashed sync service as failed rather than stopped', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      workload: makeWorkload({ outputBucket: 'results-bucket' }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            output: {
              status: ServiceState.Fatal,
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ output-sync  failed');
  });

  it('caps verbose rclone diagnostics when no error line is detected', async () => {
    const logs = Array.from(
      { length: 130 },
      (_, index) => `line ${index}`,
    ).join('\n');
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      workload: makeWorkload({ outputBucket: 'results-bucket' }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            output: {
              status: ServiceState.Stopped,
              logs,
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ output-sync  stopped');
    expect(output).not.toContain('│ line 0');
    expect(output).toContain('│ line 129');
  });

  it('renders compact checkpoint-sync diagnostics without logs by default', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      workload: makeWorkload({ spot: true }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            checkpoint: {
              status: ServiceState.Stopped,
              logs: 'rclone: Failed to sync checkpoint.tar',
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ checkpoint-sync  stopped');
    expect(output).toContain('Run with --verbose for checkpoint-sync logs.');
    expect(output).not.toContain('Failed to sync');
  });

  it('renders checkpoint-sync diagnostics in verbose mode', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      workload: makeWorkload({ spot: true }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            checkpoint: {
              status: ServiceState.Running,
              logs: [
                'Transferred: 0 B',
                'ERROR : checkpoint.tar: Failed to copy: permission denied',
              ].join('\n'),
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ checkpoint-sync  running (errors)');
    expect(output).toContain('│ Transferred: 0 B');
    expect(output).toContain(
      '│ ERROR : checkpoint.tar: Failed to copy: permission denied',
    );
    expect(output).not.toContain(
      'Run with --verbose for checkpoint-sync logs.',
    );
  });

  it('detects running rclone errors before the displayed log tail', async () => {
    const logs = [
      'ERROR : results.json: Failed to copy: permission denied',
      ...Array.from({ length: 130 }, (_, index) => `line ${index}`),
    ].join('\n');
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      status: 'down',
      workload: makeWorkload({ outputBucket: 'results-bucket' }),
      vms: [
        {
          ip: '1.2.3.4',
          endedAt: null,
          container: {
            state: ContainerState.Running,
          },
          rclone: {
            output: {
              status: ServiceState.Running,
              logs,
            },
          },
        },
      ],
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--verbose',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('✗ output-sync  running (errors)');
    expect(output).not.toContain('Failed to copy');
    expect(output).toContain('│ line 129');
  });

  it('does not fetch listWorkloads when an explicit id is passed', async () => {
    await createStatusCommand().parseAsync(['node', 'test', 'dep-1']);
    expect(listWorkloads).not.toHaveBeenCalled();
  });

  it('--json preserves an upgraded Service event history as a flat array', async () => {
    const events = upgradedServiceHistory();
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      workload: makeWorkload({ workloadType: 'service' }),
      events,
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--json',
      '--history',
    ]);
    const stdoutCalls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutCalls).toHaveLength(1);
    const payload = JSON.parse(stdoutCalls[0]) as Record<string, unknown>;
    expect(payload.events).toEqual(events);
    expect(payload).not.toHaveProperty('eventSections');
  });

  it('--history renders every upgraded Service section', async () => {
    vi.mocked(getWorkloadStatus).mockResolvedValue({
      ...okStatus,
      workload: makeWorkload({ workloadType: 'service' }),
      events: upgradedServiceHistory(),
    });

    await createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--history',
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Initial workload · app:v1');
    expect(output).toContain('Upgrade 1 · app:v1 → app:v2');
    expect(output).toContain('Upgrade 2 · app:v2 → app:v3');
    expect(output).not.toContain('earlier workload versions hidden');
  });

  it('--watch preserves the full Service view with --history', async () => {
    vi.useFakeTimers();
    vi.mocked(getWorkloadStatus)
      .mockResolvedValueOnce({
        ...okStatus,
        workload: makeWorkload({
          workloadType: 'service',
          state: WorkloadState.Running,
        }),
        events: upgradedServiceHistory(),
      })
      .mockResolvedValueOnce({
        ...okStatus,
        workload: makeWorkload({
          workloadType: 'service',
          state: WorkloadState.Completed,
        }),
        events: upgradedServiceHistory(),
      });

    const run = createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--watch',
      '--history',
      '--interval',
      '1',
    ]);

    await vi.waitFor(() => expect(getWorkloadStatus).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    const historyRenders = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes('Initial workload · app:v1'),
    );
    expect(historyRenders).toHaveLength(2);
  });

  it('--watch --json emits one JSON object per poll', async () => {
    vi.useFakeTimers();
    vi.mocked(getWorkloadStatus)
      .mockResolvedValueOnce({
        ...okStatus,
        workload: makeWorkload({ state: WorkloadState.Running }),
      })
      .mockResolvedValueOnce({
        ...okStatus,
        workload: makeWorkload({ state: WorkloadState.Completed }),
      });

    const run = createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--watch',
      '--json',
      '--interval',
      '1',
    ]);

    await vi.waitFor(() => expect(getWorkloadStatus).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    const stdoutCalls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutCalls).toHaveLength(2);
    expect(stdoutCalls.map((line) => JSON.parse(line).workload.state)).toEqual([
      WorkloadState.Running,
      WorkloadState.Completed,
    ]);
  });

  it('--watch treats SIGINT as cancellation without reporting the API down', async () => {
    vi.useFakeTimers();
    vi.mocked(getWorkloadStatus)
      .mockResolvedValueOnce({
        ...okStatus,
        workload: makeWorkload({ state: WorkloadState.Running }),
      })
      .mockImplementationOnce(
        (_request, _timeout, options?: { signal?: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new Error('No local API is running')),
              { once: true },
            );
          }),
      );

    const run = createStatusCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--watch',
      '--interval',
      '1',
    ]);

    await vi.waitFor(() => expect(getWorkloadStatus).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(getWorkloadStatus).toHaveBeenCalledTimes(2));

    process.emit('SIGINT', 'SIGINT');
    await run;

    expect(process.exitCode).toBe(130);
    expect(printError).not.toHaveBeenCalledWith(
      expect.stringContaining('No local API is running'),
    );
    expect(printError).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch status'),
    );
  });

  it('--interval rejects values below one second', async () => {
    await expect(
      createStatusCommand().parseAsync([
        'node',
        'test',
        'dep-1',
        '--watch',
        '--interval',
        '0',
      ]),
    ).rejects.toThrow('process.exit:1');
    expect(getWorkloadStatus).not.toHaveBeenCalled();
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('--interval must be a number >= 1'),
    );
  });

  it('--json with no id refuses to run the picker (would corrupt JSON pipe)', async () => {
    await expect(
      createStatusCommand().parseAsync(['node', 'test', '--json']),
    ).rejects.toThrow('process.exit:1');
    expect(selectWorkload).not.toHaveBeenCalled();
    // exitWithError → printError → console.error inside output.js bypasses
    // the printError mock, so check the underlying console.error stream.
    const errMessages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(
      errMessages.some((m) => /Workload ID required with --json/.test(m)),
    ).toBe(true);
  });

  it('reads ANYCLOUD_WORKLOAD_ID env var when no id arg', async () => {
    process.env.ANYCLOUD_WORKLOAD_ID = 'env-id';
    await createStatusCommand().parseAsync(['node', 'test']);
    expect(getWorkloadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: 'env-id' },
        query: { verbose: undefined },
      }),
      undefined,
    );
    expect(selectWorkload).not.toHaveBeenCalled();
  });

  it('--help mentions the picker, watch, the window flags, --json, and non-interactive env vars', () => {
    // Capture the full help text including addHelpText('after', ...) blocks.
    // helpInformation() omits those; outputHelp() emits them via events.
    const buf: string[] = [];
    const cmd = createStatusCommand().configureOutput({
      writeOut: (s) => buf.push(s),
    });
    cmd.outputHelp();
    const help = buf.join('');
    // Picker discoverability — these were silently lost in an earlier change
    expect(help).toContain('omit for interactive picker');
    expect(help).toContain('TTY picker'); // example with no id
    expect(help).toContain('-p, --period');
    expect(help).toContain('-n, --limit');
    // Non-interactive mode block (env-driven CI usage)
    expect(help).toContain('Non-interactive mode');
    expect(help).toContain('ANYCLOUD_WORKLOAD_ID');
    // Flags
    expect(help).toContain('--json');
    expect(help).toContain('--verbose');
    expect(help).toContain('--history');
    expect(help).toContain('--watch');
    expect(help).toContain('--interval');
  });
});
