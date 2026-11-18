import { randomBytes } from 'crypto';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import config, {
  RETRY_JITTER_CAP_MS,
  STUCK_ACTIVE_TIMEOUT_MS,
} from '../../../src/api/config';
import {
  cleanupRetryDelayMs,
  WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
  WORKLOAD_RECONCILE_POLL_INTERVAL_MS,
  WORKLOAD_RECONCILE_RETRY_INTERVAL_MS,
  WORKLOAD_RECONCILE_STUCK_INTERVAL_MS,
  WorkloadReconciler,
  type WorkloadReconcileLane,
  type WorkloadReconcileWork,
} from '../../../src/api/services/workload-reconciler';
import {
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';

const NOW = 2_000_000_000_000;
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { WorkloadQueryStore } from '../../../src/api/services/repositories/workload-queries.js';
import { createWorkload as insertWorkload } from '../../../src/api/services/repositories/workload-creation.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

describe('WorkloadReconciler', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createWorkload(
    id: string,
    state: WorkloadState,
    options?: {
      spot?: boolean;
      liveVm?: boolean;
      workloadType?: WorkloadType;
      checkpoint?: boolean;
    },
  ): Promise<void> {
    if (options?.checkpoint)
      await upsertCredential(
        getDB(),
        'storage',
        'test-ciphertext',
        CloudType.AWS,
      );
    await insertWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: options?.workloadType ?? WorkloadType.Job,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: options?.spot ?? false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
      checkpointBucket: options?.checkpoint ? 'service-state' : undefined,
      checkpointStorageCredentialId: options?.checkpoint
        ? 'storage'
        : undefined,
    });
    if (options?.liveVm) {
      await provisionTestVm(id, {
        ip: '10.0.0.1',
        cloudId: `${id}-vm`,
      });
    }
    // Retry timing here pins the host-step backoff, not the Provisioning one.
    if (state === WorkloadState.Retrying) {
      await walkToState(id, WorkloadState.Initializing);
    }
    await walkToState(id, state);
  }

  async function setLatestEventAt(
    id: string,
    createdAt: number,
  ): Promise<void> {
    await getDB().query(
      `UPDATE workload_events
       SET created_at = ?
       WHERE id = (
         SELECT id FROM workload_events
         WHERE workload_id = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [createdAt, id],
    );
  }

  it('schedules current state in memory without a durable cursor', async () => {
    await createWorkload('running-job', WorkloadState.Running);
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(),
    });

    await reconciler.discoverNow();

    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id: 'running-job',
        lane: 'poll',
        dueAt: NOW,
      }),
    ]);
  });

  it('admits a Running VM to the shared poll lane', async () => {
    await createWorkload('running-vm', WorkloadState.Running, {
      workloadType: WorkloadType.Vm,
    });
    const reconciler = new WorkloadReconciler({ reconcile: vi.fn() });

    await reconciler.discoverNow();

    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id: 'running-vm',
        lane: 'poll',
        dueAt: NOW,
      }),
    ]);
  });

  it('polls running Services only when explicit checkpoint credentials need renewal', async () => {
    await createWorkload('with-storage', WorkloadState.Running, {
      workloadType: WorkloadType.Service,
      checkpoint: true,
    });
    await createWorkload('without-storage', WorkloadState.Running, {
      workloadType: WorkloadType.Service,
    });
    const reconcile = vi.fn().mockResolvedValue({ disposition: 'completed' });
    const reconciler = new WorkloadReconciler({ reconcile });
    await reconciler.discoverNow();
    expect(reconciler.entriesForTests().map((entry) => entry.id)).toEqual([
      'with-storage',
    ]);
    await reconciler.pumpNow();
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ workloadId: 'with-storage', kind: 'poll' }),
      ),
    );
  });

  it('can make every active pipeline row immediately eligible for recovery', async () => {
    await createWorkload('fresh-active', WorkloadState.Downloading);
    await setLatestEventAt('fresh-active', NOW - 1_000);
    const normal = new WorkloadReconciler({ reconcile: vi.fn() });
    const immediate = new WorkloadReconciler({ reconcile: vi.fn() });

    await normal.discoverNow();
    await immediate.discoverNow({ activeRecoveryNow: true });

    expect(normal.entriesForTests()[0]).toMatchObject({
      lane: 'stuck',
      dueAt: NOW - 1_000 + STUCK_ACTIVE_TIMEOUT_MS,
    });
    expect(immediate.entriesForTests()[0]).toMatchObject({
      kind: 'active-recovery',
      lane: 'stuck',
      dueAt: NOW,
    });
  });

  // Run 42570629661 (dogfood-0174, Job D): each a2-highgpu-1g refusal waited
  // for the next 30 s discovery although its retry needed no backoff.
  it('launches a free failover at once, and leaves any other retry to discovery', async () => {
    const reconcile = vi
      .fn()
      .mockResolvedValue({ disposition: 'completed' as const });
    const reconciler = new WorkloadReconciler({ reconcile, random: () => 1 });
    const failover = async (id: string, metadata: Record<string, unknown>) => {
      await createWorkload(id, WorkloadState.Queued);
      // The scheduler's claim, the step's own Provisioning event, then the
      // refused launch, as the run recorded them.
      await lifecycle().updateState(id, WorkloadState.Provisioning, {
        metadata: { untriedTargets: 10 },
      });
      await lifecycle().updateState(id, WorkloadState.Provisioning, {
        metadata: { reason: 'active-step-replay' },
      });
      await lifecycle().updateState(id, WorkloadState.Retrying, {
        metadata: {
          diagnosis: 'capacity-exhausted',
          targetVmType: 'a2-highgpu-1g',
          targetRegion: 'us-central1',
          targetAvailabilityZone: 'b',
          ...metadata,
        },
      });
      return reconciler.enqueueImmediateRetryNow(id);
    };

    expect(
      await failover('free-failover', {
        disposition: 'failover-target',
        launchFailover: true,
      }),
    ).toBe(true);
    expect(
      await failover('same-target', { disposition: 'retry-same-target' }),
    ).toBe(false);
    // Launched now, not at the next discovery; the other waits for it.
    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id: 'free-failover',
        kind: 'retry-launch',
        dueAt: expect.any(Number),
      }),
    ]);
    expect(reconciler.entriesForTests()[0]!.dueAt).toBeLessThanOrEqual(NOW);
    // Not Retrying: nothing to wake.
    await createWorkload('running', WorkloadState.Running);
    expect(await reconciler.enqueueImmediateRetryNow('running')).toBe(false);
  });

  it('dispatches a woken free failover before any discovery', async () => {
    const reconcile = vi
      .fn()
      .mockResolvedValue({ disposition: 'completed' as const });
    // Started before the failover, with no discovery due for an hour.
    const reconciler = new WorkloadReconciler({
      reconcile,
      discoveryIntervalMs: 3_600_000,
    });
    await reconciler.start();
    try {
      const id = 'woken-failover';
      await createWorkload(id, WorkloadState.Queued);
      await lifecycle().updateState(id, WorkloadState.Provisioning, {
        metadata: { untriedTargets: 10 },
      });
      await lifecycle().updateState(id, WorkloadState.Retrying, {
        metadata: { disposition: 'failover-target', launchFailover: true },
      });
      expect(reconcile).not.toHaveBeenCalled();

      expect(await reconciler.enqueueImmediateRetryNow(id)).toBe(true);
      await reconciler.waitForInFlight();
      expect(
        reconcile.mock.calls.map(([work]) => [work.kind, work.workloadId]),
      ).toEqual([['retry-launch', id]]);
    } finally {
      await reconciler.stop(0);
    }
  });

  it('resamples retry jitter after restart inside the same durable window', async () => {
    await createWorkload('bounded-retry', WorkloadState.Retrying);
    const retryEventAt = NOW - 30_000;
    await setLatestEventAt('bounded-retry', retryEventAt);
    const first = new WorkloadReconciler({
      reconcile: vi.fn(),
      random: () => 0,
    });
    const restarted = new WorkloadReconciler({
      reconcile: vi.fn(),
      random: () => 1,
    });

    await first.discoverNow();
    await restarted.discoverNow();

    const firstEntry = first.entriesForTests()[0]!;
    const restartedEntry = restarted.entriesForTests()[0]!;
    expect(restartedEntry.retryDueAt).not.toBe(firstEntry.retryDueAt);
    expect(firstEntry.retryDueAt).toBeGreaterThan(retryEventAt);
    expect(restartedEntry.retryDueAt).toBeLessThanOrEqual(
      retryEventAt + RETRY_JITTER_CAP_MS,
    );
    expect(firstEntry).toMatchObject({
      kind: 'retry-prepare',
      dueAt: NOW,
    });
  });

  it('prepares a retry immediately and launches only at its sampled deadline', async () => {
    await createWorkload('phased-retry', WorkloadState.Retrying);
    const reconcile = vi
      .fn()
      .mockResolvedValue({ disposition: 'completed' as const });
    const reconciler = new WorkloadReconciler({
      reconcile,
      random: () => 0.5,
    });

    await reconciler.discoverNow();
    expect(reconciler.entriesForTests()[0]).toMatchObject({
      id: 'phased-retry',
      kind: 'retry-prepare',
      dueAt: NOW,
      retryDueAt: NOW + 60_000,
    });

    await reconciler.pumpNow();
    await reconciler.waitForInFlight();
    expect(reconcile.mock.calls.map(([work]) => work.kind)).toEqual([
      'retry-prepare',
    ]);
    expect(reconciler.entriesForTests()[0]).toMatchObject({
      kind: 'retry-launch',
      dueAt: NOW + 60_000,
    });

    vi.setSystemTime(NOW + 59_999);
    expect(await reconciler.pumpNow()).toBe(0);
    vi.setSystemTime(NOW + 60_000);
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();
    expect(reconcile.mock.calls.map(([work]) => work.kind)).toEqual([
      'retry-prepare',
      'retry-launch',
    ]);
  });

  it('replaces a stale retry revision during preflight without invoking it', async () => {
    await createWorkload('stale-retry', WorkloadState.Retrying);
    const originalGetCandidate =
      queries().getWorkloadReconcileCandidate.bind(queries());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(
      WorkloadQueryStore.prototype,
      'getWorkloadReconcileCandidate',
    ).mockImplementationOnce(async (id) => {
      await gate;
      return originalGetCandidate(id);
    });
    const reconcile = vi.fn();
    const reconciler = new WorkloadReconciler({
      reconcile,
      random: () => 0.5,
    });
    await reconciler.discoverNow();

    expect(await reconciler.pumpNow()).toBe(1);
    await walkToState('stale-retry', WorkloadState.Retrying);
    release();
    await reconciler.waitForInFlight();

    expect(reconcile).not.toHaveBeenCalled();
    expect(reconciler.entriesForTests()[0]).toMatchObject({
      id: 'stale-retry',
      kind: 'retry-prepare',
    });
  });

  it('samples jitter only once for an unchanged retry revision', async () => {
    await createWorkload('single-sample-retry', WorkloadState.Retrying);
    const random = vi.fn(() => 0.5);
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(),
      random,
    });

    await reconciler.discoverNow();
    await reconciler.discoverNow();

    expect(random).toHaveBeenCalledTimes(1);
  });

  it.each(['retry-prepare', 'retry-launch'] as const)(
    'resumes %s promptly after a long release batch without overlapping work',
    async (kind) => {
      const id = `long-release-${kind}`;
      await createWorkload(id, WorkloadState.Retrying);
      if (kind === 'retry-launch') {
        await setLatestEventAt(id, NOW - RETRY_JITTER_CAP_MS - 1);
      }
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reconcile = vi
        .fn()
        .mockResolvedValue({ disposition: 'completed' as const })
        .mockImplementationOnce(async () => {
          markStarted();
          await gate;
          return {
            disposition: 'deferred' as const,
            reason: 'release-pending' as const,
          };
        });
      const reconciler = new WorkloadReconciler({
        reconcile,
        random: () => 0.5,
      });
      await reconciler.discoverNow();
      const retryDueAt = reconciler.entriesForTests()[0]!.retryDueAt;

      expect(await reconciler.pumpNow()).toBe(1);
      await started;
      vi.setSystemTime(NOW + 290_000);
      await reconciler.discoverNow();
      expect(await reconciler.pumpNow()).toBe(0);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconciler.backlogStatus().inFlightCount).toBe(1);

      release();
      await reconciler.waitForInFlight();
      expect(reconciler.entriesForTests()[0]).toMatchObject({
        kind,
        dueAt: NOW + 290_000,
        retryDueAt,
      });
      expect(reconciler.backlogStatus().inFlightCount).toBe(0);
      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      expect(reconcile.mock.calls.map(([work]) => work.kind)).toEqual([
        kind,
        kind,
      ]);
    },
  );

  it.each(['retry-prepare', 'retry-launch'] as const)(
    'paces quick pending-release results from the actual %s start',
    async (kind) => {
      const id = `quick-release-${kind}`;
      await createWorkload(id, WorkloadState.Retrying);
      if (kind === 'retry-launch') {
        await setLatestEventAt(id, NOW - RETRY_JITTER_CAP_MS - 1);
      }
      const originalGetCandidate =
        queries().getWorkloadReconcileCandidate.bind(queries());
      vi.spyOn(
        WorkloadQueryStore.prototype,
        'getWorkloadReconcileCandidate',
      ).mockImplementationOnce(async (workloadId) => {
        vi.setSystemTime(NOW + 10_000);
        return originalGetCandidate(workloadId);
      });
      const reconcile = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 5_000);
        return {
          disposition: 'deferred' as const,
          reason: 'release-pending' as const,
        };
      });
      const reconciler = new WorkloadReconciler({
        reconcile,
        random: () => 0.5,
      });
      await reconciler.discoverNow();

      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      const dueAt = NOW + 10_000 + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS;
      expect(reconciler.entriesForTests()[0]).toMatchObject({ kind, dueAt });
      await reconciler.discoverNow();
      vi.setSystemTime(dueAt - 1);
      expect(await reconciler.pumpNow()).toBe(0);
      vi.setSystemTime(dueAt);
      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      expect(reconcile).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { timing: 'before', releaseDuration: 10_000 },
    { timing: 'after', releaseDuration: 50_000 },
  ])(
    'keeps the sampled launch deadline when release finishes $timing it',
    async ({ releaseDuration }) => {
      const id = `release-deadline-${releaseDuration}`;
      await createWorkload(id, WorkloadState.Retrying);
      const random = vi.fn(() => 1);
      const reconcile = vi
        .fn()
        .mockResolvedValue({ disposition: 'completed' as const })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(NOW + 1_000);
          return {
            disposition: 'deferred' as const,
            reason: 'release-pending' as const,
          };
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + releaseDuration);
          return { disposition: 'completed' as const };
        });
      const reconciler = new WorkloadReconciler({ reconcile, random });
      await reconciler.discoverNow();
      const retryDueAt = reconciler.entriesForTests()[0]!.retryDueAt!;
      expect(retryDueAt).toBe(NOW + 84_000);

      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      await reconciler.discoverNow();
      expect(reconciler.entriesForTests()[0]).toMatchObject({
        kind: 'retry-prepare',
        dueAt: NOW + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS,
        retryDueAt,
      });
      vi.setSystemTime(NOW + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS);
      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();

      expect(reconciler.entriesForTests()[0]).toMatchObject({
        kind: 'retry-launch',
        dueAt: retryDueAt,
        retryDueAt,
      });
      expect(random).toHaveBeenCalledTimes(1);
      if (Date.now() < retryDueAt) {
        expect(await reconciler.pumpNow()).toBe(0);
        vi.setSystemTime(retryDueAt);
      }
      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      expect(reconcile.mock.calls.map(([work]) => work.kind)).toEqual([
        'retry-prepare',
        'retry-prepare',
        'retry-launch',
      ]);
    },
  );

  it.each(['deferred', 'failed'] as const)(
    'preserves the existing retry gap after ordinary %s work',
    async (outcome) => {
      await createWorkload('ordinary-retry-gap', WorkloadState.Retrying);
      const reconciler = new WorkloadReconciler({
        reconcile: async () => {
          vi.setSystemTime(NOW + 290_000);
          if (outcome === 'failed') throw new Error('Provider request failed');
          return { disposition: 'deferred' };
        },
        random: () => 0.5,
      });
      await reconciler.discoverNow();

      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();

      expect(reconciler.entriesForTests()[0]).toMatchObject({
        kind: 'retry-prepare',
        dueAt: NOW + 290_000 + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS,
        retryDueAt: NOW + 60_000,
      });
      expect(await reconciler.pumpNow()).toBe(0);
    },
  );

  it('keeps a pending removal blocked across restart until confirmed release', async () => {
    const id = 'release-pending-restart';
    const retryEventAt = NOW - RETRY_JITTER_CAP_MS - 1;
    vi.setSystemTime(retryEventAt);
    await createWorkload(id, WorkloadState.Downloading, { liveVm: true });
    const store = queries();
    await walkToState(id, WorkloadState.Retrying);
    const retryBefore = await lifecycle().getRetryCandidatesByIds([id]);
    const eventsBefore = await eventLog().getWorkloadEvents(id);
    vi.setSystemTime(NOW);
    await ledger().claimVmRemoval(id, [`${id}-vm`]);

    const admissions: string[] = [];
    const reconcile = vi.fn(async (work: WorkloadReconcileWork) => {
      if (work.kind !== 'retry-launch') {
        throw new Error(`Unexpected work kind: ${work.kind}`);
      }
      const admission = await lifecycle().queueRetryCandidate(
        work.workloadId,
        work.expectedRevision,
      );
      admissions.push(admission);
      if (admission === 'release-pending') {
        return {
          disposition: 'deferred' as const,
          reason: 'release-pending' as const,
        };
      }
      return {
        disposition:
          admission === 'queued' ? ('completed' as const) : ('stale' as const),
      };
    });
    const original = new WorkloadReconciler({ reconcile, random: () => 0 });
    await original.discoverNow();
    expect(original.entriesForTests()[0]).toMatchObject({
      kind: 'retry-launch',
      retryDueAt: retryEventAt + 36_000,
    });
    expect(await original.pumpNow()).toBe(1);
    await original.waitForInFlight();
    expect(admissions).toEqual(['release-pending']);

    vi.setSystemTime(NOW + 1_000);
    const restarted = new WorkloadReconciler({ reconcile, random: () => 1 });
    await restarted.discoverNow();
    expect(restarted.entriesForTests()[0]).toMatchObject({
      kind: 'retry-launch',
      retryDueAt: retryEventAt + 84_000,
    });
    expect(await restarted.pumpNow()).toBe(1);
    await restarted.waitForInFlight();
    expect(admissions).toEqual(['release-pending', 'release-pending']);
    expect(await lifecycle().getRetryCandidatesByIds([id])).toEqual(
      retryBefore,
    );
    expect(await eventLog().getWorkloadEvents(id)).toEqual(eventsBefore);

    await releaseTestVms(id, `${id}-vm`);
    vi.setSystemTime(NOW + 1_000 + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS);
    expect(await restarted.pumpNow()).toBe(1);
    await restarted.waitForInFlight();
    expect(admissions).toEqual([
      'release-pending',
      'release-pending',
      'queued',
    ]);
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Queued);
    const eventsAfter = await eventLog().getWorkloadEvents(id);
    expect(eventsAfter).toHaveLength(eventsBefore.length + 1);
    expect(eventsAfter.at(-1)?.state).toBe(WorkloadState.Queued);
    expect(await restarted.pumpNow()).toBe(0);
  });

  it('does not apply pending-release retry pacing to a different lane', async () => {
    await createWorkload('poll-release-reason', WorkloadState.Running);
    const reconciler = new WorkloadReconciler({
      reconcile: async () => {
        vi.setSystemTime(NOW + 290_000);
        return { disposition: 'deferred', reason: 'release-pending' };
      },
    });
    await reconciler.discoverNow();

    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();

    expect(reconciler.entriesForTests()[0]).toMatchObject({
      kind: 'poll',
      dueAt: NOW + 290_000 + WORKLOAD_RECONCILE_POLL_INTERVAL_MS,
    });
  });

  it('polls a Running Workload now, after any in-flight poll, and refuses others', async () => {
    await createWorkload('saved-secret', WorkloadState.Running, {
      liveVm: true,
    });
    await createWorkload('queued', WorkloadState.Queued);
    let release!: () => void;
    const reconcile = vi.fn(
      (_work: WorkloadReconcileWork) =>
        new Promise<void>((resolve) => (release = resolve)),
    );
    const reconciler = new WorkloadReconciler({ reconcile });
    await reconciler.discoverNow();
    vi.setSystemTime(NOW + WORKLOAD_RECONCILE_POLL_INTERVAL_MS);
    expect(await reconciler.pumpNow()).toBe(1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    // A save during the in-flight poll still gets its own poll right after.
    expect(await reconciler.enqueuePollNow('saved-secret')).toBe(true);
    release();
    await reconciler.waitForInFlight();
    expect(await reconciler.pumpNow()).toBe(1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    release();
    await reconciler.waitForInFlight();
    expect(reconcile.mock.calls.map(([work]) => work)).toEqual([
      { workloadId: 'saved-secret', kind: 'poll' },
      { workloadId: 'saved-secret', kind: 'poll' },
    ]);
    expect(await reconciler.enqueuePollNow('queued')).toBe(false);
    expect(await reconciler.enqueuePollNow('missing')).toBe(false);
  });

  it('discovers durable cleanup without a VM row', async () => {
    await createWorkload('network-only-cleanup', WorkloadState.Terminated);
    await outcomes().requestTermination(
      'network-only-cleanup',
      scope('test-user'),
    );
    const reconcile = vi.fn(async () => {
      expect(
        (await queries().getWorkload('network-only-cleanup'))?.cleanedAt,
      ).toBeNull();
      await outcomes().markCleanupComplete('network-only-cleanup');
    });
    const reconciler = new WorkloadReconciler({ reconcile });

    await reconciler.discoverNow();
    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id: 'network-only-cleanup',
        kind: 'cleanup',
      }),
    ]);
    expect(await reconciler.enqueueCleanupNow('network-only-cleanup')).toBe(
      true,
    );

    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        workloadId: 'network-only-cleanup',
        kind: 'cleanup',
      }),
    );
    expect(reconciler.entriesForTests()).toEqual([]);
  });

  it('backs off failed cleanup after updating termination diagnostics', async () => {
    const id = 'diagnostic-cleanup-backoff';
    await createWorkload(id, WorkloadState.Terminated, { liveVm: true });
    const store = queries();
    const revisionBefore = (await store.getWorkloadReconcileCandidate(id))
      ?.revision;
    const reconcile = vi.fn(async () => {
      await eventLog().updateTerminalDiagnostics(id, {
        rcloneLogs: 'output-sync: failed',
      });
      return { disposition: 'deferred' as const };
    });
    const reconciler = new WorkloadReconciler({ reconcile });

    await reconciler.discoverNow();
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();

    expect((await store.getWorkloadReconcileCandidate(id))?.revision).toBe(
      revisionBefore,
    );
    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id,
        lane: 'cleanup',
        dueAt: NOW + cleanupRetryDelayMs(0),
      }),
    ]);
    expect(await reconciler.pumpNow()).toBe(0);
  });

  it('escalates the cleanup retry gap while a VM stays live, capped at the lane interval', async () => {
    const id = 'cleanup-retry-escalation';
    await createWorkload(id, WorkloadState.Terminated, { liveVm: true });
    // Every gap here is billed VM time, so the first retries must be short and
    // then widen with how long teardown has been outstanding.
    const expectedGaps = [
      20_000,
      20_000,
      40_000,
      80_000,
      160_000,
      WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
      WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
    ];
    const reconcile = vi.fn(async () => ({ disposition: 'deferred' as const }));
    const reconciler = new WorkloadReconciler({ reconcile });

    await reconciler.discoverNow();
    const observed: number[] = [];
    for (const _ of expectedGaps) {
      const startedAt = Date.now();
      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      const [entry] = reconciler.entriesForTests();
      observed.push(entry!.dueAt - startedAt);
      vi.setSystemTime(entry!.dueAt);
    }

    expect(observed).toEqual(expectedGaps);
  });

  it('gives a long-pending teardown the capped gap on its first attempt after a restart', async () => {
    // The reconciler map is rebuilt from scratch on restart. Deriving the gap
    // from durable state rather than an in-memory tally is what stops a
    // teardown that has been stuck for an hour dropping back to 20s polling.
    const id = 'cleanup-retry-after-restart';
    vi.setSystemTime(NOW - 40 * 60_000);
    await createWorkload(id, WorkloadState.Terminated, { liveVm: true });
    vi.setSystemTime(NOW);
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(async () => ({ disposition: 'deferred' as const })),
    });

    await reconciler.discoverNow();
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();

    expect(reconciler.entriesForTests()[0]!.dueAt).toBe(
      NOW + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
    );
  });

  it('keeps the escalated cleanup gap when a later event lands on the teardown', async () => {
    // Pacing derives from completed_at precisely so that recording anything
    // new in the event log after the terminal outcome cannot drop a
    // long-pending teardown back to the 20-second floor.
    const id = 'cleanup-retry-ignores-new-events';
    vi.setSystemTime(NOW - 40 * 60_000);
    await createWorkload(id, WorkloadState.Terminated, { liveVm: true });
    vi.setSystemTime(NOW);
    await getDB().query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, NULL, ?)`,
      [id, WorkloadState.Terminated, NOW],
    );
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(async () => ({ disposition: 'deferred' as const })),
    });

    await reconciler.discoverNow();
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();

    expect(reconciler.entriesForTests()[0]!.dueAt).toBe(
      NOW + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
    );
  });

  it('keeps the escalated cleanup gap when events land between and during attempts', async () => {
    // The anchor alone is not enough: rescheduling a cleanup entry whose
    // snapshot changed must not fall through to classifySnapshot's immediate
    // dueAt. Covers both replacement paths — discovery mid-gap and the
    // post-attempt refresh.
    const id = 'cleanup-retry-event-mid-gap';
    vi.setSystemTime(NOW - 40 * 60_000);
    await createWorkload(id, WorkloadState.Terminated, { liveVm: true });
    vi.setSystemTime(NOW);
    const reconcile = vi.fn(async () => ({ disposition: 'deferred' as const }));
    const reconciler = new WorkloadReconciler({ reconcile });

    await reconciler.discoverNow();
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();
    const paced = reconciler.entriesForTests()[0]!.dueAt;
    expect(paced).toBe(NOW + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS);

    // An event landing while the gap is pending must not pull the deadline
    // forward on the next discovery pass.
    await getDB().query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, NULL, ?)`,
      [id, WorkloadState.Terminated, NOW + 1_000],
    );
    await reconciler.discoverNow();
    expect(reconciler.entriesForTests()[0]!.dueAt).toBe(paced);

    // An event written during the attempt must not collapse the next gap
    // into an immediate retry either.
    vi.setSystemTime(paced);
    reconcile.mockImplementationOnce(async () => {
      await getDB().query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, NULL, ?)`,
        [id, WorkloadState.Terminated, paced],
      );
      return { disposition: 'deferred' as const };
    });
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();
    expect(reconciler.entriesForTests()[0]!.dueAt).toBe(
      paced + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
    );
  });

  it('leaves every non-cleanup lane on its own fixed interval', async () => {
    const id = 'poll-lane-interval-unchanged';
    await createWorkload(id, WorkloadState.Running, { liveVm: true });
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(async () => ({ disposition: 'deferred' as const })),
    });

    await reconciler.discoverNow();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await reconciler.pumpNow()).toBe(1);
      await reconciler.waitForInFlight();
      const [entry] = reconciler.entriesForTests();
      expect(entry!.lane).toBe('poll');
      expect(entry!.dueAt - Date.now()).toBe(
        WORKLOAD_RECONCILE_POLL_INTERVAL_MS,
      );
      vi.setSystemTime(entry!.dueAt);
    }
  });

  it('preserves network-only cleanup requested while work is in flight', async () => {
    const id = 'in-flight-network-cleanup';
    await createWorkload(id, WorkloadState.Running);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn(async (work) => {
      if (work.kind === 'poll') {
        markStarted();
        await gate;
      } else if (work.kind === 'cleanup') {
        expect((await queries().getWorkload(id))?.cleanedAt).toBeNull();
        await outcomes().markCleanupComplete(id);
      }
    });
    const reconciler = new WorkloadReconciler({ reconcile });
    await reconciler.discoverNow();

    expect(await reconciler.pumpNow()).toBe(1);
    await started;
    await outcomes().requestTermination(id, scope('test-user'));
    expect(await reconciler.enqueueCleanupNow(id)).toBe(true);
    release();
    await reconciler.waitForInFlight();

    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id,
        lane: 'cleanup',
        kind: 'cleanup',
        dueAt: NOW,
      }),
    ]);
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();
    expect(reconcile.mock.calls.map(([work]) => work.kind)).toEqual([
      'poll',
      'cleanup',
    ]);
    expect(reconciler.entriesForTests()).toEqual([]);
  });

  it('gives each low-volume lane four turns and poll the remaining 24 at K=40', async () => {
    const expected: Record<WorkloadReconcileLane, number> = {
      retry: 4,
      finalization: 4,
      cleanup: 4,
      stuck: 4,
      poll: 24,
    };
    for (let index = 0; index < 4; index += 1) {
      await createWorkload(`retry-${index}`, WorkloadState.Retrying);
      await setLatestEventAt(`retry-${index}`, NOW - RETRY_JITTER_CAP_MS - 1);
      await createWorkload(`finalization-${index}`, WorkloadState.Finalizing);
      await createWorkload(`cleanup-${index}`, WorkloadState.Terminated, {
        liveVm: true,
      });
      await createWorkload(`stuck-${index}`, WorkloadState.Provisioning);
      await setLatestEventAt(
        `stuck-${index}`,
        NOW - STUCK_ACTIVE_TIMEOUT_MS - 1,
      );
    }
    for (let index = 0; index < 24; index += 1) {
      await createWorkload(`poll-${index}`, WorkloadState.Running);
    }

    const selected: Record<WorkloadReconcileLane, number> = {
      retry: 0,
      finalization: 0,
      cleanup: 0,
      stuck: 0,
      poll: 0,
    };
    const laneById = new Map<string, WorkloadReconcileLane>();
    const reconciler = new WorkloadReconciler({
      maxInFlight: 40,
      reconcile: async (work) => {
        selected[laneById.get(work.workloadId)!] += 1;
      },
    });
    await reconciler.discoverNow();
    for (const entry of reconciler.entriesForTests()) {
      laneById.set(entry.id, entry.lane);
    }

    expect(await reconciler.pumpNow()).toBe(40);
    await reconciler.waitForInFlight();

    expect(selected).toEqual(expected);
  });

  it('does not apply a separate cap to active recovery', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createWorkload(
        `blocked-active-${index}`,
        WorkloadState.Downloading,
      );
    }

    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const reconcile = vi.fn(async (work) => {
      if (work.kind === 'active-recovery') await activeGate;
    });
    const reconciler = new WorkloadReconciler({
      maxInFlight: 3,
      reconcile,
    });
    await reconciler.discoverNow({ activeRecoveryNow: true });

    expect(await reconciler.pumpNow()).toBe(3);
    await vi.waitFor(() => {
      expect(
        reconcile.mock.calls.filter(
          ([work]) => work.kind === 'active-recovery',
        ),
      ).toHaveLength(3);
    });
    expect(await reconciler.pumpNow()).toBe(0);

    releaseActive();
    await reconciler.waitForInFlight();
  });

  it('reschedules unchanged work at its lane interval after completion', async () => {
    await createWorkload('poll-again', WorkloadState.Running);
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(),
    });
    await reconciler.discoverNow();

    await reconciler.pumpNow();
    await reconciler.waitForInFlight();

    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id: 'poll-again',
        lane: 'poll',
        dueAt: NOW + WORKLOAD_RECONCILE_POLL_INTERVAL_MS,
      }),
    ]);
    expect(await reconciler.pumpNow()).toBe(0);
  });

  it('preserves a paced recovery installed while the previous handoff settles', async () => {
    const id = 'paced-active-recovery-race';
    await createWorkload(id, WorkloadState.Provisioning);
    async function reconcileWork() {
      await reconciler.deferActiveRecovery(id);
      return { disposition: 'completed' as const };
    }
    const reconcile = vi.fn(reconcileWork);
    const reconciler = new WorkloadReconciler({ reconcile });
    await reconciler.discoverNow({ activeRecoveryNow: true });

    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id,
        kind: 'active-recovery',
        dueAt: NOW + WORKLOAD_RECONCILE_STUCK_INTERVAL_MS,
      }),
    ]);
    expect(await reconciler.pumpNow()).toBe(0);

    vi.setSystemTime(NOW + WORKLOAD_RECONCILE_STUCK_INTERVAL_MS);
    expect(await reconciler.pumpNow()).toBe(1);
    await reconciler.waitForInFlight();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('drops an item when work transitions it out of the reconciled live set', async () => {
    await createWorkload('became-queued', WorkloadState.Running);
    const reconciler = new WorkloadReconciler({
      reconcile: async (work) => {
        await walkToState(work.workloadId, WorkloadState.Queued);
      },
    });
    await reconciler.discoverNow();

    await reconciler.pumpNow();
    await reconciler.waitForInFlight();

    expect(reconciler.entriesForTests()).toEqual([]);
  });

  it('discovers cleanup for any terminal workload that still has a VM', async () => {
    await createWorkload('completed-with-vm', WorkloadState.Completed, {
      liveVm: true,
    });
    const reconciler = new WorkloadReconciler({ reconcile: vi.fn() });

    await reconciler.discoverNow();

    expect(reconciler.entriesForTests()).toEqual([
      expect.objectContaining({
        id: 'completed-with-vm',
        lane: 'cleanup',
        dueAt: NOW,
      }),
    ]);
  });

  it('isolates a failed item and keeps other due work moving', async () => {
    await createWorkload('poison', WorkloadState.Running);
    await createWorkload('healthy', WorkloadState.Running);
    const seen: string[] = [];
    const reconciler = new WorkloadReconciler({
      reconcile: async (work) => {
        if (work.workloadId === 'poison') throw new Error('bad row');
        seen.push(work.workloadId);
      },
    });
    await reconciler.discoverNow();

    const status = await reconciler.drainDue(1_000);

    expect(seen).toEqual(['healthy']);
    expect(status).toMatchObject({
      processedCount: 2,
      failureCount: 1,
      deferredCount: 0,
    });
  });

  it('reports how far behind due work has fallen', async () => {
    await createWorkload('running-job', WorkloadState.Running);
    const reconciler = new WorkloadReconciler({ reconcile: vi.fn() });
    await reconciler.discoverNow();

    expect(reconciler.backlogStatus()).toEqual({
      scheduledCount: 1,
      inFlightCount: 0,
      oldestDueAgeMs: 0,
    });

    vi.setSystemTime(NOW + 20 * 60_000);

    expect(reconciler.backlogStatus()).toEqual({
      scheduledCount: 1,
      inFlightCount: 0,
      oldestDueAgeMs: 20 * 60_000,
    });
  });

  it('hydrates retry history only when its durable revision changes', async () => {
    await createWorkload('unchanged-retry', WorkloadState.Retrying);
    const hydrate = vi.spyOn(lifecycle(), 'getRetryCandidatesByIds');
    const reconciler = new WorkloadReconciler({ reconcile: vi.fn() });

    await reconciler.discoverNow();
    await reconciler.discoverNow();

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledWith(['unchanged-retry']);
  });
});
