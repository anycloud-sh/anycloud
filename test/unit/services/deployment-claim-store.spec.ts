import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDeploymentStore,
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore,
  getReplicaDemandStore,
  getWorkloadOutcomes as outcomes,
  getPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  makeClusterKubernetesClientFixture,
  makeContainerSpec,
  makeReplicaPolicyDependencies,
} from '../helpers/fixtures.js';
import { registerRequestDeadline } from '../../../src/api/services/request-budget.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { explainQueryPlan, searchesIndex } from '../helpers/query-plan.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import type { V1Pod } from '@kubernetes/client-node';
import {
  createReplicaPolicy,
  drainReplica,
} from '../../../src/api/services/deployment-replicas.js';

const owner = { kind: 'api' } as const;
const runtime = {
  deploymentId: 'deployment',
  generation: 1,
  podUid: 'pod',
  containerId: 'container',
};
const candidate = (jobId = 'job') => ({
  jobId,
  submissionRevision: 0,
  previousExecutionId: null,
});
const claim = (jobId = 'job', executionId = randomUUID()) => ({
  ...runtime,
  ...candidate(jobId),
  executionId,
});
const store = () => getDeploymentExecutionStore();

async function admit(id = 'job', claimDeadlineAt?: number): Promise<void> {
  expect(
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id,
      deploymentId: runtime.deploymentId,
      userId: 'owner',
      ownerUserId: 'owner',
      claimDeadlineAt,
    }),
  ).toBe(true);
}

async function seedDeployment(): Promise<void> {
  resetPersistence();
  await seedReadyNodePool({ nodePoolId: 'pool', ownerUserId: 'owner' });
  await getDeploymentStore().create(
    {
      id: runtime.deploymentId,
      ownerUserId: 'owner',
      name: 'deployment',
      nodePoolId: 'pool',
      config: makeContainerSpec(),
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
    },
    { kind: 'api' },
  );
}

