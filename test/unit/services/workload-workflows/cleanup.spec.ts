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
import {
  resetPersistence,
  getCredentialSecretStore,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
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
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

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
  requestWorkloadCleanup,
} from '../../../../src/api/services/monitor';
import { WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS } from '../../../../src/api/services/workload-reconciler';
import * as termination from '../../../../src/api/services/host-runtime/termination';
import * as workloadCleanup from '../../../../src/api/services/workload-cleanup';
import {
  encryptCredential,
  hashCredential,
} from '../../../../src/api/services/cloud-config';
import { TimeoutError, withTimeout } from '../../../../src/shared/utils';
import { TEST_LAMBDA_CRED } from '../../helpers/fixtures';
import {
  drainWorkloadWork,
  hasWorkloadWork,
} from '../../../../src/api/services/workload-work-registry';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { WorkloadQueryStore } from '../../../../src/api/services/repositories/workload-queries.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

describe('terminal cleanup reconciliation — credential health gate', () => {
  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  async function seedTerminalWithVM(
    id: string,
    credentialId: string,
  ): Promise<void> {
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
    await provisionTestVm(id, { ip: '1.2.3.4', cloudId: 'gcp-vm-id' });
    await walkToState(id, WorkloadState.Terminated);
  }

  async function seedCredential(): Promise<string> {
    return upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      await encryptCredential(TEST_LAMBDA_CRED),
      CloudType.GCP,
    );
  }

  it('skips cleanup when the workload credential is failing auth', async () => {
    const store = queries();
    const credentialId = await seedCredential();
    await seedTerminalWithVM('cleanup-bad-cred', credentialId);
    await getCredentialSecretStore().markCredentialAuthFailed(credentialId);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).not.toHaveBeenCalled();
    // VM is left in place — cleanup resumes once the credential is fixed.
    expect((await store.getVMs('cleanup-bad-cred')).length).toBe(1);
  });

  it('runs cleanup when the credential is healthy', async () => {
    const credentialId = await seedCredential();
    await seedTerminalWithVM('cleanup-good-cred', credentialId);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalled();
  });

  it('uses a historical VM credential when the workload credential is null', async () => {
    const credentialId = await seedCredential();
    // Historical rows can have no workload credential while retaining the
    // attempt credential on the VM, which cleanup authenticates with.
    await createWorkload(getDB(), {
      id: 'cleanup-historical-bad-cred',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      'cleanup-historical-bad-cred',
      { ip: '1.2.3.4', cloudId: 'gcp-vm-id' },
      { credentialId },
    );
    await walkToState('cleanup-historical-bad-cred', WorkloadState.Terminated);
    await getCredentialSecretStore().markCredentialAuthFailed(credentialId);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).not.toHaveBeenCalled();
  });

  it('completes cleanup for a workload that never provisioned anything', async () => {
    // A historical row with no attempt has no credential to resolve and none
    // is needed: provisioning writes its ledger before the first mutation.
    // Deferring on the missing credential would strand cleaned_at, and with it
    // resubmission, forever.
    await createWorkload(getDB(), {
      id: 'cleanup-never-provisioned',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await outcomes().requestTermination(
      'cleanup-never-provisioned',
      scope('test-user'),
      {
        metadata: { reason: 'terminated' },
      },
    );

    await runWorkloadReconcileOnce();

    const workload = await queries().getWorkload('cleanup-never-provisioned');
    expect(workload?.state).toBe(WorkloadState.Terminated);
    expect(workload?.cleanedAt).toEqual(expect.any(Number));
    const attemptRows = await getDB().query<{
      cleanup_attempts: number | null;
    }>('SELECT cleanup_attempts FROM workloads WHERE id = ?', [
      'cleanup-never-provisioned',
    ]);
    expect(attemptRows[0]?.cleanup_attempts).toBe(1);
    // No placement to reconstruct, so teardown is never dispatched.
    expect(termination.terminateStep).not.toHaveBeenCalled();
    await expect(
      outcomes().resubmitWorkload('cleanup-never-provisioned'),
    ).resolves.toBe(true);
  });

  it('resolves the credential once (no double getVMs) on the cleanup path', async () => {
    const credentialId = await seedCredential();
    await seedTerminalWithVM('cleanup-getvms-once', credentialId);
    const getVMsSpy = vi.spyOn(WorkloadQueryStore.prototype, 'getVMs');

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalled();
    // The gate resolves the credential; loadWorkloadConfigs reuses it during
    // credential loading instead of re-running the same getVMs resolution.
    expect(getVMsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('terminal cleanup reconciliation', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createTerminalWorkloadWithVM(
    id: string,
    state: WorkloadState = WorkloadState.Terminated,
    workloadType: WorkloadType = WorkloadType.Job,
  ): Promise<void> {
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
    await provisionTestVm(id, { ip: '10.0.0.1', cloudId: `vm-${id}` });
    await walkToState(id, state);
  }

  it('cleans up VMs for a terminal workload with leftover VMs', async () => {
    await createTerminalWorkloadWithVM('cleanup-success');

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledOnce();

    // State stays Terminated (no state change needed)
    const d = await queries().getWorkload('cleanup-success');
    expect(d?.state).toBe(WorkloadState.Terminated);
  });

  it('keeps timed-out terminal cleanup serialized until it completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'owned-terminal-cleanup';
    const store = queries();
    await createTerminalWorkloadWithVM(id);
    await outcomes().requestTermination(id, scope('test-user'));
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Terminated);

    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    vi.mocked(termination.terminateStep)
      .mockReset()
      .mockReturnValueOnce(cleanup)
      .mockResolvedValue(undefined);
    vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
    vi.mocked(withTimeout).mockImplementationOnce(() =>
      Promise.reject(new TimeoutError(`terminateStep for ${id}`, 1_000)),
    );

    try {
      await runWorkloadReconcileOnce();

      await vi.waitFor(() =>
        expect(termination.terminateStep).toHaveBeenCalledOnce(),
      );
      expect(hasWorkloadWork(id)).toBe(true);
      expect(await outcomes().resubmitWorkload(id)).toBe(false);

      vi.setSystemTime(Date.now() + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS + 1);
      const deferred = await runWorkloadReconcileOnce();

      expect(deferred.deferredCount).toBeGreaterThan(0);
      expect(termination.terminateStep).toHaveBeenCalledOnce();
      expect((await store.getWorkload(id))?.state).toBe(
        WorkloadState.Terminated,
      );

      resolveCleanup();
      await drainWorkloadWork(id);
      expect((await store.getWorkload(id))?.state).toBe(
        WorkloadState.Terminated,
      );
      vi.setSystemTime(Date.now() + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS + 1);
      await runWorkloadReconcileOnce();

      expect(termination.terminateStep).toHaveBeenCalledOnce();
      expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
    } finally {
      resolveCleanup();
      await drainWorkloadWork(id);
      vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
    }
  });

  it('retries terminal service cleanup through the Serve runtime boundary', async () => {
    await createTerminalWorkloadWithVM(
      'cleanup-serve',
      WorkloadState.Terminated,
      WorkloadType.Service,
    );

    await runWorkloadReconcileOnce();

    expect(serveRuntime.cleanup).toHaveBeenCalledWith({
      workload: expect.objectContaining({
        id: 'cleanup-serve',
        workloadType: WorkloadType.Service,
      }),
      placement: {
        cloudConfig: expect.objectContaining({
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          vmType: 'n2-standard-4',
        }),
      },
    });
    expect(termination.terminateStep).not.toHaveBeenCalled();
  });

  it('preserves Completed state — only cleans up VMs', async () => {
    await createTerminalWorkloadWithVM(
      'cleanup-completed',
      WorkloadState.Completed,
    );

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledOnce();

    const d = await queries().getWorkload('cleanup-completed');
    expect(d?.state).toBe(WorkloadState.Completed);
  });

  it('cleans up a completed workload without explicit cleanup intent', async () => {
    await createTerminalWorkloadWithVM(
      'cleanup-completed-no-intent',
      WorkloadState.Completed,
    );

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledOnce();
  });

  it('reuses an ended historical attempt credential for network-only cleanup', async () => {
    const id = 'cleanup-historical-network-only';
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
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { ip: '10.0.0.1', cloudId: `vm-${id}` },
      {
        region: 'us-central1',
        vmType: 'n2-standard-4',
        credentialId,
      },
    );
    await releaseTestVms(id, `vm-${id}`);
    await walkToState(id, WorkloadState.Completed);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledWith(
      expect.objectContaining({ cloudProvider: CloudType.GCP }),
      id,
    );
    expect((await queries().getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('cleans a resubmitted terminal lifecycle with no new VM attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'cleanup-new-lifecycle-without-attempt';
    const store = queries();
    await createTerminalWorkloadWithVM(id);
    await releaseTestVms(id, `vm-${id}`);
    expect(await outcomes().markCleanupComplete(id)).toBe(true);

    vi.setSystemTime(Date.now() + 60_000);
    expect(await outcomes().resubmitWorkload(id)).toBe(true);
    await walkToState(id, WorkloadState.Invalid);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledWith(
      expect.anything(),
      id,
    );
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('retries cleanup on the next interval after a transient failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'cleanup-retry-interval';
    await createTerminalWorkloadWithVM(id, WorkloadState.Completed);
    vi.mocked(termination.terminateStep).mockRejectedValueOnce(
      new Error('transient cleanup failure'),
    );

    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS);
    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledTimes(2);
  });

  it('retries on next tick when terminate throws', async () => {
    await createTerminalWorkloadWithVM('cleanup-throws');

    vi.mocked(termination.terminateStep).mockRejectedValueOnce(
      new Error('bucket not empty'),
    );

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledOnce();

    // State stays terminal, will be picked up again next tick
    const d = await queries().getWorkload('cleanup-throws');
    expect(d?.state).toBe(WorkloadState.Terminated);
  });

  it('blocks resubmission throughout admitted network-only cleanup', async () => {
    const id = 'cleanup-resubmitted';
    const store = queries();
    await createTerminalWorkloadWithVM(id);
    await releaseTestVms(id, `vm-${id}`);
    await outcomes().requestTermination(id, scope('test-user'));
    expect(await requestWorkloadCleanup(id)).toBe(true);
    vi.mocked(termination.terminateStep).mockImplementationOnce(
      async (_cloudConfig, workloadId) => {
        expect(await outcomes().resubmitWorkload(workloadId)).toBe(false);
        expect((await store.getWorkload(workloadId))?.cleanedAt).toBeNull();
      },
    );

    const status = await runWorkloadReconcileOnce();

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Terminated);
    expect(await outcomes().resubmitWorkload(id)).toBe(true);
    expect(status.staleCount).toBe(0);
    expect(termination.terminateStep).toHaveBeenCalledOnce();
  });

  it('defers an admitted cleanup while live attempt evidence remains', async () => {
    const id = 'cleanup-live-attempt-remains';
    const store = queries();
    await createTerminalWorkloadWithVM(id);
    await outcomes().requestTermination(id, scope('test-user'));
    vi.mocked(workloadCleanup.completeWorkloadCleanup).mockResolvedValueOnce(
      false,
    );

    const status = await runWorkloadReconcileOnce();

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Terminated);
    expect(status.deferredCount).toBe(1);
    expect(status.staleCount).toBe(0);
    expect(workloadCleanup.completeWorkloadCleanup).toHaveBeenCalledOnce();
  });

  it('skips when credentials are missing', async () => {
    // Same simulation as the retry-reconciliation missing-creds test —
    // see comment there.
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'cleanup-no-creds',
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
    await getDB().query(
      `UPDATE workloads SET credential_id = NULL WHERE id = ?`,
      ['cleanup-no-creds'],
    );
    await provisionTestVm('cleanup-no-creds', {
      ip: '10.0.0.1',
      cloudId: 'vm-no-creds',
    });
    await walkToState('cleanup-no-creds', WorkloadState.Terminated);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).not.toHaveBeenCalled();
  });

  it('processes all candidates independently — one failure does not block others', async () => {
    await createTerminalWorkloadWithVM('cleanup-iso-fails');
    await createTerminalWorkloadWithVM('cleanup-iso-succeeds');

    vi.mocked(termination.terminateStep).mockRejectedValueOnce(
      new Error('bucket not empty'),
    );

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledTimes(2);
  });

  it('picks up a terminal workload whose only rows are unresolved provisioning attempts', async () => {
    // A workload that never successfully provisioned a VM may still have
    // partial Azure resources (NIC + Public IP). Reconciler discovery must
    // return it so bounded terminal cleanup can try those cloud_ids.
    // Without this, the 100-public-IP-per-region quota gets eaten by leftovers
    // from failed provisioning attempts.
    const id = 'cleanup-failed-only';
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
    for (const cloudId of [`${id}-0`, `${id}-1`]) {
      await provisionTestVm(id, { cloudId }, { region: 'us-central1' });
    }
    await walkToState(id, WorkloadState.Errored);

    // Sanity: no live VMs (getVMs filters ip IS NULL).
    expect(await queries().getVMs(id)).toHaveLength(0);

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledOnce();
  });
});
