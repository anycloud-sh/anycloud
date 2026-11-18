import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterEach,
  vi,
  onTestFinished,
  type Mock,
} from 'vitest';
import { randomBytes } from 'crypto';
import { SSHManager } from '../../../../src/api/services/gateways/ssh';
import {
  resetPersistence,
  getCredentialSecretStore,
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db';
import {
  CloudFailureDiagnosis,
  CloudType,
} from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
  PREEMPTIBLE_STATES,
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  FAILED_DEPLOY_MAX_ATTEMPTS,
  PINNED_PROVISIONING_REJECTION_MAX_ATTEMPTS,
  RETRY_JITTER_CAP_MS,
  UNUSABLE_GPU_MAX_RETRIES,
} from '../../../../src/api/config';
import {
  UNUSABLE_GPU_DIAGNOSIS,
  UNUSABLE_GPU_EXHAUSTED,
} from '../../../../src/api/services/workload-workflows/missing-gpu.js';
import { FailureDisposition } from '../../../../src/api/services/provisioning-failure.js';
import { VM_RELEASE_CANDIDATE } from '../../../../src/api/services/gateways/cloud.js';
import { JOB_UNREACHABLE_RECOVERY_MS } from '../../../../src/api/services/workload-workflows/retry-recovery.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

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
import { retryWindow } from '../../../../src/api/services/retry-backoff';
import { WORKLOAD_RECONCILE_RETRY_INTERVAL_MS } from '../../../../src/api/services/workload-reconciler';
import * as startup from '../../../../src/api/services/workload-workflows/vm-host-startup';
import * as termination from '../../../../src/api/services/host-runtime/termination';
import {
  encryptCredential,
  hashCredential,
  createComputeProvider,
} from '../../../../src/api/services/cloud-config';
import {
  checkNetworkConnectivity,
  tcpPing,
  TimeoutError,
  withTimeout,
} from '../../../../src/shared/utils';
import {
  TEST_GCP_CRED,
  TEST_LAMBDA_CRED,
  makeMockCloudCompute,
} from '../../helpers/fixtures';
import {
  drainWorkloadWork,
  hasWorkloadWork,
} from '../../../../src/api/services/workload-work-registry';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

