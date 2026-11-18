/**
 * Deployment-targeted Job reconciliation. A targeted Job keeps its own
 * execution protocol: its Deployment's application claims and reports each
 * execution, so this workflow never enters VM-host startup, owns no VM rows,
 * and only wakes the Deployment controller or settles durable outcomes.
 */

import type {
  WorkloadReconcileResult,
  WorkloadReconcileWork,
} from '../workload-reconciler.js';
import type { StoredWorkload } from '../workload-record.js';
import {
  LIVE_EXECUTION_STATES,
  WorkloadState,
  TERMINAL_STATES,
} from '../../../shared/workload.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';

/** The durable retry admission. */
interface TargetedJobLifecycle {
  queueRetryCandidate(
    workloadId: string,
    expectedRevision: number,
  ): Promise<'queued' | 'release-pending' | 'stale'>;
}
/** The durable cleanup fence. */
interface TargetedJobOutcomes {
  markCleanupComplete(workloadId: string): Promise<boolean>;
  recordCleanupError(workloadId: string, reason: string): Promise<void>;
}
export interface TargetedJobDeps {
  executions: {
    getTargetedExecution(
      jobId: string,
    ): Promise<{ endedAt: number | null } | null>;
  };
  lifecycle: TargetedJobLifecycle;
  outcomes: TargetedJobOutcomes;
  /** Deletes a spot pool Job's managed checkpoint bucket (D-managed), if any. */
  deleteManagedCheckpoint(workload: StoredWorkload): Promise<void>;
  /** The Deployment controller, which observes executions in Kubernetes. */
  deployments: { schedule(deploymentId: string): void };
}

export async function reconcileTargetedJob(
  deps: TargetedJobDeps,
  work: WorkloadReconcileWork,
  workload: StoredWorkload,
): Promise<WorkloadReconcileResult> {
  const { executions, lifecycle, outcomes, deployments } = deps;
  const targetId = workload.deploymentId;
  if (targetId === null) return { disposition: 'stale' };

  const state = workload.state as WorkloadState;
  switch (work.kind) {
    case 'retry-prepare':
    case 'retry-launch': {
      if (
        !work.retry ||
        (state !== WorkloadState.Retrying && state !== WorkloadState.Recovering)
      ) {
        return { disposition: 'stale' };
      }

      // recordAttemptOutcome spends the retry budget (O15) as attempts end.
      if (work.kind === 'retry-prepare') {
        return { disposition: 'completed' };
      }
      const queued = await lifecycle.queueRetryCandidate(
        workload.id,
        work.expectedRevision,
      );
      if (queued === 'release-pending') {
        return { disposition: 'deferred', reason: 'release-pending' };
      }
      return { disposition: queued === 'queued' ? 'completed' : 'stale' };
    }

    case 'cleanup': {
      if (!TERMINAL_STATES.includes(state)) {
        return { disposition: 'stale' };
      }
      if (workload.cleanedAt !== null) return { disposition: 'stale' };
      const execution = await executions.getTargetedExecution(workload.id);
      if (execution && execution.endedAt === null) {
        // A running termination is released only by the in-Pod cleanup
        // acknowledgement or by Kubernetes-observed process replacement.
        deployments.schedule(targetId);
        return { disposition: 'deferred' };
      }
      try {
        await deps.deleteManagedCheckpoint(workload);
      } catch (error) {
        await outcomes.recordCleanupError(workload.id, errorMessage(error));
        return { disposition: 'deferred' };
      }
      const cleaned = await outcomes.markCleanupComplete(workload.id);
      return { disposition: cleaned ? 'completed' : 'stale' };
    }

    case 'poll':
    case 'active-recovery':
      if (!LIVE_EXECUTION_STATES.includes(state)) {
        return { disposition: 'stale' };
      }
      deployments.schedule(targetId);
      return { disposition: 'completed' };

    case 'finalization':
      return { disposition: 'stale' };
  }
}
