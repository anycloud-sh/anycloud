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
  getWorkloadLifecycle as lifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  RETRY_JITTER_CAP_MS,
  STUCK_ACTIVE_TIMEOUT_MS,
} from '../../../../src/api/config';
import {
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  vmReleaseUnknown,
} from '../../../../src/api/services/gateways/cloud.js';

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

import { passthroughTimeout } from '../../helpers/monitor-harness';

import {
  runWorkloadReconcileOnce,
  WORKLOAD_RECONCILE_DRAIN_BUDGET_MS,
  resetJobCompletionMonitorStateForTests,
} from '../../../../src/api/services/monitor';
import {
  JOB_COMPLETION_POLL_INTERVAL_MS,
  JOB_UNREACHABLE_RECOVERY_MS,
} from '../../../../src/api/services/workload-workflows/retry-recovery';
import * as startup from '../../../../src/api/services/workload-workflows/vm-host-startup';
import * as completion from '../../../../src/api/services/workload-workflows/completion';
import * as termination from '../../../../src/api/services/host-runtime/termination';
import {
  encryptCredential,
  hashCredential,
  createComputeProvider,
} from '../../../../src/api/services/cloud-config';
import { JOB_CHECK_TIMEOUT_THRESHOLD } from '../../../../src/api/config';
import {
  checkNetworkConnectivity,
  tcpPing,
  withTimeout,
} from '../../../../src/shared/utils';
import {
  TEST_GCP_CRED,
  TEST_LAMBDA_CRED,
  makeMockCloudCompute,
  makeMockVM,
  makeStoredWorkload,
} from '../../helpers/fixtures';
import type { DbVM } from '../../../../src/api/services/entities';
import {
  ConcurrencyMeter,
  measureTickDrainMs,
} from '../../helpers/concurrency-meter';
import {
  drainWorkloadWork,
  hasWorkloadWork,
  trackWorkloadWork,
} from '../../../../src/api/services/workload-work-registry';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { WorkloadQueryStore } from '../../../../src/api/services/repositories/workload-queries.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import {
  reconcileFinalizingJob,
  reconcileRunningJobCompletion,
  type CompletionReconcilePersistence,
} from '../../../../src/api/services/workload-workflows/completion-reconcile';
import { log } from '../../../../src/api/services/logger';
import { Local } from '../../../../src/api/services/gateways/local';
import { createDefaultLocalSmolvmRuntime } from '../../../../src/api/services/gateways/local-smolvm-runtime';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';

const localConfig = {
  cloudProvider: CloudType.Local,
  region: 'local',
  vmType: 'local',
};
const MAX_RECONCILE_IN_FLIGHT = 40;
const RECONCILE_ARM_FLOOR = Math.max(
  1,
  Math.floor(MAX_RECONCILE_IN_FLIGHT / 10),
);