describe('retry reconciliation', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    vi.mocked(checkNetworkConnectivity).mockReset();
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
    vi.mocked(tcpPing).mockReset();
    vi.mocked(tcpPing).mockResolvedValue(false);
    vi.mocked(createComputeProvider).mockReset();
    vi.mocked(createComputeProvider).mockReturnValue(makeMockCloudCompute());
    resetJobCompletionMonitorStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not overlap a timed-out retry teardown with its next attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'owned-retry-teardown';
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
      credentialId,
    });
    await provisionTestVm(id, {
      ip: '1.2.3.4',
      cloudId: 'provider-vm-id',
    });
    await walkToState(id, WorkloadState.Retrying);

    let resolveTeardown!: () => void;
    const teardown = new Promise<void>((resolve) => {
      resolveTeardown = resolve;
    });
    vi.mocked(termination.teardownVMs).mockReturnValueOnce(teardown);
    vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
    vi.mocked(withTimeout).mockImplementationOnce(() =>
      Promise.reject(new TimeoutError(`workload teardown for ${id}`, 1_000)),
    );

    try {
      await runWorkloadReconcileOnce();

      expect(termination.teardownVMs).toHaveBeenCalledOnce();
      expect(hasWorkloadWork(id)).toBe(true);

      vi.setSystemTime(Date.now() + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS + 1);
      const deferred = await runWorkloadReconcileOnce();

      expect(deferred.deferredCount).toBeGreaterThan(0);
      expect(termination.teardownVMs).toHaveBeenCalledOnce();

      resolveTeardown();
      await drainWorkloadWork(id);
      vi.setSystemTime(Date.now() + WORKLOAD_RECONCILE_RETRY_INTERVAL_MS + 1);
      await runWorkloadReconcileOnce();

      expect(termination.teardownVMs).toHaveBeenCalledTimes(2);
    } finally {
      resolveTeardown();
      await drainWorkloadWork(id);
      vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
      vi.useRealTimers();
    }
  });

  it('skips a workload whose backoff window has not yet elapsed', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-too-soon',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    // Retrying event just happened — well within the backoff window
    await walkToState('retry-too-soon', WorkloadState.Retrying);

    await runWorkloadReconcileOnce();

    // Should not have been re-queued yet
    const workload = await queries().getWorkload('retry-too-soon');
    expect(workload?.state).toBe(WorkloadState.Retrying);
    // No VM seeded for this workload — terminateStep is correctly skipped when
    // there are no VMs in DB. When a VM exists, terminateStep must run immediately
    // regardless of the backoff window (see test below).
    expect(termination.terminateStep).not.toHaveBeenCalled();
  });

  it('calls teardownVMs immediately for a Retrying workload with live VMs, even before backoff elapses', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'cleanup-before-backoff',
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

    // Seed a live VM — this is the zombie-VM regression: cleanup must happen
    // during immediate retry preparation, before the launch backoff expires.
    await provisionTestVm('cleanup-before-backoff', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });

    // Retrying event just now — backoff has NOT elapsed
    await walkToState('cleanup-before-backoff', WorkloadState.Retrying);

    await runWorkloadReconcileOnce();

    // teardownVMs must be called immediately to prevent zombie VMs in GCP
    expect(termination.teardownVMs).toHaveBeenCalledOnce();

    // Workload stays Retrying — backoff not elapsed, so not re-queued yet
    const d = await queries().getWorkload('cleanup-before-backoff');
    expect(d?.state).toBe(WorkloadState.Retrying);
  });

  it('pauses retry (no teardown re-storm) when the credential is failing auth', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-bad-cred',
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
    // Live VM that would otherwise be torn down before retry.
    await provisionTestVm('retry-bad-cred', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });
    await walkToState('retry-bad-cred', WorkloadState.Retrying);
    // The credential is invalid (e.g. AADSTS7000215) and marked auth-failed.
    await getCredentialSecretStore().markCredentialAuthFailed(credentialId);

    await runWorkloadReconcileOnce();

    // Paused: no teardown against the bad credential (no AAD re-storm), the VM is
    // left in place, and it stays Retrying until a valid secret is re-saved.
    expect(termination.teardownVMs).not.toHaveBeenCalled();
    expect((await queries().getVMs('retry-bad-cred')).length).toBe(1);
    expect((await queries().getWorkload('retry-bad-cred'))?.state).toBe(
      WorkloadState.Retrying,
    );
  });

  it('keeps VMs alive when failedAtState is a post-provisioning step (downloading/syncing/starting)', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'reuse-vms-download',
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

    // Seed a live VM
    await provisionTestVm('reuse-vms-download', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });

    // Simulate: failed at Downloading → Retrying
    await walkToState('reuse-vms-download', WorkloadState.Downloading);
    await walkToState('reuse-vms-download', WorkloadState.Retrying);

    // Backdate so backoff window has elapsed
    const retryTs = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    const downloadTs = retryTs - 1_000;
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [retryTs, 'reuse-vms-download', WorkloadState.Retrying],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [downloadTs, 'reuse-vms-download', WorkloadState.Downloading],
    );

    await runWorkloadReconcileOnce();

    // teardownVMs must NOT be called — the post-provisioning reuse branch keeps
    // the VM so the retry resumes on it. (Asserting `terminateStep` here was
    // vacuous: retry never calls it — that's the cleanup arm — so the negative
    // always held and guarded nothing.) The mirror is the provisioning-step test
    // below, which asserts teardownVMs IS called.
    expect(termination.teardownVMs).not.toHaveBeenCalled();
    // And the VM is still present for the resumed retry to reuse.
    expect(await queries().getVMs('reuse-vms-download')).toHaveLength(1);

    // Workload should be re-queued
    const d = await queries().getWorkload('reuse-vms-download');
    expect(d?.state).toBe(WorkloadState.Queued);
  });

  it('tears down an unresolved attempt placeholder before retry launch', async () => {
    const db = getDB();
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const id = 'teardown-unresolved-attempt';

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
    // The live VM would ordinarily be reused after a Downloading failure, but
    // the no-IP row may own partial provider resources from another attempt.
    await provisionTestVm(id, {
      ip: '1.2.3.4',
      cloudId: 'gcp-reusable-vm',
    });
    await provisionTestVm(
      id,
      { cloudId: 'gcp-unresolved-attempt' },
      { region: 'us-central1', vmType: 'n2-standard-4', credentialId },
    );

    await walkToState(id, WorkloadState.Downloading);
    await walkToState(id, WorkloadState.Retrying);
    const retryTs = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    await db.query(
      `UPDATE workload_events SET created_at = ?
       WHERE workload_id = ? AND state = ?`,
      [retryTs, id, WorkloadState.Retrying],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ?
       WHERE workload_id = ? AND state = ?`,
      [retryTs - 1_000, id, WorkloadState.Downloading],
    );

    await runWorkloadReconcileOnce();

    expect(termination.teardownVMs).toHaveBeenCalledOnce();
    expect((await queries().getWorkload(id))?.state).toBe(WorkloadState.Queued);
  });

  it('uses a historical attempt credential to clean up unresolved resources', async () => {
    const db = getDB();
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const attemptCredentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const id = 'teardown-historical-attempt';

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await walkToState(id, WorkloadState.Provisioning);
    const attempt = await ledger().beginProvisioningAttempt(id, `${id}-0`, {
      region: 'us-central1',
      vmType: 'n2-standard-4',
      credentialId: attemptCredentialId,
    });
    expect(attempt).not.toBeNull();
    const providerResourceId = 'gcp-provider-resource-123';
    await ledger().retargetProvisioningAttempt(
      id,
      attempt!,
      providerResourceId,
    );

    await runWorkloadReconcileOnce({ activeRecoveryNow: true });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(
      (await ledger().getUnresolvedProvisioningAttempts(id))[0]?.cloud_id,
    ).toBe(providerResourceId);
    await db.query(
      `UPDATE workload_events SET created_at = ?
       WHERE workload_id = ? AND state = ?`,
      [Date.now() - RETRY_JITTER_CAP_MS - 1_000, id, WorkloadState.Retrying],
    );

    await runWorkloadReconcileOnce();

    expect(termination.teardownVMs).toHaveBeenCalledWith(
      expect.objectContaining({ cloudProvider: CloudType.GCP }),
      id,
    );
    expect((await queries().getWorkload(id))?.state).toBe(WorkloadState.Queued);
  });

  it('terminates VMs when failedAtState is a provisioning step even with live VMs', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'teardown-provisioning',
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

    // Simulate: failed at Provisioning → Retrying
    // Seed a live VM
    await provisionTestVm('teardown-provisioning', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });

    await walkToState('teardown-provisioning', WorkloadState.Retrying);

    // Backdate so backoff window has elapsed
    const retryTs = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    const provisioningTs = retryTs - 1_000;
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [retryTs, 'teardown-provisioning', WorkloadState.Retrying],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [provisioningTs, 'teardown-provisioning', WorkloadState.Provisioning],
    );

    await runWorkloadReconcileOnce();

    // teardownVMs SHOULD be called — provisioning failure needs VM teardown
    expect(termination.teardownVMs).toHaveBeenCalledOnce();

    // Workload should be re-queued
    const d = await queries().getWorkload('teardown-provisioning');
    expect(d?.state).toBe(WorkloadState.Queued);
  });

  it.each([false, true])(
    'waits for Service retirement before replacement (release pending: %s)',
    async (releasePending) => {
      const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
      const credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_LAMBDA_CRED),
        encryptedCred,
        CloudType.GCP,
      );
      await createWorkload(getDB(), {
        id: 'replace-service-runtime',
        userId: 'test-user',
        workloadType: 'service',
        image: 'nginx:latest',
        requestedComputeProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'n2-standard-4',
        spot: false,
        dockerCommand: 'docker run nginx',
        sshPrivateKey: 'test-ssh-key',
        credentialId,
      });
      await provisionTestVm('replace-service-runtime', {
        ip: '1.2.3.4',
        cloudId: 'service-capacity',
      });
      await walkToState('replace-service-runtime', WorkloadState.Recovering);

      if (releasePending) {
        serveRuntime.teardown.mockResolvedValueOnce(undefined);
      }
      const beforeRetry = (
        await lifecycle().getRetryCandidatesByIds(['replace-service-runtime'])
      )[0];
      const status = await runWorkloadReconcileOnce();

      expect(serveRuntime.teardown).toHaveBeenCalledWith({
        workload: expect.objectContaining({ id: 'replace-service-runtime' }),
        placement: {
          cloudConfig: expect.objectContaining({
            cloudProvider: CloudType.GCP,
          }),
        },
      });
      expect(termination.teardownVMs).not.toHaveBeenCalled();
      expect(
        (await queries().getWorkload('replace-service-runtime'))?.state,
      ).toBe(releasePending ? WorkloadState.Recovering : WorkloadState.Queued);
      if (releasePending) {
        expect(status.deferredCount).toBe(1);
        expect(
          (
            await lifecycle().getRetryCandidatesByIds([
              'replace-service-runtime',
            ])
          )[0],
        ).toEqual(beforeRetry);
        expect(await queries().getVMs('replace-service-runtime')).toHaveLength(
          1,
        );
      } else {
        expect(await queries().getVMs('replace-service-runtime')).toHaveLength(
          0,
        );
      }
    },
  );

  it('stays Retrying when teardownVMs throws — does not re-queue with ghost VM in DB', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'cleanup-throws',
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

    // Seed a live VM — the ghost VM that teardownVMs must clean up
    await provisionTestVm('cleanup-throws', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });

    // Set to Retrying and backdate past the backoff cap so re-queue would normally proceed
    await walkToState('cleanup-throws', WorkloadState.Retrying);
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        Date.now() - RETRY_JITTER_CAP_MS - 1000,
        'cleanup-throws',
        WorkloadState.Retrying,
      ],
    );

    // Cloud API fails — teardownVMs throws
    vi.mocked(termination.teardownVMs).mockRejectedValueOnce(
      new Error('GCP delete failed'),
    );

    await runWorkloadReconcileOnce();

    // Must stay Retrying — re-queuing with a ghost VM in DB causes zombie VMs on the next
    // provisioning attempt (new VM is created alongside the existing one)
    const d = await queries().getWorkload('cleanup-throws');
    expect(d?.state).toBe(WorkloadState.Retrying);
  });

  it('re-queues a workload once the backoff window has elapsed', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-test',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    await walkToState('retry-test', WorkloadState.Retrying);

    // Backdate the Retrying event past the maximum infra jitter window
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        Date.now() - RETRY_JITTER_CAP_MS - 1000,
        'retry-test',
        WorkloadState.Retrying,
      ],
    );

    await runWorkloadReconcileOnce();

    // No VMs seeded — terminateStep is not called (nothing to clean up)
    expect(termination.terminateStep).not.toHaveBeenCalled();
    // deploy is NOT called directly — provisioning scheduler picks it up from Queued
    expect(startup.deploy).not.toHaveBeenCalled();

    // State must be Queued so the provisioning scheduler can dispatch it
    const workload = await queries().getWorkload('retry-test');
    expect(workload?.state).toBe(WorkloadState.Queued);
  });

  it('respects the longer provisioning backoff when failedAtState is Provisioning', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-provisioning-failure',
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

    // Simulate: failed at Provisioning → then set to Retrying
    // failedAtState = the event immediately before the last Retrying event
    await walkToState('retry-provisioning-failure', WorkloadState.Provisioning);
    await walkToState('retry-provisioning-failure', WorkloadState.Retrying);

    // Backdate both events so Provisioning precedes Retrying and Retrying is past
    // the jitter cap (10 min), guaranteeing the window has elapsed
    const retryTs = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    const provisioningTs = retryTs - 1_000; // must be before retryTs for failedAtState lookup
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [retryTs, 'retry-provisioning-failure', WorkloadState.Retrying],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        provisioningTs,
        'retry-provisioning-failure',
        WorkloadState.Provisioning,
      ],
    );

    await runWorkloadReconcileOnce();

    // The provisioning jitter cap has elapsed → workload should be re-queued
    const workload = await queries().getWorkload('retry-provisioning-failure');
    expect(workload?.state).toBe(WorkloadState.Queued);
  });

  it('keeps the attempt limit for pinned capacity retries', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.Lambda,
    );

    await createWorkload(getDB(), {
      id: 'retry-exhausted-test',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Lambda,
      region: 'us-south-2',
      vmType: 'gpu_2x_h100_sxm5',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    // Seed 99 prior retry events, then make the 100th a real pinned
    // Provisioning → Retrying capacity failure. The short retry path must
    // remain behind the shared attempt cap.
    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
      await db.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
        ['retry-exhausted-test', WorkloadState.Retrying, null, oldTs],
      );
    }
    await provisionTestVm('retry-exhausted-test', {
      ip: '10.0.0.1',
      cloudId: 'lambda-ended-vm-id',
    });
    await walkToState('retry-exhausted-test', WorkloadState.Retrying);
    await db.query(
      `UPDATE workload_events SET metadata = ?
       WHERE workload_id = ? AND state = ?`,
      [
        JSON.stringify({
          diagnosis: CloudFailureDiagnosis.CapacityExhausted,
          disposition: FailureDisposition.RetrySameTarget,
          errorKind: CloudFailureDiagnosis.CapacityExhausted,
          error: 'insufficient capacity',
        }),
        'retry-exhausted-test',
        WorkloadState.Retrying,
      ],
    );

    // A capacity-exhausted provisioning retry always registered its attempt row
    // before calling the provider, and retry teardown then ended it. Cleanup
    // still owns that placement's networking.
    await releaseTestVms('retry-exhausted-test', 'lambda-ended-vm-id');

    await runWorkloadReconcileOnce();

    expect(startup.deploy).not.toHaveBeenCalled();
    expect((await queries().getWorkload('retry-exhausted-test'))?.state).toBe(
      WorkloadState.Failed,
    );

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledWith(
      expect.anything(),
      'retry-exhausted-test',
    );
    expect(
      (await queries().getWorkload('retry-exhausted-test'))?.cleanedAt,
    ).not.toBeNull();

    const workload = await queries().getWorkload('retry-exhausted-test');
    expect(workload?.state).toBe(WorkloadState.Failed);
  });

  it('scales retry limit by resubmit count so resubmitted workloads get extra attempts', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'resubmit-retry-scale',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    // Simulate max attempts (exhausted) then resubmit
    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1000;
    await walkToState('resubmit-retry-scale', WorkloadState.Retrying);
    for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
      await db.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
        ['resubmit-retry-scale', WorkloadState.Retrying, null, oldTs],
      );
    }
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'resubmit-retry-scale', WorkloadState.Retrying],
    );

    // Exhaust retries → Failed
    await runWorkloadReconcileOnce();
    expect((await queries().getWorkload('resubmit-retry-scale'))?.state).toBe(
      WorkloadState.Failed,
    );
    await runWorkloadReconcileOnce();
    const failedDep = await queries().getWorkload('resubmit-retry-scale');
    expect(failedDep?.state).toBe(WorkloadState.Failed);

    // Resubmit — this doubles the allowed retries
    await outcomes().resubmitWorkload('resubmit-retry-scale');

    // Back to Retrying with same event count (still at FAILED_DEPLOY_MAX_ATTEMPTS)
    await walkToState('resubmit-retry-scale', WorkloadState.Retrying);
    // Backdate so backoff window has elapsed
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ? AND created_at > ?`,
      [oldTs, 'resubmit-retry-scale', WorkloadState.Retrying, oldTs],
    );

    // Should NOT be exhausted because limit is now MAX_ATTEMPTS * 2
    await runWorkloadReconcileOnce();
    const afterResubmit = await queries().getWorkload('resubmit-retry-scale');
    expect(afterResubmit?.state).toBe(WorkloadState.Queued);
  });

  it('runs full cleanup before marking Failed when retry attempts are exhausted', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-exhausted-with-vm',
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

    // Simulate max attempts all backdated past the jitter cap
    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1000;
    // Seed a live VM — should be cleaned up even on exhaustion
    await provisionTestVm('retry-exhausted-with-vm', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });

    await walkToState('retry-exhausted-with-vm', WorkloadState.Retrying);
    for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
      await db.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
        ['retry-exhausted-with-vm', WorkloadState.Retrying, null, oldTs],
      );
    }
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'retry-exhausted-with-vm', WorkloadState.Retrying],
    );

    await runWorkloadReconcileOnce();
    expect(
      (await queries().getWorkload('retry-exhausted-with-vm'))?.state,
    ).toBe(WorkloadState.Failed);
    await runWorkloadReconcileOnce();

    // Exhaustion is final, so it must clean workload-scoped networking too.
    expect(termination.teardownVMs).not.toHaveBeenCalled();
    expect(termination.terminateStep).toHaveBeenCalledWith(
      expect.anything(),
      'retry-exhausted-with-vm',
    );

    // A failed deploy step ended the last attempt before the program ran.
    await expect(
      queries().getWorkload('retry-exhausted-with-vm'),
    ).resolves.toMatchObject({
      state: WorkloadState.Failed,
      endReason: 'retries-exhausted',
      lastAttemptEndReason: null,
    });
  });

  it.each([
    [true, 'reclaimed'],
    [false, 'lost'],
  ] as const)(
    'RFC 0049 C15: a spot Job whose budget runs out in Recovering, its VM preempted=%s, names its last attempt %s',
    async (markPreempted, lastAttemptEndReason) => {
      const credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_LAMBDA_CRED),
        await encryptCredential(TEST_LAMBDA_CRED),
        CloudType.GCP,
      );
      await createWorkload(getDB(), {
        id: 'recovering-exhausted',
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'n2-standard-4',
        spot: true,
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'test-ssh-key',
        credentialId,
      });
      const vm = { ip: '1.2.3.4', cloudId: 'gcp-vm-id' };
      await provisionTestVm('recovering-exhausted', vm);
      await walkToState('recovering-exhausted', WorkloadState.Running);
      // The preemption monitor marks the VM; an unreachable host doesn't.
      await lifecycle().claimRecovery(
        'recovering-exhausted',
        WorkloadState.Running,
        { vm: { ...vm, markPreempted } },
      );
      // Teardown ends the row and keeps its flag.
      await getDB().query('UPDATE vms SET ended_at = 1 WHERE workload_id = ?', [
        'recovering-exhausted',
      ]);
      for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
        await getDB().query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
          ['recovering-exhausted', WorkloadState.Recovering, null, 1],
        );
      }

      await runWorkloadReconcileOnce();

      await expect(
        queries().getWorkload('recovering-exhausted'),
      ).resolves.toMatchObject({
        state: WorkloadState.Failed,
        endReason: 'retries-exhausted',
        lastAttemptEndReason,
      });
    },
  );

  it('runs full cleanup on exhaustion even when retry teardown already ended every VM row', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-exhausted-ended-vms',
      userId: 'test-user',
      workloadType: 'service',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1000;
    await provisionTestVm('retry-exhausted-ended-vms', {
      ip: '1.2.3.4',
      cloudId: 'gcp-ended-vm-id',
    });
    await walkToState('retry-exhausted-ended-vms', WorkloadState.Retrying);
    for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
      await db.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
        ['retry-exhausted-ended-vms', WorkloadState.Retrying, null, oldTs],
      );
    }
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'retry-exhausted-ended-vms', WorkloadState.Retrying],
    );

    await releaseTestVms('retry-exhausted-ended-vms', 'gcp-ended-vm-id');
    expect(await queries().getVMs('retry-exhausted-ended-vms')).toHaveLength(0);

    await runWorkloadReconcileOnce();
    expect(
      (await queries().getWorkload('retry-exhausted-ended-vms'))?.state,
    ).toBe(WorkloadState.Failed);
    await runWorkloadReconcileOnce();

    expect(termination.teardownVMs).not.toHaveBeenCalled();
    expect(serveRuntime.cleanup).toHaveBeenCalledWith({
      workload: expect.objectContaining({
        id: 'retry-exhausted-ended-vms',
      }),
      placement: {
        cloudConfig: expect.objectContaining({
          cloudProvider: CloudType.GCP,
        }),
      },
    });
    expect(termination.terminateStep).not.toHaveBeenCalled();
    expect(
      (await queries().getWorkload('retry-exhausted-ended-vms'))?.state,
    ).toBe(WorkloadState.Failed);
  });

  it('stays Failed when final cleanup fails during retry exhaustion', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'retry-exhausted-cleanup-fails',
      userId: 'test-user',
      workloadType: 'service',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1000;
    await provisionTestVm('retry-exhausted-cleanup-fails', {
      ip: '1.2.3.4',
      cloudId: 'cleanup-failure-attempt',
    });
    await walkToState('retry-exhausted-cleanup-fails', WorkloadState.Retrying);
    for (let i = 1; i < FAILED_DEPLOY_MAX_ATTEMPTS; i++) {
      await db.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
        ['retry-exhausted-cleanup-fails', WorkloadState.Retrying, null, oldTs],
      );
    }
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'retry-exhausted-cleanup-fails', WorkloadState.Retrying],
    );
    await releaseTestVms(
      'retry-exhausted-cleanup-fails',
      'cleanup-failure-attempt',
    );

    serveRuntime.cleanup.mockRejectedValueOnce(
      new Error('network still attached'),
    );

    await runWorkloadReconcileOnce();
    expect(
      (await queries().getWorkload('retry-exhausted-cleanup-fails'))?.state,
    ).toBe(WorkloadState.Failed);
    await runWorkloadReconcileOnce();

    expect(serveRuntime.cleanup).toHaveBeenCalledWith({
      workload: expect.objectContaining({
        id: 'retry-exhausted-cleanup-fails',
      }),
      placement: {
        cloudConfig: expect.objectContaining({
          cloudProvider: CloudType.GCP,
        }),
      },
    });
    expect(
      (await queries().getWorkload('retry-exhausted-cleanup-fails'))?.state,
    ).toBe(WorkloadState.Failed);
  });

  it('marks as Failed immediately when credentials are missing', async () => {
    // Simulate the missing-credentials state: legacy rows from before
    // migration 0014 had credential_id = '' which 0042 NULLifies, and
    // operator/manual edits could also produce NULL. The defensive
    // `!workload?.credentialId` branch in `loadWorkloadConfigs`'s credential
    // resolution treats both as "missing creds".
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'retry-missing-creds',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await getDB().query(
      `UPDATE workloads SET credential_id = NULL WHERE id = ?`,
      ['retry-missing-creds'],
    );

    await walkToState('retry-missing-creds', WorkloadState.Retrying);

    // No backdating needed — credentials are checked before the backoff window,
    // so missing creds → Failed regardless of how recently the Retrying event was set.
    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).not.toHaveBeenCalled();
    expect(startup.deploy).not.toHaveBeenCalled();

    const workload = await queries().getWorkload('retry-missing-creds');
    expect(workload?.state).toBe(WorkloadState.Failed);
  });

  it('cleans up VMs and re-queues immediately for a Recovering workload (no backoff)', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'recovering-with-vm',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    // Starting is normally reusable for a deploy retry, but Recovering means
    // preemption owns the VM and must always clean it up before re-provisioning.
    await provisionTestVm('recovering-with-vm', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });
    await walkToState('recovering-with-vm', WorkloadState.Starting);
    await walkToState('recovering-with-vm', WorkloadState.Recovering);

    await runWorkloadReconcileOnce();

    // VM must be cleaned up immediately even before backoff elapses
    expect(termination.teardownVMs).toHaveBeenCalledOnce();

    // Preemption recovery skips backoff — workload is re-queued immediately
    const d = await queries().getWorkload('recovering-with-vm');
    expect(d?.state).toBe(WorkloadState.Queued);
  });

  it('does not let provisioning region exhaustion override Recovering backoff skip', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'recovering-all-regions-tried',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: null as any,
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    await provisionTestVm(
      'recovering-all-regions-tried',
      {
        ip: '1.2.3.4',
        cloudId: 'gcp-live-vm-id',
      },
      { region: 'us-east1' },
    );
    await provisionTestVm(
      'recovering-all-regions-tried',
      { cloudId: 'gcp-failed-us-central1' },
      { region: 'us-central1' },
    );
    await provisionTestVm(
      'recovering-all-regions-tried',
      { cloudId: 'gcp-failed-us-west1' },
      { region: 'us-west1' },
    );
    await walkToState('recovering-all-regions-tried', WorkloadState.Recovering);

    await runWorkloadReconcileOnce();

    expect(termination.teardownVMs).toHaveBeenCalledOnce();
    const d = await queries().getWorkload('recovering-all-regions-tried');
    expect(d?.state).toBe(WorkloadState.Queued);
  });

  it('processes all candidates independently — one terminateStep failure does not block others', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    const oldTs = Date.now() - RETRY_JITTER_CAP_MS - 1000;

    // First workload: has a VM, terminateStep will throw
    await createWorkload(getDB(), {
      id: 'isolation-fails',
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
    await provisionTestVm('isolation-fails', {
      ip: '1.2.3.4',
      cloudId: 'gcp-vm-id',
    });
    await walkToState('isolation-fails', WorkloadState.Retrying);
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'isolation-fails', WorkloadState.Retrying],
    );

    // Second workload: no VM, backoff elapsed — should be re-queued cleanly
    await createWorkload(getDB(), {
      id: 'isolation-succeeds',
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
    await walkToState('isolation-succeeds', WorkloadState.Retrying);
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [oldTs, 'isolation-succeeds', WorkloadState.Retrying],
    );

    vi.mocked(termination.teardownVMs).mockRejectedValueOnce(
      new Error('GCP delete failed'),
    );

    await runWorkloadReconcileOnce();

    // First: teardownVMs threw → stays Retrying, VM still present (cleanup failed)
    const d1 = await queries().getWorkload('isolation-fails');
    expect(d1?.state).toBe(WorkloadState.Retrying);
    const d1VMs = await queries().getVMs('isolation-fails');
    expect(d1VMs.length).toBe(1);

    // Second: unaffected by first's failure → re-queued, no VMs
    const d2 = await queries().getWorkload('isolation-succeeds');
    expect(d2?.state).toBe(WorkloadState.Queued);
    const d2VMs = await queries().getVMs('isolation-succeeds');
    expect(d2VMs.length).toBe(0);
  });
});

