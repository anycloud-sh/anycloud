import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';
import BetterSqlite3 from 'better-sqlite3';
import config, { FAILED_DEPLOY_MAX_ATTEMPTS } from '../../../../src/api/config';
import {
  getDeploymentExecutionStore as executions,
  getWorkloadEventStore as eventLog,
  getWorkloadLifecycle as lifecycle,
  getWorkloadOutcomes as outcomes,
  getWorkloadQueryStore as queries,
  resetPersistence,
} from '../../../../src/api/services/persistence.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { runMigrations } from '../../../../src/api/services/repositories/migrations.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import {
  attemptEndOf,
  batchPolicy,
  DEPLOYMENT_POLICY,
  RUNNER_REPLICA_POLICY,
  UNUSABLE_GPU_POOL_RERUN,
  type Cause,
} from '../../../../src/api/services/job-outcome.js';
import {
  claimInput,
  createTarget,
  createTargetedJob,
  firstExecution,
  secondExecution,
} from '../../helpers/targeted-jobs.js';

function attempts(workloadId: string) {
  return getDB().query<Record<string, unknown>>(
    `SELECT a.attempt, a.execution_id AS executionId, a.substrate, a.outcome,
            a.cause, a.exit_code AS exitCode, a.reason,
            a.ended_at IS NOT NULL AS ended, p.pod_uid AS podUid, p.node
     FROM workload_attempts a LEFT JOIN pod_attempts p ON p.attempt_id = a.id
     WHERE a.workload_id = ? ORDER BY a.attempt`,
    [workloadId],
  );
}

/** Claim, end the first attempt as an OOM retry, and claim the second. */
async function retriedOnce(): Promise<void> {
  await createTarget();
  await createTargetedJob('job');
  const store = executions();
  await store.claimTargetedJob(claimInput('job', firstExecution));
  await store.recordPodNode(firstExecution, 'node-a');
  await expect(
    store.reportTargetedJobExecution('job', firstExecution, {
      state: WorkloadState.Retrying,
      reason: 'replica OOMKilled',
      cause: {
        kind: 'exit',
        code: 137,
        oom: true,
      },
    }),
  ).resolves.toBe(true);
  const retry = (await eventLog().getWorkloadEvents('job')).at(-1)!;
  await lifecycle().queueRetryCandidate('job', retry.id);
  await store.claimTargetedJob(
    claimInput('job', secondExecution, firstExecution, 'pod-b'),
  );
}

