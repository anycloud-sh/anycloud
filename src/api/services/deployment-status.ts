import type {
  DeploymentStatus,
  DeploymentSummary,
} from '../../shared/api-contract/deployments-schemas.js';
import { WorkloadState } from '../../shared/workload.js';
import type { StoredDeployment } from './deployment-store.js';
import type { TargetedJobStatusSnapshot } from './repositories/deployment-executions.js';

export interface DeploymentRuntimeObservation {
  workload: NonNullable<DeploymentSummary['workload']>;
  appliedGeneration: number | null;
  /** The native Deployment's applied revision has finished rolling out. */
  rolledOut: boolean;
  containerReady: boolean | null;
  /** The native Deployment's `status.readyReplicas`. */
  readyReplicas: number;
  containerRunning: boolean;
  /** Kubernetes keeps retrying, but the container can't start as configured. */
  containerFailed: boolean;
  podTerminating: boolean;
  probeConfigured: boolean | null;
  observedAt: number;
}

export type DeploymentObservation =
  | { kind: 'observed'; runtime: DeploymentRuntimeObservation }
  | { kind: 'unavailable'; message: string }
  | { kind: 'not-requested' };

/**
 * Why a queued pool Job waits (RFC 0044 § Waiting for capacity): no replica
 * yet, with the spend cap that holds one back, or its replica's pool reason.
 */
export function poolJobWait(
  runtime: Pick<DeploymentRuntimeObservation, 'containerFailed'> & {
    workload: Pick<
      DeploymentRuntimeObservation['workload'],
      'podName' | 'pendingReason'
    >;
  },
  capBlock: string | null,
): string {
  const { podName, pendingReason } = runtime.workload;
  if (podName === null) {
    return capBlock ? `no replica yet: ${capBlock}` : 'no replica yet';
  }
  if (pendingReason) return `its replica is Pending: ${pendingReason}`;
  if (runtime.containerFailed) return "its replica can't start";
  return 'every replica is busy or starting';
}

