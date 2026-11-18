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

const api = vi.hoisted(() => ({
  listWorkloads: vi.fn(),
  terminateWorkload: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({
      start: () => ({
        stop: () => undefined,
        succeed: () => undefined,
        fail: () => undefined,
      }),
    }),
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
  createApiClient: () => ({
    workloads: {
      list: api.listWorkloads,
      terminate: api.terminateWorkload,
    },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/cli/session/detect.js', () => ({
  detectSession: vi.fn(),
}));

import { createTerminateCommand } from '../../../src/cli/commands/terminate.js';
import { printError } from '../../../src/cli/utils/output.js';
import { selectWorkloads } from '../../../src/cli/utils/workload-picker.js';
import { detectSession } from '../../../src/cli/session/detect.js';
import { makeStoredWorkload } from '../helpers/fixtures';

const listWorkloads = api.listWorkloads;
const terminateWorkload = api.terminateWorkload;

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
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 0,
    sshPrivateKey: '',
    credentialId: 'cred-1',
    totalCost: null,
    state: WorkloadState.Running,
    ...overrides,
  });
}

describe('createTerminateCommand', () => {
  const savedEnv = process.env.ANYCLOUD_WORKLOAD_ID;
  const savedExitCode = process.exitCode;
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    delete process.env.ANYCLOUD_WORKLOAD_ID;
    process.exitCode = undefined;
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({ id: 'running-id' }),
    ]);
    vi.mocked(terminateWorkload).mockResolvedValue({ message: 'ok' });
    vi.mocked(detectSession).mockReturnValue(null);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANYCLOUD_WORKLOAD_ID;
    else process.env.ANYCLOUD_WORKLOAD_ID = savedEnv;
    process.exitCode = savedExitCode;
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('delegates terminatable filtering to the server (stateClass)', async () => {
    // No id arg → interactive multi-select picker path. The server returns the
    // terminatable set; the CLI sends only the stateClass, no row cap.
    vi.mocked(listWorkloads).mockResolvedValue([
      makeWorkload({
        id: 'old-running',
        state: WorkloadState.Running,
        vmCount: 1,
      }),
    ]);
    vi.mocked(selectWorkloads).mockResolvedValue(['old-running']);

    await createTerminateCommand().parseAsync(['node', 'test']);

    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ stateClass: 'terminatable' }),
      }),
    );
    expect(terminateWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: 'old-running' } }),
    );
  });

  it('includes detected caller session in terminate requests', async () => {
    vi.mocked(detectSession).mockReturnValue({
      session: 'session-123',
      agent: 'claude',
      label: 'Readable session',
    });

    await createTerminateCommand().parseAsync(['node', 'test', 'running-id']);

    expect(terminateWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: 'running-id' },
        query: { session: 'session-123' },
      }),
    );
    const request = vi.mocked(terminateWorkload).mock.calls[0]![0];
    expect(request.query).not.toHaveProperty('agent');
    expect(request.query).not.toHaveProperty('sessionLabel');
  });

  it('sets a nonzero exit code when a termination request fails', async () => {
    vi.mocked(terminateWorkload).mockRejectedValue(
      new Error('API unavailable'),
    );

    await createTerminateCommand().parseAsync(['node', 'test', 'running-id']);

    expect(process.exitCode).toBe(1);
    expect(printError).toHaveBeenCalledWith('API unavailable');
  });

  it('attempts every workload and exits nonzero when a batch partially fails', async () => {
    vi.mocked(terminateWorkload).mockImplementation(async (request) => {
      if (request.params.id === 'dep-b') throw new Error('dep-b failed');
      return { message: 'ok' };
    });

    await createTerminateCommand().parseAsync([
      'node',
      'test',
      'dep-a',
      'dep-b',
      'dep-c',
    ]);

    expect(
      vi
        .mocked(terminateWorkload)
        .mock.calls.map(([request]) => request.params.id),
    ).toEqual(['dep-a', 'dep-b', 'dep-c']);
    expect(process.exitCode).toBe(1);
  });
});
