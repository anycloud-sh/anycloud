import type { V1Pod } from '@kubernetes/client-node';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  LIVE_EXECUTION_STATES,
  isTerminalState,
} from '../../../shared/workload.js';
import type { StoredDeployment } from '../deployment-store.js';
import {
  listReplicaPods,
  type DeploymentRuntimeResolver,
} from '../kubernetes/deployment-runtime.js';
import { podExec } from '../kubernetes/pod-exec.js';
import {
  KUBERNETES_DEPLOYMENT_CONTAINER,
  isPodReady,
} from '../kubernetes/pool-objects.js';
import type { PoolJobLogWindow } from '../repositories/pool-job-store.js';
import { refused, type JobExecPreparation } from './operations.js';

type Runtimes = Pick<DeploymentRuntimeResolver, 'resolve'>;

/**
 * Prepare `command` in one of a Deployment's running replica Pods, which are
 * read only in its node pool's namespace by its own selector: the only Pods
 * `anycloud exec` ever reaches. `pick` chooses one, or says why none.
 */
async function prepareInReplica(
  runtimes: Runtimes,
  owner: { label: string; nodePoolId: string; deploymentId: string },
  command: string,
  pick: (running: V1Pod[]) => V1Pod | string,
  fence?: () => Promise<string | undefined>,
): Promise<JobExecPreparation> {
  let replicas;
  try {
    replicas = await listReplicaPods(runtimes, owner);
  } catch (error) {
    return refused(
      503,
      `Could not reach the cluster of ${owner.label}: ${errorMessage(error)}.`,
    );
  }
  const { runtime, namespace, items } = replicas;
  const pod = pick(
    items
      .filter(
        (item) =>
          !item.metadata?.deletionTimestamp &&
          item.status?.containerStatuses?.find(
            (status) => status.name === KUBERNETES_DEPLOYMENT_CONTAINER,
          )?.state?.running,
      )
      .sort((a, b) => a.metadata!.name!.localeCompare(b.metadata!.name!)),
  );
  if (typeof pod === 'string') return refused(409, pod);
  const target = {
    namespace,
    pod: pod.metadata!.name!,
    container: KUBERNETES_DEPLOYMENT_CONTAINER,
  };
  return {
    ok: true,
    run: (stream) => podExec(runtime.cluster, target, command, stream, fence),
  };
}

/**
 * `anycloud exec` for a pool Job (RFC 0044): only in the replica that holds
 * its claim, and only while that execution is open. A replica runs one Job
 * at a time and resets between them, so the command is fenced to start only
 * while this Job still holds it (`podExec`). A Job on a user Deployment gets
 * null, the targeted-Job refusal: its replica runs other Jobs beside it.
 */
export function createPoolJobExec(deps: {
  window(jobId: string): Promise<PoolJobLogWindow | null>;
  runtimes: Runtimes;
}) {
  return async function prepare(
    jobId: string,
    command: string,
  ): Promise<JobExecPreparation | null> {
    const window = await deps.window(jobId);
    if (!window?.managed) return null;
    const { attempt, state } = window;
    const holds = (current: PoolJobLogWindow | null) =>
      !!current?.attempt &&
      LIVE_EXECUTION_STATES.includes(current.state) &&
      current.attempt.endedAt === null &&
      current.attempt.podUid === attempt?.podUid &&
      current.attempt.openedAt === attempt.openedAt;
    if (!holds(window)) {
      return refused(
        409,
        isTerminalState(state)
          ? `Job ${jobId} has ended; exec reaches a pool Job only while it runs.`
          : `Job ${jobId} is ${state} and waits for a replica; exec reaches a pool Job only while it runs.`,
      );
    }
    return prepareInReplica(
      deps.runtimes,
      { label: `Job ${jobId}`, ...window },
      command,
      (running) =>
        running.find((pod) => pod.metadata?.uid === attempt!.podUid) ??
        `Job ${jobId}'s replica is not running.`,
      async () =>
        holds(await deps.window(jobId))
          ? undefined
          : `Job ${jobId} ended before the command started; it did not run.`,
    );
  };
}

/**
 * `anycloud exec` for a Deployment record: in its first ready replica by
 * name, or in the running replica `replica` names, Ready or not, so a replica
 * failing its probe can be inspected.
 */
export const createDeploymentExec =
  (deps: { runtimes: Runtimes }) =>
  (
    deployment: StoredDeployment,
    command: string,
    replica: string | undefined,
  ): Promise<JobExecPreparation> => {
    const label = `Deployment ${deployment.id}`;
    if (deployment.managed) {
      return Promise.resolve(
        refused(
          400,
          `${label} runs pool Jobs; exec into one of its running Jobs instead.`,
        ),
      );
    }
    return prepareInReplica(
      deps.runtimes,
      { label, nodePoolId: deployment.nodePoolId, deploymentId: deployment.id },
      command,
      (running) => {
        const pod = replica
          ? running.find((item) => item.metadata?.name === replica)
          : running.find(isPodReady);
        const why = replica
          ? `no running replica ${replica}`
          : 'no ready replica';
        const names = running.map((item) => item.metadata!.name!).join(', ');
        return (
          pod ??
          `${label} has ${why}; ${names ? `its running replicas: ${names}. Choose one with --replica.` : `check anycloud deployment status ${deployment.id}.`}`
        );
      },
    );
  };