/** Explanatory facts from one request; discovery and exact claims own eligibility. */
export function deriveDeploymentStatus(
  deployment: StoredDeployment,
  jobs: TargetedJobStatusSnapshot,
  observation: DeploymentObservation,
): DeploymentStatus {
  const runtime = observation.kind === 'observed' ? observation.runtime : null;
  const workload = runtime?.workload;
  const appliedGeneration =
    runtime?.appliedGeneration && runtime.appliedGeneration > 0
      ? runtime.appliedGeneration
      : null;
  const podGeneration = workload?.observedGeneration ?? null;
  const changing =
    runtime !== null &&
    (runtime.appliedGeneration !== deployment.generation ||
      (podGeneration !== null && podGeneration !== deployment.generation));
  const oldExecutions = jobs.blockers.some(
    (execution) =>
      execution.generation !== null &&
      execution.generation !== deployment.generation,
  );
  const waitingOnJobs =
    jobs.counts.unreleased > 0 &&
    (changing || oldExecutions || deployment.deletionRequestedAt !== null);
  const status: DeploymentStatus = {
    state: 'unknown',
    releasing: false,
    ready: false,
    upgrade: null,
    reason:
      "Kubernetes can't be read, so readiness is unknown and new Jobs wait.",
    requestedGeneration: deployment.generation,
    appliedGeneration,
    podGeneration,
    podName: workload?.podName ?? null,
    podUid: workload?.podUid ?? null,
    containerId: workload?.containerId ?? null,
    containerReady: runtime?.containerReady ?? null,
    readyReplicas: runtime?.readyReplicas ?? null,
    applicationReady:
      runtime?.containerRunning && runtime.probeConfigured
        ? runtime.containerReady
        : null,
    probeConfigured: runtime?.probeConfigured ?? null,
    observation: observation.kind,
    observedAt: runtime?.observedAt ?? null,
    observationError:
      observation.kind === 'unavailable' ? observation.message : null,
    blockingJobs: {
      total: waitingOnJobs ? jobs.counts.unreleased : 0,
      jobs: waitingOnJobs
        ? jobs.blockers.map((execution) => ({
            id: execution.jobId,
            executionId: execution.executionId,
            generation: execution.generation,
            state: execution.state,
          }))
        : [],
    },
  };
  if (
    deployment.deletionRequestedAt !== null ||
    deployment.deletedAt !== null
  ) {
    return {
      ...status,
      state: WorkloadState.Terminated,
      releasing: deployment.deletedAt === null,
      reason:
        deployment.deletedAt !== null
          ? 'The Deployment is deleted.'
          : waitingOnJobs
            ? 'Deleting once its Jobs finish and are cleaned up; new Jobs are refused.'
            : 'Deleting its Kubernetes Deployment; new Jobs are refused.',
    };
  }
  // Revision 1 is the create; each later revision is an upgrade that leaves
  // the Deployment running while its new Pod starts.
  const upgraded = deployment.generation > 1;
  const live = (
    state: NonNullable<DeploymentStatus['upgrade']>['state'],
    reason: string,
  ): DeploymentStatus => ({
    ...status,
    state:
      upgraded && state === WorkloadState.Starting
        ? WorkloadState.Running
        : state,
    upgrade: upgraded ? { number: deployment.generation - 1, state } : null,
    reason,
  });
  if (waitingOnJobs) {
    return live(
      WorkloadState.Starting,
      'Waiting for Jobs on the previous revision to finish and be cleaned up; new Jobs wait.',
    );
  }
  if (!runtime) return status;
  const replacing =
    runtime.podTerminating ||
    (changing &&
      (runtime.appliedGeneration !== null || workload?.podUid !== null));
  const identified =
    podGeneration !== null && !!workload?.podUid && !!workload.containerId;
  // Why the Pod can't take Jobs, or null when it can.
  const notReady = replacing
    ? `Replacing the Pod with revision ${deployment.generation}; new Jobs wait.`
    : !runtime.containerRunning
      ? (workload?.pendingReason ?? 'Waiting for the container to start.')
      : !identified
        ? "The Pod's revision or container isn't known yet, so new Jobs wait."
        : !runtime.containerReady
          ? status.applicationReady === false
            ? 'Waiting for the readiness probe to pass; new Jobs wait.'
            : 'Waiting for the container to be ready; new Jobs wait.'
          : runtime.readyReplicas < deployment.minReplicas
            ? `Waiting for replicas to be ready (${runtime.readyReplicas}/${deployment.minReplicas}).`
            : null;
  const readyReason =
    jobs.counts.unreleased >=
    deployment.maxConcurrentJobsPerReplica * deployment.maxReplicas
      ? 'Every Job slot is in use; new Jobs wait for one to free up.'
      : status.applicationReady === null
        ? 'The container is ready; no readiness probe is set.'
        : 'The readiness probe passes; new Jobs can start.';
  // Once this revision has rolled out, losing readiness (a failing probe, a
  // restart, a crash loop) leaves the Deployment running; `reason` and
  // `containerReady` carry it, as a Service's unhealthy container does.
  // With no Pod, a Recreate upgrade may sit between Pods while Kubernetes
  // still reports the previous revision's rollout as complete.
  if (
    runtime.rolledOut &&
    runtime.appliedGeneration === deployment.generation &&
    !changing &&
    workload?.podUid
  ) {
    return {
      ...live(WorkloadState.Running, notReady ?? readyReason),
      ready: notReady === null,
    };
  }
  if (replacing) return live(WorkloadState.Starting, notReady!);
  // After the replacement check, so a failing old Pod doesn't fail the
  // upgrade that replaces it.
  if (runtime.containerFailed) {
    return live(
      WorkloadState.Failed,
      workload?.pendingReason ?? 'The container keeps failing to start.',
    );
  }
  if (runtime.containerRunning && !identified) {
    return {
      ...status,
      upgrade: upgraded
        ? { number: deployment.generation - 1, state: WorkloadState.Starting }
        : null,
      reason: notReady!,
    };
  }
  return notReady
    ? live(WorkloadState.Starting, notReady)
    : { ...live(WorkloadState.Running, readyReason), ready: true };
}
