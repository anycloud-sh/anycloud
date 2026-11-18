import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock('token'),
);
import { runWait } from '../../../src/cli/commands/wait.js';
import { ORPCError } from '@orpc/client';
import {
  WAIT_EXIT,
  parseWaitTarget,
  parseWaitTimeout,
  waitForTargets,
  type WaitDependencies,
  type WaitObservation,
} from '../../../src/cli/use-cases/workload-wait.js';
import { formatWaitRecord } from '../../../src/cli/renderers/workload-wait.js';
import type { WorkloadStatusResponse } from '../../../src/shared/api-contract/workload-management-schemas.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../../src/shared/runtime.js';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud.js';
import { LocalApiUnavailableError } from '../../../src/shared/services/api-client/runtime.js';
import {
  makeStatusWorkloadMetadata,
  makeWorkloadEvent,
} from '../helpers/fixtures.js';
import type { ClusterSummary } from '../../../src/shared/api-contract/clusters-schemas.js';

const START = Date.parse('2026-10-02T19:00:00Z');

type Step = WorkloadState | Error | WorkloadStatusResponse | WaitObservation;

const waitForWorkloads = (
  references: readonly string[],
  deps: WaitDependencies,
  options: Parameters<typeof waitForTargets>[2],
) => waitForTargets(references.map(parseWaitTarget), deps, options);

function status(
  id: string,
  state: WorkloadState,
  workloadType = WorkloadType.Job,
  extra: Partial<WorkloadStatusResponse> = {},
): WorkloadStatusResponse {
  return {
    workload: makeStatusWorkloadMetadata({ id, workloadType, state }),
    events: [],
    status: WorkloadHealthStatus.Unknown,
    ...extra,
  };
}

/**
 * Scripted status reads on a fake clock: each read of an id consumes its next
 * step (the last repeats), and each sleep advances the clock.
 */
