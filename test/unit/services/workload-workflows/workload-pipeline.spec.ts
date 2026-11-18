import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { randomBytes } from 'crypto';
import {
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
  DEPLOY_STEPS,
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  MAX_ACTIVE_DEPLOY_PIPELINES,
  RETRY_JITTER_CAP_MS,
  STUCK_ACTIVE_TIMEOUT_MS,
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
  runWorkloadReconcileOnce,
  resetJobCompletionMonitorStateForTests,
} from '../../../../src/api/services/monitor';
import {
  WORKLOAD_RECONCILE_RETRY_INTERVAL_MS,
  WorkloadReconciler,
} from '../../../../src/api/services/workload-reconciler';
import * as startup from '../../../../src/api/services/workload-workflows/vm-host-startup';
import * as completion from '../../../../src/api/services/workload-workflows/completion';
import * as termination from '../../../../src/api/services/host-runtime/termination';
import {
  encryptCredential,
  hashCredential,
} from '../../../../src/api/services/cloud-config';
import {
  checkNetworkConnectivity,
  tcpPing,
  TimeoutError,
  withTimeout,
} from '../../../../src/shared/utils';
import { TEST_LAMBDA_CRED } from '../../helpers/fixtures';
import { ResourceStateIndeterminateError } from '../../../../src/shared/errors';
import { runStep } from '../../../../src/api/services/task';
import {
  drainWorkloadWork,
  hasWorkloadWork,
} from '../../../../src/api/services/workload-work-registry';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

const MAX_RECONCILE_IN_FLIGHT = 40;

/** withTimeout's real race, so a test can drive the deadline with fake timers. */
const racingTimeout: typeof withTimeout = (promise, timeoutMs, operationName) =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new TimeoutError(operationName, timeoutMs)),
        timeoutMs,
      );
    }),
  ]);

