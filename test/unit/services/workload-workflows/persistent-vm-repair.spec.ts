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
  getWorkloadEventStore as eventLog,
  getWorkloadLifecycle as lifecycle,
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
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  vmReleaseUnknown,
} from '../../../../src/api/services/gateways/cloud.js';

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
  runWorkloadReconcileOnce,
  resetJobCompletionMonitorStateForTests,
} from '../../../../src/api/services/monitor';
import {
  VM_HOST_MISSING_REASON,
  reconcileRunningVm,
} from '../../../../src/api/services/workload-workflows/persistent-vm-repair';
import { log } from '../../../../src/api/services/logger';
import {
  JOB_COMPLETION_POLL_INTERVAL_MS,
  JOB_UNREACHABLE_RECOVERY_MS,
} from '../../../../src/api/services/workload-workflows/retry-recovery';
import * as containerRepair from '../../../../src/api/services/host-runtime/vm-container-repair';
import type { RunningVmContainerReconcileResult } from '../../../../src/api/services/host-runtime/vm-container-repair';
import { ContainerState } from '../../../../src/shared/runtime.js';
import * as startup from '../../../../src/api/services/workload-workflows/vm-host-startup';
import * as completion from '../../../../src/api/services/workload-workflows/completion';
import * as termination from '../../../../src/api/services/host-runtime/termination';
import {
  encryptCredential,
  hashCredential,
  createComputeProvider,
} from '../../../../src/api/services/cloud-config';
import {
  checkNetworkConnectivity,
  tcpPing,
} from '../../../../src/shared/utils';
import { TEST_GCP_CRED, makeMockCloudCompute } from '../../helpers/fixtures';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import {
  STOPPED_VM_RESTART_BACKOFF_MS,
  VM_STOPPED_RESTARTED_REASON,
  VM_STOPPED_WAITING_REASON,
  resetStoppedVmRestartsForTests,
} from '../../../../src/api/services/workload-workflows/stopped-vm-restart';

const Exited = ContainerState.Exited;

