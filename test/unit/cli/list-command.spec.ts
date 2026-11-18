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
  getNodePool: vi.fn(),
  getDeployment: vi.fn(),
  listNodePools: vi.fn(),
  listWorkloads: vi.fn(),
  listDeployments: vi.fn(),
}));

const sharedUtils = vi.hoisted(() => ({
  sleep: vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(),
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
    nodePools: { get: api.getNodePool, list: api.listNodePools },
    workloads: { list: api.listWorkloads },
    deployments: { get: api.getDeployment, list: api.listDeployments },
  }),
}));

vi.mock('../../../src/shared/utils.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/shared/utils.js')>();
  return { ...actual, sleep: sharedUtils.sleep };
});

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
import {
  printError,
  printInfo,
  setJsonMode,
} from '../../../src/cli/utils/output.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import {
  makeDeploymentSummary,
  makeNodePoolSummary,
  makeStoredWorkload,
} from '../helpers/fixtures';

const listWorkloads = api.listWorkloads;

const nodePool = makeNodePoolSummary();
const deployment = makeDeploymentSummary();

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
  const originalStdoutRows = process.stdout.rows;
  const originalStdoutColumns = process.stdout.columns;
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
    sharedUtils.sleep.mockResolvedValue(undefined);
    api.listNodePools.mockResolvedValue({ nodePools: [] });
    api.listDeployments.mockResolvedValue({ deployments: [] });
    api.getNodePool.mockResolvedValue({ nodePool });
    api.getDeployment.mockResolvedValue({ deployment });
    process.exitCode = undefined;
  });

  afterEach(() => {
    setJsonMode(false);
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalStdoutIsTTY,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: originalStdoutRows,
    });
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: originalStdoutColumns,
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

  it('0036/S19 renders mixed rows with Deployment identity and a blank Deployment-Job CSV image', async () => {
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'vm-job' }),
      {
        ...makeWorkload({ id: 'deployment-job' }),
        deploymentId: 'deployment-model',
        image: null,
        cloudProvider: null,
        region: null,
        vmType: null,
        vmCount: 0,
      },
    ]);
    await createListCommand().parseAsync(['node', 'test']);
    const humanOutput = logSpy.mock.calls
      .map(([line]) => String(line))
      .join('\n');
    expect(humanOutput).toContain('IMAGE / DEPLOYMENT');
    expect(humanOutput).toContain('Deployment deployment-model');
    expect(humanOutput).toContain('nginx:alpine');

    logSpy.mockClear();
    await createListCommand().parseAsync(['node', 'test', '--csv']);
    const csv = String(logSpy.mock.calls[0]?.[0]);
    const rows = csv.split('\n').map((line) => line.split(','));
    expect(rows[1][6]).toBe('nginx:alpine');
    expect(rows[2][0]).toBe('deployment-job');
    expect(rows[2][6]).toBe('');
    expect(csv).not.toContain('deployment-model');
  });

  it('--deployment keeps exact Deployment scope with a larger limit and skips all pickers', async () => {
    setInteractive();
    await createListCommand().parseAsync([
      'node',
      'test',
      '--deployment',
      deployment.id,
      '-n',
      '400',
    ]);
    expect(listWorkloads).toHaveBeenCalledWith({
      query: expect.objectContaining({
        deploymentId: deployment.id,
        limit: '400',
      }),
    });
    expect(safePrompts).not.toHaveBeenCalled();
    expect(api.listNodePools).not.toHaveBeenCalled();
    expect(api.listDeployments).not.toHaveBeenCalled();
    expect(api.getDeployment).not.toHaveBeenCalled();
  });

  it.each([undefined, WorkloadType.Job])(
    'keeps filters and uses generic guidance for capped direct lists (type: %s)',
    async (type) => {
      listWorkloads.mockResolvedValue([
        makeWorkload({
          deploymentId: deployment.id,
          state: WorkloadState.Failed,
          session: 'session-a',
        }),
      ]);

      await createListCommand(type).parseAsync([
        'node',
        'test',
        '--deployment',
        deployment.id,
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
          deploymentId: deployment.id,
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

  it('rejects a Deployment filter on Service or VM workloads before fetching', async () => {
    await expect(
      createListCommand().parseAsync([
        'node',
        'test',
        '--deployment',
        deployment.id,
        '--type',
        'service',
      ]),
    ).rejects.toThrow('process.exit:1');
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('--deployment only supports Jobs'),
    );
    expect(listWorkloads).not.toHaveBeenCalled();
  });

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
        initial: 3,
        choices: [
          { title: '☸️ by node pool', value: '__node_pools__' },
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

  it('lists ordinary workloads without requesting an unavailable node pool inventory', async () => {
    setInteractive();
    api.listNodePools.mockRejectedValue(
      new Error('Node pool status timed out'),
    );
    vi.mocked(safePrompts).mockResolvedValue({ view: '__all__' });

    await createListCommand().parseAsync(['node', 'test']);

    expect(api.listNodePools).not.toHaveBeenCalled();
    expect(api.listDeployments).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('dep-1');
    expect(exitSpy).not.toHaveBeenCalled();
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

  it('drills from the list view through node pool and Deployment pickers into exact Deployment Jobs', async () => {
    setInteractive();
    api.listNodePools.mockImplementation(async () => {
      expect(safePrompts).toHaveBeenCalledTimes(1);
      return { nodePools: [nodePool] };
    });
    api.listDeployments.mockResolvedValue({ deployments: [deployment] });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__node_pools__' })
      .mockResolvedValueOnce({ nodePool: nodePool.id })
      .mockResolvedValueOnce({ deployment: deployment.id });
    const deploymentJob = {
      ...makeWorkload({
        id: 'deployment-job',
        deploymentId: deployment.id,
        image: null,
        cloudProvider: null,
        region: null,
        vmType: null,
        gpuType: null,
        vmCount: 0,
      }),
    };
    vi.mocked(listWorkloads)
      .mockResolvedValueOnce([makeWorkload({ id: 'ordinary-job' })])
      .mockResolvedValueOnce([deploymentJob]);

    await createListCommand().parseAsync(['node', 'test']);

    expect(vi.mocked(safePrompts).mock.calls[0]?.[0]).toMatchObject({
      name: 'view',
      choices: expect.arrayContaining([
        { title: '☸️ by node pool', value: '__node_pools__' },
      ]),
    });
    expect(vi.mocked(safePrompts).mock.calls[1]?.[0]).toMatchObject({
      type: 'autocomplete',
      name: 'nodePool',
      message: 'Select node pool',
      choices: [
        {
          title: 'training  node-pool-a  running  1/1 ready',
          value: nodePool.id,
        },
      ],
    });
    expect(vi.mocked(safePrompts).mock.calls[2]?.[0]).toMatchObject({
      type: 'autocomplete',
      name: 'deployment',
      message: 'Select Deployment',
      choices: [
        {
          title:
            'model-deployment  deployment-a  example/model-deployment:latest  ' +
            'Jobs: 1/4, 1 queued',
          value: deployment.id,
        },
      ],
    });
    expect(api.listDeployments).toHaveBeenCalledWith({
      query: { nodePool: nodePool.id },
    });
    expect(listWorkloads).toHaveBeenNthCalledWith(
      2,
      { query: { deploymentId: deployment.id } },
      { signal: undefined },
    );
    expect(api.getNodePool).toHaveBeenCalledWith(
      { params: { id: nodePool.id } },
      { signal: undefined },
    );
    expect(api.getDeployment).toHaveBeenCalledWith(
      { params: { id: deployment.id } },
      { signal: undefined },
    );
    const stdout = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(stdout).toContain('Node pool training');
    expect(stdout).toContain('Deployment model-deployment');
    expect(stdout).toMatch(/Revision\s+1/u);
    expect(stdout).toContain('deployment-job');
    expect(stdout).not.toContain('ordinary-job');
  });

  it('can enter the node pool picker when there are node pools but no ordinary workloads', async () => {
    setInteractive();
    api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
    api.listDeployments.mockResolvedValue({ deployments: [deployment] });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__node_pools__' })
      .mockResolvedValueOnce({ nodePool: nodePool.id })
      .mockResolvedValueOnce({ deployment: deployment.id });
    vi.mocked(listWorkloads).mockResolvedValue([]);

    await createListCommand().parseAsync(['node', 'test']);

    expect(safePrompts).toHaveBeenCalledTimes(3);
    expect(printInfo).toHaveBeenCalledWith(
      `No Jobs found for Deployment ${deployment.name}.`,
    );
  });

  it('offers a runnable larger-history command that retains the picked Deployment', async () => {
    setInteractive();
    api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
    api.listDeployments.mockResolvedValue({ deployments: [deployment] });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__node_pools__' })
      .mockResolvedValueOnce({ nodePool: nodePool.id })
      .mockResolvedValueOnce({ deployment: deployment.id });
    const history = Array.from({ length: 200 }, (_, index) =>
      makeWorkload({
        id: `deployment-job-${index}`,
        deploymentId: deployment.id,
      }),
    );
    listWorkloads.mockResolvedValueOnce([]).mockResolvedValueOnce(history);

    await createListCommand().parseAsync(['node', 'test']);

    expect(printInfo).toHaveBeenCalledWith(
      'Showing the newest 200 Jobs. List more with: anycloud job list --deployment deployment-a -n 400',
    );
    listWorkloads.mockClear();
    await createListCommand(WorkloadType.Job).parseAsync([
      'node',
      'test',
      '--deployment',
      deployment.id,
      '-n',
      '400',
    ]);
    expect(listWorkloads).toHaveBeenCalledWith({
      query: expect.objectContaining({
        workloadType: 'job',
        deploymentId: deployment.id,
        limit: '400',
      }),
    });
  });

  it('reports an empty node pool inventory after selecting the node pool view with no workloads', async () => {
    setInteractive();
    vi.mocked(listWorkloads).mockResolvedValue([]);
    vi.mocked(safePrompts).mockResolvedValue({ view: '__node_pools__' });

    await createListCommand().parseAsync(['node', 'test']);

    expect(safePrompts).toHaveBeenCalledTimes(1);
    expect(api.listNodePools).toHaveBeenCalledTimes(1);
    expect(api.listDeployments).not.toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith('No node pools found.');
  });

  it('reports a node pool inventory failure only after the node pool view is selected', async () => {
    setInteractive();
    vi.mocked(safePrompts).mockResolvedValue({ view: '__node_pools__' });
    api.listNodePools.mockImplementation(async () => {
      expect(safePrompts).toHaveBeenCalledTimes(1);
      throw new Error('Node pool status timed out');
    });

    await expect(
      createListCommand().parseAsync(['node', 'test']),
    ).rejects.toThrow('process.exit:1');

    expect(printError).toHaveBeenCalledWith(
      'Failed to list workloads: Node pool status timed out',
    );
    expect(api.listDeployments).not.toHaveBeenCalled();
  });

  it('reports a selected node pool with no Deployments and stops before loading Jobs', async () => {
    setInteractive();
    api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
    api.listDeployments.mockResolvedValue({ deployments: [] });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__node_pools__' })
      .mockResolvedValueOnce({ nodePool: nodePool.id });

    await createListCommand().parseAsync(['node', 'test']);

    expect(printInfo).toHaveBeenCalledWith(
      `No Deployments found on node pool ${nodePool.name}.`,
    );
    expect(listWorkloads).toHaveBeenCalledTimes(1);
  });

  it('reports an empty node pool picker and exits cleanly in watch mode', async () => {
    setInteractive();

    await createListCommand().parseAsync(['node', 'test', '--watch']);

    expect(printInfo).toHaveBeenCalledWith('No node pools found.');
    expect(safePrompts).not.toHaveBeenCalled();
    expect(api.listDeployments).not.toHaveBeenCalled();
    expect(listWorkloads).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits cleanly when the node pool picker is cancelled', async () => {
    setInteractive();
    api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__node_pools__' })
      .mockResolvedValueOnce({ nodePool: undefined });

    await createListCommand().parseAsync(['node', 'test']);

    expect(api.listDeployments).not.toHaveBeenCalled();
    expect(api.getNodePool).not.toHaveBeenCalled();
    expect(listWorkloads).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits cleanly when the Deployment picker is cancelled', async () => {
    setInteractive();
    api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
    api.listDeployments.mockResolvedValue({ deployments: [deployment] });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ view: '__node_pools__' })
      .mockResolvedValueOnce({ nodePool: nodePool.id })
      .mockResolvedValueOnce({ deployment: undefined });

    await createListCommand().parseAsync(['node', 'test']);

    expect(api.getNodePool).not.toHaveBeenCalled();
    expect(api.getDeployment).not.toHaveBeenCalled();
    expect(listWorkloads).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, WorkloadType.Job])(
    'refreshes the selected Deployment every five seconds and exits on Ctrl-C (type: %s)',
    async (type) => {
      setInteractive();
      api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
      api.listDeployments.mockResolvedValue({ deployments: [deployment] });
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ nodePool: nodePool.id })
        .mockResolvedValueOnce({ deployment: deployment.id });
      let refreshes = 0;
      vi.mocked(listWorkloads).mockImplementation(async () => {
        refreshes += 1;
        if (refreshes === 2) {
          queueMicrotask(() => process.emit('SIGINT', 'SIGINT'));
        }
        return [
          makeWorkload({
            id: `watched-job-${refreshes}`,
            deploymentId: deployment.id,
            image: null,
            cloudProvider: null,
            region: null,
            vmType: null,
            gpuType: null,
            vmCount: 0,
          }),
        ];
      });
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        await createListCommand(type).parseAsync(['node', 'test', '--watch']);
      } finally {
        writeSpy.mockRestore();
      }

      expect(safePrompts).toHaveBeenCalledTimes(2);
      expect(api.getNodePool).toHaveBeenCalledTimes(2);
      expect(api.getDeployment).toHaveBeenCalledTimes(2);
      expect(listWorkloads).toHaveBeenCalledTimes(2);
      expect(listWorkloads).toHaveBeenCalledWith(
        { query: { deploymentId: deployment.id } },
        { signal: expect.any(AbortSignal) },
      );
      expect(sharedUtils.sleep).toHaveBeenCalledWith(
        5_000,
        expect.any(AbortSignal),
      );
      expect(process.exitCode).toBe(130);
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  describe('watch display', () => {
    let writeSpy: MockInstance<typeof process.stdout.write>;

    function setTerminalSize(rows: number, columns: number): void {
      Object.defineProperty(process.stdout, 'rows', {
        configurable: true,
        value: rows,
      });
      Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        value: columns,
      });
    }

    function makeDeploymentJob(
      overrides: Partial<StoredWorkload> = {},
    ): StoredWorkload {
      return makeWorkload({
        deploymentId: deployment.id,
        image: null,
        cloudProvider: null,
        region: null,
        vmType: null,
        gpuType: null,
        vmCount: 0,
        ...overrides,
      });
    }

    function frames(): string[][] {
      return logSpy.mock.calls.map(([frame]) => String(frame).split('\n'));
    }

    beforeEach(() => {
      setInteractive();
      setTerminalSize(24, 80);
      api.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
      api.listDeployments.mockResolvedValue({ deployments: [deployment] });
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ nodePool: nodePool.id })
        .mockResolvedValueOnce({ deployment: deployment.id });
      sharedUtils.sleep.mockImplementation(async () => {
        process.emit('SIGINT', 'SIGINT');
      });
      writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
    });

    afterEach(() => writeSpy.mockRestore());

    it.each([24, 40])(
      'keeps active Jobs and summaries visible at %i rows with a full history',
      async (rows) => {
        setTerminalSize(rows, 80);
        vi.mocked(listWorkloads).mockResolvedValue([
          ...Array.from({ length: 198 }, (_, index) =>
            makeDeploymentJob({
              id: `done-${index}`,
              state: WorkloadState.Completed,
            }),
          ),
          makeDeploymentJob({ id: 'active-old', startedAt: 100 }),
          makeDeploymentJob({
            id: 'queued-old',
            state: WorkloadState.Queued,
            startedAt: 200,
          }),
        ]);
        api.getDeployment.mockResolvedValue({
          deployment: {
            ...deployment,
            jobs: { ...deployment.jobs, terminal: 198 },
          },
        });

        await createListCommand().parseAsync(['node', 'test', '--watch']);

        const [lines] = frames();
        const frame = lines.join('\n');
        expect(lines.length).toBeLessThan(rows);
        expect(lines.every((line) => line.length < 80)).toBe(true);
        expect(frame).toContain('Node pool: running, 1/1 ready');
        expect(frame).toContain('Deployment: unknown, Jobs 1/4');
        expect(frame).toContain(
          'Jobs: 1 running, 1 queued, 0 retrying, 198 terminal',
        );
        const jobRows = lines.filter((line) =>
          /^(active-old|queued-old|done-)/u.test(line),
        );
        expect(jobRows[0]).toContain('active-old');
        expect(jobRows[1]).toContain('queued-old');
        expect(jobRows[2]).toContain('done-0');
        expect(frame).toContain(`Showing ${jobRows.length}/200 fetched Jobs`);
        expect(frame).toContain(
          `Hidden: 0 active, ${200 - jobRows.length} terminal`,
        );
        expect(frame).not.toMatch(/--status|--limit|raise with/u);
        expect(listWorkloads).toHaveBeenCalledWith(
          { query: { deploymentId: deployment.id } },
          { signal: expect.any(AbortSignal) },
        );
        expect(process.exitCode).toBe(130);
        expect(printError).not.toHaveBeenCalled();
      },
    );

    it('reports active Jobs hidden by the viewport without reducing the fetched set', async () => {
      vi.mocked(listWorkloads).mockResolvedValue(
        Array.from({ length: 250 }, (_, index) =>
          makeDeploymentJob({ id: `active-${index}` }),
        ),
      );
      api.getDeployment.mockResolvedValue({
        deployment: {
          ...deployment,
          jobs: { ...deployment.jobs, running: 250, queued: 0, terminal: 0 },
        },
      });

      await createListCommand().parseAsync(['node', 'test', '--watch']);

      const [lines] = frames();
      const visible = lines.filter((line) => line.startsWith('active-')).length;
      expect(lines.length).toBeLessThan(24);
      expect(lines.join('\n')).toContain(`Showing ${visible}/250 fetched Jobs`);
      expect(lines.join('\n')).toContain(
        `Hidden: ${250 - visible} active, 0 terminal`,
      );
      expect(lines.join('\n')).toContain('Jobs: 250 running');
    });

    it('uses the new terminal size on the next refresh', async () => {
      setTerminalSize(40, 100);
      vi.mocked(listWorkloads).mockResolvedValue(
        Array.from({ length: 200 }, (_, index) =>
          makeDeploymentJob({ id: `job-${index}` }),
        ),
      );
      sharedUtils.sleep.mockImplementationOnce(async () =>
        setTerminalSize(24, 60),
      );

      await createListCommand().parseAsync(['node', 'test', '--watch']);

      const [first, second] = frames();
      expect(first.length).toBeLessThan(40);
      expect(first.every((line) => line.length < 100)).toBe(true);
      expect(second.length).toBeLessThan(24);
      expect(second.every((line) => line.length < 60)).toBe(true);
      expect(second.length).toBeLessThan(first.length);
    });

    it('constrains long Unicode fields and diagnostics while keeping state and creator visible', async () => {
      const longText = `\x1b[31m${'界'.repeat(200)}\nextra\ttext\x1b[0m`;
      api.getNodePool.mockResolvedValue({
        nodePool: { ...nodePool, name: longText, lastError: longText },
      });
      api.getDeployment.mockResolvedValue({
        deployment: {
          ...deployment,
          name: longText,
          workload: {
            ...deployment.workload,
            containerReady: false,
            pendingReason: longText,
          },
        },
      });
      vi.mocked(listWorkloads).mockResolvedValue([
        {
          ...makeDeploymentJob({
            id: 'long-job-'.repeat(30),
            userId: 'teammate',
          }),
          isOwnedByCaller: false,
        },
      ]);

      await createListCommand().parseAsync(['node', 'test', '--watch']);

      const [lines] = frames();
      const frame = lines.join('\n');
      expect(lines.length).toBeLessThan(24);
      // Each known full-width fixture character occupies two terminal cells.
      expect(
        lines.every((line) => line.replace(/界/gu, 'xx').length < 80),
      ).toBe(true);
      expect(frame).not.toContain('\x1b');
      expect(frame).not.toContain('\t');
      expect(frame).toContain('Deployment: unknown, Jobs 1/4');
      expect(frame).toContain('Node pool error:');
      expect(frame).toContain('Pending:');
      expect(frame).toContain('USER');
      const jobRow = lines.find((line) => line.startsWith('long-job-'));
      expect(jobRow).toContain('running');
      expect(jobRow).toContain('teammate');
      expect(frame).toContain('Hidden: 0 active, 0 terminal');
    });

    it('shows an empty Job list without losing the node pool and Deployment summaries', async () => {
      vi.mocked(listWorkloads).mockResolvedValue([]);

      await createListCommand().parseAsync(['node', 'test', '--watch']);

      const frame = frames()[0].join('\n');
      expect(frame).toContain('Node pool: running');
      expect(frame).toContain('Deployment: unknown, Jobs 1/4');
      expect(frame).toContain('Showing 0/0 fetched Jobs');
      expect(frame).toContain('Hidden: 0 active, 0 terminal');
    });

    it('requests more room instead of overflowing a tiny terminal', async () => {
      setTerminalSize(4, 25);

      await createListCommand().parseAsync(['node', 'test', '--watch']);

      const [lines] = frames();
      expect(lines.length).toBeLessThan(4);
      expect(lines.every((line) => line.length < 25)).toBe(true);
      expect(lines.join('\n')).toContain('Enlarge the terminal');
    });

    it('cancels an in-flight Job request quietly on Ctrl-C', async () => {
      vi.mocked(listWorkloads).mockImplementation(
        (_input, { signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
            queueMicrotask(() => process.emit('SIGINT', 'SIGINT'));
          }),
      );

      await createListCommand().parseAsync(['node', 'test', '--watch']);

      expect(process.exitCode).toBe(130);
      expect(printError).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(frames()).toHaveLength(0);
    });
  });

  it('requires an interactive stdout for --watch before loading node pools', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    setStdoutIsTTY(false);
    await expect(
      createListCommand().parseAsync(['node', 'test', '--watch']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('--watch requires an interactive terminal'),
    );
    expect(api.listNodePools).not.toHaveBeenCalled();
  });

  it('rejects a watch interval below one second', async () => {
    setInteractive();
    await expect(
      createListCommand().parseAsync([
        'node',
        'test',
        '--watch',
        '--interval',
        '0',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('--interval must be a number >= 1'),
    );
    expect(api.listNodePools).not.toHaveBeenCalled();
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
    expect(help).toContain('--watch');
    expect(help).toContain('--interval');
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
