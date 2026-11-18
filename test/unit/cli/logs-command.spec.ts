import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

vi.mock('../../../src/cli/commands/shared.js', () => ({
  resolveWorkloadId: vi.fn(),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/native.js', async () => ({
  streamWorkloadLogs: vi.fn(),
  ApiHttpError: (
    await vi.importActual<
      typeof import('../../../src/shared/services/api-client/native.js')
    >('../../../src/shared/services/api-client/native.js')
  ).ApiHttpError,
}));

vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
  writeSync: vi.fn(),
}));

vi.mock('../../../src/shared/utils.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/shared/utils.js')>(
    '../../../src/shared/utils.js',
  )),
  sleep: vi.fn(async () => undefined),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  printError: vi.fn(),
}));

const statusRead = vi.fn();
vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({ workloads: { status: statusRead } }),
}));

import { createLogsCommand } from '../../../src/cli/commands/logs.js';
import { resolveWorkloadId } from '../../../src/cli/commands/shared.js';
import { nativeApiBearer } from '../../../src/cli/services/auth.js';
import { streamWorkloadLogs } from '../../../src/shared/services/api-client/native.js';
import { getAnycloudVersion } from '../../../src/shared/services/api-client/runtime.js';
import { printError } from '../../../src/cli/utils/output.js';
import { ApiHttpError } from '../../../src/shared/services/api-client/native.js';
import { writeSync } from 'node:fs';
import { sleep } from '../../../src/shared/utils.js';
import { LOGS_CONTAINER_NOT_READY } from '../../../src/shared/api-contract/native-schemas.js';
import type { WorkloadStatusResponse as StatusResponse } from '../../../src/shared/api-contract/workload-management-schemas.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../../src/shared/runtime.js';
import { makeStatusWorkloadMetadata } from '../helpers/fixtures.js';

const notReady = (state: string) =>
  new ApiHttpError(
    '/v1/workloads/dep-1/logs',
    400,
    `Workload is ${state}; its container is not running yet.`,
    LOGS_CONTAINER_NOT_READY,
  );

const workload = (
  state: WorkloadState,
  workloadType: 'job' | 'service' = 'job',
): StatusResponse => ({
  workload: makeStatusWorkloadMetadata({ id: 'dep-1', state, workloadType }),
  events: [],
  status: WorkloadHealthStatus.Unknown,
});