describe('persistent VM repair reconciliation', () => {
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
    vi.mocked(containerRepair.reconcileRunningVmContainer).mockReset();
    vi.mocked(containerRepair.reconcileRunningVmContainer).mockResolvedValue({
      outcome: 'healthy',
    });
    resetJobCompletionMonitorStateForTests();
    resetStoppedVmRestartsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createRunningPersistentVm(id: string) {
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      await encryptCredential(TEST_GCP_CRED),
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: WorkloadType.Vm,
      image: 'ghcr.io/acme/dev:test',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'docker run vm',
      sshPrivateKey: 'test-key',
      credentialId,
    });
    await provisionTestVm(
      id,
      {
        ip: '1.2.3.4',
        cloudId: `cloud-${id}`,
        availabilityZone: 'us-central1-a',
      },
      {
        region: 'us-central1',
        vmType: 'n2-standard-4',
        credentialId,
      },
    );
    await walkToState(id, WorkloadState.Running);
    return { store: queries(), cloudId: `cloud-${id}` };
  }

  it('polls a Running VM through repair without entering Job completion', async () => {
    const id = 'running-vm-repair-poll';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: WorkloadType.Vm,
      image: 'ghcr.io/acme/dev:test',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      dockerCommand: 'docker run vm',
      sshPrivateKey: 'test-key',
      credentialId: null,
    });
    await provisionTestVm(id, {
      ip: '1.2.3.4',
      cloudId: 'running-vm-host',
    });
    await walkToState(id, WorkloadState.Running);
    vi.mocked(tcpPing).mockResolvedValue(true);

    await runWorkloadReconcileOnce();

    expect(containerRepair.reconcileRunningVmContainer).toHaveBeenCalledWith(
      id,
    );
    expect(completion.checkJobCompletion).not.toHaveBeenCalled();
    expect(completion.finalizeJobArtifacts).not.toHaveBeenCalled();
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Running,
    );
    // A reachable VM is never read from its cloud.
    expect(createComputeProvider).not.toHaveBeenCalled();
  });

  describe('a VM its cloud stopped', () => {
    const NEW_IP = '5.6.7.8';
    function stoppedCloud(startVM: () => Promise<string | null>) {
      const compute = makeMockCloudCompute({
        verifyVMPreemption: vi.fn().mockResolvedValue(true),
        startVM: vi.fn(startVM),
      });
      vi.mocked(createComputeProvider).mockReturnValue(compute);
      return compute;
    }
    const reasons = async (id: string) =>
      (await eventLog().getWorkloadEvents(id)).map(
        (event) => JSON.parse(event.metadata ?? '{}').reason,
      );

    it('starts it in place, records the new IP and repairs its container over it', async () => {
      const id = 'stopped-vm-restarted';
      const { store, cloudId } = await createRunningPersistentVm(id);
      const compute = stoppedCloud(async () => NEW_IP);

      await runWorkloadReconcileOnce();

      expect(compute.startVM).toHaveBeenCalledWith(cloudId);
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
      const live = await store.getVMs(id);
      expect(live).toMatchObject([{ cloudId, ip: NEW_IP, sshHost: NEW_IP }]);
      expect(await store.listVms(id)).toHaveLength(2);
      expect(await reasons(id)).toContain(VM_STOPPED_RESTARTED_REASON);
      expect(termination.teardownVMs).not.toHaveBeenCalled();
      expect(startup.deploy).not.toHaveBeenCalled();

      // The next poll reaches the new address and repairs the container there.
      vi.mocked(tcpPing).mockResolvedValue(true);
      await runWorkloadReconcileOnce();
      expect(tcpPing).toHaveBeenLastCalledWith(NEW_IP, 22, 5000);
      expect(containerRepair.reconcileRunningVmContainer).toHaveBeenCalledWith(
        id,
      );
    });

    it('keeps the VM and its disk while a start fails, retrying in place with backoff', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const id = 'stopped-vm-no-capacity';
      const { store, cloudId } = await createRunningPersistentVm(id);
      const [original] = await store.getVMs(id);
      let capacity = false;
      const compute = stoppedCloud(async () => (capacity ? NEW_IP : null));

      await runWorkloadReconcileOnce();
      await runWorkloadReconcileOnce();
      vi.setSystemTime(Date.now() + STOPPED_VM_RESTART_BACKOFF_MS.first);
      await runWorkloadReconcileOnce();

      expect(compute.startVM).toHaveBeenCalledTimes(2);
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
      expect(await store.listVms(id)).toEqual([original]);
      expect(
        (await reasons(id)).filter((r) => r === VM_STOPPED_WAITING_REASON),
      ).toHaveLength(1);
      expect(termination.teardownVMs).not.toHaveBeenCalled();
      expect(termination.terminateStep).not.toHaveBeenCalled();
      expect(startup.deploy).not.toHaveBeenCalled();

      capacity = true;
      vi.setSystemTime(Date.now() + STOPPED_VM_RESTART_BACKOFF_MS.first * 2);
      await runWorkloadReconcileOnce();

      expect(await store.getVMs(id)).toMatchObject([{ cloudId, ip: NEW_IP }]);
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    });

    it('records the address of a start that completed after its deadline', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const id = 'stopped-vm-late-start';
      const { store, cloudId } = await createRunningPersistentVm(id);
      const compute = stoppedCloud(async () => null);

      await runWorkloadReconcileOnce();
      // The cloud finished that start late: the VM now runs at a new address.
      vi.spyOn(compute, 'observeStoppedVm').mockResolvedValue(false);
      vi.mocked(compute.startVM).mockResolvedValue(NEW_IP);
      vi.setSystemTime(Date.now() + STOPPED_VM_RESTART_BACKOFF_MS.first);
      await runWorkloadReconcileOnce();

      expect(await store.getVMs(id)).toMatchObject([{ cloudId, ip: NEW_IP }]);
    });

    it('backs off afresh after the host answered between two stops', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const id = 'stopped-vm-stopped-again';
      await createRunningPersistentVm(id);
      const compute = stoppedCloud(async () => null);

      await runWorkloadReconcileOnce();
      vi.mocked(tcpPing).mockResolvedValue(true);
      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
      await runWorkloadReconcileOnce();
      vi.mocked(tcpPing).mockResolvedValue(false);
      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
      await runWorkloadReconcileOnce();

      expect(compute.startVM).toHaveBeenCalledTimes(2);
      expect(
        (await reasons(id)).filter((r) => r === VM_STOPPED_WAITING_REASON),
      ).toHaveLength(2);
    });

    it("doesn't carry a failed start's backoff to the workload's next VM", async () => {
      const id = 'stopped-vm-next-vm';
      await createRunningPersistentVm(id);
      const compute = stoppedCloud(async () => null);

      await repair(id);
      await getDB().query(
        `UPDATE vms SET cloud_id = 'cloud-next-vm' WHERE workload_id = ?`,
        [id],
      );
      await repair(id);

      expect(compute.startVM).toHaveBeenCalledTimes(2);
      expect(
        (await reasons(id)).filter((r) => r === VM_STOPPED_WAITING_REASON),
      ).toHaveLength(2);
    });

    it('keeps the old address when the workload is terminated during the start', async () => {
      const id = 'stopped-vm-terminated-mid-start';
      const { store, cloudId } = await createRunningPersistentVm(id);
      stoppedCloud(async () => {
        await walkToState(id, WorkloadState.Terminated);
        return NEW_IP;
      });

      expect((await repair(id)).disposition).toBe('stale');
      expect(await store.listVms(id)).toMatchObject([
        { cloudId, ip: '1.2.3.4' },
      ]);
    });

    it('does not overwrite a VM row that changed during the start', async () => {
      const id = 'stopped-vm-row-changed';
      const { store, cloudId } = await createRunningPersistentVm(id);
      stoppedCloud(async () => {
        await lifecycle().restartVMInPlace(
          id,
          WorkloadState.Running,
          { cloudId, ip: '1.2.3.4' },
          { vm: { cloudId, ip: '9.9.9.9' }, attempt: {} },
          'another restart',
        );
        return NEW_IP;
      });

      expect((await repair(id)).disposition).toBe('stale');
      expect(await store.getVMs(id)).toMatchObject([
        { cloudId, ip: '9.9.9.9' },
      ]);
    });

    it('does not start a VM whose workload was terminated', async () => {
      const id = 'stopped-vm-terminated';
      const { store } = await createRunningPersistentVm(id);
      const compute = stoppedCloud(async () => NEW_IP);
      await walkToState(id, WorkloadState.Terminated);

      await runWorkloadReconcileOnce();

      expect(compute.startVM).not.toHaveBeenCalled();
      expect((await store.getWorkload(id))?.state).toBe(
        WorkloadState.Terminated,
      );
    });

    it('does not start a running host that only lost SSH', async () => {
      const id = 'unreachable-vm-running';
      const { store } = await createRunningPersistentVm(id);
      const compute = makeMockCloudCompute({
        verifyVMPreemption: vi.fn().mockResolvedValue(false),
      });
      vi.spyOn(compute, 'observeStoppedVm');
      vi.mocked(createComputeProvider).mockReturnValue(compute);

      await runWorkloadReconcileOnce();

      expect(compute.observeStoppedVm).toHaveBeenCalled();
      expect(compute.startVM).not.toHaveBeenCalled();
      expect(await store.getVMs(id)).toMatchObject([{ ip: '1.2.3.4' }]);
    });
  });

  it('test:0036/S11 preserves a persistent VM and its spec when its unreachable host still exists', async () => {
    const id = 'running-vm-host-alive';
    const { store, cloudId } = await createRunningPersistentVm(id);
    const specs = await getDB().query('SELECT * FROM container_specs');
    const observeVMReleaseOnce = vi.fn().mockResolvedValue(VM_PRESENT);
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({ observeVMReleaseOnce }),
    );

    await runWorkloadReconcileOnce();

    expect(observeVMReleaseOnce).toHaveBeenCalledWith(
      cloudId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(createComputeProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        availabilityZone: 'us-central1-a',
      }),
      'observed-vm',
    );
    expect(containerRepair.reconcileRunningVmContainer).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    expect(await store.getVMs(id)).toHaveLength(1);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual(specs);
    expect(startup.deploy).not.toHaveBeenCalled();
  });

  it('never fails a persistent VM while cloud host status remains unknown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'running-vm-host-unknown';
    const { store } = await createRunningPersistentVm(id);
    const observeVMReleaseOnce = vi
      .fn()
      .mockResolvedValue(vmReleaseUnknown('provider unavailable'));
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({ observeVMReleaseOnce }),
    );

    await runWorkloadReconcileOnce();
    vi.setSystemTime(Date.now() + JOB_UNREACHABLE_RECOVERY_MS * 2);
    await runWorkloadReconcileOnce();

    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(2);
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    expect(await store.getVMs(id)).toHaveLength(1);
  });

  it('test:0036/S11 fails a persistent VM without replacement when its host is confirmed gone', async () => {
    const id = 'running-vm-host-terminated';
    const { store, cloudId } = await createRunningPersistentVm(id);
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
      }),
    );

    await runWorkloadReconcileOnce();

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Failed);
    // The host's directly-attached resources can outlive it, so the ledger row
    // stays live until terminal cleanup deletes them.
    expect(await store.listVms(id)).toMatchObject([{ cloudId, endedAt: null }]);
    const failureEvent = (await eventLog().getWorkloadEvents(id)).at(-1)!;
    expect(failureEvent).toMatchObject({
      state: WorkloadState.Failed,
    });
    expect(JSON.parse(failureEvent.metadata!)).toEqual({
      reason: VM_HOST_MISSING_REASON,
      cloudId,
    });
    expect(termination.teardownVMs).not.toHaveBeenCalled();
    expect(startup.deploy).not.toHaveBeenCalled();

    await runWorkloadReconcileOnce();

    expect((await store.getWorkload(id))?.cleanedAt).toEqual(
      expect.any(Number),
    );
    expect(await store.listVms(id)).toMatchObject([
      { cloudId, endedAt: expect.any(Number) },
    ]);
    expect(termination.terminateStep).toHaveBeenCalledWith(
      expect.objectContaining({ cloudProvider: CloudType.GCP }),
      id,
    );
    expect(startup.deploy).not.toHaveBeenCalled();
  });

  it('retains stable-release evidence across monitor polls without overrunning one poll', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'running-vm-host-stable-release';
    const { store } = await createRunningPersistentVm(id);
    const observeVMReleaseOnce = vi
      .fn()
      .mockResolvedValue(VM_RELEASE_CANDIDATE);
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce,
        releaseConfirmationPolicy: {
          requiredReleaseObservations: 2,
          minObservationIntervalMs: 10_000,
        },
      }),
    );

    await runWorkloadReconcileOnce();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    expect(observeVMReleaseOnce).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Failed);
    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(2);
  });

  it('retains stable-release evidence when reachable-host container observation throws', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const id = 'running-vm-observation-failed';
    const { store } = await createRunningPersistentVm(id);
    vi.mocked(tcpPing).mockResolvedValue(true);
    vi.mocked(containerRepair.reconcileRunningVmContainer).mockRejectedValue(
      new Error('SSH stream closed'),
    );
    const observeVMReleaseOnce = vi
      .fn()
      .mockResolvedValue(VM_RELEASE_CANDIDATE);
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        observeVMReleaseOnce,
        releaseConfirmationPolicy: {
          requiredReleaseObservations: 2,
          minObservationIntervalMs: 10_000,
        },
      }),
    );

    await runWorkloadReconcileOnce();

    expect(containerRepair.reconcileRunningVmContainer).toHaveBeenCalledWith(
      id,
    );
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    expect(observeVMReleaseOnce).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
    await runWorkloadReconcileOnce();

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Failed);
    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(2);
  });

  it('defers persistent host-loss detection when exact attempt credentials are missing', async () => {
    const id = 'running-vm-host-no-credentials';
    const { store } = await createRunningPersistentVm(id);
    await store['db'].query(
      'UPDATE vms SET credential_id = NULL WHERE workload_id = ?',
      [id],
    );

    await runWorkloadReconcileOnce();

    expect(createComputeProvider).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    expect(await store.getVMs(id)).toHaveLength(1);
  });

  it.each(['credential', 'region', 'zone'] as const)(
    'does not reuse native-absence confirmation after the attempt %s changes',
    async (coordinate) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const id = `host-identity-${coordinate}`;
      const { store, cloudId } = await createRunningPersistentVm(id);
      const [oldVm] = await store.getVMs(id);
      const firstRead = vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE);
      const nextRead = vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE);
      const policy = {
        requiredReleaseObservations: 2,
        minObservationIntervalMs: 10_000,
      };
      vi.mocked(createComputeProvider)
        .mockImplementationOnce((cfg) =>
          makeMockCloudCompute({
            region: cfg.region,
            observeVMReleaseOnce: firstRead,
            releaseConfirmationPolicy: policy,
          }),
        )
        .mockImplementation((cfg) =>
          makeMockCloudCompute({
            region: cfg.region,
            observeVMReleaseOnce: nextRead,
            releaseConfirmationPolicy: policy,
          }),
        );

      await runWorkloadReconcileOnce();
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
      expect(firstRead).toHaveBeenCalledOnce();

      const replacementCredential = await upsertCredential(
        getDB(),
        'other-project-credential',
        await encryptCredential({
          ...TEST_GCP_CRED,
          projectId: 'other-project',
        }),
        CloudType.GCP,
      );
      await releaseTestVms(id, cloudId);
      await walkToState(id, WorkloadState.Provisioning);
      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
      await provisionTestVm(
        id,
        {
          ...oldVm!,
          cloudId,
          createdAt: Date.now(),
          availabilityZone:
            coordinate === 'zone' ? 'us-central1-b' : oldVm!.availabilityZone,
        },
        {
          credentialId:
            coordinate === 'credential'
              ? replacementCredential
              : oldVm!.credentialId,
          region: coordinate === 'region' ? 'us-east4' : oldVm!.region,
          vmType: 'n2-standard-4',
        },
      );
      await walkToState(id, WorkloadState.Running);

      await runWorkloadReconcileOnce();
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
      expect(firstRead).toHaveBeenCalledOnce();
      expect(nextRead).toHaveBeenCalledOnce();

      vi.setSystemTime(Date.now() + JOB_COMPLETION_POLL_INTERVAL_MS);
      await runWorkloadReconcileOnce();
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Failed);
      expect(nextRead).toHaveBeenCalledTimes(2);
    },
  );

  it('skips persistent VM host checks while the API network is unavailable', async () => {
    const id = 'running-vm-api-network-down';
    const { store } = await createRunningPersistentVm(id);
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(false);

    await runWorkloadReconcileOnce();

    expect(tcpPing).not.toHaveBeenCalled();
    expect(createComputeProvider).not.toHaveBeenCalled();
    expect(containerRepair.reconcileRunningVmContainer).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
  });

  async function repair(id: string, failed = true) {
    const failMissingVmHost = vi.fn().mockResolvedValue(failed);
    const { disposition } = await reconcileRunningVm(
      {
        store: queries(),
        lifecycle: lifecycle(),
        outcomes: { failMissingVmHost },
      },
      (await queries().getWorkload(id))!,
    );
    return { disposition, failMissingVmHost };
  }

  it.each<[RunningVmContainerReconcileResult, string, 'info' | 'warn', RegExp]>(
    [
      [{ outcome: 'created' }, 'completed', 'info', /Recreated/],
      [{ outcome: 'converged' }, 'completed', 'info', /another creator/],
      [{ outcome: 'conflict', state: Exited }, 'completed', 'warn', /conflict/],
      [{ outcome: 'deferred', reason: 'busy' }, 'deferred', 'warn', /deferred/],
    ],
  )(
    'returns %o as %s and de-duplicates its log',
    async (result, disposition, level, message) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const spy = vi.spyOn(log, level);
      const id = `repair-${result.outcome}`;
      await createRunningPersistentVm(id);
      vi.mocked(tcpPing).mockResolvedValue(true);
      vi.mocked(containerRepair.reconcileRunningVmContainer).mockResolvedValue(
        result,
      );
      const logged = () => spy.mock.calls.filter(([m]) => message.test(m));

      expect((await repair(id)).disposition).toBe(disposition);
      await repair(id);
      expect(logged()).toHaveLength(1);
      vi.mocked(
        containerRepair.reconcileRunningVmContainer,
      ).mockResolvedValueOnce({ outcome: 'observed', state: Exited });
      await repair(id);
      await repair(id);
      expect(logged()).toHaveLength(2);
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await repair(id);
      expect(logged()).toHaveLength(3);
      vi.mocked(
        containerRepair.reconcileRunningVmContainer,
      ).mockResolvedValueOnce({ outcome: 'healthy' });
      await repair(id);
      await repair(id);
      expect(logged()).toHaveLength(4);
    },
  );

  it.each([
    [/host exists/, VM_PRESENT, 1],
    [/awaits confirmation/, VM_RELEASE_CANDIDATE, 2],
    [/status is unknown/, vmReleaseUnknown('down'), 1],
  ])(
    'defers an unobservable host and logs %s',
    async (message, observation, requiredReleaseObservations) => {
      const warn = vi.spyOn(log, 'warn');
      const id = `unobservable-${requiredReleaseObservations}-${observation.state}`;
      await createRunningPersistentVm(id);
      vi.mocked(createComputeProvider).mockReturnValue(
        makeMockCloudCompute({
          observeVMReleaseOnce: vi.fn().mockResolvedValue(observation),
          releaseConfirmationPolicy: {
            requiredReleaseObservations,
            minObservationIntervalMs: 0,
          },
        }),
      );

      const { disposition, failMissingVmHost } = await repair(id);

      expect(disposition).toBe('deferred');
      expect(failMissingVmHost).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(message),
        expect.anything(),
      );
    },
  );

  it.each([
    [true, 'completed'],
    [false, 'stale'],
  ] as const)(
    'returns a confirmed-missing host failure claim of %s as %s',
    async (failed, disposition) => {
      const id = `missing-host-${failed}`;
      const { cloudId } = await createRunningPersistentVm(id);
      vi.mocked(createComputeProvider).mockReturnValue(
        makeMockCloudCompute({
          observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
        }),
      );

      const result = await repair(id, failed);

      expect(result.disposition).toBe(disposition);
      expect(result.failMissingVmHost).toHaveBeenCalledWith(
        id,
        { cloudId, ip: '1.2.3.4' },
        { reason: VM_HOST_MISSING_REASON },
      );
    },
  );
});
