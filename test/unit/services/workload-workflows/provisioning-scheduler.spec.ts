import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterEach,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSHManager } from '../../../../src/api/services/gateways/ssh';
import {
  getNotificationsStore,
  getSpendControlsStore,
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getProvisioningAttemptStore as ledger,
} from '../../../../src/api/services/persistence.js';
import {
  provisionTestVm,
  releaseTestVms,
  walkToState,
} from '../../../helpers/workload-store.js';
import { resolveWorkloadPrice } from '../../../../src/shared/catalog/index.js';
import { getDB } from '../../../../src/api/services/repositories/db';
import { CloudType, type CloudConfig } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  FAILED_DEPLOY_MAX_ATTEMPTS,
  MAX_ACTIVE_DEPLOY_PIPELINES,
  RETRY_JITTER_CAP_MS,
} from '../../../../src/api/config';

const { updateNotificationMock } = vi.hoisted(() => ({
  updateNotificationMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/api/services/serve/default-runtime', async () =>
  (await import('../../helpers/monitor-harness')).serveRuntimeMock(),
);
vi.mock(
  '../../../../src/api/services/host-runtime/vm-container-repair',
  async () =>
    (await import('../../helpers/monitor-harness')).vmContainerRepairMock(),
);
vi.mock(
  '../../../../src/api/services/workload-workflows/vm-host-startup',
  async () =>
    (await import('../../helpers/monitor-harness')).vmHostStartupMock(),
);
vi.mock(
  '../../../../src/api/services/workload-workflows/completion',
  async () => (await import('../../helpers/monitor-harness')).completionMock(),
);
vi.mock('../../../../src/api/services/host-runtime/termination', async () =>
  (await import('../../helpers/monitor-harness')).terminationMock(),
);
vi.mock('../../../../src/api/services/workload-cleanup', async () =>
  (await import('../../helpers/monitor-harness')).workloadCleanupMock(),
);
vi.mock('../../../../src/api/services/update-notifications', () => ({
  UPDATE_NOTIFICATION_INTERVAL_MS: 60 * 60_000,
  runUpdateNotificationOnce: updateNotificationMock,
}));
vi.mock('../../../../src/api/services/docker');
vi.mock('../../../../src/api/services/catalog-readiness', async () =>
  (await import('../../helpers/monitor-harness')).catalogReadinessMock(),
);
vi.mock('../../../../src/shared/utils', async (importOriginal) =>
  (await import('../../helpers/monitor-harness')).sharedUtilsMock(
    await importOriginal(),
  ),
);
vi.mock('../../../../src/api/services/cloud-config', async (importOriginal) =>
  (await import('../../helpers/monitor-harness')).cloudConfigMock(
    await importOriginal(),
  ),
);

import {
  passthroughTimeout,
  serveRuntime,
} from '../../helpers/monitor-harness';

import {
  runProvisioningSchedulerOnce,
  runWorkloadReconcileOnce,
} from '../../../../src/api/services/monitor';
import { WorkloadReconciler } from '../../../../src/api/services/workload-reconciler';
import * as startup from '../../../../src/api/services/workload-workflows/vm-host-startup';
import {
  encryptCredential,
  hashCredential,
  resolveProvisioningConfig,
} from '../../../../src/api/services/cloud-config';
import {
  checkNetworkConnectivity,
  withTimeout,
} from '../../../../src/shared/utils';
import {
  TEST_AWS_CRED,
  TEST_GCP_CRED,
  TEST_LAMBDA_CRED,
} from '../../helpers/fixtures';
function enableSlackNotifications(): Promise<void> {
  return getNotificationsStore().saveChannel('slack', {
    webhook: 'https://hooks.slack.com/services/T/B/x',
  });
}
import {
  ResourceOwnershipError,
  ResourceStateIndeterminateError,
} from '../../../../src/shared/errors';
import { drainWorkloadWork } from '../../../../src/api/services/workload-work-registry';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

describe('runProvisioningSchedulerOnce', () => {
  let sshPrivateKey: string;
  let tempHome: string;
  let originalHome: string | undefined;
  const fetchMock = vi.fn();
  const budgetTestNow = new Date('2026-05-24T12:00:00Z');

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    vi.mocked(checkNetworkConnectivity).mockReset();
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
    vi.mocked(startup.deploy).mockReset();
    vi.mocked(startup.deploy).mockResolvedValue(undefined);
    // Scheduler tests exercise admission/orchestration, not target placement.
    // Keep that boundary explicit so this suite never constructs a live cloud
    // gateway; placement's published-catalog contract lives in optimizer and
    // GPU-resolution specs.
    vi.mocked(resolveProvisioningConfig).mockReset();
    vi.mocked(resolveProvisioningConfig).mockImplementation(
      async (workload) => ({
        state: WorkloadState.Provisioning,
        credentialId: workload.credentialId ?? undefined,
        config: {
          cloudProvider: CloudType.GCP,
          region: workload.region ?? 'us-central1',
          vmType:
            typeof workload.vmType === 'string'
              ? workload.vmType
              : (workload.vmType?.[0] ?? 'n2-standard-4'),
          spot: workload.spot,
          credentials: TEST_GCP_CRED,
        },
      }),
    );
    serveRuntime.deploy.mockReset();
    serveRuntime.deploy.mockResolvedValue(undefined);
    vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
    // Isolate HOME so the scheduler's notifications-config lookup can't pick up
    // a real ~/.anycloud/notifications.json and fire a live webhook during tests.
    tempHome = mkdtempSync(join(tmpdir(), 'anycloud-sched-'));
    originalHome = process.env.HOME;
    // Keep the isolation while copying the published catalogs downloaded by
    // test/global-setup.ts. Spend-control price lookups must use production
    // catalog data, not a generated test CSV.
    cpSync(
      join(originalHome ?? homedir(), '.anycloud', 'catalogs'),
      join(tempHome, '.anycloud', 'catalogs'),
      { recursive: true },
    );
    process.env.HOME = tempHome;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function useStableBudgetWindow(): void {
    vi.useFakeTimers();
    vi.setSystemTime(budgetTestNow);
  }

  async function createQueuedWorkload(
    id: string,
    credentialId: string,
    options?: {
      session?: string;
      workloadType?: WorkloadType;
      userId?: string;
      ownerUserId?: string;
    },
  ): Promise<void> {
    await createWorkload(getDB(), {
      id,
      userId: options?.userId ?? 'test-user',
      ownerUserId: options?.ownerUserId,
      workloadType: options?.workloadType ?? WorkloadType.Job,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
      session: options?.session,
    });
    // createWorkload starts in Queued state
  }

  it('dispatches queued workloads up to the concurrency cap', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createQueuedWorkload('sched-1', credentialId);
    await createQueuedWorkload('sched-2', credentialId);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(2);
    const d1 = await store.getWorkload('sched-1');
    const d2 = await store.getWorkload('sched-2');
    expect(d1?.state).toBe(WorkloadState.Provisioning);
    expect(d2?.state).toBe(WorkloadState.Provisioning);
    const intent = await eventLog().getLatestProvisioningIntent('sched-1');
    expect(intent).toEqual({
      cloudProvider: CloudType.GCP,
      availabilityZone: null,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      credentialId,
    });
  });

  it('hands an inconclusive provisioning dispatch to active recovery', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createQueuedWorkload('sched-indeterminate', credentialId);
    vi.mocked(startup.deploy)
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(
        new ResourceStateIndeterminateError(
          'Could not inspect the existing provisioning attempt',
          new Error('provider timeout'),
        ),
      );
    const enqueue = vi.spyOn(
      WorkloadReconciler.prototype,
      'deferActiveRecovery',
    );

    try {
      await runProvisioningSchedulerOnce();
      await vi.waitFor(() =>
        expect(enqueue).toHaveBeenCalledWith('sched-indeterminate'),
      );
      expect(await enqueue.mock.results.at(-1)!.value).toBe(true);

      expect((await store.getWorkload('sched-indeterminate'))?.state).toBe(
        WorkloadState.Provisioning,
      );
      expect(startup.deploy).toHaveBeenCalledOnce();
    } finally {
      enqueue.mockRestore();
    }
  });

  it('does not start a second run when recovery observes a scheduler-owned workload', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createQueuedWorkload('sched-single-flight', credentialId);

    let release!: () => void;
    vi.mocked(startup.deploy).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    try {
      await runProvisioningSchedulerOnce();
      await vi.waitFor(() => expect(startup.deploy).toHaveBeenCalledOnce());

      await runWorkloadReconcileOnce({ activeRecoveryNow: true });

      expect(startup.deploy).toHaveBeenCalledOnce();
      expect((await store.getWorkload('sched-single-flight'))?.state).toBe(
        WorkloadState.Provisioning,
      );
    } finally {
      release();
      await Promise.resolve();
    }
  });

  it('does not let one credential backlog starve another credential', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const laneA = await upsertCredential(
      getDB(),
      'scheduler-lane-a',
      encryptedCred,
      CloudType.GCP,
    );
    const laneB = await upsertCredential(
      getDB(),
      'scheduler-lane-b',
      encryptedCred,
      CloudType.GCP,
    );

    for (let i = 0; i < 60; i++) {
      const id = `sched-lane-a-${i.toString().padStart(2, '0')}`;
      await createQueuedWorkload(id, laneA);
      await getDB().query(`UPDATE workloads SET started_at = ? WHERE id = ?`, [
        i + 1,
        id,
      ]);
    }
    await createQueuedWorkload('sched-lane-b', laneB);
    await getDB().query(`UPDATE workloads SET started_at = ? WHERE id = ?`, [
      1_000,
      'sched-lane-b',
    ]);

    const resolvedConfig: CloudConfig = {
      cloudProvider: CloudType.GCP,
      vmType: 'n2-standard-4',
      region: 'us-central1',
      spot: false,
      credentials: TEST_LAMBDA_CRED,
    };
    for (let i = 0; i < MAX_ACTIVE_DEPLOY_PIPELINES; i++) {
      vi.mocked(resolveProvisioningConfig).mockResolvedValueOnce({
        state: WorkloadState.Provisioning,
        config: resolvedConfig,
      });
    }

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(MAX_ACTIVE_DEPLOY_PIPELINES);
    expect((await store.getWorkload('sched-lane-b'))?.state).toBe(
      WorkloadState.Provisioning,
    );
    const laneAStates = await getDB().query<{ state: WorkloadState }>(
      `SELECT state FROM workloads WHERE id LIKE 'sched-lane-a-%'`,
    );
    expect(
      laneAStates.filter((row) => row.state === WorkloadState.Provisioning),
    ).toHaveLength(MAX_ACTIVE_DEPLOY_PIPELINES - 1);
  });

  it('dispatches queued services through the Serve runtime boundary', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createQueuedWorkload('sched-serve', credentialId, {
      workloadType: WorkloadType.Service,
    });

    await runProvisioningSchedulerOnce();

    const workload = await store.getWorkload('sched-serve');
    expect(serveRuntime.deploy).toHaveBeenCalledWith({
      workload: expect.objectContaining({
        id: 'sched-serve',
        workloadType: WorkloadType.Service,
      }),
      placement: {
        cloudConfig: expect.objectContaining({
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          vmType: 'n2-standard-4',
        }),
        selectedCredentialId: credentialId,
      },
      resumeFrom: WorkloadState.Provisioning,
      replayActiveStep: true,
    });
    expect(startup.deploy).not.toHaveBeenCalled();
    expect(workload?.state).toBe(WorkloadState.Provisioning);
  });

  it('publishes Invalid when a Serve runtime rejects user input', async () => {
    // The Kubernetes Serve runtime is not wrapped in runStep, so a deterministic
    // name owned by another workload reaches its terminal outcome only here.
    // Retrying it would burn the whole retry budget re-issuing the same create.
    const store = queries();
    const credentialId = await seedLambdaCredential();
    await createQueuedWorkload('sched-serve-foreign', credentialId, {
      workloadType: WorkloadType.Service,
    });
    serveRuntime.deploy.mockRejectedValueOnce(
      new ResourceOwnershipError(
        'Kubernetes Serve Service already exists and is not owned by this workload',
      ),
    );

    await runProvisioningSchedulerOnce();
    await drainWorkloadWork('sched-serve-foreign');

    const workload = await store.getWorkload('sched-serve-foreign');
    expect(workload?.state).toBe(WorkloadState.Invalid);
    expect(workload?.completedAt).toEqual(expect.any(Number));
    expect(workload?.cleanedAt).toBeNull();
    const events = await eventLog().getWorkloadEvents('sched-serve-foreign');
    expect(events.at(-1)?.state).toBe(WorkloadState.Invalid);
    // Same error-only metadata shape runStep publishes for Invalid.
    expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
      error: {
        name: 'ResourceOwnershipError',
        message: expect.stringContaining('not owned by this workload'),
      },
    });
  });

  it('still routes infrastructure failures to Retrying', async () => {
    const store = queries();
    const credentialId = await seedLambdaCredential();
    await createQueuedWorkload('sched-serve-flake', credentialId, {
      workloadType: WorkloadType.Service,
    });
    serveRuntime.deploy.mockRejectedValueOnce(new Error('cluster unreachable'));

    await runProvisioningSchedulerOnce();
    await drainWorkloadWork('sched-serve-flake');

    const workload = await store.getWorkload('sched-serve-flake');
    expect(workload?.state).toBe(WorkloadState.Retrying);
    expect(workload?.completedAt).toBeNull();
  });

  it('dedups repeated Queued block resolutions instead of spamming events', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createQueuedWorkload('sched-blocked', credentialId);

    const message =
      'Credential "x" is failing authentication; re-enter a valid secret';
    vi.mocked(resolveProvisioningConfig)
      .mockResolvedValueOnce({ state: WorkloadState.Queued, message })
      .mockResolvedValueOnce({ state: WorkloadState.Queued, message })
      .mockResolvedValueOnce({ state: WorkloadState.Queued, message });

    await runProvisioningSchedulerOnce();
    await runProvisioningSchedulerOnce();
    await runProvisioningSchedulerOnce();

    // A durable block recurs every tick; it must append the reason at most once,
    // not one workload_events row per tick (the unbounded-growth regression).
    const events = await eventLog().getWorkloadEvents('sched-blocked');
    const blockEvents = events.filter(
      (e) => e.metadata && JSON.parse(e.metadata).message === message,
    );
    expect(blockEvents.length).toBe(1);
    expect(startup.deploy).not.toHaveBeenCalled();
  });

  it('does not let slow config resolution block other queued workloads', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createQueuedWorkload('slow-resolve', credentialId);
    await createQueuedWorkload('fast-resolve', credentialId);
    await getDB().query(
      `UPDATE workloads
       SET started_at = CASE id
         WHEN 'slow-resolve' THEN 1
         WHEN 'fast-resolve' THEN 2
       END
       WHERE id IN ('slow-resolve', 'fast-resolve')`,
    );

    const slowResolution = new Promise<never>(() => {});
    const fastConfig: CloudConfig = {
      cloudProvider: CloudType.GCP,
      vmType: 'n2-standard-4',
      region: 'us-central1',
      spot: false,
      credentials: TEST_LAMBDA_CRED,
    };

    let slowResolutionSignal: AbortSignal | undefined;
    vi.mocked(resolveProvisioningConfig)
      .mockImplementationOnce((_workload, _store, _credentials, options) => {
        slowResolutionSignal = options?.signal;
        return slowResolution;
      })
      .mockResolvedValueOnce({
        state: WorkloadState.Provisioning,
        config: fastConfig,
      });
    vi.mocked(withTimeout).mockImplementation(((
      promise: Promise<unknown>,
      _timeoutMs: number,
      operationName: string,
    ) => {
      if (operationName.includes('slow-resolve')) {
        return Promise.reject(new Error('timeout'));
      }
      return promise;
    }) as typeof withTimeout);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const slow = await store.getWorkload('slow-resolve');
    const fast = await store.getWorkload('fast-resolve');
    expect(slow?.state).toBe(WorkloadState.Queued);
    expect(fast?.state).toBe(WorkloadState.Provisioning);
    expect(slowResolutionSignal?.aborted).toBe(true);

    const slowEvents = await eventLog().getWorkloadEvents('slow-resolve');
    const lastEvent = slowEvents[slowEvents.length - 1];
    expect(lastEvent?.state).toBe(WorkloadState.Queued);
    expect(JSON.parse(lastEvent!.metadata!).message).toContain(
      'retrying shortly',
    );
  });

  it('does not dispatch when the concurrency cap is full', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createQueuedWorkload('sched-queued', credentialId);

    // Fill the cap with active Provisioning rows
    for (let i = 0; i < MAX_ACTIVE_DEPLOY_PIPELINES; i++) {
      await createQueuedWorkload(`active-${i}`, credentialId, {
        userId: 'u',
      });
      await walkToState(`active-${i}`, WorkloadState.Provisioning);
    }

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).not.toHaveBeenCalled();
    const d = await store.getWorkload('sched-queued');
    expect(d?.state).toBe(WorkloadState.Queued);
  });

  it('dispatches in FIFO order by started_at', async () => {
    const store = queries();
    const db = getDB();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createQueuedWorkload('fifo-late', credentialId);
    await createQueuedWorkload('fifo-early', credentialId);

    // Backdate fifo-early so it sorts first
    await db.query(`UPDATE workloads SET started_at = ? WHERE id = ?`, [
      Date.now() - 10_000,
      'fifo-early',
    ]);

    // Leave only 1 slot free
    for (let i = 0; i < MAX_ACTIVE_DEPLOY_PIPELINES - 1; i++) {
      await createQueuedWorkload(`filler-${i}`, credentialId, {
        userId: 'u',
      });
      await walkToState(`filler-${i}`, WorkloadState.Provisioning);
    }

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const early = await store.getWorkload('fifo-early');
    const late = await store.getWorkload('fifo-late');
    expect(early?.state).toBe(WorkloadState.Provisioning);
    expect(late?.state).toBe(WorkloadState.Queued);
  });

  it('counts non-Provisioning pipeline states (Downloading, etc.) against the cap', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createQueuedWorkload('sched-np-queued', credentialId);

    // Fill the cap with a round-robin of every non-Provisioning pipeline state
    const pipelineStates = [
      WorkloadState.Initializing,
      WorkloadState.Downloading,
      WorkloadState.Starting,
      WorkloadState.Syncing,
    ];
    for (let i = 0; i < MAX_ACTIVE_DEPLOY_PIPELINES; i++) {
      const state = pipelineStates[i % pipelineStates.length];
      await createQueuedWorkload(`active-np-${i}`, credentialId, {
        userId: 'u',
      });
      await walkToState(`active-np-${i}`, state);
    }

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).not.toHaveBeenCalled();
    const d = await store.getWorkload('sched-np-queued');
    expect(d?.state).toBe(WorkloadState.Queued);
  });

  // ---- Spend-controls gate ----

  async function seedLambdaCredential(): Promise<string> {
    return upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      await encryptCredential(TEST_LAMBDA_CRED),
      CloudType.GCP,
    );
  }

  async function seedRunningWithVM(
    id: string,
    credentialId: string,
    pricePerHour: number,
    session?: string,
    owner?: { userId: string; ownerUserId: string },
  ): Promise<void> {
    await createWorkload(getDB(), {
      id,
      userId: owner?.userId ?? 'test-user',
      ownerUserId: owner?.ownerUserId,
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
      session,
    });
    // In-flight VM (ended_at IS NULL) → contributes pricePerHour to the live
    // burn rate that the throttle compares against.
    await walkToState(id, WorkloadState.Provisioning);
    const attempt = await ledger().beginProvisioningAttempt(id, `vm-${id}`, {
      region: 'us-central1',
      credentialId,
      pricePerHour,
    });
    await ledger().completeProvisioningAttempt(id, attempt!, {
      ip: '1.2.3.4',
      cloudId: `vm-${id}`,
      createdAt: Date.now() - 60 * 1000,
    });
    await walkToState(id, WorkloadState.Running);
  }

  it('throttle: blocks queued dispatch when account-wide cap exceeded', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('hot-spender', credentialId, 30); // $15 in last 30m
    await getSpendControlsStore().setThrottle('account', 10);
    await createQueuedWorkload('blocked-by-throttle', credentialId);

    await runProvisioningSchedulerOnce();

    expect(resolveProvisioningConfig).toHaveBeenCalled();
    expect(startup.deploy).not.toHaveBeenCalled();
    const d = await store.getWorkload('blocked-by-throttle');
    expect(d?.state).toBe(WorkloadState.Queued);
    // Block reason written to workload_events as a Queued event.
    const events = await eventLog().getWorkloadEvents('blocked-by-throttle');
    const last = events[events.length - 1];
    expect(last.state).toBe(WorkloadState.Queued);
    expect(JSON.parse(last.metadata!).message).toContain('throttle');
  });

  it('throttle: dispatches when cap is set but spend is under it', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('mild', credentialId, 2); // $1 in last 30m
    await getSpendControlsStore().setThrottle('account', 10);
    await createQueuedWorkload('passes-throttle', credentialId);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalled();
    const d = await store.getWorkload('passes-throttle');
    expect(d?.state).toBe(WorkloadState.Provisioning);
  });

  it('throttle: blocks queued dispatch using the resolved config price', async () => {
    const selectedPrice = resolveWorkloadPrice(
      CloudType.AWS,
      't3.micro',
      'us-east-1',
      false,
    );
    expect(selectedPrice).toBeDefined();
    await getSpendControlsStore().setThrottle('account', selectedPrice! / 2);
    const encryptedCred = await encryptCredential(TEST_AWS_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_AWS_CRED),
      encryptedCred,
      CloudType.AWS,
    );

    await createWorkload(getDB(), {
      id: 'blocked-resolved-throttle',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      vmType: 't3.micro',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    const resolvedConfig: CloudConfig = {
      cloudProvider: CloudType.AWS,
      vmType: 't3.micro',
      region: 'us-east-1',
      spot: false,
      credentials: TEST_AWS_CRED,
    };
    vi.mocked(resolveProvisioningConfig).mockResolvedValueOnce({
      state: WorkloadState.Provisioning,
      config: resolvedConfig,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(resolveProvisioningConfig).toHaveBeenCalled();
    expect(startup.deploy).not.toHaveBeenCalled();
    const workload = await queries().getWorkload('blocked-resolved-throttle');
    expect(workload?.state).toBe(WorkloadState.Queued);
    const events = await eventLog().getWorkloadEvents(
      'blocked-resolved-throttle',
    );
    const last = events[events.length - 1];
    expect(last.state).toBe(WorkloadState.Queued);
    expect(JSON.parse(last.metadata!).message).toContain('throttle');
  });

  it('budget: blocks dispatch when day cap exceeded', async () => {
    useStableBudgetWindow();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('big', credentialId, 200);
    // Backdate the VM so 30 min of $200/hr ≈ $100 has accrued in the window.
    await getDB().query(`UPDATE vms SET created_at = ? WHERE workload_id = ?`, [
      Date.now() - 30 * 60 * 1000,
      'big',
    ]);
    await getSpendControlsStore().setBudget('day', 'account', 50);
    await createQueuedWorkload('blocked-by-budget', credentialId);

    await runProvisioningSchedulerOnce();

    expect(resolveProvisioningConfig).not.toHaveBeenCalled();
    expect(startup.deploy).not.toHaveBeenCalled();
    const events = await eventLog().getWorkloadEvents('blocked-by-budget');
    const last = events[events.length - 1];
    expect(JSON.parse(last.metadata!).message).toContain('daily budget');
  });

  it('budget: dispatches when day cap is set but spend is under it', async () => {
    useStableBudgetWindow();
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('under-budget', credentialId, 2);
    await getDB().query(`UPDATE vms SET created_at = ? WHERE workload_id = ?`, [
      Date.now() - 30 * 60 * 1000,
      'under-budget',
    ]);
    await getSpendControlsStore().setBudget('day', 'account', 50);
    await createQueuedWorkload('passes-budget', credentialId);

    await runProvisioningSchedulerOnce();

    expect(resolveProvisioningConfig).toHaveBeenCalled();
    expect(startup.deploy).toHaveBeenCalled();
    const d = await store.getWorkload('passes-budget');
    expect(d?.state).toBe(WorkloadState.Provisioning);
  });

  it('budget: pre-resolution check respects agent-session scope', async () => {
    useStableBudgetWindow();
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('session-big', credentialId, 200, 'sess-A');
    await getDB().query(`UPDATE vms SET created_at = ? WHERE workload_id = ?`, [
      Date.now() - 30 * 60 * 1000,
      'session-big',
    ]);
    await getSpendControlsStore().setBudget('day', 'agent-session', 50);
    await createQueuedWorkload('blocked-session-budget', credentialId, {
      session: 'sess-A',
    });
    await createQueuedWorkload('passes-session-budget', credentialId, {
      session: 'sess-B',
    });

    await runProvisioningSchedulerOnce();

    expect(resolveProvisioningConfig).toHaveBeenCalledTimes(1);
    expect(startup.deploy).toHaveBeenCalledTimes(1);
    expect((await store.getWorkload('blocked-session-budget'))?.state).toBe(
      WorkloadState.Queued,
    );
    expect((await store.getWorkload('passes-session-budget'))?.state).toBe(
      WorkloadState.Provisioning,
    );

    const events = await eventLog().getWorkloadEvents('blocked-session-budget');
    const last = events[events.length - 1];
    expect(JSON.parse(last.metadata!).message).toContain(
      "agent-session 'sess-A'",
    );
  });

  it('agent-session scope: a per-session cap blocks only its own session', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('hot-A', credentialId, 30, 'sess-A'); // $15 in sess-A
    await getSpendControlsStore().setThrottle('agent-session', 5);
    // New queued workload in sess-B should sail through.
    await createWorkload(getDB(), {
      id: 'b-cand',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
      session: 'sess-B',
    });
    await createQueuedWorkload('a-cand', credentialId, { session: 'sess-A' });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledOnce();
    const d = await queries().getWorkload('b-cand');
    expect(d?.state).toBe(WorkloadState.Provisioning);
  });

  it('block reason is not re-appended every tick while still blocked', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await seedRunningWithVM('hot', credentialId, 30);
    await getSpendControlsStore().setThrottle('account', 10);
    await createQueuedWorkload('persist-block', credentialId);

    await runProvisioningSchedulerOnce();
    await runProvisioningSchedulerOnce();
    await runProvisioningSchedulerOnce();

    const events = await eventLog().getWorkloadEvents('persist-block');
    const blocked = events.filter(
      (e) =>
        e.state === WorkloadState.Queued &&
        e.metadata &&
        JSON.parse(e.metadata).message?.includes('throttle'),
    );
    expect(blocked).toHaveLength(1);
  });

  it('throttle: pre-charges admitted workloads and alerts when only a throttle blocks', async () => {
    const credentialId = await seedLambdaCredential();
    const price = resolveWorkloadPrice(
      CloudType.GCP,
      'n2-standard-4',
      'us-central1',
      false,
    );
    await enableSlackNotifications();
    // Room for one candidate, not two: the first admission must count.
    await getSpendControlsStore().setThrottle('account', price! * 1.5);
    await createQueuedWorkload('burst-1', credentialId);
    await createQueuedWorkload('burst-2', credentialId);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain(
      'throttle',
    );
  });

  // ---- Spend-block notifications ----

  async function seedBudgetBlock(
    credentialId: string,
    owner?: { userId: string; ownerUserId: string },
  ): Promise<void> {
    await seedRunningWithVM('big-notify', credentialId, 200, undefined, owner);
    // 30 min of $200/hr ≈ $100 accrued, over the $50 day cap.
    await getDB().query(`UPDATE vms SET created_at = ? WHERE workload_id = ?`, [
      Date.now() - 30 * 60 * 1000,
      'big-notify',
    ]);
    await getSpendControlsStore().setBudget('day', 'account', 50);
  }

  it('notifies once when a budget starts blocking, then debounces within cooldown', async () => {
    useStableBudgetWindow();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await enableSlackNotifications();
    await seedBudgetBlock(credentialId);
    await createQueuedWorkload('notify-1', credentialId);

    await runProvisioningSchedulerOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('workloads waiting on spend cap');
    expect(body.text).toContain('daily budget');

    // Still blocked on the next tick → debounced, no second notification.
    await runProvisioningSchedulerOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries a failed alert next tick and reminds once the cooldown elapses', async () => {
    useStableBudgetWindow();
    const credentialId = await seedLambdaCredential();
    await enableSlackNotifications();
    await seedBudgetBlock(credentialId);
    await createQueuedWorkload('notify-retry', credentialId);
    fetchMock.mockRejectedValueOnce(new Error('slack down'));

    await runProvisioningSchedulerOnce();
    await runProvisioningSchedulerOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const cooldownMs = 6 * 60 * 60_000;
    vi.setSystemTime(budgetTestNow.getTime() + cooldownMs - 1);
    await runProvisioningSchedulerOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(budgetTestNow.getTime() + cooldownMs);
    await runProvisioningSchedulerOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends one notification per blocking cap in a tick', async () => {
    useStableBudgetWindow();
    const credentialId = await seedLambdaCredential();
    await enableSlackNotifications();
    await seedRunningWithVM('spender-A', credentialId, 200, 'sess-A');
    await seedRunningWithVM('spender-B', credentialId, 200, 'sess-B');
    await getDB().query(`UPDATE vms SET created_at = ?`, [
      Date.now() - 30 * 60 * 1000,
    ]);
    await getSpendControlsStore().setBudget('day', 'agent-session', 50);
    await createQueuedWorkload('waits-A1', credentialId, { session: 'sess-A' });
    await createQueuedWorkload('waits-A2', credentialId, { session: 'sess-A' });
    await createQueuedWorkload('waits-B', credentialId, { session: 'sess-B' });

    await runProvisioningSchedulerOnce();

    const texts = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body).text as string,
    );
    expect(texts).toHaveLength(2);
    expect(texts.join('\n')).toContain("agent-session 'sess-A'");
    expect(texts.join('\n')).toContain("agent-session 'sess-B'");
  });

  it('sends a single notification when many queued rows trip the same cap in one tick', async () => {
    useStableBudgetWindow();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await enableSlackNotifications();
    await seedBudgetBlock(credentialId);
    await createQueuedWorkload('notify-a', credentialId);
    await createQueuedWorkload('notify-b', credentialId);
    await createQueuedWorkload('notify-c', credentialId);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('names the affected accounts on a shared API, still in one notification', async () => {
    useStableBudgetWindow();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await enableSlackNotifications();
    await seedBudgetBlock(credentialId);
    await createQueuedWorkload('notify-mine', credentialId);
    await createQueuedWorkload('notify-theirs', credentialId, {
      userId: 'teammate',
      ownerUserId: '77',
    });

    await runProvisioningSchedulerOnce();

    // One cap, one alert — attribution is body content, never a second event.
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('waiting: ');
    expect(body.text).toContain('teammate');
    expect(body.text).toContain('test-user');
  });

  it('names one waiter when a different account consumed the budget', async () => {
    useStableBudgetWindow();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await enableSlackNotifications();
    await seedBudgetBlock(credentialId, {
      userId: 'teammate',
      ownerUserId: '77',
    });
    await createQueuedWorkload('notify-waiter', credentialId);

    await runProvisioningSchedulerOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('waiting: test-user');
    expect(body.text).toContain('spend by user: teammate ');
    expect(body.text).not.toContain('test-user $0.00');
  });

  /** A finished VM that ran 2 h from `from` at $10/h ($20), owned by `userId`. */
  async function seedEndedSpend(
    credentialId: string,
    userId: string,
    ownerUserId: string,
    from: string,
  ): Promise<void> {
    const id = `spend-${userId}`;
    vi.setSystemTime(new Date(from));
    await createWorkload(getDB(), {
      id,
      userId,
      ownerUserId,
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });
    await provisionTestVm(
      id,
      { cloudId: `vm-${id}`, ip: '1.2.3.4', createdAt: Date.parse(from) },
      { region: 'us-central1', credentialId, pricePerHour: 10 },
    );
    vi.setSystemTime(Date.parse(from) + 2 * 3_600_000);
    await releaseTestVms(id);
  }

  it.each([
    {
      month: 'a 31-day month, including spend on the 1st',
      now: '2026-03-15T12:00:00Z',
      spend: ['2026-03-01T10:00:00Z', '2026-03-10T10:00:00Z'],
    },
    {
      month: 'February, excluding spend on January 30',
      now: '2026-02-15T12:00:00Z',
      spend: [
        '2026-02-02T10:00:00Z',
        '2026-02-10T10:00:00Z',
        '2026-01-30T10:00:00Z',
      ],
    },
  ])(
    "attributes a month budget's spend over its calendar window in $month",
    async ({ now, spend }) => {
      vi.useFakeTimers();
      const credentialId = await seedLambdaCredential();
      await enableSlackNotifications();
      const owners = [
        ['early', '78'],
        ['teammate', '77'],
        ['previous', '79'],
      ];
      for (const [i, from] of spend.entries()) {
        await seedEndedSpend(credentialId, owners[i][0], owners[i][1], from);
      }
      vi.setSystemTime(new Date(now));
      await getSpendControlsStore().setBudget('month', 'account', 30);
      await createQueuedWorkload('waits', credentialId);

      await runProvisioningSchedulerOnce();

      expect(startup.deploy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      const text = JSON.parse(fetchMock.mock.calls[0][1].body).text as string;
      // The two in-window spenders add up to the total that tripped the cap.
      expect(text).toContain('spent $40.00');
      expect(text).toContain('early $20.00');
      expect(text).toContain('teammate $20.00');
      expect(text).not.toContain('previous');
    },
  );

  it("names only the session's spenders for an agent-session cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(budgetTestNow);
    const credentialId = await seedLambdaCredential();
    await enableSlackNotifications();
    await seedRunningWithVM('session-spend', credentialId, 200, 'sess-A', {
      userId: 'teammate',
      ownerUserId: '77',
    });
    await seedRunningWithVM('outside-spend', credentialId, 200, 'sess-B', {
      userId: 'outsider',
      ownerUserId: '78',
    });
    await getDB().query(`UPDATE vms SET created_at = ?`, [
      Date.now() - 30 * 60 * 1000,
    ]);
    await getSpendControlsStore().setBudget('day', 'agent-session', 50);
    await createQueuedWorkload('waits-A', credentialId, { session: 'sess-A' });

    await runProvisioningSchedulerOnce();

    const texts = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body).text as string,
    );
    const sessionA = texts.find((t) => t.includes("agent-session 'sess-A'"));
    expect(sessionA).toContain('spend by user: teammate ');
    expect(sessionA).not.toContain('outsider');
  });

  it('does not notify when no channels are configured', async () => {
    useStableBudgetWindow();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    // No enableSlackNotifications() — no channel is configured on this API.
    await seedBudgetBlock(credentialId);
    await createQueuedWorkload('notify-none', credentialId);

    await runProvisioningSchedulerOnce();

    // Block still recorded, just no send.
    const events = await eventLog().getWorkloadEvents('notify-none');
    const last = events[events.length - 1];
    expect(JSON.parse(last.metadata!).message).toContain('daily budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provisioning failure → retry cycle', () => {
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  it('deploy provisioning failure transitions to Retrying, then reconciliation re-queues', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'prov-fail-cycle',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    // Simulate what runStep does when provisionStep throws a provisioning failure:
    // deploy is called, it transitions Provisioning → Retrying
    vi.mocked(startup.deploy).mockImplementationOnce(async () => {
      await lifecycle().updateState('prov-fail-cycle', WorkloadState.Retrying, {
        metadata: {
          reason:
            'VM test-vm provisioning failed: Allocation failed. OverconstrainedAllocationRequest.',
        },
      });
    });

    // Step 1: Scheduler dispatches → deploy "fails" → state becomes Retrying
    await runProvisioningSchedulerOnce();

    const afterScheduler = await queries().getWorkload('prov-fail-cycle');
    expect(afterScheduler?.state).toBe(WorkloadState.Retrying);

    // Step 2: Backdate the Retrying event so retry launch is due.
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        Date.now() - RETRY_JITTER_CAP_MS - 1000,
        'prov-fail-cycle',
        WorkloadState.Retrying,
      ],
    );

    // Step 3: Retry reconciliation re-queues the workload
    await runWorkloadReconcileOnce();

    const afterRetry = await queries().getWorkload('prov-fail-cycle');
    expect(afterRetry?.state).toBe(WorkloadState.Queued);
  });

  it('deploy provisioning failure exhausts retries and marks Failed', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'prov-fail-exhaust',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    // Simulate deploy failing with provisioning error
    vi.mocked(startup.deploy).mockImplementation(async () => {
      await lifecycle().updateState(
        'prov-fail-exhaust',
        WorkloadState.Retrying,
        {
          metadata: { reason: 'VM provisioning failed: Allocation failed.' },
        },
      );
    });

    // Run scheduler to trigger the first failure
    await runProvisioningSchedulerOnce();

    // Simulate max retry attempts already recorded, all backdated
    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1000;
    for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
      await db.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
        ['prov-fail-exhaust', WorkloadState.Retrying, null, oldTs],
      );
    }
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'prov-fail-exhaust', WorkloadState.Retrying],
    );

    // Retry monitor sees max attempts exhausted → marks Failed
    await runWorkloadReconcileOnce();
    expect((await queries().getWorkload('prov-fail-exhaust'))?.state).toBe(
      WorkloadState.Failed,
    );
    await runWorkloadReconcileOnce();

    const d = await queries().getWorkload('prov-fail-exhaust');
    expect(d?.state).toBe(WorkloadState.Failed);
  });
});