beforeEach(seedDeployment);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Deployment look then claim', () => {
  it.each(['claim', 'observation'] as const)(
    'fences %s writes when the elapsed deadline precedes its timer callback',
    async (operation) => {
      await admit('job', operation === 'observation' ? 0 : undefined);
      const controller = new AbortController();
      const expired = new Error('Elapsed request deadline');
      const deadlineAt = performance.now() + 30_000;
      registerRequestDeadline(controller.signal, deadlineAt, () =>
        controller.abort(expired),
      );
      const input = { ...claim(), signal: controller.signal };
      // Database initialization yields before entering the transaction. Advance
      // only the monotonic clock; no abort timer or event-loop turn runs.
      const pending =
        operation === 'claim'
          ? store().claimTargetedJob(input)
          : store().observeTargetedJobSubmission('job', 0, controller.signal);
      vi.spyOn(performance, 'now').mockReturnValue(deadlineAt);
      await expect(pending).rejects.toBe(expired);
      expect(controller.signal.aborted).toBe(true);
      expect(await queries().getWorkload('job')).toMatchObject({
        state: WorkloadState.Queued,
        firstClaimedAt: null,
        currentExecutionId: null,
      });
      expect(await getDB().query('SELECT * FROM workload_events')).toEqual([]);
    },
  );

  it('fences an observer cancelled while database initialization yields', async () => {
    await admit('job', 0);
    const cancellation = new AbortController();
    const reason = new Error('Observation disconnected');
    const observation = store().observeTargetedJobSubmission(
      'job',
      0,
      cancellation.signal,
    );
    // transaction() awaits init() before entering its synchronous callback,
    // even for this already initialized database.
    cancellation.abort(reason);
    await expect(observation).rejects.toBe(reason);
    expect((await queries().getWorkload('job'))?.state).toBe(
      WorkloadState.Queued,
    );
    expect(await getDB().query('SELECT * FROM workload_events')).toEqual([]);
    await expect(
      store().observeTargetedJobSubmission('job', 0),
    ).resolves.toMatchObject({
      outcome: 'expired',
      claimed: false,
    });
  });

  it('discovers without writing and atomically selects one of competing readers', async () => {
    await expect(store().discoverTargetedJob(runtime)).resolves.toEqual({
      kind: 'empty',
    });
    await admit();
    const before = await getDB().query('SELECT * FROM workload_events');
    const readers = await Promise.all([
      store().discoverTargetedJob(runtime),
      store().discoverTargetedJob(runtime),
    ]);
    expect(readers).toEqual([
      { kind: 'candidate', candidate: candidate() },
      { kind: 'candidate', candidate: candidate() },
    ]);
    expect(await getDB().query('SELECT * FROM workload_events')).toEqual(
      before,
    );
    const results = await Promise.all([
      store().claimTargetedJob(claim()),
      store().claimTargetedJob(claim()),
    ]);
    expect(results.filter((result) => result.kind === 'selected')).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.kind === 'stale')).toHaveLength(1);
    expect(await getDB().query('SELECT * FROM workload_events')).toHaveLength(
      1,
    );
  });

  it('keeps running and terminated executions in capacity until cleanup', async () => {
    await admit('first');
    await admit('second');
    const execution = claim('first');
    await store().claimTargetedJob(execution);
    await expect(store().claimTargetedJob(claim('second'))).resolves.toEqual({
      kind: 'conflict',
    });
    await outcomes().requestTermination('first', owner);
    await expect(store().discoverTargetedJob(runtime)).resolves.toEqual({
      kind: 'full',
    });
    await expect(
      store().claimTargetedJob({ ...execution, ready: false }),
    ).resolves.toMatchObject({ kind: 'selected' });
    await store().completeTargetedJobCleanup('first', execution.executionId);
    await expect(
      store().claimTargetedJob(claim('second')),
    ).resolves.toMatchObject({ kind: 'selected', jobId: 'second' });
  });

  it("S12 counts a replica's occupancy from its own attempts, not the Deployment's history", async () => {
    const dbFile = join(tmpdir(), `anycloud-claim-occupancy-${process.pid}.db`);
    rmSync(dbFile, { force: true });
    vi.stubEnv('SQLITE_PATH', dbFile);
    await seedDeployment();
    try {
      await getDB().query(
        'UPDATE deployments SET max_concurrent_jobs_per_replica = 2 WHERE id = ?',
        [runtime.deploymentId],
      );
      // History on other replicas, ended and cleaned.
      for (const id of ['old-1', 'old-2']) {
        await admit(id);
        const old = { ...claim(id), podUid: `${id}-pod` };
        await store().claimTargetedJob(old);
        await store().reportTargetedJobExecution(id, old.executionId, {
          state: WorkloadState.Completed,
        });
        await store().completeTargetedJobCleanup(id, old.executionId);
      }
      await admit('first');
      await admit('second');
      await store().claimTargetedJob(claim('first'));
      const queries: [string, unknown[] | undefined][] = [];
      const transaction = getDB().transaction.bind(getDB());
      vi.spyOn(getDB(), 'transaction').mockImplementation((fn) =>
        transaction((tx) =>
          fn({
            query: (sql, params) => {
              queries.push([sql, params]);
              return tx.query(sql, params);
            },
          }),
        ),
      );
      await expect(
        store().claimTargetedJob(claim('second')),
      ).resolves.toMatchObject({ kind: 'selected', jobId: 'second' });
      const [sql, params] = queries.find(
        ([sql]) => sql.includes('COUNT(*)') && sql.includes('pod_attempts'),
      )!;
      const plan = explainQueryPlan(dbFile, sql, params);
      expect(searchesIndex(plan, 'idx_pod_attempts_pod_uid')).toBe(true);
      expect(searchesIndex(plan, 'idx_workloads_deployment')).toBe(false);
    } finally {
      resetPersistence();
      rmSync(dbFile, { force: true });
    }
  });

  it('gives each replica its own slots: a full replica refuses, another claims', async () => {
    await admit('first');
    await admit('second');
    await admit('third');
    await getDB().query(
      'UPDATE deployments SET max_replicas = 2 WHERE id = ?',
      [runtime.deploymentId],
    );
    await store().claimTargetedJob(claim('first'));
    // The same replica is full at one Job.
    await expect(store().claimTargetedJob(claim('second'))).resolves.toEqual({
      kind: 'conflict',
    });
    // A second replica of the same Deployment claims with its own slot.
    await expect(
      store().claimTargetedJob({ ...claim('second'), podUid: 'pod-2' }),
    ).resolves.toMatchObject({ kind: 'selected', jobId: 'second' });
    await expect(
      store().claimTargetedJob({ ...claim('third'), podUid: 'pod-2' }),
    ).resolves.toEqual({ kind: 'conflict' });
  });

  it('replays only the identical tuple before readiness and generation checks', async () => {
    await admit();
    const request = claim();
    await store().claimTargetedJob(request);
    await getDB().query('UPDATE deployments SET generation = 2 WHERE id = ?', [
      runtime.deploymentId,
    ]);
    await expect(
      store().claimTargetedJob({ ...request, ready: false }),
    ).resolves.toMatchObject({
      kind: 'selected',
      executionId: request.executionId,
    });
    await expect(
      store().claimTargetedJob({ ...request, submissionRevision: 1 }),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(
      store().claimTargetedJob({ ...request, podUid: 'other' }),
    ).resolves.toEqual({ kind: 'conflict' });
    await store().reportTargetedJobExecution('job', request.executionId, {
      state: WorkloadState.Completed,
    });
    await expect(store().claimTargetedJob(request)).resolves.toEqual({
      kind: 'execution-used',
    });
  });

  it('accepts canonicalized predecessor UUIDs for claim, replay and permanent staleness', async () => {
    await admit();
    const previousExecution = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
    await store().claimTargetedJob({
      ...claim(),
      executionId: previousExecution,
    });
    await store().reportTargetedJobExecution('job', previousExecution, {
      state: WorkloadState.Retrying,
      reason: 'retry fixture',
    });
    const retry = await queries().getWorkloadReconcileCandidate('job');
    expect(await lifecycle().queueRetryCandidate('job', retry!.revision)).toBe(
      'queued',
    );
    await expect(store().discoverTargetedJob(runtime)).resolves.toMatchObject({
      kind: 'candidate',
      candidate: { previousExecutionId: previousExecution },
    });
    const canonical = {
      ...claim(),
      previousExecutionId: previousExecution.toLowerCase(),
    };
    await expect(store().claimTargetedJob(canonical)).resolves.toMatchObject({
      kind: 'selected',
    });
    await expect(
      store().claimTargetedJob({
        ...canonical,
        previousExecutionId: previousExecution,
      }),
    ).resolves.toMatchObject({ kind: 'selected' });
    await expect(
      store().claimTargetedJob({ ...canonical, executionId: randomUUID() }),
    ).resolves.toEqual({ kind: 'stale' });
  });

  it('can claim the same pending tuple after its missing Job is admitted', async () => {
    const pending = claim();
    await expect(store().claimTargetedJob(pending)).resolves.toEqual({
      kind: 'conflict',
    });
    await admit();
    await expect(store().claimTargetedJob(pending)).resolves.toEqual({
      kind: 'selected',
      jobId: pending.jobId,
      executionId: pending.executionId,
    });
  });

  it('can claim a future revision after explicit resubmission reaches it', async () => {
    await admit('job', 0);
    const pending = { ...claim(), submissionRevision: 1 };
    await expect(store().claimTargetedJob(pending)).resolves.toEqual({
      kind: 'conflict',
    });
    expect(await store().expireDueTargetedJobSubmissions()).toBe(1);
    expect(await outcomes().resubmitWorkloadForScope('job', owner)).toEqual({
      submissionRevision: 1,
      claimDeadlineAt: null,
    });
    await expect(store().claimTargetedJob(pending)).resolves.toEqual({
      kind: 'selected',
      jobId: pending.jobId,
      executionId: pending.executionId,
    });
  });

  it('can claim an unknown predecessor after that execution runs and retries', async () => {
    await admit();
    const first = claim();
    const pending = { ...claim(), previousExecutionId: first.executionId };
    await expect(store().claimTargetedJob(pending)).resolves.toEqual({
      kind: 'conflict',
    });
    await expect(store().claimTargetedJob(first)).resolves.toMatchObject({
      kind: 'selected',
    });
    expect(
      await store().reportTargetedJobExecution('job', first.executionId, {
        state: WorkloadState.Retrying,
        reason: 'retry',
      }),
    ).toBe(true);
    const retry = await queries().getWorkloadReconcileCandidate('job');
    await expect(
      lifecycle().queueRetryCandidate('job', retry!.revision),
    ).resolves.toBe('queued');
    await expect(store().discoverTargetedJob(runtime)).resolves.toEqual({
      kind: 'candidate',
      candidate: {
        ...candidate(),
        previousExecutionId: first.executionId,
      },
    });
    await expect(store().claimTargetedJob(pending)).resolves.toEqual({
      kind: 'selected',
      jobId: pending.jobId,
      executionId: pending.executionId,
    });
  });

  it('leaves an unready claim available to the same caller when it becomes ready', async () => {
    await admit();
    const pending = claim();
    await expect(
      store().claimTargetedJob({ ...pending, ready: false }),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(store().claimTargetedJob(pending)).resolves.toMatchObject({
      kind: 'selected',
      executionId: pending.executionId,
    });
  });

  it('refuses a claim on a replica closed for release, leaving the Job queued, for at least an hour', async () => {
    await admit();
    const now = Date.now();
    store().closeReplica(runtime.podUid, now);
    // A closed replica discovers nothing, and a claim already under way is
    // stale, which the SDK absorbs, rather than a conflict it raises.
    await expect(store().discoverTargetedJob(runtime)).resolves.toEqual({
      kind: 'full',
    });
    await expect(store().claimTargetedJob(claim())).resolves.toEqual({
      kind: 'stale',
    });
    expect(await queries().getWorkload('job')).toMatchObject({
      state: WorkloadState.Queued,
      currentExecutionId: null,
      firstClaimedAt: null,
    });
    // Only that replica is closed, and for at least an hour: an entry is
    // pruned once older than that, and the still-queued Job is claimed.
    store().closeReplica('later-pod', now + 3_600_000);
    await expect(store().claimTargetedJob(claim())).resolves.toEqual({
      kind: 'stale',
    });
    store().closeReplica('later-pod', now + 3_600_001);
    await expect(store().claimTargetedJob(claim())).resolves.toMatchObject({
      kind: 'selected',
    });
  });

  it('rolls the Job back if its start event cannot commit', async () => {
    await admit();
    await getDB()
      .query(`CREATE TRIGGER fail_start BEFORE INSERT ON workload_events
      WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'start rejected'); END`);
    await expect(store().claimTargetedJob(claim())).rejects.toThrow(
      'start rejected',
    );
    expect(await queries().getWorkload('job')).toMatchObject({
      state: WorkloadState.Queued,
      currentExecutionId: null,
      firstClaimedAt: null,
    });
    expect(await getDB().query('SELECT * FROM workload_events')).toHaveLength(
      0,
    );
  });

  it('does not mutate after request cancellation', async () => {
    await admit();
    const controller = new AbortController();
    controller.abort(new Error('disconnected'));
    await expect(
      store().claimTargetedJob({ ...claim(), signal: controller.signal }),
    ).rejects.toThrow('disconnected');
    expect(await queries().getWorkload('job')).toMatchObject({
      state: WorkloadState.Queued,
      firstClaimedAt: null,
    });
  });
});

