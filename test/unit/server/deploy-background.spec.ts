import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireAndForget, runStep } from '../../../src/api/services/task.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import * as workloadStoreModule from '../../../src/api/services/persistence.js';
import { CONTAINER_SETUP_TIMEOUT_MS } from '../../../src/api/config.js';
import { DeployError } from '../../../src/shared/errors.js';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import {
  drainWorkloadWork,
  hasWorkloadWork,
} from '../../../src/api/services/workload-work-registry.js';
import { log } from '../../../src/api/services/logger.js';
import { TimeoutError } from '../../../src/shared/utils.js';

// Mock the workload store module
vi.mock('../../../src/api/services/persistence.js', async () => {
  const actual = await vi.importActual(
    '../../../src/api/services/persistence.js',
  );
  return {
    ...actual,
    getWorkloadLifecycle: vi.fn().mockReturnValue({
      claimStep: vi.fn().mockResolvedValue(41),
      updateState: vi.fn().mockResolvedValue(true),
    }),
    getWorkloadOutcomes: vi.fn().mockReturnValue({
      publishTerminalOutcome: vi.fn().mockResolvedValue(true),
    }),
  };
});

// Mock the logger to avoid noise
vi.mock('../../../src/api/services/logger.js', () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('runStep', () => {
  let claimStepSpy: ReturnType<typeof vi.fn>;
  let publishTerminalOutcomeSpy: ReturnType<typeof vi.fn>;
  let updateStateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    claimStepSpy = vi.fn().mockResolvedValue(41);
    publishTerminalOutcomeSpy = vi.fn().mockResolvedValue({
      completedAt: 1,
    });
    updateStateSpy = vi.fn().mockResolvedValue(true);
    const lifecycle = {
      claimStep: claimStepSpy,
      updateState: updateStateSpy,
    };
    vi.mocked(workloadStoreModule.getWorkloadLifecycle).mockReturnValue(
      lifecycle as any,
    );
    const outcomes = { publishTerminalOutcome: publishTerminalOutcomeSpy };
    vi.mocked(workloadStoreModule.getWorkloadOutcomes).mockReturnValue(
      outcomes as any,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should transition to error state when step throws', async () => {
    const mockError = new Error('Step failed');

    await expect(
      runStep({
        id: 'test-workload-123',
        step: WorkloadState.Provisioning,
        fn: () => Promise.reject(mockError),
        timeoutMs: 1000,
        onErrorState: WorkloadState.Failed,
      }),
    ).rejects.toThrow('Step failed');

    // Should have logged start state
    expect(claimStepSpy).toHaveBeenCalledWith(
      'test-workload-123',
      WorkloadState.Provisioning,
      undefined,
    );

    // Routing only. What the row ends up holding is asserted by reading it
    // back in deploy.spec.ts; persistence is mocked here, so a spy could not
    // show it survived being written. See RFC 0023.
    expect(publishTerminalOutcomeSpy).toHaveBeenCalledWith(
      'test-workload-123',
      WorkloadState.Failed,
      WorkloadState.Provisioning,
      {
        metadata: expect.objectContaining({
          error: expect.anything(),
        }),
      },
    );
  });

  it('should NOT transition to error state when step succeeds', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await runStep({
      id: 'test-workload-123',
      step: WorkloadState.Provisioning,
      fn,
      timeoutMs: 1000,
      onErrorState: WorkloadState.Failed,
    });

    // Should have logged start state only
    expect(claimStepSpy).toHaveBeenCalledOnce();
    expect(claimStepSpy).toHaveBeenCalledWith(
      'test-workload-123',
      WorkloadState.Provisioning,
      undefined,
    );
    expect(fn).toHaveBeenCalledWith(41);
    expect(publishTerminalOutcomeSpy).not.toHaveBeenCalled();
    expect(updateStateSpy).not.toHaveBeenCalled();
  });

  it('waits for data-dependent work when no wall-clock timeout is supplied', async () => {
    vi.useFakeTimers();
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    try {
      const step = runStep({
        id: 'large-input-hydrate',
        step: WorkloadState.Syncing,
        fn: () => work,
        timeoutMs: null,
        onErrorState: WorkloadState.Retrying,
      });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(updateStateSpy).not.toHaveBeenCalled();

      resolveWork();
      await expect(step).resolves.toBeUndefined();
    } finally {
      resolveWork();
      vi.useRealTimers();
    }
  });

  it('should stay in same state when error state equals step state (retryable)', async () => {
    const mockError = new Error('Termination failed');

    await expect(
      runStep({
        id: 'test-workload-123',
        step: WorkloadState.Retrying,
        fn: () => Promise.reject(mockError),
        timeoutMs: 1000,
        onErrorState: WorkloadState.Retrying,
      }),
    ).rejects.toThrow('Termination failed');

    // Should have logged start state AND error (for debugging retryable errors)
    expect(claimStepSpy).toHaveBeenCalledWith(
      'test-workload-123',
      WorkloadState.Retrying,
      undefined,
    );
    expect(updateStateSpy).toHaveBeenCalledOnce();
    expect(updateStateSpy).toHaveBeenCalledWith(
      'test-workload-123',
      WorkloadState.Retrying,
      {
        metadata: expect.objectContaining({ error: expect.anything() }),
      },
    );
  });

  it('routes application 4xx DeployError to Invalid even when a provider classifier is present', async () => {
    const error = new DeployError(
      "Bucket 'missing-input' does not exist. Please create it before deploying.",
      400,
    );
    const classifyError = vi.fn(
      () => CloudFailureDiagnosis.TemporaryProviderFailure,
    );
    const onError = vi.fn().mockResolvedValue(undefined);

    await expect(
      runStep({
        id: 'test-workload-123',
        step: WorkloadState.Provisioning,
        fn: () => Promise.reject(error),
        timeoutMs: 1000,
        onErrorState: WorkloadState.Retrying,
        onError,
        classifyError,
      }),
    ).rejects.toBe(error);

    expect(onError).toHaveBeenCalledWith(error);
    expect(classifyError).not.toHaveBeenCalled();
    expect(publishTerminalOutcomeSpy).toHaveBeenLastCalledWith(
      'test-workload-123',
      WorkloadState.Invalid,
      WorkloadState.Provisioning,
      {
        // Routing and classification only; the stored error is asserted by
        // read-back in deploy.spec.ts. See RFC 0023.
        metadata: expect.objectContaining({
          error: expect.anything(),
          diagnosis: CloudFailureDiagnosis.InvalidRequest,
          disposition: FailureDisposition.TerminalInvalid,
          errorKind: CloudFailureDiagnosis.InvalidRequest,
        }),
      },
    );
  });

  it('should include startMetadata in the step start event', async () => {
    await runStep({
      id: 'test-workload-123',
      step: WorkloadState.Provisioning,
      fn: () => Promise.resolve(),
      timeoutMs: 1000,
      onErrorState: WorkloadState.Failed,
      startMetadata: { region: 'us-east-1' },
    });

    expect(claimStepSpy).toHaveBeenCalledWith(
      'test-workload-123',
      WorkloadState.Provisioning,
      { metadata: { region: 'us-east-1' } },
    );
  });

  describe('Starting step timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('CONTAINER_SETUP_TIMEOUT_MS should be 10 minutes', () => {
      expect(CONTAINER_SETUP_TIMEOUT_MS).toBe(10 * 60 * 1000);
    });

    it('should timeout after CONTAINER_SETUP_TIMEOUT_MS with correct error message', async () => {
      let resolveOperation!: () => void;
      const operation = new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });

      const stepPromise = runStep({
        id: 'test-workload-123',
        step: WorkloadState.Starting,
        fn: () => operation,
        timeoutMs: CONTAINER_SETUP_TIMEOUT_MS,
        onErrorState: WorkloadState.Errored,
      });

      // Set up rejection handler BEFORE advancing timers to avoid unhandled rejection
      const errorPromise = stepPromise.catch((e) => e);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(CONTAINER_SETUP_TIMEOUT_MS + 1);

      const error = await errorPromise;
      expect(error.message).toContain('starting timed out after 10 minutes');

      // Should have transitioned to Errored with the error object (logger will serialize)
      expect(publishTerminalOutcomeSpy).toHaveBeenCalledWith(
        'test-workload-123',
        WorkloadState.Errored,
        WorkloadState.Starting,
        expect.objectContaining({
          metadata: expect.objectContaining({
            error: expect.objectContaining({
              message: expect.stringContaining(
                'starting timed out after 10 minutes',
              ),
            }),
          }),
        }),
      );

      expect(hasWorkloadWork('test-workload-123')).toBe(true);
      resolveOperation();
      await drainWorkloadWork('test-workload-123');
      expect(hasWorkloadWork('test-workload-123')).toBe(false);
    });

    it('records timeout state immediately but delays teardown until initialization settles', async () => {
      const workloadId = 'timed-out-initialization';
      let resolveInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      });
      let resolveTeardown!: () => void;
      const teardown = new Promise<void>((resolve) => {
        resolveTeardown = resolve;
      });
      const onError = vi.fn(() => teardown);
      const fn = vi.fn(() => initialization);

      const stepPromise = runStep({
        id: workloadId,
        step: WorkloadState.Initializing,
        fn,
        timeoutMs: 1_000,
        onErrorState: WorkloadState.Retrying,
        onError,
      });
      const errorPromise = stepPromise.catch((error) => error);

      await vi.advanceTimersByTimeAsync(1_001);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(TimeoutError);
      expect(fn).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(updateStateSpy).toHaveBeenCalledWith(
        workloadId,
        WorkloadState.Retrying,
        expect.objectContaining({
          metadata: expect.objectContaining({
            error: expect.objectContaining({
              name: error.name,
              message: error.message,
            }),
          }),
        }),
      );
      expect(hasWorkloadWork(workloadId)).toBe(true);

      resolveInitialization();
      await Promise.resolve();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(error);
      expect(hasWorkloadWork(workloadId)).toBe(true);

      resolveTeardown();
      await drainWorkloadWork(workloadId);

      expect(hasWorkloadWork(workloadId)).toBe(false);
    });

    it('logs a late rejection without replacing the foreground TimeoutError', async () => {
      const workloadId = 'late-step-rejection';
      let rejectOperation!: (error: Error) => void;
      const operation = new Promise<void>((_resolve, reject) => {
        rejectOperation = reject;
      });
      const lateError = new Error('provider rejected after deadline');

      const stepPromise = runStep({
        id: workloadId,
        step: WorkloadState.Provisioning,
        fn: () => operation,
        timeoutMs: 1_000,
        onErrorState: WorkloadState.Retrying,
      });
      const errorPromise = stepPromise.catch((error) => error);

      await vi.advanceTimersByTimeAsync(1_001);
      const foregroundError = await errorPromise;
      expect(foregroundError).toBeInstanceOf(TimeoutError);

      rejectOperation(lateError);
      await drainWorkloadWork(workloadId);

      expect(foregroundError).toBeInstanceOf(TimeoutError);
      expect(log.warn).toHaveBeenCalledWith(
        'Workload step rejected after its timeout',
        {
          id: workloadId,
          step: WorkloadState.Provisioning,
          // The whole error, not its message: the logger serializes and
          // redacts it, keeping the name and stack the message alone drops.
          error: lateError,
        },
      );
    });
  });
});

describe('fireAndForget', () => {
  it('should not throw on rejected promise', async () => {
    const rejectedPromise = Promise.reject(new Error('Test error'));

    expect(() => fireAndForget(rejectedPromise)).not.toThrow();

    // Allow microtask to complete
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('should allow resolved promise to complete', async () => {
    let completed = false;
    const promise = Promise.resolve().then(() => {
      completed = true;
    });

    fireAndForget(promise);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(true);
  });
});