describe('active-pipeline reconciliation', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
    vi.mocked(startup.deploy).mockResolvedValue(undefined);
  });

  async function createWorkloadInState(id: string, state: WorkloadState) {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await walkToState(id, WorkloadState.Provisioning);
    if (state !== WorkloadState.Provisioning) {
      await provisionTestVm(
        id,
        { cloudId: `${id}-vm`, ip: '203.0.113.20' },
        {
          region: 'us-central1',
          vmType: 'n2-standard-4',
          credentialId,
        },
      );
      await walkToState(id, state);
    }
  }

  it('returns a timed-out empty Provisioning admission to Queued', async () => {
    const store = queries();
    const db = getDB();

    await createWorkloadInState('stuck-prov', WorkloadState.Provisioning);

    // Backdate the event past the stuck timeout
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        Date.now() - STUCK_ACTIVE_TIMEOUT_MS - 1000,
        'stuck-prov',
        WorkloadState.Provisioning,
      ],
    );

    await runWorkloadReconcileOnce();

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await store.getWorkload('stuck-prov'))?.state).toBe(
      WorkloadState.Queued,
    );
    const events = await eventLog().getWorkloadEvents('stuck-prov');
    expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
      reason: 'empty-provisioning-admission-released',
    });
  });

  it('replays every timed-out deploy step from its persisted state', async () => {
    const store = queries();
    const db = getDB();

    for (const state of DEPLOY_STEPS) {
      const id = `stuck-${state}`;
      await createWorkloadInState(id, state);
      if (state === WorkloadState.Provisioning) {
        await provisionTestVm(id, {
          cloudId: `${id}-vm`,
          ip: '203.0.113.21',
        });
      }
      await db.query(
        `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
        [Date.now() - STUCK_ACTIVE_TIMEOUT_MS - 1000, id, state],
      );
    }

    await runWorkloadReconcileOnce();

    for (const state of DEPLOY_STEPS) {
      const d = await store.getWorkload(`stuck-${state}`);
      expect(d?.state).toBe(state);
      expect(startup.deploy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ cloudProvider: CloudType.GCP }),
        expect.objectContaining({ id: `stuck-${state}` }),
        expect.any(String),
        { resumeFrom: state, replayActiveStep: true },
      );
    }
  });

  it('moves a later step with no live VM to Retrying', async () => {
    const store = queries();
    const db = getDB();
    await createWorkloadInState('stuck-no-vm', WorkloadState.Downloading);
    await releaseTestVms('stuck-no-vm');
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        Date.now() - STUCK_ACTIVE_TIMEOUT_MS - 1000,
        'stuck-no-vm',
        WorkloadState.Downloading,
      ],
    );

    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('stuck-no-vm'))?.state).toBe(
      WorkloadState.Retrying,
    );
  });

  it('skips workloads not stuck long enough', async () => {
    const store = queries();

    await createWorkloadInState('fresh-init', WorkloadState.Initializing);

    // Event is fresh — no backdating

    await runWorkloadReconcileOnce();

    const d = await store.getWorkload('fresh-init');
    expect(d?.state).toBe(WorkloadState.Initializing);
  });

  it('does nothing when no workloads are stuck', async () => {
    const store = queries();

    // Create a Running workload — should be ignored
    await createWorkloadInState('running-ok', WorkloadState.Running);

    await runWorkloadReconcileOnce();

    const d = await store.getWorkload('running-ok');
    expect(d?.state).toBe(WorkloadState.Running);
  });
});

// ============================================================================
// Startup scheduling of active recovery
// ============================================================================

describe('startup active-pipeline reconciliation', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    resetJobCompletionMonitorStateForTests();
    vi.clearAllMocks();
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
    vi.mocked(startup.deploy).mockResolvedValue(undefined);
    serveRuntime.deploy.mockResolvedValue(undefined);
  });

  async function createWorkloadInState(
    id: string,
    state: WorkloadState,
    workloadType = WorkloadType.Job,
  ) {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await walkToState(id, WorkloadState.Provisioning);
    if (state !== WorkloadState.Provisioning) {
      await provisionTestVm(
        id,
        {
          cloudId: `${id}-vm`,
          ip: '203.0.113.10',
        },
        {
          region: 'us-central1',
          vmType: 'n2-standard-4',
          credentialId,
        },
      );
      await walkToState(id, state);
    }
  }

  it('requeues a recently orphaned empty admission without waiting for the stuck timeout', async () => {
    const store = queries();
    // Workload entered Provisioning just now; periodic recovery would wait
    // for the normal timeout.
    await createWorkloadInState('orphan-1', WorkloadState.Provisioning);

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await store.getWorkload('orphan-1'))?.state).toBe(
      WorkloadState.Queued,
    );
  });

  it('resumes an orphaned service through the shared Serve runtime', async () => {
    const id = 'orphan-service-runtime';
    await createWorkloadInState(
      id,
      WorkloadState.Downloading,
      WorkloadType.Service,
    );

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(serveRuntime.deploy).toHaveBeenCalledWith({
      workload: expect.objectContaining({
        id,
        workloadType: WorkloadType.Service,
      }),
      placement: {
        cloudConfig: expect.objectContaining({
          cloudProvider: CloudType.GCP,
        }),
        selectedCredentialId: expect.any(String),
      },
      resumeFrom: WorkloadState.Downloading,
      replayActiveStep: true,
    });
    expect(startup.deploy).not.toHaveBeenCalled();
  });

  it('resumes a durable Provisioning intent before a VM placeholder exists', async () => {
    const id = 'orphan-durable-intent';
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: WorkloadType.Job,
      image: 'alpine:latest',
      vmType: ['unavailable-first-choice', 'n2-standard-8'],
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await lifecycle().updateState(id, WorkloadState.Provisioning, {
      metadata: {
        provisioningIntent: {
          cloudProvider: CloudType.GCP,
          availabilityZone: 'b',
          region: 'us-west1',
          vmType: 'n2-standard-8',
          credentialId,
        },
      },
    });

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(await queries().getVMs(id)).toHaveLength(0);
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Provisioning,
    );
    expect(startup.deploy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudProvider: CloudType.GCP,
        availabilityZone: 'b',
        region: 'us-west1',
        vmType: 'n2-standard-8',
      }),
      expect.objectContaining({ id }),
      credentialId,
      {
        resumeFrom: WorkloadState.Provisioning,
        replayActiveStep: true,
      },
    );
  });

  it('routes contradictory durable Provisioning facts to Retrying', async () => {
    const id = 'orphan-contradictory-intent';
    const store = queries();
    await createWorkloadInState(id, WorkloadState.Provisioning);
    const workload = await store.getWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Provisioning, {
      metadata: {
        provisioningIntent: {
          cloudProvider: CloudType.AWS,
          availabilityZone: null,
          region: 'us-east-1',
          vmType: 'm7i.large',
          credentialId: workload!.credentialId,
        },
      },
    });

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Retrying);
    const events = await eventLog().getWorkloadEvents(id);
    expect(JSON.parse(events.at(-1)!.metadata!).reason).toContain(
      'does not match durable provisioning intent AWS',
    );
  });

  it('uses VM-ledger placement once a provisioning attempt exists', async () => {
    const id = 'orphan-ledger-precedence';
    const store = queries();
    await createWorkloadInState(id, WorkloadState.Provisioning);
    const workload = await store.getWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Provisioning, {
      metadata: {
        provisioningIntent: {
          cloudProvider: CloudType.AWS,
          availabilityZone: 'us-east-1a',
          region: 'us-east-1',
          vmType: 'm7i.large',
          credentialId: workload!.credentialId,
        },
      },
    });
    const attempt = await ledger().beginProvisioningAttempt(id, `${id}-0`, {
      region: 'us-central1',
      availabilityZone: 'us-central1-b',
      vmType: 'n2-standard-4',
      credentialId: workload!.credentialId ?? undefined,
    });
    expect(attempt).not.toBeNull();

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect((await store.getWorkload(id))?.state).toBe(
      WorkloadState.Provisioning,
    );
    expect(startup.deploy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudProvider: CloudType.GCP,
        availabilityZone: 'us-central1-b',
        region: 'us-central1',
        vmType: 'n2-standard-4',
      }),
      expect.objectContaining({ id }),
      workload!.credentialId,
      {
        resumeFrom: WorkloadState.Provisioning,
        existingAttempt: attempt,
        replayActiveStep: true,
      },
    );
  });

  it('passes the exact matching unresolved attempt into provisioning replay', async () => {
    const store = queries();
    await createWorkloadInState(
      'orphan-existing-attempt',
      WorkloadState.Provisioning,
    );
    const workload = await store.getWorkload('orphan-existing-attempt');
    const attempt = await ledger().beginProvisioningAttempt(
      'orphan-existing-attempt',
      'orphan-existing-attempt-0',
      {
        region: 'us-central1',
        vmType: 'n2-standard-4',
        credentialId: workload!.credentialId ?? undefined,
      },
    );
    if (!attempt) throw new Error('the store refused the attempt');
    expect(attempt).not.toBeNull();

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cloudProvider: CloudType.GCP }),
      expect.objectContaining({ id: 'orphan-existing-attempt' }),
      workload!.credentialId,
      {
        resumeFrom: WorkloadState.Provisioning,
        existingAttempt: attempt!,
        replayActiveStep: true,
      },
    );
  });

  it('defers inconclusive attempt adoption without retiring or cleaning it up', async () => {
    const store = queries();
    await createWorkloadInState(
      'orphan-inconclusive-attempt',
      WorkloadState.Provisioning,
    );
    const workload = await store.getWorkload('orphan-inconclusive-attempt');
    const attempt = await ledger().beginProvisioningAttempt(
      'orphan-inconclusive-attempt',
      'orphan-inconclusive-attempt-0',
      {
        region: 'us-central1',
        vmType: 'n2-standard-4',
        credentialId: workload!.credentialId ?? undefined,
      },
    );
    if (!attempt) throw new Error('the store refused the attempt');
    expect(attempt).not.toBeNull();
    vi.mocked(startup.deploy).mockRejectedValueOnce(
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
      const status = await runWorkloadReconcileOnce({
        activeRecoveryNow: true,
      });

      expect(status.deferredCount).toBe(0);
      await vi.waitFor(() =>
        expect(enqueue).toHaveBeenCalledWith('orphan-inconclusive-attempt'),
      );
      expect(
        (await store.getWorkload('orphan-inconclusive-attempt'))?.state,
      ).toBe(WorkloadState.Provisioning);
      const unresolved = await ledger().getUnresolvedProvisioningAttempts(
        'orphan-inconclusive-attempt',
      );
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({
        cloud_id: attempt.cloudId,
        ended_at: null,
      });
      expect(termination.teardownVMs).not.toHaveBeenCalled();
    } finally {
      enqueue.mockRestore();
    }
  });

  it('replays provisioning postamble when the completed VM row is already durable', async () => {
    const store = queries();
    await createWorkloadInState(
      'orphan-completed-provisioning',
      WorkloadState.Provisioning,
    );
    const workload = await store.getWorkload('orphan-completed-provisioning');
    await provisionTestVm(
      'orphan-completed-provisioning',
      {
        cloudId: 'gcp-instance-1',
        ip: '203.0.113.11',
      },
      {
        region: 'us-central1',
        vmType: 'n2-standard-4',
        credentialId: workload!.credentialId ?? undefined,
      },
    );

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cloudProvider: CloudType.GCP }),
      expect.objectContaining({ id: 'orphan-completed-provisioning' }),
      workload!.credentialId,
      {
        resumeFrom: WorkloadState.Provisioning,
        replayActiveStep: true,
      },
    );
  });

  it('cleans up through Retrying instead of adopting a mismatched attempt placement', async () => {
    const store = queries();
    await createWorkloadInState(
      'orphan-mismatched-attempt',
      WorkloadState.Provisioning,
    );
    const workload = await store.getWorkload('orphan-mismatched-attempt');
    await ledger().beginProvisioningAttempt(
      'orphan-mismatched-attempt',
      'orphan-mismatched-attempt-0',
      {
        region: 'us-west1',
        vmType: 'n2-standard-4',
        credentialId: workload!.credentialId ?? undefined,
      },
    );

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await store.getWorkload('orphan-mismatched-attempt'))?.state).toBe(
      WorkloadState.Retrying,
    );
    const events = await eventLog().getWorkloadEvents(
      'orphan-mismatched-attempt',
    );
    expect(JSON.parse(events.at(-1)!.metadata!).reason).toContain(
      'region us-west1 does not match us-central1',
    );
  });

  it('falls back to Retrying when startup resume cannot recover the step', async () => {
    const store = queries();
    await createWorkloadInState(
      'orphan-resume-failed',
      WorkloadState.Downloading,
    );
    vi.mocked(startup.deploy).mockRejectedValueOnce(
      new Error('workload host disappeared'),
    );
    // A failed launch wakes its first cleanup at once; Retrying ignores it.
    const cleanup = vi.spyOn(WorkloadReconciler.prototype, 'enqueueCleanupNow');
    // So does an immediate retry; this one keeps its backoff.
    const retry = vi.spyOn(
      WorkloadReconciler.prototype,
      'enqueueImmediateRetryNow',
    );

    try {
      await runWorkloadReconcileOnce({ activeRecoveryNow: true });

      await vi.waitFor(async () =>
        expect((await store.getWorkload('orphan-resume-failed'))?.state).toBe(
          WorkloadState.Retrying,
        ),
      );
      await vi.waitFor(() =>
        expect(cleanup).toHaveBeenCalledWith('orphan-resume-failed'),
      );
      await vi.waitFor(() =>
        expect(retry).toHaveBeenCalledWith('orphan-resume-failed'),
      );
      expect(await retry.mock.results[0]!.value).toBe(false);
    } finally {
      cleanup.mockRestore();
      retry.mockRestore();
    }
    const events = await eventLog().getWorkloadEvents('orphan-resume-failed');
    expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
      reason: 'could not replay active downloading step',
    });
  });

  it('defers remote startup resume while the API network is down', async () => {
    const store = queries();
    await createWorkloadInState('orphan-offline', WorkloadState.Downloading);
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(false);

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await store.getWorkload('orphan-offline'))?.state).toBe(
      WorkloadState.Downloading,
    );
  });

  it('falls back to Retrying when a later deploy step has no live VM', async () => {
    const store = queries();
    await createWorkloadInState('orphan-no-vm', WorkloadState.Initializing);
    await releaseTestVms('orphan-no-vm');

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await store.getWorkload('orphan-no-vm'))?.state).toBe(
      WorkloadState.Retrying,
    );
  });

  it('moves every later step with multiple live VMs to Retrying instead of guessing', async () => {
    const store = queries();
    const laterSteps = DEPLOY_STEPS.filter(
      (state) => state !== WorkloadState.Provisioning,
    );

    for (const state of laterSteps) {
      const id = `orphan-ambiguous-${state}`;
      await createWorkloadInState(id, WorkloadState.Provisioning);
      const workload = await store.getWorkload(id);
      for (const [vm, ip] of [
        ['vm', '203.0.113.10'],
        ['second-vm', '203.0.113.11'],
      ]) {
        await provisionTestVm(
          id,
          { cloudId: `${id}-${vm}`, ip },
          {
            region: 'us-central1',
            vmType: 'n2-standard-4',
            credentialId: workload!.credentialId ?? undefined,
          },
        );
      }
      await walkToState(id, state);
    }

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).not.toHaveBeenCalled();
    for (const state of laterSteps) {
      const id = `orphan-ambiguous-${state}`;
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Retrying);
      const events = await eventLog().getWorkloadEvents(id);
      expect(JSON.parse(events.at(-1)!.metadata!).reason).toBe(
        `cannot reconcile ${state}: ambiguous live VM count 2`,
      );
    }
  });

  it('resumes every active-state workload from its persisted step', async () => {
    for (const state of DEPLOY_STEPS) {
      const id = `orphan-${state}`;
      await createWorkloadInState(id, state);
      if (state === WorkloadState.Provisioning) {
        await provisionTestVm(id, {
          cloudId: `${id}-vm`,
          ip: '203.0.113.22',
        });
      }
    }

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    for (const state of DEPLOY_STEPS) {
      expect(startup.deploy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ cloudProvider: CloudType.GCP }),
        expect.objectContaining({ id: `orphan-${state}` }),
        expect.any(String),
        { resumeFrom: state, replayActiveStep: true },
      );
    }
  });

  it('drains more than one page of immediately due active rows', async () => {
    const count = MAX_RECONCILE_IN_FLIGHT + 7;

    for (let i = 0; i < count; i++) {
      const state = DEPLOY_STEPS[i % DEPLOY_STEPS.length];
      const id = `orphan-page-${i}`;
      await createWorkloadInState(id, state);
      if (state === WorkloadState.Provisioning) {
        await provisionTestVm(id, {
          cloudId: `${id}-vm`,
          ip: '203.0.113.23',
        });
      }
    }

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect(startup.deploy).toHaveBeenCalledTimes(count);
  });

  it('hands off all admitted active pipelines without waiting for workload completion', async () => {
    let release!: () => void;
    const workloadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(startup.deploy).mockImplementation(() => workloadGate);
    vi.mocked(tcpPing).mockResolvedValue(true);

    for (let i = 0; i < MAX_ACTIVE_DEPLOY_PIPELINES; i++) {
      await createWorkloadInState(
        `orphan-blocked-${i}`,
        WorkloadState.Downloading,
      );
    }
    await createWorkloadInState('poll-while-recovering', WorkloadState.Running);

    try {
      const status = await runWorkloadReconcileOnce({
        activeRecoveryNow: true,
      });

      expect(startup.deploy).toHaveBeenCalledTimes(MAX_ACTIVE_DEPLOY_PIPELINES);
      expect(completion.checkJobCompletion).toHaveBeenCalledWith(
        expect.anything(),
        'poll-while-recovering',
        'test-ssh-key',
        expect.anything(),
      );
      expect(status.processedCount).toBe(MAX_ACTIVE_DEPLOY_PIPELINES + 1);

      // Rediscovery while every workload promise is still blocked must not
      // start a duplicate coroutine for any workload ID.
      await runWorkloadReconcileOnce({ activeRecoveryNow: true });
      expect(startup.deploy).toHaveBeenCalledTimes(MAX_ACTIVE_DEPLOY_PIPELINES);
    } finally {
      release();
      await Promise.resolve();
    }
  });

  it('keeps pipeline ownership after a step timeout until the raw operation settles', async () => {
    vi.useFakeTimers();
    const id = 'timed-out-owned-pipeline';
    const store = queries();
    await createWorkloadInState(id, WorkloadState.Provisioning);
    const workload = await store.getWorkload(id);
    await provisionTestVm(
      id,
      { cloudId: 'late-provider-id', ip: '203.0.113.24' },
      {
        region: 'us-central1',
        vmType: 'n2-standard-4',
        credentialId: workload!.credentialId ?? undefined,
      },
    );

    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const stepFn = vi.fn(() => operation);
    vi.mocked(startup.deploy).mockImplementation(() =>
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: stepFn,
        timeoutMs: 1_000,
        onErrorState: WorkloadState.Retrying,
      }),
    );
    vi.mocked(withTimeout).mockImplementation(racingTimeout);

    try {
      await runWorkloadReconcileOnce({ activeRecoveryNow: true });
      await vi.waitFor(() => expect(stepFn).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(1_001);

      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Retrying);
      const events = await eventLog().getWorkloadEvents(id);
      expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
        error: {
          message: expect.stringContaining('timed out'),
        },
      });
      expect(hasWorkloadWork(id)).toBe(true);

      await vi.advanceTimersByTimeAsync(RETRY_JITTER_CAP_MS + 1);
      const deferred = await runWorkloadReconcileOnce();

      expect(deferred.deferredCount).toBeGreaterThan(0);
      expect(termination.teardownVMs).not.toHaveBeenCalled();
      expect(startup.deploy).toHaveBeenCalledOnce();

      resolveOperation();
      await drainWorkloadWork(id);
      expect(hasWorkloadWork(id)).toBe(false);

      await vi.advanceTimersByTimeAsync(
        WORKLOAD_RECONCILE_RETRY_INTERVAL_MS + 1,
      );
      await runWorkloadReconcileOnce();

      expect(termination.teardownVMs).toHaveBeenCalledWith(
        expect.anything(),
        id,
      );
    } finally {
      resolveOperation();
      await drainWorkloadWork(id);
      vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
      vi.useRealTimers();
    }
  });

  it('does not touch Running or terminal workloads', async () => {
    const store = queries();

    await createWorkloadInState('running-ok', WorkloadState.Running);
    await createWorkloadInState('completed-ok', WorkloadState.Completed);

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect((await store.getWorkload('running-ok'))?.state).toBe(
      WorkloadState.Running,
    );
    expect((await store.getWorkload('completed-ok'))?.state).toBe(
      WorkloadState.Completed,
    );
  });
});
