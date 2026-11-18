import { Command } from 'commander';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadType } from '../../../src/shared/workload.js';
import { makeStoredWorkload } from '../helpers/fixtures.js';

const api = vi.hoisted(() => ({
  listWorkloads: vi.fn(),
  submit: vi.fn(),
  upgrade: vi.fn(),
  authenticate: vi.fn(),
  resolveCloudConfig: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    workloads: { list: api.listWorkloads },
    admission: { submit: api.submit },
    serviceUpgrade: { upgrade: api.upgrade },
  }),
}));

vi.mock('../../../src/cli/services/auth.js', () => ({
  apiClient: async () => {
    await api.authenticate();
    return {
      workloads: { list: api.listWorkloads },
      admission: { submit: api.submit },
      serviceUpgrade: { upgrade: api.upgrade },
    };
  },
}));

vi.mock('../../../src/cli/commands/shared.js', () => ({
  parseEnvVars: () => undefined,
  buildDockerOptions: () => undefined,
  resolveCloudConfig: api.resolveCloudConfig,
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/cli/utils/output.js')>()),
  createSpinner: () => ({
    start: () => ({ stop: () => undefined, succeed: () => undefined }),
  }),
  printInfo: vi.fn(),
  printError: vi.fn(),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(() => false),
  safePrompts: vi.fn(),
}));

import { createListCommand } from '../../../src/cli/commands/list.js';
import { createSubmitCommand } from '../../../src/cli/commands/submit.js';
import { createServeCommand } from '../../../src/cli/commands/serve.js';
import { createVmCommand } from '../../../src/cli/commands/vm.js';
import { printError, setJsonMode } from '../../../src/cli/utils/output.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';

function program(): Command {
  const root = new Command('anycloud')
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .addCommand(createSubmitCommand())
    .addCommand(createServeCommand())
    .addCommand(createVmCommand())
    .addCommand(createListCommand());
  for (const command of root.commands) {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
    for (const child of command.commands) {
      child.exitOverride().configureOutput({ writeErr: () => undefined });
    }
  }
  return root;
}

async function run(args: string[]): Promise<void> {
  await program().parseAsync(args, { from: 'user' });
}

const resources = [WorkloadType.Job, WorkloadType.Service, WorkloadType.Vm];
const commands = [
  ['job', WorkloadType.Job],
  ['service', WorkloadType.Service],
  ['vm', WorkloadType.Vm],
] as const;

