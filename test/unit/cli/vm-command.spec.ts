import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const api = vi.hoisted(() => ({ createWorkload: vi.fn() }));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (message: string) => {
      throw new Error(message);
    },
    createSpinner: () => ({
      start: () => ({
        succeed: () => undefined,
        stop: () => undefined,
      }),
    }),
    printInfo: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(),
}));

vi.mock('../../../src/cli/services/ghcr-picker.js', () => ({
  pickGHCRImage: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    admission: { submit: api.createWorkload },
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
}));

vi.mock('../../../src/cli/session/detect.js', () => ({
  detectSession: vi.fn(() => ({
    session: 'session-1',
    agent: 'codex',
    label: 'vm-work',
  })),
}));

import { createVmCommand } from '../../../src/cli/commands/vm.js';
import {
  parseEnvVars,
  resolveCloudConfig,
} from '../../../src/cli/commands/shared.js';
import { pickGHCRImage } from '../../../src/cli/services/ghcr-picker.js';
import { shouldAllowPrompts } from '../../../src/cli/utils/safe-prompts.js';
import { printError, printInfo } from '../../../src/cli/utils/output.js';
import { WorkloadType } from '../../../src/shared/workload.js';
import { CloudType, DiskTier } from '../../../src/shared/cloud.js';
import { apiClient } from '../../../src/cli/services/auth.js';

const createWorkload = api.createWorkload;

async function runVm(argv: string[]): Promise<void> {
  const command = createVmCommand();
  command.exitOverride();
  await command.parseAsync(argv, { from: 'user' });
}

describe('vm command', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let consoleSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(pickGHCRImage).mockResolvedValue(null);
    vi.mocked(parseEnvVars).mockReturnValue({ FOO: 'bar' });
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        availabilityZone: 'a',
        vmType: 't3.large',
        diskSizeGb: 200,
        diskTier: DiskTier.High,
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: undefined,
      gpuType: undefined,
    });
    vi.mocked(createWorkload).mockResolvedValue({ id: 'vm-created' });
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
  });

  it('creates directly from anycloud vm and passes the image through unchanged', async () => {
    await runVm([
      'ghcr.io/acme/dev:v1',
      '--id',
      'vm-1',
      '--credentials',
      'prod-aws',
      '--region',
      'us-east-1',
      '--zone',
      'a',
      '--vm-type',
      't3.large',
      '--disk-size',
      '200',
      '--disk-tier',
      'high',
      '--env',
      'FOO=bar',
      '--secret',
      'dev-secret',
    ]);

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'prod-aws',
        region: 'us-east-1',
        zone: 'a',
        vmType: ['t3.large'],
        diskSize: 200,
        diskTier: 'high',
      }),
      { allowSpotPrompt: false },
    );
    expect(createWorkload).toHaveBeenCalledWith({
      image: 'ghcr.io/acme/dev:v1',
      cloudConfig: {
        cloudProvider: 'AWS',
        region: 'us-east-1',
        availabilityZone: 'a',
        vmType: 't3.large',
        diskSizeGb: 200,
        diskTier: 'high',
      },
      credentialName: 'prod-aws',
      gpuType: undefined,
      workloadType: WorkloadType.Vm,
      id: 'vm-1',
      env: { FOO: 'bar' },
      secrets: ['dev-secret'],
      session: 'session-1',
      agent: 'codex',
      sessionLabel: 'vm-work',
    });
    expect(printInfo).toHaveBeenCalledWith('Connect: anycloud ssh vm-created');
  });

  it('recommends explicit starting images when none is provided non-interactively', async () => {
    await expect(runVm(['--vm-type', 't3.large'])).rejects.toThrow(
      'process.exit:1',
    );

    expect(printError).toHaveBeenCalledWith(
      `Image required. Pass it as the first argument.

Recommended starting images:
  mcr.microsoft.com/devcontainers/base:ubuntu24.04 — Ubuntu Development (CPU)
  pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime — PyTorch + CUDA (NVIDIA GPU)`,
    );
    expect(pickGHCRImage).not.toHaveBeenCalled();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('uses the shared image picker interactively when no image is provided', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(pickGHCRImage).mockResolvedValue('ghcr.io/acme/picked:v1');

    await runVm(['--vm-type', 't3.large']);

    expect(pickGHCRImage).toHaveBeenCalledWith();
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'ghcr.io/acme/picked:v1' }),
    );
  });

  it('does not register or accept the removed vm new command', async () => {
    const command = createVmCommand();

    expect(
      command.commands.map((subcommand) => subcommand.name()),
    ).not.toContain('new');
    await expect(
      runVm(['new', 'ghcr.io/acme/dev:v1', '--vm-type', 't3.large']),
    ).rejects.toMatchObject({ code: 'commander.excessArguments' });
    expect(apiClient).not.toHaveBeenCalled();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('points a bare former-syntax invocation at the new spelling', async () => {
    await expect(runVm(['new'])).rejects.toThrow('process.exit:1');

    expect(printError).toHaveBeenCalledWith(
      'anycloud vm new was replaced by anycloud vm <image>, e.g. anycloud vm ghcr.io/owner/repo:tag.',
    );
    expect(apiClient).not.toHaveBeenCalled();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('accepts a custom compatible image and internal PORT environment', async () => {
    vi.mocked(parseEnvVars).mockReturnValue({ PORT: '3000' });
    vi.mocked(createWorkload).mockResolvedValue({ id: 'vm-custom' });

    await runVm(['--vm-type', 't3.large', 'ghcr.io/acme/dev:latest']);

    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'ghcr.io/acme/dev:latest',
        workloadType: WorkloadType.Vm,
        env: { PORT: '3000' },
      }),
    );
    expect(printInfo).toHaveBeenCalledWith('Connect: anycloud ssh vm-custom');
  });

  it('exposes only the supported VM creation options', () => {
    const options = createVmCommand().options.map((option) => option.long);

    for (const supported of [
      '--id',
      '--credentials',
      '--region',
      '--zone',
      '--vm-type',
      '--gpu-type',
      '--disk-size',
      '--disk-tier',
      '--env',
      '--env-file',
      '--secret',
    ]) {
      expect(options).toContain(supported);
    }
    for (const excluded of [
      '--spot',
      '--persist',
      '--persist-bucket',
      '--input-bucket',
      '--output-bucket',
      '--checkpoint-bucket',
      '--bind',
      '--ipc',
      '--runtime',
      '--public-port',
    ]) {
      expect(options).not.toContain(excluded);
    }
  });

  it('shows creation and listing syntax in help', () => {
    const help = createVmCommand().helpInformation();

    expect(help).toContain('Usage: vm [options] [command] [image]');
    expect(help).toContain('list|ls [options]');
    expect(help).not.toContain('new');
  });

  it('defensively rejects spot from resolved configuration', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValueOnce({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        vmType: 't3.large',
        spot: true,
      },
      credentialName: 'prod-aws',
      inputStorageCredentialName: undefined,
      outputStorageCredentialName: undefined,
      checkpointStorageCredentialName: undefined,
      gpuType: undefined,
    });

    await expect(
      runVm(['ghcr.io/acme/dev:latest', '--vm-type', 't3.large']),
    ).rejects.toThrow('process.exit:1');

    expect(createWorkload).not.toHaveBeenCalled();
    expect(printError).toHaveBeenCalledWith(
      '--spot is not supported for vm workloads',
    );
  });
});
