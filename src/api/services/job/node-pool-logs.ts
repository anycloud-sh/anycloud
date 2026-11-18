import { LOGS_CONTAINER_NOT_READY } from '../../../shared/api-contract/native-schemas.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { isTerminalState } from '../../../shared/workload.js';
import { ApiException } from '@kubernetes/client-node';
import type { StoredDeployment } from '../deployment-store.js';
import type { ClusterKubernetesClient } from '../kubernetes/cluster-client.js';
import {
  ClusterIdentityChangedError,
  ClusterPermissionError,
} from '../kubernetes/cluster-runtime.js';
import {
  listReplicaPods,
  NodePoolRuntimeUnavailableError,
  type DeploymentRuntimeResolver,
} from '../kubernetes/deployment-runtime.js';
import {
  KUBERNETES_DEPLOYMENT_CONTAINER,
  latestPod,
  podPendingReason,
} from '../kubernetes/pool-objects.js';
import { kubernetesWorkloadResourceName } from '../kubernetes/identity.js';
import { podLogs, tail, type PodLogTarget } from '../kubernetes/pod-logs.js';
import type { StoredWorkload } from '../workload-record.js';
import type { JobLogsPreparation, JobOperationStream } from './operations.js';

const POD_LIST_TIMEOUT_MS = 10_000;

/** A Service or Deployment record whose replica Pods run on a node pool. */
interface PodLogsSubject {
  noun: 'Service' | 'Deployment';
  id: string;
  nodePoolId: string;
  /** A Service owns its namespace; a Deployment lives in its node pool's. */
  namespace?: string;
  /** Once the record has ended, a missing Pod will not appear. */
  ended: boolean;
  statusCommand: string;
}

export interface NodePoolLogs {
  service(
    workload: StoredWorkload,
    follow: boolean,
  ): Promise<JobLogsPreparation>;
  deployment(
    deployment: StoredDeployment,
    follow: boolean,
  ): Promise<JobLogsPreparation>;
}

/** Failures that persist until an operator acts, so waiting cannot help. */
function clusterRefused(error: unknown): boolean {
  return (
    error instanceof NodePoolRuntimeUnavailableError ||
    error instanceof ClusterIdentityChangedError ||
    error instanceof ClusterPermissionError ||
    (error instanceof ApiException && [401, 403].includes(error.code))
  );
}

/**
 * The Kubernetes API's status and reason, without the response headers its
 * error message embeds: they change per request (`audit-id`, `date`).
 */
function clusterErrorSummary(error: unknown): string {
  if (!(error instanceof ApiException)) return errorMessage(error);
  let body: unknown = error.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // Not a Kubernetes Status object.
    }
  }
  const reason =
    body && typeof body === 'object' && 'message' in body
      ? String(body.message).replace(/\.$/u, '')
      : undefined;
  return `HTTP ${error.code}${reason ? `: ${reason}` : ''}`;
}

async function streamPodLogs(
  cluster: ClusterKubernetesClient,
  target: PodLogTarget,
  facts: { pods: number; restarts: number; started: boolean },
  follow: boolean,
  stream: JobOperationStream,
): Promise<number> {
  if (facts.pods > 1) {
    await stream.onStderr(
      Buffer.from(`Showing Pod ${target.pod}, the newest of ${facts.pods}.\n`),
    );
  }
  // A crash-looping container's own log starts empty; its previous run says why.
  if (facts.restarts > 0) {
    const note = `Previous run of Pod ${target.pod} (restarts: ${facts.restarts}), last 1 MiB`;
    try {
      const previous = await tail(
        cluster,
        { ...target, previous: true },
        undefined,
        stream.signal,
      );
      await stream.onStderr(Buffer.from(`${note}:\n`));
      await stream.onStdout(previous);
    } catch (error) {
      if (stream.signal.aborted) throw error;
      await stream.onStderr(
        Buffer.from(`${note} is unavailable: ${errorMessage(error)}\n`),
      );
    }
  }
  if (facts.started) {
    await podLogs(
      cluster,
      target,
      { follow, signal: stream.signal },
      stream.onStdout,
    );
  }
  return 0;
}

/**
 * `anycloud logs` for a Service or Deployment on a node pool: the newest of
 * its Pods, Ready or not, so a replica that fails to start is the one shown.
 * Every read stays in the record's namespace and Pod selector; the route has
 * already authorized the record against its owner.
 */
export function createNodePoolLogs(deps: {
  runtimes: Pick<DeploymentRuntimeResolver, 'resolve'>;
}): NodePoolLogs {
  async function prepare(
    subject: PodLogsSubject,
    follow: boolean,
  ): Promise<JobLogsPreparation> {
    const label = `${subject.noun} ${subject.id}`;
    let replicas;
    try {
      // A cached runtime can be stale, so an unreachable cluster usually fails
      // at the Pod list.
      replicas = await listReplicaPods(
        deps.runtimes,
        { ...subject, deploymentId: subject.id },
        POD_LIST_TIMEOUT_MS,
      );
    } catch (error) {
      // A live record's cluster may be briefly unreachable, so `--follow`
      // waits; a deleted node pool or a refused cluster needs an operator.
      const retryable = !subject.ended && !clusterRefused(error);
      return {
        ok: false,
        status: 503,
        ...(retryable ? { code: LOGS_CONTAINER_NOT_READY } : {}),
        clientError: `Could not reach the cluster of ${label}: ${clusterErrorSummary(error)}.`,
        telemetryError: 'Node pool cluster unavailable',
        probeCount: 0,
      };
    }
    const { runtime, namespace, items } = replicas;
    const pod = latestPod(items);
    const name = pod?.metadata?.name;
    const container = pod?.status?.containerStatuses?.find(
      (status) => status.name === KUBERNETES_DEPLOYMENT_CONTAINER,
    );
    const started = !!(
      container?.state?.running ?? container?.state?.terminated
    );
    const restarts = container?.restartCount ?? 0;
    if (!name || (!started && restarts === 0)) {
      const why = name
        ? `${label}'s Pod ${name} has not started (${podPendingReason(pod) ?? 'Pending'})`
        : `${label} has no Pod`;
      return {
        ok: false,
        status: 409,
        ...(subject.ended ? {} : { code: LOGS_CONTAINER_NOT_READY }),
        clientError: `${why}; check ${subject.statusCommand} ${subject.id}.`,
        telemetryError: name ? 'Pod not started' : 'No Pod',
        probeCount: 1,
      };
    }
    const target = {
      namespace,
      pod: name,
      container: KUBERNETES_DEPLOYMENT_CONTAINER,
    };
    const facts = { pods: items.length, restarts, started };
    return {
      ok: true,
      probeCount: 1,
      run: (stream) =>
        streamPodLogs(runtime.cluster, target, facts, follow, stream),
    };
  }

  return {
    service: (workload, follow) => {
      if (workload.nodePoolId === null) {
        throw new Error(`Service ${workload.id} is not on a node pool`);
      }
      return prepare(
        {
          noun: 'Service',
          id: workload.id,
          nodePoolId: workload.nodePoolId,
          namespace: kubernetesWorkloadResourceName('serve', workload.id),
          ended: isTerminalState(workload.state),
          statusCommand: 'anycloud status',
        },
        follow,
      );
    },
    deployment: (deployment, follow) =>
      prepare(
        {
          noun: 'Deployment',
          id: deployment.id,
          nodePoolId: deployment.nodePoolId,
          ended: deployment.deletionRequestedAt !== null,
          statusCommand: 'anycloud deployment status',
        },
        follow,
      ),
  };
}
