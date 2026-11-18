import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';

const { fake } = await vi.hoisted(async () => {
  const { createFakeTransport } = await import('../../helpers/mock-transport');
  return { fake: createFakeTransport() };
});

// Mock the transport seam (not the ssh module) so SSHManager statics like
// derivePublicKey stay real, and route every VM command through one shared,
// command-addressed fake instead of order-coupled mockResolvedValueOnce chains.
vi.mock('../../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => fake),
}));

// Terminal states now always release the VM, so completion runs teardown. These
// tests are about the completion decision, not the provider call, so stub the
// compute provider rather than letting teardown reach a real cloud SDK.
vi.mock('../../../../src/api/services/cloud-config', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/api/services/cloud-config')
    >();
  return {
    ...actual,
    createComputeProvider: vi.fn(
      (cloudConfig: import('../../../../src/shared/cloud.js').CloudConfig) => ({
        type: cloudConfig.cloudProvider,
        region: cloudConfig.region ?? '',
        terminateVMs: vi.fn(async (vmIds: string[]) => vmIds),
        terminateNetworking: vi.fn(async () => undefined),
        classifyError: vi.fn(() => undefined),
        isTerminalAuthError: vi.fn(() => false),
      }),
    ),
    createOutputStorageProvider: vi.fn(() => ({
      type: 'AWS',
      region: 'us-east-1',
      validateScopedStorageTokenSource: vi.fn(async () => undefined),
      mintScopedStorageToken: vi.fn(async () => ({
        credentials: {
          cloudProvider: 'AWS',
          accessKeyId: 'scoped-access-key',
          secretAccessKey: 'scoped-secret-key',
          sessionToken: 'scoped-session-token',
        },
        expiresAt: 3_600_000,
      })),
    })),
    createCheckpointStorageProvider: vi.fn(() => ({
      deleteBucket: vi.fn(async () => undefined),
    })),
  };
});

