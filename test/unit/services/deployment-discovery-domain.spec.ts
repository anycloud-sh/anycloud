import { claimSpendBlock } from '../../../src/api/services/spend-controls.js';
import { getPersistence } from '../../../src/api/services/persistence.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';
import { ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE } from '../../../src/api/services/kubernetes/pool-objects.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../src/api/services/kubernetes/identity.js';
import { makeClusterKubernetesClientFixture } from '../helpers/fixtures.js';
import { WorkloadState } from '../../../src/shared/workload.js';

function fixture(maxOutstandingAcquisitionDependencies?: number) {
  const pod = {
    metadata: {
      name: 'pod',
      uid: 'pod',
      labels: Object.fromEntries([
        kubernetesWorkloadPodSelector('deployment').split('='),
      ]) as Record<string, string>,
      annotations: { 'anycloud.sh/generation': '1' },
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'workload',
          ready: true,
          containerID: 'container',
          image: 'image',
          imageID: 'image-id',
          restartCount: 0,
        },
      ],
    },
  };
  const createTokenReview = vi.fn().mockResolvedValue({
    status: {
      authenticated: true,
      audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
      user: {
        username: `system:serviceaccount:namespace:${kubernetesWorkloadResourceName('deployment', 'deployment')}`,
        extra: {
          'authentication.kubernetes.io/pod-uid': ['pod'],
          'authentication.kubernetes.io/pod-name': ['pod'],
        },
      },
    },
  });
  const readNamespacedPod = vi.fn().mockResolvedValue(pod);
  const jobs = {
    discoverTargetedJob: vi.fn().mockResolvedValue({ kind: 'empty' }),
    podHasClaimed: vi.fn().mockResolvedValue(false),
    listTargetedExecutions: vi.fn().mockResolvedValue([]),
    claimTargetedJob: vi.fn().mockResolvedValue({
      kind: 'selected',
      jobId: 'job',
      executionId: 'execution',
    }),
    getTargetedExecution: vi.fn().mockResolvedValue({
      deploymentId: 'deployment',
      jobId: 'job',
      executionId: 'execution',
      generation: 1,
      podUid: 'pod',
      containerId: 'container',
      state: WorkloadState.Running,
      cleanedAt: null,
    }),
    reportTargetedJobExecution: vi.fn().mockResolvedValue(true),
    completeTargetedJobCleanup: vi.fn().mockResolvedValue(true),
    reportTargetedJobPhase: vi.fn(),
    getTargetedJobSpec: vi.fn(),
    recordAttemptLogTail: vi.fn(),
    closeReplica: vi.fn(),
  };
  const getMetadataById = vi.fn().mockResolvedValue({
    id: 'deployment',
    nodePoolId: 'pool',
    managed: false,
    deletedAt: null,
  });
  const runtime = {
    config: { namespace: 'namespace' },
    nodePool: {
      clusterId: 'cluster-a',
      nodePoolId: 'pool',
      nvidiaGpusPerNode: 0,
    },
    cluster: makeClusterKubernetesClientFixture({
      authentication: { createTokenReview },
      core: { readNamespacedPod },
    }),
  };
  const runtimes = { resolve: vi.fn().mockResolvedValue(runtime) };
  const reconcile = vi.fn();
  const domain = createDeploymentWorkloadDomain({
    reconcile,
    jobChanges: getPersistence().jobChanges,
    claimSpendBlock,
    mintStorage: async () => ({}),
    maxOutstandingAcquisitionDependencies,
    deployments: { getMetadataById },
    jobs,
    runtimes,
  });
  const controller = new AbortController();
  const operation = {
    signal: controller.signal,
    startedAt: performance.now(),
    deadlineAt: performance.now() + 30_000,
  };
  return {
    domain,
    reconcile,
    runtime,
    runtimes,
    jobChanges: getPersistence().jobChanges,
    getMetadataById,
    jobs,
    createTokenReview,
    readNamespacedPod,
    pod,
    controller,
    operation,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('read-only Deployment discovery and exact claiming', () => {
  it('0029/S28 wakes on runtime readiness without polling or a Job mutation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.pod.status.containerStatuses[0].ready = false;
    const observed = f.domain.candidate(
      'deployment',
      20_000,
      'Bearer token',
      f.operation,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.jobs.discoverTargetedJob).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false }),
    );
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.jobs.discoverTargetedJob).toHaveBeenCalledTimes(1);
    f.pod.status.containerStatuses[0].ready = true;
    f.jobs.discoverTargetedJob.mockResolvedValue({
      kind: 'candidate',
      candidate: {
        jobId: 'arrived',
        submissionRevision: 0,
        previousExecutionId: null,
      },
    });
    f.jobChanges.notifyDeployment('deployment');
    expect(await observed).toEqual({
      status: 200,
      body: {
        jobId: 'arrived',
        submissionRevision: 0,
        previousExecutionId: null,
      },
    });
    expect(f.readNamespacedPod).toHaveBeenCalledTimes(2);
    expect(f.createTokenReview).toHaveBeenCalledTimes(2);
    expect(f.jobs.claimTargetedJob).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queues the Deployment reconcile once an outcome or a cleanup frees its slot', async () => {
    const f = fixture();
    await f.domain.outcome(
      'deployment',
      'job',
      { executionId: 'execution', outcome: 'completed' },
      'Bearer token',
    );
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith('deployment');
    await f.domain.cleanup('deployment', 'job', 'execution', 'Bearer token');
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    // A fenced report changes nothing, so nothing is queued.
    f.jobs.completeTargetedJobCleanup.mockResolvedValueOnce(false);
    await expect(
      f.domain.cleanup('deployment', 'job', 'execution', 'Bearer token'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('captures a committed change while its discovery read is still in flight', async () => {
    const f = fixture();
    f.jobs.discoverTargetedJob
      .mockImplementationOnce(async () => {
        f.jobChanges.notifyDeployment('deployment');
        return { kind: 'empty' };
      })
      .mockResolvedValueOnce({
        kind: 'candidate',
        candidate: {
          jobId: 'raced',
          submissionRevision: 0,
          previousExecutionId: null,
        },
      });
    await expect(
      f.domain.candidate('deployment', 20_000, 'Bearer token', f.operation),
    ).resolves.toMatchObject({
      status: 200,
      body: { jobId: 'raced' },
    });
    expect(f.jobs.discoverTargetedJob).toHaveBeenCalledTimes(2);
    expect(f.createTokenReview).toHaveBeenCalledTimes(2);
  });

  it.each(['revoked token', 'replaced Pod', 'unavailable Kubernetes'] as const)(
    'revalidates %s after waking',
    async (failure) => {
      vi.useFakeTimers();
      const f = fixture();
      const result = f.domain.candidate(
        'deployment',
        20_000,
        'Bearer token',
        f.operation,
      );
      const rejection = expect(result).rejects.toMatchObject({
        statusCode:
          failure === 'unavailable Kubernetes'
            ? 503
            : failure === 'replaced Pod'
              ? 409
              : 401,
      });
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'revoked token')
        f.createTokenReview.mockResolvedValue({
          status: { authenticated: false },
        });
      else if (failure === 'replaced Pod') f.pod.metadata.uid = 'replacement';
      else f.readNamespacedPod.mockRejectedValue(new Error('offline'));
      f.jobChanges.notifyDeployment('deployment');
      await rejection;
      expect(f.jobs.discoverTargetedJob).toHaveBeenCalledOnce();
      expect(f.jobs.claimTargetedJob).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('isolates other Deployment signals and expires without another read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = f.domain.candidate(
      'deployment',
      20_000,
      'Bearer token',
      f.operation,
    );
    await vi.advanceTimersByTimeAsync(0);
    f.jobChanges.notifyDeployment('another');
    f.jobChanges.notify('deployment');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toEqual({ status: 204 });
    expect(f.jobs.discoverTargetedJob).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the pre-authentication observation cutoff and discards a late candidate', async () => {
    const f = fixture();
    f.jobs.discoverTargetedJob.mockResolvedValue({
      kind: 'candidate',
      candidate: {
        jobId: 'job',
        submissionRevision: 0,
        previousExecutionId: null,
      },
    });
    await expect(
      f.domain.candidate('deployment', 100, 'Bearer token', {
        ...f.operation,
        startedAt: performance.now() - 200,
      }),
    ).resolves.toEqual({ status: 204 });
    expect(f.jobs.claimTargetedJob).not.toHaveBeenCalled();
  });

  it.each(['createTokenReview', 'readNamespacedPod'] as const)(
    'bounds stalled %s and fences its late resolution',
    async (dependency) => {
      const f = fixture();
      let finish: ((result: unknown) => void) | undefined;
      f[dependency].mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const result = f.domain.claim(
        'deployment',
        'job',
        'execution',
        { submissionRevision: 0, previousExecutionId: null },
        'Bearer token',
        f.operation,
      );
      const rejection = expect(result).rejects.toThrow('request expired');
      await vi.waitFor(() => expect(f[dependency]).toHaveBeenCalled());
      f.controller.abort(new Error('request expired'));
      await rejection;
      finish?.(dependency === 'readNamespacedPod' ? f.pod : {});
      await Promise.resolve();
      expect(f.jobs.claimTargetedJob).not.toHaveBeenCalled();
    },
  );

  it('keeps lifecycle calls usable while discovery waits', async () => {
    vi.useFakeTimers();
    const f = fixture(1);
    const discovering = f.domain.candidate(
      'deployment',
      20_000,
      'Bearer token',
      f.operation,
    );
    const rejection = expect(discovering).rejects.toThrow('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      f.domain.candidate('deployment', 0, 'Bearer token'),
    ).resolves.toEqual({ status: 204 });
    await expect(
      f.domain.outcome(
        'deployment',
        'job',
        { executionId: 'execution', outcome: 'completed' },
        'Bearer token',
      ),
    ).resolves.toBeUndefined();
    await expect(
      f.domain.cleanup('deployment', 'job', 'execution', 'Bearer token'),
    ).resolves.toBeUndefined();
    f.controller.abort(new Error('disconnected'));
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.jobs.discoverTargetedJob).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['createTokenReview', 'resolve'],
    ['createTokenReview', 'reject'],
    ['readNamespacedPod', 'resolve'],
    ['readNamespacedPod', 'reject'],
  ] as const)(
    'retains cancelled %s capacity until the underlying call can %s',
    async (dependency, settlement) => {
      const f = fixture(1);
      let settle!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      f[dependency].mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              settlement === 'resolve'
                ? resolve(undefined)
                : reject(new Error('dependency closed'));
            started();
          }),
      );
      const cancelled = f.domain.candidate(
        'deployment',
        0,
        'Bearer token',
        f.operation,
      );
      const rejected = expect(cancelled).rejects.toThrow('disconnected');
      await entered;
      f.controller.abort(new Error('disconnected'));
      await rejected;

      const startedLookups = f.getMetadataById.mock.calls.length;
      await expect(
        f.domain.candidate('deployment', 0, 'Bearer token'),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(f.getMetadataById).toHaveBeenCalledTimes(startedLookups);
      await expect(
        f.domain.cancellation('deployment', 'job', 'execution', 'Bearer token'),
      ).resolves.toEqual({ cancelled: false });
      await expect(
        f.domain.outcome(
          'deployment',
          'job',
          { executionId: 'execution', outcome: 'completed' },
          'Bearer token',
        ),
      ).resolves.toBeUndefined();
      await expect(
        f.domain.cleanup('deployment', 'job', 'execution', 'Bearer token'),
      ).resolves.toBeUndefined();

      settle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(
        f.domain.candidate('deployment', 0, 'Bearer token'),
      ).resolves.toEqual({ status: 204 });
      expect(f.jobs.claimTargetedJob).not.toHaveBeenCalled();
    },
  );

  it('releases acquisition capacity when a dependency throws before returning a promise', async () => {
    const f = fixture(1);
    const error = new Error('lookup failed');
    f.getMetadataById.mockImplementationOnce(() => {
      throw error;
    });
    await expect(
      f.domain.candidate('deployment', 0, 'Bearer token'),
    ).rejects.toBe(error);
    await expect(
      f.domain.candidate('deployment', 0, 'Bearer token'),
    ).resolves.toEqual({ status: 204 });
  });

  it.each([
    ['stale', 'WORKLOAD_CANDIDATE_STALE'],
    ['execution-used', 'WORKLOAD_EXECUTION_USED'],
    ['conflict', undefined],
  ])('preserves the store classification %s', async (kind, code) => {
    const f = fixture();
    f.jobs.claimTargetedJob.mockResolvedValue({ kind });
    await expect(
      f.domain.claim(
        'deployment',
        'job',
        'execution',
        { submissionRevision: 0, previousExecutionId: null },
        'Bearer token',
        f.operation,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code });
  });

  it('authenticates an unready process before recovering its existing execution', async () => {
    const f = fixture();
    f.pod.status.containerStatuses[0].ready = false;
    await expect(
      f.domain.claim(
        'deployment',
        'job',
        'execution',
        { submissionRevision: 0, previousExecutionId: null },
        'Bearer token',
        f.operation,
      ),
    ).resolves.toEqual({ jobId: 'job', executionId: 'execution' });
    expect(f.jobs.claimTargetedJob).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false }),
    );
  });
});