describe('durable first-claim deadlines', () => {
  it('bounds individual status blockers while counting terminal cleanup and excluding other Deployments', async () => {
    const deploymentStore = getDeploymentStore();
    const original = (await deploymentStore.getById(runtime.deploymentId))!;
    expect(
      await deploymentStore.update(
        {
          ...original,
          expectedGeneration: 1,
          maxConcurrentJobsPerReplica: 13,
        },
        owner,
      ),
    ).toBe(2);
    const claims = [];
    for (let index = 0; index < 13; index++) {
      const id = `job-${String(index).padStart(2, '0')}`;
      await admit(id);
      const request = { ...claim(id), generation: 2 };
      claims.push(request);
      expect(await store().claimTargetedJob(request)).toMatchObject({
        kind: 'selected',
      });
    }
    await admit('queued');
    await admit('expired', 0);
    expect(await outcomes().requestTermination('job-00', owner)).toEqual({
      previousState: WorkloadState.Running,
    });
    expect(
      await deploymentStore.create(
        {
          ...original,
          id: 'other',
          name: 'other',
        },
        owner,
      ),
    ).toBe(true);
    expect(
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id: 'other-job',
        deploymentId: 'other',
        userId: 'owner',
        ownerUserId: 'owner',
      }),
    ).toBe(true);
    expect(
      await store().claimTargetedJob({
        ...claim('other-job'),
        deploymentId: 'other',
      }),
    ).toMatchObject({ kind: 'selected' });

    const transaction = vi.spyOn(getDB(), 'transaction');
    const query = vi.spyOn(getDB(), 'query');
    const snapshot = await store().targetedJobStatusSnapshot(
      runtime.deploymentId,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(snapshot.counts).toEqual({
      queued: 1,
      running: 12,
      retrying: 0,
      terminal: 1,
      unreleased: 13,
    });
    expect(snapshot.blockers).toHaveLength(10);
    expect(snapshot.blockers.map((blocker) => blocker.jobId)).toEqual(
      claims.slice(0, 10).map((request) => request.jobId),
    );
    expect(snapshot.blockers[0]).toEqual({
      jobId: 'job-00',
      executionId: claims[0].executionId,
      generation: 2,
      state: WorkloadState.Terminated,
    });
    expect(snapshot.blockers.every((blocker) => blocker.generation === 2)).toBe(
      true,
    );
    expect(
      await store().reportTargetedJobExecution(
        'job-00',
        claims[0].executionId,
        {
          state: WorkloadState.Completed,
        },
      ),
    ).toBe(true);
    const released = await store().targetedJobStatusSnapshot(
      runtime.deploymentId,
    );
    expect(released.counts.unreleased).toBe(12);
    expect(released.blockers[0].jobId).toBe('job-01');
    expect(
      (await store().targetedJobStatusSnapshot('missing')).counts.unreleased,
    ).toBe(0);
  });

  it('bounds background expiry while direct observation and later batches make progress', async () => {
    for (let index = 0; index < 258; index++) {
      await admit(`batch-${String(index).padStart(4, '0')}`, 0);
    }
    expect(await store().expireDueTargetedJobSubmissions()).toBe(256);
    expect((await queries().getWorkload('batch-0256'))?.state).toBe(
      WorkloadState.Queued,
    );
    expect(await store().discoverTargetedJob(runtime)).toEqual({
      kind: 'empty',
    });
    expect(
      await store().observeTargetedJobSubmission('batch-0257', 0),
    ).toMatchObject({
      outcome: 'expired',
      claimed: false,
    });
    expect(await store().expireDueTargetedJobSubmissions()).toBe(1);
    expect(await store().expireDueTargetedJobSubmissions()).toBe(0);
    expect(await getDB().query('SELECT * FROM workload_events')).toHaveLength(
      258,
    );
  });

  it.each(['claim', 'expiry'] as const)(
    'expiry wins at the exact cutoff when %s runs first',
    async (first) => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await admit('job', now);
      if (first === 'claim') {
        await expect(store().claimTargetedJob(claim())).resolves.toEqual({
          kind: 'stale',
        });
      } else {
        expect(await store().expireDueTargetedJobSubmissions()).toBe(1);
        await expect(store().claimTargetedJob(claim())).resolves.toEqual({
          kind: 'stale',
        });
      }
      expect(
        await store().observeTargetedJobSubmission('job', 0),
      ).toMatchObject({ claimed: false, outcome: 'expired' });
      vi.mocked(Date.now).mockReturnValue(now - 10_000);
      expect(
        await store().observeTargetedJobSubmission('job', 0),
      ).toMatchObject({ outcome: 'expired' });
      await expect(store().claimTargetedJob(claim())).resolves.toEqual({
        kind: 'stale',
      });
    },
  );

  it('keeps claim evidence and revision through completion and automatic retry', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await admit('job', now + 1);
    const request = claim();
    await store().claimTargetedJob(request);
    vi.mocked(Date.now).mockReturnValue(now + 2);
    expect(await store().expireDueTargetedJobSubmissions()).toBe(0);
    await store().reportTargetedJobExecution('job', request.executionId, {
      state: WorkloadState.Retrying,
      reason: 'try again',
    });
    const retry = await queries().getWorkloadReconcileCandidate('job');
    expect(await lifecycle().queueRetryCandidate('job', retry!.revision)).toBe(
      'queued',
    );
    await expect(store().discoverTargetedJob(runtime)).resolves.toEqual({
      kind: 'candidate',
      candidate: { ...candidate(), previousExecutionId: request.executionId },
    });
    const next = { ...claim(), previousExecutionId: request.executionId };
    await expect(store().claimTargetedJob(next)).resolves.toMatchObject({
      kind: 'selected',
    });
    await expect(
      store().claimTargetedJob({
        ...claim(),
        previousExecutionId: request.executionId,
      }),
    ).resolves.toEqual({ kind: 'stale' });
    await store().reportTargetedJobExecution('job', next.executionId, {
      state: WorkloadState.Completed,
    });
    expect(await store().observeTargetedJobSubmission('job', 0)).toMatchObject({
      claimed: true,
      outcome: 'claimed',
    });
  });

  it('resubmits the same ID with an authoritative revision and clears its cutoff', async () => {
    const now = Date.now();
    await admit('job', now - 1);
    await store().expireDueTargetedJobSubmissions();
    expect(await outcomes().resubmitWorkloadForScope('job', owner)).toEqual({
      submissionRevision: 1,
      claimDeadlineAt: null,
    });
    expect(await store().observeTargetedJobSubmission('job', 0)).toMatchObject({
      outcome: 'changed',
      submissionRevision: 1,
    });
    expect(await queries().getWorkload('job')).toMatchObject({
      id: 'job',
      state: WorkloadState.Queued,
      firstClaimedAt: null,
      claimDeadlineAt: null,
    });
    await expect(store().claimTargetedJob(claim())).resolves.toEqual({
      kind: 'stale',
    });
    await expect(
      store().claimTargetedJob({ ...claim(), submissionRevision: 1 }),
    ).resolves.toMatchObject({ kind: 'selected' });
  });

  it('distinguishes operator termination and excludes due work from every queue view', async () => {
    await admit('due', Date.now() - 1);
    await admit('live');
    expect(await store().countTargetedJobs(runtime.deploymentId)).toMatchObject(
      {
        queued: 1,
      },
    );
    expect(
      await queries().getWorkloadStatusForScope('live', owner),
    ).toMatchObject({ jobsAhead: 0 });
    expect(
      await queries().getWorkloadStatusForScope('due', owner),
    ).toMatchObject({ jobsAhead: null });
    await expect(store().discoverTargetedJob(runtime)).resolves.toMatchObject({
      kind: 'candidate',
      candidate: { jobId: 'live' },
    });
    await expect(
      store().claimTargetedJob(claim('live')),
    ).resolves.toMatchObject({
      kind: 'selected',
      jobId: 'live',
    });
    await admit('cancelled');
    await outcomes().requestTermination('cancelled', owner);
    expect(
      await store().observeTargetedJobSubmission('cancelled', 0),
    ).toMatchObject({ outcome: 'terminated', claimed: false });
    expect(await store().expireDueTargetedJobSubmissions()).toBe(1);
  });
});