import {
  checkJobCompletion,
  finalizeJobArtifacts,
  FINAL_SYNC_MAX_ATTEMPTS,
  classifyJobExit,
} from '../../../../src/api/services/workload-workflows/completion';
import {
  GPU_PASSED_PROBE,
  UNUSABLE_GPU_DIAGNOSIS,
} from '../../../../src/api/services/workload-workflows/missing-gpu';
import { reconcileFinalizingJob } from '../../../../src/api/services/workload-workflows/completion-reconcile';
import {
  makeMockCloudCompute,
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
} from '../../helpers/fixtures';
import { CloudType, GpuRuntime } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { ContainerState } from '../../../../src/shared/runtime.js';
import { createTransport } from '../../../../src/api/services/gateways/transport';
import { resetTestStore, settleWithFakeTimers } from '../../utils';
import config from '../../../../src/api/config';
import {
  createComputeProvider,
  encryptCredential,
} from '../../../../src/api/services/cloud-config';
import {
  getWorkloadLifecycle as lifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import {
  provisionTestVm,
  releaseTestVms,
  walkToState,
} from '../../../helpers/workload-store.js';
import { GPU_RERUN_DIAGNOSIS } from '../../../../src/api/services/workload-event-metadata.js';

const persistence = () => ({
  store: queries(),
  lifecycle: lifecycle(),
  outcomes: getWorkloadOutcomes(),
  events: eventLog(),
  resume: { resumeOnExistingVM: vi.fn() },
});

describe('job completion and recovery', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    await resetTestStore();
    fake.reset();
  });

  async function createRunningLambdaWorkload(id: string) {
    await upsertCredential(
      getDB(),
      'lambda-cred-hash',
      await encryptCredential({ cloudProvider: CloudType.Lambda, apiKey: 'k' }),
      CloudType.Lambda,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
      requestedComputeProvider: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      spot: false,
      dockerCommand: 'nvidia-smi',
      sshPrivateKey: 'private-key',
      credentialId: 'lambda-cred-hash',
    });
    await lifecycle().updateState(id, WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      {
        ip: '203.0.113.10',
        cloudId: '123',
      },
      { region: 'us-east-1' },
    );
    await lifecycle().updateState(id, WorkloadState.Running);
  }

  async function createRunningAwsWorkload(
    id: string,
    spot = false,
    checkpointBucket?: string,
    outputBucket?: string,
  ) {
    await upsertCredential(
      getDB(),
      'aws-cred-hash',
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      spot,
      checkpointBucket,
      outputBucket,
      dockerCommand: 'echo ok',
      sshPrivateKey: 'private-key',
      credentialId: 'aws-cred-hash',
    });
    await lifecycle().updateState(id, WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      {
        ip: '203.0.113.20',
        cloudId: 'i-123',
      },
      { region: 'us-east-1' },
    );
    await lifecycle().updateState(id, WorkloadState.Running);
  }

  function mockDockerExited(exitCode: number) {
    // Command-addressed: getContainerStatus runs `docker inspect`, then (since
    // the container is non-running) `docker logs`. Robust to call order.
    fake
      .on('docker inspect', {
        code: 0,
        stdout: JSON.stringify({
          Status: 'exited',
          ExitCode: exitCode,
          StartedAt: '2026-01-01T00:00:00.000Z',
          OOMKilled: false,
          Error: '',
        }),
        stderr: '',
      })
      .on('docker logs', { code: 0, stdout: '', stderr: '' });
  }

  function mockDockerRunning() {
    fake.on('docker inspect', {
      code: 0,
      stdout: JSON.stringify({
        Status: 'running',
        ExitCode: 0,
        StartedAt: '1970-01-01T00:00:00.000Z',
        OOMKilled: false,
        Error: '',
      }),
      stderr: '',
    });
  }

  function mockDockerExitedWithLogs(exitCode: number, logs: string) {
    fake
      .on('docker inspect', {
        code: 0,
        stdout: JSON.stringify({
          Status: 'exited',
          ExitCode: exitCode,
          StartedAt: '2026-01-01T00:00:00.000Z',
          OOMKilled: false,
          Error: '',
        }),
        stderr: '',
      })
      .on('docker logs', { code: 0, stdout: logs, stderr: '' });
  }

  it('keeps Lambda completion on the VM-host Docker-over-SSH path', async () => {
    const id = 'lambda-vm-host-completion';
    await createRunningLambdaWorkload(id);
    mockDockerExited(0);
    vi.mocked(createTransport).mockClear();

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );
    expect(createTransport).toHaveBeenCalledWith(
      '203.0.113.10',
      'private-key',
      22,
      undefined,
    );
    expect(
      fake.execStream.mock.calls.some(([command]) =>
        command.includes('docker inspect'),
      ),
    ).toBe(true);
    expect(
      fake.execStream.mock.calls.some(([command]) =>
        command.includes('/tmp/anycloud-exit-'),
      ),
    ).toBe(false);
  });

  it('marks exit code 7 Errored even when logs are unavailable', async () => {
    const id = 'aws-exit-seven-no-logs';
    await createRunningAwsWorkload(id);
    fake
      .on('docker inspect', {
        code: 0,
        stdout: JSON.stringify({
          Status: 'exited',
          ExitCode: 7,
          StartedAt: '2026-01-01T00:00:00.000Z',
          OOMKilled: false,
          Error: '',
        }),
      })
      .on('docker logs', new Error('log channel closed'));

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Errored,
    );
  });

  it('moves a removed container to Recovering when Docker is healthy', async () => {
    const id = 'aws-container-removed';
    await createRunningAwsWorkload(id);
    fake
      .on('docker inspect', { code: 1, stderr: 'No such container' })
      .on('docker info', { code: 0 });

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Recovering,
    );
  });

  it('recovers a job whose container is dead rather than trusting its exit code', async () => {
    const id = 'aws-container-dead';
    await createRunningAwsWorkload(id);
    // ExitCode 0 is deliberate: classifying a dead container instead of
    // recovering it would falsely mark the job Completed.
    fake.on('docker inspect', {
      code: 0,
      stdout: JSON.stringify({
        Status: 'dead',
        ExitCode: 0,
        StartedAt: '2026-01-01T00:00:00.000Z',
        OOMKilled: false,
        Error: '',
      }),
    });

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Recovering,
    );
  });

  async function createRunningGpuJob(id: string, cloudProvider: CloudType) {
    const isLocal = cloudProvider === CloudType.Local;
    if (!isLocal) {
      await upsertCredential(
        getDB(),
        'gpu-cred-hash',
        'cred-encrypted',
        cloudProvider,
      );
    }
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      region: isLocal ? 'local' : 'us-east-1',
      vmType: isLocal ? 'local' : 'g6e.xlarge',
      spot: false,
      dockerCommand: 'echo ok',
      dockerOptions: { gpus: 'all' },
      sshPrivateKey: 'private-key',
      credentialId: isLocal ? null : 'gpu-cred-hash',
      requestedComputeProvider: isLocal ? cloudProvider : undefined,
    });
    await lifecycle().updateState(id, WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      { ip: '203.0.113.30', cloudId: isLocal ? `ac-local-${id}-0` : 'i-gpu' },
      { region: isLocal ? 'local' : 'us-east-1' },
    );
    await lifecycle().updateState(id, WorkloadState.Running);
  }

  const MISSING_GPU_LOG = 'cuInit(0) failed: CUDA_ERROR_NO_DEVICE';
  // Verbatim customer training crash on a Lambda H100:2 NVSwitch slice whose fabric
  // was not ready (error 802). GPUs enumerate but CUDA init fails host-side.
  const FABRIC_NOT_READY_LOG =
    'RuntimeError: Unexpected error from cudaGetDeviceCount(). ' +
    'Error 802: system not yet initialized';

  const AWS_GPU_CONFIG = {
    cloudProvider: CloudType.AWS,
    credentials: TEST_AWS_CRED,
    region: 'us-east-1',
    vmType: 'g6e.xlarge',
  } as const;
  const GPU_PROBE_FAILED = 'No devices were found\nexit=9';
  const GPU_PROBE_PASSED =
    'GPU 0: NVIDIA L40S (UUID: GPU-0)\nCUresult 0\nexit=0';

  it('retries a non-Local --gpus job on a fresh VM when the GPU probe confirms its missing-GPU error', async () => {
    const id = 'aws-gpu-missing';
    await createRunningGpuJob(id, CloudType.AWS);
    mockDockerExitedWithLogs(1, MISSING_GPU_LOG);
    fake.on('nvidia-smi -L', GPU_PROBE_FAILED);

    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    // The retry budget counts this diagnosis (UNUSABLE_GPU_MAX_RETRIES).
    expect(
      await eventLog().countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS),
    ).toBe(1);
  });

  /** The retry's VM eligibility: 'reuse' keeps the VM, 'release-pending' replaces it. */
  async function retryVMEligibility(id: string) {
    const [{ revision }] = await getDB().query<{ revision: number }>(
      'SELECT MAX(id) AS revision FROM workload_events WHERE workload_id = ?',
      [id],
    );
    return lifecycle().getRetryVMEligibility(id, revision);
  }

  async function exitWithPassedProbe(id: string) {
    fake.reset();
    mockDockerExitedWithLogs(1, 'No CUDA GPUs are available');
    fake.onceOn('nvidia-smi -L', GPU_PROBE_PASSED);
    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);
  }

  async function messageOf(id: string, state: WorkloadState) {
    const events = await eventLog().getWorkloadEvents(id);
    return JSON.parse(events.findLast((e) => e.state === state)!.metadata!)
      .message;
  }

  it('reruns a --gpus job once on its own VM when its log blames the GPU but the GPU passes its probe', async () => {
    const id = 'aws-gpu-rerun';
    await createRunningGpuJob(id, CloudType.AWS);

    await exitWithPassedProbe(id);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(await retryVMEligibility(id)).toBe('reuse');
    expect(
      await eventLog().countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS),
    ).toBe(0);

    // The rerun's new container succeeds on the same VM.
    await walkToState(id, WorkloadState.Running);
    fake.reset();
    mockDockerExitedWithLogs(0, 'done');
    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );
  });

  it('ends a --gpus job Errored when the GPU passes its probe again after the in-place rerun', async () => {
    const id = 'aws-gpu-image-fault';
    await createRunningGpuJob(id, CloudType.AWS);
    await exitWithPassedProbe(id);
    await walkToState(id, WorkloadState.Running);

    await exitWithPassedProbe(id);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Errored,
    );
    expect(await messageOf(id, WorkloadState.Errored)).toBe(GPU_PASSED_PROBE);
    expect(
      await eventLog().countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS),
    ).toBe(0);
  });

  it('replaces the VM when the GPU fails its probe after an in-place rerun, and never reruns in place again', async () => {
    const id = 'aws-gpu-rerun-then-bad';
    await createRunningGpuJob(id, CloudType.AWS);
    await exitWithPassedProbe(id);
    await walkToState(id, WorkloadState.Running);

    fake.reset();
    mockDockerExitedWithLogs(1, MISSING_GPU_LOG);
    fake.onceOn('nvidia-smi -L', GPU_PROBE_FAILED);
    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(await retryVMEligibility(id)).toBe('release-pending');

    // On the fresh VM the GPU passes again: the one rerun is spent.
    await releaseTestVms(id, 'i-gpu');
    await walkToState(id, WorkloadState.Provisioning);
    await provisionTestVm(id, { ip: '203.0.113.31', cloudId: 'i-gpu-2' });
    await walkToState(id, WorkloadState.Running);
    await exitWithPassedProbe(id);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Errored,
    );
    expect(await messageOf(id, WorkloadState.Errored)).toBe(GPU_PASSED_PROBE);
    expect(
      await eventLog().countFailureDiagnosis(id, GPU_RERUN_DIAGNOSIS),
    ).toBe(1);
  });

  it('retries a ROCm job on a fresh VM without the CUDA probe', async () => {
    const id = 'azure-rocm-missing';
    await createRunningGpuJob(id, CloudType.AWS);
    mockDockerExitedWithLogs(1, 'hipErrorNoDevice');

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Azure,
      credentials: TEST_AZURE_CRED,
      region: 'eastus',
      vmType: 'Standard_ND96isr_MI300X_v5',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(
      await eventLog().countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS),
    ).toBe(1);
    expect(fake.commands.some((c) => c.includes('nvidia-smi -L'))).toBe(false);
  });

  it('retries a --gpus job on a fresh VM when the GPU probe cannot run', async () => {
    const id = 'aws-gpu-probe-unreachable';
    await createRunningGpuJob(id, CloudType.AWS);
    mockDockerExitedWithLogs(1, MISSING_GPU_LOG);
    fake.on('nvidia-smi -L', new Error('SSH connection reset'));

    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(
      await eventLog().countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS),
    ).toBe(1);
  });

  it('retries a GPU numeric fault on a fresh VM without the probe, which cannot clear it', async () => {
    const id = 'aws-gpu-redzone';
    await createRunningGpuJob(id, CloudType.AWS);
    mockDockerExitedWithLogs(
      1,
      'redzone_allocator.cc:322] Mismatched results with host and device comparison',
    );
    fake.on('nvidia-smi -L', GPU_PROBE_PASSED);

    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(fake.commands.some((c) => c.includes('nvidia-smi -L'))).toBe(false);
  });

  it('does not retry a Local --gpus job on a missing-GPU error (single fixed host)', async () => {
    const id = 'local-gpu-missing';
    await createRunningGpuJob(id, CloudType.Local);
    mockDockerExitedWithLogs(1, MISSING_GPU_LOG);

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Errored,
    );
  });

  it('retries a non-Local --gpus job that exits with a fabric-not-ready (CUDA 802) error', async () => {
    const id = 'aws-gpu-fabric-802';
    await createRunningGpuJob(id, CloudType.AWS);
    mockDockerExitedWithLogs(1, FABRIC_NOT_READY_LOG);
    fake.on('nvidia-smi -L', GPU_PROBE_FAILED);

    await checkJobCompletion(persistence(), id, 'private-key', AWS_GPU_CONFIG);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
  });

  it('does not retry a Local --gpus job on a fabric-not-ready error (single fixed host)', async () => {
    const id = 'local-gpu-fabric-802';
    await createRunningGpuJob(id, CloudType.Local);
    mockDockerExitedWithLogs(1, FABRIC_NOT_READY_LOG);

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Errored,
    );
  });

  it('moves an exited VM-host bucket job to Finalizing before publishing terminal state', async () => {
    const id = 'aws-finalizing-claim';
    const logs = `BEGIN ${'workload diagnostic 🚀; '.repeat(1024)} END`;
    const diagnostics = `Container logs:\n${logs}`;
    await createRunningAwsWorkload(id);
    mockDockerExitedWithLogs(0, logs);

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      outputBucket: 'results-bucket',
    });

    const store = queries();
    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Finalizing);

    const events = await eventLog().getWorkloadEvents(id);
    expect(events.at(-1)?.state).toBe(WorkloadState.Finalizing);
    const rawMetadata = events.at(-1)!.metadata!;
    const metadata = JSON.parse(rawMetadata);
    expect(metadata).toMatchObject({
      targetState: WorkloadState.Completed,
      workloadExitCode: 0,
      attempt: 0,
      maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      state: ContainerState.Exited,
      exitCode: 0,
      oomKilled: false,
      logs: diagnostics,
    });
    expect(metadata).not.toHaveProperty('exitMetadata');
    expect(Buffer.byteLength(metadata.logs)).toBeGreaterThan(16 * 1024);
    expect(rawMetadata.split(JSON.stringify(diagnostics))).toHaveLength(2);
    expect(fake.execStream).toHaveBeenCalledTimes(2);
    expect(fake.execStream.mock.calls[0][0]).toContain('docker inspect');
    expect(fake.execStream.mock.calls[1][0]).toContain('docker logs');
  });

  it('defers spot VM container exit until the dwell window elapses and resets on recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const id = 'aws-spot-exit-dwell';
      const cloudConfig = {
        cloudProvider: CloudType.AWS,
        credentials: TEST_AWS_CRED,
        region: 'us-east-1',
        vmType: 't3.large',
        spot: true,
      };

      await createRunningAwsWorkload(id, true);
      mockDockerExited(0);

      await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );

      vi.setSystemTime(149_999);
      await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );

      fake.reset();
      mockDockerRunning();
      await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );

      fake.reset();
      mockDockerExited(0);
      vi.setSystemTime(300_000);
      await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );

      vi.setSystemTime(450_000);
      await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
      const store = queries();
      expect((await store.getWorkload(id))?.state).toBe(
        WorkloadState.Finalizing,
      );
      const events = await eventLog().getWorkloadEvents(id);
      expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // The reclaim itself ends `reclaimed` through vm-job-max-retries.spec.ts's
  // 'ends a Spot VM Job at its first reclaim with --max-retries 0'.
  describe('a spot Job that cannot restart in place (--max-retries 0)', () => {
    const cloudConfig = {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      spot: true,
    };
    const create = async (id: string, maxRetries: number | null) => {
      await createRunningAwsWorkload(id, true);
      await getDB().query('UPDATE workloads SET max_retries = ? WHERE id = ?', [
        maxRetries,
        id,
      ]);
    };
    const check = async (id: string, exitCode: number, probe: string) => {
      fake.reset();
      mockDockerExited(exitCode);
      fake.on('instance-action', { code: 0, stdout: probe, stderr: '' });
      await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
      return (await queries().getWorkload(id))?.state;
    };
    const probed = () =>
      fake.commands.some((command) => command.includes('instance-action'));

    it('ends at once on a clean exit with no reclaim notice', async () => {
      await create('spot-final-0', 0);
      expect(await check('spot-final-0', 0, 'no-notice\n')).toBe(
        WorkloadState.Finalizing,
      );
      const events = await eventLog().getWorkloadEvents('spot-final-0');
      expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
      });
    });

    it('keeps the grace on a reclaim notice, and asks only at first sight', async () => {
      await create('spot-notice', 0);
      // No `no-notice`: a notice, or a read that failed.
      expect(await check('spot-notice', 0, '')).toBe(WorkloadState.Running);
      expect(probed()).toBe(true);
      // A later "no notice" can't end a VM already seen being reclaimed.
      expect(await check('spot-notice', 0, 'no-notice\n')).toBe(
        WorkloadState.Running,
      );
      expect(probed()).toBe(false);
    });

    it('keeps the grace without asking on a non-zero exit', async () => {
      // A reclaim's SIGTERM is 143.
      await create('spot-nonzero', 0);
      expect(await check('spot-nonzero', 143, 'no-notice\n')).toBe(
        WorkloadState.Running,
      );
      expect(probed()).toBe(false);
    });

    it.each([2, null])(
      'keeps the grace without asking while an in-place restart is possible (%s)',
      async (maxRetries) => {
        const id = `spot-retries-${maxRetries}`;
        await create(id, maxRetries);
        expect(await check(id, 0, 'no-notice\n')).toBe(WorkloadState.Running);
        expect(probed()).toBe(false);
      },
    );
  });

  it('publishes Completed after final output sync succeeds', async () => {
    const id = 'lambda-final-sync-ok';
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 0,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    // Detached final-sync unit's poll resolves to a successful sentinel.
    fake.on('ac-final', 'DONE 0\n').default({ stdout: '', stderr: '' });

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Completed);

    const events = await eventLog().getWorkloadEvents(id);
    expect(events.at(-2)?.state).toBe(WorkloadState.Finalizing);
    expect(events.at(-1)?.state).toBe(WorkloadState.Completed);
    // Final sync ran the rclone copy detached (systemd transient unit or nohup),
    // not a single held ssh.exec that a NAT/idle teardown could kill mid-copy.
    expect(
      fake.commands.some(
        (c) =>
          (c.includes('systemd-run') || c.includes('nohup')) &&
          c.includes('rclone copy /mnt/output'),
      ),
    ).toBe(true);
  });

  it('final-syncs an explicit checkpoint bucket for a non-spot Job', async () => {
    const id = 'aws-explicit-checkpoint';
    const checkpointBucket = 'durable-job-state';
    const cloudConfig = {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      checkpointBucket,
    };
    await createRunningAwsWorkload(id, false, checkpointBucket);
    mockDockerExited(0);

    await checkJobCompletion(persistence(), id, 'private-key', cloudConfig);
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Finalizing,
    );

    fake.on('ac-final', 'DONE 0\n');
    await finalizeJobArtifacts(persistence(), id, 'private-key', cloudConfig);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );
    expect(
      fake.commands.some((command) =>
        command.includes(`rclone copy /mnt/checkpoint s3:${checkpointBucket}`),
      ),
    ).toBe(true);
  });

  it('final-syncs output and checkpoint from the VM provider managed root', async () => {
    const id = 'azure-managed-final-sync';
    const hostRoot = '/var/lib/anycloud/deployments';
    const bucketHostPaths = {
      input: `${hostRoot}/input`,
      output: `${hostRoot}/output`,
      checkpoint: `${hostRoot}/checkpoint`,
    };
    await upsertCredential(
      getDB(),
      'azure-cred-hash',
      await encryptCredential(TEST_AZURE_CRED),
      CloudType.Azure,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_B1s',
      spot: true,
      dockerCommand: 'echo ok',
      sshPrivateKey: 'private-key',
      credentialId: 'azure-cred-hash',
    });
    await lifecycle().updateState(id, WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      {
        ip: '203.0.113.20',
        cloudId: 'vm-azure',
      },
      {
        region: 'eastus',
        credentialId: 'azure-cred-hash',
        bucketHostPaths,
      },
    );
    await lifecycle().updateState(id, WorkloadState.Running);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 0,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    fake.on('ac-final', 'DONE 0\n').default({ stdout: '', stderr: '' });

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Azure,
      credentials: {
        applicationId: 'app',
        secret: 'secret',
        directoryId: 'dir',
        subscriptionId: 'sub',
      },
      region: 'eastus',
      vmType: 'Standard_B1s',
      outputStorageCredentials: TEST_AWS_CRED,
      outputStorageRegion: 'us-east-1',
      outputBucket: 'results-bucket',
      spot: true,
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );
    expect(
      fake.commands.some((command) =>
        command.includes(`rclone copy ${hostRoot}/output s3:results-bucket`),
      ),
    ).toBe(true);
    expect(
      fake.commands.some((command) =>
        command.includes(`rclone copy ${hostRoot}/checkpoint azureblob:${id}`),
      ),
    ).toBe(true);
    expect(
      fake.commands.some((command) =>
        command.includes('rclone copy /mnt/output'),
      ),
    ).toBe(false);
    expect(
      fake.commands.some((command) =>
        command.includes('rclone copy /mnt/checkpoint'),
      ),
    ).toBe(false);
  });

  it('final-syncs legacy Azure VM rows from their persisted /mnt paths', async () => {
    const id = 'azure-legacy-final-sync';
    await upsertCredential(
      getDB(),
      'azure-legacy-cred-hash',
      await encryptCredential(TEST_AZURE_CRED),
      CloudType.Azure,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_B1s',
      spot: true,
      dockerCommand: 'echo ok',
      sshPrivateKey: 'private-key',
      credentialId: 'azure-legacy-cred-hash',
    });
    await lifecycle().updateState(id, WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      {
        ip: '203.0.113.21',
        cloudId: 'vm-azure-legacy',
      },
      { region: 'eastus', credentialId: 'azure-legacy-cred-hash' },
    );
    await lifecycle().updateState(id, WorkloadState.Running);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 0,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    fake.on('ac-final', 'DONE 0\n').default({ stdout: '', stderr: '' });

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Azure,
      credentials: {
        applicationId: 'app',
        secret: 'secret',
        directoryId: 'dir',
        subscriptionId: 'sub',
      },
      region: 'eastus',
      vmType: 'Standard_B1s',
      outputStorageCredentials: TEST_AWS_CRED,
      outputStorageRegion: 'us-east-1',
      outputBucket: 'results-bucket',
      spot: true,
    });

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Completed,
    );
    expect(
      fake.commands.some((command) =>
        command.includes('rclone copy /mnt/output s3:results-bucket'),
      ),
    ).toBe(true);
    expect(
      fake.commands.some((command) =>
        command.includes(`rclone copy /mnt/checkpoint azureblob:${id}`),
      ),
    ).toBe(true);
    expect(
      fake.commands.some((command) =>
        command.includes('/var/lib/anycloud/deployments/output'),
      ),
    ).toBe(false);
  });

  it('keeps the VM in Finalizing when final output sync times out', async () => {
    const id = 'lambda-final-sync-fails';
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        state: 'exited',
        exitCode: 137,
        oomKilled: true,
        logs: 'CUDA OOM',
        targetState: WorkloadState.Completed,
        workloadExitCode: 137,
        attempt: 0,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    fake.default(new Error('SSH command timed out after 2700000ms'));

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Finalizing);

    const events = await eventLog().getWorkloadEvents(id);
    expect(events.some((e) => e.state === WorkloadState.Completed)).toBe(false);
    const metadata = JSON.parse(events.at(-1)!.metadata!);
    expect(metadata).toMatchObject({
      reason: 'final-bucket-sync-failed',
      targetState: WorkloadState.Completed,
      workloadExitCode: 137,
      exitCode: 137,
      oomKilled: true,
      logs: 'CUDA OOM',
      attempt: 1,
      maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
    });
    expect(metadata).not.toHaveProperty('exitMetadata');
    expect(metadata.error.message).toContain('SSH command timed out');
  });

  it('preserves final-sync command output in failure metadata', async () => {
    const id = 'final-sync-log-tail';
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 0,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    fake.on('ps -p 1', 'systemd\n');
    fake.default({ stdout: '', stderr: '', code: 0 });
    fake.on(/systemctl is-active ac-final-output/, {
      stdout: 'DONE 1\n',
      stderr: '',
      code: 0,
    });
    fake.on('tail -c 4000', {
      stdout: 'rclone: Failed to copy: permission denied',
      stderr: '',
      code: 0,
    });

    vi.useFakeTimers();
    try {
      const finalized = finalizeJobArtifacts(persistence(), id, 'private-key', {
        cloudProvider: CloudType.Lambda,
        credentials: { apiKey: 'test' },
        region: 'us-east-1',
        vmType: 'gpu_1x_a100',
        outputBucket: 'results-bucket',
      });
      await settleWithFakeTimers(finalized);
    } finally {
      vi.useRealTimers();
    }

    const events = await eventLog().getWorkloadEvents(id);
    const metadata = JSON.parse(events.at(-1)!.metadata!);
    expect(metadata).toMatchObject({
      reason: 'final-bucket-sync-failed',
      error: {
        message: 'exited with code 1',
        name: 'DetachedRunError',
        exitCode: 1,
        logTail: 'rclone: Failed to copy: permission denied',
      },
    });
  });

  it('retries final-sync without re-reading the workload sentinel', async () => {
    const id = 'lambda-final-sync-retry-ok';
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 1,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    fake.on('ac-final', 'DONE 0\n').default({ stdout: '', stderr: '' });

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Completed);
    // The final-sync retry runs only the detached rclone copy + its polls — it
    // never re-reads the workload exit sentinel.
    expect(
      fake.commands.some((c) => c.includes('rclone copy /mnt/output')),
    ).toBe(true);
    expect(fake.commands.some((c) => c.includes('/tmp/anycloud-exit-'))).toBe(
      false,
    );
  });

  it('uses finalization metadata when a newer non-control event is latest', async () => {
    const id = 'lambda-final-sync-after-non-control-event';
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        targetState: WorkloadState.Errored,
        workloadExitCode: 7,
        attempt: 1,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        reason: 'job finalization retry pending',
        error: { message: 'transient finalization failure' },
      },
    });

    const eventsBeforeFinalize = await eventLog().getWorkloadEvents(id);
    const latestBeforeFinalize = JSON.parse(
      eventsBeforeFinalize.at(-1)!.metadata!,
    );
    expect(latestBeforeFinalize).toMatchObject({
      reason: 'job finalization retry pending',
    });
    expect(latestBeforeFinalize).not.toHaveProperty('targetState');

    fake.on('ac-final', 'DONE 0\n').default({ stdout: '', stderr: '' });

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Errored);

    const events = await eventLog().getWorkloadEvents(id);
    const metadata = JSON.parse(events.at(-1)!.metadata!);
    expect(metadata).toMatchObject({
      workloadExitCode: 7,
      finalSyncAttempts: 2,
    });
    expect(metadata).not.toMatchObject({
      reason: 'final-bucket-sync-metadata-missing',
    });
  });

  it('preserves complete exit diagnostics across final-sync failures and eventual success', async () => {
    const id = 'lambda-final-sync-diagnostics';
    const logs = `BEGIN ${'workload diagnostic 🚀; '.repeat(1024)} END`;
    const exitDiagnostics = {
      state: ContainerState.Exited,
      exitCode: 137,
      oomKilled: true,
      logs,
    };
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        ...exitDiagnostics,
        // Older writers can still leave a duplicate before rollout completes.
        exitMetadata: exitDiagnostics,
        targetState: WorkloadState.Errored,
        workloadExitCode: 137,
        attempt: 1,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
        reason: 'final-bucket-sync-failed',
        error: 'previous timeout',
      },
    });
    const originalEvents = await eventLog().getWorkloadEvents(id);
    const cloudConfig = {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    };
    fake.default(new Error('final output sync timed out'));

    for (const attempt of [2, 3]) {
      await finalizeJobArtifacts(persistence(), id, 'private-key', cloudConfig);

      expect((await store.getWorkload(id))?.state).toBe(
        WorkloadState.Finalizing,
      );
      const events = await eventLog().getWorkloadEvents(id);
      const rawMetadata = events.at(-1)!.metadata!;
      const metadata = JSON.parse(rawMetadata);
      expect(metadata).toMatchObject({
        ...exitDiagnostics,
        targetState: WorkloadState.Errored,
        workloadExitCode: 137,
        attempt,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
        reason: 'final-bucket-sync-failed',
        error: { message: 'final output sync timed out' },
      });
      expect(metadata).not.toHaveProperty('exitMetadata');
      expect(Buffer.byteLength(metadata.logs)).toBeGreaterThan(16 * 1024);
      expect(rawMetadata.split(JSON.stringify(logs))).toHaveLength(2);
    }

    fake.reset();
    fake.on('ac-final', 'DONE 0\n').default({ stdout: '', stderr: '' });
    await finalizeJobArtifacts(persistence(), id, 'private-key', cloudConfig);

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Errored);
    const events = await eventLog().getWorkloadEvents(id);
    expect(events.slice(0, originalEvents.length)).toEqual(originalEvents);
    expect(
      events.slice(originalEvents.length).map((event) => event.state),
    ).toEqual([
      WorkloadState.Finalizing,
      WorkloadState.Finalizing,
      WorkloadState.Errored,
    ]);
    const rawMetadata = events.at(-1)!.metadata!;
    const metadata = JSON.parse(rawMetadata);
    expect(metadata).toMatchObject({
      ...exitDiagnostics,
      workloadExitCode: 137,
      finalSyncAttempts: 4,
    });
    expect(metadata).not.toHaveProperty('reason');
    expect(metadata).not.toHaveProperty('error');
    expect(metadata).not.toHaveProperty('exitMetadata');
    expect(rawMetadata.split(JSON.stringify(logs))).toHaveLength(2);
  });

  it('marks Failed when final-sync retries are exhausted', async () => {
    const id = 'lambda-final-sync-exhausted';
    const exitDiagnostics = {
      state: ContainerState.Exited,
      exitCode: 0,
      oomKilled: false,
      logs: 'workload completed before final sync failed',
    };
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        ...exitDiagnostics,
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: FINAL_SYNC_MAX_ATTEMPTS - 1,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    fake.default(new Error('still failing'));

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Failed);
    const events = await eventLog().getWorkloadEvents(id);
    const rawMetadata = events.at(-1)!.metadata!;
    const metadata = JSON.parse(rawMetadata);
    expect(metadata).toMatchObject({
      ...exitDiagnostics,
      reason: 'final-bucket-sync-failed',
      targetState: WorkloadState.Completed,
      workloadExitCode: 0,
      attempt: FINAL_SYNC_MAX_ATTEMPTS,
      maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      error: { message: 'still failing' },
    });
    expect(metadata).not.toHaveProperty('exitMetadata');
    expect(
      rawMetadata.split(JSON.stringify(exitDiagnostics.logs)),
    ).toHaveLength(2);
  });

  it('restarts an evicted spot VM instead of spending final-sync attempts on it', async () => {
    const id = 'aws-final-sync-evicted';
    const store = queries();
    const reconcile = async () =>
      reconcileFinalizingJob(persistence(), (await store.getWorkload(id))!);
    await createRunningAwsWorkload(id, true, undefined, 'results-bucket');
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        exitCode: 0,
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: FINAL_SYNC_MAX_ATTEMPTS - 1,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    const compute = makeMockCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      verifyVMPreemption: vi.fn().mockResolvedValue(true),
      startVM: vi.fn().mockResolvedValue('203.0.113.21'),
    });
    vi.mocked(createComputeProvider).mockReturnValueOnce(compute);
    fake.default(
      new Error('ssh: connect to host port 22: Connection timed out'),
    );

    await reconcile();

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Finalizing);
    expect(compute.startVM).toHaveBeenCalledWith('i-123');
    expect((await store.getVMs(id)).map((vm) => vm.ip)).toEqual([
      '203.0.113.21',
    ]);

    fake.reset();
    fake.on('ac-final', 'DONE 0\n');
    await reconcile();

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Completed);
  });

  it.each([
    [
      'the preemption observation throws',
      'fails open',
      vi.fn().mockRejectedValue(new Error('provider API down')),
      vi.fn(),
    ],
    [
      'the evicted VM cannot restart',
      'keeps the attempt bound',
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue(null),
    ],
  ])(
    'spends the last final-sync attempt when %s (%s)',
    async (_case, _why, verifyVMPreemption, startVM) => {
      const id = 'aws-final-sync-no-restart';
      const store = queries();
      await createRunningAwsWorkload(id, true, undefined, 'results-bucket');
      await lifecycle().updateState(id, WorkloadState.Finalizing, {
        metadata: {
          exitCode: 0,
          targetState: WorkloadState.Completed,
          workloadExitCode: 0,
          attempt: FINAL_SYNC_MAX_ATTEMPTS - 1,
          maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
        },
      });
      vi.mocked(createComputeProvider).mockReturnValueOnce(
        makeMockCloudCompute({
          type: CloudType.AWS,
          region: 'us-east-1',
          verifyVMPreemption,
          startVM,
        }),
      );
      fake.default(
        new Error('ssh: connect to host port 22: Connection timed out'),
      );

      await reconcileFinalizingJob(
        persistence(),
        (await store.getWorkload(id))!,
      );

      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Failed);
      const events = await eventLog().getWorkloadEvents(id);
      expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
        reason: 'final-bucket-sync-failed',
        attempt: FINAL_SYNC_MAX_ATTEMPTS,
      });
    },
  );

  it('marks Failed when a finalizing job has no live VM', async () => {
    const id = 'lambda-final-sync-vm-missing';
    const logs = 'workload completed before its host disappeared';
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        exitCode: 0,
        logs,
        targetState: WorkloadState.Completed,
        workloadExitCode: 0,
        attempt: 3,
        maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
      },
    });
    await releaseTestVms(id, '123');

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Failed);
    const events = await eventLog().getWorkloadEvents(id);
    const rawMetadata = events.at(-1)!.metadata!;
    const metadata = JSON.parse(rawMetadata);
    expect(metadata).toMatchObject({
      exitCode: 0,
      logs,
      reason: 'final-bucket-sync-vm-missing',
      targetState: WorkloadState.Completed,
      workloadExitCode: 0,
      attempt: 3,
      maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
    });
    expect(metadata).not.toHaveProperty('exitMetadata');
    expect(rawMetadata.split(JSON.stringify(logs))).toHaveLength(2);
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('preserves Errored semantics after successful VM-host final output sync', async () => {
    const id = 'aws-final-sync-error';
    await createRunningAwsWorkload(id);
    mockDockerExited(7);

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      outputBucket: 'results-bucket',
    });

    const store = queries();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Finalizing);

    // Detached final-sync unit's poll resolves to a successful sentinel.
    fake.on('ac-final', 'DONE 0\n');

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Errored);

    const events = await eventLog().getWorkloadEvents(id);
    expect(events.at(-2)?.state).toBe(WorkloadState.Finalizing);
    expect(events.at(-1)?.state).toBe(WorkloadState.Errored);
  });

  it('does not persist an ignored systemd cleanup warning as a sync error', async () => {
    const id = 'aws-ignored-rclone-systemd-warning';
    const workloadLogs = 'workload exited after model evaluation';
    const warning =
      'Jul 10 23:26:13 vm-1 systemd[1]: rclone-output.service: Failed to kill control group /system.slice/rclone-output.service, ignoring: Invalid argument';
    await createRunningAwsWorkload(id);
    mockDockerExitedWithLogs(7, workloadLogs);
    fake
      .on('ps -p 1 -o comm=', 'systemd\n')
      .on('systemctl is-active rclone-output', 'active\n')
      .on('systemctl is-active rclone-checkpoint', 'missing\n')
      // Old VM whose unit predates the log file: tail fails, the journalctl
      // fallback serves lifecycle noise containing "Failed …".
      .on('tail -200 /var/log/rclone-output.log', `${warning}\n`);

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      outputBucket: 'results-bucket',
    });

    const store = queries();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Finalizing);
    const events = await eventLog().getWorkloadEvents(id);
    const finalizingMetadata = JSON.parse(events.at(-1)!.metadata!);
    expect(finalizingMetadata.logs).toContain(workloadLogs);
    expect(finalizingMetadata.logs).not.toContain('output-sync:');
    expect(finalizingMetadata.logs).not.toContain(
      'Failed to kill control group',
    );
  });

  it('still persists structured rclone errors captured at container exit', async () => {
    const id = 'aws-structured-rclone-error-persisted';
    const workloadLogs = 'workload exited after model evaluation';
    const rcloneError =
      '2026/07/10 23:26:14 ERROR : results.json: Failed to copy: permission denied';
    await createRunningAwsWorkload(id);
    mockDockerExitedWithLogs(7, workloadLogs);
    fake
      .on('ps -p 1 -o comm=', 'systemd\n')
      .on('systemctl is-active rclone-output', 'active\n')
      .on('systemctl is-active rclone-checkpoint', 'missing\n')
      .on('tail -200 /var/log/rclone-output.log', `${rcloneError}\n`);

    await checkJobCompletion(persistence(), id, 'private-key', {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      outputBucket: 'results-bucket',
    });

    const events = await eventLog().getWorkloadEvents(id);
    const finalizingMetadata = JSON.parse(events.at(-1)!.metadata!);
    expect(finalizingMetadata.logs).toContain('output-sync:');
    expect(finalizingMetadata.logs).toContain(rcloneError);
  });

  it('forces Failed when a finalizing job has no finalization-control metadata', async () => {
    const id = 'lambda-final-sync-metadata-missing';
    const store = queries();
    await createRunningLambdaWorkload(id);
    await lifecycle().updateState(id, WorkloadState.Finalizing, {
      metadata: {
        reason: 'job finalization retry pending',
        error: { message: 'transient finalization failure' },
      },
    });

    expect(await eventLog().getLatestFinalizationEventMetadata(id)).toBeNull();

    fake.default({ stdout: '', stderr: '' });

    await finalizeJobArtifacts(persistence(), id, 'private-key', {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'test' },
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      outputBucket: 'results-bucket',
    });

    const workload = await store.getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Failed);

    const events = await eventLog().getWorkloadEvents(id);
    expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
      reason: 'final-bucket-sync-metadata-missing',
    });
    expect(fake.exec).not.toHaveBeenCalled();
  });
});