describe('workload attempts', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(() => resetPersistence());

  it('0044/S17 opens a Pod attempt per claim and closes it with its cause, leaving the Pod facts to their owner', async () => {
    await retriedOnce();

    expect(await attempts('job')).toEqual([
      {
        attempt: 1,
        executionId: firstExecution,
        substrate: 'pod',
        outcome: WorkloadState.Retrying,
        cause: 'exit',
        exitCode: 137,
        reason: 'replica OOMKilled',
        ended: 1,
        podUid: 'pod-a',
        node: 'node-a',
      },
      {
        attempt: 2,
        executionId: secondExecution,
        substrate: 'pod',
        outcome: null,
        cause: null,
        exitCode: null,
        reason: null,
        ended: 0,
        podUid: 'pod-b',
        node: null,
      },
    ]);
    await expect(
      executions().getTargetedExecution('job'),
    ).resolves.toMatchObject({
      executionId: secondExecution,
      generation: 1,
      podUid: 'pod-b',
      containerId: 'containerd://container-a',
    });
  });

  it('fences a stale execution and replays only the recorded end', async () => {
    await retriedOnce();
    const store = executions();

    await expect(
      store.reportTargetedJobExecution('job', firstExecution, {
        state: WorkloadState.Retrying,
        reason: 'replica OOMKilled',
      }),
    ).resolves.toBe(true);
    await expect(
      store.reportTargetedJobExecution('job', firstExecution, {
        state: WorkloadState.Retrying,
        reason: 'another reason',
      }),
    ).resolves.toBe(false);
    await expect(
      store.reportTargetedJobExecution('job', firstExecution, {
        state: WorkloadState.Completed,
      }),
    ).resolves.toBe(false);
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Running,
    });

    await expect(
      store.reportTargetedJobExecution('job', secondExecution, {
        state: WorkloadState.Completed,
      }),
    ).resolves.toBe(true);
    await expect(
      store.reportTargetedJobExecution('job', secondExecution, {
        state: WorkloadState.Completed,
      }),
    ).resolves.toBe(true);
    await expect(
      store.reportTargetedJobExecution('job', secondExecution, {
        state: WorkloadState.Errored,
      }),
    ).resolves.toBe(false);
    expect((await attempts('job')).map((row) => row.outcome)).toEqual([
      WorkloadState.Retrying,
      WorkloadState.Completed,
    ]);
  });

  it('turns a retry at the budget into Failed with its cleanup, and a resubmit renews the budget', async () => {
    await createTarget();
    await createTargetedJob('job');
    const store = executions();
    await store.claimTargetedJob(claimInput('job', firstExecution));
    // Earlier attempts of this submission, which started at 1.
    await getDB().query('UPDATE workloads SET started_at = 1 WHERE id = ?', [
      'job',
    ]);
    for (let n = 1; n < FAILED_DEPLOY_MAX_ATTEMPTS; n++) {
      await getDB().query(
        `INSERT INTO workload_attempts (workload_id, attempt, execution_id,
           substrate, outcome, opened_at, ended_at)
         VALUES ('job', ?, ?, 'pod', 'retrying', 2, 3)`,
        [n + 100, `earlier-${n}`],
      );
    }

    await expect(
      store.reportTargetedJobExecution('job', firstExecution, {
        state: WorkloadState.Retrying,
        reason: 'replica lost',
      }),
    ).resolves.toBe(true);
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Failed,
      completedAt: expect.any(Number),
      cleanedAt: expect.any(Number),
    });
    const failed = (await eventLog().getWorkloadEvents('job')).at(-1)!;
    expect([failed.state, JSON.parse(failed.metadata!)]).toEqual([
      WorkloadState.Failed,
      { executionId: firstExecution, reason: 'retry attempts exhausted' },
    ]);
    await expect(
      store.reportTargetedJobExecution('job', firstExecution, {
        state: WorkloadState.Retrying,
        reason: 'replica lost',
      }),
    ).resolves.toBe(true);
    await expect(store.listTargetedExecutions('target')).resolves.toEqual([]);

    await expect(outcomes().resubmitWorkload('job')).resolves.toBe(true);
    await store.claimTargetedJob({
      ...claimInput('job', secondExecution),
      submissionRevision: 1,
    });
    await expect(
      store.reportTargetedJobExecution('job', secondExecution, {
        state: WorkloadState.Retrying,
        reason: 'replica lost',
      }),
    ).resolves.toBe(true);
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Retrying,
    });
  });

  it("fails a retry past its own cap with the cap's message, counting only this submission's retries with its reason", async () => {
    await createTarget();
    await createTargetedJob('job');
    const store = executions();
    await store.claimTargetedJob(claimInput('job', firstExecution));
    await getDB().query('UPDATE workloads SET started_at = 2 WHERE id = ?', [
      'job',
    ]);
    // Another reason, and this reason before the submission, don't count.
    for (const [attempt, reason, openedAt] of [
      [101, 'replica lost', 2],
      [102, 'gpu', 1],
    ] as const) {
      await getDB().query(
        `INSERT INTO workload_attempts (workload_id, attempt, execution_id,
           substrate, outcome, reason, opened_at, ended_at)
         VALUES ('job', ?, ?, 'pod', 'retrying', ?, ?, 3)`,
        [attempt, `earlier-${attempt}`, reason, openedAt],
      );
    }
    const end = {
      state: WorkloadState.Retrying as const,
      reason: 'gpu',
      retryCap: { max: 1, failed: 'GPU unusable on every fresh VM' },
    };

    await store.reportTargetedJobExecution('job', firstExecution, end);
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Retrying,
    });
    const retry = (await eventLog().getWorkloadEvents('job')).at(-1)!;
    await lifecycle().queueRetryCandidate('job', retry.id);
    await store.claimTargetedJob(
      claimInput('job', secondExecution, firstExecution, 'pod-b'),
    );
    await store.reportTargetedJobExecution('job', secondExecution, end);
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Failed,
    });
    const failed = (await eventLog().getWorkloadEvents('job')).at(-1)!;
    expect(JSON.parse(failed.metadata!)).toEqual({
      executionId: secondExecution,
      reason: 'GPU unusable on every fresh VM',
    });
    // RFC 0049 C15: a spent cap is a spent retry budget.
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      endReason: 'retries-exhausted',
      lastAttemptEndReason: null,
    });
  });

  it('gives a retried Job its --timeout window again from each requeue, then expires it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      await createTarget();
      await createTargetedJob('job', { claimDeadlineAt: 1_060_000 });
      const store = executions();
      const retry = async (
        execution: string,
        previous: string | null,
        at: number,
      ) => {
        vi.setSystemTime(at);
        await store.claimTargetedJob(claimInput('job', execution, previous));
        await store.reportTargetedJobExecution('job', execution, {
          state: WorkloadState.Retrying,
          reason: 'replica OOMKilled',
        });
        const event = (await eventLog().getWorkloadEvents('job')).at(-1)!;
        await lifecycle().queueRetryCandidate('job', event.id);
        return queries().getWorkload('job');
      };
      // Each requeue waits the same 60 s as the first queueing allowed.
      await expect(
        retry(firstExecution, null, 1_050_000),
      ).resolves.toMatchObject({
        state: WorkloadState.Queued,
        claimDeadlineAt: 1_110_000,
      });
      await expect(
        retry(secondExecution, firstExecution, 1_100_000),
      ).resolves.toMatchObject({ claimDeadlineAt: 1_160_000 });
      vi.setSystemTime(1_159_999);
      await expect(store.expireDueTargetedJobSubmissions()).resolves.toBe(0);
      vi.setSystemTime(1_160_000);
      await expect(store.expireDueTargetedJobSubmissions()).resolves.toBe(1);
      await expect(queries().getWorkload('job')).resolves.toMatchObject({
        state: WorkloadState.Terminated,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes a closed attempt, so a second close, a late fact or an overwrite aborts while an open close and a replay succeed', async () => {
    await retriedOnce();
    const db = getDB();

    await expect(
      executions().reportTargetedJobExecution('job', firstExecution, {
        state: WorkloadState.Retrying,
        reason: 'replica OOMKilled',
      }),
    ).resolves.toBe(true);
    await expect(
      db.query(
        "UPDATE workload_attempts SET outcome = 'completed' WHERE attempt = 1",
      ),
    ).rejects.toThrow('workload attempt facts are written once');
    await expect(
      db.query('UPDATE workload_attempts SET ended_at = NULL, outcome = NULL'),
    ).rejects.toThrow('workload attempt facts are written once');
    await expect(
      db.query(
        "UPDATE workload_attempts SET reason = 'other' WHERE attempt = 1",
      ),
    ).rejects.toThrow('workload attempt facts are written once');
    await expect(
      db.query("UPDATE pod_attempts SET node = 'node-b' WHERE node = 'node-a'"),
    ).rejects.toThrow('pod attempt facts are written once');
    await expect(
      executions().reportTargetedJobExecution('job', secondExecution, {
        state: WorkloadState.Completed,
      }),
    ).resolves.toBe(true);
    for (const late of [
      "reason = 'late'",
      "cause = 'exit', exit_code = 0",
      'ended_at = ended_at + 1',
    ]) {
      await expect(
        db.query(`UPDATE workload_attempts SET ${late} WHERE attempt = 2`),
      ).rejects.toThrow('workload attempt facts are written once');
    }
    await executions().recordPodNode(firstExecution, 'node-b');
    await executions().recordPodNode(secondExecution, 'node-c');
    expect((await attempts('job')).map((row) => row.node)).toEqual([
      'node-a',
      'node-c',
    ]);
  });

  it('allows one extension row per attempt, of its discriminator kind', async () => {
    await createTarget();
    await createTargetedJob('job');
    await executions().claimTargetedJob(claimInput('job', firstExecution));
    const db = getDB();
    const [{ id }] = await db.query<{ id: number }>(
      'SELECT id FROM workload_attempts',
    );

    await expect(
      db.query('INSERT INTO pod_attempts (attempt_id) VALUES (?)', [id]),
    ).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    await db.query(
      `INSERT INTO workload_attempts
         (id, workload_id, attempt, execution_id, substrate, opened_at)
       VALUES (99, 'job', 2, 'slurm-execution', 'slurm', 1)`,
    );
    await expect(
      db.query('INSERT INTO pod_attempts (attempt_id) VALUES (99)'),
    ).rejects.toThrow('pod_attempts requires a pod attempt');
    await expect(
      db.query('UPDATE pod_attempts SET attempt_id = 99'),
    ).rejects.toThrow('pod attempt owner is immutable');
    await expect(
      db.query("UPDATE workload_attempts SET substrate = 'pod' WHERE id = 99"),
    ).rejects.toThrow('workload attempt identity is immutable');
    await expect(
      db.query(
        `INSERT INTO workload_attempts
           (workload_id, attempt, execution_id, substrate, opened_at)
         VALUES ('job', 3, 'vm-execution', 'vm', 1)`,
      ),
    ).rejects.toThrow(/CHECK/);

    await db.query('DELETE FROM workload_attempts');
    expect(
      await db.query(
        'SELECT (SELECT COUNT(*) FROM workload_attempts) + (SELECT COUNT(*) FROM pod_attempts) AS rows',
      ),
    ).toEqual([{ rows: 0 }]);
  });
});