describe('poll reconciliation — job timeout escalation', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  function resetJobCompletionMocks(): void {
    vi.mocked(tcpPing).mockReset();
    vi.mocked(tcpPing).mockResolvedValue(false);
    vi.mocked(checkNetworkConnectivity).mockReset();
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
    vi.mocked(withTimeout).mockReset();
    vi.mocked(withTimeout).mockImplementation(passthroughTimeout);
    vi.mocked(completion.checkJobCompletion).mockReset();
    vi.mocked(completion.checkJobCompletion).mockResolvedValue(undefined);
    vi.mocked(completion.finalizeJobArtifacts).mockReset();
    vi.mocked(completion.finalizeJobArtifacts).mockResolvedValue(undefined);
    vi.mocked(termination.terminateStep).mockReset();
    vi.mocked(termination.terminateStep).mockResolvedValue(undefined);
    vi.mocked(createComputeProvider).mockReset();
    vi.mocked(createComputeProvider).mockReturnValue(makeMockCloudCompute());
  }

  beforeEach(() => {
    vi.useRealTimers();
    resetJobCompletionMonitorStateForTests();
    resetPersistence();
    vi.clearAllMocks();
    resetJobCompletionMocks();
  });

  afterEach(() => {
    resetJobCompletionMonitorStateForTests();
    vi.useRealTimers();
    resetJobCompletionMocks();
  });

  async function createRunningJob(id: string, spot = false) {
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
      spot,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await provisionTestVm(id, { ip: '1.2.3.4', cloudId: 'i-abc123' });
    await walkToState(id, WorkloadState.Running);
  }

  async function createFinalizingJob(id: string) {
    await createRunningJob(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 0,
        maxAttempts: 20,
      },
    });
  }

  async function createTerminalWorkloadWithVM(id: string): Promise<void> {
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
    await provisionTestVm(id, { ip: '10.0.0.1', cloudId: `vm-${id}` });
    await walkToState(id, WorkloadState.Terminated);
  }

  async function createStuckActiveWorkload(id: string): Promise<void> {
    await createRunningJob(id);
    await walkToState(id, WorkloadState.Downloading);
    await getDB().query(
      'UPDATE workload_events SET created_at = ? WHERE workload_id = ?',
      [Date.now() - STUCK_ACTIVE_TIMEOUT_MS - 1000, id],
    );
  }

  it('preserves a cloud-confirmed existing VM after the SSH threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createRunningJob('unreachable-job');
    const store = queries();

    // The cloud confirms the VM is alive, but SSH remains broken.
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_PRESENT),
      }),
    );

    // A count alone is not enough: the full wall-clock duration must elapse.
    for (let i = 0; i < JOB_CHECK_TIMEOUT_THRESHOLD; i++) {
      await runWorkloadReconcileOnce();
      const d = await store.getWorkload('unreachable-job');
      expect(d?.state).toBe(WorkloadState.Running);
      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    }

    // Even well beyond the threshold, positive cloud existence evidence must
    // not turn a saturated guest's SSH failure into destructive recovery.
    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS);
    await runWorkloadReconcileOnce();

    const d = await store.getWorkload('unreachable-job');
    expect(d?.state).toBe(WorkloadState.Running);
    expect(termination.teardownVMs).not.toHaveBeenCalledWith(
      expect.anything(),
      'unreachable-job',
    );
  });

  it('requires a full unknown-status window after cloud existence was confirmed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createRunningJob('alive-then-unknown-job');
    const store = queries();
    const observeVMReleaseOnce = vi
      .fn()
      .mockResolvedValueOnce(VM_PRESENT)
      .mockResolvedValue(vmReleaseUnknown('provider temporarily unavailable'));
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({ observeVMReleaseOnce }),
    );

    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS);
    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('alive-then-unknown-job'))?.state).toBe(
      WorkloadState.Running,
    );

    vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS);
    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('alive-then-unknown-job'))?.state).toBe(
      WorkloadState.Recovering,
    );
  });

  it('recovers immediately when cloud confirms VM is terminated', async () => {
    await createRunningJob('terminated-vm-job');
    const store = queries();

    // The cloud authoritatively reports that the VM is gone.
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
      }),
    );

    // Single cycle should trigger immediate recovery (no threshold wait)
    await runWorkloadReconcileOnce();

    const d = await store.getWorkload('terminated-vm-job');
    expect(d?.state).toBe(WorkloadState.Recovering);
    expect(termination.teardownVMs).toHaveBeenCalledWith(
      expect.anything(),
      'terminated-vm-job',
    );
  });

  it('recovers a Local Job whose smolvm machine stopped', async () => {
    const id = 'stopped-local-job';
    const cloudId = `ac-local-${id}-0`;
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'local-key',
      credentialId: null,
    });
    await provisionTestVm(id, { ip: 'localhost', cloudId, sshPort: 22022 });
    await walkToState(id, WorkloadState.Running);
    const runtime = createDefaultLocalSmolvmRuntime();
    const getMachine = vi
      .spyOn(runtime.client, 'getMachine')
      .mockResolvedValue({ name: cloudId, state: 'stopped' });
    const local = new Local(completeCloudConfig(localConfig), { runtime });
    vi.mocked(createComputeProvider).mockReturnValue(local.compute());

    await runWorkloadReconcileOnce();

    expect(getMachine).toHaveBeenCalledWith(cloudId);
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Recovering,
    );
    expect(termination.teardownVMs).toHaveBeenCalledWith(expect.anything(), id);
  });

  it('requires fresh absence confirmation when a legacy Job fallback credential changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'legacy-job-fallback-scope';
    await createRunningJob(id);
    const store = queries();
    await getDB().query(
      'UPDATE vms SET credential_id = NULL WHERE workload_id = ?',
      [id],
    );
    const firstRead = vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE);
    const nextRead = vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE);
    const policy = {
      requiredReleaseObservations: 2,
      minObservationIntervalMs: 10_000,
    };
    vi.mocked(createComputeProvider)
      .mockReturnValueOnce(
        makeMockCloudCompute({
          observeVMReleaseOnce: firstRead,
          releaseConfirmationPolicy: policy,
        }),
      )
      .mockReturnValue(
        makeMockCloudCompute({
          observeVMReleaseOnce: nextRead,
          releaseConfirmationPolicy: policy,
        }),
      );

    await runWorkloadReconcileOnce();
    expect(firstRead).toHaveBeenCalledOnce();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);

    const replacement = await upsertCredential(
      getDB(),
      'legacy-fallback-replacement',
      await encryptCredential({ ...TEST_GCP_CRED, projectId: 'next-project' }),
      CloudType.GCP,
    );
    await getDB().query('UPDATE workloads SET credential_id = ? WHERE id = ?', [
      replacement,
      id,
    ]);
    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();

    expect(nextRead).toHaveBeenCalledOnce();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    expect((await store.getVMs(id))[0]?.credentialId).toBeUndefined();

    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();
    expect(nextRead).toHaveBeenCalledTimes(2);
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Recovering);
  });

  it('keeps provider failures unknown and records that evidence on fallback recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createRunningJob('unknown-cloud-job');
    const store = queries();
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce: vi
          .fn()
          .mockResolvedValue(vmReleaseUnknown('provider unavailable')),
      }),
    );

    await runWorkloadReconcileOnce();
    expect((await store.getWorkload('unknown-cloud-job'))?.state).toBe(
      WorkloadState.Running,
    );

    vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS);
    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('unknown-cloud-job'))?.state).toBe(
      WorkloadState.Recovering,
    );
    const events = await eventLog().getWorkloadEvents('unknown-cloud-job');
    expect(events.at(-1)?.metadata).toContain(
      'cloud status unknown: provider unavailable',
    );
  });

  it('treats gateway construction failures as unknown instead of skipping fallback tracking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createRunningJob('gateway-construction-job');
    const store = queries();
    vi.mocked(createComputeProvider).mockImplementation(() => {
      throw new Error('gateway construction failed');
    });

    await runWorkloadReconcileOnce();
    expect((await store.getWorkload('gateway-construction-job'))?.state).toBe(
      WorkloadState.Running,
    );

    vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS);
    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('gateway-construction-job'))?.state).toBe(
      WorkloadState.Recovering,
    );
    const events = await eventLog().getWorkloadEvents(
      'gateway-construction-job',
    );
    expect(events.at(-1)?.metadata).toContain(
      'cloud status unknown: gateway construction failed',
    );
  });

  it('reuses a timed-out in-flight read and consumes a late termination result', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createRunningJob('late-termination-job');
    const store = queries();
    let resolveStatus!: (status: typeof VM_RELEASE_CANDIDATE) => void;
    const observeVMReleaseOnce = vi.fn(
      () =>
        new Promise<typeof VM_RELEASE_CANDIDATE>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({ observeVMReleaseOnce }),
    );
    vi.mocked(withTimeout)
      .mockRejectedValueOnce(new Error('status read timed out'))
      .mockRejectedValueOnce(new Error('status read timed out'));

    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();

    expect(observeVMReleaseOnce).toHaveBeenCalledOnce();
    expect(createComputeProvider).toHaveBeenCalledOnce();
    expect((await store.getWorkload('late-termination-job'))?.state).toBe(
      WorkloadState.Running,
    );

    resolveStatus(VM_RELEASE_CANDIDATE);
    await vi.waitFor(() => expect(observeVMReleaseOnce).toHaveBeenCalledOnce());
    await Promise.resolve();

    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();

    expect((await store.getWorkload('late-termination-job'))?.state).toBe(
      WorkloadState.Recovering,
    );
    expect(observeVMReleaseOnce).toHaveBeenCalledOnce();
  });

  it('does not recover finalizing jobs when SSH is unreachable', async () => {
    await createFinalizingJob('finalizing-unreachable-job');
    const store = queries();

    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
      }),
    );

    for (let i = 0; i < JOB_CHECK_TIMEOUT_THRESHOLD + 1; i++) {
      await runWorkloadReconcileOnce();
    }

    const d = await store.getWorkload('finalizing-unreachable-job');
    expect(d?.state).toBe(WorkloadState.Finalizing);
    expect(termination.teardownVMs).not.toHaveBeenCalledWith(
      expect.anything(),
      'finalizing-unreachable-job',
    );
  });

  it('runs finalizing jobs through the finalization monitor', async () => {
    await createFinalizingJob('finalization-monitor-job');

    await runWorkloadReconcileOnce();

    expect(completion.finalizeJobArtifacts).toHaveBeenCalledWith(
      expect.anything(),
      'finalization-monitor-job',
      'test-ssh-key',
      expect.anything(),
    );
  });

  it('does not record finalization monitor failures as workload events', async () => {
    await createFinalizingJob('finalization-diagnostic-job');
    const beforeEvents = await eventLog().getWorkloadEvents(
      'finalization-diagnostic-job',
    );
    vi.mocked(completion.finalizeJobArtifacts).mockRejectedValueOnce(
      Object.assign(new Error('rclone failed'), {
        name: 'DetachedRunError',
        exitCode: 1,
        logTail: 'rclone: Failed to copy: permission denied',
      }),
    );

    await runWorkloadReconcileOnce();

    const afterEvents = await eventLog().getWorkloadEvents(
      'finalization-diagnostic-job',
    );
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  it('runs finalizing jobs through the unified workload reconciler', async () => {
    await createFinalizingJob('workload-reconcile-finalization-job');

    await runWorkloadReconcileOnce();

    expect(completion.finalizeJobArtifacts).toHaveBeenCalledWith(
      expect.anything(),
      'workload-reconcile-finalization-job',
      'test-ssh-key',
      expect.anything(),
    );
  });

  it('checks running jobs through the unified workload reconciler', async () => {
    await createRunningJob('workload-reconcile-running-job');
    vi.mocked(tcpPing).mockResolvedValueOnce(true);

    await runWorkloadReconcileOnce();

    expect(completion.checkJobCompletion).toHaveBeenCalledWith(
      expect.anything(),
      'workload-reconcile-running-job',
      'test-ssh-key',
      expect.anything(),
    );
  });

  it('coalesces and briefly caches the shared network probe', async () => {
    for (let index = 0; index < 8; index += 1) {
      await createRunningJob(`workload-reconcile-network-${index}`);
    }
    vi.mocked(tcpPing).mockResolvedValue(true);

    await runWorkloadReconcileOnce();
    await runWorkloadReconcileOnce();

    expect(checkNetworkConnectivity).toHaveBeenCalledTimes(1);
  });

  it('runs preemption before completion for spot running jobs in the unified reconciler', async () => {
    const compute = makeMockCloudCompute({
      verifyVMPreemption: vi
        .fn<(cloudId: string) => Promise<boolean>>()
        .mockResolvedValue(false),
    });
    vi.mocked(createComputeProvider).mockReturnValue(compute);
    await createRunningJob('workload-reconcile-spot-running-job', true);
    vi.mocked(tcpPing).mockResolvedValueOnce(true);

    await runWorkloadReconcileOnce();

    expect(compute.verifyVMPreemption).toHaveBeenCalledWith('i-abc123');
    expect(completion.checkJobCompletion).toHaveBeenCalledWith(
      expect.anything(),
      'workload-reconcile-spot-running-job',
      'test-ssh-key',
      expect.anything(),
    );
  });

  it('skips completion when spot preemption transitions the running job', async () => {
    const compute = makeMockCloudCompute({
      verifyVMPreemption: vi
        .fn<(cloudId: string) => Promise<boolean>>()
        .mockResolvedValue(true),
      startVM: vi
        .fn<(cloudId: string) => Promise<string | null>>()
        .mockResolvedValue(null),
    });
    vi.mocked(createComputeProvider).mockReturnValue(compute);
    await createRunningJob('workload-reconcile-preempted-running-job', true);
    vi.mocked(tcpPing).mockResolvedValueOnce(true);

    await runWorkloadReconcileOnce();

    expect(
      (await queries().getWorkload('workload-reconcile-preempted-running-job'))
        ?.state,
    ).toBe(WorkloadState.Recovering);
    expect(completion.checkJobCompletion).not.toHaveBeenCalled();
  });

  describe('an on-demand Job whose cloud stopped its VM', () => {
    function stoppedCloud(startVM: () => Promise<string | null>) {
      const compute = makeMockCloudCompute({
        verifyVMPreemption: vi.fn().mockResolvedValue(true),
        startVM: vi.fn(startVM),
      });
      vi.mocked(createComputeProvider).mockReturnValue(compute);
      return compute;
    }

    it('starts it in place and resumes the Job on the new IP', async () => {
      const id = 'on-demand-job-stopped';
      await createRunningJob(id);
      const compute = stoppedCloud(async () => '5.6.7.8');

      await runWorkloadReconcileOnce();

      expect(compute.startVM).toHaveBeenCalledWith('i-abc123');
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Starting,
      );
      expect(await queries().getVMs(id)).toMatchObject([
        { cloudId: 'i-abc123', ip: '5.6.7.8' },
      ]);
      await vi.waitFor(() =>
        expect(startup.resumeOnExistingVM).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ id }),
        ),
      );
      expect(termination.teardownVMs).not.toHaveBeenCalled();
    });

    it('hands it to the retry pipeline, as a spot Job, when the start fails', async () => {
      const id = 'on-demand-job-stopped-no-capacity';
      await createRunningJob(id);
      stoppedCloud(async () => null);

      await runWorkloadReconcileOnce();

      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Recovering,
      );
      expect(termination.teardownVMs).toHaveBeenCalledWith(
        expect.anything(),
        id,
      );
    });

    it('never reads a reachable Job host from its cloud', async () => {
      const id = 'on-demand-job-reachable';
      await createRunningJob(id);
      const compute = stoppedCloud(async () => '5.6.7.8');
      vi.mocked(tcpPing).mockResolvedValue(true);

      await runWorkloadReconcileOnce();

      expect(compute.verifyVMPreemption).not.toHaveBeenCalled();
      expect(compute.startVM).not.toHaveBeenCalled();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );
    });
  });

  it('runs retry candidates through the unified workload reconciler', async () => {
    await createRunningJob('workload-reconcile-retry');
    const retryTs = Date.now() - RETRY_JITTER_CAP_MS - 1_000;
    await walkToState('workload-reconcile-retry', WorkloadState.Retrying);
    await getDB().query(
      `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
      [retryTs, 'workload-reconcile-retry', WorkloadState.Retrying],
    );

    await runWorkloadReconcileOnce();

    expect(
      (await queries().getWorkload('workload-reconcile-retry'))?.state,
    ).toBe(WorkloadState.Queued);
  });

  it('schedules retry candidates by event backoff when they are not ready yet', async () => {
    await createRunningJob('workload-reconcile-retry-too-soon');
    await walkToState(
      'workload-reconcile-retry-too-soon',
      WorkloadState.Retrying,
    );

    const status = await runWorkloadReconcileOnce();

    expect(
      (await queries().getWorkload('workload-reconcile-retry-too-soon'))?.state,
    ).toBe(WorkloadState.Retrying);
    expect(status.processedCount).toBe(1);
  });

  it('runs terminal cleanup through the unified workload reconciler', async () => {
    await createTerminalWorkloadWithVM('workload-reconcile-cleanup');

    await runWorkloadReconcileOnce();

    expect(termination.terminateStep).toHaveBeenCalledWith(
      expect.anything(),
      'workload-reconcile-cleanup',
    );
  });

  it('replays timed-out active workloads through the unified workload reconciler', async () => {
    await createStuckActiveWorkload('workload-reconcile-stuck');

    await runWorkloadReconcileOnce();

    expect(startup.deploy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'workload-reconcile-stuck' }),
      expect.any(String),
      {
        resumeFrom: WorkloadState.Downloading,
        replayActiveStep: true,
      },
    );
    expect(
      (await queries().getWorkload('workload-reconcile-stuck'))?.state,
    ).toBe(WorkloadState.Downloading);
  });

  it('recovers orphaned spot pipeline rows even when the spot/running claim fills K', async () => {
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        verifyVMPreemption: vi
          .fn<(cloudId: string) => Promise<boolean>>()
          .mockResolvedValue(false),
      }),
    );

    for (let i = 0; i < MAX_RECONCILE_IN_FLIGHT; i++) {
      const id = `workload-reconcile-spot-orphan-${i}`;
      await createRunningJob(id, true);
      await walkToState(id, WorkloadState.Downloading);
      await getDB().query(
        'UPDATE workload_events SET created_at = ? WHERE workload_id = ?',
        [Date.now() - STUCK_ACTIVE_TIMEOUT_MS - 1000, id],
      );
    }

    await runWorkloadReconcileOnce();

    const workloads = await Promise.all(
      Array.from({ length: MAX_RECONCILE_IN_FLIGHT }, (_, i) =>
        queries().getWorkload(`workload-reconcile-spot-orphan-${i}`),
      ),
    );
    expect(
      workloads.filter((d) => d?.state === WorkloadState.Downloading),
    ).toHaveLength(MAX_RECONCILE_IN_FLIGHT);
    expect(startup.deploy).toHaveBeenCalledTimes(MAX_RECONCILE_IN_FLIGHT);
  });

  it('bounds unified reconcile work to one aggregate in-flight K while draining pages', async () => {
    const meter = new ConcurrencyMeter();
    vi.mocked(completion.finalizeJobArtifacts).mockImplementation(
      meter.track('finalizeJobArtifacts', async () => {}),
    );
    vi.mocked(termination.terminateStep).mockImplementation(
      meter.track('terminateStep', async () => {}),
    );

    const finalizingCount = Math.floor(MAX_RECONCILE_IN_FLIGHT / 4);
    const cleanupCount = Math.floor(MAX_RECONCILE_IN_FLIGHT / 4);
    const stuckClaimed =
      MAX_RECONCILE_IN_FLIGHT - finalizingCount - cleanupCount;
    const stuckCount = stuckClaimed + 5;
    for (let i = 0; i < finalizingCount; i++) {
      await createFinalizingJob(`reconcile-bound-${i}`);
    }
    for (let i = 0; i < cleanupCount; i++) {
      await createTerminalWorkloadWithVM(`reconcile-cleanup-bound-${i}`);
    }
    for (let i = 0; i < stuckCount; i++) {
      await createStuckActiveWorkload(`reconcile-stuck-bound-${i}`);
    }

    const status = await runWorkloadReconcileOnce();

    expect(completion.finalizeJobArtifacts).toHaveBeenCalledTimes(
      finalizingCount,
    );
    expect(termination.terminateStep).toHaveBeenCalledTimes(cleanupCount);
    const stuckStates = await Promise.all(
      Array.from({ length: stuckCount }, (_, i) =>
        queries().getWorkload(`reconcile-stuck-bound-${i}`),
      ),
    );
    expect(
      stuckStates.filter((d) => d?.state === WorkloadState.Downloading),
    ).toHaveLength(stuckCount);
    expect(startup.deploy).toHaveBeenCalledTimes(stuckCount);
    expect(status.processedCount).toBe(
      finalizingCount + cleanupCount + stuckCount,
    );
    expect(meter.peakTotal()).toBeLessThanOrEqual(MAX_RECONCILE_IN_FLIGHT);
  });

  it('reserves low-volume reconcile arms when running jobs saturate the drain budget', async () => {
    const meter = new ConcurrencyMeter();
    const runningMs = WORKLOAD_RECONCILE_DRAIN_BUDGET_MS / 2;
    const runningCount = MAX_RECONCILE_IN_FLIGHT * 3;
    const lowVolumeIds = Array.from(
      { length: RECONCILE_ARM_FLOOR },
      (_, i) => i,
    );

    vi.mocked(completion.checkJobCompletion).mockImplementation(
      meter.track('checkJobCompletion', async () => {
        await new Promise((resolve) => setTimeout(resolve, runningMs));
      }),
    );
    vi.mocked(completion.finalizeJobArtifacts).mockImplementation(
      meter.track('finalizeJobArtifacts', async () => {}),
    );
    vi.mocked(termination.terminateStep).mockImplementation(
      meter.track('terminateStep', async () => {}),
    );
    vi.mocked(tcpPing).mockResolvedValue(true);

    for (let i = 0; i < runningCount; i++) {
      await createRunningJob(`fair-running-${i}`);
    }
    for (const i of lowVolumeIds) {
      const retryId = `fair-retry-${i}`;
      await createRunningJob(retryId);
      await walkToState(retryId, WorkloadState.Retrying);
      await getDB().query(
        `UPDATE workload_events SET created_at = ? WHERE workload_id = ? AND state = ?`,
        [
          Date.now() - RETRY_JITTER_CAP_MS - 1_000,
          retryId,
          WorkloadState.Retrying,
        ],
      );
      await createFinalizingJob(`fair-finalizing-${i}`);
      await createTerminalWorkloadWithVM(`fair-cleanup-${i}`);
      await createStuckActiveWorkload(`fair-stuck-${i}`);
    }

    let status: Awaited<ReturnType<typeof runWorkloadReconcileOnce>>;
    await measureTickDrainMs(async () => {
      status = await runWorkloadReconcileOnce();
    });

    expect(status!.hitDrainBudget).toBe(true);
    expect(status!.remainingDueCount).toBeGreaterThan(0);
    expect(meter.count('checkJobCompletion')).toBeLessThan(runningCount);
    expect(completion.finalizeJobArtifacts).toHaveBeenCalledTimes(
      RECONCILE_ARM_FLOOR,
    );
    expect(termination.terminateStep).toHaveBeenCalledTimes(
      RECONCILE_ARM_FLOOR,
    );
    expect(meter.peakTotal()).toBeLessThanOrEqual(MAX_RECONCILE_IN_FLIGHT);

    const retryStates = await Promise.all(
      lowVolumeIds.map((i) => queries().getWorkload(`fair-retry-${i}`)),
    );
    const stuckStates = await Promise.all(
      lowVolumeIds.map((i) => queries().getWorkload(`fair-stuck-${i}`)),
    );
    expect(retryStates.every((d) => d?.state === WorkloadState.Queued)).toBe(
      true,
    );
    expect(
      stuckStates.every((d) => d?.state === WorkloadState.Downloading),
    ).toBe(true);
  });

  it('isolates a poison row and continues the rest of the reconcile page', async () => {
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        verifyVMPreemption: vi
          .fn<(cloudId: string) => Promise<boolean>>()
          .mockResolvedValue(false),
      }),
    );

    await createRunningJob('workload-reconcile-poison', true);
    await walkToState('workload-reconcile-poison', WorkloadState.Downloading);
    await createStuckActiveWorkload('workload-reconcile-healthy');

    const originalGetWorkload = WorkloadQueryStore.prototype.getWorkload;
    const spy = vi
      .spyOn(WorkloadQueryStore.prototype, 'getWorkload')
      .mockImplementation(function (this: WorkloadQueryStore, id) {
        if (id === 'workload-reconcile-poison') {
          throw new Error('poison row');
        }
        return originalGetWorkload.call(this, id);
      });

    try {
      const status = await runWorkloadReconcileOnce();

      expect(status.failed).toBe(false);
      expect(status.processedCount).toBe(2);
      expect(status.failureCount).toBe(1);
      expect(
        (await queries().getWorkload('workload-reconcile-healthy'))?.state,
      ).toBe(WorkloadState.Downloading);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns failed status when controller discovery fails', async () => {
    const spy = vi
      .spyOn(WorkloadQueryStore.prototype, 'listWorkloadReconcileCandidates')
      .mockRejectedValueOnce(new Error('db unavailable'));

    try {
      const status = await runWorkloadReconcileOnce();

      expect(status.failed).toBe(true);
      expect(status.processedCount).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not start duplicate finalization while one is in flight', async () => {
    await createFinalizingJob('finalization-in-flight-job');
    let resolveFinalize!: () => void;
    vi.mocked(completion.finalizeJobArtifacts).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFinalize = resolve;
      }),
    );

    const firstRun = runWorkloadReconcileOnce();
    for (let i = 0; i < 10; i++) {
      if (vi.mocked(completion.finalizeJobArtifacts).mock.calls.length > 0)
        break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // The standalone helper sees the row again; the process-local in-flight
    // guard prevents a duplicate finalization.
    await runWorkloadReconcileOnce();

    expect(completion.finalizeJobArtifacts).toHaveBeenCalledTimes(1);
    resolveFinalize();
    await firstRun;
  });

  it('keeps terminal cleanup serialized while finalization is in flight', async () => {
    const id = 'finalization-cleanup-fence-job';
    const store = queries();
    await createFinalizingJob(id);

    let resolveFinalize!: () => void;
    const finalizationGate = new Promise<void>((resolve) => {
      resolveFinalize = resolve;
    });
    vi.mocked(completion.finalizeJobArtifacts).mockImplementationOnce(
      async () => {
        await outcomes().publishTerminalOutcome(
          id,
          WorkloadState.Completed,
          WorkloadState.Finalizing,
          { metadata: { workloadExitCode: 0, finalSyncAttempts: 1 } },
        );
        await finalizationGate;
      },
    );

    const firstRun = runWorkloadReconcileOnce();
    try {
      await vi.waitFor(async () => {
        expect((await store.getWorkload(id))?.state).toBe(
          WorkloadState.Completed,
        );
      });

      expect(hasWorkloadWork(id)).toBe(true);

      await runWorkloadReconcileOnce();

      expect(termination.terminateStep).not.toHaveBeenCalled();

      resolveFinalize();
      await firstRun;
      await drainWorkloadWork(id);

      expect(hasWorkloadWork(id)).toBe(false);

      await runWorkloadReconcileOnce();

      expect(termination.terminateStep).toHaveBeenCalledOnce();
    } finally {
      resolveFinalize();
      await Promise.allSettled([firstRun]);
      await drainWorkloadWork(id);
    }
  });

  it('allows a later finalization tick to retry after a rejection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createFinalizingJob('finalization-retry-job');
    vi.mocked(completion.finalizeJobArtifacts)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();

    expect(completion.finalizeJobArtifacts).toHaveBeenCalledTimes(2);
  });

  it('skips finalizing jobs when the API network is down', async () => {
    await createFinalizingJob('finalization-netdown-job');
    vi.mocked(checkNetworkConnectivity).mockResolvedValueOnce(false);

    await runWorkloadReconcileOnce();

    expect(completion.finalizeJobArtifacts).not.toHaveBeenCalled();
  });

  it('resets the unreachable duration when a check succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await createRunningJob('flaky-job');
    const store = queries();

    // The cloud confirms that the VM remains alive.
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_PRESENT),
      }),
    );

    // Almost hit threshold
    for (let i = 0; i < JOB_CHECK_TIMEOUT_THRESHOLD - 2; i++) {
      await runWorkloadReconcileOnce();
      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    }

    // One successful check resets the counter
    vi.mocked(tcpPing).mockResolvedValueOnce(true);
    vi.mocked(completion.checkJobCompletion).mockResolvedValueOnce(undefined);
    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);

    // threshold-1 more timeouts — should NOT escalate (counter was reset)
    vi.mocked(completion.checkJobCompletion).mockRejectedValue(
      new Error('SSH connection timed out'),
    );
    for (let i = 0; i < JOB_CHECK_TIMEOUT_THRESHOLD - 1; i++) {
      await runWorkloadReconcileOnce();
      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    }

    const d = await store.getWorkload('flaky-job');
    expect(d?.state).toBe(WorkloadState.Running);
  });

  describe('direct Running Job completion', () => {
    const liveVm: DbVM = {
      ...makeMockVM(),
      createdAt: 0,
      preempt: 0,
      endedAt: null,
      inputHostPath: '',
      outputHostPath: '',
      checkpointHostPath: '',
    };
    const localJob = () =>
      makeStoredWorkload({
        cloudProvider: CloudType.Local,
        credentialId: null,
      });

    function deps(vms: DbVM[] | Error): CompletionReconcilePersistence {
      const getVMs = vi.spyOn(queries(), 'getVMs');
      if (vms instanceof Error) getVMs.mockRejectedValue(vms);
      else getVMs.mockResolvedValue(vms);
      return {
        store: queries(),
        lifecycle: lifecycle(),
        outcomes: outcomes(),
        events: eventLog(),
        resume: { resumeOnExistingVM: vi.fn() },
      };
    }

    it('skips completion checks without credentials', async () => {
      const error = vi.spyOn(log, 'error');
      const job = makeStoredWorkload({ credentialId: null });

      await reconcileRunningJobCompletion(deps([liveVm]), job);

      expect(termination.teardownVMs).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('skips the SSH probe for a Job without an SSH key', async () => {
      const job = localJob();

      await reconcileRunningJobCompletion(deps([liveVm]), job);

      expect(tcpPing).not.toHaveBeenCalled();
      expect(createComputeProvider).not.toHaveBeenCalled();
    });

    it('fails a Finalizing Job that has no resolved provider', async () => {
      const job = makeStoredWorkload({
        cloudProvider: null,
        credentialId: null,
      });
      const publish = vi
        .spyOn(outcomes(), 'publishTerminalOutcome')
        .mockResolvedValue(true);

      expect(await reconcileFinalizingJob(deps([]), job)).toEqual({
        disposition: 'completed',
      });

      expect(publish).toHaveBeenCalledWith(
        job.id,
        WorkloadState.Failed,
        WorkloadState.Finalizing,
        {
          metadata: {
            reason:
              'Job reached VM-host-only Finalizing without a resolved provider',
          },
        },
      );
    });

    it('waits for a previous poll that outlived its timeout instead of polling again', async () => {
      await createRunningJob('overlapping-poll-job');
      const job = (await queries().getWorkload('overlapping-poll-job'))!;
      let finishPoll!: () => void;
      const previousPoll = new Promise<void>((resolve) => {
        finishPoll = resolve;
      });
      trackWorkloadWork(job.id, previousPoll);
      vi.mocked(tcpPing).mockResolvedValue(true);

      await reconcileRunningJobCompletion(deps([liveVm]), job);

      expect(completion.checkJobCompletion).not.toHaveBeenCalled();
      finishPoll();
      await drainWorkloadWork(job.id);
      await reconcileRunningJobCompletion(deps([liveVm]), job);
      expect(completion.checkJobCompletion).toHaveBeenCalledTimes(1);
      await drainWorkloadWork(job.id);
    });

    it('logs instead of throwing when the VM read fails', async () => {
      const error = vi.spyOn(log, 'error');
      const job = makeStoredWorkload();
      const failure = new Error('database unavailable');

      await expect(
        reconcileRunningJobCompletion(deps(failure), job),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith('Error checking job completion', {
        id: job.id,
        error: failure,
      });
    });
  });
});
