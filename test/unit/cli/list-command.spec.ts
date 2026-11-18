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
import { CloudType, DiskTier } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';

const api = vi.hoisted(() => ({
  listWorkloads: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({ start: () => ({ stop: () => undefined }) }),
    printInfo: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    workloads: { list: api.listWorkloads },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(() => false),
  safePrompts: vi.fn(),
}));

import { createListCommand } from '../../../src/cli/commands/list.js';
import { printInfo, setJsonMode } from '../../../src/cli/utils/output.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import { makeStoredWorkload } from '../helpers/fixtures';

const listWorkloads = api.listWorkloads;

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
    diskSizeGb: null,
    diskTier: null,
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 1,
    sshPrivateKey: '',
    credentialId: 'cred-1',
    totalCost: null,
    state: WorkloadState.Running,
    sessionLabel: null,
    ...overrides,
  });
}

describe('createListCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  let errSpy: MockInstance<typeof console.error>;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    // Neutralize ambient agent markers so the default path is deterministic
    // regardless of whether the suite itself runs inside an agent.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CODEX_BIN_PATH', '');
    vi.stubEnv('CODEX_THREAD_ID', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('AIDER_MODEL', '');
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(safePrompts).mockReset();
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload()]);
    process.exitCode = undefined;
  });

  afterEach(() => {
    setJsonMode(false);
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalStdoutIsTTY,
    });
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function setStdoutIsTTY(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value,
    });
  }

  function setInteractive(): void {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    setStdoutIsTTY(true);
  }

  it.each([undefined, WorkloadType.Job])(
    'keeps filters and uses generic guidance for capped direct lists (type: %s)',
    async (type) => {
      listWorkloads.mockResolvedValue([
        makeWorkload({
          state: WorkloadState.Failed,
          session: 'session-a',
        }),
      ]);

      await createListCommand(type).parseAsync([
        'node',
        'test',
        '--status',
        'failed',
        '--session',
        'session-a',
        '-n',
        '1',
      ]);

      expect(listWorkloads).toHaveBeenCalledExactlyOnceWith({
        query: expect.objectContaining({
          workloadType: type,
          status: 'failed',
          session: 'session-a',
          limit: '1',
        }),
      });
      expect(printInfo).toHaveBeenCalledWith(
        'Showing the newest 1 — narrow with -p / --status / -f or raise with -n (max 1000).',
      );
      expect(printInfo).not.toHaveBeenCalledWith(
        expect.stringContaining('anycloud job list'),
      );
    },
  );

  it('-n is passed through raw — the server clamps, not the CLI', async () => {
    await createListCommand().parseAsync(['node', 'test', '-n', '999999']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ limit: '999999' }),
      }),
    );
  });

  it('-p sets a started-at window (sinceMs), no explicit limit', async () => {
    await createListCommand().parseAsync(['node', 'test', '-p', '7d']);
    expect(exitSpy).not.toHaveBeenCalled();
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.query.limit).toBeUndefined();
    expect(typeof call?.query.sinceMs).toBe('string');
  });

  it('fails fast on a non-positive -n before hitting the API', async () => {
    await expect(
      createListCommand().parseAsync(['node', 'test', '-n', '0']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(listWorkloads).not.toHaveBeenCalled();
  });

  it('auto-scopes to the caller session when an agent is detected', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'sess-auto');
    await createListCommand().parseAsync(['node', 'test']);
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.query.session).toBe('sess-auto');
    // Auto-derived session must match exactly (no fuzzy prefix leak).
    expect(call?.query.sessionExact).toBe('true');
  });

  it('explicit --session overrides the auto-scope (and is fuzzy)', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'sess-auto');
    await createListCommand().parseAsync([
      'node',
      'test',
      '--session',
      'other',
    ]);
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.query.session).toBe('other');
    expect(call?.query.sessionExact).toBeUndefined();
  });

  it('hints when the terminal-state result hits the limit cap (may be truncated)', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'a', state: WorkloadState.Completed }),
      makeWorkload({ id: 'b', state: WorkloadState.Completed }),
      makeWorkload({ id: 'c', state: WorkloadState.Completed }),
    ]);
    await createListCommand().parseAsync(['node', 'test', '-n', '3']);
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('newest 3'));
  });

  it('does not hint when the result is under the limit cap', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'a', state: WorkloadState.Completed }),
      makeWorkload({ id: 'b', state: WorkloadState.Completed }),
    ]);
    await createListCommand().parseAsync(['node', 'test', '-n', '3']);
    expect(printInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('newest'),
    );
  });

  it('renders a SESSION column when any row has a non-null session', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({
        id: 'tagged',
        agent: 'claude',
        session: 'claude-abcdefghij',
      }),
      makeWorkload({ id: 'untagged', agent: null, session: null }),
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('SESSION');
    // prettySession truncates long session ids to <agent>:<6-char>
    expect(stdout).toContain('claude:claude');
  });

  it('shows the session label (Claude title) instead of agent:hash', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({
        id: 'tagged',
        agent: 'claude',
        session: 'claude-abcdefghij',
        sessionLabel: 'Make sessions readable',
      }),
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('Make sessions readable');
    expect(stdout).not.toContain('claude:claude');
  });

  it('hides the SESSION column when no row has a session', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'plain-1', agent: null, session: null }),
      makeWorkload({ id: 'plain-2', agent: null, session: null }),
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).not.toContain('SESSION');
  });

  it('renders a USER column when the only returned workload belongs to another user', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      {
        ...makeWorkload({ id: 'teammate-only', userId: 'teammate' }),
        isOwnedByCaller: false,
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('USER');
    expect(stdout).toContain('teammate');
  });

  it('hides the USER column when the caller owns every returned workload', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      {
        ...makeWorkload({ id: 'mine-only', userId: 'test-user' }),
        isOwnedByCaller: true,
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).not.toContain('USER');
  });

  it('renders a DISK column when any row has a non-default disk tier', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'default-disk', diskTier: null }),
      makeWorkload({ id: 'standard-disk', diskTier: DiskTier.Medium }),
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('DISK');
    expect(stdout).toContain('medium');
    expect(stdout).toContain('default-disk');
    expect(stdout).toContain('standard-disk');
  });

  it('hides the DISK column when disk tier is default', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'default-disk', diskTier: null }),
      makeWorkload({ id: 'high-disk', diskTier: DiskTier.High }),
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).not.toContain('DISK');
  });

  it('renders a TYPE column and summarizes Jobs, Services, and VMs', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'job-1', workloadType: 'job' }),
      makeWorkload({ id: 'srv-1', workloadType: 'service' }),
      makeWorkload({ id: 'vm-1', workloadType: 'vm' }),
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('Summary (1 job, 1 service, 1 VM)');
    expect(stdout).toContain('TYPE');
    expect(stdout).toContain('job-1');
    expect(stdout).toContain('job');
    expect(stdout).toContain('srv-1');
    expect(stdout).toContain('service');
    expect(stdout).toContain('vm-1');
    expect(stdout).toContain('vm');
  });

  it('prompts bare human list with state and all choices; Enter defaults to all, a pick shows its state', async () => {
    setInteractive();
    vi.mocked(safePrompts).mockResolvedValue({
      view: WorkloadState.Completed,
    });
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({
        id: 'active-run',
        state: WorkloadState.Running,
      }),
      makeWorkload({ id: 'done-1', state: WorkloadState.Completed }),
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'select',
        name: 'view',
        message: 'Select view',
        initial: 2,
        choices: [
          { title: '⚡ running (1)', value: WorkloadState.Running },
          { title: '✅ completed (1)', value: WorkloadState.Completed },
          { title: '📋 all (2)', value: '__all__' },
        ],
      }),
    );
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('done-1');
    expect(stdout).not.toContain('active-run');
  });

  it('"by session" view opens a session sub-picker and filters to the pick', async () => {
    setInteractive();
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__sessions__' })
      .mockResolvedValueOnce({ session: 'sess-1' });
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({
        id: 'a-sess1',
        state: WorkloadState.Running,
        session: 'sess-1',
        agent: 'claude',
      }),
      makeWorkload({
        id: 'b-sess2',
        state: WorkloadState.Running,
        session: 'sess-2',
        agent: 'claude',
      }),
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    // Second prompt is the session autocomplete.
    expect(vi.mocked(safePrompts).mock.calls[1]?.[0]).toMatchObject({
      type: 'autocomplete',
      name: 'session',
    });
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('a-sess1');
    expect(stdout).not.toContain('b-sess2');
    expect(printInfo).toHaveBeenCalledWith('1 workload(s)');
  });

  it('returns cleanly without rendering a table when the human list picker is cancelled', async () => {
    setInteractive();
    vi.mocked(safePrompts).mockResolvedValue({ view: undefined });

    await createListCommand().parseAsync(['node', 'test']);

    expect(exitSpy).not.toHaveBeenCalled();
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('Summary');
    expect(stdout).not.toContain('ID');
    expect(stdout).not.toContain('dep-1');
  });

  it('does not prompt when stdout is redirected even if stdin can prompt', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    setStdoutIsTTY(false);

    await createListCommand().parseAsync(['node', 'test']);

    expect(safePrompts).not.toHaveBeenCalled();
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdout).toContain('dep-1');
  });

  it('--json prints the workloads as a JSON array', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      { ...makeWorkload({ id: 'a' }), isOwnedByCaller: true },
      {
        ...makeWorkload({ id: 'b', workloadType: 'service' }),
        isOwnedByCaller: false,
      },
    ]);
    await createListCommand().parseAsync(['node', 'test', '--json']);
    expect(exitSpy).not.toHaveBeenCalled();
    const stdoutCalls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutCalls).toHaveLength(1);
    expect(stdoutCalls[0]).not.toMatch(/\n {2}/);
    const parsed = JSON.parse(stdoutCalls[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((d: { id: string }) => d.id)).toEqual(['a', 'b']);
    expect(parsed[1].workloadType).toBe('service');
    expect(parsed[0]).not.toHaveProperty('isOwnedByCaller');
    expect(parsed[1]).not.toHaveProperty('isOwnedByCaller');
  });

  it('--filter forwards to the server; empty result short-circuits with a message', async () => {
    // Server applies the substring filter and returns the (empty) match set.
    vi.mocked(listWorkloads).mockResolvedValue([]);
    await createListCommand().parseAsync(['node', 'test', '-f', 'nomatch']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ filter: 'nomatch' }),
      }),
    );
    expect(printInfo).toHaveBeenCalledWith('No workloads matching "nomatch".');
  });

  it('--help mentions all the flags users need to discover', () => {
    const buf: string[] = [];
    const cmd = createListCommand().configureOutput({
      writeOut: (s) => buf.push(s),
    });
    cmd.outputHelp();
    const help = buf.join('');
    expect(help).toContain('-f, --filter');
    expect(help).toContain('-p, --period');
    expect(help).toContain('-n, --limit');
    expect(help).toContain('--type');
    expect(help).toContain('--credentials');
    expect(help).toContain('--json');
    expect(help).toMatch(/list\|ls/); // commander shows alias in usage line
  });

  it.each([['--all'], ['--provider', 'aws'], ['--cloud', 'aws']])(
    'rejects removed option %s',
    async (...args) => {
      const cmd = createListCommand()
        .exitOverride()
        .configureOutput({ writeErr: () => undefined });
      await expect(cmd.parseAsync(['node', 'test', ...args])).rejects.toThrow(
        /unknown option/i,
      );
      expect(listWorkloads).not.toHaveBeenCalled();
    },
  );

  it('--csv emits a header row followed by one row per workload', async () => {
    const started = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({
        id: 'dep-1',
        image: 'nginx:alpine',
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.micro',
        state: WorkloadState.Running,
        spot: false,
        startedAt: started,
        completedAt: null,
        totalCost: null,
      }),
      makeWorkload({
        id: 'dep-2',
        workloadType: 'service',
        // Comma + quote → must be CSV-escaped
        image: 'ghcr.io/org/app:"v1,beta"',
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'n1-standard-1',
        state: WorkloadState.Completed,
        spot: true,
        startedAt: started,
        completedAt: started + 60_000,
        totalCost: 0.42,
      }),
    ]);
    await createListCommand().parseAsync(['node', 'test', '--csv']);
    expect(exitSpy).not.toHaveBeenCalled();
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    const lines = stdout.split('\n');
    expect(lines[0]).toBe(
      'id,user,state,cloudProvider,region,vmType,image,spot,startedAt,completedAt,totalCost,workloadType',
    );
    expect(lines[1]).toBe(
      `dep-1,user,running,${CloudType.AWS},us-east-1,t3.micro,nginx:alpine,false,${new Date(started).toISOString()},,,job`,
    );
    expect(lines[2]).toBe(
      `dep-2,user,completed,${CloudType.GCP},us-central1,n1-standard-1,"ghcr.io/org/app:""v1,beta""",true,${new Date(started).toISOString()},${new Date(started + 60_000).toISOString()},0.42,service`,
    );
  });

  it('--only-ids emits one id per line and skips the table chrome', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'a' }),
      makeWorkload({ id: 'b' }),
    ]);
    await createListCommand().parseAsync(['node', 'test', '--only-ids']);
    expect(exitSpy).not.toHaveBeenCalled();
    const stdoutLines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutLines).toEqual(['a', 'b']);
  });

  it('--filter + --json forwards the filter and emits the server result', async () => {
    // --json suppresses the human "no match" message; the server-filtered
    // (empty) array is emitted instead.
    vi.mocked(listWorkloads).mockResolvedValue([]);
    await createListCommand().parseAsync([
      'node',
      'test',
      '-f',
      'nomatch',
      '--json',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ filter: 'nomatch' }),
      }),
    );
    const stdoutCalls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutCalls).toHaveLength(1);
    expect(JSON.parse(stdoutCalls[0])).toEqual([]);
  });
});
