import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  transport: {},
}));

const storeMocks = vi.hoisted(() => ({
  getWorkload: vi.fn(),
  getVMs: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  getLatestRunningAndProvisioningEventIds: vi.fn(),
}));

const computeMocks = vi.hoisted(() => ({
  releaseConfirmationPolicy: {
    requiredReleaseObservations: 1,
    minObservationIntervalMs: 0,
  },
  observeVMReleaseOnce: vi.fn(),
}));

const storageProviderMocks = vi.hoisted(() => ({
  createOutput: vi.fn(),
  createCheckpoint: vi.fn(),
}));

vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => transportMocks.transport),
}));

vi.mock('../../../src/api/services/persistence', () => ({
  getWorkloadQueryStore: () => storeMocks,
  getWorkloadEventStore: () => eventMocks,
}));

vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/api/services/cloud-config')
  >()),
  createComputeProvider: (
    cloudConfig: import('../../../src/shared/cloud.js').CloudConfig,
  ) => ({
    ...computeMocks,
    type: cloudConfig.cloudProvider,
    region: cloudConfig.region ?? '',
  }),
  loadWorkloadConfigs: vi.fn(),
  createOutputStorageProvider: storageProviderMocks.createOutput,
  createCheckpointStorageProvider: storageProviderMocks.createCheckpoint,
}));

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  configureAndHydrateVmStorage,
  hasVmRuntimeStorage,
  mountsForVmStorage,
  quiesceVmServiceStorage,
  renewAt,
  resolveFinalSyncCloud,
  syncFinalVmJobArtifacts,
  vmStorageHydrationTimeoutMs,
} from '../../../src/api/services/vm-runtime-storage';
import * as cloudProviders from '../../../src/api/services/cloud-config.js';
import { SupervisorManager } from '../../../src/api/services/supervisor';
import { DockerManager } from '../../../src/api/services/docker';
import { VMReleaseState } from '../../../src/api/services/gateways/cloud';
import { RCLONE_INIT_TIMEOUT_MS } from '../../../src/api/config';
import { DeployError } from '../../../src/shared/errors';
import packageJson from '../../../package.json' with { type: 'json' };
import { type StoredWorkload } from '../../../src/api/services/workload-record.js';
import { CloudType, type CloudConfig } from '../../../src/shared/cloud.js';
import { WorkloadType } from '../../../src/shared/workload.js';
import { ContainerState } from '../../../src/shared/runtime.js';
import type { DbVM } from '../../../src/api/services/entities';
import type { ResolvedWorkloadStorage } from '../../../src/api/services/workload-storage';
import {
  makeMockCloudStorage,
  TEST_AWS_CRED,
  TEST_GCP_CRED,
} from '../helpers/fixtures';

const workloadFixture = {
  id: 'vm-storage-test',
  image: 'alpine:latest',
  sshPrivateKey: 'private-key',
};
const workload = workloadFixture as StoredWorkload;

const vm: DbVM = {
  cloudId: 'i-runtime-storage',
  ip: '203.0.113.10',
  sshHost: '203.0.113.10',
  sshPort: 22,
  sshUsername: 'ubuntu',
  createdAt: 0,
  preempt: null,
  endedAt: null,
  inputHostPath: '/var/lib/anycloud/input',
  outputHostPath: '/var/lib/anycloud/output',
  checkpointHostPath: '/var/lib/anycloud/checkpoint',
};

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    vmType: 'e2-standard-2',
    ...overrides,
  };
}

