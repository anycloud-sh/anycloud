import {
  listReplicaPods,
  type DeploymentRuntimeResolver,
} from './kubernetes/deployment-runtime.js';
import { kubernetesRequestOptions } from './kubernetes/request-options.js';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
} from './kubernetes/managed-resources.js';
import { getDefaultDeploymentRuntimeResolver } from './kubernetes/default-runtime.js';
import { getDeploymentExecutionStore, getPoolJobStore } from './persistence.js';
import type { PoolJobInFlight } from './repositories/pool-job-store.js';

/**
 * How long one `api upgrade` poll holds claims: past the backup and rollout
 * that follow the last poll, so no Job starts on the API being replaced.
 */
const DRAIN_HOLD_MS = 10 * 60_000;
/** One unreachable pool cluster must not hold the drain's route. */
const K8S_TIMEOUT_MS = 10_000;

/**
 * Decision 30: before `api upgrade` replaces the API, it stops claims on
 * managed Deployments and lists the pool Jobs in flight. `force` marks the
 * executions of every Job whose runner release isn't in `keep`, the new
 * release's window (RFC 0049 C27), and deletes their replicas, so each runner
 * gets SIGTERM and uploads, and the Deployment owner retries its Job, which
 * the runner leaves to the owner (RFC 0043 S12).
 */
export function createPoolJobDrain(deps: {
  executions: {
    pauseManagedClaims(until: number): void;
    markForcedStop(executionId: string): void;
  };
  inFlight(): Promise<PoolJobInFlight[]>;
  runtimes: Pick<DeploymentRuntimeResolver, 'resolve'>;
}) {
  async function stopReplica(job: PoolJobInFlight): Promise<void> {
    const { runtime, namespace, items } = await listReplicaPods(
      deps.runtimes,
      job,
      K8S_TIMEOUT_MS,
    );
    const pod = items.find((item) => item.metadata?.uid === job.podUid);
    if (!pod?.metadata?.name || pod.metadata.deletionTimestamp) return;
    try {
      await runtime.cluster.core.deleteNamespacedPod(
        {
          namespace,
          name: pod.metadata.name,
          body: { preconditions: { uid: job.podUid } },
        },
        kubernetesRequestOptions(AbortSignal.timeout(K8S_TIMEOUT_MS)),
      );
    } catch (error) {
      if (
        !isKubernetesNotFoundError(error) &&
        !isKubernetesConflictError(error)
      )
        throw error;
    }
  }

  return async function drain(
    force: boolean,
    keep: readonly string[] = [],
  ): Promise<PoolJobInFlight[]> {
    deps.executions.pauseManagedClaims(Date.now() + DRAIN_HOLD_MS);
    const jobs = await deps.inFlight();
    if (force) {
      for (const job of jobs) {
        if (job.runnerRelease !== null && keep.includes(job.runnerRelease)) {
          continue;
        }
        deps.executions.markForcedStop(job.executionId);
        await stopReplica(job);
      }
    }
    return jobs;
  };
}

/** The drain `systemRelease.drain` serves, on this process's stores. */
export function drainPoolJobs(
  force: boolean,
  keep?: readonly string[],
): Promise<PoolJobInFlight[]> {
  return createPoolJobDrain({
    executions: getDeploymentExecutionStore(),
    inFlight: () => getPoolJobStore().inFlight(),
    runtimes: getDefaultDeploymentRuntimeResolver(),
  })(force, keep);
}
