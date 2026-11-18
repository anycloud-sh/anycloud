import {
  setHeaderOptions,
  type V1Deployment as KubernetesDeployment,
  type V1Pod,
  type V1PodTemplateSpec,
} from '@kubernetes/client-node';
import type { StoredDeployment } from './deployment-store.js';
import type { ClusterKubernetesClient } from './kubernetes/cluster-client.js';
import type { NodePoolRuntimeIdentity } from './kubernetes/deployment-runtime.js';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
} from './kubernetes/managed-resources.js';
import { NVIDIA_GPU_RESOURCE } from './kubernetes/nvidia-device-plugin.js';
import {
  DELETION_COST,
  DRAINING_COST,
  isPodReady,
} from './kubernetes/pool-objects.js';
import type { TargetedJobCounts } from './repositories/deployment-executions.js';
import type { ManagedDemand } from './repositories/replica-demand.js';
import { podRequests, share } from './pool-fit.js';

/** Managed replicas per cluster (RFC 0044 decision 6); S12 raises it. */
export const IN_FLIGHT_CAP = 200;

/** S12's KWOK stage measures a raised cap before the owner decides. */
function inFlightCap(): number {
  const raised = Number(process.env.ANYCLOUD_E2E_IN_FLIGHT_CAP);
  return process.env.IS_TEST === 'true' &&
    Number.isSafeInteger(raised) &&
    raised > 0
    ? raised
    : IN_FLIGHT_CAP;
}

export interface ReplicaPolicyDependencies {
  drainReplica(deploymentId: string, podUid: string): Promise<boolean>;
  reopenReplica(podUid: string): void;
  listManagedDemand(clusterId: string): Promise<ManagedDemand[]>;
  managedRoom(nodePoolId: string): Promise<{
    maxVms: number;
    reservedGpus: number;
    vmPrice: number | null;
  }>;
  /** Whether spend caps hold the pool's scale-out, so a step-up waits. */
  capBlocked(nodePoolId: string): Promise<boolean>;
  /** One pass's claim check for queued pool Jobs; truthy blocks. */
  demandAdmission(): Promise<
    (session: string | null, hourlyUsd?: number) => Promise<unknown>
  >;
}

export interface ReplicaPolicyInput {
  deployment: StoredDeployment;
  current: KubernetesDeployment | undefined;
  pods: readonly V1Pod[];
  jobs: TargetedJobCounts;
  template: V1PodTemplateSpec;
  nodePool: NodePoolRuntimeIdentity;
  cluster: ClusterKubernetesClient;
}

const isDraining = (pod: V1Pod) =>
  pod.metadata?.annotations?.[DELETION_COST] === DRAINING_COST;

/**
 * Close an idle replica to claims. A replica seen busy is left open; else it
 * is closed first, so a claim on it either committed before
 * the second read, which then sees it, or is refused, and a replica that
 * claimed meanwhile is reopened.
 */
export async function drainReplica(
  jobs: {
    closeReplica(podUid: string): void;
    reopenReplica(podUid: string): void;
    listTargetedExecutions(deploymentId: string): Promise<{ podUid: string }[]>;
  },
  deploymentId: string,
  podUid: string,
): Promise<boolean> {
  const holds = async () =>
    (await jobs.listTargetedExecutions(deploymentId)).some(
      (execution) => execution.podUid === podUid,
    );
  if (await holds()) return false;
  jobs.closeReplica(podUid);
  if (!(await holds())) return true;
  jobs.reopenReplica(podUid);
  return false;
}

/** Set or clear a replica's draining cost; one gone or replaced is left. */
async function markDraining(
  cluster: ClusterKubernetesClient,
  pod: V1Pod,
  draining: boolean,
): Promise<void> {
  const path = `/metadata/annotations/${DELETION_COST.replace('/', '~1')}`;
  try {
    await cluster.core.patchNamespacedPod(
      {
        namespace: pod.metadata!.namespace!,
        name: pod.metadata!.name!,
        body: [
          { op: 'test', path: '/metadata/uid', value: pod.metadata!.uid },
          draining
            ? { op: 'add', path, value: DRAINING_COST }
            : { op: 'remove', path },
        ],
      },
      setHeaderOptions('Content-Type', 'application/json-patch+json'),
    );
  } catch (error) {
    if (
      !isKubernetesNotFoundError(error) &&
      !isKubernetesConflictError(error) &&
      (error as { code?: number }).code !== 422
    ) {
      throw error;
    }
  }
}

/** A replica's hourly price from its shape, before one holds a Node. */
function shapePrice(
  template: V1PodTemplateSpec,
  nodePool: NodePoolRuntimeIdentity,
  vmPrice: number | null,
): number | undefined {
  const size = nodePool.nodeSize;
  if (!size || !nodePool.nvidiaGpusPerNode || vmPrice === null) {
    return undefined;
  }
  const requests = podRequests({ spec: template.spec });
  return (
    vmPrice *
    share(
      { ...requests, 'ephemeral-storage': 0 },
      {
        cpu: size.vCPUs * 1000,
        memory: size.memoryGiB * 2 ** 30,
        [NVIDIA_GPU_RESOURCE]: nodePool.nvidiaGpusPerNode,
        'ephemeral-storage': 0,
      },
    )
  );
}

