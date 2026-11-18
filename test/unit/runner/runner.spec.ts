import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkloadExecution } from '../../../src/shared/api-contract/deployment-workload-schemas.js';
import { FenceError, type RunnerApi } from '../../../src/runner/api.js';
import {
  runJob,
  runRunner,
  type RunnerPorts,
  runnerExitCode,
} from '../../../src/runner/runner.js';
import type { CopyResult } from '../../../src/runner/transfer.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ok: CopyResult = { result: 'done', detail: '', moved: true };
const fail = (
  result: CopyResult['result'],
  detail: string = result,
): CopyResult => ({
  result,
  detail,
  moved: false,
});
type Grant = NonNullable<WorkloadExecution['storage']['input']>;
const grant = (remote: string, expiresAt = Date.now() + 36 * HOUR): Grant => ({
  remote,
  env: { RCLONE_CONFIG_REMOTE_TYPE: 'azureblob' },
  expiresAt,
});

function spec(overrides: Partial<WorkloadExecution> = {}): WorkloadExecution {
  return {
    command: ['python', 'train.py', '--epochs', '3'],
    env: { SEED: '1' },
    timeLimitSeconds: null,
    storage: {
      input: grant('in:dataset'),
      output: grant('out:results/job-1/'),
      checkpoint: grant('ckpt:state/job-1/'),
    },
    ...overrides,
  };
}

/**
 * A fake claim API, rclone and command. `events` records every call in
 * order; each test drives the command and the clock.
 */