describe('RFC 0049 C15 end reasons', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(() => resetPersistence());

  const endOf = async (id = 'job') => {
    const workload = await queries().getWorkload(id);
    return [
      workload?.state,
      workload?.endReason,
      workload?.lastAttemptEndReason,
    ];
  };

  it.each<[Cause, WorkloadState, string]>([
    [{ kind: 'exit', code: 0, oom: false }, WorkloadState.Completed, 'exited'],
    [{ kind: 'unrecoverable', detail: 'd' }, WorkloadState.Invalid, 'invalid'],
    [{ kind: 'deadline', detail: 'd' }, WorkloadState.Failed, 'timeout'],
    [{ kind: 'transfer', detail: 'd' }, WorkloadState.Failed, 'lost'],
    [
      { kind: 'evicted-storage', detail: 'd' },
      WorkloadState.Invalid,
      'invalid',
    ],
  ])(
    'ends a pool Job whose attempt ended with %o as %s / %s',
    async (cause, state, endReason) => {
      await createTarget();
      await createTargetedJob('job');
      await executions().claimTargetedJob(claimInput('job', firstExecution));
      await executions().reportTargetedJobExecution(
        'job',
        firstExecution,
        attemptEndOf(batchPolicy({ resumable: false }), cause),
      );
      await expect(endOf()).resolves.toEqual([state, endReason, null]);
    },
  );

  it('keeps a retrying Job without one, ends it retries-exhausted with a reclaimed last attempt, and a resubmit clears both', async () => {
    await createTarget();
    await createTargetedJob('job');
    const store = executions();
    await store.claimTargetedJob(claimInput('job', firstExecution));
    await getDB().query('UPDATE workloads SET started_at = 1 WHERE id = ?', [
      'job',
    ]);
    const disrupted = attemptEndOf(batchPolicy({ resumable: false }), {
      kind: 'disrupted',
      detail: 'Node was preempted',
    });
    // One attempt short of the budget: the next disruption retries.
    for (let n = 2; n < FAILED_DEPLOY_MAX_ATTEMPTS; n++) {
      await getDB().query(
        `INSERT INTO workload_attempts (workload_id, attempt, execution_id,
           substrate, outcome, opened_at, ended_at)
         VALUES ('job', ?, ?, 'pod', 'retrying', 2, 3)`,
        [n + 100, `earlier-${n}`],
      );
    }
    await store.reportTargetedJobExecution('job', firstExecution, disrupted);
    await expect(endOf()).resolves.toEqual([
      WorkloadState.Retrying,
      null,
      null,
    ]);

    const retry = (await eventLog().getWorkloadEvents('job')).at(-1)!;
    await lifecycle().queueRetryCandidate('job', retry.id);
    await store.claimTargetedJob(
      claimInput('job', secondExecution, firstExecution, 'pod-b'),
    );
    await store.reportTargetedJobExecution('job', secondExecution, disrupted);
    await expect(endOf()).resolves.toEqual([
      WorkloadState.Failed,
      'retries-exhausted',
      'reclaimed',
    ]);

    await expect(outcomes().resubmitWorkload('job')).resolves.toBe(true);
    await expect(endOf()).resolves.toEqual([WorkloadState.Queued, null, null]);
  });

  it('ends a terminated Job cancelled, an unclaimed one timeout, and one no replica can run invalid', async () => {
    await createTarget();
    await createTargetedJob('job');
    await outcomes().requestTermination('job', { kind: 'api' });
    await expect(endOf()).resolves.toEqual([
      WorkloadState.Terminated,
      'cancelled',
      null,
    ]);

    await createTargetedJob('unclaimed', { claimDeadlineAt: 1 });
    await expect(executions().expireDueTargetedJobSubmissions()).resolves.toBe(
      1,
    );
    await expect(endOf('unclaimed')).resolves.toEqual([
      WorkloadState.Terminated,
      'timeout',
      null,
    ]);

    await createTargetedJob('unrunnable');
    await executions().terminateUnassignedTargetedJobs('target', {
      message: 'no replica can run it',
      before: Date.now() + 1,
    });
    await expect(endOf('unrunnable')).resolves.toEqual([
      WorkloadState.Invalid,
      'invalid',
      null,
    ]);
  });
});

