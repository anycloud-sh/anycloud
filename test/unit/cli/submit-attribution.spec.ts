import { describe, it, expect, beforeEach, vi } from 'vitest';

const api = vi.hoisted(() => ({ createWorkload: vi.fn() }));
const mocks = vi.hoisted(() => ({ warnPrivilegedDeprecated: vi.fn() }));

// Characterization safety net for the submit-stamping seam: the single place
// that turns a DetectedSession into a persisted attribution. Freezes current
// behavior so a detection redesign that changes the DetectedSession shape
// (renamed .label, non-nullable .agent, different session string) fails loudly
// here instead of silently mis-attributing VMs.

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
  shouldAllowPrompts: vi.fn(() => false), // non-interactive: no prompts, straight to submit
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  checkApiVersion: vi.fn(async (url: string) => ({
    url,
    cliVersion: '0.0.0-test',
    apiVersion: '0.0.0-test',
    compatible: true,
  })),
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    admission: { submit: api.createWorkload },
  }),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock('gh-token'),
);

vi.mock('../../../src/cli/commands/shared.js', async (importActual) => ({
  parseEnvVars: () => undefined,
  resolveCloudConfig: vi.fn(async () => ({
    cloudConfig: {},
    credentialName: 'prod-aws',
    inputStorageCredentialName: undefined,
    outputStorageCredentialName: undefined,
    gpuType: undefined,
  })),
  buildDockerOptions: (
    await importActual<typeof import('../../../src/cli/commands/shared.js')>()
  ).buildDockerOptions,
  warnPrivilegedDeprecated: mocks.warnPrivilegedDeprecated,
}));

vi.mock('../../../src/cli/session/detect.js', () => ({
  detectSession: vi.fn(),
}));

import { createSubmitCommand } from '../../../src/cli/commands/submit.js';
import { detectSession } from '../../../src/cli/session/detect.js';

const createWorkload = api.createWorkload;

async function runSubmit(argv: string[]) {
  const cmd = createSubmitCommand();
  cmd.exitOverride();
  await cmd.parseAsync(argv, { from: 'user' });
}

function lastRequest() {
  return vi.mocked(createWorkload).mock.calls.at(-1)?.[0];
}

describe('submit attribution stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createWorkload).mockResolvedValue({
      id: 'dep-1',
      url: undefined,
    });
  });

  it.each(['claude', 'codex'])(
    'stamps the detected %s session, agent, and label onto the request',
    async (agent) => {
      vi.mocked(detectSession).mockReturnValue({
        session: `${agent}-abc`,
        agent,
        label: 'gas-pipeline-tautomer-refactor',
      });
      await runSubmit(['nginx:latest']);
      const req = lastRequest();
      expect(req?.session).toBe(`${agent}-abc`);
      expect(req?.agent).toBe(agent);
      expect(req?.sessionLabel).toBe('gas-pipeline-tautomer-refactor');
    },
  );

  it('stamps NO attribution for an interactive human (detectSession => null)', async () => {
    vi.mocked(detectSession).mockReturnValue(null);
    await runSubmit(['nginx:latest']);
    const req = lastRequest();
    // objectContaining can't prove absence — read the actual arg and assert undefined.
    expect(req?.session).toBeUndefined();
    expect(req?.agent).toBeUndefined();
    expect(req?.sessionLabel).toBeUndefined();
  });

  it('omits the label when the detected agent has no session title', async () => {
    vi.mocked(detectSession).mockReturnValue({
      session: 'aider-1234',
      agent: 'aider',
    });
    await runSubmit(['nginx:latest']);
    const req = lastRequest();
    expect(req?.session).toBe('aider-1234');
    expect(req?.agent).toBe('aider');
    expect(req?.sessionLabel).toBeUndefined();
  });

  it('coerces a null detected agent to undefined on the request', async () => {
    vi.mocked(detectSession).mockReturnValue({
      session: 'x-1',
      agent: null,
    });
    await runSubmit(['nginx:latest']);
    const req = lastRequest();
    expect(req?.session).toBe('x-1');
    expect(req?.agent).toBeUndefined();
  });
});

describe('job VM options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createWorkload).mockResolvedValue({ id: 'job-1' });
  });

  it('sends --max-retries 0', async () => {
    await runSubmit(['ghcr.io/acme/train:1', '--max-retries', '0']);
    expect(lastRequest()).toMatchObject({ maxRetries: 0 });
  });

  it.each(['-1', '1.5', 'two'])('refuses --max-retries %s', async (value) => {
    await expect(
      runSubmit(['ghcr.io/acme/train:1', '--max-retries', value]),
    ).rejects.toThrow();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('sends --require-nested-virtualization and --host-docker', async () => {
    await runSubmit(['ghcr.io/acme/ci:1', '--require-nested-virtualization']);
    expect(lastRequest()).toMatchObject({ requireNestedVirtualization: true });
    await runSubmit(['ghcr.io/acme/ci:1', '--host-docker']);
    expect(lastRequest()).toMatchObject({ hostDocker: true });
  });

  it('sends --regions in the cloud config, never an empty list', async () => {
    await runSubmit(['ghcr.io/acme/ci:1', '--regions', 'us-east-1, us-west-2']);
    expect(lastRequest()?.cloudConfig).toMatchObject({
      regions: ['us-east-1', 'us-west-2'],
    });
    vi.mocked(createWorkload).mockClear();
    // An empty list is refused, never dropped into an unpinned Job.
    await expect(
      runSubmit(['ghcr.io/acme/ci:1', '--regions', ' , ']),
    ).rejects.toThrow();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('sends --disk-iops and --disk-throughput in the cloud config', async () => {
    await runSubmit([
      'ghcr.io/acme/ci:1',
      '--disk-throughput',
      '500',
      '--disk-iops',
      '3000',
    ]);
    expect(lastRequest()?.cloudConfig).toMatchObject({
      diskIops: 3000,
      diskThroughputMibps: 500,
    });
    vi.mocked(createWorkload).mockClear();
    await expect(
      runSubmit(['ghcr.io/acme/ci:1', '--disk-iops', '3k']),
    ).rejects.toThrow();
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('sends --no-checkpoint only when given', async () => {
    await runSubmit(['ghcr.io/acme/train:1']);
    expect(lastRequest()?.noCheckpoint).toBeUndefined();
    await runSubmit(['ghcr.io/acme/train:1', '--no-checkpoint']);
    expect(lastRequest()).toMatchObject({ noCheckpoint: true });
  });

  it('sends --privileged and each --bind', async () => {
    // `--bind` takes one path, so the image after it stays the image.
    await runSubmit([
      '--privileged',
      '--bind',
      '/var/lib/docker',
      '--bind',
      '/scratch',
      'ghcr.io/acme/ci:1',
    ]);
    expect(lastRequest()).toMatchObject({
      image: 'ghcr.io/acme/ci:1',
      dockerOptions: {
        privileged: true,
        binds: ['/var/lib/docker', '/scratch'],
      },
    });
    // Deprecated (RFC 0049 C32): it warns, and still sends it.
    expect(mocks.warnPrivilegedDeprecated).toHaveBeenCalledWith('--privileged');
  });
});