function harness(
  options: {
    spec?: WorkloadExecution;
    copies?: Array<(to: string) => CopyResult | undefined>;
    renewals?: Array<() => Promise<WorkloadExecution>>;
  } = {},
) {
  const events: string[] = [];
  let exit!: (code: number) => void;
  let terminate!: () => void;
  let renewals = 0;
  const api: RunnerApi = {
    candidate: vi.fn(async () => null),
    claim: vi.fn(async () => true),
    execution: vi.fn(async () => {
      if (renewals > 0) {
        const renewal = options.renewals?.[renewals - 1];
        renewals++;
        if (renewal) return renewal();
      }
      renewals++;
      return options.spec ?? spec();
    }),
    report: vi.fn(async (_job, report) => {
      events.push(
        'phase' in report
          ? `phase ${report.phase}`
          : `report ${JSON.stringify(report.cause)}`,
      );
    }),
    cancelled: vi.fn(
      (_job: string, _execution: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve, reject) => {
          terminate = () => resolve(true);
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ),
    cleanup: vi.fn(async () => {
      events.push('cleanup');
    }),
  };
  const ports: RunnerPorts = {
    api,
    copy: vi.fn(async (from: string, to: string, _env, sync?: boolean) => {
      events.push(`${sync ? 'sync' : 'copy'} ${from} ${to}`);
      return options.copies?.shift()?.(to) ?? ok;
    }),
    entrypoint: ['/entrypoint.sh'],
    cmd: ['serve'],
    stopGraceMs: 60_000,
    start: vi.fn((argv: string[]) => {
      events.push(`start ${argv.join(' ')}`);
      return new Promise<number>((resolve) => {
        exit = resolve;
      });
    }),
    killAll: vi.fn((signal) => {
      events.push(`kill ${signal}`);
      exit?.(signal === 'SIGTERM' ? 143 : 137);
    }),
    oomKills: vi.fn(async () => 0),
    reset: vi.fn(async () => {
      events.push('reset');
    }),
    empty: vi.fn(async (dir: string) => {
      events.push(`empty ${dir}`);
    }),
    log: () => {},
  };
  return {
    events,
    ports,
    api,
    exit: (code: number) => exit(code),
    terminate: () => terminate(),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Serve these Jobs, then long-poll empty as the API does. */
function serve(api: RunnerApi, ...jobIds: string[]) {
  const candidates = jobIds.map((jobId) => ({
    jobId,
    submissionRevision: 0,
    previousExecutionId: null,
  }));
  vi.mocked(api.candidate).mockImplementation(
    async (signal) =>
      candidates.shift() ??
      new Promise((resolve, reject) => {
        const wait = setTimeout(() => resolve(null), 20_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(wait);
          reject(new Error('aborted'));
        });
      }),
  );
}

describe('the runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stages, runs the command unmodified, uploads every minute and reports only after the final upload', async () => {
    const h = harness();
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    expect(h.ports.start).toHaveBeenCalledWith(
      ['/entrypoint.sh', 'python', 'train.py', '--epochs', '3'],
      { SEED: '1' },
    );
    await vi.advanceTimersByTimeAsync(MIN);
    h.exit(0);
    await job;
    expect(h.events).toEqual([
      'empty /mnt/input',
      'sync in:dataset /mnt/input',
      'copy ckpt:state/job-1/ /mnt/checkpoint',
      'phase running',
      'start /entrypoint.sh python train.py --epochs 3',
      'copy /mnt/output out:results/job-1/',
      'copy /mnt/checkpoint ckpt:state/job-1/',
      'phase finalizing',
      'copy /mnt/output out:results/job-1/',
      'copy /mnt/checkpoint ckpt:state/job-1/',
      'report {"kind":"exit","code":0,"oom":false}',
    ]);
  });

  it("runs the image's Cmd after its Entrypoint when the Job has no command", async () => {
    const h = harness({ spec: spec({ command: [] }) });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    expect(h.ports.start).toHaveBeenCalledWith(['/entrypoint.sh', 'serve'], {
      SEED: '1',
    });
    h.exit(0);
    await job;
  });

  it('restarts the replica after an OOM kill outside the command, as on a fenced execution', async () => {
    const h = harness();
    // A staging rclone or a forked worker was OOM-killed in the container.
    vi.mocked(h.ports.oomKills).mockResolvedValue(1);
    vi.mocked(h.api.cancelled).mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new FenceError('stale')), 1_000),
        ),
    );
    serve(h.api, 'job-1', 'job-2');
    const runner = runRunner(h.ports, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(runner).resolves.toBe('restart');
    expect(h.api.claim).toHaveBeenCalledTimes(1);
    // Only the reset before the first claim: the restart resets next.
    expect(h.events.filter((event) => event === 'reset')).toHaveLength(1);
  });

  it("empties /mnt/input for a Job without inputs, so it sees none of the last Job's", async () => {
    const { input: _input, ...storage } = spec().storage;
    const h = harness({ spec: spec({ storage }) });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    expect(h.events.slice(0, 2)).toEqual([
      'empty /mnt/input',
      'copy ckpt:state/job-1/ /mnt/checkpoint',
    ]);
    h.exit(0);
    await job;
  });

  it('keeps /mnt/input for a Job of the same input bucket and empties it for another', async () => {
    const replica = {};
    const run = async (input: ReturnType<typeof grant>) => {
      const h = harness({
        spec: spec({ storage: { ...spec().storage, input } }),
      });
      const job = runJob(
        h.ports,
        'job',
        'exec',
        new AbortController().signal,
        replica,
      );
      await settle();
      h.exit(0);
      await job;
      return h.events.filter((event) => event.endsWith('/mnt/input'));
    };
    expect(await run(grant('in:dataset'))).toEqual([
      'empty /mnt/input',
      'sync in:dataset /mnt/input',
    ]);
    // A fresh credential for the same bucket keeps the synced inputs.
    expect(
      await run({
        ...grant('in:dataset'),
        env: {
          RCLONE_CONFIG_REMOTE_TYPE: 'azureblob',
          RCLONE_CONFIG_REMOTE_SAS_URL: 'renewed',
        },
      }),
    ).toEqual(['sync in:dataset /mnt/input']);
    expect(await run(grant('in:other'))).toEqual([
      'empty /mnt/input',
      'sync in:other /mnt/input',
    ]);
  });

  it('restarts the replica after a Job was OOM-killed, before claiming another', async () => {
    const h = harness();
    serve(h.api, 'job-1', 'job-2');
    vi.mocked(h.ports.oomKills).mockResolvedValueOnce(0).mockResolvedValue(1);
    const runner = runRunner(h.ports, new AbortController().signal);
    await settle();
    h.exit(137);
    await expect(runner).resolves.toBe('restart');
    expect(h.api.claim).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toBe(
      'report {"kind":"exit","code":137,"oom":true}',
    );
  });

  it('reports a non-zero exit with the OOM kill the cgroup counted', async () => {
    const h = harness();
    vi.mocked(h.ports.oomKills).mockResolvedValueOnce(2).mockResolvedValue(3);
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    h.exit(137);
    await job;
    expect(h.events.at(-1)).toBe(
      'report {"kind":"exit","code":137,"oom":true}',
    );
  });

  it('treats a missing checkpoint as a first attempt and a missing input bucket as invalid', async () => {
    const first = harness({ copies: [() => ok, () => fail('missing')] });
    const job = runJob(
      first.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    expect(first.ports.start).toHaveBeenCalled();
    first.exit(0);
    await job;

    const missing = harness({ copies: [() => fail('missing', 'not found')] });
    await runJob(
      missing.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    expect(missing.ports.start).not.toHaveBeenCalled();
    expect(missing.events.at(-1)).toBe(
      'report {"kind":"unrecoverable","detail":"Could not stage the input bucket: not found"}',
    );
  });

  it('retries a stalled staging copy and stays syncing until it succeeds (RFC 0043 S8)', async () => {
    const h = harness({
      copies: [() => fail('stalled'), () => fail('failed')],
    });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    expect(h.events).toEqual([
      'empty /mnt/input',
      'sync in:dataset /mnt/input',
    ]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(h.ports.start).toHaveBeenCalled();
    expect(
      h.events.filter((event) => event === 'sync in:dataset /mnt/input'),
    ).toHaveLength(3);
    h.exit(0);
    await job;
  });

  it('keeps a Job finalizing while its output bucket is missing, completes once it returns, and fails after 15 min without progress (0044/S20)', async () => {
    const missing = () => fail('failed', 'container not found');
    const recovers = harness({
      copies: [() => ok, () => ok, missing, () => ok, missing, () => ok],
    });
    let job = runJob(
      recovers.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    recovers.exit(0);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await job;
    expect(recovers.events.at(-1)).toBe(
      'report {"kind":"exit","code":0,"oom":false}',
    );

    const gone = harness({
      copies: [() => ok, () => ok, ...Array(100).fill(missing)],
    });
    job = runJob(gone.ports, 'job-1', 'exec-1', new AbortController().signal);
    await settle();
    gone.exit(0);
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(gone.events.at(-1)).not.toMatch(/^report/);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await job;
    expect(gone.events.at(-1)).toBe(
      'report {"kind":"transfer","detail":"container not found"}',
    );
  });

  it('stops the command at its time limit, uploads and reports the deadline', async () => {
    const h = harness({ spec: spec({ timeLimitSeconds: 90 }) });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await job;
    expect(h.events.slice(-5)).toEqual([
      'kill SIGTERM',
      'phase finalizing',
      'copy /mnt/output out:results/job-1/',
      'copy /mnt/checkpoint ckpt:state/job-1/',
      'report {"kind":"deadline","detail":"Time limit of 90s reached"}',
    ]);
  });

  it('kills a command that ignores SIGTERM after the grace', async () => {
    const h = harness({ spec: spec({ timeLimitSeconds: 1 }) });
    vi.mocked(h.ports.killAll).mockImplementation((signal) => {
      h.events.push(`kill ${signal}`);
      if (signal === 'SIGKILL') h.exit(137);
    });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.events.at(-1)).toBe('kill SIGTERM');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.events).not.toContain('kill SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    await job;
    expect(h.events).toContain('kill SIGKILL');
  });

  it('on terminate stops the command, runs the final upload and releases the slot (0044/S8)', async () => {
    const h = harness();
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    h.terminate();
    await job;
    expect(h.events.slice(-4)).toEqual([
      'kill SIGTERM',
      'copy /mnt/output out:results/job-1/',
      'copy /mnt/checkpoint ckpt:state/job-1/',
      'cleanup',
    ]);
  });

  it.each(['terminate', 'sigterm'] as const)(
    'reports an exit that won the race when a %s lands during the last periodic upload',
    async (stop) => {
      const h = harness();
      const shutdown = new AbortController();
      const job = runJob(h.ports, 'job-1', 'exec-1', shutdown.signal);
      await settle();
      let uploaded!: () => void;
      vi.mocked(h.ports.copy).mockImplementationOnce(async (from, to) => {
        h.events.push(`copy ${from} ${to}`);
        await new Promise<void>((resolve) => (uploaded = resolve));
        return ok;
      });
      await vi.advanceTimersByTimeAsync(MIN);
      h.exit(0);
      await settle();
      if (stop === 'terminate') h.terminate();
      else shutdown.abort();
      await settle();
      uploaded();
      await job;
      expect(h.events).not.toContain('kill SIGTERM');
      expect(h.events.slice(-4)).toEqual([
        'phase finalizing',
        'copy /mnt/output out:results/job-1/',
        'copy /mnt/checkpoint ckpt:state/job-1/',
        'report {"kind":"exit","code":0,"oom":false}',
      ]);
    },
  );

  it('reports an exit when a terminate lands in the same microtask flush', async () => {
    const h = harness();
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await settle();
    h.exit(0);
    h.terminate();
    await job;
    expect(h.events).not.toContain('cleanup');
    expect(h.events.slice(-4)).toEqual([
      'phase finalizing',
      'copy /mnt/output out:results/job-1/',
      'copy /mnt/checkpoint ckpt:state/job-1/',
      'report {"kind":"exit","code":0,"oom":false}',
    ]);
  });

  it.each([
    ['SIGTERM', 'failed', []],
    [
      'credential expiry',
      'denied',
      [
        'report {"kind":"disrupted","detail":"storage credentials expired before they could be renewed"}',
      ],
    ],
  ] as const)(
    'keeps a %s that lands during the last periodic upload for a failing final upload',
    async (stop, failure, report) => {
      const h = harness({
        spec: spec({
          storage: { output: grant('out:o/', Date.now() + 3 * MIN) },
        }),
        renewals: [() => new Promise(() => {})],
      });
      const shutdown = new AbortController();
      let ended = false;
      const job = runJob(h.ports, 'job-1', 'exec-1', shutdown.signal).then(
        () => (ended = true),
      );
      await settle();
      let uploaded!: () => void;
      vi.mocked(h.ports.copy)
        .mockImplementation(async (from, to) => {
          h.events.push(`copy ${from} ${to}`);
          return fail(failure);
        })
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => (uploaded = resolve));
          return ok;
        });
      await vi.advanceTimersByTimeAsync(MIN);
      h.exit(0);
      await settle();
      if (stop === 'SIGTERM') shutdown.abort();
      else await vi.advanceTimersByTimeAsync(2 * MIN);
      uploaded();
      // A SIGTERM gets one try within the grace; expired credentials none.
      await vi.advanceTimersByTimeAsync(MIN);
      expect(ended).toBe(true);
      await job;
      expect(h.events.slice(h.events.indexOf('phase finalizing'))).toEqual([
        'phase finalizing',
        ...(stop === 'SIGTERM' ? ['copy /mnt/output out:o/'] : []),
        ...report,
      ]);
    },
  );

  it.each([
    [143, []],
    [1, ['report {"kind":"exit","code":1,"oom":false}']],
  ] as const)(
    'when the replica SIGTERM follows an exit %i, reports no outcome only for the SIGTERM exit',
    async (code, report) => {
      const h = harness();
      const shutdown = new AbortController();
      const job = runJob(h.ports, 'job-1', 'exec-1', shutdown.signal);
      await settle();
      let uploaded!: () => void;
      vi.mocked(h.ports.copy).mockImplementationOnce(async (from, to) => {
        h.events.push(`copy ${from} ${to}`);
        await new Promise<void>((resolve) => (uploaded = resolve));
        return ok;
      });
      // A Node shutdown signals every process in the container at once, so
      // the command's exit can reach the runner before its own SIGTERM.
      h.exit(code);
      await settle();
      shutdown.abort();
      uploaded();
      await job;
      expect(h.events.slice(h.events.indexOf('phase finalizing'))).toEqual([
        'phase finalizing',
        'copy /mnt/output out:results/job-1/',
        'copy /mnt/checkpoint ckpt:state/job-1/',
        ...report,
      ]);
    },
  );

  it('exits 143 on a replica SIGTERM, so a limit eviction keeps its reason (0043/S12)', () => {
    expect(runnerExitCode('stopped')).toBe(143);
    expect(runnerExitCode('restart')).toBe(1);
  });

  it('on a replica SIGTERM uploads once, reports no outcome and claims nothing more', async () => {
    const h = harness({ copies: [() => ok, () => ok, () => fail('failed')] });
    serve(h.api, 'job-1', 'job-2');
    const shutdown = new AbortController();
    const runner = runRunner(h.ports, shutdown.signal);
    await settle();
    shutdown.abort();
    await runner;
    expect(h.api.claim).toHaveBeenCalledTimes(1);
    // A drain, an upgrade and a storage eviction all send SIGTERM; the
    // Deployment owner tells them apart from the held Pod (RFC 0043 S12).
    expect(h.events.slice(-4)).toEqual([
      'kill SIGTERM',
      'phase finalizing',
      'copy /mnt/output out:results/job-1/',
      'copy /mnt/checkpoint ckpt:state/job-1/',
    ]);
    expect(h.events.some((event) => event.startsWith('report'))).toBe(false);
  });

  it('resets before its first claim, as a restarted container keeps the fixed paths, and exits when a reset fails', async () => {
    const h = harness();
    serve(h.api, 'job-1');
    vi.mocked(h.ports.reset).mockRejectedValueOnce(new Error('EACCES'));
    await expect(
      runRunner(h.ports, new AbortController().signal),
    ).rejects.toThrow('EACCES');
    expect(h.api.candidate).not.toHaveBeenCalled();
  });

  it("exits on a fenced candidate poll, as when a restore dropped its Deployment's record (RFC 0049 C27)", async () => {
    const h = harness();
    vi.mocked(h.api.candidate).mockRejectedValue(
      new FenceError('Deployment not found'),
    );
    // The container exits and Kubernetes restarts it: a crash loop, never a
    // claim against a Deployment the API no longer holds.
    await expect(
      runRunner(h.ports, new AbortController().signal),
    ).rejects.toBeInstanceOf(FenceError);
    expect(h.api.candidate).toHaveBeenCalledOnce();
    expect(h.api.claim).not.toHaveBeenCalled();
  });

  it('resets after a Job, not after an empty poll', async () => {
    const h = harness();
    serve(h.api, 'job-1');
    const shutdown = new AbortController();
    const runner = runRunner(h.ports, shutdown.signal);
    await settle();
    h.exit(0);
    await vi.advanceTimersByTimeAsync(60_000);
    shutdown.abort();
    await runner;
    expect(h.ports.reset).toHaveBeenCalledTimes(2);
  });

  it('claims the next Job only after the outcome is reported and the replica reset', async () => {
    const h = harness();
    serve(h.api, 'job-1', 'job-2');
    vi.mocked(h.api.claim).mockImplementation(async (candidate) => {
      h.events.push(`claim ${candidate.jobId}`);
      return true;
    });
    const shutdown = new AbortController();
    const runner = runRunner(h.ports, shutdown.signal);
    await settle();
    h.exit(0);
    await settle();
    const second = h.events.indexOf('claim job-2');
    expect(h.events.slice(second - 2, second)).toEqual([
      'report {"kind":"exit","code":0,"oom":false}',
      'reset',
    ]);
    h.exit(0);
    await settle();
    shutdown.abort();
    await runner;
  });

  it('renews credentials through an API outage shorter than their lifetime (RFC 0043 S5)', async () => {
    let apiUp = false;
    const outage = () =>
      new Promise<WorkloadExecution>((resolve) => {
        const poll = setInterval(() => {
          if (!apiUp) return;
          clearInterval(poll);
          resolve(spec());
        }, MIN);
      });
    const h = harness({ renewals: [outage] });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(18 * HOUR + 5 * HOUR);
    apiUp = true;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(h.api.execution).toHaveBeenCalledTimes(2);
    expect(h.events).not.toContain('kill SIGTERM');
    h.exit(0);
    await job;
  });

  it('stops the command and reports the Job retrying when credentials expire before renewal (RFC 0043 S5)', async () => {
    const h = harness({ renewals: [() => new Promise(() => {})] });
    const job = runJob(
      h.ports,
      'job-1',
      'exec-1',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(36 * HOUR);
    await job;
    expect(h.events.slice(-3)).toEqual([
      'kill SIGTERM',
      'phase finalizing',
      'report {"kind":"disrupted","detail":"storage credentials expired before they could be renewed"}',
    ]);
  });

  it('drops an execution the API fenced off: no upload, no report, then reset (S14)', async () => {
    const h = harness();
    vi.mocked(h.api.cancelled).mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new FenceError('stale')), 1_000),
        ),
    );
    serve(h.api, 'job-1');
    const shutdown = new AbortController();
    const runner = runRunner(h.ports, shutdown.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    shutdown.abort();
    await runner;
    expect(h.events.slice(-2)).toEqual(['kill SIGTERM', 'reset']);
    expect(h.api.report).toHaveBeenCalledTimes(1); // phase running only
  });
});