describe('resource listing and launch', () => {
  let logSpy: MockInstance<typeof console.log>;
  const stdoutIsTTY = process.stdout.isTTY;
  const stdinIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_BIN_PATH',
      'CODEX_THREAD_ID',
      'CURSOR_TRACE_ID',
      'AIDER_MODEL',
    ])
      vi.stubEnv(name, '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    api.authenticate.mockResolvedValue('test-token');
    api.listWorkloads.mockResolvedValue([]);
    api.submit.mockResolvedValue({ id: 'created' });
    api.upgrade.mockResolvedValue({ id: 'upgraded' });
    api.resolveCloudConfig.mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
      },
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    setJsonMode(false);
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: stdoutIsTTY,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: stdinIsTTY,
    });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(commands)(
    '%s list and ls list only %s workloads without submitting',
    async (name, type) => {
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      });
      vi.mocked(shouldAllowPrompts).mockReturnValue(true);
      api.listWorkloads.mockResolvedValue([
        makeStoredWorkload({ id: `${type}-listed`, workloadType: type }),
      ]);

      for (const verb of ['list', 'ls']) {
        await run([name, verb]);
        expect(api.listWorkloads).toHaveBeenLastCalledWith({
          query: expect.objectContaining({ workloadType: type }),
        });
      }

      expect(logSpy.mock.calls.flat().join('\n')).toContain(`${type}-listed`);
      expect(safePrompts).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
      expect(api.upgrade).not.toHaveBeenCalled();
    },
  );

  it.each(resources)(
    '%s list preserves combined filters, limits, and JSON output',
    async (type) => {
      const row = makeStoredWorkload({
        id: `${type}-listed`,
        workloadType: type,
      });
      api.listWorkloads.mockResolvedValue([{ ...row, isOwnedByCaller: false }]);
      const before = Date.now();
      await run([
        type,
        'list',
        '--status',
        'running',
        '--credentials',
        'prod',
        '--user',
        'alice',
        '--session',
        'session-a',
        '--agent',
        'codex',
        '-f',
        'model',
        '-p',
        '7d',
        '-n',
        '400',
        '--json',
      ]);

      expect(api.listWorkloads).toHaveBeenCalledWith({
        query: expect.objectContaining({
          workloadType: type,
          status: 'running',
          credentialName: 'prod',
          user: 'alice',
          session: 'session-a',
          agent: 'codex',
          filter: 'model',
          limit: '400',
          sessionExact: undefined,
        }),
      });
      const since = Number(api.listWorkloads.mock.calls[0]?.[0].query.sinceMs);
      expect(since).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
      expect(since).toBeLessThanOrEqual(Date.now() - 7 * 24 * 60 * 60 * 1000);
      expect(logSpy).toHaveBeenCalledExactlyOnceWith(JSON.stringify([row]));
      expect(api.submit).not.toHaveBeenCalled();
    },
  );

  it.each(resources)(
    '%s list preserves CSV and ID-only output',
    async (type) => {
      const row = makeStoredWorkload({
        id: `${type}-listed`,
        workloadType: type,
      });
      api.listWorkloads.mockResolvedValue([row]);
      await run([type, 'list', '--csv']);
      expect(logSpy.mock.calls[0]?.[0]).toContain(
        'id,user,state,cloudProvider',
      );
      expect(logSpy.mock.calls[0]?.[0]).toContain(`${type}-listed,`);
      logSpy.mockClear();
      await run([type, 'ls', '--only-ids']);
      expect(logSpy).toHaveBeenCalledExactlyOnceWith(`${type}-listed`);
      expect(safePrompts).not.toHaveBeenCalled();
    },
  );

  it.each(resources)(
    '%s list retains automatic agent session scope',
    async (type) => {
      vi.stubEnv('CLAUDECODE', '1');
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'session-exact');
      await run([type, 'list', '--only-ids']);
      expect(api.listWorkloads).toHaveBeenCalledWith({
        query: expect.objectContaining({
          workloadType: type,
          session: 'session-exact',
          sessionExact: 'true',
        }),
      });
    },
  );

  it('passes --deployment after job list to listing instead of Job submission', async () => {
    await run([
      'job',
      'list',
      '--deployment',
      'deployment-a',
      '-n',
      '400',
      '--json',
    ]);
    expect(api.listWorkloads).toHaveBeenCalledWith({
      query: expect.objectContaining({
        workloadType: 'job',
        deploymentId: 'deployment-a',
        limit: '400',
      }),
    });
    expect(api.submit).not.toHaveBeenCalled();
  });

  it.each(resources)(
    '%s list rejects attempts to override its type',
    async (type) => {
      await expect(run([type, 'list', '--type', 'job'])).rejects.toMatchObject({
        code: 'commander.unknownOption',
      });
      expect(api.authenticate).not.toHaveBeenCalled();
      expect(api.listWorkloads).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['job', '--deployment', 'deployment-a'],
    ['job', '--env', 'NAME=value'],
    ['service', '--credentials', 'prod'],
    ['vm', '--id', 'my-vm'],
  ])('rejects launch options before %s list: %s', async (type, flag, value) => {
    await expect(run([type!, flag!, value!, 'list'])).rejects.toThrow(
      'process.exit:1',
    );
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining(
        `Put listing options after 'anycloud ${type} list'`,
      ),
    );
    expect(api.authenticate).not.toHaveBeenCalled();
    expect(api.listWorkloads).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it.each([WorkloadType.Service, WorkloadType.Vm])(
    '%s list does not expose Job-only filtering or watch',
    async (type) => {
      for (const args of [['--deployment', 'deployment-a'], ['--watch']]) {
        await expect(run([type, 'list', ...args])).rejects.toMatchObject({
          code: 'commander.unknownOption',
        });
      }
      expect(api.listWorkloads).not.toHaveBeenCalled();
    },
  );

  it.each(commands)(
    '%s still launches tagged images, including reserved names',
    async (name, type) => {
      for (const image of [
        'example/image:latest',
        'list:latest',
        'ls:latest',
      ]) {
        await run([name, image, '--id', 'chosen-id', '--credentials', 'prod']);
        expect(api.submit).toHaveBeenLastCalledWith(
          expect.objectContaining({
            image,
            workloadType: type,
            id: 'chosen-id',
          }),
        );
      }
      expect(api.listWorkloads).not.toHaveBeenCalled();
    },
  );

  it.each(['job', 'service'])(
    '%s forwards container arguments after --',
    async (name) => {
      await run([
        name,
        'example/image:latest',
        '--credentials',
        'prod',
        '--',
        'python',
        'list',
        '--deployment',
        'application-deployment',
        '--epochs',
        '10',
      ]);
      expect(api.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          command: [
            'python',
            'list',
            '--deployment',
            'application-deployment',
            '--epochs',
            '10',
          ],
        }),
      );
      expect(api.listWorkloads).not.toHaveBeenCalled();
    },
  );

  it.each(['job'])(
    '%s --deployment still submits identity-only Jobs',
    async (name) => {
      await run([name, '--deployment', 'model-deployment']);
      expect(api.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          deployment: 'model-deployment',
          workloadType: 'job',
        }),
      );
      expect(api.listWorkloads).not.toHaveBeenCalled();
    },
  );

  it.each(['service'])(
    '%s upgrade still preserves its request and container command',
    async (name) => {
      await run([
        name,
        'upgrade',
        'api-id',
        'example/api:v2',
        '--',
        'node',
        'server.js',
        '--port',
        '8088',
      ]);
      expect(api.upgrade).toHaveBeenCalledExactlyOnceWith({
        params: { id: 'api-id' },
        body: {
          image: 'example/api:v2',
          command: ['node', 'server.js', '--port', '8088'],
        },
      });
      expect(api.submit).not.toHaveBeenCalled();
      expect(api.listWorkloads).not.toHaveBeenCalled();
    },
  );

  it('keeps top-level list as an untyped overview', async () => {
    await run(['list', '--json']);
    expect(
      api.listWorkloads.mock.calls[0]?.[0].query.workloadType,
    ).toBeUndefined();
    expect(api.submit).not.toHaveBeenCalled();
  });
});
