import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as termination from '../../../src/api/services/host-runtime/termination';
import { generateStartupScript } from '../../../src/api/services/vm-startup-script';
import { runStep } from '../../../src/api/services/task';
import {
  latestEventMetadata,
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;
const generateManagedStartupScript = (
  sshKeys: Parameters<typeof generateStartupScript>[0],
): string => generateStartupScript(sshKeys);

const deployFlowMocks = vi.hoisted(() => ({
  assertVmContainerReady: vi.fn(),
  checkpointUpsertBucket: vi.fn(),
  classifyError: vi.fn(),
  dockerPing: vi.fn(),
  getContainerStatus: vi.fn(),
  startContainer: vi.fn(),
}));

vi.mock('../../../src/api/services/docker', () => ({
  DockerManager: vi.fn().mockImplementation(function () {
    return {
      assertVmContainerReady: deployFlowMocks.assertVmContainerReady,
      getContainerStatus: deployFlowMocks.getContainerStatus,
      startContainer: deployFlowMocks.startContainer,
      ping: deployFlowMocks.dockerPing,
    };
  }),
}));

vi.mock('../../../src/api/services/cloud-config', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...actual,
    createComputeProvider: vi.fn((cloudConfig: CloudConfig) => ({
      classifyError: deployFlowMocks.classifyError,
      getAllVMs: vi.fn().mockResolvedValue([]),
      newVM: vi.fn().mockResolvedValue({
        cloudId: 'vm-1',
        ip: '10.0.0.1',
      }),
      // Mirror the real capability: Local publishes no public endpoint.
      publishesPublicEndpoint: () => cloudConfig?.cloudProvider !== 'Local',
      terminateNetworking: vi.fn().mockResolvedValue(undefined),
      terminateVMs: vi.fn((cloudIds: string[]) => Promise.resolve(cloudIds)),
      type: cloudConfig.cloudProvider,
      region: cloudConfig.region ?? '',
      upsertFirewall: vi.fn().mockResolvedValue(undefined),
      validateCredentials: vi.fn().mockResolvedValue(undefined),
    })),
    createCheckpointStorageProvider: vi.fn(() => ({
      region: 'us-east-1',
      type: 'aws',
      upsertBucket: deployFlowMocks.checkpointUpsertBucket,
    })),
    resolveRuntimeBucketStorageRegions: vi.fn(
      async (cloudConfig: CloudConfig) => cloudConfig,
    ),
  };
});

