import config from '../config.js';
import type { CloudConfig } from '../../shared/cloud.js';
import type { CloudCompute } from './gateways/cloud.js';
import { getDefaultDeploymentControl } from './deployment-controller.js';
import { getDefaultClusterRuntimeResolver } from './kubernetes/default-runtime.js';
import { log } from './logger.js';
import {
  getDeploymentExecutionStore,
  getPersistence,
  getPoolJobStore,
} from './persistence.js';
import {
  createNodePoolController,
  type NodePoolController,
} from './node-pool-controller.js';
import {
  createNodePoolReconciler,
  type NodePoolReconciler,
} from './node-pool-reconciler.js';

export interface NodePoolRuntimeServices {
  controller: NodePoolController;
  reconciler: NodePoolReconciler;
}

const entryChangedListeners = new Set<(nodePoolId: string) => void>();

/**
 * Told when a pool's ingress entry changes or is lost. The Service runtime
 * listens to re-point `<id>.anycloud.sh` records; registering here rather
 * than importing that runtime keeps the two defaults acyclic.
 */
export function onNodePoolIngressEntryChanged(
  listener: (nodePoolId: string) => void,
): () => void {
  entryChangedListeners.add(listener);
  return () => entryChangedListeners.delete(listener);
}

let defaultRuntime: NodePoolRuntimeServices | undefined;
let configuredCreateCompute:
  | ((config: CloudConfig) => CloudCompute)
  | undefined;

/**
 * Narrow qualification seam: a constrained fixture may replace the provider
 * compute a node pool provisions with before the runtime is created. Product
 * lifecycle wiring stays here; the seam cannot change once initialized.
 */
export function configureDefaultNodePoolRuntime(composition: {
  createCompute(config: CloudConfig): CloudCompute;
}): NodePoolRuntimeServices {
  if (defaultRuntime) {
    if (composition.createCompute !== configuredCreateCompute) {
      throw new Error(
        'Node pool compute composition cannot change after the default runtime is initialized',
      );
    }
    return defaultRuntime;
  }
  configuredCreateCompute = composition.createCompute;
  return getDefaultNodePoolRuntime();
}

/**
 * Production node pool runtime: provider gateways, the shared VM ledger and
 * the identity-verified cluster connection. Created once per process.
 */
export function getDefaultNodePoolRuntime(): NodePoolRuntimeServices {
  if (defaultRuntime) return defaultRuntime;
  const persistence = getPersistence();
  const controller = createNodePoolController({
    ...(configuredCreateCompute
      ? { createCompute: configuredCreateCompute }
      : {}),
    nodePools: persistence.nodePools,
    vms: persistence.nodePoolVms,
    clusterRecords: persistence.clusterRecords,
    references: {
      countLiveForNodePool: async (nodePoolId) =>
        (await persistence.deployments.countLiveForNodePool(nodePoolId)) +
        (await persistence.nodePoolServices.countLiveNodePoolReferences(
          nodePoolId,
        )),
      // Every node-pool Workload is a Service today.
      countServicesForNodePool: (nodePoolId) =>
        persistence.nodePoolServices.countLiveNodePoolReferences(nodePoolId),
      listManagedImages: (nodePoolId) =>
        persistence.deployments.listLiveManagedImages(nodePoolId),
    },
    // Service records follow the entry's public IP: wake every live Service
    // on the pool so its next pass re-points `<id>.anycloud.sh`. A pass that
    // never comes (restart in between) heals on the reconciler's own cadence.
    ingress: {
      entryChanged: (nodePoolId, entry) => {
        log.info('Node pool ingress entry changed', { id: nodePoolId, entry });
        for (const listener of entryChangedListeners) listener(nodePoolId);
      },
      publishedAt: (nodePoolId, ip) =>
        persistence.nodePoolServices.publishedAt(nodePoolId, ip),
    },
    clusterRuntime: getDefaultClusterRuntimeResolver(),
    // Scaling reads the Pods the Deployment loop already watches.
    pods: (clusterId) => getDefaultDeploymentControl().pods(clusterId),
    unfit: (...pool) => getDefaultDeploymentControl().unfit(...pool),
    poolJobs: {
      closeReplica: (podUid) =>
        getDeploymentExecutionStore().closeReplica(podUid),
      inFlight: () => getPoolJobStore().inFlight(),
    },
    credentials: persistence.credentialSecrets,
    version: config.currVersion,
  });
  defaultRuntime = {
    controller,
    reconciler: createNodePoolReconciler({
      nodePools: persistence.nodePools,
      controller,
    }),
  };
  return defaultRuntime;
}
