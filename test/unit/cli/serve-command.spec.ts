import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Command } from 'commander';

const api = vi.hoisted(() => ({
  createWorkload: vi.fn(),
  upgradeServeWorkload: vi.fn(),
}));
const spinnerSucceed = vi.hoisted(() => vi.fn());

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (msg: string) => {
      throw new Error(msg);
    },
    createSpinner: () => ({
      start: () => ({
        succeed: spinnerSucceed,
        warn: () => undefined,
        fail: () => undefined,
        stop: () => undefined,
      }),
    }),
    printInfo: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    admission: { submit: api.createWorkload },
    serviceUpgrade: { upgrade: api.upgradeServeWorkload },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock('gh-token'),
);

vi.mock('../../../src/cli/commands/shared.js', () => ({
  parseEnvVars: vi.fn(),
  resolveCloudConfig: vi.fn(),
  buildDockerOptions: vi.fn(),
}));

vi.mock('../../../src/cli/session/detect.js', () => ({
  detectSession: vi.fn(() => ({
    session: 'session-1',
    agent: 'codex',
    label: 'main',
  })),
}));

vi.mock('../../../src/cli/services/ghcr-picker.js', () => ({
  pickGHCRImage: vi.fn(),
}));

import { createServeCommand } from '../../../src/cli/commands/serve.js';
import { shouldAllowPrompts } from '../../../src/cli/utils/safe-prompts.js';
import {
  buildDockerOptions,
  parseEnvVars,
  resolveCloudConfig,
} from '../../../src/cli/commands/shared.js';
import {
  printError,
  printInfo,
  printWarning,
} from '../../../src/cli/utils/output.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { pickGHCRImage } from '../../../src/cli/services/ghcr-picker.js';

const createWorkload = api.createWorkload;
const upgradeServeWorkload = api.upgradeServeWorkload;
const checkpointRenewalWarning =
  'This Service uses temporary S3 checkpoint credentials renewed by your local API. Keep this computer awake and the API running and connected. If credentials expire while the API is offline, checkpoint uploads pause until renewal succeeds. The Service keeps running.';

async function runServe(argv: string[], commandName = 'service') {
  const cmd = new Command('anycloud').enablePositionalOptions();
  cmd.exitOverride();
  cmd.addCommand(createServeCommand());
  await cmd.parseAsync([commandName, ...argv], { from: 'user' });
}