describe('RA replica drain and managed demand', () => {
  it('0044/14 reads, closes, then rereads a replica, so a drain and a claim never both win', async () => {
    await admit('held');
    await admit('next');
    await expect(
      store().claimTargetedJob(claim('held')),
    ).resolves.toMatchObject({
      kind: 'selected',
    });
    // A replica seen busy is never closed, and keeps claiming up to its limit.
    await expect(
      drainReplica(store(), runtime.deploymentId, runtime.podUid),
    ).resolves.toBe(false);
    await getDB().query(
      'UPDATE deployments SET max_concurrent_jobs_per_replica = 2',
    );
    await admit('second');
    await expect(
      store().claimTargetedJob(claim('second')),
    ).resolves.toMatchObject({ kind: 'selected' });
    // An idle one races a claim: exactly one of them wins.
    const idle = { ...claim('next'), podUid: 'idle' };
    const [drained, claimed] = await Promise.all([
      drainReplica(store(), runtime.deploymentId, 'idle'),
      store().claimTargetedJob(idle),
    ]);
    expect([drained, claimed.kind === 'selected']).toContain(true);
    expect(drained).toBe(claimed.kind !== 'selected');
    // A claim commits between the first read and the close: it is reopened.
    await admit('raced');
    await admit('after');
    const racer = (jobId: string) => ({ ...claim(jobId), podUid: 'racer' });
    const executions = store();
    let reads = 0;
    const racing = {
      closeReplica: (podUid: string) => executions.closeReplica(podUid),
      reopenReplica: (podUid: string) => executions.reopenReplica(podUid),
      listTargetedExecutions: async (deploymentId: string) => {
        const read = await executions.listTargetedExecutions(deploymentId);
        if (reads++ === 0)
          await expect(
            executions.claimTargetedJob(racer('raced')),
          ).resolves.toMatchObject({ kind: 'selected' });
        return read;
      },
    };
    await expect(
      drainReplica(racing, runtime.deploymentId, 'racer'),
    ).resolves.toBe(false);
    await expect(
      store().claimTargetedJob(racer('after')),
    ).resolves.toMatchObject({ kind: 'selected' });
    // A drained replica claims again once its mark is cleared.
    await admit('later');
    await drainReplica(store(), runtime.deploymentId, 'spare');
    const spare = { ...claim('later'), podUid: 'spare' };
    await expect(store().claimTargetedJob(spare)).resolves.toEqual({
      kind: 'stale',
    });
    store().reopenReplica('spare');
    await expect(store().claimTargetedJob(spare)).resolves.toMatchObject({
      kind: 'selected',
    });
  });

  it('never cuts a replica the Pod cache lists Pending, but that holds or could claim a Job', async () => {
    for (const id of ['held', 'other', 'next']) await admit(id);
    const policy = createReplicaPolicy({
      ...makeReplicaPolicyDependencies(),
      drainReplica: (id, podUid) => drainReplica(store(), id, podUid),
      reopenReplica: (podUid) => store().reopenReplica(podUid),
    });
    const cluster = makeClusterKubernetesClientFixture({
      core: { patchNamespacedPod: vi.fn(async () => ({})) },
    });
    const replica = (uid: string, phase: string): V1Pod => ({
      metadata: { uid, name: uid, namespace: 'ns' },
      status: {
        phase,
        conditions: [
          { type: 'Ready', status: phase === 'Running' ? 'True' : 'False' },
        ],
      },
    });
    // From 2 replicas to 1; `other` holds a Job in both passes.
    const scale = async (pending: string) =>
      policy({
        deployment: (await getDeploymentStore().getById(runtime.deploymentId))!,
        current: {
          metadata: { generation: 1 },
          spec: { replicas: 2, selector: {}, template: {} },
          status: { observedGeneration: 1, replicas: 2, readyReplicas: 1 },
        },
        pods: [replica(pending, 'Pending'), replica('other', 'Running')],
        jobs: {
          queued: 0,
          running: 1,
          retrying: 0,
          terminal: 0,
          unreleased: 1,
        },
        template: {},
        nodePool: {
          clusterId: 'cluster',
          nodePoolId: 'pool',
          nvidiaGpusPerNode: 0,
        },
        cluster,
      });
    for (const [jobId, podUid] of [
      ['held', runtime.podUid],
      ['other', 'other'],
    ]) {
      await expect(
        store().claimTargetedJob({ ...claim(jobId), podUid }),
      ).resolves.toMatchObject({ kind: 'selected' });
    }
    // The apiserver already runs `runtime.podUid`, which claimed; the cache
    // lags it.
    await expect(scale(runtime.podUid)).resolves.toBe(2);
    // An idle Pending one is closed before the count drops, so once it
    // starts it can't claim a Job its removal would strand.
    await expect(scale('idle')).resolves.toBe(1);
    await expect(
      store().claimTargetedJob({ ...claim('next'), podUid: 'idle' }),
    ).resolves.toEqual({ kind: 'stale' });
  });

  it('never cuts again before the ReplicaSet removes the replicas the last cut closed', async () => {
    for (const id of ['next', 'cancelled']) await admit(id);
    const deployment = {
      ...(await getDeploymentStore().getById(runtime.deploymentId))!,
      maxReplicas: 3,
    };
    const cost = 'controller.kubernetes.io/pod-deletion-cost';
    // Oldest ready first, as the cache lists them; `fresh` just started.
    const pods = ['a', 'b', 'fresh'].map(
      (uid): V1Pod => ({
        metadata: { uid, name: uid, namespace: 'ns', annotations: {} },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }),
    );
    const cluster = makeClusterKubernetesClientFixture({
      core: {
        patchNamespacedPod: vi.fn(
          async (request: { name: string; body: { value?: string }[] }) => {
            const pod = pods.find(
              (each) => each.metadata!.name === request.name,
            );
            pod!.metadata!.annotations![cost] = request.body[1]!.value!;
            return {};
          },
        ),
      },
    });
    const policy = createReplicaPolicy({
      ...makeReplicaPolicyDependencies(),
      drainReplica: (id, podUid) => drainReplica(store(), id, podUid),
      reopenReplica: (podUid) => store().reopenReplica(podUid),
    });
    // The Deployment at `spec`, its status from the ReplicaSet's last sync.
    const scale = async (spec: number, generation: number) =>
      policy({
        deployment,
        current: {
          metadata: { generation },
          spec: { replicas: spec, selector: {}, template: {} },
          status: {
            observedGeneration: generation,
            replicas: pods.length,
            readyReplicas: pods.length,
          },
        },
        pods,
        jobs: await store().countTargetedJobs(deployment.id),
        template: {},
        nodePool: {
          clusterId: 'cluster',
          nodePoolId: 'pool',
          nvidiaGpusPerNode: 0,
        },
        cluster,
      });
    // The ReplicaSet removes ready replicas by lowest deletion cost, then
    // the most recently ready.
    const removed = (spec: number) =>
      [...pods]
        .reverse()
        .sort(
          (left, right) =>
            Number(left.metadata!.annotations![cost] ?? 0) -
            Number(right.metadata!.annotations![cost] ?? 0),
        )
        .slice(0, pods.length - spec)
        .map((pod) => pod.metadata!.uid!);
    // Two queued Jobs cut 3 to 2, closing `a`; `fresh` stays open.
    await expect(scale(3, 1)).resolves.toBe(2);
    await expect(
      store().claimTargetedJob({ ...claim('next'), podUid: 'fresh' }),
    ).resolves.toMatchObject({ kind: 'selected' });
    await outcomes().requestTermination('cancelled', owner);
    // `fresh` holds the one Job left, and the ReplicaSet hasn't yet
    // removed `a`: a cut now would take `fresh` with it.
    const spec = await scale(2, 2);
    const held = (await store().listTargetedExecutions(deployment.id)).map(
      (execution) => execution.podUid,
    );
    expect(held).toEqual(['fresh']);
    expect(removed(spec)).not.toContain('fresh');
  });

  it.each([
    {
      // Settled at 3: `a` holds a Job, `p1` and `p2` are starting, and one
      // Job is queued, so RA keeps 2. Before the ReplicaSet syncs, `p1`
      // starts and `p2` becomes ready and tries to claim. The ReplicaSet's
      // cache has `p1` start but still sees `p2` Pending, and removes
      // Pending replicas before any deletion cost.
      name: 'a closed one starts',
      pods: { a: 'Ready', p1: 'Pending', p2: 'Pending' },
      holders: ['a'],
      spec: 3,
      claimant: 'p2',
    },
    {
      // Settled at 5: the caches still see `b`, which claimed, Pending, so
      // RA finds it busy in the Pending tier. `n` is closed anyway: once
      // `p1` starts, the ReplicaSet would remove `n`, still not ready in
      // its cache, before `p1`.
      name: 'a busy one comes first',
      pods: {
        a: 'Ready',
        b: 'Pending',
        p1: 'Pending',
        n: 'Running',
        r: 'Ready',
      },
      holders: ['a', 'b'],
      spec: 5,
      claimant: 'n',
    },
  ])(
    'closes every starting replica on a cut when $name, so the one the ReplicaSet still sees starting never holds a Job',
    async ({ pods, holders, spec, claimant }) => {
      for (const id of [...holders, 'next']) await admit(id);
      for (const id of holders) {
        await expect(
          store().claimTargetedJob({ ...claim(id), podUid: id }),
        ).resolves.toMatchObject({ kind: 'selected' });
      }
      const deployment = {
        ...(await getDeploymentStore().getById(runtime.deploymentId))!,
        maxReplicas: spec,
      };
      const replicas = Object.entries(pods).map(
        ([uid, state]): V1Pod => ({
          metadata: { uid, name: uid, namespace: 'ns' },
          status: {
            phase: state === 'Pending' ? 'Pending' : 'Running',
            conditions: [
              { type: 'Ready', status: state === 'Ready' ? 'True' : 'False' },
            ],
          },
        }),
      );
      const policy = createReplicaPolicy({
        ...makeReplicaPolicyDependencies(),
        drainReplica: (id, podUid) => drainReplica(store(), id, podUid),
        reopenReplica: (podUid) => store().reopenReplica(podUid),
      });
      await expect(
        policy({
          deployment,
          current: {
            metadata: { generation: 1 },
            spec: { replicas: spec, selector: {}, template: {} },
            status: {
              observedGeneration: 1,
              replicas: spec,
              readyReplicas: Object.values(pods).filter(
                (state) => state === 'Ready',
              ).length,
            },
          },
          pods: replicas,
          jobs: await store().countTargetedJobs(deployment.id),
          template: {},
          nodePool: {
            clusterId: 'cluster',
            nodePoolId: 'pool',
            nvidiaGpusPerNode: 0,
          },
          cluster: makeClusterKubernetesClientFixture({
            core: { patchNamespacedPod: vi.fn(async () => ({})) },
          }),
        }),
      ).resolves.toBe(spec - 1);
      await store().claimTargetedJob({ ...claim('next'), podUid: claimant });
      const held = (await store().listTargetedExecutions(deployment.id)).map(
        (execution) => execution.podUid,
      );
      expect(held).toEqual(holders);
    },
  );

  it('lists managed demand on the cluster in submit order and bounds it by the user reservations', async () => {
    const deployments = getDeploymentStore();
    await deployments.create(
      {
        id: 'user-gpu',
        ownerUserId: 'owner',
        name: 'user-gpu',
        nodePoolId: 'pool',
        config: makeContainerSpec(),
        gpuCount: 2,
        maxConcurrentJobsPerReplica: 1,
        minReplicas: 1,
        maxReplicas: 3,
        reservation: { maxGpus: 100 },
      },
      owner,
    );
    await getDB().query(
      `UPDATE deployments SET managed = 1, gpu_count = 4, min_replicas = 0
       WHERE id = ?`,
      [runtime.deploymentId],
    );
    for (const id of ['late', 'held', 'early', 'staging']) await admit(id);
    // Past its claim deadline, a Job only waits for a claim to expire it.
    await admit('expired', 1);
    await getDB().query(
      `UPDATE workloads SET submitted_at = CASE id
         WHEN 'early' THEN 1 WHEN 'held' THEN 2 WHEN 'staging' THEN 4 ELSE 3 END`,
    );
    // A runner staging its Job (the syncing state) holds its replica too.
    await getDB().query(
      `UPDATE workloads SET state = 'syncing' WHERE id = 'staging'`,
    );
    // A managed replica claims once its bind is recorded (SLOT), here on an
    // unpriced Node.
    const vm = await getPersistence().nodePoolVms.beginVmAttempt('pool', {
      cloudId: 'node',
      region: 'us-east-1',
      availabilityZone: null,
      vmType: 't3.large',
      desiredVmCount: 1,
    });
    await getDeploymentStore().recordOccupancy(
      runtime.deploymentId,
      [{ podUid: runtime.podUid, vmId: vm!.vmRowId, share: 1, gpus: 4 }],
      [runtime.podUid],
    );
    await expect(
      store().claimTargetedJob(claim('held')),
    ).resolves.toMatchObject({ kind: 'selected' });
    await expect(
      getReplicaDemandStore().listManagedDemand('cluster-a'),
    ).resolves.toEqual([
      {
        deploymentId: runtime.deploymentId,
        session: null,
        held: false,
        hourlyUsd: null,
      },
      {
        deploymentId: runtime.deploymentId,
        session: null,
        held: true,
        hourlyUsd: null,
      },
      {
        deploymentId: runtime.deploymentId,
        session: null,
        held: false,
        hourlyUsd: null,
      },
      {
        deploymentId: runtime.deploymentId,
        session: null,
        held: true,
        hourlyUsd: null,
      },
    ]);
    await expect(
      getReplicaDemandStore().listManagedDemand('other-cluster'),
    ).resolves.toEqual([]);
    // Managed replicas reserve nothing: only the user Deployment's 2 × 3.
    await expect(
      getReplicaDemandStore().managedRoom('pool'),
    ).resolves.toMatchObject({
      reservedGpus: 6,
      vmPrice: null,
    });
  });
});
