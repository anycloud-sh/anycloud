import { CloudFailureDiagnosis } from '../../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { NodePoolKernel, TrackedNodePoolRef } from '../node-pools.js';
import type {
  KubernetesCapacityObservation,
  LaunchFailureRecord,
  KubernetesCapacityIdentity,
  KubernetesConnectionObservation,
  ClusterNodePoolAdapter,
} from '../targets/cluster-node-pool.js';
import type { Waiter } from '../wait.js';

export interface NodePoolContractDependencies {
  readonly nodePools: Pick<
    NodePoolKernel,
    | 'release'
    | 'reserve'
    | 'status'
    | 'waitForDeletionRecorded'
    | 'waitForState'
  >;
  readonly policy: { readonly nodePoolTimeoutMs: number };
  readonly target: Pick<
    ClusterNodePoolAdapter,
    | 'create'
    | 'nodePoolRequest'
    | 'recordNodePool'
    | 'capacity'
    | 'nodePoolStatus'
    | 'deleteOneCapacityHost'
    | 'capacityIdentities'
    | 'delete'
    | 'nodePoolAbsent'
    | 'connection'
    | 'replaceController'
    | 'nodePoolReadyByCli'
  >;
  readonly wait: Pick<Waiter, 'for'>;
}

export interface ReadyNodePool {
  readonly id: string;
  readonly ref: TrackedNodePoolRef;
  readonly totalVmCount: number;
  readonly vmCount: number;
  /** Launches that failed before the pool became ready. */
  readonly failedLaunches?: readonly LaunchFailureRecord[];
  readonly replacementVmRowId?: number;
  readonly replacementCapacity?: {
    readonly beforeCapacity: readonly KubernetesCapacityIdentity[];
    readonly afterCapacity: readonly KubernetesCapacityIdentity[];
    readonly replacementVmRowId: number;
  };
}