function harness(
  script: Record<string, Step[]>,
  types: Record<string, WorkloadType> = {},
  json = false,
) {
  let clock = START;
  const reads: string[] = [];
  const lines: string[] = [];
  const cursor: Record<string, number> = {};
  const deps: WaitDependencies = {
    read: async (target) => {
      const id = target.id;
      reads.push(id);
      const steps = script[id];
      const index = Math.min(cursor[id] ?? 0, steps.length - 1);
      cursor[id] = index + 1;
      const step = steps[index];
      if (step instanceof Error) throw step;
      if (typeof step === 'string') {
        return {
          kind: 'workload',
          status: status(id, step, types[id] ?? WorkloadType.Job),
        };
      }
      return 'kind' in step ? step : { kind: 'workload', status: step };
    },
    emit: (record) => lines.push(formatWaitRecord(record, json)),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { deps, lines, reads, elapsed: () => clock - START };
}

const S = WorkloadState;

describe('waitForWorkloads', () => {
  it('prints each state change once and exits 0 when a Job completes', async () => {
    const { deps, lines } = harness({
      'train-a': [S.Queued, S.Running, S.Running, S.Running, S.Completed],
    });
    await expect(waitForWorkloads(['train-a'], deps, {})).resolves.toBe(
      WAIT_EXIT.succeeded,
    );
    expect(lines).toEqual([
      '[19:00:00] train-a queued',
      '[19:00:05] train-a running',
      '[19:00:20] train-a completed',
      '[19:00:20] succeeded: train-a',
    ]);
  });

  it.each([S.Errored, S.Failed, S.Invalid, S.Terminated])(
    'exits 1 when a Job ends %s',
    async (state) => {
      const { deps, lines } = harness({ job: [S.Running, state] });
      await expect(waitForWorkloads(['job'], deps, {})).resolves.toBe(
        WAIT_EXIT.failed,
      );
      expect(lines.at(-1)).toBe('[19:00:05] failed: job');
    },
  );

  it('names the exit code of an errored Job', async () => {
    const errored = status('job', S.Errored, WorkloadType.Job, {
      events: [
        makeWorkloadEvent({
          state: S.Errored,
          createdAt: START,
          metadata: { exitCode: 2 },
        }),
      ],
    });
    const { deps, lines } = harness({ job: [errored] });
    await waitForWorkloads(['job'], deps, {});
    expect(lines[0]).toBe('[19:00:00] job errored (exit 2)');
  });

  it("names a failed Job's message when it has no reason", async () => {
    const errored = status('job', S.Errored, WorkloadType.Job, {
      events: [
        makeWorkloadEvent({
          state: S.Errored,
          createdAt: START,
          metadata: { message: 'bad input' },
        }),
      ],
    });
    const { deps, lines } = harness({ job: [errored] });
    await waitForWorkloads(['job'], deps, {});
    expect(lines[0]).toBe('[19:00:00] job errored: bad input');
  });

  it('returns when a VM or Service is Running, without waiting for an end', async () => {
    const { deps, lines, reads } = harness(
      { vm: [S.Provisioning, S.Running], svc: [S.Running] },
      { vm: WorkloadType.Vm, svc: WorkloadType.Service },
    );
    await expect(waitForWorkloads(['vm', 'svc'], deps, {})).resolves.toBe(
      WAIT_EXIT.succeeded,
    );
    expect(lines).toEqual([
      '[19:00:00] vm provisioning',
      '[19:00:00] svc running (ready)',
      '[19:00:05] vm running (ready)',
      '[19:00:05] succeeded: vm, svc',
    ]);
    expect(reads.filter((id) => id === 'svc')).toHaveLength(1);
  });

  it('fails a VM that ends before it is ready', async () => {
    const { deps } = harness(
      { vm: [S.Provisioning, S.Failed] },
      { vm: WorkloadType.Vm },
    );
    await expect(waitForWorkloads(['vm'], deps, {})).resolves.toBe(
      WAIT_EXIT.failed,
    );
  });

  it('reports an early failure at once and still collects the rest', async () => {
    const { deps, lines } = harness({
      a: [S.Errored],
      b: [S.Running, S.Running, S.Completed],
    });
    await expect(waitForWorkloads(['a', 'b'], deps, {})).resolves.toBe(
      WAIT_EXIT.failed,
    );
    expect(lines).toEqual([
      '[19:00:00] a errored',
      '[19:00:00] b running',
      '[19:00:10] b completed',
      '[19:00:10] failed: a; succeeded: b',
    ]);
  });

  it('prints a heartbeat after 30 minutes without a change', async () => {
    const steps: Step[] = Array.from({ length: 800 }, () => S.Running);
    steps.push(S.Completed);
    const { deps, lines } = harness({ long: steps });
    await waitForWorkloads(['long'], deps, {});
    expect(lines.filter((line) => line.includes('observing'))).toEqual([
      '[19:30:00] observing: 1 running; elapsed 30m',
      '[20:00:00] observing: 1 running; elapsed 1h 0m',
    ]);
  });

  it('rides out transient API errors and reports degraded and recovered once', async () => {
    const outage = new ORPCError('SERVICE_UNAVAILABLE', { status: 503 });
    const { deps, lines } = harness({
      job: [S.Running, outage, new TypeError('fetch failed'), S.Completed],
    });
    await expect(waitForWorkloads(['job'], deps, {})).resolves.toBe(
      WAIT_EXIT.succeeded,
    );
    expect(lines.filter((line) => line.includes('observer'))).toEqual([
      expect.stringMatching(/observer degraded: .*retrying/),
      expect.stringContaining('observer recovered'),
    ]);
  });

  it('stops with exit 2 on a permanent error such as not found', async () => {
    const { deps, lines } = harness({
      gone: [new ORPCError('NOT_FOUND', { status: 404, message: 'missing' })],
    });
    await expect(waitForWorkloads(['gone'], deps, {})).resolves.toBe(
      WAIT_EXIT['observer-error'],
    );
    expect(lines.at(-1)).toContain('gone: missing');
  });

  it('stops with exit 2 when the local API is not running', async () => {
    const { deps } = harness({
      job: [new LocalApiUnavailableError('No local API is running')],
    });
    await expect(waitForWorkloads(['job'], deps, {})).resolves.toBe(
      WAIT_EXIT['observer-error'],
    );
  });

  it('exits 4 when the timeout elapses, leaving the Workload running', async () => {
    const { deps, lines, elapsed } = harness({ job: [S.Running] });
    await expect(
      waitForWorkloads(['job'], deps, { timeoutMs: 60_000 }),
    ).resolves.toBe(WAIT_EXIT.timeout);
    expect(elapsed()).toBe(60_000);
    expect(lines.at(-1)).toBe(
      '[19:01:00] timed out after 1m; still waiting on: job',
    );
  });

  it('carries retry facts on a retrying line', async () => {
    const retrying = status('job', S.Retrying, WorkloadType.Job, {
      workload: makeStatusWorkloadMetadata({
        id: 'job',
        state: S.Retrying,
        spot: true,
      }),
      events: [
        makeWorkloadEvent({
          state: S.Retrying,
          createdAt: START,
          metadata: {
            diagnosis: CloudFailureDiagnosis.CapacityExhausted,
            targetVmType: 'g5.xlarge',
            targetAvailabilityZone: 'us-east-2b',
          },
        }),
      ],
      retry: {
        attempt: 3,
        earliestAt: Date.parse('2026-10-02T19:01:00Z'),
        latestAt: Date.parse('2026-10-02T19:05:00Z'),
      },
    });
    const { deps, lines } = harness({ job: [retrying, S.Completed] });
    await waitForWorkloads(['job'], deps, {});
    expect(lines[0]).toBe(
      '[19:00:00] job retrying (attempt 3, Spot capacity unavailable, g5.xlarge us-east-2b; next 19:01–19:05)',
    );
    const json = harness({ job: [retrying, S.Completed] }, {}, true);
    await waitForWorkloads(['job'], json.deps, {});
    expect(JSON.parse(json.lines[0]).retry).toEqual({
      attempt: 3,
      diagnosis: 'capacity-exhausted',
      target: ['g5.xlarge', 'us-east-2b'],
      earliestAt: '2026-10-02T19:01:00.000Z',
      latestAt: '2026-10-02T19:05:00.000Z',
    });
  });

  it('emits NDJSON records with --json', async () => {
    const { deps, lines } = harness(
      { vm: [S.Provisioning, S.Running] },
      { vm: WorkloadType.Vm },
      true,
    );
    await waitForWorkloads(['vm'], deps, {});
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'state',
        observedAt: '2026-10-02T19:00:00.000Z',
        ref: 'vm',
        kind: 'workload',
        previousState: null,
        state: 'provisioning',
      },
      {
        type: 'state',
        observedAt: '2026-10-02T19:00:05.000Z',
        ref: 'vm',
        kind: 'workload',
        previousState: 'provisioning',
        state: 'running',
        ready: true,
      },
      {
        type: 'result',
        observedAt: '2026-10-02T19:00:05.000Z',
        outcome: 'succeeded',
        succeeded: ['vm'],
        failed: [],
        pending: [],
      },
    ]);
  });

  it("RFC 0049 C15: carries a Job's end reason in --json", async () => {
    const ended = status('job', S.Failed);
    ended.workload.endReason = 'retries-exhausted';
    ended.workload.lastAttemptEndReason = 'reclaimed';
    const { deps, lines } = harness({ job: [ended] }, {}, true);
    await waitForWorkloads(['job'], deps, {});
    expect(JSON.parse(lines[0])).toMatchObject({
      state: 'failed',
      endReason: 'retries-exhausted',
      lastAttemptEndReason: 'reclaimed',
    });
  });

  it('propagates an abort without printing a result', async () => {
    const controller = new AbortController();
    const { deps, lines } = harness({ job: [S.Running] });
    deps.sleep = async () => {
      controller.abort(new Error('interrupted'));
      throw controller.signal.reason;
    };
    await expect(
      waitForWorkloads(['job'], deps, { signal: controller.signal }),
    ).rejects.toThrow('interrupted');
    expect(lines).toEqual(['[19:00:00] job running']);
  });
});

