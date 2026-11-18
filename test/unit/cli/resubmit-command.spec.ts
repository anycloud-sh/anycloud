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
  resubmitWorkload: vi.fn(),
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
      resubmit: api.resubmitWorkload,
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

import { createResubmitCommand } from '../../../src/cli/commands/resubmit.js';
import { selectWorkloads } from '../../../src/cli/utils/workload-picker.js';
import { detectSession } from '../../../src/cli/session/detect.js';
import { makeStoredWorkload } from '../helpers/fixtures';

const listWorkloads = api.listWorkloads;
const resubmitWorkload = api.resubmitWorkload;

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
    state: WorkloadState.Invalid,
    ...overrides,
  });
}

describe('createResubmitCommand', () => {
  const savedEnv = process.env.ANYCLOUD_WORKLOAD_ID;
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    delete process.env.ANYCLOUD_WORKLOAD_ID;
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(resubmitWorkload).mockResolvedValue({ message: 'ok' });
    vi.mocked(detectSession).mockReturnValue(null);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANYCLOUD_WORKLOAD_ID;
    else process.env.ANYCLOUD_WORKLOAD_ID = savedEnv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('delegates resubmittable filtering to the server (stateClass)', async () => {
    const invalid = makeWorkload({ id: 'invalid-id' });
    // The API returns the already-filtered resubmittable set; the CLI renders
    // it as-is (no client-side filtering).
    vi.mocked(listWorkloads).mockResolvedValue([invalid]);
    vi.mocked(selectWorkloads).mockResolvedValue(['invalid-id']);

    await createResubmitCommand().parseAsync(['node', 'test']);

    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ stateClass: 'resubmittable' }),
      }),
    );
    expect(selectWorkloads).toHaveBeenCalledWith([invalid]);
    expect(resubmitWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: 'invalid-id' } }),
    );
  });

  it('does not locally gate explicit workload IDs through the picker list', async () => {
    await createResubmitCommand().parseAsync(['node', 'test', 'older-invalid']);

    expect(listWorkloads).not.toHaveBeenCalled();
    expect(selectWorkloads).not.toHaveBeenCalled();
    expect(resubmitWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: 'older-invalid' } }),
    );
  });

  it('does not locally gate environment workload IDs through the picker list', async () => {
    process.env.ANYCLOUD_WORKLOAD_ID = 'older-invalid,another-invalid';

    await createResubmitCommand().parseAsync(['node', 'test']);

    expect(listWorkloads).not.toHaveBeenCalled();
    expect(selectWorkloads).not.toHaveBeenCalled();
    expect(resubmitWorkload).toHaveBeenCalledTimes(2);
    expect(resubmitWorkload).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ params: { id: 'older-invalid' } }),
    );
    expect(resubmitWorkload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ params: { id: 'another-invalid' } }),
    );
  });

  it('includes detected caller attribution in resubmit requests', async () => {
    vi.mocked(detectSession).mockReturnValue({
      session: 'session-123',
      agent: 'claude',
      label: 'Readable session',
    });

    await createResubmitCommand().parseAsync(['node', 'test', 'older-invalid']);

    expect(resubmitWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: 'older-invalid' },
        body: { session: 'session-123' },
      }),
    );
    const request = vi.mocked(resubmitWorkload).mock.calls[0]![0];
    expect(request.body).not.toHaveProperty('agent');
    expect(request.body).not.toHaveProperty('sessionLabel');
  });
});