describe('Deployment cancellation waits', () => {
  it('waits quietly and wakes on termination without advancing a polling timer', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.domain.cancellation(
      'deployment',
      'job',
      'execution',
      'Bearer token',
      20_000,
      f.operation,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.jobs.getTargetedExecution).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.jobs.getTargetedExecution).toHaveBeenCalledTimes(1);
    expect(f.createTokenReview).toHaveBeenCalledTimes(1);
    f.jobs.getTargetedExecution.mockResolvedValue({
      ...(await f.jobs.getTargetedExecution()),
      state: WorkloadState.Terminated,
    });
    f.jobChanges.notify('job');
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(f.createTokenReview).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([WorkloadState.Completed, WorkloadState.Retrying])(
    'ends the wait when the execution becomes %s',
    async (state) => {
      vi.useFakeTimers();
      const f = fixture();
      const execution = await f.jobs.getTargetedExecution();
      const pending = f.domain.cancellation(
        'deployment',
        'job',
        'execution',
        'Bearer token',
        20_000,
        f.operation,
      );
      await vi.advanceTimersByTimeAsync(0);
      f.jobs.getTargetedExecution.mockResolvedValue({ ...execution, state });
      f.jobChanges.notify('job');
      await expect(pending).resolves.toEqual({ cancelled: false });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('returns false on wait expiry and revalidates the caller', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.domain.cancellation(
      'deployment',
      'job',
      'execution',
      'Bearer token',
      100,
      f.operation,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ cancelled: false });
    expect(f.createTokenReview).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a disconnect during the database read and removes its waiter', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: unknown) => void;
    const read = new Promise((resolve) => {
      release = resolve;
    });
    f.jobs.getTargetedExecution.mockReturnValue(read);
    const pending = f.domain.cancellation(
      'deployment',
      'job',
      'execution',
      'Bearer token',
      20_000,
      f.operation,
    );
    const reason = new Error('HTTP request disconnected');
    const failure = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    f.controller.abort(reason);
    await failure;
    release(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects replacement execution identity after a notification', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const execution = await f.jobs.getTargetedExecution();
    const pending = f.domain.cancellation(
      'deployment',
      'job',
      'execution',
      'Bearer token',
      20_000,
      f.operation,
    );
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 409 });
    await vi.advanceTimersByTimeAsync(0);
    f.jobs.getTargetedExecution.mockResolvedValue({
      ...execution,
      executionId: 'replacement',
    });
    f.jobChanges.notify('job');
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a token invalidated while waiting before returning a result', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const execution = await f.jobs.getTargetedExecution();
    const pending = f.domain.cancellation(
      'deployment',
      'job',
      'execution',
      'Bearer token',
      20_000,
      f.operation,
    );
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 401 });
    await vi.advanceTimersByTimeAsync(0);
    f.createTokenReview.mockResolvedValue({ status: { authenticated: false } });
    f.jobs.getTargetedExecution.mockResolvedValue({
      ...execution,
      state: WorkloadState.Terminated,
    });
    f.jobChanges.notify('job');
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
