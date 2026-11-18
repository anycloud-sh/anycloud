import { TERMINAL_STATES } from '../../../shared/workload.js';

/**
 * The one definition of a Workload that still holds a node pool in use: a
 * node-pool-targeted row whose cleanup has not confirmed native removal.
 * `NodePoolServiceStore.hasLiveNodePoolReferences` (the early diagnostic) and
 * the `NOT EXISTS` fence inside `NodePoolStore.requestDeletion` both render
 * this text, so the two can never disagree about what "live" means.
 */
export function liveNodePoolWorkloadSql(
  alias: string,
  nodePoolExpression: string,
): string {
  const column = alias ? `${alias}.` : '';
  return `${column}node_pool_id = ${nodePoolExpression} AND ${column}cleaned_at IS NULL`;
}

/**
 * Deployment records that hold a node pool, as one SQL count: user
 * Deployments until deleted, and live or uncleaned pool Jobs on its managed
 * Deployments, which go with the pool. `node-pool delete`'s early diagnostic
 * and the fence in `NodePoolStore.requestDeletion` both render this text.
 */
export function nodePoolDeploymentReferencesSql(
  nodePoolExpression: string,
): string {
  return `((SELECT COUNT(*) FROM deployments d
      WHERE d.node_pool_id = ${nodePoolExpression} AND d.deleted_at IS NULL
        AND d.managed = 0)
    + (SELECT COUNT(*) FROM workloads w JOIN deployments d ON d.id = w.deployment_id
      WHERE d.node_pool_id = ${nodePoolExpression} AND d.managed = 1
        AND (w.state NOT IN (${TERMINAL_STATES.map((state) => `'${state}'`).join(', ')})
          OR (w.cleaned_at IS NULL AND w.current_execution_id IS NOT NULL))))`;
}

/**
 * GPUs the node pool's live user Deployments (each replica's, up to their
 * maximum) and Services hold, as one SQL scalar. Managed Deployments reserve
 * none: RA caps their replicas after these (RFC 0044 invariant 16).
 * A Service stores its resolved count as `dockerOptions.gpus`. Both admissions
 * compare it with `ready VMs × GPUs per VM` in the transaction that stores them.
 */
export function nodePoolGpuReservationSql(nodePoolExpression: string): string {
  return `((SELECT COALESCE(SUM(d.gpu_count * d.max_replicas), 0) FROM deployments d
      WHERE d.node_pool_id = ${nodePoolExpression} AND d.deleted_at IS NULL
        AND d.managed = 0)
    + (SELECT COALESCE(SUM(CAST(json_extract(s.docker_options, '$.gpus') AS INTEGER)), 0)
      FROM workloads w JOIN container_specs s ON s.workload_id = w.id
      WHERE ${liveNodePoolWorkloadSql('w', nodePoolExpression)}))`;
}
