import { errorMessage } from '../../shared/log-diagnostics.js';
import { waitForDNSPublication } from './dns-publication.js';
import { deleteDNSRecord, upsertDNSRecord } from '../../shared/dns-worker.js';
import { createClusterRuntimeResolver } from './kubernetes/cluster-runtime.js';
import {
  getDefaultNodePoolRuntime,
  onNodePoolIngressEntryChanged,
} from './node-pool-runtime-default.js';
import { log } from './logger.js';
import { getPersistence } from './persistence.js';
import {
  createNodePoolServiceController,
  type NodePoolServiceController,
} from './node-pool-service-controller.js';
import {
  createNodePoolServiceReconciler,
  type NodePoolServiceReconciler,
} from './node-pool-service-reconciler.js';

export interface NodePoolServiceRuntimeServices {
  controller: NodePoolServiceController;
  reconciler: NodePoolServiceReconciler;
}

let defaultRuntime: NodePoolServiceRuntimeServices | undefined;

/**
 * Production runtime for Services on node pools: durable Workload records,
 * node pool records and the identity-verified cluster connection. Created once
 * per process.
 */
export function getDefaultNodePoolServiceRuntime(): NodePoolServiceRuntimeServices {
  if (defaultRuntime) return defaultRuntime;
  const persistence = getPersistence();
  const controller = createNodePoolServiceController({
    workloads: persistence.workloadQueries,
    secrets: persistence.credentialSecrets,
    transitions: persistence.workloadLifecycle,
    outcomes: persistence.workloadOutcomes,
    events: persistence.workloadEvents,
    endpoints: persistence.provisioningAttempts,
    nodePools: persistence.nodePools,
    clusterRuntime: createClusterRuntimeResolver({
      connections: persistence.clusterRecords,
    }),
    poolIngress: (nodePoolId) =>
      getDefaultNodePoolRuntime().controller.ingress(nodePoolId),
    // The same Worker calls VM-host Services make, with the creator's token.
    publicEndpoint: {
      publish: async (workloadId, ip, githubToken, recordId) => {
        log.info('Publishing DNS record', { id: workloadId, ip });
        return upsertDNSRecord(workloadId, ip, githubToken, {
          proxied: true,
          recordId,
        });
      },
      waitForPublication: waitForDNSPublication,
      remove: async (recordId, githubToken) => {
        log.info('Deleting DNS record', { recordId });
        await deleteDNSRecord(recordId, githubToken);
      },
    },
  });
  const reconciler = createNodePoolServiceReconciler({
    workloads: persistence.nodePoolServices,
    controller,
  });
  // Service records follow the entry's public IP: wake every live Service on
  // the pool so its next pass re-points `<id>.anycloud.sh`. A wake that never
  // comes (restart in between) heals on the reconciler's own cadence.
  onNodePoolIngressEntryChanged((nodePoolId) => {
    void persistence.nodePoolServices
      .listLiveNodePoolWorkloadIds(nodePoolId)
      .then((ids) => Promise.all(ids.map((id) => reconciler.schedule(id))))
      .catch((error) =>
        log.warn('Waking node pool Services after an entry change failed', {
          id: nodePoolId,
          error: errorMessage(error),
        }),
      );
  });
  defaultRuntime = { controller, reconciler };
  return defaultRuntime;
}