describe('retry reconciliation — provisioning tier', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  it('uses the ordinary provisioning backoff for pinned capacity failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const db = getDB();
      const id = 'pinned-gcp-capacity-retry';
      const encryptedCred = await encryptCredential(TEST_GCP_CRED);
      const credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_GCP_CRED),
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
      await walkToState(id, WorkloadState.Retrying);
      await db.query(
        `UPDATE workload_events SET metadata = ?
         WHERE workload_id = ? AND state = ?`,
        [
          JSON.stringify({
            diagnosis: CloudFailureDiagnosis.CapacityExhausted,
            disposition: FailureDisposition.RetrySameTarget,
            errorKind: CloudFailureDiagnosis.CapacityExhausted,
            error: 'insufficient capacity',
          }),
          id,
          WorkloadState.Retrying,
        ],
      );

      await runWorkloadReconcileOnce();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Retrying,
      );
      // Driven off the sampled window, not a fixed constant: the reconciler
      // draws a point inside [minMs, maxMs], so advancing a hardcoded amount
      // makes this pass only some of the time whenever the curve is retuned.
      const { minMs, maxMs } = retryWindow(WorkloadState.Provisioning, 1);
      await vi.advanceTimersByTimeAsync(minMs - 1);
      await runWorkloadReconcileOnce();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Retrying,
      );

      await vi.advanceTimersByTimeAsync(maxMs - minMs + 2);
      await runWorkloadReconcileOnce();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Queued,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queues a pinned-region provisioning failure after backoff elapses', async () => {
    // Pinned-region provisioning failures respect backoff since there are no
    // alternative regions to try.
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'prov-tier-test',
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

    // Build a real Provisioning → Retrying trace
    await walkToState('prov-tier-test', WorkloadState.Provisioning);
    await walkToState('prov-tier-test', WorkloadState.Retrying);

    // Backdate: Retrying beyond the jitter cap — backoff has elapsed.
    const pastBackoff = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [pastBackoff - 60_000, 'prov-tier-test', WorkloadState.Provisioning],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [pastBackoff, 'prov-tier-test', WorkloadState.Retrying],
    );

    await runWorkloadReconcileOnce();

    // Re-queued after backoff elapsed
    const workload = await queries().getWorkload('prov-tier-test');
    expect(workload?.state).toBe(WorkloadState.Queued);
  });

  it('marks pinned provisioning-rejected as Failed after the small retry budget', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'pinned-provisioning-rejected',
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

    for (let i = 0; i < PINNED_PROVISIONING_REJECTION_MAX_ATTEMPTS; i += 1) {
      await walkToState(
        'pinned-provisioning-rejected',
        WorkloadState.Provisioning,
      );
      await walkToState('pinned-provisioning-rejected', WorkloadState.Retrying);
      if (i < PINNED_PROVISIONING_REJECTION_MAX_ATTEMPTS - 1) {
        await walkToState('pinned-provisioning-rejected', WorkloadState.Queued);
      }
    }
    await db.query(
      `UPDATE workload_events SET metadata = ?
       WHERE workload_id = ? AND state = ?`,
      [
        JSON.stringify({
          diagnosis: CloudFailureDiagnosis.ProvisioningRejected,
          disposition: FailureDisposition.RetrySameTarget,
          errorKind: CloudFailureDiagnosis.ProvisioningRejected,
          error: 'Unknown',
        }),
        'pinned-provisioning-rejected',
        WorkloadState.Retrying,
      ],
    );

    await runWorkloadReconcileOnce();
    expect(
      (await queries().getWorkload('pinned-provisioning-rejected'))?.state,
    ).toBe(WorkloadState.Failed);
    await runWorkloadReconcileOnce();

    const workload = await queries().getWorkload(
      'pinned-provisioning-rejected',
    );
    expect(workload?.state).toBe(WorkloadState.Failed);
    const events = await eventLog().getWorkloadEvents(
      'pinned-provisioning-rejected',
    );
    const outcomeMetadata = JSON.parse(events.at(-1)?.metadata ?? '{}');
    expect(outcomeMetadata.diagnosis).toBe(
      CloudFailureDiagnosis.ProvisioningRejected,
    );
    expect(outcomeMetadata.disposition).toBe(FailureDisposition.TerminalFailed);
  });

  it.each([
    [UNUSABLE_GPU_MAX_RETRIES, WorkloadState.Queued],
    [UNUSABLE_GPU_MAX_RETRIES + 1, WorkloadState.Failed],
  ])(
    'after %i unusable-GPU retries a GPU Job is %s',
    async (retries, expected) => {
      const id = `unusable-gpu-${retries}`;
      const credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_LAMBDA_CRED),
        await encryptCredential(TEST_LAMBDA_CRED),
        CloudType.GCP,
      );
      await createWorkload(getDB(), {
        id,
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'g2-standard-4',
        spot: true,
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'test-ssh-key',
        credentialId,
      });
      for (let i = 0; i < retries; i += 1) {
        if (i > 0) await walkToState(id, WorkloadState.Queued);
        await walkToState(id, WorkloadState.Provisioning);
        await walkToState(id, WorkloadState.Running);
        await walkToState(id, WorkloadState.Retrying);
      }
      await getDB().query(
        `UPDATE workload_events SET metadata = ?, created_at = ?
         WHERE workload_id = ? AND state = ?`,
        [
          JSON.stringify({ diagnosis: UNUSABLE_GPU_DIAGNOSIS, exitCode: 1 }),
          Date.now() - RETRY_JITTER_CAP_MS - 1_000,
          id,
          WorkloadState.Retrying,
        ],
      );

      await runWorkloadReconcileOnce();

      expect((await queries().getWorkload(id))?.state).toBe(expected);
      if (expected === WorkloadState.Failed) {
        const events = await eventLog().getWorkloadEvents(id);
        expect(JSON.parse(events.at(-1)?.metadata ?? '{}').reason).toBe(
          UNUSABLE_GPU_EXHAUSTED,
        );
      }
    },
  );

  it('applies provisioning backoff to a failover-target failure', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'prov-multi-test',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: null as any,
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    // Build a real Provisioning → Retrying trace
    await walkToState('prov-multi-test', WorkloadState.Provisioning);
    await walkToState('prov-multi-test', WorkloadState.Retrying);

    // Retrying only 5 sec ago — every provisioning diagnosis uses the same
    // retry curve.
    const fiveSecAgo = Date.now() - 5_000;
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [fiveSecAgo - 60_000, 'prov-multi-test', WorkloadState.Provisioning],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [fiveSecAgo, 'prov-multi-test', WorkloadState.Retrying],
    );
    await db.query(
      `UPDATE workload_events SET metadata = ?
       WHERE workload_id = ? AND state = ?`,
      [
        JSON.stringify({
          diagnosis: CloudFailureDiagnosis.ProvisioningRejected,
          disposition: FailureDisposition.FailoverTarget,
          errorKind: CloudFailureDiagnosis.ProvisioningRejected,
          error: 'Unknown',
        }),
        'prov-multi-test',
        WorkloadState.Retrying,
      ],
    );

    await runWorkloadReconcileOnce();

    const workload = await queries().getWorkload('prov-multi-test');
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });

  it('holds retry-same-target multi-region provisioning failures while backoff has not elapsed', async () => {
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'prov-retry-same-target',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: null as any,
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });

    await walkToState('prov-retry-same-target', WorkloadState.Provisioning);
    await walkToState('prov-retry-same-target', WorkloadState.Retrying);

    const fiveSecAgo = Date.now() - 5_000;
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [
        fiveSecAgo - 60_000,
        'prov-retry-same-target',
        WorkloadState.Provisioning,
      ],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ?, metadata = ?
       WHERE workload_id = ? AND state = ?`,
      [
        fiveSecAgo,
        JSON.stringify({
          diagnosis: CloudFailureDiagnosis.TemporaryProviderFailure,
          disposition: FailureDisposition.RetrySameTarget,
          errorKind: CloudFailureDiagnosis.TemporaryProviderFailure,
          error: 'temporary provider failure',
        }),
        'prov-retry-same-target',
        WorkloadState.Retrying,
      ],
    );

    await runWorkloadReconcileOnce();

    const workload = await queries().getWorkload('prov-retry-same-target');
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });

  it('holds a non-provisioning failure in Retrying when elapsed is below the backoff floor', async () => {
    // Non-provisioning failures (e.g. Initializing) must respect backoff.
    // At 5 sec elapsed the jitter floor (1 min) hasn't passed — stay Retrying.
    const db = getDB();

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'init-backoff-test',
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

    // Build Initializing → Retrying trace
    await walkToState('init-backoff-test', WorkloadState.Provisioning);
    await walkToState('init-backoff-test', WorkloadState.Initializing);
    await walkToState('init-backoff-test', WorkloadState.Retrying);

    // Backdate: Retrying at 5 sec ago — well below the 1 min floor
    const fiveSecAgo = Date.now() - 5_000;
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [fiveSecAgo - 60_000, 'init-backoff-test', WorkloadState.Initializing],
    );
    await db.query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [fiveSecAgo, 'init-backoff-test', WorkloadState.Retrying],
    );

    await runWorkloadReconcileOnce();

    // Still in Retrying — backoff holds it
    const workload = await queries().getWorkload('init-backoff-test');
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });
});

describe('poll reconciliation — preemption recovery', () => {
  let mockCloud: {
    verifyVMPreemption: Mock<(cloudId: string) => Promise<boolean>>;
    startVM: Mock<(cloudId: string) => Promise<string | null>>;
  };

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    mockCloud = {
      verifyVMPreemption: vi
        .fn<(cloudId: string) => Promise<boolean>>()
        .mockResolvedValue(true),
      startVM: vi
        .fn<(cloudId: string) => Promise<string | null>>()
        .mockResolvedValue(null), // restart fails by default
    };
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute(mockCloud),
    );
  });

  async function createRunningSpotWorkload(id: string): Promise<void> {
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
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await provisionTestVm(
      id,
      { ip: '1.2.3.4', cloudId: 'vm-cloud-id' },
      { region: 'us-central1', vmType: 'n2-standard-4' },
    );
    await walkToState(id, WorkloadState.Running);
  }

  it('claims Recovering before waiting for startVM', async () => {
    await createRunningSpotWorkload('preempt-recovering-before-restart');
    const store = queries();
    let finishRestart!: (ip: string | null) => void;
    mockCloud.startVM.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          finishRestart = resolve;
        }),
    );

    const check = runWorkloadReconcileOnce();
    await vi.waitFor(() => expect(mockCloud.startVM).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });

    expect(
      (await store.getWorkload('preempt-recovering-before-restart'))?.state,
    ).toBe(WorkloadState.Recovering);
    expect(
      (await store.getVMs('preempt-recovering-before-restart'))[0]?.preempt,
    ).toBe(1);

    finishRestart(null);
    await check;
  });

  it('restarts with the exact VM credential, region, and zone after Workload configuration changes', async () => {
    const id = 'preempt-exact-attempt';
    await createRunningSpotWorkload(id);
    const store = queries();
    const original = { ...TEST_GCP_CRED, projectId: 'original-project' };
    const originalCredential = await upsertCredential(
      getDB(),
      'original-project',
      await encryptCredential(original),
      CloudType.GCP,
    );
    await getDB().query(
      'UPDATE vms SET credential_id = ?, region = ?, availability_zone = ? WHERE workload_id = ?',
      [originalCredential, 'us-east4', 'c', id],
    );
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      makeMockCloudCompute({
        ...mockCloud,
        type: cfg.cloudProvider,
        region: cfg.region,
      }),
    );

    await runWorkloadReconcileOnce();

    expect(createComputeProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cloudProvider: CloudType.GCP,
        credentials: expect.objectContaining({
          projectId: original.projectId,
          clientEmail: original.clientEmail,
          privateKey: original.privateKey,
        }),
        region: 'us-east4',
        availabilityZone: 'c',
      }),
      'observed-vm',
    );
    expect(mockCloud.verifyVMPreemption).toHaveBeenCalledWith('vm-cloud-id');
    expect(mockCloud.startVM).toHaveBeenCalledWith('vm-cloud-id');
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Recovering);
    expect(termination.teardownVMs).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          projectId: original.projectId,
          clientEmail: original.clientEmail,
          privateKey: original.privateKey,
        }),
        region: 'us-east4',
        availabilityZone: 'c',
      }),
      id,
    );
  });

  it('transitions to Recovering before teardownVMs when startVM returns null', async () => {
    await createRunningSpotWorkload('preempt-normal');

    await runWorkloadReconcileOnce();

    const d = await queries().getWorkload('preempt-normal');
    expect(d?.state).toBe(WorkloadState.Recovering);
    expect(termination.teardownVMs).toHaveBeenCalledOnce();
    const events = await eventLog().getWorkloadEvents('preempt-normal');
    expect(
      events.filter((event) => event.state === WorkloadState.Recovering),
    ).toHaveLength(1);
  });

  it('does not mutate or restart the VM when termination wins the recovery claim', async () => {
    await createRunningSpotWorkload('preempt-cas-fails');

    const store = queries();
    mockCloud.verifyVMPreemption.mockImplementationOnce(async () => {
      await outcomes().requestTermination(
        'preempt-cas-fails',
        scope('test-user'),
      );
      return true;
    });

    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('preempt-cas-fails'))?.state).toBe(
      WorkloadState.Terminated,
    );
    expect(mockCloud.startVM).not.toHaveBeenCalled();
    expect((await store.getVMs('preempt-cas-fails'))[0]?.preempt).not.toBe(1);
    expect(termination.teardownVMs).not.toHaveBeenCalled();
  });

  it('does not let a stale cloud check claim a replacement workload', async () => {
    await createRunningSpotWorkload('preempt-stale-cloud-check');
    const store = queries();
    mockCloud.verifyVMPreemption.mockImplementationOnce(async () => {
      // The workload retried onto a replacement VM while the check ran.
      await walkToState('preempt-stale-cloud-check', WorkloadState.Retrying);
      await releaseTestVms('preempt-stale-cloud-check', 'vm-cloud-id');
      await walkToState(
        'preempt-stale-cloud-check',
        WorkloadState.Provisioning,
      );
      await provisionTestVm('preempt-stale-cloud-check', {
        ip: '9.8.7.6',
        cloudId: 'replacement-cloud-id',
      });
      await walkToState('preempt-stale-cloud-check', WorkloadState.Running);
      return true;
    });

    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('preempt-stale-cloud-check'))?.state).toBe(
      WorkloadState.Running,
    );
    expect(await store.getVMs('preempt-stale-cloud-check')).toMatchObject([
      { ip: '9.8.7.6', cloudId: 'replacement-cloud-id' },
    ]);
    expect(mockCloud.startVM).not.toHaveBeenCalled();
    expect(termination.teardownVMs).not.toHaveBeenCalled();
  });

  it('leaves workload in Recovering even when teardownVMs throws', async () => {
    await createRunningSpotWorkload('preempt-terminate-throws');
    vi.mocked(termination.teardownVMs).mockRejectedValueOnce(
      new Error('cleanup failed'),
    );

    await runWorkloadReconcileOnce();

    const d = await queries().getWorkload('preempt-terminate-throws');
    expect(d?.state).toBe(WorkloadState.Recovering);
    expect(termination.teardownVMs).toHaveBeenCalledOnce();
  });

  it.each(['verifyVMPreemption', 'startVM'] as const)(
    'claims Recovering and tears down when %s throws',
    async (failing) => {
      const id = `preempt-${failing}-throws`;
      await createRunningSpotWorkload(id);
      mockCloud[failing].mockRejectedValueOnce(new Error('API down'));

      await runWorkloadReconcileOnce();

      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Recovering,
      );
      expect(termination.teardownVMs).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        id,
      );
    },
  );

  it('does not tear down when termination wins after the preemption check fails', async () => {
    const id = 'preempt-observe-throws-terminated';
    await createRunningSpotWorkload(id);
    mockCloud.verifyVMPreemption.mockImplementationOnce(async () => {
      await outcomes().requestTermination(id, scope('test-user'));
      throw new Error('API down');
    });

    await runWorkloadReconcileOnce();

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Terminated,
    );
    expect(termination.teardownVMs).not.toHaveBeenCalled();
  });

  it('preserves an unreachable Job while the cloud release awaits confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => void vi.useRealTimers());
    const id = 'unreachable-release-confirming';
    await createRunningSpotWorkload(id);
    mockCloud.verifyVMPreemption.mockResolvedValue(false);
    vi.mocked(tcpPing).mockResolvedValue(false);
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        ...mockCloud,
        releaseConfirmationPolicy: {
          requiredReleaseObservations: 2,
          minObservationIntervalMs: 60_000,
        },
        // The provider read outlasts the whole unreachable window.
        observeVMReleaseOnce: vi.fn(async () => {
          vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS);
          return VM_RELEASE_CANDIDATE;
        }),
      }),
    );

    await runWorkloadReconcileOnce();

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Running,
    );
    expect(termination.teardownVMs).not.toHaveBeenCalled();
  });
});

describe('poll reconciliation — startVM success path (container restart)', () => {
  let mockCloud: {
    verifyVMPreemption: Mock<(cloudId: string) => Promise<boolean>>;
    startVM: Mock<(cloudId: string) => Promise<string | null>>;
  };

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    vi.spyOn(SSHManager, 'derivePublicKey').mockResolvedValue(
      'ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQC test-key',
    );
    mockCloud = {
      verifyVMPreemption: vi
        .fn<(cloudId: string) => Promise<boolean>>()
        .mockResolvedValue(true),
      startVM: vi
        .fn<(cloudId: string) => Promise<string | null>>()
        .mockResolvedValue('5.6.7.8'),
    };
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute(mockCloud),
    );
  });

  async function createRunningSpotWorkload(
    id: string,
    workloadType: 'job' | 'service' = 'job',
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
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await walkToState(id, WorkloadState.Provisioning);
    // Use a past timestamp so the soft-deleted row's created_at doesn't
    // collide with the restart row's created_at in PK (workload_id, cloud_id, created_at)
    // when finishPreemptionRecovery ends and reinserts it in the same millisecond.
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) - 1000;
    await provisionTestVm(id, {
      ip: '1.2.3.4',
      cloudId: 'vm-cloud-id',
      sshHost: '1.2.3.4',
      sshPort: 22,
    });
    Date.now = realNow;
    await walkToState(id, WorkloadState.Running);
  }

  it('claims Starting and fires resumeOnExistingVM after startVM returns new IP', async () => {
    await createRunningSpotWorkload('restart-job-success');

    await runWorkloadReconcileOnce();

    expect(vi.mocked(startup.resumeOnExistingVM)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(), // cloudConfig
      expect.objectContaining({ id: 'restart-job-success' }),
    );
    const d = await queries().getWorkload('restart-job-success');
    expect(await queries().getVMs('restart-job-success')).toMatchObject([
      {
        cloudId: 'vm-cloud-id',
        ip: '5.6.7.8',
        sshHost: '5.6.7.8',
        sshPort: 22,
      },
    ]);
    // State is Starting — resumeOnExistingVM is fire-and-forget and the mock
    // doesn't advance state; the real function transitions to Running.
    expect(d?.state).toBe(WorkloadState.Starting);
    const events = await eventLog().getWorkloadEvents('restart-job-success');
    expect(events.slice(-2).map((event) => event.state)).toEqual([
      WorkloadState.Recovering,
      WorkloadState.Starting,
    ]);
  });

  it('returns a restarted service from Recovering to Running', async () => {
    await createRunningSpotWorkload('restart-service-success', 'service');

    await runWorkloadReconcileOnce();

    const d = await queries().getWorkload('restart-service-success');
    expect(await queries().getVMs('restart-service-success')).toMatchObject([
      {
        cloudId: 'vm-cloud-id',
        ip: '5.6.7.8',
        sshHost: '5.6.7.8',
        sshPort: 22,
      },
    ]);
    expect(d?.state).toBe(WorkloadState.Running);
    expect(startup.resumeOnExistingVM).not.toHaveBeenCalled();
    const events = await eventLog().getWorkloadEvents(
      'restart-service-success',
    );
    expect(events.slice(-2).map((event) => event.state)).toEqual([
      WorkloadState.Recovering,
      WorkloadState.Running,
    ]);
  });

  it('does not resume a restarted job when termination wins during startVM', async () => {
    await createRunningSpotWorkload('restart-terminated-during-start');
    let finishRestart!: (ip: string | null) => void;
    mockCloud.startVM.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          finishRestart = resolve;
        }),
    );

    const check = runWorkloadReconcileOnce();
    await vi.waitFor(() => expect(mockCloud.startVM).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    const store = queries();
    await outcomes().requestTermination(
      'restart-terminated-during-start',
      scope('test-user'),
    );
    finishRestart('5.6.7.8');
    await check;

    expect(
      (await store.getWorkload('restart-terminated-during-start'))?.state,
    ).toBe(WorkloadState.Terminated);
    expect(startup.resumeOnExistingVM).not.toHaveBeenCalled();
    expect(await store.getVMs('restart-terminated-during-start')).toMatchObject(
      [{ ip: '1.2.3.4', cloudId: 'vm-cloud-id', preempt: 1 }],
    );
  });

  it('keeps the restarting attempt credential and placement when its credential rotates during startVM', async () => {
    const id = 'restart-credential-rotates';
    const credentials = getCredentialSecretStore();
    const recorded = { ...TEST_GCP_CRED, privateKey: 'recorded-private-key' };
    const rotated = { ...TEST_GCP_CRED, privateKey: 'rotated-private-key' };
    const recordedId = await credentials.saveNamedCredential(
      'prod',
      hashCredential(recorded),
      await encryptCredential(recorded),
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
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId: recordedId,
    });
    await walkToState(id, WorkloadState.Provisioning);
    // Backdate so the replacement row cannot collide with this one's key.
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) - 1000;
    await provisionTestVm(
      id,
      {
        ip: '1.2.3.4',
        cloudId: 'vm-cloud-id',
        sshHost: '1.2.3.4',
        sshPort: 22,
      },
      {
        credentialId: recordedId,
        region: 'us-east1',
        availabilityZone: 'us-east1-b',
        vmType: 'n2-standard-8',
      },
    );
    Date.now = realNow;
    await walkToState(id, WorkloadState.Running);
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      makeMockCloudCompute({
        ...mockCloud,
        type: cfg.cloudProvider,
        region: cfg.region ?? '',
      }),
    );
    let finishRestart!: (ip: string | null) => void;
    mockCloud.startVM.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          finishRestart = resolve;
        }),
    );
    // Spy below the logger so its redaction is part of what is checked.
    const logged = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const check = runWorkloadReconcileOnce();
      await vi.waitFor(() => expect(mockCloud.startVM).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      // The named credential rotates to a new id and the recorded one starts
      // failing auth while the restart is pending.
      await credentials.saveNamedCredential(
        'prod',
        hashCredential(rotated),
        await encryptCredential(rotated),
        CloudType.GCP,
      );
      await credentials.markCredentialAuthFailed(recordedId);
      finishRestart('5.6.7.8');
      await check;

      // One gateway, bound from the attempt's recorded facts before the
      // restart, serves it; the replacement row and the resume keep those
      // facts instead of the rotated credential or the workload's region.
      expect(vi.mocked(createComputeProvider).mock.calls).toEqual([
        [
          expect.objectContaining({
            credentials: expect.objectContaining({
              privateKey: 'recorded-private-key',
            }),
            region: 'us-east1',
            availabilityZone: 'us-east1-b',
          }),
          'observed-vm',
        ],
      ]);
      expect(await queries().getVMs(id)).toMatchObject([
        {
          cloudId: 'vm-cloud-id',
          ip: '5.6.7.8',
          credentialId: recordedId,
          region: 'us-east1',
          availabilityZone: 'us-east1-b',
        },
      ]);
      expect(
        await getDB().query(
          'SELECT vm_type FROM vms WHERE workload_id = ? AND ended_at IS NULL',
          [id],
        ),
      ).toEqual([{ vm_type: 'n2-standard-8' }]);
      expect(startup.resumeOnExistingVM).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({
          credentials: expect.objectContaining({
            privateKey: 'recorded-private-key',
          }),
          region: 'us-east1',
          vmType: 'n2-standard-8',
        }),
        expect.objectContaining({ id }),
      );
      const written = JSON.stringify([
        logged.map((spy) => spy.mock.calls),
        await eventLog().getWorkloadEvents(id),
      ]);
      expect(written).not.toContain('recorded-private-key');
      expect(written).not.toContain('rotated-private-key');
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });

  it('refuses a Service upgrade that arrives during startVM and keeps the restarted configuration', async () => {
    const id = 'restart-service-upgrade-during-start';
    await createRunningSpotWorkload(id, 'service');
    const specs = await getDB().query('SELECT * FROM container_specs');
    let finishRestart!: (ip: string | null) => void;
    mockCloud.startVM.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          finishRestart = resolve;
        }),
    );

    const check = runWorkloadReconcileOnce();
    await vi.waitFor(() => expect(mockCloud.startVM).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    await expect(
      lifecycle().beginServiceUpgrade({
        id,
        scope: scope('test-user'),
        image: 'alpine:upgraded',
        previousImage: 'alpine:latest',
        command: ['upgraded'],
        env: { UPGRADED: 'env-canary' },
        githubToken: 'upgrade-token-canary',
        dockerCommand: 'upgraded diagnostic',
      }),
    ).resolves.toBe(false);
    finishRestart('5.6.7.8');
    await check;

    // The in-place restart holds Recovering, so the upgrade is refused rather
    // than applied mid-restart, and the Service resumes on what it read.
    const workload = await queries().getWorkload(id);
    expect(workload).toMatchObject({
      state: WorkloadState.Running,
      image: 'alpine:latest',
      dockerCommand: 'docker run alpine',
    });
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual(specs);
    expect(await queries().getVMs(id)).toMatchObject([
      { cloudId: 'vm-cloud-id', ip: '5.6.7.8' },
    ]);
    const events = JSON.stringify(await eventLog().getWorkloadEvents(id));
    expect(events).not.toContain('serve-upgrade');
    expect(events).not.toContain('upgrade-token-canary');
    expect(events).not.toContain('env-canary');
  });

  it('silently handles resumeOnExistingVM rejection leaving retry pipeline to re-provision', async () => {
    vi.mocked(startup.resumeOnExistingVM).mockRejectedValueOnce(
      new Error('SSH connection failed'),
    );
    await createRunningSpotWorkload('restart-job-fail');

    await runWorkloadReconcileOnce();

    // Error is swallowed by .catch() — state stays Starting.
    // The real resumeOnExistingVM uses runStep which transitions to Retrying on failure.
    const d = await queries().getWorkload('restart-job-fail');
    expect(d?.state).toBe(WorkloadState.Starting);
  });

  it('carries every persisted field onto the restart row (fallback-array deploy)', async () => {
    // Regression: finishPreemptionRecovery writes the newest vms row. If it drops a
    // field it reads back as NULL and misleads downstream — vmType →
    // loadWorkloadConfigs loses the resolved type (fake head returns).
    // Spreading the VM also preserves base-image provenance and its NAT'd SSH
    // endpoint.
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'restart-keeps-vmtype',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: ['totally_fake_nonexistent_vm', 'n2-standard-4'],
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await walkToState('restart-keeps-vmtype', WorkloadState.Provisioning);
    // Backdate so the soft-deleted row's created_at doesn't collide with the
    // restart row. The running VM persisted the real resolved type, concrete
    // base image, and NAT'd SSH endpoint.
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) - 1000;
    await provisionTestVm(
      'restart-keeps-vmtype',
      {
        ip: '1.2.3.4',
        cloudId: 'vm-cloud-id',
        baseImageId: 'base-image-1',
        sshHost: 'gateway.example.com',
        sshPort: 2222,
      },
      { vmType: 'n2-standard-4' },
    );
    Date.now = realNow;
    await walkToState('restart-keeps-vmtype', WorkloadState.Running);

    await runWorkloadReconcileOnce();

    // The newest row (the restart) recovers the real type, not the fake head.
    const latest = await queries().getLatestProvisioningConfig(
      'restart-keeps-vmtype',
    );
    expect(latest?.vmType).toBe('n2-standard-4');
    // …and every other persisted property survived the restart re-insert.
    const [restartRow] = await queries().getVMs('restart-keeps-vmtype');
    expect(restartRow).toMatchObject({
      ip: '5.6.7.8', // the new IP from startVM
      cloudId: 'vm-cloud-id',
      baseImageId: 'base-image-1',
      sshHost: 'gateway.example.com',
      sshPort: 2222,
    });
  });
});

describe('poll reconciliation — preemption during pipeline states', () => {
  let mockCloud: {
    verifyVMPreemption: Mock<(cloudId: string) => Promise<boolean>>;
    startVM: Mock<(cloudId: string) => Promise<string | null>>;
  };

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    mockCloud = {
      verifyVMPreemption: vi
        .fn<(cloudId: string) => Promise<boolean>>()
        .mockResolvedValue(true),
      startVM: vi
        .fn<(cloudId: string) => Promise<string | null>>()
        .mockResolvedValue(null),
    };
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute(mockCloud),
    );
  });

  async function createSpotWorkloadInState(
    id: string,
    state: WorkloadState,
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
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: true,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await provisionTestVm(id, { ip: '1.2.3.4', cloudId: 'vm-cloud-id' });
    await walkToState(id, state);
  }

  // All pipeline states with a live VM should be checked by preemption reconciliation
  const pipelineStates = PREEMPTIBLE_STATES.filter(
    (s) => s !== WorkloadState.Running,
  );

  it.each(pipelineStates)(
    'transitions %s → Recovering without calling startVM',
    async (state) => {
      await createSpotWorkloadInState(`preempt-pipeline-${state}`, state);

      await runWorkloadReconcileOnce();

      expect(mockCloud.startVM).not.toHaveBeenCalled();
      const d = await queries().getWorkload(`preempt-pipeline-${state}`);
      expect(d?.state).toBe(WorkloadState.Recovering);
    },
  );

  it('calls teardownVMs for non-Running preemption', async () => {
    await createSpotWorkloadInState(
      'preempt-init-terminate',
      WorkloadState.Initializing,
    );

    await runWorkloadReconcileOnce();

    expect(termination.teardownVMs).toHaveBeenCalledOnce();
    expect(mockCloud.startVM).not.toHaveBeenCalled();
  });

  it('does not call teardownVMs when CAS fails for non-Running state', async () => {
    await createSpotWorkloadInState(
      'preempt-init-cas-fails',
      WorkloadState.Initializing,
    );

    const store = queries();
    mockCloud.verifyVMPreemption.mockImplementationOnce(async () => {
      await outcomes().requestTermination(
        'preempt-init-cas-fails',
        scope('test-user'),
      );
      return true;
    });

    await runWorkloadReconcileOnce();

    expect(termination.teardownVMs).not.toHaveBeenCalled();
    expect((await store.getVMs('preempt-init-cas-fails'))[0]?.preempt).not.toBe(
      1,
    );
  });

  it('does not pick up Recovering/Retrying workloads for preemption', async () => {
    // These states are already in cleanup, so preemption reconciliation ignores them.
    for (const state of [WorkloadState.Recovering, WorkloadState.Retrying]) {
      await createSpotWorkloadInState(`preempt-skip-${state}`, state);
    }

    await runWorkloadReconcileOnce();

    expect(mockCloud.verifyVMPreemption).not.toHaveBeenCalled();
  });
});
