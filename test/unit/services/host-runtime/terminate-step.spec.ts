/**
 * Tests for terminateStep/cleanupVMs cloud-before-DB ordering guarantee.
 *
 * Cloud termination must happen before VMs are soft-deleted from DB. If that
 * call fails, VMs remain visible for retry; once deletion is provider-confirmed,
 * the spend ledger is retired even if later network/DNS/storage cleanup fails.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  type MockInstance,
} from 'vitest';
import { randomBytes } from 'crypto';
import {
  getCredentialSecretStore,
  getWorkloadLifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../../src/api/services/persistence.js';
import {
  terminateStep,
  teardownVMs,
  teardownServiceVMs,
} from '../../../../src/api/services/host-runtime/termination';
import { DockerManager } from '../../../../src/api/services/docker.js';
import { SupervisorManager } from '../../../../src/api/services/supervisor.js';
import { completeWorkloadCleanup } from '../../../../src/api/services/workload-cleanup';
import { WorkloadOutcomeStore } from '../../../../src/api/services/repositories/workload-outcomes.js';
import { WorkloadQueryStore } from '../../../../src/api/services/repositories/workload-queries.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { resetTestStore } from '../../utils';
import { CloudType, type CloudConfig } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  encryptCredential,
  hashCredential,
  loadWorkloadConfigs,
} from '../../../../src/api/services/cloud-config';
import {
  makeMockCloudCompute,
  TEST_AWS_CRED,
  TEST_GCP_CRED,
} from '../../helpers/fixtures';
import type { CloudCompute } from '../../../../src/api/services/gateways/cloud.js';
import { getDB } from '../../../../src/api/services/repositories/db';
import { log } from '../../../../src/api/services/logger';

vi.mock('../../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    createComputeProvider: vi.fn(),
  };
});

vi.mock(
  '../../../../src/api/services/workload-storage',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../../../../src/api/services/workload-storage')
      >();
    return {
      ...real,
      cleanupManagedWorkloadStorage: vi.fn().mockResolvedValue(undefined),
    };
  },
);

vi.mock('../../../../src/shared/dns-worker', () => ({
  deleteDNSRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  '../../../../src/api/services/vm-runtime-storage',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../../../../src/api/services/vm-runtime-storage')
      >();
    return {
      ...real,
      // hasVmRuntimeStorage stays real so the diagnostics branch is entered on
      // its genuine condition; only the SSH round-trip is replaced.
      captureVmStorageDiagnostics: vi.fn().mockResolvedValue(undefined),
    };
  },
);

import { createComputeProvider } from '../../../../src/api/services/cloud-config';
import { cleanupManagedWorkloadStorage } from '../../../../src/api/services/workload-storage';
import { deleteDNSRecord } from '../../../../src/shared/dns-worker';
import { captureVmStorageDiagnostics } from '../../../../src/api/services/vm-runtime-storage';
import { TERMINAL_DIAGNOSTICS_TIMEOUT_MS } from '../../../../src/api/config';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import { Azure } from '../../../../src/api/services/gateways/azure';
import { AWS } from '../../../../src/api/services/gateways/aws';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';

// The local provider authenticates against nothing, so it carries no
// credentials; the field is optional precisely for it.
const cloudConfig: CloudConfig = {
  cloudProvider: CloudType.Local,
  region: 'local',
  vmType: 'local',
};

function scopedCompute(
  cfg: CloudConfig,
  mock: Partial<CloudCompute>,
): CloudCompute {
  return Object.assign(
    makeMockCloudCompute({
      type: cfg.cloudProvider,
      region: cfg.region ?? '',
    }),
    mock,
  );
}

function mockCompute(overrides: Record<string, any> = {}) {
  const mock = {
    // Default: pass-through (every vmId confirmed deleted). Tests for partial
    // failure override this to return a subset.
    terminateVMs: vi
      .fn()
      .mockImplementation((vmIds: string[]) => Promise.resolve(vmIds)),
    terminateNetworking: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.mocked(createComputeProvider).mockImplementation((cfg) =>
    scopedCompute(cfg, mock),
  );
  return mock;
}

describe('terminateStep - cloud-before-DB ordering', () => {
  beforeEach(async () => {
    await resetTestStore();
    config.cipherKey = 'a'.repeat(64);
    vi.clearAllMocks();
    vi.mocked(cleanupManagedWorkloadStorage).mockResolvedValue(undefined);
  });

  async function createWorkloadWithVMs(
    id: string,
    ips: string[],
    workloadType: 'job' | 'service' = 'job',
    state = WorkloadState.Running,
  ) {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType,
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    for (let i = 0; i < ips.length; i++) {
      await provisionTestVm(id, { ip: ips[i], cloudId: `i-cloud${i}` });
    }
    await walkToState(id, state);
  }

  it('leaves VMs in DB when cloud termination fails', async () => {
    const id = 'terminate-cloud-fail';
    await createWorkloadWithVMs(id, ['1.1.1.1', '2.2.2.2']);

    const mock = mockCompute({
      terminateVMs: vi.fn().mockRejectedValue(new Error('cloud API error')),
    });

    await expect(terminateStep(cloudConfig, id)).rejects.toThrow(
      'cloud API error',
    );

    expect(mock.terminateVMs).toHaveBeenCalledOnce();

    // VMs must still be queryable — soft-delete must not have happened yet
    const store = queries();
    const vms = await store.getVMs(id);
    expect(vms).toHaveLength(2);
    expect(vms.map((v) => v.cloudId)).toEqual(
      expect.arrayContaining(['i-cloud0', 'i-cloud1']),
    );
  });

  it('removes VMs from DB after successful cloud termination', async () => {
    const id = 'terminate-cloud-success';
    await createWorkloadWithVMs(id, ['1.1.1.1']);

    const mock = mockCompute();

    await terminateStep(cloudConfig, id);

    expect(mock.terminateVMs).toHaveBeenCalledWith(['i-cloud0']);
    expect(mock.terminateNetworking).toHaveBeenCalledWith(id);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('retries successfully after a prior cloud termination failure', async () => {
    const id = 'terminate-retry';
    await createWorkloadWithVMs(id, ['1.1.1.1']);

    // First attempt: cloud fails → VMs survive in DB
    mockCompute({
      terminateVMs: vi.fn().mockRejectedValue(new Error('transient error')),
    });

    await expect(terminateStep(cloudConfig, id)).rejects.toThrow();
    expect(await queries().getVMs(id)).toHaveLength(1);

    // Second attempt: cloud succeeds → VMs cleaned up.
    // Critically, terminateVMs must receive the cloudId that survived in DB —
    // if VMs had been wiped during the first failure, the retry would call with []
    // and cloud VMs would be leaked.
    const mock = mockCompute();

    await terminateStep(cloudConfig, id);
    expect(mock.terminateVMs).toHaveBeenCalledWith(['i-cloud0']);
    expect(mock.terminateNetworking).toHaveBeenCalledWith(id);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('records cleanup passes without adding events', async () => {
    const id = 'terminate-cleanup-pass-count';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    await walkToState(id, WorkloadState.Terminated);

    const compute = mockCompute({
      terminateVMs: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce((cloudIds: string[]) =>
          Promise.resolve(cloudIds),
        ),
    });
    const eventCount = (await eventLog().getWorkloadEvents(id)).length;

    await expect(
      completeWorkloadCleanup(cloudConfig, id, (workload) =>
        terminateStep(cloudConfig, id, workload),
      ),
    ).resolves.toBe(false);
    await expect(
      completeWorkloadCleanup(cloudConfig, id, (workload) =>
        terminateStep(cloudConfig, id, workload),
      ),
    ).resolves.toBe(true);

    expect((await eventLog().getWorkloadEvents(id)).length).toBe(eventCount);
    const rows = await getDB().query<{ cleanup_attempts: number | null }>(
      'SELECT cleanup_attempts FROM workloads WHERE id = ?',
      [id],
    );
    expect(rows[0]?.cleanup_attempts).toBe(2);
    expect(compute.terminateVMs).toHaveBeenCalledTimes(2);
  });

  it('records why cleanup is pending after each failed pass and clears it on success', async () => {
    const id = 'terminate-cleanup-error';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    const store = queries();
    await walkToState(id, WorkloadState.Terminated);
    const cleanupError = async () =>
      (
        await getDB().query<{ cleanup_error: string | null }>(
          'SELECT cleanup_error FROM workloads WHERE id = ?',
          [id],
        )
      )[0]?.cleanup_error;
    const run = () =>
      completeWorkloadCleanup(cloudConfig, id, (workload) =>
        terminateStep(cloudConfig, id, workload),
      );

    // First pass: the teardown itself throws (the F run 6 shape); the reason
    // lands on the workload, secrets redacted.
    mockCompute({
      terminateVMs: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'NamespaceDeletionDiscoveryFailure: token=ghp_abcdefghijklmnopqrstuvwxyz0123 rejected',
          ),
        ),
    });
    await expect(run()).rejects.toThrow('NamespaceDeletionDiscoveryFailure');
    expect(await cleanupError()).toBe(
      'NamespaceDeletionDiscoveryFailure: token=<REDACTED> rejected',
    );

    // Second pass: the provider answers but the VM row survives; the deferral
    // replaces the earlier reason.
    mockCompute({ terminateVMs: vi.fn().mockResolvedValueOnce([]) });
    await expect(run()).resolves.toBe(false);
    expect(await cleanupError()).toBe('VM still live after teardown: i-cloud0');
    await expect(store.getWorkload(id)).resolves.toMatchObject({
      cleanupError: 'VM still live after teardown: i-cloud0',
    });

    // Third pass succeeds: cleaned, and the reason is gone with it.
    mockCompute();
    await expect(run()).resolves.toBe(true);
    expect(await cleanupError()).toBeNull();
    await expect(store.getWorkload(id)).resolves.toMatchObject({
      cleanedAt: expect.any(Number),
      cleanupError: null,
    });
  });

  it('backstops the pass count when the entry write fails', async () => {
    const id = 'terminate-pass-counter-failed';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    await walkToState(id, WorkloadState.Terminated);
    vi.spyOn(getWorkloadOutcomes(), 'recordCleanupAttempt').mockResolvedValue(
      false,
    );
    mockCompute();

    await expect(
      completeWorkloadCleanup(cloudConfig, id, (workload) =>
        terminateStep(cloudConfig, id, workload),
      ),
    ).resolves.toBe(true);

    const rows = await getDB().query<{ cleanup_attempts: number | null }>(
      'SELECT cleanup_attempts FROM workloads WHERE id = ?',
      [id],
    );
    expect(rows[0]?.cleanup_attempts).toBe(1);
  });

  it('fences resubmission until external teardown and ledger retirement finish', async () => {
    const id = 'terminate-resubmit-race';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    const store = queries();
    await ledger().updateDnsRecordId(id, 'dns-before-resubmit');
    await walkToState(id, WorkloadState.Failed);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockCompute({
      terminateVMs: vi.fn(async (cloudIds: string[]) => {
        markStarted();
        await gate;
        return cloudIds;
      }),
    });

    const cleanup = completeWorkloadCleanup(cloudConfig, id, () =>
      terminateStep(cloudConfig, id),
    );
    await started;

    expect(await getWorkloadOutcomes().resubmitWorkload(id)).toBe(false);
    expect((await store.getWorkload(id))?.dnsRecordId).toBe(
      'dns-before-resubmit',
    );

    release();
    await cleanup;

    expect(deleteDNSRecord).toHaveBeenCalledWith('dns-before-resubmit', null);
    expect((await store.getWorkload(id))?.dnsRecordId).toBeNull();
    expect(await getWorkloadOutcomes().resubmitWorkload(id)).toBe(true);
  });

  it('tears down a VM provisioned before a URL-preserving Service upgrade', async () => {
    // beginServiceUpgrade resets started_at while the old VM is still live, so
    // a lifecycle window over attempt timestamps would drop it from cleanup —
    // leaking a billing VM and blocking markCleanupComplete forever.
    const id = 'terminate-after-upgrade';
    await createWorkloadWithVMs(id, ['1.1.1.1'], 'service');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await getWorkloadLifecycle().beginServiceUpgrade({
        id,
        image: 'test:v2',
        scope: { kind: 'api' },
        previousImage: 'test:latest',
        dockerCommand: 'docker run test',
        command: null,
        env: null,
      }),
    ).toBe(true);
    await walkToState(id, WorkloadState.Terminated);

    const mock = mockCompute();
    const cleaned = await completeWorkloadCleanup(cloudConfig, id, () =>
      terminateStep(cloudConfig, id),
    );

    expect(mock.terminateVMs).toHaveBeenCalledWith(['i-cloud0']);
    expect(mock.terminateNetworking).toHaveBeenCalledWith(id);
    expect(await queries().getVMs(id)).toHaveLength(0);
    expect(cleaned).toBe(true);
  });

  it('test:0036/S9 reconstructs accepted Service configuration while flushing and releasing the old VM first', async () => {
    const id = 'restart-upgraded-service';
    await createWorkload(getDB(), {
      id,
      userId: 'original-user',
      workloadType: 'service',
      image: 'nginx:old',
      command: ['old'],
      env: { VALUE: 'old' },
      githubToken: 'old-token',
      dockerCommand: 'old diagnostic',
      sshPrivateKey: 'test-key',
      requestedComputeProvider: CloudType.Local,
      checkpointBucket: 'durable-service-state',
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'old-service-host' },
      {
        bucketHostPaths: {
          input: '/input',
          output: '/output',
          checkpoint: '/old-host/checkpoint',
        },
      },
    );
    await walkToState(id, WorkloadState.Running);
    await ledger().updateDnsRecordId(id, 'preserved-dns');
    await getWorkloadLifecycle().beginServiceUpgrade({
      id,
      scope: { kind: 'api' },
      image: 'nginx:accepted',
      previousImage: 'nginx:old',
      command: ['accepted'],
      env: { VALUE: 'accepted' },
      githubToken: 'accepted-token',
      dockerCommand: 'accepted diagnostic',
    });
    const specs = await getDB().query('SELECT * FROM container_specs');
    // Reconstruct through a new repository instance; no in-memory upgrade payload survives.
    const restartedStore = new WorkloadQueryStore(getDB());
    const accepted = (await restartedStore.getWorkload(id))!;
    expect(accepted).toMatchObject({
      state: WorkloadState.Recovering,
      image: 'nginx:accepted',
      command: ['accepted'],
      env: { VALUE: 'accepted' },
      registryUsername: 'x-access-token',
      githubToken: 'accepted-token',
      dnsRecordId: 'preserved-dns',
      checkpointBucket: 'durable-service-state',
    });
    const stop = vi
      .spyOn(DockerManager.prototype, 'stopContainerGracefully')
      .mockResolvedValue(undefined);
    const stopSync = vi
      .spyOn(SupervisorManager.prototype, 'stopRcloneServices')
      .mockResolvedValue(undefined);
    const flush = vi
      .spyOn(SupervisorManager.prototype, 'runFinalCheckpointSync')
      .mockResolvedValue(undefined);
    const compute = mockCompute();
    try {
      await teardownServiceVMs(
        { ...cloudConfig, checkpointBucket: 'durable-service-state' },
        id,
      );
      expect(flush).toHaveBeenCalledWith(
        'durable-service-state',
        CloudType.Local,
        id,
        '1.1.1.1',
        expect.any(Number),
        '/old-host/checkpoint',
      );
      expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
        compute.terminateVMs.mock.invocationCallOrder[0],
      );
      expect(compute.terminateVMs).toHaveBeenCalledWith(['old-service-host']);
      expect(await restartedStore.getVMs(id)).toEqual([]);
      expect(await getDB().query('SELECT * FROM container_specs')).toEqual(
        specs,
      );
      const runtimeCommand = DockerManager.getCommand(
        (await restartedStore.getWorkload(id))!,
      );
      expect(runtimeCommand).toContain('nginx:accepted');
      expect(runtimeCommand).toContain('VALUE=accepted');
      expect(runtimeCommand).not.toContain('nginx:old');
      expect((await restartedStore.getWorkload(id))?.dnsRecordId).toBe(
        'preserved-dns',
      );
    } finally {
      stop.mockRestore();
      stopSync.mockRestore();
      flush.mockRestore();
    }
  });

  it('retires provider-confirmed compute before a later DNS failure', async () => {
    const id = 'terminate-dns-fail';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    await ledger().updateDnsRecordId(id, 'dns-record-1');
    const mock = mockCompute();
    vi.mocked(deleteDNSRecord).mockRejectedValueOnce(
      new Error('transient DNS error'),
    );

    await expect(terminateStep(cloudConfig, id)).rejects.toThrow(
      'transient DNS error',
    );

    expect(mock.terminateVMs).toHaveBeenCalledOnce();
    expect(mock.terminateNetworking).toHaveBeenCalledOnce();
    expect(await queries().getVMs(id)).toHaveLength(0);

    await terminateStep(cloudConfig, id);

    expect(mock.terminateVMs).toHaveBeenCalledOnce();
    expect(mock.terminateNetworking).toHaveBeenCalledTimes(2);
    expect((await queries().getWorkload(id))?.dnsRecordId).toBe(null);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('retries managed checkpoint cleanup before marking terminal cleanup complete', async () => {
    const id = 'terminate-checkpoint-fail';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    const store = queries();
    await walkToState(id, WorkloadState.Completed);
    const markCleanupComplete = vi.spyOn(
      WorkloadOutcomeStore.prototype,
      'markCleanupComplete',
    );
    const mock = mockCompute();
    vi.mocked(cleanupManagedWorkloadStorage)
      .mockRejectedValueOnce(new Error('transient storage error'))
      .mockResolvedValueOnce(undefined);
    const spotConfig = { ...cloudConfig, spot: true };

    await expect(
      completeWorkloadCleanup(spotConfig, id, () =>
        terminateStep(spotConfig, id),
      ),
    ).rejects.toThrow('transient storage error');
    expect(await store.getVMs(id)).toHaveLength(0);
    expect((await store.getWorkload(id))?.cleanedAt).toBeNull();
    expect(markCleanupComplete).not.toHaveBeenCalled();

    await expect(
      completeWorkloadCleanup(spotConfig, id, () =>
        terminateStep(spotConfig, id),
      ),
    ).resolves.toBe(true);

    expect(mock.terminateVMs).toHaveBeenCalledOnce();
    expect(mock.terminateNetworking).toHaveBeenCalledTimes(2);
    expect(cleanupManagedWorkloadStorage).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(cleanupManagedWorkloadStorage).mock.invocationCallOrder[1]!,
    ).toBeLessThan(markCleanupComplete.mock.invocationCallOrder[0]!);
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('cleans an Invalid Azure spot workload whose ID is not a valid container name', async () => {
    const id = 'x--y';
    await createWorkloadWithVMs(id, []);
    await walkToState(id, WorkloadState.Invalid);
    const azureConfig: CloudConfig = {
      cloudProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_B1s',
      spot: true,
      credentials: {
        subscriptionId: '11111111-2222-3333-4444-555555555555',
        directoryId: 'tenant',
        applicationId: 'app',
        secret: 'secret',
      },
    };
    const azure = new Azure(completeCloudConfig(azureConfig));
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(new Error('storage account probed'));
    const { cleanupManagedWorkloadStorage: realCleanup } =
      await vi.importActual<
        typeof import('../../../../src/api/services/workload-storage')
      >('../../../../src/api/services/workload-storage');
    vi.mocked(cleanupManagedWorkloadStorage).mockImplementation(
      (cfg, workloadId) =>
        realCleanup(cfg, workloadId, {
          input: () => azure.storage(),
          output: () => azure.storage(),
          checkpoint: () => azure.storage(),
        }),
    );
    const logError = vi.spyOn(log, 'error');

    await expect(
      completeWorkloadCleanup(azureConfig, id, async () => {}),
    ).resolves.toBe(true);

    expect((await queries().getWorkload(id))?.cleanedAt).not.toBeNull();
    expect(findStorageAccount).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('resource teardown preserves a managed checkpoint for terminal cleanup', async () => {
    const id = 'teardown-preserves-managed-checkpoint';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    const mock = mockCompute();

    await terminateStep({ ...cloudConfig, spot: true }, id);

    expect(mock.terminateVMs).toHaveBeenCalledOnce();
    expect(cleanupManagedWorkloadStorage).not.toHaveBeenCalled();
  });

  it('preserves managed storage while a provider-backed attempt remains live', async () => {
    const id = 'cleanup-preserves-checkpoint-with-live-attempt';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    const store = queries();
    await walkToState(id, WorkloadState.Completed);
    mockCompute({
      terminateVMs: vi.fn().mockResolvedValue([]),
    });
    const spotConfig = { ...cloudConfig, spot: true };

    await expect(
      completeWorkloadCleanup(spotConfig, id, () =>
        terminateStep(spotConfig, id),
      ),
    ).resolves.toBe(false);

    expect(await store.getVMs(id)).toHaveLength(1);
    expect(cleanupManagedWorkloadStorage).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.cleanedAt).toBeNull();
  });

  it('preserves input, output, and explicitly named checkpoint buckets', async () => {
    const id = 'terminate-explicit-checkpoint';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    const store = queries();
    await walkToState(id, WorkloadState.Completed);
    const mock = mockCompute();
    const explicitBuckets = {
      ...cloudConfig,
      spot: true,
      inputBucket: 'user-owned-input',
      outputBucket: 'user-owned-output',
      checkpointBucket: 'user-owned-state',
    };

    await expect(
      completeWorkloadCleanup(explicitBuckets, id, () =>
        terminateStep(explicitBuckets, id),
      ),
    ).resolves.toBe(true);

    expect(cleanupManagedWorkloadStorage).toHaveBeenCalledWith(
      explicitBuckets,
      id,
    );
    expect(mock.terminateVMs).toHaveBeenCalledOnce();
    expect(await store.getVMs(id)).toHaveLength(0);
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('teardownVMs only terminates VMs without networking', async () => {
    const id = 'teardown-vms-only';
    await createWorkloadWithVMs(id, ['1.1.1.1']);

    const mock = mockCompute();

    await teardownVMs(cloudConfig, id);

    expect(mock.terminateVMs).toHaveBeenCalledWith(['i-cloud0']);
    expect(mock.terminateNetworking).not.toHaveBeenCalled();
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('teardownVMs is a no-op when there are no VM attempt rows', async () => {
    const id = 'teardown-no-attempts';
    await createWorkloadWithVMs(id, []);

    mockCompute();

    await teardownVMs(cloudConfig, id);

    expect(createComputeProvider).not.toHaveBeenCalled();
  });

  it('terminateStep still cleans networking when there are no VM attempt rows', async () => {
    const id = 'terminate-no-attempts';
    await createWorkloadWithVMs(id, []);

    const mock = mockCompute();

    await terminateStep(cloudConfig, id);

    expect(mock.terminateVMs).not.toHaveBeenCalled();
    expect(mock.terminateNetworking).toHaveBeenCalledWith(id);
  });

  it('partial cloud failure: only confirmed-deleted VMs are soft-deleted', async () => {
    const id = 'terminate-partial';
    await createWorkloadWithVMs(id, ['1.1.1.1', '2.2.2.2', '3.3.3.3']);

    // Cloud confirms i-cloud0 and i-cloud2 deleted; i-cloud1 stays live.
    const mock = mockCompute({
      terminateVMs: vi.fn().mockResolvedValue(['i-cloud0', 'i-cloud2']),
    });

    await terminateStep(cloudConfig, id);

    expect(mock.terminateVMs).toHaveBeenCalledWith([
      'i-cloud0',
      'i-cloud1',
      'i-cloud2',
    ]);
    const live = await queries().getVMs(id);
    expect(live.map((v) => v.cloudId)).toEqual(['i-cloud1']);
  });

  it('empty success set: no rows soft-deleted, workload remains a cleanup candidate', async () => {
    const id = 'terminate-empty-success';
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    await walkToState(id, WorkloadState.Terminated);

    mockCompute({
      terminateVMs: vi.fn().mockResolvedValue([]),
    });

    await terminateStep(cloudConfig, id);

    // VM still live — cleanup reconciliation will retry.
    expect(await queries().getVMs(id)).toHaveLength(1);
    const candidate = await queries().getWorkloadReconcileCandidate(id);
    expect(candidate).toMatchObject({ id });
  });

  it('includes unresolved provisioning attempts in the cloud cleanup call', async () => {
    const id = 'terminate-with-failed-rows';
    await createWorkloadWithVMs(
      id,
      ['1.1.1.1'],
      'job',
      WorkloadState.Provisioning,
    );
    for (const cloudId of ['i-failed-a', 'i-failed-b']) {
      await provisionTestVm(id, { cloudId }, { region: 'us-east-1' });
    }
    await walkToState(id, WorkloadState.Running);

    const mock = mockCompute();

    await terminateStep(cloudConfig, id);

    // Failed provisioning placeholders flow through cleanup even when their
    // recorded region/type places them in a separate provider call.
    expect(
      mock.terminateVMs.mock.calls.flatMap(([cloudIds]) => cloudIds),
    ).toEqual(expect.arrayContaining(['i-cloud0', 'i-failed-a', 'i-failed-b']));
    // All confirmed-deleted IDs (including the placeholders, since mockCompute
    // pass-through returns the input) get ended_at set.
    const live = await queries().getVMs(id);
    expect(live).toHaveLength(0);
  });

  it('excludes already-retired attempts from provider cleanup', async () => {
    const id = 'terminate-active-attempts-only';
    await createWorkloadWithVMs(
      id,
      ['1.1.1.1'],
      'job',
      WorkloadState.Provisioning,
    );
    await releaseTestVms(id, 'i-cloud0');
    await provisionTestVm(id, {
      ip: '2.2.2.2',
      cloudId: 'i-current',
    });
    await walkToState(id, WorkloadState.Running);
    const mock = mockCompute();

    await terminateStep(cloudConfig, id);

    expect(mock.terminateVMs).toHaveBeenCalledWith(['i-current']);
  });

  it('separates cleanup groups that share credentials across regions', async () => {
    const id = 'terminate-same-credential-regions';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'east-vm' },
      { region: 'us-east-1', vmType: 'small' },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'west-vm' },
      { region: 'us-west-2', vmType: 'small' },
    );
    await walkToState(id, WorkloadState.Running);
    const east = mockCompute();
    const west = mockCompute();
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      scopedCompute(cfg, cfg.region === 'us-east-1' ? east : west),
    );

    await terminateStep(cloudConfig, id);

    expect(east.terminateVMs).toHaveBeenCalledWith(['east-vm']);
    expect(west.terminateVMs).toHaveBeenCalledWith(['west-vm']);
  });

  it('0047 finishes AWS Job cleanup after a region the credential may not use', async () => {
    // The Job left ap-south-1 on an EC2 regional denial and ran in us-east-1.
    // Jobs attach the shared security group, so teardown owes neither region
    // an EC2 networking call — the denied region included.
    const id = 'terminate-aws-denied-region';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'denied-placeholder' },
      { region: 'ap-south-1', vmType: 'c6i.xlarge' },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'i-0123456789abcdef0' },
      { region: 'us-east-1', vmType: 'c6i.xlarge' },
    );
    await walkToState(id, WorkloadState.Running);
    const ec2Sends = new Map<string, ReturnType<typeof vi.fn>>();
    vi.mocked(createComputeProvider).mockImplementation((cfg) => {
      const aws = new AWS(completeCloudConfig(cfg));
      const send = vi.fn().mockRejectedValue(
        Object.assign(new Error('not authorized to perform: ec2:*'), {
          name: 'UnauthorizedOperation',
          Code: 'UnauthorizedOperation',
        }),
      );
      const ec2client = { send };
      aws.ec2client = ec2client as unknown as typeof aws.ec2client;
      ec2Sends.set(cfg.region!, send);
      return Object.assign(aws.compute(), {
        terminateVMs: vi.fn(async (ids: string[]) => ids),
      });
    });

    await terminateStep(
      {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 'c6i.xlarge',
        credentials: TEST_AWS_CRED,
      },
      id,
    );

    expect([...ec2Sends.keys()].sort()).toEqual(['ap-south-1', 'us-east-1']);
    for (const send of ec2Sends.values()) expect(send).not.toHaveBeenCalled();
  });

  it('separates GCP cleanup groups by the persisted availability zone', async () => {
    const id = 'terminate-gcp-same-region-zones';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'zone-b-vm' },
      {
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'zone-f-vm' },
      {
        region: 'us-central1',
        availabilityZone: 'f',
        vmType: 'g4-standard-48',
      },
    );
    await walkToState(id, WorkloadState.Running);

    const zoneB = mockCompute();
    const zoneF = mockCompute();
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      scopedCompute(cfg, cfg.availabilityZone === 'b' ? zoneB : zoneF),
    );

    await teardownVMs(
      {
        cloudProvider: CloudType.GCP,
        credentials: TEST_GCP_CRED,
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
      id,
    );

    expect(vi.mocked(createComputeProvider).mock.calls).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ availabilityZone: 'b' }), 'observed-vm'],
        [expect.objectContaining({ availabilityZone: 'f' }), 'observed-vm'],
      ]),
    );
    expect(zoneB.terminateVMs).toHaveBeenCalledWith(['zone-b-vm']);
    expect(zoneF.terminateVMs).toHaveBeenCalledWith(['zone-f-vm']);
  });

  it('soft-deletes only the GCP zone group whose provider confirms absence', async () => {
    const id = 'terminate-gcp-zone-partial-confirmation';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'zone-b-confirmed' },
      {
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'zone-f-unknown' },
      {
        region: 'us-central1',
        availabilityZone: 'f',
        vmType: 'g4-standard-48',
      },
    );
    await walkToState(id, WorkloadState.Running);

    const zoneB = mockCompute({
      terminateVMs: vi.fn().mockResolvedValue(['zone-b-confirmed']),
    });
    const zoneF = mockCompute({
      terminateVMs: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      scopedCompute(cfg, cfg.availabilityZone === 'b' ? zoneB : zoneF),
    );

    await teardownVMs(
      {
        cloudProvider: CloudType.GCP,
        credentials: TEST_GCP_CRED,
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
      id,
    );

    expect((await queries().getVMs(id)).map((vm) => vm.cloudId)).toEqual([
      'zone-f-unknown',
    ]);
  });

  it('isolates legacy GCP attempts and clears inherited zones for discovery', async () => {
    const id = 'terminate-gcp-legacy-zone-discovery';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'known-zone-vm' },
      {
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'legacy-zone-vm' },
      { region: 'us-central1', vmType: 'g4-standard-48' },
    );
    await walkToState(id, WorkloadState.Running);

    const knownZone = mockCompute();
    const legacyDiscovery = mockCompute();
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      scopedCompute(
        cfg,
        cfg.availabilityZone === undefined ? legacyDiscovery : knownZone,
      ),
    );

    await teardownVMs(
      {
        cloudProvider: CloudType.GCP,
        credentials: TEST_GCP_CRED,
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
      id,
    );

    expect(
      vi
        .mocked(createComputeProvider)
        .mock.calls.map(([cfg]) => cfg.availabilityZone),
    ).toEqual(['b', undefined]);
    expect(knownZone.terminateVMs).toHaveBeenCalledWith(['known-zone-vm']);
    expect(legacyDiscovery.terminateVMs).toHaveBeenCalledWith([
      'legacy-zone-vm',
    ]);
  });

  it('keeps the other scoped attempt live when equal native IDs receive different release results', async () => {
    const id = 'same-native-id-different-zones';
    await createWorkloadWithVMs(id, [], 'job', WorkloadState.Provisioning);
    for (const [zone, ip] of [
      ['b', '1.1.1.1'],
      ['f', '2.2.2.2'],
    ]) {
      await provisionTestVm(
        id,
        {
          cloudId: 'same-native-id',
          ip: ip!,
          createdAt: zone === 'b' ? 100 : 200,
        },
        {
          region: 'us-central1',
          availabilityZone: zone,
          vmType: 'e2-standard-2',
        },
      );
    }
    await walkToState(id, WorkloadState.Running);
    const zoneB = mockCompute({
      terminateVMs: vi.fn().mockResolvedValue(['same-native-id']),
    });
    const zoneF = mockCompute({ terminateVMs: vi.fn().mockResolvedValue([]) });
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      scopedCompute(cfg, cfg.availabilityZone === 'b' ? zoneB : zoneF),
    );

    await teardownVMs(
      {
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'e2-standard-2',
        credentials: TEST_GCP_CRED,
      },
      id,
    );

    const attempts = await ledger().getProvisioningAttempts(id);
    expect(attempts).toHaveLength(2);
    expect(
      attempts.find((row) => row.availability_zone === 'b')?.ended_at,
    ).toEqual(expect.any(Number));
    expect(
      attempts.find((row) => row.availability_zone === 'f')?.ended_at,
    ).toBeNull();
    expect(attempts.every((row) => row.removal_requested_at !== null)).toBe(
      true,
    );
    expect(zoneB.terminateVMs).toHaveBeenCalledExactlyOnceWith([
      'same-native-id',
    ]);
    expect(zoneF.terminateVMs).toHaveBeenCalledExactlyOnceWith([
      'same-native-id',
    ]);
    expect(zoneB.terminateNetworking).not.toHaveBeenCalled();
    expect(zoneF.terminateNetworking).not.toHaveBeenCalled();
  });

  it('routes cross-cloud cleanup attempts to the provider for each attempt credential', async () => {
    const id = 'terminate-cross-cloud-attempts';
    await upsertCredential(
      getDB(),
      'aws-cred',
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await upsertCredential(
      getDB(),
      'gcp-cred',
      await encryptCredential(TEST_GCP_CRED),
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: null,
      vmType: ['t3.small', 'e2-standard-2'],
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'aws-live' },
      { credentialId: 'aws-cred', region: 'us-east-1', vmType: 't3.small' },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'gcp-live' },
      {
        credentialId: 'gcp-cred',
        region: 'us-central1',
        vmType: 'e2-standard-2',
      },
    );
    await provisionTestVm(
      id,
      { cloudId: 'aws-failed' },
      { region: 'us-east-1', vmType: 't3.small', credentialId: 'aws-cred' },
    );
    await walkToState(id, WorkloadState.Running);

    const awsCompute = mockCompute();
    const gcpCompute = mockCompute();
    vi.mocked(createComputeProvider).mockImplementation((cfg) =>
      scopedCompute(
        cfg,
        cfg.cloudProvider === CloudType.AWS ? awsCompute : gcpCompute,
      ),
    );

    await terminateStep(
      {
        cloudProvider: CloudType.GCP,
        credentials: TEST_GCP_CRED,
        region: 'us-central1',
        vmType: 'e2-standard-2',
      },
      id,
    );

    const computeConfigs = vi
      .mocked(createComputeProvider)
      .mock.calls.map(([cfg]) => cfg);
    expect(computeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.small',
        }),
        expect.objectContaining({
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          vmType: 'e2-standard-2',
        }),
      ]),
    );
    expect(awsCompute.terminateVMs).toHaveBeenCalledWith([
      'aws-live',
      'aws-failed',
    ]);
    expect(gcpCompute.terminateVMs).toHaveBeenCalledWith(['gcp-live']);
    expect(awsCompute.terminateNetworking).toHaveBeenCalledWith(id);
    expect(gcpCompute.terminateNetworking).toHaveBeenCalledWith(id);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('keeps unrecorded region-scoped attempt zones unknown instead of borrowing the latest zone', async () => {
    const id = 'terminate-aws-unknown-zone';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: 'true',
      sshPrivateKey: 'test-key',
      credentialId: null,
    });
    await provisionTestVm(
      id,
      { cloudId: 'old-attempt' },
      { region: 'us-east-1', vmType: 't3.medium' },
    );
    const compute = mockCompute();

    await teardownVMs(
      {
        cloudProvider: CloudType.AWS,
        credentials: TEST_AWS_CRED,
        region: 'us-east-1',
        vmType: 't3.medium',
        availabilityZone: 'us-east-1c',
      },
      id,
    );

    expect(createComputeProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        availabilityZone: undefined,
      }),
      'observed-vm',
    );
    expect(compute.terminateVMs).toHaveBeenCalledExactlyOnceWith([
      'old-attempt',
    ]);
    expect((await ledger().getProvisioningAttempts(id))[0]?.ended_at).toEqual(
      expect.any(Number),
    );
  });

  it('tears down on schedule when pre-teardown diagnostics never answer', async () => {
    // The diagnostics SSH round-trip runs ahead of the terminate call, on every
    // cleanup attempt, against a box that a stalled teardown has already shown
    // to be suspect. Unbounded, it bills full VM rate while it hangs.
    const id = 'terminate-diagnostics-wedged';
    const store = queries();
    await createWorkloadWithVMs(id, ['1.1.1.1']);
    await walkToState(id, WorkloadState.Terminated);
    // hasVmRuntimeStorage reads the placement config, so a bucket here is what
    // arms the diagnostics branch.
    const storageConfig = { ...cloudConfig, inputBucket: 'in' };

    vi.mocked(captureVmStorageDiagnostics).mockImplementation(
      () => new Promise(() => {}),
    );
    const mock = mockCompute();

    vi.useFakeTimers();
    try {
      const cleanup = completeWorkloadCleanup(storageConfig, id, () =>
        terminateStep(storageConfig, id),
      );
      await vi.waitFor(() =>
        expect(captureVmStorageDiagnostics).toHaveBeenCalledOnce(),
      );
      await vi.advanceTimersByTimeAsync(TERMINAL_DIAGNOSTICS_TIMEOUT_MS + 1);
      expect(await cleanup).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    expect(mock.terminateVMs).toHaveBeenCalledWith(['i-cloud0']);
    expect(await store.getVMs(id)).toHaveLength(0);
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('reports the deferral when only an IP-less attempt blocks cleanup', async () => {
    // getVMs hides rows with no IP; markCleanupComplete fences on every un-ended
    // row. A failed provisioning attempt therefore defers cleanup past both the
    // live-VM guard and its log, which is exactly the invisible teardown this
    // logging exists to end.
    const id = 'terminate-unresolved-attempt';
    const store = queries();
    await createWorkloadWithVMs(id, [], 'job', WorkloadState.Provisioning);
    await provisionTestVm(id, { cloudId: 'i-never-confirmed' });
    await walkToState(id, WorkloadState.Running);
    await walkToState(id, WorkloadState.Terminated);
    mockCompute({ terminateVMs: vi.fn().mockResolvedValue([]) });

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      expect(
        await completeWorkloadCleanup(cloudConfig, id, () =>
          terminateStep(cloudConfig, id),
        ),
      ).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unretired provisioning attempts'),
        expect.objectContaining({ id, cloudIds: ['i-never-confirmed'] }),
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect((await store.getWorkload(id))?.cleanedAt).toBeNull();
  });

  // The wait is measured from this stamp, so it has to be durable before the
  // provider call and stable across the retries that follow a failure.
  const removalRequestedAt = async (cloudId: string) => {
    const [row] = await getDB().query<{ removal_requested_at: number | null }>(
      `SELECT removal_requested_at FROM vms WHERE cloud_id = ?`,
      [cloudId],
    );
    return row?.removal_requested_at ?? null;
  };

  it('records the removal request before asking the provider to terminate', async () => {
    const id = 'terminate-stamp-ordering';
    await createWorkloadWithVMs(id, ['1.1.1.1']);

    let stampAtCallTime: number | null = null;
    mockCompute({
      terminateVMs: vi.fn().mockImplementation(async (vmIds: string[]) => {
        stampAtCallTime = await removalRequestedAt('i-cloud0');
        return vmIds;
      }),
    });

    await terminateStep(cloudConfig, id);

    expect(stampAtCallTime).not.toBeNull();
  });

  it('keeps the original request timestamp across a failed terminate', async () => {
    const id = 'terminate-stamp-survives-failure';
    await createWorkloadWithVMs(id, ['1.1.1.1']);

    mockCompute({
      terminateVMs: vi.fn().mockRejectedValue(new Error('transient error')),
    });
    await expect(terminateStep(cloudConfig, id)).rejects.toThrow();
    const first = await removalRequestedAt('i-cloud0');
    expect(first).not.toBeNull();

    // Re-stamping on each cleanup attempt would keep resetting the reported
    // wait, hiding exactly the overrun this is meant to expose.
    await new Promise((r) => setTimeout(r, 5));
    mockCompute();
    await terminateStep(cloudConfig, id);

    expect(await removalRequestedAt('i-cloud0')).toBe(first);
  });

  const cleanupGroupLogs = (info: MockInstance<typeof log.info>) =>
    info.mock.calls
      .filter(([message]) => message === 'Terminating VM cleanup group')
      .map(([, fields]) => fields);

  it('labels cleanup-configuration fallbacks apart from recorded placement', async () => {
    const id = 'terminate-labels-fallback-placement';
    await createWorkloadWithVMs(id, [], 'job', WorkloadState.Provisioning);
    await provisionTestVm(id, { cloudId: 'legacy-vm' });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'same-placement-vm' },
      { region: 'local', vmType: 'local' },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'recorded-vm' },
      { region: 'local-2', vmType: 'local-large' },
    );
    await walkToState(id, WorkloadState.Running);
    mockCompute();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      await terminateStep(cloudConfig, id);
      const groups = cleanupGroupLogs(info);
      // The null-placement row shares its group with an equal recorded one, so
      // the group is legacy; the credentialless provider needs no credential.
      expect(groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            region: 'local',
            vmType: 'local',
            cloudIds: expect.arrayContaining([
              'legacy-vm',
              'same-placement-vm',
            ]),
            attempt: 'legacy',
            missing: ['region', 'vmType'],
            fallback: { region: 'local', vmType: 'local' },
          }),
          expect.objectContaining({
            region: 'local-2',
            vmType: 'local-large',
            cloudIds: ['recorded-vm'],
            attempt: 'recorded',
          }),
        ]),
      );
      expect(groups).toHaveLength(2);
      expect(
        groups.find((group) => group?.attempt === 'recorded'),
      ).not.toHaveProperty('fallback');
    } finally {
      info.mockRestore();
    }
    expect(vi.mocked(createComputeProvider).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({ region: 'local', vmType: 'local' }),
          'observed-vm',
        ],
        [
          expect.objectContaining({ region: 'local-2', vmType: 'local-large' }),
          'observed-vm',
        ],
      ]),
    );
  });

  it('labels a GCP attempt without credential or zone for provider discovery', async () => {
    const id = 'terminate-gcp-legacy-label';
    await upsertCredential(
      getDB(),
      'gcp-cred',
      await encryptCredential(TEST_GCP_CRED),
      CloudType.GCP,
    );
    await createWorkloadWithVMs(id, [], 'job', WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'recorded-zone-vm' },
      {
        credentialId: 'gcp-cred',
        region: 'us-central1',
        availabilityZone: 'b',
        vmType: 'g4-standard-48',
      },
    );
    await provisionTestVm(
      id,
      { ip: '2.2.2.2', cloudId: 'legacy-zone-vm' },
      { region: 'us-central1', vmType: 'g4-standard-48' },
    );
    await walkToState(id, WorkloadState.Running);
    mockCompute();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      await teardownVMs(
        {
          cloudProvider: CloudType.GCP,
          credentials: TEST_GCP_CRED,
          region: 'us-central1',
          availabilityZone: 'b',
          vmType: 'g4-standard-48',
        },
        id,
      );
      expect(cleanupGroupLogs(info)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cloudIds: ['recorded-zone-vm'],
            availabilityZone: 'b',
            attempt: 'recorded',
          }),
          expect.objectContaining({
            cloudIds: ['legacy-zone-vm'],
            availabilityZone: undefined,
            attempt: 'legacy',
            missing: ['credential', 'zone'],
            fallback: {},
          }),
        ]),
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Legacy cleanup attempt requires provider-wide zone discovery',
        expect.objectContaining({ id, cloud: CloudType.GCP, attemptCount: 1 }),
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it.each([
    ['its workload is gone', /workload not found/],
    ['its configuration is null', /credential aws-cred not found/],
  ])(
    'fails cleanup preparation for a recorded credential when %s',
    async (condition, error) => {
      const id = `terminate-unloadable-${condition.split(' ')[1]}`;
      await upsertCredential(
        getDB(),
        'aws-cred',
        await encryptCredential(TEST_AWS_CRED),
        CloudType.AWS,
      );
      await createWorkloadWithVMs(id, [], 'job', WorkloadState.Provisioning);
      await provisionTestVm(
        id,
        { ip: '1.1.1.1', cloudId: 'recorded-vm' },
        { credentialId: 'aws-cred', region: 'us-east-1', vmType: 't3' },
      );
      await walkToState(id, WorkloadState.Running);
      mockCompute();
      const unloadable = condition.includes('workload')
        ? vi.spyOn(queries(), 'getWorkload')
        : vi.spyOn(
            getCredentialSecretStore(),
            'getCredentialWithCloudProvider',
          );
      unloadable.mockResolvedValue(null);
      try {
        await expect(teardownVMs(cloudConfig, id)).rejects.toThrow(error);
      } finally {
        unloadable.mockRestore();
      }
      expect(createComputeProvider).not.toHaveBeenCalled();
      expect(await removalRequestedAt('recorded-vm')).toBeNull();
      expect(await queries().getVMs(id)).toHaveLength(1);
    },
  );

  it('keeps the placements it read when the credential and attempts change during provider termination', async () => {
    const id = 'terminate-race-during-provider-call';
    const credentials = getCredentialSecretStore();
    const recorded = { ...TEST_AWS_CRED, secretAccessKey: 'recorded-secret' };
    const rotated = { ...TEST_AWS_CRED, secretAccessKey: 'rotated-secret' };
    const recordedId = await credentials.saveNamedCredential(
      'prod',
      hashCredential(recorded),
      await encryptCredential(recorded),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test:latest',
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-ssh-key',
      credentialId: recordedId,
    });
    await provisionTestVm(
      id,
      { ip: '1.1.1.1', cloudId: 'recorded-vm' },
      { credentialId: recordedId, region: 'us-east-1', vmType: 't3.small' },
    );
    // A second launch the provider had nothing to remove for when it was
    // released; its VM resolves only while termination is in flight.
    const lateAttempt = await provisionTestVm(
      id,
      { cloudId: 'late-vm' },
      { credentialId: recordedId, region: 'us-east-1', vmType: 't3.small' },
    );
    await releaseTestVms(id, 'late-vm');
    await walkToState(id, WorkloadState.Running);
    await walkToState(id, WorkloadState.Terminated);
    let finishTermination!: () => void;
    const compute = mockCompute({
      terminateVMs: vi.fn(
        (cloudIds: string[]) =>
          new Promise<string[]>((resolve) => {
            finishTermination = () => resolve(cloudIds);
          }),
      ),
    });
    const fallback: CloudConfig = {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-west-2',
      vmType: 't3.large',
    };
    // Spy below the logger so its redaction is part of what is checked.
    const logged = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const cleanup = completeWorkloadCleanup(fallback, id, (workload) =>
        terminateStep(fallback, id, workload),
      );
      await vi.waitFor(() => expect(compute.terminateVMs).toHaveBeenCalled());
      // While the provider call is pending, the named credential rotates to a
      // new id, the recorded one starts failing auth, and the late launch
      // resolves its VM, reviving its released attempt.
      await credentials.saveNamedCredential(
        'prod',
        hashCredential(rotated),
        await encryptCredential(rotated),
        CloudType.AWS,
      );
      await credentials.markCredentialAuthFailed(recordedId);
      await ledger().completeProvisioningAttempt(id, lateAttempt, {
        ip: '2.2.2.2',
        cloudId: 'late-vm',
      });
      finishTermination();

      // The pass keeps the gateway it bound before the call, so networking
      // uses the recorded credential and region rather than the rotated
      // credential or the fallback; the completion fence re-reads the ledger
      // after the call, so the late attempt keeps cleanup open.
      await expect(cleanup).resolves.toBe(false);
      expect(vi.mocked(createComputeProvider).mock.calls).toEqual([
        [
          expect.objectContaining({
            cloudProvider: CloudType.AWS,
            credentials: expect.objectContaining({
              secretAccessKey: 'recorded-secret',
            }),
            region: 'us-east-1',
            vmType: 't3.small',
          }),
          'observed-vm',
        ],
      ]);
      expect(compute.terminateVMs).toHaveBeenCalledExactlyOnceWith([
        'recorded-vm',
      ]);
      expect(compute.terminateNetworking).toHaveBeenCalledExactlyOnceWith(id);
      expect((await queries().getVMs(id)).map((vm) => vm.cloudId)).toEqual([
        'late-vm',
      ]);
      expect(await removalRequestedAt('late-vm')).toBeNull();
      const workload = await queries().getWorkload(id);
      expect(workload?.cleanedAt).toBeNull();
      const written = JSON.stringify([
        logged.map((spy) => spy.mock.calls),
        workload,
        await eventLog().getWorkloadEvents(id),
      ]);
      expect(written).not.toContain('recorded-secret');
      expect(written).not.toContain('rotated-secret');
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });
});

describe('terminal cleanup after a confirmed-missing VM host', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  // Every cloud id the stubbed provider was asked to delete, so the test can
  // assert which ledger rows cleanup still owns.
  const terminatedVmIds: string[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    terminatedVmIds.length = 0;
    mockCompute({
      terminateVMs: vi.fn(async (vmIds: string[]) => {
        terminatedVmIds.push(...vmIds);
        return vmIds;
      }),
    });
    await resetTestStore();
  });

  // A provider that no longer lists the VM has usually kept its
  // directly-attached resources (Azure leaves the disk, NIC, and public IP
  // behind). Cleanup builds its delete set from unended ledger rows, so the
  // failure transition must leave the row live or those resources are never
  // released and markCleanupComplete commits over them. Azure's OS disk is the
  // known exception: terminateVM reads its name off the VM, so a host deleted
  // outside Anycloud orphans the disk until the standalone-disk sweep in
  // the account resource sweep reclaims it.
  it('still deletes the missing host so its attached resources are released', async () => {
    const id = 'vm-host-missing-cleanup';
    const credentialId = hashCredential(TEST_AWS_CRED);
    await upsertCredential(
      getDB(),
      credentialId,
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'vm',
      image: 'ghcr.io/acme/dev:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      dockerCommand: 'docker run vm',
      sshPrivateKey: 'private-key',
      credentialId,
    });
    await provisionTestVm(
      id,
      { ip: '203.0.113.50', cloudId: 'i-missing' },
      { region: 'us-east-1', vmType: 't3.large', credentialId },
    );
    await walkToState(id, WorkloadState.Running);

    expect(
      await getWorkloadOutcomes().failMissingVmHost(
        id,
        { ip: '203.0.113.50', cloudId: 'i-missing' },
        { reason: 'host gone' },
      ),
    ).toBe(true);

    const workload = (await queries().getWorkload(id))!;
    const cloudConfig = (await loadWorkloadConfigs(workload))!;
    await terminateStep(cloudConfig, id);

    expect(terminatedVmIds).toEqual(['i-missing']);
    expect(await queries().getVMs(id)).toEqual([]);
    expect(await getWorkloadOutcomes().markCleanupComplete(id)).toBe(true);
  });
});