describe('createLogsCommand', () => {
  const savedExitCode = process.exitCode;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(resolveWorkloadId).mockResolvedValue('dep-1');
    vi.mocked(nativeApiBearer).mockResolvedValue('gh-token');
    vi.mocked(getAnycloudVersion).mockReturnValue('0.0.0-test');
    vi.mocked(streamWorkloadLogs).mockResolvedValue(0);
    vi.mocked(statusRead).mockResolvedValue(workload(WorkloadState.Completed));
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    exitSpy.mockRestore();
  });

  it('streams logs through the API (server-side) in non-follow mode', async () => {
    await createLogsCommand().parseAsync(['node', 'test', 'dep-1']);

    expect(resolveWorkloadId).toHaveBeenCalledWith('dep-1');
    expect(streamWorkloadLogs).toHaveBeenCalledWith(
      'gh-token',
      {
        id: 'dep-1',
        follow: false,
      },
      expect.objectContaining({
        stdout: expect.any(Function),
        stderr: expect.any(Function),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('passes follow: true for --follow', async () => {
    await createLogsCommand().parseAsync(['node', 'test', 'dep-1', '--follow']);

    expect(streamWorkloadLogs).toHaveBeenCalledWith(
      'gh-token',
      expect.objectContaining({ follow: true }),
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('no longer accepts the --watch alias', async () => {
    const command = createLogsCommand().exitOverride();
    command.configureOutput({ writeErr: () => undefined });
    await expect(
      command.parseAsync(['node', 'test', 'dep-1', '--watch']),
    ).rejects.toThrow(/unknown option/);
    expect(streamWorkloadLogs).not.toHaveBeenCalled();
  });

  it('waits through setup with --follow, repeating each reason once', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      vi.mocked(streamWorkloadLogs)
        .mockRejectedValueOnce(notReady('provisioning'))
        .mockRejectedValueOnce(notReady('provisioning'))
        .mockRejectedValueOnce(notReady('starting'))
        .mockResolvedValueOnce(0);

      await createLogsCommand().parseAsync([
        'node',
        'test',
        'dep-1',
        '--follow',
      ]);

      expect(streamWorkloadLogs).toHaveBeenCalledTimes(4);
      expect(stderr.mock.calls.map(([text]) => String(text))).toEqual([
        'Workload is provisioning; its container is not running yet. Waiting…\n',
        'Workload is starting; its container is not running yet. Waiting…\n',
      ]);
      expect(printError).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("waits for a Job to finish after its container exits, so a reconnect can't replay", async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // The Perforated spike: the container exited, then the Job stayed
      // running for minutes while it finished.
      vi.mocked(statusRead)
        .mockResolvedValueOnce(workload(WorkloadState.Running))
        .mockResolvedValueOnce(workload(WorkloadState.Running))
        .mockResolvedValueOnce(workload(WorkloadState.Completed));

      await createLogsCommand().parseAsync([
        'node',
        'test',
        'dep-1',
        '--follow',
      ]);

      expect(streamWorkloadLogs).toHaveBeenCalledTimes(1);
      expect(statusRead).toHaveBeenCalledTimes(3);
      expect(stderr.mock.calls.map(([text]) => String(text))).toEqual([
        'Container exited; waiting for the Job to finish…\n',
      ]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
  });

  it("follows a recovered Job's next container without replaying the old one", async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // A Spot reclaim resumed in place: the API keeps serving the old exited
      // container (each reconnect would replay it) until the new one runs.
      statusRead
        .mockResolvedValueOnce(workload(WorkloadState.Running))
        .mockResolvedValueOnce(workload(WorkloadState.Recovering))
        .mockResolvedValueOnce(workload(WorkloadState.Starting))
        .mockResolvedValueOnce(workload(WorkloadState.Running))
        .mockResolvedValueOnce(workload(WorkloadState.Completed));

      await createLogsCommand().parseAsync([
        'node',
        'test',
        'dep-1',
        '--follow',
      ]);

      // One stream per attempt, and a pause on every hold.
      expect(streamWorkloadLogs).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(stderr.mock.calls.map(([text]) => String(text))).toEqual([
        'Container exited; waiting for the Job to finish…\n',
        'Job is recovering; waiting for its next container…\n',
        'Job is starting; waiting for its next container…\n',
      ]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
  });

  it('says so when a retried attempt runs and ends between two checks', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      statusRead
        .mockResolvedValueOnce(workload(WorkloadState.Running))
        .mockResolvedValueOnce(workload(WorkloadState.Retrying))
        .mockResolvedValueOnce(workload(WorkloadState.Errored));

      await createLogsCommand().parseAsync(['node', 'test', 'dep-1', '-f']);

      expect(streamWorkloadLogs).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls.map(([text]) => String(text)).at(-1)).toBe(
        'Job is errored; its last attempt ended between checks. See `anycloud status dep-1`.\n',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('ends with the container when the Job has ended, or for a Service, a Deployment or without --follow', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // The Job already ended.
      await createLogsCommand().parseAsync(['node', 'test', 'dep-1', '-f']);
      // A Service's container restarts; its logs should not be held.
      vi.mocked(statusRead).mockResolvedValueOnce(
        workload(WorkloadState.Running, 'service'),
      );
      await createLogsCommand().parseAsync(['node', 'test', 'dep-1', '-f']);
      // A Deployment ID has no Workload status.
      vi.mocked(statusRead).mockRejectedValueOnce(
        new Error('Workload not found'),
      );
      await createLogsCommand().parseAsync(['node', 'test', 'dep-1', '-f']);
      expect(statusRead).toHaveBeenCalledTimes(3);
      // Without --follow there is nothing to wait for.
      await createLogsCommand().parseAsync(['node', 'test', 'dep-1']);
      expect(statusRead).toHaveBeenCalledTimes(3);

      expect(stderr).not.toHaveBeenCalled();
      expect(printError).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
  });

  it('fails on the final error once the API stops saying to wait', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      vi.mocked(streamWorkloadLogs)
        .mockRejectedValueOnce(notReady('provisioning'))
        .mockRejectedValueOnce(
          new ApiHttpError(
            '/v1/workloads/dep-1/logs',
            400,
            'No live VMs found for this workload',
          ),
        );

      await expect(
        createLogsCommand().parseAsync(['node', 'test', 'dep-1', '--follow']),
      ).rejects.toThrow('process.exit:1');
      expect(printError).toHaveBeenCalledWith(
        expect.stringContaining('No live VMs'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('exits quietly when the reader closes the pipe', async () => {
    vi.mocked(writeSync).mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    vi.mocked(streamWorkloadLogs).mockImplementationOnce(
      async (_token, _request, handlers, options) =>
        await new Promise<number>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
          void handlers?.stdout?.(Buffer.from('epoch 1\n'));
        }),
    );

    await createLogsCommand().parseAsync(['node', 'test', 'dep-1', '--follow']);

    expect(writeSync).toHaveBeenCalledWith(1, expect.any(Buffer), 0);
    expect(process.exitCode).toBeUndefined();
    expect(printError).not.toHaveBeenCalled();
  });

  it('aborts --follow on SIGINT, exits 130, and suppresses abort noise', async () => {
    const originalSigintListeners = process.listenerCount('SIGINT');
    let requestSignal: AbortSignal | undefined;
    vi.mocked(streamWorkloadLogs).mockImplementationOnce(
      async (_accessToken, _request, _handlers, options) => {
        requestSignal = options?.signal;
        return await new Promise<number>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );

    const run = createLogsCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--follow',
    ]);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    process.emit('SIGINT', 'SIGINT');
    await run;

    expect(requestSignal?.aborted).toBe(true);
    expect(process.exitCode).toBe(130);
    expect(printError).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(originalSigintListeners);
  });

  it('uses the workload resolver when no id is provided', async () => {
    await createLogsCommand().parseAsync(['node', 'test']);

    expect(resolveWorkloadId).toHaveBeenCalledWith(undefined);
    expect(streamWorkloadLogs).toHaveBeenCalled();
  });

  it('propagates the logs stream exit code', async () => {
    vi.mocked(streamWorkloadLogs).mockResolvedValue(17);

    await createLogsCommand().parseAsync(['node', 'test', 'dep-1']);

    expect(process.exitCode).toBe(17);
  });

  it('surfaces a runtime logs error and exits 1', async () => {
    vi.mocked(streamWorkloadLogs).mockRejectedValue(
      new Error('Kubernetes Job logs are unavailable after cleanup.'),
    );

    await expect(
      createLogsCommand().parseAsync(['node', 'test', 'dep-1']),
    ).rejects.toThrow('process.exit:1');

    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('unavailable after cleanup'),
    );
  });
});