describe('classifyJobExit (fabric-not-ready, error 802)', () => {
  // Regression: a Lambda H100:2 slice whose NVSwitch fabric was not ready
  // crashed a customer training Job with CUDA error 802 ~40s after the container started.
  // Before the stopgap this fell through to terminal Errored (no retry, no
  // fresh node); it must now be Retrying so the monitor tears the VM down and
  // reprovisions on a different host.
  const fabricNotReady = {
    exitCode: 1,
    logs:
      'RuntimeError: Unexpected error from cudaGetDeviceCount(). ' +
      'Error 802: system not yet initialized',
  };

  it('retries a fabric-not-ready crash on a GPU target', () => {
    expect(classifyJobExit(null, fabricNotReady, true, GpuRuntime.Cuda)).toBe(
      WorkloadState.Retrying,
    );
  });

  it('does not retry the same log for a non-GPU job', () => {
    // gpuTarget=false: a CPU job merely probing CUDA must still go to Errored.
    expect(classifyJobExit(null, fabricNotReady, false, GpuRuntime.Cuda)).toBe(
      WorkloadState.Errored,
    );
  });

  it('still completes a clean exit', () => {
    expect(classifyJobExit(null, { exitCode: 0 }, true, GpuRuntime.Cuda)).toBe(
      WorkloadState.Completed,
    );
  });
});
