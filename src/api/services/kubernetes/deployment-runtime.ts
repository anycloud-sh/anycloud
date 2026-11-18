import { NodePoolState } from '../../../shared/node-pools.js';
import type { DeploymentTarget } from '../deployment-store.js';
import type { NodePoolRepository, StoredNodePool } from '../cluster-store.js';
import type { LocalKubernetesConfig } from './config.js';
import type { ClusterKubernetesClient } from './cluster-client.js';
import type { ClusterRuntimeResolver } from './cluster-runtime.js';
import { nodePoolNamespace } from './node-pool-scheduling.js';
import { nodePoolDisk } from './node-pool-disk.js';
import { getVCPUsForVMType } from '../../../shared/cloud-config.js';
import { nodePoolGpusPerNode, nodePoolNodeSize } from './pod-options.js';
import { kubernetesWorkloadPodSelector } from './identity.js';
import { kubernetesRequestOptions } from './request-options.js';

export interface NodePoolRuntimeIdentity {
  clusterId: string;
  nodePoolId: string;
  /** Physical NVIDIA devices each node pool Node advertises; 0 for CPU. */
  nvidiaGpusPerNode: number;
  /** The pool VM's catalog size, which replica default requests divide. */
  nodeSize?: { vCPUs: number; memoryGiB: number };
  /** What managed replicas divide; undefined when the disk size is unknown. */
  ephemeralStorage?: { allocatableGi: number; vCPUs: number };
  /** User-namespace replicas get `/dev/kvm` (RFC 0049 C32 with C10). */
  kvm?: boolean;
}

/**
 * A node pool's Kubernetes runtime: its cluster's verified connection, scoped to
 * the node pool's namespace and carrying the scheduling identity every Pod
 * template on it must select and the kind of capacity it must request
 * (`nvidiaGpusPerNode` devices per Node, or none on CPU node pools). Shared
 * by every consumer that runs native objects on a node pool (Deployment
 * records here; Service Workloads elsewhere).
 */
export interface NodePoolKubernetesRuntime {
  config: LocalKubernetesConfig;
  cluster: ClusterKubernetesClient;
  nodePool: NodePoolRuntimeIdentity;
}

export class NodePoolRuntimeUnavailableError extends Error {
  constructor(nodePoolId: string, why: string) {
    super(`Node pool ${nodePoolId} ${why}`);
    this.name = 'NodePoolRuntimeUnavailableError';
  }
}

export interface NodePoolRuntimeResolver {
  resolve(
    nodePoolId: string,
    signal?: AbortSignal,
  ): Promise<NodePoolKubernetesRuntime>;
}

/**
 * Resolve a node pool to its cluster runtime. A deleted node pool has no
 * runtime; `deleting`, `failed` and `creating` node pools still resolve so
 * Deployments on them can drain, observe and recover — admission decides
 * separately whether new records may target the node pool.
 */
export function createNodePoolRuntimeResolver(deps: {
  nodePools: Pick<NodePoolRepository, 'getForScope'>;
  clusterRuntime: Pick<ClusterRuntimeResolver, 'resolve'>;
}): NodePoolRuntimeResolver {
  return {
    async resolve(nodePoolId, signal) {
      const nodePool = await deps.nodePools.getForScope(nodePoolId, {
        kind: 'api',
      });
      if (!nodePool || nodePool.state === NodePoolState.Deleted) {
        throw new NodePoolRuntimeUnavailableError(nodePoolId, 'does not exist');
      }
      const runtime = await deps.clusterRuntime.resolve(
        nodePool.clusterId,
        signal,
      );
      const { allocatableGi } = nodePoolDisk(nodePool);
      return {
        config: { namespace: nodePoolNamespace(nodePool.id) },
        cluster: runtime.cluster,
        nodePool: {
          clusterId: nodePool.clusterId,
          nodePoolId: nodePool.id,
          nvidiaGpusPerNode: nodePoolGpusPerNode(nodePool),
          nodeSize: nodePoolNodeSize(nodePool),
          ...(nodePool.userNamespaceJobs &&
            nodePool.requireNestedVirtualization && { kvm: true }),
          ...(allocatableGi !== undefined &&
            allocatableGi > 0 && {
              ephemeralStorage: {
                allocatableGi,
                // The largest, so CPU fractions sum to at most one Node of
                // any type in the pool; 0 when the catalog knows none.
                vCPUs: Math.max(
                  0,
                  ...nodePool.vmTypes.map(
                    (type) =>
                      getVCPUsForVMType(type, nodePool.cloudProvider) ?? 0,
                  ),
                ),
              },
            }),
        },
      };
    },
  };
}

/** Resolve the runtime a Deployment record's target lives on. */
export interface DeploymentRuntimeResolver {
  resolve(
    target: DeploymentTarget,
    signal?: AbortSignal,
  ): Promise<NodePoolKubernetesRuntime>;
}

export function createDeploymentRuntimeResolver(deps: {
  nodePools: Pick<NodePoolRuntimeResolver, 'resolve'>;
}): DeploymentRuntimeResolver {
  return {
    resolve(target, signal) {
      return deps.nodePools.resolve(target.nodePoolId, signal);
    },
  };
}

/**
 * The Pods of a Deployment or Service record on its node pool, read only by
 * the record's own selector, in its node pool's namespace unless `namespace`
 * names the record's own.
 */
export async function listReplicaPods(
  runtimes: Pick<DeploymentRuntimeResolver, 'resolve'>,
  owner: { nodePoolId: string; deploymentId: string; namespace?: string },
  timeoutMs = 10_000,
) {
  const runtime = await runtimes.resolve({
    kind: 'nodePool',
    nodePoolId: owner.nodePoolId,
  });
  const namespace = owner.namespace ?? runtime.config.namespace;
  const { items } = await runtime.cluster.core.listNamespacedPod(
    {
      namespace,
      labelSelector: kubernetesWorkloadPodSelector(owner.deploymentId),
    },
    kubernetesRequestOptions(AbortSignal.timeout(timeoutMs)),
  );
  return { runtime, namespace, items };
}