describe('RFC 0049 C3 retry policy', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(() => resetPersistence());

  const disrupted = attemptEndOf(batchPolicy({ resumable: false }), {
    kind: 'disrupted',
    detail: 'Node was preempted',
  });
  const runnerExit = attemptEndOf(RUNNER_REPLICA_POLICY, {
    kind: 'exit',
    code: 1,
    oom: false,
  });
  const end = async () => {
    const workload = await queries().getWorkload('job');
    const event = (await eventLog().getWorkloadEvents('job')).at(-1);
    return [
      workload?.state,
      workload?.endReason,
      workload?.lastAttemptEndReason,
      // A Failed end names it `reason`, an Errored one `message`.
      JSON.parse(event!.metadata!).reason ??
        JSON.parse(event!.metadata!).message,
    ];
  };
  /** End the current attempt, then requeue and claim the next one. */
  async function endAndRetry(execution: string, next: string) {
    await executions().reportTargetedJobExecution('job', execution, disrupted);
    const retry = (await eventLog().getWorkloadEvents('job')).at(-1)!;
    await lifecycle().queueRetryCandidate('job', retry.id);
    await executions().claimTargetedJob(
      claimInput('job', next, execution, 'pod-b'),
    );
  }

  it.each([
    [disrupted, 'reclaimed', 'Node was preempted'],
    [runnerExit, 'exited', 'runner exited with code 1'],
  ] as const)(
    'with --max-retries 0, ends the first retrying attempt Failed with its own cause',
    async (attemptEnd, endReason, detail) => {
      await createTarget();
      await createTargetedJob('job', { maxRetries: 0 });
      await executions().claimTargetedJob(claimInput('job', firstExecution));
      await executions().reportTargetedJobExecution(
        'job',
        firstExecution,
        attemptEnd,
      );
      await expect(end()).resolves.toEqual([
        WorkloadState.Failed,
        endReason,
        endReason,
        `max retries (0) reached: ${detail}`,
      ]);
    },
  );

  it('with --max-retries 1, retries once and ends the second disruption, and a resubmit renews the cap', async () => {
    await createTarget();
    await createTargetedJob('job', { maxRetries: 1 });
    await executions().claimTargetedJob(claimInput('job', firstExecution));
    await endAndRetry(firstExecution, secondExecution);
    await executions().reportTargetedJobExecution(
      'job',
      secondExecution,
      disrupted,
    );
    await expect(end()).resolves.toEqual([
      WorkloadState.Failed,
      'reclaimed',
      'reclaimed',
      'max retries (1) reached: Node was preempted',
    ]);

    await expect(outcomes().resubmitWorkload('job')).resolves.toBe(true);
    // Both attempts came before the resubmit, even within its millisecond.
    await getDB().query(
      "UPDATE workload_attempts SET opened_at = 1 WHERE workload_id = 'job'",
    );
    const third = '33333333-3333-4333-8333-333333333333';
    await executions().claimTargetedJob({
      ...claimInput('job', third),
      submissionRevision: 1,
    });
    await executions().reportTargetedJobExecution('job', third, disrupted);
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Retrying,
    });
  });

  it("doesn't count a handler's retry or a GPU rerun, which still ends Errored at its own cap", async () => {
    await createTarget();
    await createTargetedJob('job', { maxRetries: 0 });
    await executions().claimTargetedJob(claimInput('job', firstExecution));
    await executions().reportTargetedJobExecution('job', firstExecution, {
      state: WorkloadState.Retrying,
      reason: 'application requested retry',
    });
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Retrying,
    });

    const gpuRerun = {
      state: WorkloadState.Retrying,
      reason: UNUSABLE_GPU_POOL_RERUN,
      cause: { kind: 'exit', code: 1, oom: false },
      retryCap: {
        max: 1,
        ends: WorkloadState.Errored,
        failed: 'the Job failed the same way in a new Pod',
      },
    } as const;
    let previous = firstExecution;
    for (const next of [
      secondExecution,
      '33333333-3333-4333-8333-333333333333',
    ]) {
      const retry = (await eventLog().getWorkloadEvents('job')).at(-1)!;
      await lifecycle().queueRetryCandidate('job', retry.id);
      await executions().claimTargetedJob(
        claimInput('job', next, previous, `pod-${next[0]}`),
      );
      await executions().reportTargetedJobExecution('job', next, gpuRerun);
      previous = next;
    }
    // As without `maxRetries`: one rerun, then the cap's Errored end.
    await expect(end()).resolves.toEqual([
      WorkloadState.Errored,
      'retries-exhausted',
      'exited',
      'the Job failed the same way in a new Pod',
    ]);
  });

  it('keeps retrying a Deployment Job whose replica ended for another cause, such as a storage eviction', async () => {
    await createTarget();
    await createTargetedJob('job', { maxRetries: 0 });
    await executions().claimTargetedJob(claimInput('job', firstExecution));
    await executions().reportTargetedJobExecution(
      'job',
      firstExecution,
      attemptEndOf(DEPLOYMENT_POLICY, {
        kind: 'evicted-storage',
        detail: 'ephemeral storage exceeded',
      }),
    );
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Retrying,
    });
  });

  it('ends retries-exhausted when the system budget runs out at the same attempt', async () => {
    await createTarget();
    await createTargetedJob('job', { maxRetries: 50 });
    await executions().claimTargetedJob(claimInput('job', firstExecution));
    await getDB().query('UPDATE workloads SET started_at = 1 WHERE id = ?', [
      'job',
    ]);
    for (let n = 1; n < FAILED_DEPLOY_MAX_ATTEMPTS; n++) {
      await getDB().query(
        `INSERT INTO workload_attempts (workload_id, attempt, execution_id,
           substrate, outcome, cause, reason, opened_at, ended_at)
         VALUES ('job', ?, ?, 'pod', 'retrying', 'disrupted', 'Node was preempted', 2, 3)`,
        [n + 100, `earlier-${n}`],
      );
    }
    await executions().reportTargetedJobExecution(
      'job',
      firstExecution,
      disrupted,
    );
    await expect(end()).resolves.toEqual([
      WorkloadState.Failed,
      'retries-exhausted',
      'reclaimed',
      'retry attempts exhausted',
    ]);
  });
});