export interface NodePoolContractRecord {
  readonly contract: 'node-pool';
  readonly nodePoolId: string;
  readonly name: string;
  readonly requestedVmCount: number;
  readonly totalVmCount: number;
  readonly liveVmCount: number;
  readonly nodesAbsent: true;
  readonly deletionRecorded: true;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Local cluster contract: ${message}`);
}

export interface NodePoolDeletionCapacityBaseline {
  readonly nodePoolId: string;
  readonly totalVmCount: number;
}

export function captureDeletionCapacityBaseline(
  nodePoolId: string,
  knownTotalVmCount: number,
  capacity: KubernetesCapacityObservation,
): NodePoolDeletionCapacityBaseline {
  invariant(
    capacity.nodePoolId === nodePoolId,
    `node pool ${nodePoolId} received capacity for ${capacity.nodePoolId}`,
  );
  invariant(
    capacity.totalVmCount >= knownTotalVmCount,
    `node pool ${nodePoolId} lost capacity history before deletion (${knownTotalVmCount} known, ${capacity.totalVmCount} observed)`,
  );
  return { nodePoolId, totalVmCount: capacity.totalVmCount };
}

export function deletionCapacityHistoryViolation(
  baseline: NodePoolDeletionCapacityBaseline,
  capacity: KubernetesCapacityObservation,
): string | undefined {
  if (capacity.nodePoolId !== baseline.nodePoolId) {
    return `capacity observation switched from node pool ${baseline.nodePoolId} to ${capacity.nodePoolId}`;
  }
  if (capacity.totalVmCount < baseline.totalVmCount) {
    return `deleted node pool ${baseline.nodePoolId} lost capacity history during deletion (${baseline.totalVmCount} before, ${capacity.totalVmCount} after)`;
  }
  if (capacity.totalVmCount > baseline.totalVmCount) {
    return `deleted node pool ${baseline.nodePoolId} created capacity during deletion (${baseline.totalVmCount} before, ${capacity.totalVmCount} after)`;
  }
  return undefined;
}

export function deletionLiveCapacityUnmet(
  capacity: KubernetesCapacityObservation,
): string | undefined {
  return capacity.liveVmCount === 0
    ? undefined
    : `deleted node pool ${capacity.nodePoolId} retained ${capacity.liveVmCount} live capacity VMs across ${capacity.totalVmCount} historical rows`;
}

export async function waitForDeletionCapacityRelease(
  wait: Pick<Waiter, 'for'>,
  capacity: () => Promise<KubernetesCapacityObservation>,
  baseline: NodePoolDeletionCapacityBaseline,
  timeoutMs: number,
): Promise<KubernetesCapacityObservation> {
  return wait.for(
    `deleted node pool ${baseline.nodePoolId} capacity release`,
    capacity,
    {
      timeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      reject: (observation) =>
        deletionCapacityHistoryViolation(baseline, observation),
      unmet: deletionLiveCapacityUnmet,
    },
  );
}

export async function createReadyNodePool(
  dependencies: NodePoolContractDependencies,
  ref: TrackedNodePoolRef,
  vmCount: number,
  maxVmCount = vmCount,
  jobs: 'privileged' | 'user-namespace' | 'plain' = 'plain',
): Promise<ReadyNodePool> {
  const created = await dependencies.target.create(ref, {
    ...dependencies.target.nodePoolRequest(ref.name, vmCount, maxVmCount),
    privilegedJobs: jobs === 'privileged',
    userNamespaceJobs: jobs === 'user-namespace',
  });
  dependencies.target.recordNodePool(created.id);
  // `anycloud wait` watches the new pool become ready, as a user would.
  const readyByCli = await dependencies.target.nodePoolReadyByCli(
    created.id,
    dependencies.policy.nodePoolTimeoutMs,
  );
  await dependencies.nodePools.waitForState(
    ref,
    WorkloadState.Running,
    dependencies.policy.nodePoolTimeoutMs,
  );
  if (!readyByCli) {
    throw new Error(
      `anycloud wait did not report node pool ${created.id} ready`,
    );
  }
  const { capacity } = await dependencies.wait.for(
    `node pool ${created.id} to expose ${vmCount} Ready capacity VMs`,
    async () => ({
      capacity: await dependencies.target.capacity(created.id),
      status: await dependencies.nodePools.status(ref),
    }),
    {
      timeoutMs: dependencies.policy.nodePoolTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: ({ capacity, status }) =>
        capacity.totalVmCount === vmCount + capacity.failedLaunches.length &&
        capacity.liveVmCount === vmCount &&
        status.capacity?.readyVmCount === vmCount
          ? undefined
          : `${status.state}: ${capacity.totalVmCount} total, ${capacity.liveVmCount} live`,
    },
  );
  return {
    id: created.id,
    ref,
    totalVmCount: capacity.totalVmCount,
    vmCount,
    failedLaunches: capacity.failedLaunches,
  };
}

/**
 * The forced capacity fault came first, and every later failure is
 * non-terminal (real capacity, quota, or a region the provider rejects).
 */
export function forcedCapacityFailureUnmet(
  failures: readonly LaunchFailureRecord[] = [],
): string | undefined {
  const [forced, ...rest] = failures;
  if (forced?.diagnosis !== CloudFailureDiagnosis.CapacityExhausted) {
    return `the first failed launch is ${forced?.diagnosis ?? 'missing'}, not the forced capacity failure`;
  }
  const terminal = rest.find(
    ({ diagnosis }) =>
      diagnosis === CloudFailureDiagnosis.InvalidRequest ||
      diagnosis === CloudFailureDiagnosis.BadCredential,
  );
  return (
    terminal && `a launch in ${terminal.region} failed ${terminal.diagnosis}`
  );
}

export async function proveCapacityReplacement(
  dependencies: Pick<NodePoolContractDependencies, 'policy' | 'wait'> & {
    readonly target: Pick<
      NodePoolContractDependencies['target'],
      | 'capacity'
      | 'nodePoolStatus'
      | 'deleteOneCapacityHost'
      | 'capacityIdentities'
    >;
  },
  nodePool: ReadyNodePool,
  /** The VM row to delete; any live one when omitted. */
  vmRowId?: number,
): Promise<ReadyNodePool> {
  const before = await dependencies.target.capacityIdentities(nodePool.id);
  const failedBefore = nodePool.failedLaunches?.length ?? 0;
  await dependencies.target.deleteOneCapacityHost(nodePool.id, vmRowId);
  const capacity = await dependencies.wait.for(
    `node pool ${nodePool.id} capacity replacement`,
    () => dependencies.target.capacity(nodePool.id),
    {
      timeoutMs: dependencies.policy.nodePoolTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      // Launches that failed on the way add rows of their own.
      unmet: (candidate) =>
        candidate.totalVmCount ===
          nodePool.totalVmCount +
            1 +
            candidate.failedLaunches.length -
            failedBefore && candidate.liveVmCount === nodePool.vmCount
          ? undefined
          : `${candidate.totalVmCount} total, ${candidate.liveVmCount} live`,
    },
  );
  await dependencies.wait.for(
    `node pool ${nodePool.id} replacement capability readiness`,
    () => dependencies.target.nodePoolStatus(nodePool.id),
    {
      timeoutMs: dependencies.policy.nodePoolTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (status) =>
        status.state === WorkloadState.Running &&
        status.readyVmCount === nodePool.vmCount
          ? undefined
          : `${status.state}: ${status.readyVmCount} Ready VMs`,
    },
  );
  const after = await dependencies.target.capacityIdentities(nodePool.id);
  const failed = new Set(
    (await dependencies.target.capacity(nodePool.id)).failedLaunches.map(
      ({ vmRowId }) => vmRowId,
    ),
  );
  const replacements = after.filter(
    (entry) =>
      !failed.has(entry.vmRowId) &&
      !before.some((old) => old.vmRowId === entry.vmRowId),
  );
  invariant(
    replacements.length === 1,
    'replacement did not produce one new capacity identity',
  );
  return {
    ...nodePool,
    totalVmCount: capacity.totalVmCount,
    failedLaunches: capacity.failedLaunches,
    replacementVmRowId: replacements[0].vmRowId,
    replacementCapacity: {
      beforeCapacity: before,
      afterCapacity: after,
      replacementVmRowId: replacements[0].vmRowId,
    },
  };
}

export async function deleteNodePools(
  dependencies: NodePoolContractDependencies,
  nodePools: readonly ReadyNodePool[],
): Promise<readonly NodePoolContractRecord[]> {
  const capacityBaselines = new Map(
    await Promise.all(
      nodePools.map(async (nodePool) => {
        await dependencies.target.delete(nodePool.ref);
        return [
          nodePool.id,
          captureDeletionCapacityBaseline(
            nodePool.id,
            nodePool.totalVmCount,
            await dependencies.target.capacity(nodePool.id),
          ),
        ] as const;
      }),
    ),
  );
  const deletions = await Promise.all(
    nodePools.map((nodePool) =>
      dependencies.nodePools.waitForDeletionRecorded(
        nodePool.ref,
        dependencies.policy.nodePoolTimeoutMs,
      ),
    ),
  );
  const records: NodePoolContractRecord[] = [];
  for (const nodePool of nodePools) {
    const baseline = capacityBaselines.get(nodePool.id);
    invariant(
      baseline,
      `node pool ${nodePool.id} has no deletion capacity baseline`,
    );
    const absentCapacity = await waitForDeletionCapacityRelease(
      dependencies.wait,
      () => dependencies.target.capacity(nodePool.id),
      baseline,
      dependencies.policy.nodePoolTimeoutMs,
    );
    invariant(
      await dependencies.target.nodePoolAbsent(nodePool.id),
      `deleted node pool ${nodePool.id} retained Nodes on the cluster`,
    );
    records.push({
      contract: 'node-pool',
      nodePoolId: nodePool.id,
      name: nodePool.ref.name,
      requestedVmCount: nodePool.vmCount,
      totalVmCount: absentCapacity.totalVmCount,
      liveVmCount: absentCapacity.liveVmCount,
      nodesAbsent: true,
      deletionRecorded: true,
    });
  }
  for (const deletion of deletions) {
    await dependencies.nodePools.release(deletion);
  }
  return records;
}

export async function observeNodePoolIsolation(
  dependencies: NodePoolContractDependencies,
  nodePools: readonly [ReadyNodePool, ReadyNodePool],
): Promise<
  readonly [KubernetesConnectionObservation, KubernetesConnectionObservation]
> {
  const connections = await Promise.all(
    nodePools.map((nodePool) => dependencies.target.connection(nodePool.id)),
  );
  const [first, second] = connections;
  invariant(
    nodePools[0].id !== nodePools[1].id,
    'two node pools share one product identity',
  );
  invariant(
    first.nodePoolId === nodePools[0].id &&
      second.nodePoolId === nodePools[1].id,
    'node pool connection observation changed its product identity',
  );
  // Both node pools join the one cluster: they must report the same
  // Kubernetes identity and connection revision, and differ only by pool.
  invariant(
    first.kubernetesIdentity === second.kubernetesIdentity &&
      first.connectionRevision === second.connectionRevision,
    'two node pools on one cluster reported different Kubernetes identities',
  );
  return [first, second];
}

export async function replaceClusterController(
  dependencies: NodePoolContractDependencies,
  nodePool: ReadyNodePool,
  beforeConnection: KubernetesConnectionObservation,
) {
  const replacement = await dependencies.target.replaceController();
  invariant(
    replacement.beforeControllerInstance !==
      replacement.afterControllerInstance,
    'controller replacement retained its process identity',
  );
  const afterConnection = await confirmClusterConnection(
    dependencies,
    nodePool,
    beforeConnection,
  );
  return { replacement, afterConnection };
}

export async function confirmClusterConnection(
  dependencies: NodePoolContractDependencies,
  nodePool: ReadyNodePool,
  before: KubernetesConnectionObservation,
): Promise<KubernetesConnectionObservation> {
  const after = await dependencies.target.connection(nodePool.id);
  invariant(
    before.nodePoolId === nodePool.id &&
      after.nodePoolId === nodePool.id &&
      after.kubernetesIdentity === before.kubernetesIdentity,
    'API replacement changed Kubernetes identity',
  );
  return after;
}