import { DeployError } from '../../../src/shared/errors';
import { formatErrorForUser } from '../../../src/shared/error-formatter';
import {
  CloudFailureDiagnosis,
  CloudConfig,
  CloudType,
} from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { ContainerState } from '../../../src/shared/runtime.js';
import {
  getWorkloadLifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import { checkJobCompletion } from '../../../src/api/services/workload-workflows/completion';
import {
  PartialVMCreationError,
  VMCreationError,
} from '../../../src/api/services/codes';
import { resetTestStore } from '../utils';
import {
  drainWorkloadWork,
  hasWorkloadWork,
} from '../../../src/api/services/workload-work-registry';
import { TimeoutError } from '../../../src/shared/utils';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../../src/api/services/repositories/db.js';

const persisted = () => ({
  store: queries(),
  lifecycle: getWorkloadLifecycle(),
  outcomes: getWorkloadOutcomes(),
  events: eventLog(),
});

describe('conduct module', () => {
  describe('generateStartupScript', () => {
    it('should include SSH public key in authorized_keys', () => {
      const script = generateManagedStartupScript({
        publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB test@example.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      });

      expect(script).toContain(
        'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB test@example.com',
      );
      expect(script).toContain('/root/.ssh/authorized_keys');
    });

    it('never writes the private key to the guest', () => {
      const script = generateManagedStartupScript({
        publicKey: 'ssh-rsa test',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nsecret-key-data\n-----END PRIVATE KEY-----',
      });

      expect(script).not.toContain('-----BEGIN PRIVATE KEY-----');
      expect(script).not.toContain('secret-key-data');
      expect(script).not.toContain('/etc/anycloud-key');
    });

    it('should set correct permissions on SSH files', () => {
      const script = generateManagedStartupScript({
        publicKey: 'ssh-rsa test',
        privateKey: 'test-key',
      });

      expect(script).toContain('chmod 700 /root/.ssh');
      expect(script).toContain('chmod 600 /root/.ssh/authorized_keys');
    });

    it('should create sshd run directory', () => {
      const script = generateManagedStartupScript({
        publicKey: 'ssh-rsa test',
        privateKey: 'test-key',
      });

      expect(script).toContain('mkdir -p /run/sshd');
    });

    it('should handle systemctl vs direct sshd start', () => {
      const script = generateManagedStartupScript({
        publicKey: 'ssh-rsa test',
        privateKey: 'test-key',
      });

      expect(script).toContain('systemctl restart sshd');
      expect(script).toContain('/usr/sbin/sshd');
    });
  });

  describe('unresolved provisioning attempts', () => {
    beforeEach(async () => {
      await resetTestStore();
    });

    it('should be invisible to getVMs but counted by countAllVMs', async () => {
      const workloadId = 'test-failed-vms-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, { cloudId: `${workloadId}-0` });

      // Not active
      expect(await queries().getVMs(workloadId)).toHaveLength(0);
      // But counted
      expect(await ledger().countAllVMs(workloadId)).toBe(1);
    });

    it('should count alongside active VMs', async () => {
      const workloadId = 'test-mixed-vms-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // First attempt failed
      await provisionTestVm(workloadId, { cloudId: `${workloadId}-0` });
      // Second attempt succeeded
      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: `${workloadId}-1`,
        privateIp: '10.0.0.1',
      });

      expect(await queries().getVMs(workloadId)).toHaveLength(1);
      expect(await ledger().countAllVMs(workloadId)).toBe(2);
    });

    it('should handle multiple vmIds in one call', async () => {
      const workloadId = 'test-multi-fail-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await Promise.all(
        [`${workloadId}-0`, `${workloadId}-1`].map((cloudId) =>
          provisionTestVm(workloadId, { cloudId }),
        ),
      );

      expect(await ledger().countAllVMs(workloadId)).toBe(2);
    });

    it('should be a no-op for empty array', async () => {
      const workloadId = 'test-empty-fail-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await Promise.all(
        [].map((cloudId) => provisionTestVm(workloadId, { cloudId })),
      );
      expect(await ledger().countAllVMs(workloadId)).toBe(0);
    });
  });

  describe('VM storage in SQLite', () => {
    beforeEach(async () => {
      // Migrations auto-run on fresh SQLiteDatabase in LOCAL mode
      await resetTestStore();
    });

    it('should store and retrieve VMs with cloudId from SQLite', async () => {
      const workloadId = 'test-vm-storage-' + Date.now();

      // Create workload
      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // Add VMs with cloudIds (this was not possible before the refactor)
      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'i-abc123',
        privateIp: '10.0.0.1',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'i-def456',
        privateIp: '10.0.0.2',
      });

      // Retrieve VMs - now includes cloudId for termination
      const vms = await queries().getVMs(workloadId);

      expect(vms).toHaveLength(2);
      expect(vms[0]).toMatchObject({
        ip: '1.1.1.1',
        cloudId: 'i-abc123',
        privateIp: '10.0.0.1',
      });
      expect(vms[0].createdAt).toBeTypeOf('number');
      expect(vms[1]).toMatchObject({
        ip: '2.2.2.2',
        cloudId: 'i-def456',
        privateIp: '10.0.0.2',
      });
      expect(vms[1].createdAt).toBeTypeOf('number');
    });

    it('should only return active VMs (not ended)', async () => {
      const workloadId = 'test-active-vms-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // Add 3 VMs
      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'i-abc123',
        privateIp: '10.0.0.1',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'i-def456',
        privateIp: '10.0.0.2',
      });
      await provisionTestVm(workloadId, {
        ip: '3.3.3.3',
        cloudId: 'i-ghi789',
        privateIp: '10.0.0.3',
      });

      // Get VMs to obtain createdAt timestamp
      const allVms = await queries().getVMs(workloadId);
      const vmToEnd = allVms.find((v) => v.ip === '2.2.2.2')!;

      // End one VM
      await releaseTestVms(workloadId, vmToEnd.cloudId);

      // Should only return 2 active VMs
      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(2);
      expect(vms.map((v) => v.ip)).toEqual(['1.1.1.1', '3.3.3.3']);
    });

    it('should handle IP reuse during upgrade (same IP, different created_at)', async () => {
      // Mock Date.now() to return controlled timestamps
      let mockTime = 1000000;
      const dateNowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => mockTime);

      try {
        const workloadId = 'test-ip-reuse-' + mockTime;

        await createWorkload(getDB(), {
          id: workloadId,
          userId: 'test-user',
          workloadType: 'job',
          image: 'test:latest',
          dockerCommand: 'docker run test',
          sshPrivateKey: 'test-ssh-key',
          credentialId: 'test-credential-id',
        });

        // Add old VM at time 1000000
        await provisionTestVm(workloadId, {
          ip: '1.1.1.1',
          cloudId: 'i-old123',
          privateIp: '10.0.0.1',
        });

        // Get old VM to obtain createdAt
        const oldVms = await queries().getVMs(workloadId);
        expect(oldVms).toHaveLength(1);
        const oldVm = oldVms[0];
        expect(oldVm.createdAt).toBe(1000000);

        // Advance mock time by 1ms to ensure different created_at
        mockTime = 1000001;

        // Simulate upgrade: Add new VM with SAME IP but different instance ID at time 1000001
        await provisionTestVm(workloadId, {
          ip: '1.1.1.1',
          cloudId: 'i-new456',
          privateIp: '10.0.0.1',
        });

        // Now we have 2 active VMs with same IP
        const beforeEnd = await queries().getVMs(workloadId);
        expect(beforeEnd).toHaveLength(2);
        expect(beforeEnd.map((v) => v.cloudId)).toEqual([
          'i-old123',
          'i-new456',
        ]);

        // End old VM using cloudId
        await releaseTestVms(workloadId, oldVm.cloudId);

        // Should only return new VM
        const afterEnd = await queries().getVMs(workloadId);
        expect(afterEnd).toHaveLength(1);
        expect(afterEnd[0].cloudId).toBe('i-new456');
        expect(afterEnd[0].ip).toBe('1.1.1.1'); // Same IP as old VM
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('should end all VMs for a workload', async () => {
      const workloadId = 'test-end-all-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'i-abc123',
        privateIp: '10.0.0.1',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'i-def456',
        privateIp: '10.0.0.2',
      });

      // End all VMs
      await releaseTestVms(workloadId);

      // Should return empty array
      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(0);
    });

    it('should handle VMs without privateIp', async () => {
      const workloadId = 'test-no-private-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // Add VM without privateIp
      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'i-abc123',
      });

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(1);
      expect(vms[0].privateIp).toBeUndefined();
    });
  });

  describe('checkJobCompletion', () => {
    beforeEach(async () => {
      // Migrations auto-run on fresh SQLiteDatabase in LOCAL mode
      await resetTestStore();
    });

    it('should not update state when already in Errored state', async () => {
      const workloadId = 'test-errored-skip-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // Call checkJobCompletion - should return early without updating state
      await checkJobCompletion(persisted(), workloadId, 'fake-ssh-key', {
        cloudProvider: CloudType.AWS,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });

      // Verify no events were logged (state was not updated)
      const events = await eventLog().getWorkloadEvents(workloadId);
      expect(events).toHaveLength(0);
    });

    it('should not update state when already in Completed state', async () => {
      const workloadId = 'test-completed-skip-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await checkJobCompletion(persisted(), workloadId, 'fake-ssh-key', {
        cloudProvider: CloudType.AWS,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });

      const events = await eventLog().getWorkloadEvents(workloadId);
      expect(events).toHaveLength(0);
    });

    it('should not update state when in Terminated state', async () => {
      const workloadId = 'test-terminated-skip-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await checkJobCompletion(persisted(), workloadId, 'fake-ssh-key', {
        cloudProvider: CloudType.AWS,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });

      const events = await eventLog().getWorkloadEvents(workloadId);
      expect(events).toHaveLength(0);
    });
  });

  describe('workload events', () => {
    beforeEach(async () => {
      // Migrations auto-run on fresh SQLiteDatabase in LOCAL mode
      await resetTestStore();
    });

    it('should not log provisioning event on createWorkload (runStep logs it)', async () => {
      const workloadId = 'test-no-initial-event-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // Verify no events logged yet (runStep will log the first event)
      const events = await eventLog().getWorkloadEvents(workloadId);
      expect(events).toHaveLength(0);

      // Verify workload starts in Queued state (provisioning scheduler dispatches it)
      const workload = await queries().getWorkload(workloadId);
      expect(workload?.state).toBe(WorkloadState.Queued);
    });

    it('should log exactly one event per state via runStep', async () => {
      const workloadId = 'test-single-event-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      // Run provisioning step (simulates what the startup deploy does)
      await runStep({
        id: workloadId,
        step: WorkloadState.Provisioning,
        fn: async () => {},
        timeoutMs: 5000,
        onErrorState: WorkloadState.Failed,
      });

      // Verify exactly one provisioning event
      const events = await eventLog().getWorkloadEvents(workloadId);
      const provisioningEvents = events.filter(
        (e) => e.state === WorkloadState.Provisioning,
      );
      expect(provisioningEvents).toHaveLength(1);
    });

    it('publishes a terminal outcome before its error cleanup callback', async () => {
      const workloadId = 'terminal-before-cleanup-' + Date.now();
      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: WorkloadType.Job,
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      const onError = vi.fn(async () => {
        const workload = await queries().getWorkload(workloadId);
        const events = await eventLog().getWorkloadEvents(workloadId);
        expect(workload?.state).toBe(WorkloadState.Invalid);
        expect(workload?.completedAt).toEqual(expect.any(Number));
        expect(events.at(-1)?.state).toBe(WorkloadState.Invalid);
      });

      await expect(
        runStep({
          id: workloadId,
          step: WorkloadState.Provisioning,
          fn: async () => {
            throw new Error('terminal provisioning failure');
          },
          timeoutMs: 5_000,
          onErrorState: WorkloadState.Invalid,
          onError,
        }),
      ).rejects.toThrow('terminal provisioning failure');

      expect(onError).toHaveBeenCalledOnce();
      expect((await queries().getWorkload(workloadId))?.cleanedAt).toBeNull();
    });

    it('persists a late provider ID before timeout cleanup consumes it', async () => {
      vi.useFakeTimers();
      const workloadId = 'late-provider-id-ordering';
      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: WorkloadType.Job,
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      let resolveProvider!: () => void;
      const provider = new Promise<void>((resolve) => {
        resolveProvider = resolve;
      });
      const cleanupIds: string[][] = [];

      try {
        const step = runStep({
          id: workloadId,
          step: WorkloadState.Provisioning,
          fn: async () => {
            const attempt = await ledger().beginProvisioningAttempt(
              workloadId,
              `${workloadId}-0`,
            );
            expect(attempt).not.toBeNull();
            await provider;
            await ledger().completeProvisioningAttempt(workloadId, attempt!, {
              cloudId: 'provider-resource-123',
              ip: '203.0.113.50',
            });
          },
          timeoutMs: 1_000,
          onErrorState: WorkloadState.Retrying,
          onError: async () => {
            const attempts = await ledger().getProvisioningAttempts(workloadId);
            cleanupIds.push(
              attempts
                .filter((candidate) => candidate.ended_at === null)
                .map((candidate) => candidate.cloud_id),
            );
          },
        });
        const foregroundError = step.catch((error) => error);

        await vi.waitFor(async () => {
          expect(
            await ledger().getProvisioningAttempts(workloadId),
          ).toHaveLength(1);
        });
        await vi.advanceTimersByTimeAsync(1_001);

        await expect(foregroundError).resolves.toBeInstanceOf(TimeoutError);
        expect(cleanupIds).toEqual([]);
        expect(hasWorkloadWork(workloadId)).toBe(true);

        resolveProvider();
        await drainWorkloadWork(workloadId);

        expect(
          (await ledger().getProvisioningAttempts(workloadId))[0]?.cloud_id,
        ).toBe('provider-resource-123');
        expect(cleanupIds).toEqual([['provider-resource-123']]);
      } finally {
        resolveProvider();
        await drainWorkloadWork(workloadId);
        vi.useRealTimers();
      }
    });

    it.each([
      { wrapper: 'attempt', withClassifier: true },
      { wrapper: 'attempt', withClassifier: false },
      { wrapper: 'partial', withClassifier: true },
      { wrapper: 'partial', withClassifier: false },
    ])(
      'keeps wrapped configuration errors terminal ($wrapper, classifier=$withClassifier)',
      async ({ wrapper, withClassifier }) => {
        const workloadId = `wrapped-config-${wrapper}-${withClassifier}`;
        await createWorkload(getDB(), {
          id: workloadId,
          userId: 'test-user',
          workloadType: WorkloadType.Job,
          image: 'test:latest',
          dockerCommand: 'docker run test',
          sshPrivateKey: 'test-ssh-key',
          credentialId: 'test-credential-id',
        });
        const original = new DeployError(
          'Unsupported accelerator runtime',
          400,
        );
        const error =
          wrapper === 'attempt'
            ? new VMCreationError(original, ['attempted-vm'])
            : new PartialVMCreationError(original, [{ cloudId: 'created-vm' }]);
        const classifyError = vi
          .fn()
          .mockReturnValue(CloudFailureDiagnosis.TemporaryProviderFailure);
        const cleanupStates: unknown[] = [];
        const onError = vi.fn(async () => {
          const workload = await queries().getWorkload(workloadId);
          cleanupStates.push({
            state: workload?.state,
            completedAt: workload?.completedAt,
            cleanedAt: workload?.cleanedAt,
          });
        });

        await expect(
          runStep({
            id: workloadId,
            step: WorkloadState.Provisioning,
            fn: async () => {
              throw error;
            },
            timeoutMs: 5_000,
            onErrorState: WorkloadState.Retrying,
            onError,
            ...(withClassifier ? { classifyError } : {}),
          }),
        ).rejects.toBe(error);

        expect(classifyError).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(error.originalError).toBe(original);
        expect(cleanupStates).toEqual([
          {
            state: WorkloadState.Invalid,
            completedAt: expect.any(Number),
            cleanedAt: null,
          },
        ]);
        const events = await eventLog().getWorkloadEvents(workloadId);
        expect(events.map((event) => event.state)).toEqual([
          WorkloadState.Provisioning,
          WorkloadState.Invalid,
        ]);
        const metadata = JSON.parse(events.at(-1)!.metadata!);
        expect(metadata).toMatchObject({
          diagnosis: CloudFailureDiagnosis.InvalidRequest,
          disposition: 'terminal-invalid',
          error: {
            name: error.name,
            message: original.message,
            ...(wrapper === 'attempt'
              ? { attemptedVmIds: ['attempted-vm'] }
              : { partialVMs: [{ cloudId: 'created-vm' }] }),
          },
        });
      },
    );

    it('should omit the provider graph only from persisted VM creation errors', async () => {
      const workloadId = 'test-bounded-vm-error-' + Date.now();
      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      const request: Record<string, unknown> = {};
      const socket: Record<string, unknown> = { request };
      request.socket = socket;
      const quota =
        'Operation could not be completed as it results in exceeding approved Total Regional Cores quota. Location: eastus, Current Limit: 10, Current Usage: 8, Additional Required: 4';
      const originalError = Object.assign(new Error(quota), {
        code: 'OperationNotAllowed',
        statusCode: 409,
        $response: {
          body: 'x'.repeat(512 * 1024),
          request,
        },
      });
      const wrappedError = new VMCreationError(originalError, ['attempted-vm']);
      const onError = vi.fn(async (error: Error) => {
        expect(error).toBe(wrappedError);
        expect((error as VMCreationError).originalError).toBe(originalError);
      });
      const classifyError = vi.fn((error: unknown) => {
        expect(error).toBe(originalError);
        return CloudFailureDiagnosis.QuotaExhaustedAccount;
      });

      await expect(
        runStep({
          id: workloadId,
          step: WorkloadState.Provisioning,
          fn: async () => {
            throw wrappedError;
          },
          timeoutMs: 5000,
          onErrorState: WorkloadState.Retrying,
          onError,
          classifyError,
        }),
      ).rejects.toBe(wrappedError);

      expect(onError).toHaveBeenCalledOnce();
      expect(classifyError).toHaveBeenCalledOnce();
      const events = await eventLog().getWorkloadEvents(workloadId);
      const retryEvent = events.find(
        (event) => event.state === WorkloadState.Retrying,
      );
      const metadata = JSON.parse(retryEvent!.metadata!);

      expect(metadata.error).toMatchObject({
        message: quota,
        name: 'VMCreationError',
        statusCode: 409,
        attemptedVmIds: ['attempted-vm'],
      });
      expect(metadata.error).not.toHaveProperty('originalError');
      expect(metadata.error).not.toHaveProperty('code');
      // The provider's own code would swap this detail for a stock line.
      expect(formatErrorForUser(metadata.error, CloudType.Azure)).toBe(
        `${quota} (HTTP 409)`,
      );
      expect(metadata.diagnosis).toBe(
        CloudFailureDiagnosis.QuotaExhaustedAccount,
      );
      expect(Buffer.byteLength(retryEvent!.metadata!)).toBeLessThan(10_000);
    });
  });

  describe('terminate', () => {
    const cloudConfig: CloudConfig = {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    };
    beforeEach(async () => {
      await resetTestStore();
    });

    it('should preserve Completed state while cleaning its VM', async () => {
      const workloadId = 'test-preserve-completed-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'i-completed123',
      });
      await walkToState(workloadId, WorkloadState.Completed);

      await termination.terminate(cloudConfig, workloadId);

      // Already terminal — state preserved, VMs cleaned up
      const workload = await queries().getWorkload(workloadId);
      expect(workload?.state).toBe(WorkloadState.Completed);

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(0);
    });

    it('should preserve Errored state while cleaning its VM', async () => {
      const workloadId = 'test-preserve-errored-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'i-errored456',
      });
      await walkToState(workloadId, WorkloadState.Errored);

      await termination.terminate(cloudConfig, workloadId);

      const workload = await queries().getWorkload(workloadId);
      expect(workload?.state).toBe(WorkloadState.Errored);

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(0);
    });

    it('should preserve Failed state when terminating workload', async () => {
      const workloadId = 'test-preserve-failed-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      await provisionTestVm(workloadId, {
        ip: '4.4.4.4',
        cloudId: 'i-failed789',
      });
      await walkToState(workloadId, WorkloadState.Failed);

      await termination.terminate(cloudConfig, workloadId);

      const workload = await queries().getWorkload(workloadId);
      expect(workload?.state).toBe(WorkloadState.Failed);

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(0);
    });

    it('should transition Retrying state to Terminated when terminating', async () => {
      const workloadId = 'test-retrying-terminate-' + Date.now();

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      await walkToState(workloadId, WorkloadState.Retrying);

      await getWorkloadOutcomes().requestTermination(
        workloadId,
        scope('test-user'),
      );
      expect((await queries().getWorkload(workloadId))?.state).toBe(
        WorkloadState.Terminated,
      );
      await termination.terminate(cloudConfig, workloadId);

      const workload = await queries().getWorkload(workloadId);
      expect(workload?.state).toBe(WorkloadState.Terminated);
    });

    it('should transition Running state to Terminated when terminating', async () => {
      const workloadId = 'test-normal-terminate-' + Date.now();

      // Create workload in Running state (not Completed/Errored)
      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      await provisionTestVm(workloadId, {
        ip: '3.3.3.3',
        cloudId: 'i-running789',
      });
      await walkToState(workloadId, WorkloadState.Running);

      await getWorkloadOutcomes().requestTermination(
        workloadId,
        scope('test-user'),
      );
      expect((await queries().getWorkload(workloadId))?.state).toBe(
        WorkloadState.Terminated,
      );
      await termination.terminate(cloudConfig, workloadId);

      // Verify state transitioned to Terminated (normal behavior for non-exited states)
      const workload = await queries().getWorkload(workloadId);
      expect(workload?.state).toBe(WorkloadState.Terminated);

      // Verify VMs were cleaned up
      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(0);
    });
  });
});

