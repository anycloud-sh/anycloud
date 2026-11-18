/** RA's reads (RFC 0044): managed Deployments' demand and room on a cluster. */

import type { DB } from './db.js';
import { TERMINAL_STATES, WorkloadState } from '../../../shared/workload.js';
import { nodePoolGpuReservationSql } from './node-pool-references.js';

export interface ManagedDemand {
  deploymentId: string;
  session: string | null;
  held: boolean;
  hourlyUsd: number | null;
}

/** What bounds a managed Deployment's replicas on its node pool (RA). */
export interface ManagedRoom {
  maxVms: number;
  /** GPUs user Deployments and Services reserve. */
  reservedGpus: number;
  /** The newest pool VM's hourly price. */
  vmPrice: number | null;
}

export class ReplicaDemandStore {
  constructor(private readonly db: DB) {}

  /**
   * Managed Deployments' Jobs on a cluster that hold or want a replica, in
   * submit order (RA's in-flight cap): held ones, in any live state, then
   * queued and retrying ones, each with its session and its Deployment's
   * last replica price.
   */
  async listManagedDemand(clusterId: string): Promise<ManagedDemand[]> {
    const rows = await this.db.query<
      Omit<ManagedDemand, 'held'> & { held: number }
    >(
      `SELECT w.deployment_id AS deploymentId, w.session AS session,
              w.state NOT IN (?, ?) AS held,
              (SELECT o.hourly_usd FROM pool_occupancy o
               WHERE o.deployment_id = d.id ORDER BY o.id DESC LIMIT 1) AS hourlyUsd
       FROM workloads w
       JOIN deployments d ON d.id = w.deployment_id
       JOIN node_pools p ON p.id = d.node_pool_id
       WHERE d.managed = 1 AND p.cluster_id = ? AND d.deleted_at IS NULL AND (
         w.state NOT IN (?, ${TERMINAL_STATES.map(() => '?').join(', ')})
         OR (w.state = ? AND (w.first_claimed_at IS NOT NULL
           OR w.claim_deadline_at IS NULL OR w.claim_deadline_at > ?))
         OR (w.state IN (${TERMINAL_STATES.map(() => '?').join(', ')})
           AND w.cleaned_at IS NULL AND w.current_execution_id IS NOT NULL)
       )
       ORDER BY w.submitted_at, w.id`,
      [
        WorkloadState.Queued,
        WorkloadState.Retrying,
        clusterId,
        WorkloadState.Queued,
        ...TERMINAL_STATES,
        WorkloadState.Queued,
        Date.now(),
        ...TERMINAL_STATES,
      ],
    );
    return rows.map((row) => ({ ...row, held: row.held === 1 }));
  }

  async managedRoom(nodePoolId: string): Promise<ManagedRoom> {
    const [room] = await this.db.query<ManagedRoom>(
      `SELECT p.max_vm_count AS maxVms,
              ${nodePoolGpuReservationSql('p.id')} AS reservedGpus,
              (SELECT price_per_hour FROM vms WHERE node_pool_id = p.id
               ORDER BY id DESC LIMIT 1) AS vmPrice
       FROM node_pools p WHERE p.id = ?`,
      [nodePoolId],
    );
    if (!room) throw new Error(`Node pool ${nodePoolId} not found`);
    return room;
  }
}
