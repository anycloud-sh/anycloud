import { describe, expect, it, vi } from 'vitest';
import { WorkloadState } from '../../../../src/shared/workload.js';
import type { WorkloadReconcileWork } from '../../../../src/api/services/workload-reconciler.js';
import {
  reconcileTargetedJob,
  type TargetedJobDeps,
} from '../../../../src/api/services/workload-workflows/targeted-job.js';
import { makeStoredWorkload } from '../../helpers/fixtures.js';

function makeDeps(overrides: {
  execution?: { endedAt: number | null } | null;
  queued?: 'queued' | 'release-pending' | 'stale';
  cleaned?: boolean;
}) {
  return {
    executions: {
      getTargetedExecution: vi.fn(async () => overrides.execution ?? null),
    },
    lifecycle: {
      queueRetryCandidate: vi.fn(async () => overrides.queued ?? 'queued'),
    },
    outcomes: {
      markCleanupComplete: vi.fn(async () => overrides.cleaned ?? true),
      recordCleanupError: vi.fn(async () => {}),
    },
    deleteManagedCheckpoint: vi.fn(async () => {}),
    deployments: { schedule: vi.fn() },
  } satisfies TargetedJobDeps;
}

function targetedJob(state: WorkloadState, cleanedAt: number | null = null) {
  return makeStoredWorkload({
    id: 'job',
    deploymentId: 'target',
    cloudProvider: null,
    state,
    cleanedAt,
  });
}

function retryWork(
  kind: 'retry-prepare' | 'retry-launch',
): WorkloadReconcileWork {
  return {
    workloadId: 'job',
    kind,
    expectedRevision: 7,
    retry: {
      id: 'job',
      state: WorkloadState.Retrying,
      retryCount: 0,
      lastRetryAt: 0,
      failedAtState: null,
      resubmitCount: 0,
      regionDenied: 0,
      deniedRetryCount: 0,
    },
  };
}

function work(
  kind: 'poll' | 'cleanup' | 'active-recovery' | 'finalization',
): WorkloadReconcileWork {
  return { workloadId: 'job', kind };
}

describe('Deployment-targeted Job reconciliation', () => {
  it('ignores a Workload without a target Deployment', async () => {
    const deps = makeDeps({});
    await expect(
      reconcileTargetedJob(
        deps,
        work('poll'),
        makeStoredWorkload({ deploymentId: null }),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
    expect(deps.deployments.schedule).not.toHaveBeenCalled();
  });

  it('treats retry work outside Retrying or Recovering as stale', async () => {
    const deps = makeDeps({});
    await expect(
      reconcileTargetedJob(
        deps,
        retryWork('retry-launch'),
        targetedJob(WorkloadState.Running),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
    expect(deps.lifecycle.queueRetryCandidate).not.toHaveBeenCalled();
  });

  it('completes retry preparation without queueing the launch', async () => {
    const deps = makeDeps({});
    await expect(
      reconcileTargetedJob(
        deps,
        retryWork('retry-prepare'),
        targetedJob(WorkloadState.Retrying),
      ),
    ).resolves.toEqual({ disposition: 'completed' });
    expect(deps.lifecycle.queueRetryCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', { disposition: 'completed' }],
    ['release-pending', { disposition: 'deferred', reason: 'release-pending' }],
    ['stale', { disposition: 'stale' }],
  ] as const)(
    'queues a retry launch at the expected revision (%s)',
    async (queued, result) => {
      const deps = makeDeps({ queued });
      await expect(
        reconcileTargetedJob(
          deps,
          retryWork('retry-launch'),
          targetedJob(WorkloadState.Retrying),
        ),
      ).resolves.toEqual(result);
      expect(deps.lifecycle.queueRetryCandidate).toHaveBeenCalledWith('job', 7);
    },
  );

  it.each([
    ['an active Job', targetedJob(WorkloadState.Running)],
    ['a cleaned Job', targetedJob(WorkloadState.Completed, 1)],
  ])('treats cleanup of %s as stale', async (_label, workload) => {
    const deps = makeDeps({});
    await expect(
      reconcileTargetedJob(deps, work('cleanup'), workload),
    ).resolves.toEqual({ disposition: 'stale' });
    expect(deps.executions.getTargetedExecution).not.toHaveBeenCalled();
    expect(deps.outcomes.markCleanupComplete).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'completed'],
    [false, 'stale'],
  ] as const)(
    'marks a terminal Job without an execution clean (cleaned: %s)',
    async (cleaned, disposition) => {
      const deps = makeDeps({ cleaned });
      await expect(
        reconcileTargetedJob(
          deps,
          work('cleanup'),
          targetedJob(WorkloadState.Terminated),
        ),
      ).resolves.toEqual({ disposition });
      expect(deps.outcomes.markCleanupComplete).toHaveBeenCalledWith('job');
      expect(deps.deployments.schedule).not.toHaveBeenCalled();
    },
  );

  it('defers cleanup of a live execution to its Deployment', async () => {
    const deps = makeDeps({ execution: { endedAt: null } });
    await expect(
      reconcileTargetedJob(
        deps,
        work('cleanup'),
        targetedJob(WorkloadState.Terminated),
      ),
    ).resolves.toEqual({ disposition: 'deferred' });
    expect(deps.outcomes.markCleanupComplete).not.toHaveBeenCalled();
    expect(deps.deployments.schedule).toHaveBeenCalledWith('target');
  });

  it.each(['poll', 'active-recovery'] as const)(
    'wakes the Deployment for %s work on a running Job only',
    async (kind) => {
      const deps = makeDeps({});
      await expect(
        reconcileTargetedJob(
          deps,
          work(kind),
          targetedJob(WorkloadState.Starting),
        ),
      ).resolves.toEqual({ disposition: 'stale' });
      expect(deps.deployments.schedule).not.toHaveBeenCalled();

      await expect(
        reconcileTargetedJob(
          deps,
          work(kind),
          targetedJob(WorkloadState.Running),
        ),
      ).resolves.toEqual({ disposition: 'completed' });
      expect(deps.deployments.schedule).toHaveBeenCalledWith('target');
    },
  );

  it('never finalizes a targeted Job', async () => {
    const deps = makeDeps({});
    await expect(
      reconcileTargetedJob(
        deps,
        work('finalization'),
        targetedJob(WorkloadState.Finalizing),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });
});