describe('parseWaitTimeout', () => {
  it('accepts seconds, minutes and hours', () => {
    expect(parseWaitTimeout('90s')).toBe(90_000);
    expect(parseWaitTimeout('30m')).toBe(1_800_000);
    expect(parseWaitTimeout('2h')).toBe(7_200_000);
  });

  it.each(['', '30', '0m', '-1h', '1.5h', '1d'])('rejects %j', (value) => {
    expect(() => parseWaitTimeout(value)).toThrow('--timeout');
  });
});

describe('runWait', () => {
  it('rejects a malformed timeout before contacting the API', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runWait(['job'], { timeout: '5' })).resolves.toBe(
        WAIT_EXIT['observer-error'],
      );
      expect(errors.mock.calls.flat().join(' ')).toContain('--timeout');
    } finally {
      errors.mockRestore();
    }
  });
});

describe('parseWaitTarget', () => {
  it('reads cluster references and bare Workload IDs', () => {
    expect(parseWaitTarget('train-a')).toEqual({
      kind: 'workload',
      id: 'train-a',
    });
    expect(parseWaitTarget('cluster/main')).toEqual({
      kind: 'cluster',
      id: 'main',
    });
    expect(() => parseWaitTarget('deployment/api')).toThrow('cluster/<id>');
  });
});

