import { getPersistence } from '../persistence.js';
import {
  createDeploymentRuntimeResolver,
  createNodePoolRuntimeResolver,
  type DeploymentRuntimeResolver,
} from './deployment-runtime.js';
import {
  createClusterRuntimeResolver,
  type ClusterRuntimeResolver,
} from './cluster-runtime.js';

let defaultClusterRuntimeResolver: ClusterRuntimeResolver | undefined;
let defaultDeploymentRuntimeResolver: DeploymentRuntimeResolver | undefined;

/** One verified, cached connection per cluster record for the process. */
export function getDefaultClusterRuntimeResolver(): ClusterRuntimeResolver {
  defaultClusterRuntimeResolver ??= createClusterRuntimeResolver({
    connections: {
      getConnection: (clusterId) =>
        getPersistence().clusterRecords.getConnection(clusterId),
    },
  });
  return defaultClusterRuntimeResolver;
}

/** Deployment records resolve their node pool to one cluster runtime. */
export function getDefaultDeploymentRuntimeResolver(): DeploymentRuntimeResolver {
  defaultDeploymentRuntimeResolver ??= createDeploymentRuntimeResolver({
    nodePools: createNodePoolRuntimeResolver({
      nodePools: {
        getForScope: (nodePoolId, scope) =>
          getPersistence().nodePools.getForScope(nodePoolId, scope),
      },
      clusterRuntime: getDefaultClusterRuntimeResolver(),
    }),
  });
  return defaultDeploymentRuntimeResolver;
}