describe('Errored state is exclusively set by job-completion reconciliation', () => {
  const cloudConfig: CloudConfig = {
    cloudProvider: CloudType.AWS,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    region: 'us-east-1',
    vmType: 't3.micro',
  };

  beforeEach(async () => {
    await resetTestStore();
  });

  it('Downloading step failure → Retrying not Errored', async () => {
    const id = 'test-download-fail-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'bad-image:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    // FSM requires Initializing → Downloading
    await walkToState(id, WorkloadState.Initializing);

    await expect(
      runStep({
        id,
        step: WorkloadState.Downloading,
        fn: async () => {
          throw new Error('registry unavailable');
        },
        timeoutMs: 5000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
    expect(workload?.state).not.toBe(WorkloadState.Errored);
  });

  it('Starting step failure → Retrying not Errored', async () => {
    const id = 'test-start-fail-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    // FSM requires Downloading or Syncing → Starting
    await walkToState(id, WorkloadState.Downloading);

    await expect(
      runStep({
        id,
        step: WorkloadState.Starting,
        fn: async () => {
          throw new Error('Timed out while waiting for handshake');
        },
        timeoutMs: 5000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
    expect(workload?.state).not.toBe(WorkloadState.Errored);
  });

  it('keeps the reason when a step fails because its container died', async () => {
    // A container exit used to replace the standard failure metadata rather
    // than add to it, so the event recorded the container state and dropped
    // the message, diagnosis and disposition. A workload then cycled through
    // Retrying with nothing an operator could read.
    const { ContainerExitError } = await import(
      '../../../src/api/services/task'
    );
    const id = 'test-container-exit-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'service',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Downloading);

    await expect(
      runStep({
        id,
        step: WorkloadState.Starting,
        fn: async () => {
          throw new ContainerExitError(
            'Service container exited during startup',
            {
              state: ContainerState.Exited,
              exitCode: 1,
              logs: 'CIPHER_KEY must be 64 hex characters',
            },
          );
        },
        timeoutMs: 5000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toThrow();

    const metadata = await latestEventMetadata(id);
    expect(metadata.error).toMatchObject({
      message: expect.stringContaining('exited during startup'),
    });
    expect(metadata.exitCode).toBe(1);
    expect(String(metadata.logs)).toContain('CIPHER_KEY');
  });

  it('bounds what a failed step persists, stack included', async () => {
    // The cap exists because an unbounded message once bloated these rows.
    // A stack repeats the whole message on its first line, so
    // persisting one would carry the payload straight past the cap.
    const id = 'test-huge-error-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Downloading);

    await expect(
      runStep({
        id,
        step: WorkloadState.Starting,
        fn: async () => {
          throw new Error('x'.repeat(50_000));
        },
        timeoutMs: 5000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toThrow();

    const metadata = await latestEventMetadata(id);
    expect(metadata.error).not.toHaveProperty('stack');
    expect(JSON.stringify(metadata).length).toBeLessThan(8_000);
  });

  it('records a dead container status once, not twice', async () => {
    // ContainerExitError carries its status as a parameter property, which is
    // own and enumerable, so a serializer copies it too. Spreading it at the
    // top level as well would store the log tail twice per event.
    const { ContainerExitError } = await import(
      '../../../src/api/services/task'
    );
    const id = 'test-dup-status-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'service',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Downloading);

    await expect(
      runStep({
        id,
        step: WorkloadState.Starting,
        fn: async () => {
          throw new ContainerExitError('Service container exited', {
            state: ContainerState.Exited,
            exitCode: 1,
            logs: 'UNIQUE_LOG_MARKER',
          });
        },
        timeoutMs: 5000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toThrow();

    const metadata = await latestEventMetadata(id);
    expect(metadata.logs).toBe('UNIQUE_LOG_MARKER');
    expect(metadata.error).not.toHaveProperty('metadata');
    expect(JSON.stringify(metadata).match(/UNIQUE_LOG_MARKER/g)).toHaveLength(
      1,
    );
  });

  it('keeps the fields of a thrown value that is not an Error', async () => {
    // A step may reject with a plain object. Stringifying it yields
    // "[object Object]" — the same loss of reason this boundary exists to stop.
    const id = 'test-nonerror-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Downloading);

    await expect(
      runStep({
        id,
        step: WorkloadState.Starting,
        fn: async () => {
          throw { code: 'ECONNRESET', detail: 'peer closed connection' };
        },
        timeoutMs: 5000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toBeTruthy();

    const metadata = await latestEventMetadata(id);
    expect(String(metadata.error)).toContain('ECONNRESET');
    expect(String(metadata.error)).not.toBe('[object Object]');
  });

  it('checkJobCompletion sets Errored when container exits non-zero (Running → Errored)', async () => {
    const { DockerManager } = await import('../../../src/api/services/docker');
    const stub = {
      getContainerStatus: vi.fn().mockResolvedValue({
        state: 'exited',
        exitCode: 1,
        logs: 'Process failed with exit code 1',
      }),
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return stub as any;
    });

    const id = 'test-errored-from-monitor-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(id, { ip: '1.1.1.1', cloudId: 'i-abc123' });
    await walkToState(id, WorkloadState.Running);

    await checkJobCompletion(persisted(), id, 'test-ssh-key', cloudConfig);

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Errored);
  });

  it('checkJobCompletion sets Completed when container exits 0 (Running → Completed)', async () => {
    const { DockerManager } = await import('../../../src/api/services/docker');
    const stub = {
      getContainerStatus: vi.fn().mockResolvedValue({
        state: 'exited',
        exitCode: 0,
      }),
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return stub as any;
    });

    const id = 'test-completed-from-monitor-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(id, { ip: '1.1.1.1', cloudId: 'i-abc123' });
    await walkToState(id, WorkloadState.Running);

    await checkJobCompletion(persisted(), id, 'test-ssh-key', cloudConfig);

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Completed);
  });

  it('checkJobCompletion stays Completed (not Terminated) after auto-cleanup', async () => {
    const { DockerManager } = await import('../../../src/api/services/docker');
    const stub = {
      getContainerStatus: vi.fn().mockResolvedValue({
        state: 'exited',
        exitCode: 0,
      }),
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return stub as any;
    });

    const id = 'test-auto-cleanup-completed-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(id, { ip: '1.1.1.1', cloudId: 'i-abc123' });
    await walkToState(id, WorkloadState.Running);

    await checkJobCompletion(persisted(), id, 'test-ssh-key', cloudConfig);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );

    await termination.terminate(cloudConfig, id);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );
  });

  it('checkJobCompletion with missing GPU leaves Retrying for reconciliation cleanup', async () => {
    const { DockerManager } = await import('../../../src/api/services/docker');
    const stub = {
      getContainerStatus: vi.fn().mockResolvedValue({
        state: 'exited',
        exitCode: 1,
        logs: 'operation cuInit(0) failed: CUDA_ERROR_NO_DEVICE',
      }),
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return stub as any;
    });

    const id = 'test-missing-gpu-retrying-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
      dockerOptions: { gpus: 'all' },
    });
    await provisionTestVm(id, { ip: '1.1.1.1', cloudId: 'i-abc123' });
    await walkToState(id, WorkloadState.Running);

    await checkJobCompletion(persisted(), id, 'test-ssh-key', cloudConfig);

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
    const vms = await queries().getVMs(id);
    expect(vms).toHaveLength(1);
  });

  it('checkJobCompletion treats missing GPU logs as Errored without GPU request', async () => {
    const { DockerManager } = await import('../../../src/api/services/docker');
    const stub = {
      getContainerStatus: vi.fn().mockResolvedValue({
        state: 'exited',
        exitCode: 1,
        logs: 'operation cuInit(0) failed: CUDA_ERROR_NO_DEVICE',
      }),
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return stub as any;
    });

    const id = 'test-missing-gpu-no-gpu-request-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(id, { ip: '1.1.1.1', cloudId: 'i-abc123' });
    await walkToState(id, WorkloadState.Running);

    await checkJobCompletion(persisted(), id, 'test-ssh-key', cloudConfig);

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Errored);
  });

  it('checkJobCompletion is a no-op when state is not Running (onlyIfIn guard)', async () => {
    const { DockerManager } = await import('../../../src/api/services/docker');
    const stub = {
      getContainerStatus: vi.fn().mockResolvedValue({
        state: 'exited',
        exitCode: 0,
      }),
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return stub as any;
    });

    const id = 'test-guard-non-running-' + Date.now();

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(id, { ip: '1.1.1.1', cloudId: 'i-abc123' });
    // Workload was concurrently moved to Terminated (e.g. user terminate)
    await walkToState(id, WorkloadState.Terminated);

    await checkJobCompletion(persisted(), id, 'test-ssh-key', cloudConfig);

    // Guard must have blocked the Completed write — state stays Terminated
    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Terminated);
  });
});