/**
 * RA (RFC 0044): the Deployment owner's replica count, from one signal,
 * queued plus held Jobs, between the Deployment's bounds.
 */
export function createReplicaPolicy(deps: ReplicaPolicyDependencies) {
  /**
   * A managed Deployment's demand: its held Jobs, plus its queued Jobs among
   * the cluster's first claimable ones in submit order within the in-flight
   * cap, each priced at its replica's share; its maximum is what the pool's
   * `--max-vms` Nodes hold after user Deployments' GPUs (invariant 16).
   */
  async function managed(input: ReplicaPolicyInput) {
    const { deployment, nodePool } = input;
    const [rows, room, admit] = await Promise.all([
      deps.listManagedDemand(nodePool.clusterId),
      deps.managedRoom(deployment.nodePoolId),
      deps.demandAdmission(),
    ]);
    const mine = (row: ManagedDemand) => row.deploymentId === deployment.id;
    const price =
      rows.find((row) => mine(row) && row.hourlyUsd !== null)?.hourlyUsd ??
      shapePrice(input.template, nodePool, room.vmPrice);
    const cap = inFlightCap();
    let free = cap - rows.filter((row) => row.held).length;
    let demand = rows.filter((row) => row.held && mine(row)).length;
    for (const row of rows) {
      if (free <= 0) break;
      if (row.held) continue;
      const charge = mine(row) ? price : (row.hourlyUsd ?? undefined);
      if (await admit(row.session, charge)) continue;
      free -= 1;
      if (mine(row)) demand += 1;
    }
    const max =
      deployment.gpuCount > 0
        ? Math.floor(
            (room.maxVms * nodePool.nvidiaGpusPerNode - room.reservedGpus) /
              deployment.gpuCount,
          )
        : cap;
    return { demand, max: Math.max(0, max) };
  }

  return async function replicas(input: ReplicaPolicyInput): Promise<number> {
    const { deployment, current, cluster, jobs } = input;
    const { demand, max } = deployment.managed
      ? await managed(input)
      : {
          demand: jobs.queued + jobs.retrying + jobs.unreleased,
          max: deployment.maxReplicas,
        };
    const min = deployment.minReplicas;
    const want = Math.max(
      min,
      Math.min(max, Math.ceil(demand / deployment.maxConcurrentJobsPerReplica)),
    );
    const now = current?.spec?.replicas ?? min;
    // The replicas the ReplicaSet counts: not terminating, not over.
    const pods = input.pods.filter(
      (pod) =>
        !pod.metadata?.deletionTimestamp &&
        !['Succeeded', 'Failed'].includes(pod.status?.phase ?? ''),
    );
    // The ReplicaSet picks which replicas to remove from its own view, so
    // RA cuts only once that view has settled on the Pods it lists, with as
    // many ready. Otherwise the ReplicaSet removes one RA never closed, the
    // newest ready first: an earlier cut it hasn't carried out yet, a Pod
    // the cache doesn't list yet, or a replica it still sees starting.
    const settled =
      current?.status?.observedGeneration === current?.metadata?.generation &&
      current?.status?.replicas === now &&
      (current?.status?.readyReplicas ?? 0) ===
        pods.filter(isPodReady).length &&
      pods.length === now;
    if (want < now) {
      if (!settled) return now;
      // The ReplicaSet removes Pending replicas first, then not-ready and
      // ready ones, each by lowest deletion cost, which only idle replicas
      // closed to claims get. Every Pending and not-ready one is closed,
      // not just the surplus: the ReplicaSet may see one RA kept open still
      // starting after it claims, and remove it before a closed one that
      // started meanwhile. A busy replica would go before any in a later
      // tier, so closes after its tier don't count and no ready one closes.
      const surplus = now - want;
      const pending = (pod: V1Pod) => pod.status?.phase === 'Pending';
      let closed = 0;
      let counted: number | undefined;
      const started = pods.filter((pod) => !pending(pod));
      for (const [index, tier] of [
        pods.filter(pending),
        started.filter((pod) => !isPodReady(pod)),
        started.filter(isPodReady),
      ].entries()) {
        let busy = false;
        for (const pod of tier.sort(
          (a, b) => Number(isDraining(b)) - Number(isDraining(a)),
        )) {
          if (index === 2 && (counted !== undefined || closed >= surplus))
            break;
          if (!(await deps.drainReplica(deployment.id, pod.metadata!.uid!))) {
            busy = true;
            // A busy replica whose mark outlived a restart loses its cost.
            if (isDraining(pod)) await markDraining(cluster, pod, false);
            continue;
          }
          if (!isDraining(pod)) {
            await markDraining(cluster, pod, true).catch((error: unknown) => {
              deps.reopenReplica(pod.metadata!.uid!);
              throw error;
            });
          }
          closed += 1;
        }
        if (busy) counted ??= closed;
      }
      return now - Math.min(surplus, counted ?? closed);
    }
    // A draining replica the settled ReplicaSet kept claims again.
    for (const pod of settled ? pods.filter(isDraining) : []) {
      await markDraining(cluster, pod, false);
      deps.reopenReplica(pod.metadata!.uid!);
    }
    if (
      want > now &&
      want > min &&
      (await deps.capBlocked(deployment.nodePoolId))
    ) {
      return Math.max(now, min);
    }
    return want;
  };
}