describe('VM runtime storage adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(cloudProviders.loadWorkloadConfigs).mockReset();
    storageProviderMocks.createOutput.mockReset();
    storageProviderMocks.createCheckpoint.mockReset();
  });

  it('consumes one resolved plan and mints only explicit cross-cloud credentials', async () => {
    const minted = {
      ...TEST_AWS_CRED,
      sessionToken: 'short-lived-session',
    };
    const mintScopedStorageToken = vi.fn().mockResolvedValue({
      credentials: minted,
      credentialExpiresAt: 3_600_000,
      expiresAt: 3_600_000,
    });
    const cloudConfig = config({
      inputBucket: 'input-data',
      outputBucket: 'output-data',
      outputStorageCredentials: TEST_AWS_CRED,
      outputStorageRegion: 'us-east-1',
    });
    const storageFixture = {
      cloudConfig,
      workloadId: workload.id,
      targets: {
        input: {
          role: 'input',
          name: 'input-data',
          mode: 'read',
          cleanupPolicy: 'retain',
          provider: makeMockCloudStorage({
            type: CloudType.GCP,
            region: 'us-central1',
          }),
        },
        output: {
          role: 'output',
          name: 'output-data',
          mode: 'readwrite',
          cleanupPolicy: 'retain',
          provider: makeMockCloudStorage({
            validateScopedStorageTokenSource: vi.fn(),
            mintScopedStorageToken,
          }),
        },
      },
    };
    const storage = storageFixture as ResolvedWorkloadStorage;
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    await expect(
      configureAndHydrateVmStorage({
        cloudConfig,
        workload,
        vms: [vm],
        storage,
        preserveLocalData: true,
      }),
    ).resolves.toBe(storage);

    expect(mintScopedStorageToken).toHaveBeenCalledWith([
      { bucket: 'output-data', mode: 'readwrite' },
    ]);
    expect(initRclone).toHaveBeenCalledWith(
      {
        input: {
          name: 'input-data',
          cloudType: CloudType.GCP,
          region: 'us-central1',
          storageAccountName: undefined,
          credentials: undefined,
        },
        output: {
          name: 'output-data',
          cloudType: CloudType.AWS,
          region: 'us-east-1',
          storageAccountName: undefined,
          credentials: minted,
          credentialExpiresAt: 3_600_000,
        },
      },
      workload.id,
      vm.ip,
      {
        preserveLocalBuckets: true,
        bucketHostPaths: {
          input: vm.inputHostPath,
          output: vm.outputHostPath,
          checkpoint: vm.checkpointHostPath,
        },
      },
    );
  });

  it('hands an R2 bucket its account endpoint with a minted token', async () => {
    const minted = { ...TEST_AWS_CRED, sessionToken: 'r2-session' };
    const mintScopedStorageToken = vi.fn().mockResolvedValue({
      credentials: minted,
      expiresAt: 3_600_000,
    });
    const cloudConfig = config({
      outputBucket: 'r2-output',
      outputStorageCredentials: {
        cloudProvider: CloudType.Cloudflare,
        accountId: 'acct',
        apiToken: 'token',
      },
    });
    const storageFixture = {
      cloudConfig,
      workloadId: workload.id,
      targets: {
        output: {
          role: 'output',
          name: 'r2-output',
          mode: 'readwrite',
          cleanupPolicy: 'retain',
          provider: makeMockCloudStorage({
            type: CloudType.Cloudflare,
            region: 'auto',
            s3Endpoint: 'https://acct.r2.cloudflarestorage.com',
            validateScopedStorageTokenSource: vi.fn(),
            mintScopedStorageToken,
          }),
        },
      },
    };
    const storage = storageFixture as ResolvedWorkloadStorage;
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    await configureAndHydrateVmStorage({
      cloudConfig,
      workload,
      vms: [vm],
      storage,
      preserveLocalData: true,
    });

    expect(initRclone).toHaveBeenCalledWith(
      {
        output: expect.objectContaining({
          cloudType: CloudType.Cloudflare,
          endpoint: 'https://acct.r2.cloudflarestorage.com',
          credentials: minted,
        }),
      },
      workload.id,
      vm.ip,
      expect.anything(),
    );
  });

  it('0047/S3 mints bucket-scoped tokens for same-account AWS buckets from the compute credential', async () => {
    const minted = { ...TEST_AWS_CRED, sessionToken: 'scoped-session' };
    const mintScopedStorageToken = vi.fn().mockResolvedValue({
      credentials: minted,
      expiresAt: 3_600_000,
    });
    const provider = makeMockCloudStorage({
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken,
    });
    const cloudConfig = config({
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.small',
      credentials: TEST_AWS_CRED,
      inputBucket: 'input-data',
      outputBucket: 'output-data',
    });
    const storageFixture = {
      cloudConfig,
      workloadId: workload.id,
      targets: {
        input: {
          role: 'input',
          name: 'input-data',
          mode: 'read',
          cleanupPolicy: 'retain',
          provider,
        },
        output: {
          role: 'output',
          name: 'output-data',
          mode: 'readwrite',
          cleanupPolicy: 'retain',
          provider,
        },
      },
    };
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    await configureAndHydrateVmStorage({
      cloudConfig,
      workload,
      vms: [vm],
      storage: storageFixture as ResolvedWorkloadStorage,
    });

    expect(mintScopedStorageToken.mock.calls).toEqual([
      [[{ bucket: 'input-data', mode: 'read' }]],
      [[{ bucket: 'output-data', mode: 'readwrite' }]],
    ]);
    expect(initRclone).toHaveBeenCalledWith(
      {
        input: expect.objectContaining({
          credentials: minted,
          credentialExpiresAt: 3_600_000,
        }),
        output: expect.objectContaining({
          credentials: minted,
          credentialExpiresAt: 3_600_000,
        }),
      },
      workload.id,
      vm.ip,
      expect.anything(),
    );
  });

  it('0047/S8 syncs a same-project GCP bucket with a token minted from the compute key', async () => {
    const minted = { cloudProvider: CloudType.GCP, accessToken: 'downscoped' };
    const mintScopedStorageToken = vi
      .fn()
      .mockResolvedValue({ credentials: minted, expiresAt: 3_600_000 });
    const cloudConfig = config({
      credentials: TEST_GCP_CRED,
      inputBucket: 'input-data',
      outputBucket: 'output-data',
    });
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    const provider = makeMockCloudStorage({
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken,
    });
    const storageFixture = {
      cloudConfig,
      workloadId: workload.id,
      targets: {
        input: {
          role: 'input',
          name: 'input-data',
          mode: 'read',
          cleanupPolicy: 'retain',
          provider,
        },
        output: {
          role: 'output',
          name: 'output-data',
          mode: 'readwrite',
          cleanupPolicy: 'retain',
          provider,
        },
      },
    };
    await configureAndHydrateVmStorage({
      cloudConfig,
      workload,
      vms: [vm],
      storage: storageFixture as ResolvedWorkloadStorage,
    });

    expect(mintScopedStorageToken.mock.calls).toEqual([
      [[{ bucket: 'input-data', mode: 'read' }]],
      [[{ bucket: 'output-data', mode: 'readwrite' }]],
    ]);
    expect(initRclone).toHaveBeenCalledWith(
      {
        input: expect.objectContaining({ credentials: minted }),
        output: expect.objectContaining({
          credentials: minted,
          credentialExpiresAt: 3_600_000,
        }),
      },
      workload.id,
      vm.ip,
      expect.anything(),
    );
  });

  /** A GCP input sync and checkpoint restore that run until finished. */
  function longHydration(mint: () => Promise<unknown>) {
    const mintScopedStorageToken = vi.fn().mockImplementation(mint);
    const provider = makeMockCloudStorage({
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken,
    });
    const cloudConfig = config({
      credentials: TEST_GCP_CRED,
      inputBucket: 'input-data',
      checkpointBucket: 'state-data',
    });
    const target = (role: 'input' | 'checkpoint', name: string) => ({
      role,
      name,
      mode: role === 'input' ? 'read' : 'readwrite',
      cleanupPolicy: 'retain',
      provider,
    });
    const storageFixture = {
      cloudConfig,
      workloadId: workload.id,
      targets: {
        input: target('input', 'input-data'),
        checkpoint: target('checkpoint', 'state-data'),
      },
    };
    let finish = () => {};
    vi.spyOn(SupervisorManager.prototype, 'initRclone').mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const refresh = vi
      .spyOn(SupervisorManager.prototype, 'refreshRcloneCredentials')
      .mockResolvedValue(undefined);
    const hydration = configureAndHydrateVmStorage({
      cloudConfig,
      workload,
      vms: [vm],
      storage: storageFixture as ResolvedWorkloadStorage,
    });
    return {
      mintScopedStorageToken,
      refresh,
      hydration,
      finish: () => finish(),
    };
  }
  let lifetime = 0;
  const hourToken = async () => ({
    credentials: {
      cloudProvider: CloudType.GCP,
      accessToken: `downscoped-${++lifetime}`,
    },
    expiresAt: Date.now() + 3_600_000,
  });

  it('0047/S11 renews every bucket token while hydration outlives one', async () => {
    vi.useFakeTimers({ now: 0 });
    lifetime = 0;
    try {
      const { refresh, hydration, finish } = longHydration(hourToken);
      // Input sync and checkpoint restore run past the first token's hour.
      await vi.advanceTimersByTimeAsync(3_600_000 - 300_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenLastCalledWith({
        input: expect.objectContaining({
          credentials: expect.objectContaining({ accessToken: 'downscoped-3' }),
          credentialExpiresAt: 3_600_000 * 2 - 300_000,
        }),
        checkpoint: expect.objectContaining({
          credentials: expect.objectContaining({ accessToken: 'downscoped-4' }),
        }),
      });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(refresh).toHaveBeenCalledTimes(2);

      finish();
      await hydration;
      await vi.advanceTimersByTimeAsync(3 * 3_600_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles only after a renewal in flight when hydration ends', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { refresh, hydration, finish } = longHydration(hourToken);
      let writeDone = () => {};
      refresh.mockImplementation(
        () => new Promise<void>((resolve) => (writeDone = resolve)),
      );
      await vi.advanceTimersByTimeAsync(3_600_000 - 300_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      finish();
      let settled = false;
      void hydration.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      writeDone();
      await hydration;
      await vi.advanceTimersByTimeAsync(3 * 3_600_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed renewal a minute later', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let mints = 0;
      const { refresh, hydration, finish } = longHydration(async () => {
        if (++mints === 3) throw new Error('STS unavailable');
        return hourToken();
      });
      await vi.advanceTimersByTimeAsync(3_600_000 - 300_000);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      finish();
      await hydration;
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews at the earliest token expiry less five minutes', () => {
    const token = (expiresAt?: number) => ({
      name: 'b',
      cloudType: CloudType.GCP,
      credentials: { cloudProvider: CloudType.GCP, accessToken: 't' } as const,
      credentialExpiresAt: expiresAt,
    });
    expect(renewAt({ input: token(7_200_000), output: token(3_600_000) })).toBe(
      3_300_000,
    );
    expect(renewAt({ input: token(undefined) })).toBe(-Infinity);
    expect(
      renewAt({ input: { name: 'b', cloudType: CloudType.GCP } }),
    ).toBeUndefined();
  });

  it('0047/S7 re-mints a same-account AWS output token before the final VM Job copy', async () => {
    const fresh = { ...TEST_AWS_CRED, sessionToken: 'final-copy-session' };
    const mintScopedStorageToken = vi.fn().mockResolvedValue({
      credentials: fresh,
      expiresAt: 3_600_000,
    });
    storageProviderMocks.createOutput.mockReturnValue(
      makeMockCloudStorage({
        validateScopedStorageTokenSource: vi.fn(),
        mintScopedStorageToken,
      }),
    );
    const refreshRcloneCredentials = vi
      .spyOn(SupervisorManager.prototype, 'refreshRcloneCredentials')
      .mockResolvedValue(undefined);
    const runFinalOutputSync = vi
      .spyOn(SupervisorManager.prototype, 'runFinalOutputSync')
      .mockResolvedValue(undefined);

    await syncFinalVmJobArtifacts(
      workload.id,
      workload.sshPrivateKey!,
      config({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
        credentials: TEST_AWS_CRED,
        outputBucket: 'output-data',
        outputStorageRegion: 'us-east-1',
      }),
      vm,
    );

    expect(mintScopedStorageToken).toHaveBeenCalledWith([
      { bucket: 'output-data', mode: 'readwrite' },
    ]);
    expect(refreshRcloneCredentials).toHaveBeenCalledWith({
      output: expect.objectContaining({ credentials: fresh }),
    });
    expect(refreshRcloneCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      runFinalOutputSync.mock.invocationCallOrder[0],
    );
  });

  it('rejects explicit storage credentials when the target cannot mint scoped tokens', async () => {
    const cloudConfig = config({
      outputBucket: 'output-data',
      outputStorageCredentials: TEST_AWS_CRED,
      outputStorageRegion: 'us-east-1',
    });
    const storageFixture = {
      cloudConfig,
      workloadId: workload.id,
      targets: {
        output: {
          role: 'output',
          name: 'output-data',
          mode: 'readwrite',
          cleanupPolicy: 'retain',
          provider: makeMockCloudStorage(),
        },
      },
    };
    const storage = storageFixture as ResolvedWorkloadStorage;

    await expect(
      configureAndHydrateVmStorage({
        cloudConfig,
        workload,
        vms: [vm],
        storage,
      }),
    ).rejects.toBeInstanceOf(DeployError);
  });

  it('reconstructs container mounts without provider access', () => {
    expect(
      mountsForVmStorage(
        config({ inputBucket: 'input', checkpointBucket: 'checkpoint' }),
        workload.id,
        vm,
      ),
    ).toEqual({
      input: vm.inputHostPath,
      output: undefined,
      checkpoint: vm.checkpointHostPath,
    });
  });

  it('keeps input hydration unbounded and service-only setup bounded', () => {
    expect(vmStorageHydrationTimeoutMs(config({ inputBucket: 'input' }))).toBe(
      null,
    );
    expect(
      vmStorageHydrationTimeoutMs(config({ outputBucket: 'output' })),
    ).toBe(RCLONE_INIT_TIMEOUT_MS);
    expect(hasVmRuntimeStorage(config({ spot: true }))).toBe(true);
    expect(hasVmRuntimeStorage(config())).toBe(false);
  });

  it('selects explicit storage cloud and otherwise falls back to compute', () => {
    expect(resolveFinalSyncCloud(TEST_GCP_CRED, CloudType.AWS)).toBe(
      CloudType.GCP,
    );
    expect(resolveFinalSyncCloud(undefined, CloudType.AWS)).toBe(CloudType.AWS);
  });

  it('remints explicit credentials before final VM Job copies', async () => {
    const outputCredentials = {
      ...TEST_AWS_CRED,
      sessionToken: 'fresh-output-session',
    };
    const checkpointCredentials = {
      ...TEST_AWS_CRED,
      sessionToken: 'fresh-checkpoint-session',
    };
    const mintOutput = vi.fn().mockResolvedValue({
      credentials: outputCredentials,
      expiresAt: 3_600_000,
    });
    const mintCheckpoint = vi.fn().mockResolvedValue({
      credentials: checkpointCredentials,
      expiresAt: 3_600_000,
    });
    storageProviderMocks.createOutput.mockReturnValue({
      type: CloudType.AWS,
      region: 'us-east-1',
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken: mintOutput,
    });
    storageProviderMocks.createCheckpoint.mockReturnValue({
      type: CloudType.AWS,
      region: 'us-east-1',
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken: mintCheckpoint,
    });
    const refreshRcloneCredentials = vi
      .spyOn(SupervisorManager.prototype, 'refreshRcloneCredentials')
      .mockResolvedValue(undefined);
    const runFinalOutputSync = vi
      .spyOn(SupervisorManager.prototype, 'runFinalOutputSync')
      .mockResolvedValue(undefined);
    const runFinalCheckpointSync = vi
      .spyOn(SupervisorManager.prototype, 'runFinalCheckpointSync')
      .mockResolvedValue(undefined);
    const cloudConfig = config({
      outputBucket: 'output-data',
      outputStorageCredentials: TEST_AWS_CRED,
      outputStorageRegion: 'us-east-1',
      checkpointBucket: 'checkpoint-data',
      checkpointStorageCredentials: TEST_AWS_CRED,
      checkpointStorageRegion: 'us-east-1',
    });

    await syncFinalVmJobArtifacts(
      workload.id,
      workload.sshPrivateKey!,
      cloudConfig,
      vm,
    );

    expect(mintOutput).toHaveBeenCalledWith([
      { bucket: 'output-data', mode: 'readwrite' },
    ]);
    expect(mintCheckpoint).toHaveBeenCalledWith([
      { bucket: 'checkpoint-data', mode: 'readwrite' },
    ]);
    expect(refreshRcloneCredentials).toHaveBeenCalledWith({
      output: expect.objectContaining({ credentials: outputCredentials }),
      checkpoint: expect.objectContaining({
        credentials: checkpointCredentials,
      }),
    });
    expect(refreshRcloneCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      runFinalOutputSync.mock.invocationCallOrder[0],
    );
    expect(refreshRcloneCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      runFinalCheckpointSync.mock.invocationCallOrder[0],
    );
  });
});

const hostedApiVmFixture = {
  ip: '203.0.113.11',
  cloudId: 'i-hosted-api',
  sshHost: null,
  sshPort: 22,
  checkpointHostPath: '/var/lib/anycloud/checkpoint',
};

function hostedApiWorkload() {
  return {
    id: 'hosted-api-quiesce',
    image: `${packageJson.apiImage}:0.1.32`,
    sshPrivateKey: 'private-key',
    workloadType: WorkloadType.Service,
    env: null,
  };
}

describe('hosted API shutdown gate', () => {
  const cloudConfig = config({ checkpointBucket: 'hosted-api-state' });
  const id = hostedApiWorkload().id;

  function spies() {
    return {
      stopContainerGracefully: vi
        .spyOn(DockerManager.prototype, 'stopContainerGracefully')
        .mockResolvedValue(undefined),
      getContainerStatus: vi
        .spyOn(DockerManager.prototype, 'getContainerStatus')
        .mockResolvedValue({
          state: ContainerState.Exited,
          exitCode: 137,
        }),
      stopRcloneServices: vi
        .spyOn(SupervisorManager.prototype, 'stopRcloneServices')
        .mockResolvedValue(undefined),
      refreshRcloneCredentials: vi
        .spyOn(SupervisorManager.prototype, 'refreshRcloneCredentials')
        .mockResolvedValue(undefined),
      runFinalCheckpointSync: vi
        .spyOn(SupervisorManager.prototype, 'runFinalCheckpointSync')
        .mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(cloudProviders.loadWorkloadConfigs).mockReset();
    for (const mock of [
      storeMocks.getWorkload,
      storeMocks.getVMs,
      eventMocks.getLatestRunningAndProvisioningEventIds,
      computeMocks.observeVMReleaseOnce,
      storageProviderMocks.createCheckpoint,
    ]) {
      mock.mockReset();
    }
    storeMocks.getVMs.mockResolvedValue([hostedApiVmFixture]);
    // GCP syncs the checkpoint bucket with a token minted from the compute key.
    storageProviderMocks.createCheckpoint.mockReturnValue(
      makeMockCloudStorage({
        validateScopedStorageTokenSource: vi.fn(),
        mintScopedStorageToken: vi.fn().mockResolvedValue({
          credentials: { cloudProvider: CloudType.GCP, accessToken: 'final' },
          expiresAt: 3_600_000,
        }),
      }),
    );
    eventMocks.getLatestRunningAndProvisioningEventIds.mockResolvedValue({
      latestRunningEventId: 2,
      latestProvisioningEventId: 1,
    });
    // An alive VM makes the catch path rethrow instead of skipping the flush.
    computeMocks.observeVMReleaseOnce.mockResolvedValue({
      state: VMReleaseState.Present,
    });
  });

  it('flushes a legacy API Service through generic checkpoint teardown', async () => {
    storeMocks.getWorkload.mockResolvedValue(hostedApiWorkload());
    const mocks = spies();

    await expect(
      quiesceVmServiceStorage(cloudConfig, id),
    ).resolves.toBeUndefined();

    expect(mocks.stopContainerGracefully).toHaveBeenCalledWith(id);
    expect(mocks.runFinalCheckpointSync).toHaveBeenCalled();
  });

  it('remints an explicit checkpoint token before flushing a hosted API', async () => {
    const minted = {
      ...TEST_AWS_CRED,
      sessionToken: 'fresh-checkpoint-session',
    };
    const mintScopedStorageToken = vi.fn().mockResolvedValue({
      credentials: minted,
      credentialExpiresAt: 3_600_000,
      expiresAt: 3_600_000,
    });
    storageProviderMocks.createCheckpoint.mockReturnValue({
      type: CloudType.AWS,
      region: 'us-east-1',
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken,
    });
    storeMocks.getWorkload.mockResolvedValue(hostedApiWorkload());
    const mocks = spies();
    mocks.getContainerStatus.mockResolvedValue({
      state: ContainerState.Exited,
      exitCode: 0,
    });
    const explicitConfig = config({
      checkpointBucket: 'hosted-api-state',
      checkpointStorageCredentials: TEST_AWS_CRED,
      checkpointStorageRegion: 'us-east-1',
    });

    await expect(
      quiesceVmServiceStorage(explicitConfig, id),
    ).resolves.toBeUndefined();

    expect(mintScopedStorageToken).toHaveBeenCalledWith([
      { bucket: 'hosted-api-state', mode: 'readwrite' },
    ]);
    expect(mocks.refreshRcloneCredentials).toHaveBeenCalledWith({
      checkpoint: expect.objectContaining({ credentials: minted }),
    });
    expect(
      mocks.refreshRcloneCredentials.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.runFinalCheckpointSync.mock.invocationCallOrder[0]);
  });

  it.each([
    { state: VMReleaseState.Candidate, released: true },
    { state: VMReleaseState.Present, released: false },
    { state: VMReleaseState.Unknown, released: false },
  ])(
    'uses exact attempt scope after a checkpoint failure with native status $state',
    async ({ state, released }) => {
      const stored = hostedApiWorkload();
      storeMocks.getWorkload.mockResolvedValue(stored);
      storeMocks.getVMs.mockResolvedValue([
        {
          ...vm,
          cloudId: 'original-native-vm',
          credentialId: 'original-credential',
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          availabilityZone: 'b',
        },
      ]);
      vi.mocked(cloudProviders.loadWorkloadConfigs).mockResolvedValue(
        config({
          credentials: TEST_GCP_CRED,
          region: 'us-east4',
          availabilityZone: 'c',
        }),
      );
      const create = vi.spyOn(cloudProviders, 'createComputeProvider');
      const failure = new Error('final checkpoint upload failed');
      const mocks = spies();
      mocks.runFinalCheckpointSync.mockRejectedValue(failure);
      computeMocks.observeVMReleaseOnce.mockResolvedValue({
        state,
        ...(state === VMReleaseState.Unknown
          ? { error: 'native API unavailable' }
          : {}),
      });

      const flush = quiesceVmServiceStorage(cloudConfig, id);
      if (released) await expect(flush).resolves.toBeUndefined();
      else await expect(flush).rejects.toBe(failure);

      expect(
        cloudProviders.loadWorkloadConfigs,
      ).toHaveBeenCalledExactlyOnceWith(stored, 'original-credential');
      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          credentials: TEST_GCP_CRED,
          region: 'us-central1',
          availabilityZone: 'b',
        }),
        'observed-vm',
      );
      expect(computeMocks.observeVMReleaseOnce).toHaveBeenCalledWith(
        'original-native-vm',
        {},
      );
    },
  );

  it('preserves the original checkpoint failure when attempt credentials cannot be loaded', async () => {
    storeMocks.getWorkload.mockResolvedValue(hostedApiWorkload());
    storeMocks.getVMs.mockResolvedValue([
      { ...vm, credentialId: 'broken-credential' },
    ]);
    vi.mocked(cloudProviders.loadWorkloadConfigs).mockRejectedValue(
      new Error('credential decryption failed'),
    );
    const failure = new Error('checkpoint generation not uploaded');
    spies().runFinalCheckpointSync.mockRejectedValue(failure);

    await expect(quiesceVmServiceStorage(cloudConfig, id)).rejects.toBe(
      failure,
    );
    expect(computeMocks.observeVMReleaseOnce).not.toHaveBeenCalled();
  });
});