describe('serve command', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  it('does not expose a --local option', () => {
    expect(
      createServeCommand().options.map((option) => option.long),
    ).not.toContain('--local');
  });
  let consoleSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('API_URL', 'http://localhost:8080');
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(parseEnvVars).mockReturnValue({ FOO: 'bar' });
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: undefined,
      gpuType: undefined,
    });
    vi.mocked(buildDockerOptions).mockReturnValue({ shmSize: '1g' });
    vi.mocked(createWorkload).mockResolvedValue({
      id: 'srv-created',
      url: 'https://srv-created.anycloud.sh',
    });
    vi.mocked(upgradeServeWorkload).mockResolvedValue({
      id: 'srv-1',
      url: 'https://srv-1.anycloud.sh',
    });
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('is named service with no aliases', () => {
    const command = createServeCommand();

    expect(command.name()).toBe('service');
    expect(command.aliases()).toEqual([]);
  });

  it('does not expose the removed direct Cluster target', () => {
    expect(
      createServeCommand().options.map((option) => option.long),
    ).not.toContain('--cluster');
  });

  it('sends a service workload payload without job-only fields', async () => {
    await runServe([
      '--id',
      'srv-1',
      '--credentials',
      'prod-aws',
      '--vm-type',
      't3.small',
      '--env',
      'FOO=bar',
      '--secret',
      'prod-secret',
      '--shm-size',
      '1g',
      'nginx:latest',
      'node',
      'server.js',
    ]);

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'prod-aws',
        vmType: ['t3.small'],
      }),
      { allowSpotPrompt: false },
    );
    expect(createWorkload).toHaveBeenCalledTimes(1);
    const request = vi.mocked(createWorkload).mock.calls[0][0];
    expect(request).toEqual(
      expect.objectContaining({
        image: 'nginx:latest',
        cloudConfig: {
          cloudProvider: 'AWS',
          region: 'us-east-1',
          vmType: 't3.small',
        },
        credentialName: 'prod-aws',
        workloadType: 'service',
        id: 'srv-1',
        env: { FOO: 'bar' },
        secrets: ['prod-secret'],
        dockerOptions: { shmSize: '1g' },
        command: ['node', 'server.js'],
        session: 'session-1',
        agent: 'codex',
        sessionLabel: 'main',
      }),
    );
    for (const key of [
      'persist',
      'persistBucket',
      'imageDigest',
      'inputStorageCredentialName',
      'outputStorageCredentialName',
      'checkpointStorageCredentialName',
    ]) {
      expect(request).not.toHaveProperty(key);
    }
    expect(printInfo).toHaveBeenCalledWith('ID: srv-created');
    expect(printInfo).toHaveBeenCalledWith(
      'URL: https://srv-created.anycloud.sh',
    );
  });

  it('forwards PORT env as the serve port override', async () => {
    vi.mocked(parseEnvVars).mockReturnValue({ PORT: '9000' });

    await runServe(['--vm-type', 't3.small', '--env', 'PORT=9000', 'nginx']);

    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'nginx',
        workloadType: 'service',
        env: { PORT: '9000' },
      }),
    );
  });

  it('forwards checkpoint bucket configuration for services', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
        checkpointBucket: 'server-state',
        checkpointStorageRegion: 'us-west-2',
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: undefined,
      gpuType: undefined,
    });

    await runServe([
      '--checkpoint-bucket',
      'server-state',
      '--checkpoint-storage-region',
      'us-west-2',
      '--vm-type',
      't3.small',
      'nginx:latest',
    ]);

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointBucket: 'server-state',
        checkpointStorageRegion: 'us-west-2',
      }),
      { allowSpotPrompt: false },
    );
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudConfig: expect.objectContaining({
          checkpointBucket: 'server-state',
          checkpointStorageRegion: 'us-west-2',
        }),
      }),
    );
    expect(vi.mocked(createWorkload).mock.calls[0][0]).not.toHaveProperty(
      'checkpointStorageCredentialName',
    );
  });

  it('does not expose termination as a destructive stop subcommand', () => {
    expect(
      createServeCommand().commands.map((command) => command.name()),
    ).not.toContain('stop');
  });

  it('does not expose a dedicated --port option', () => {
    const cmd = createServeCommand();

    expect(cmd.options.map((option) => option.long)).not.toContain('--port');
  });

  it('exposes separate checkpoint storage credentials', () => {
    const cmd = createServeCommand();

    expect(cmd.options.map((option) => option.long)).toContain(
      '--checkpoint-storage-credentials',
    );
    expect(cmd.options.map((option) => option.long)).toContain(
      '--checkpoint-storage-region',
    );
  });

  it('defensively rejects a credentialless remote checkpoint config', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValueOnce({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        vmType: 't3.small',
        checkpointBucket: 'server-state',
      },
      credentialName: undefined,
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: undefined,
      gpuType: undefined,
    });

    await expect(
      runServe(['--checkpoint-bucket', 'server-state', 'nginx:latest']),
    ).rejects.toThrow(/process\.exit:1/);

    expect(createWorkload).not.toHaveBeenCalled();
    expect(printError).toHaveBeenCalledWith(
      'Service checkpoint buckets require selected compute credentials. Pass --credentials or inline compute credentials.',
    );
  });

  it('passes the selected checkpoint storage credential reference to admission', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValueOnce({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        vmType: 't3.small',
        checkpointBucket: 'server-state',
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: 'state-aws',
      gpuType: undefined,
    });

    await runServe([
      '--checkpoint-bucket',
      'server-state',
      '--checkpoint-storage-credentials',
      'state-aws',
      'nginx:latest',
    ]);

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointStorageCredentials: 'state-aws' }),
      expect.anything(),
    );
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialName: 'prod-aws',
        checkpointStorageCredentialName: 'state-aws',
      }),
    );
  });

  describe('local API checkpoint renewal warning', () => {
    const checkpointConfig = {
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
        checkpointBucket: 'server-state',
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: 'state-aws',
      gpuType: undefined,
    };

    beforeEach(() => {
      vi.mocked(resolveCloudConfig).mockResolvedValue(checkpointConfig);
    });

    it.each([
      { commandName: 'service', interactive: true },
      { commandName: 'service', interactive: false },
    ])(
      'warns after $commandName creation (interactive: $interactive)',
      async ({ commandName, interactive }) => {
        vi.mocked(shouldAllowPrompts).mockReturnValue(interactive);
        vi.mocked(pickGHCRImage).mockResolvedValue('nginx:latest');

        await runServe(interactive ? [] : ['nginx:latest'], commandName);

        expect(createWorkload).toHaveBeenCalledTimes(1);
        expect(createWorkload).toHaveBeenCalledWith(
          expect.objectContaining({
            image: 'nginx:latest',
            workloadType: 'service',
            cloudConfig: checkpointConfig.cloudConfig,
            credentialName: 'prod-aws',
            checkpointStorageCredentialName: 'state-aws',
          }),
        );
        expect(spinnerSucceed).toHaveBeenCalledWith(
          'Service workload created!',
        );
        expect(vi.mocked(printInfo).mock.calls).toEqual([
          ['ID: srv-created'],
          ['URL: https://srv-created.anycloud.sh'],
        ]);
        expect(printWarning).toHaveBeenCalledTimes(1);
        expect(printWarning).toHaveBeenCalledWith(checkpointRenewalWarning);
        expect(spinnerSucceed.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(printInfo).mock.invocationCallOrder[0],
        );
        expect(vi.mocked(printInfo).mock.invocationCallOrder[1]).toBeLessThan(
          vi.mocked(printWarning).mock.invocationCallOrder[0],
        );
        expect(consoleSpy.mock.calls).toEqual([[''], ['']]);
        expect(printError).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );

    it.each([
      'http://localhost:9000',
      'http://127.0.0.1:8787/',
      'http://[::1]:8081',
      'http://localhost',
      'https://localhost',
    ])('warns for loopback API %s', async (apiUrl) => {
      vi.stubEnv('API_URL', apiUrl);

      await runServe(['nginx:latest']);

      expect(printWarning).toHaveBeenCalledTimes(1);
      expect(printWarning).toHaveBeenCalledWith(checkpointRenewalWarning);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it.each([
      'https://api.anycloud.sh',
      'http://192.168.1.10:8080',
      'http://localhost.example.com:8080',
    ])('does not warn for remote API %s', async (apiUrl) => {
      vi.stubEnv('API_URL', apiUrl);

      await runServe(['nginx:latest']);

      expect(createWorkload).toHaveBeenCalledTimes(1);
      expect(printWarning).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it.each([
      {
        description: 'no checkpoint bucket',
        checkpointBucket: undefined,
        checkpointStorageCredentialName: 'state-aws',
      },
      {
        description: 'default compute-identity storage',
        checkpointBucket: 'server-state',
        checkpointStorageCredentialName: undefined,
      },
      {
        description: 'the same named compute and checkpoint credential',
        checkpointBucket: 'server-state',
        checkpointStorageCredentialName: 'prod-aws',
      },
    ])(
      'does not warn when the resolved request uses $description',
      async ({ checkpointBucket, checkpointStorageCredentialName }) => {
        vi.mocked(resolveCloudConfig).mockResolvedValue({
          ...checkpointConfig,
          cloudConfig: { ...checkpointConfig.cloudConfig, checkpointBucket },
          checkpointStorageCredentialName,
        });

        await runServe([
          'nginx:latest',
          '--checkpoint-bucket',
          'server-state',
          '--checkpoint-storage-credentials',
          'state-aws',
        ]);

        expect(createWorkload).toHaveBeenCalledTimes(1);
        expect(printWarning).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );

    it('warns with explicit checkpoint and inline compute credentials', async () => {
      const cloudConfig = {
        ...checkpointConfig.cloudConfig,
        credentials: {
          accessKeyId: 'compute-access-key',
          secretAccessKey: 'compute-secret-key',
        },
      };
      vi.mocked(resolveCloudConfig).mockResolvedValue({
        ...checkpointConfig,
        cloudConfig,
        credentialName: undefined,
      });

      await runServe(['nginx:latest']);

      expect(createWorkload).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudConfig,
          credentialName: undefined,
          checkpointStorageCredentialName: 'state-aws',
        }),
      );
      expect(printWarning).toHaveBeenCalledTimes(1);
      expect(printWarning).toHaveBeenCalledWith(checkpointRenewalWarning);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('warns after the ID when creation returns no URL', async () => {
      createWorkload.mockResolvedValue({ id: 'srv-created', url: null });

      await runServe(['nginx:latest']);

      expect(vi.mocked(printInfo).mock.calls).toEqual([['ID: srv-created']]);
      expect(printWarning).toHaveBeenCalledTimes(1);
      expect(printWarning).toHaveBeenCalledWith(checkpointRenewalWarning);
      expect(vi.mocked(printInfo).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(printWarning).mock.invocationCallOrder[0],
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('preserves creation failures without printing the warning', async () => {
      createWorkload.mockRejectedValueOnce(new Error('Creation failed'));

      await expect(runServe(['nginx:latest'])).rejects.toThrow(
        /process\.exit:1/,
      );

      expect(createWorkload).toHaveBeenCalledTimes(1);
      expect(spinnerSucceed).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
      expect(printWarning).not.toHaveBeenCalled();
      expect(printError).toHaveBeenCalledWith('Creation failed');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it('does not expose workload bake controls on create or upgrade', () => {
    const command = createServeCommand();
    const createOptions = command.options.map((option) => option.long);
    const upgrade = command.commands.find(
      (child) => child.name() === 'upgrade',
    );
    const upgradeOptions = upgrade?.options.map((option) => option.long) ?? [];

    for (const option of ['--bake', '--no-bake-cache', '--warm-image']) {
      expect(createOptions).not.toContain(option);
      expect(upgradeOptions).not.toContain(option);
    }
  });

  it('rejects resolved spot configs before creating a service workload', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
        spot: true,
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: undefined,
      gpuType: undefined,
    });

    await expect(
      runServe(['--vm-type', 't3.small', 'nginx:latest']),
    ).rejects.toThrow(/process\.exit:1/);

    expect(createWorkload).not.toHaveBeenCalled();
    expect(printError).toHaveBeenCalledWith(
      '--spot is not supported for service workloads',
    );
  });

  it('fails non-interactively when no image is provided', async () => {
    await expect(runServe([])).rejects.toThrow(/process\.exit:1/);
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('queues an upgrade without resolving cloud config', async () => {
    await runServe(['upgrade', 'srv-1', 'nginx:v2', 'node', 'server.js']);

    expect(resolveCloudConfig).not.toHaveBeenCalled();
    expect(parseEnvVars).not.toHaveBeenCalled();
    expect(createWorkload).not.toHaveBeenCalled();
    expect(upgradeServeWorkload).toHaveBeenCalledWith({
      params: { id: 'srv-1' },
      body: {
        image: 'nginx:v2',
        command: ['node', 'server.js'],
      },
    });
    expect(printInfo).toHaveBeenCalledWith('ID: srv-1');
    expect(printInfo).toHaveBeenCalledWith('URL: https://srv-1.anycloud.sh');
    expect(printWarning).not.toHaveBeenCalled();
  });

  it('forwards upgrade environment changes and the complete bind list', async () => {
    vi.mocked(parseEnvVars).mockReturnValue({
      MODE: 'production',
      PORT: '9000',
    });

    await runServe([
      'upgrade',
      'srv-1',
      'nginx:v2',
      '--env-file',
      'service.env',
      '--env',
      'MODE=production',
      '--bind',
      'service-data:/data',
      'service-workspaces:/workspace',
      '--',
      'node',
      'server.js',
    ]);

    expect(parseEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({
        env: ['MODE=production'],
        envFile: 'service.env',
      }),
    );
    expect(upgradeServeWorkload).toHaveBeenCalledWith({
      params: { id: 'srv-1' },
      body: {
        image: 'nginx:v2',
        command: ['node', 'server.js'],
        env: { MODE: 'production', PORT: '9000' },
        binds: ['service-data:/data', 'service-workspaces:/workspace'],
      },
    });
    expect(resolveCloudConfig).not.toHaveBeenCalled();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('prints no URL when the upgrade response has none', async () => {
    vi.mocked(upgradeServeWorkload).mockResolvedValue({
      id: 'srv-local',
      url: null,
    });

    await runServe(['upgrade', 'srv-local', 'nginx:v2']);

    expect(printInfo).toHaveBeenCalledWith('ID: srv-local');
    expect(printInfo).not.toHaveBeenCalledWith(expect.stringContaining('URL:'));
  });
});
