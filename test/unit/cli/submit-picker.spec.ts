import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

const api = vi.hoisted(() => ({ createWorkload: vi.fn() }));

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
        succeed: () => undefined,
        warn: () => undefined,
        fail: () => undefined,
        stop: () => undefined,
      }),
    }),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printWarning: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    admission: { submit: api.createWorkload },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () => ({
  ...(await import('./cli-auth-mock.js')).cliAuthMock('gh-token'),
  getGitHubToken: async () => 'gh-token',
}));

vi.mock('../../../src/cli/commands/shared.js', () => ({
  parseEnvVars: () => undefined,
  resolveCloudConfig: vi.fn(async () => ({
    cloudConfig: {},
    credentialName: 'prod-aws',
    inputStorageCredentialName: undefined,
    outputStorageCredentialName: undefined,
    gpuType: undefined,
  })),
  buildDockerOptions: () => undefined,
}));

import { createSubmitCommand } from '../../../src/cli/commands/submit.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import { resolveCloudConfig } from '../../../src/cli/commands/shared.js';
import type { ResolvedConfig } from '../../../src/cli/services/config.js';

const createWorkload = api.createWorkload;

const spotResolved: ResolvedConfig = {
  cloudConfig: { spot: true },
  credentialName: 'prod-aws',
  inputStorageCredentialName: undefined,
  outputStorageCredentialName: undefined,
  checkpointStorageCredentialName: undefined,
  gpuType: undefined,
};

interface FetchMock {
  url: string;
  body: unknown;
}

function mockFetchSequence(responses: FetchMock[]) {
  let i = 0;
  return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const r = responses[i++];
    if (!r) {
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }
    return new Response(JSON.stringify(r.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

async function runSubmit(argv: string[]) {
  const cmd = createSubmitCommand();
  cmd.exitOverride();
  await cmd.parseAsync(argv, { from: 'user' });
}

describe('submit picker', () => {
  it('does not expose a --local option', () => {
    expect(
      createSubmitCommand().options.map((option) => option.long),
    ).not.toContain('--local');
  });

  it('targets a Deployment with --deployment and removes --worker', () => {
    const options = createSubmitCommand().options.map((option) => option.long);
    expect(options).toContain('--deployment');
    expect(options).not.toContain('--worker');
  });

  let exitSpy: MockInstance<typeof process.exit>;
  let fetchSpy: ReturnType<typeof mockFetchSequence> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createWorkload).mockResolvedValue({
      id: 'dep-1',
      url: undefined,
    });
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fetchSpy?.mockRestore();
  });

  it('is named job with no aliases', () => {
    const command = createSubmitCommand();

    expect(command.name()).toBe('job');
    expect(command.aliases()).toEqual([]);
  });

  it('does not expose workload bake controls', () => {
    const options = createSubmitCommand().options.map((option) => option.long);
    expect(options).not.toContain('--bake');
    expect(options).not.toContain('--no-bake-cache');
    expect(options).not.toContain('--warm-image');
  });

  it('submits to a Deployment without resolving VM compute', async () => {
    await runSubmit(['--deployment', 'training']);

    expect(resolveCloudConfig).not.toHaveBeenCalled();
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment: 'training',
        workloadType: 'job',
      }),
    );
  });

  it.each([
    ['image', ['nginx:latest']],
    ['command', ['nginx:latest', '--', 'python', 'train.py']],
    ['--credentials', ['--credentials', 'prod']],
    ['--region', ['--region', 'us-east-1']],
    ['--vm-type', ['--vm-type', 'g6.xlarge']],
    ['--gpu-type', ['--gpu-type', 'h100']],
    ['--spot', ['--spot']],
    ['--disk-size', ['--disk-size', '100']],
    ['--disk-tier', ['--disk-tier', 'high']],
    ['--input-bucket', ['--input-bucket', 'input']],
    ['--output-bucket', ['--output-bucket', 'output']],
    ['--checkpoint-bucket', ['--checkpoint-bucket', 'checkpoint']],
    ['--input-storage-credentials', ['--input-storage-credentials', 'storage']],
    ['--input-storage-region', ['--input-storage-region', 'us-east-2']],
    [
      '--output-storage-credentials',
      ['--output-storage-credentials', 'storage'],
    ],
    ['--output-storage-region', ['--output-storage-region', 'us-east-2']],
    [
      '--checkpoint-storage-credentials',
      ['--checkpoint-storage-credentials', 'storage'],
    ],
    [
      '--checkpoint-storage-region',
      ['--checkpoint-storage-region', 'us-east-2'],
    ],
    ['--zone', ['--zone', 'a']],
    ['--secret', ['--secret', 'training']],
    ['--env', ['--env', 'KEY=value']],
    ['--env-file', ['--env-file', '.env']],
    ['--shm-size', ['--shm-size', '8g']],
    ['--gpus', ['--gpus', 'all']],
    ['--ipc', ['--ipc', 'host']],
    ['--ulimit', ['--ulimit', 'nofile=1024:1024']],
    ['--memory', ['--memory', '32g']],
    ['--cpus', ['--cpus', '4']],
    ['--runtime', ['--runtime', 'nvidia']],
    ['--bind', ['--bind', '/host:/container']],
  ])(
    '0029/S9 rejects targeted Job override %s locally',
    async (_label, args) => {
      await expect(
        runSubmit(['--deployment', 'training', ...args]),
      ).rejects.toThrow(/process\.exit:1/);
      expect(resolveCloudConfig).not.toHaveBeenCalled();
      expect(createWorkload).not.toHaveBeenCalled();
    },
  );

  it('TTY + no image arg → GHCR picker (repo + tag) → submits with composed image', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    fetchSpy = mockFetchSequence([
      { url: 'user', body: { login: 'alice' } },
      { url: 'user/packages', body: [{ name: 'webapp' }] },
      { url: 'user/orgs', body: [] },
      {
        url: 'versions',
        body: [{ metadata: { container: { tags: ['v1.0'] } } }],
      },
    ]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({
        repo: {
          name: 'ghcr.io/alice/webapp',
          owner: 'alice',
          packageName: 'webapp',
          isOrg: false,
        },
      })
      .mockResolvedValueOnce({ tag: 'v1.0' });

    await runSubmit([]);
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'ghcr.io/alice/webapp:v1.0',
      }),
    );
  });

  it('TTY + image arg → no prompts at all (no image picker, no confirm)', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);

    await runSubmit(['nginx:latest']);
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'nginx:latest' }),
    );
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it('non-TTY + no image arg → hard error (no prompts)', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    await expect(runSubmit([])).rejects.toThrow(/process\.exit:1/);
    expect(safePrompts).not.toHaveBeenCalled();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('non-TTY + image arg → submits without prompting', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);

    await runSubmit(['nginx:latest']);
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'nginx:latest' }),
    );
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it('--config is no longer accepted', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    await expect(
      runSubmit(['nginx:latest', '--config', 'prod']),
    ).rejects.toThrow(/unknown option/i);
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('passes checkpoint storage flags through to config resolution and request', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(resolveCloudConfig).mockResolvedValueOnce({
      ...spotResolved,
      checkpointStorageCredentialName: 'ckpt-aws',
    });

    await runSubmit([
      'nginx:latest',
      '--checkpoint-storage-credentials',
      'ckpt-aws',
      '--checkpoint-storage-region',
      'us-west-2',
    ]);

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointStorageCredentials: 'ckpt-aws',
        checkpointStorageRegion: 'us-west-2',
      }),
    );
    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointStorageCredentialName: 'ckpt-aws',
      }),
    );
  });
});
