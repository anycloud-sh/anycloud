import type { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createPoolJobLogs } from '../../../../src/api/services/job/pool-job-logs.js';
import type { JobOperationStream } from '../../../../src/api/services/job/operations.js';
import type {
  PoolJobLogTail,
  PoolJobLogWindow,
} from '../../../../src/api/services/repositories/pool-job-store.js';
import { LOGS_CONTAINER_NOT_READY } from '../../../../src/shared/api-contract/native-schemas.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';

const CLAIM = Date.parse('2026-10-14T10:00:01.000Z');

function window(overrides: Partial<PoolJobLogWindow> = {}): PoolJobLogWindow {
  return {
    managed: true,
    deploymentId: 'managed-1',
    nodePoolId: 'pool-a',
    state: WorkloadState.Running,
    attempt: { podUid: 'uid-1', openedAt: CLAIM, endedAt: null, tail: null },
    ...overrides,
  };
}

function fake(windows: PoolJobLogWindow[], log = '') {
  let reads = 0;
  const read = vi.fn(
    async () => windows[Math.min(reads++, windows.length - 1)]!,
  );
  const logCall = vi.fn(async (...args: unknown[]) => {
    (args[3] as Writable).end(Buffer.from(log));
    return new AbortController();
  });
  const cluster = makeClusterKubernetesClientFixture({
    core: {
      listNamespacedPod: vi.fn(async () => ({
        items: [{ metadata: { name: 'replica-1', uid: 'uid-1' } }],
      })),
    },
    log: { log: logCall },
  });
  const prepare = createPoolJobLogs({
    window: read,
    runtimes: {
      resolve: vi.fn(async () => ({
        config: { namespace: 'anycloud-pool-a' },
        cluster,
        nodePool: {
          clusterId: 'c',
          nodePoolId: 'pool-a',
          nvidiaGpusPerNode: 0,
        },
      })),
    },
  });
  return { prepare, logCall };
}

async function output(
  preparation: ReturnType<ReturnType<typeof createPoolJobLogs>>,
): Promise<string> {
  const prepared = await preparation;
  if (!prepared?.ok) throw new Error(JSON.stringify(prepared));
  const stdout: string[] = [];
  const stream: JobOperationStream = {
    signal: new AbortController().signal,
    onStdout: (chunk) => void stdout.push(chunk.toString()),
    onStderr: () => undefined,
  };
  await prepared.run(stream);
  return stdout.join('');
}

describe('pool Job logs (RFC 0044 § Logs)', () => {
  it('leaves a Job on a user Deployment to the targeted-Job refusal', async () => {
    await expect(
      fake([window({ managed: false })]).prepare('job-1', false),
    ).resolves.toBeNull();
  });

  it.each([
    [WorkloadState.Queued, null],
    [WorkloadState.Retrying, window().attempt],
  ])('says not ready while the Job is %s', async (state, attempt) => {
    await expect(
      fake([window({ state, attempt })]).prepare('job-1', true),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: LOGS_CONTAINER_NOT_READY,
      clientError: `Job job-1 is ${state} and waits for a replica; check anycloud status job-1.`,
    });
  });

  it("streams the replica's log from the claim while the Job runs", async () => {
    const { prepare, logCall } = fake(
      [window()],
      '2026-10-14T10:00:00.900000000Z last Job\n2026-10-14T10:00:01.100000000Z this Job\n',
    );

    await expect(output(prepare('job-1', false))).resolves.toBe('this Job\n');
    expect(logCall.mock.calls[0]?.[4]).toMatchObject({
      timestamps: true,
      sinceTime: '2026-10-14T10:00:01.000Z',
    });
  });

  it("ends a followed log with the Job, holding back a line until a read shows it isn't the next Job's", async () => {
    const now = Date.now();
    const stamp = (ms: number) => new Date(ms).toISOString();
    const live = window({
      attempt: {
        podUid: 'uid-1',
        openedAt: now - 1_000,
        endedAt: null,
        tail: null,
      },
    });
    const ended = window({
      attempt: { ...live.attempt!, endedAt: now + 1_000 },
    });
    const { prepare, logCall } = fake([live, live, ended]);
    // An open `pods/log` follow: a line from the Job, then one from the next.
    logCall.mockImplementation(async (...args: unknown[]) => {
      const sink = args[3] as Writable;
      sink.write(`${stamp(now)} mine\n`);
      setTimeout(() => sink.write(`${stamp(now + 5_000)} next\n`), 10);
      return new AbortController();
    });

    await expect(output(prepare('job-1', true))).resolves.toBe('mine\n');
  }, 15_000);

  it('serves the tail kept at the end once the Job has ended, or says why there is none', async () => {
    const ended = (tail: PoolJobLogTail) =>
      window({
        state: WorkloadState.Completed,
        attempt: { ...window().attempt!, endedAt: CLAIM + 5, tail },
      });

    await expect(
      output(
        fake([ended({ state: 'captured', text: 'done\n' })]).prepare(
          'job-1',
          true,
        ),
      ),
    ).resolves.toBe('done\n');
    await expect(
      fake([
        ended({
          state: 'unavailable',
          text: 'Its Pod was gone before its log was read.',
        }),
      ]).prepare('job-1', true),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        clientError:
          'The log of Job job-1 is unavailable: Its Pod was gone before its log was read.',
      }),
    );
    const never = await fake([
      window({ state: WorkloadState.Invalid, attempt: null }),
    ]).prepare('job-1', true);
    expect(never).toMatchObject({
      ok: false,
      clientError: 'Job job-1 never started.',
    });
    expect(never).not.toHaveProperty('code');
  });
});