describe('workload attempts migration', () => {
  let sqlite: BetterSqlite3.Database;
  afterEach(() => sqlite?.close());

  it('opens a first attempt for each live or uncleaned targeted execution from its start event', async () => {
    sqlite = new BetterSqlite3(':memory:');
    const db = {
      get inTransaction() {
        return sqlite.inTransaction;
      },
      exec: (sql: string) => void sqlite.exec(sql),
      query<T>(sql: string, params: unknown[] = []): T[] {
        const statement = sqlite.prepare(sql);
        return (
          statement.reader
            ? statement.all(...params)
            : [{ rowsAffected: statement.run(...params).changes }]
        ) as T[];
      },
    };
    await runMigrations(db, 133);
    const start = (execution: string, pod: string) =>
      JSON.stringify({
        executionId: execution,
        generation: 2,
        podUid: pod,
        containerId: `containerd://${pod}`,
      });
    sqlite.exec(`
      INSERT INTO credentials(id,encrypted_data,cloud_provider) VALUES ('compute','x','AWS');
      INSERT INTO clusters(id,owner_user_id,name,state,step,kubernetes_identity,encrypted_connection,created_at,updated_at)
        VALUES ('root','owner','root','ready','release','uid','enc',1,1);
      INSERT INTO node_pools(id,cluster_id,owner_user_id,name,state,compute_credential_id,region,vm_type,min_vm_count,max_vm_count,created_at,updated_at)
        VALUES ('pool','root','owner','pool','ready','compute','us-east-1','t3.small',1,1,1,1);
      INSERT INTO deployments(id,owner_user_id,name,node_pool_id,gpu_count,max_concurrent_jobs_per_replica,generation,created_at,updated_at)
        VALUES ('deployment','owner','deployment','pool',0,1,2,1,1);
      INSERT INTO container_specs(deployment_id,image,registry_username) VALUES ('deployment','image','owner');
      INSERT INTO workloads(id,user_id,deployment_id,workload_type,state,started_at,submitted_at,docker_command,current_execution_id)
        VALUES ('live','owner','deployment','job','running',10,10,'','second'),
               ('stopping','owner','deployment','job','terminated',10,10,'','stop'),
               ('done','owner','deployment','job','completed',10,10,'','done');
      UPDATE workloads SET completed_at = 15 WHERE id IN ('stopping', 'done');
      UPDATE workloads SET cleaned_at = 20 WHERE id = 'done';
    `);
    const event = sqlite.prepare(
      'INSERT INTO workload_events(workload_id,state,metadata,created_at) VALUES (?,?,?,?)',
    );
    event.run('live', 'running', start('first', 'pod-a'), 11);
    event.run('live', 'retrying', JSON.stringify({ executionId: 'first' }), 12);
    event.run('live', 'running', start('second', 'pod-b'), 13);
    event.run('stopping', 'running', start('stop', 'pod-d'), 12);
    event.run('done', 'running', start('done', 'pod-c'), 11);

    await runMigrations(db);

    expect(
      sqlite
        .prepare(
          `SELECT a.workload_id AS workloadId, a.attempt, a.execution_id AS executionId,
                  a.generation, a.substrate, a.outcome, a.opened_at AS openedAt,
                  p.pod_uid AS podUid, p.container_id AS containerId
           FROM workload_attempts a JOIN pod_attempts p ON p.attempt_id = a.id
           ORDER BY a.workload_id`,
        )
        .all(),
    ).toEqual([
      {
        workloadId: 'live',
        attempt: 1,
        executionId: 'second',
        generation: 2,
        substrate: 'pod',
        outcome: null,
        openedAt: 13,
        podUid: 'pod-b',
        containerId: 'containerd://pod-b',
      },
      {
        workloadId: 'stopping',
        attempt: 1,
        executionId: 'stop',
        generation: 2,
        substrate: 'pod',
        outcome: null,
        openedAt: 12,
        podUid: 'pod-d',
        containerId: 'containerd://pod-d',
      },
    ]);
  });
});