describe('waiting on clusters and Workload reasons', () => {
  const cluster = (
    state: ClusterSummary['state'],
    lastError: string | null = null,
  ): WaitObservation => {
    const summary: Partial<ClusterSummary> = { id: 'main', state, lastError };
    return { kind: 'cluster', cluster: summary as ClusterSummary };
  };

  it('is ready when a cluster runs, and fails when it fails', async () => {
    const ok = harness({
      main: [cluster(S.Provisioning), cluster(S.Running)],
    });
    await expect(waitForWorkloads(['cluster/main'], ok.deps, {})).resolves.toBe(
      WAIT_EXIT.succeeded,
    );
    expect(ok.lines.at(-1)).toBe('[19:00:05] succeeded: cluster/main');

    const bad = harness({ main: [cluster(S.Failed, 'quota exceeded')] });
    await expect(
      waitForWorkloads(['cluster/main'], bad.deps, {}),
    ).resolves.toBe(WAIT_EXIT.failed);
    expect(bad.lines[0]).toBe('[19:00:00] cluster/main failed: quota exceeded');
  });

  it('says why a Workload waits or ended', async () => {
    const blocked = (message: string) =>
      status('svc', S.Queued, WorkloadType.Service, {
        events: [makeWorkloadEvent({ state: S.Queued, metadata: { message } })],
      });
    const ended = status('job', S.Terminated, WorkloadType.Job, {
      events: [
        makeWorkloadEvent({
          state: S.Terminated,
          metadata: { reason: 'spend-cap' },
        }),
      ],
    });
    const { deps, lines } = harness(
      {
        svc: [
          blocked('Spend cap reached'),
          blocked('Waiting for capacity'),
          S.Running,
        ],
        job: [S.Queued, ended],
      },
      { svc: WorkloadType.Service },
    );
    await expect(waitForWorkloads(['svc', 'job'], deps, {})).resolves.toBe(
      WAIT_EXIT.failed,
    );
    expect(lines.slice(0, 5)).toEqual([
      '[19:00:00] svc queued: Spend cap reached',
      '[19:00:00] job queued',
      '[19:00:05] svc queued: Waiting for capacity',
      '[19:00:05] job terminated (spend-cap)',
      '[19:00:10] svc running (ready)',
    ]);
  });
});
