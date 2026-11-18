/** Node pool Service discovery and the Workload references that hold a node pool. */

import { type DB } from './db.js';
import { liveNodePoolWorkloadSql } from './node-pool-references.js';
import {
  TERMINAL_STATES,
  type WorkloadState,
} from '../../../shared/workload.js';

export interface NodePoolServiceCandidate {
  id: string;
  nodePoolId: string;
  state: WorkloadState;
}

export class NodePoolServiceStore {
  constructor(private readonly db: DB) {}

  /**
   * Node pool-targeted Services the node pool Service controller must
   * reconcile: every one that is not terminal. Terminal rows are the shared
   * cleanup lane's, which asks the Serve runtime to remove native objects.
   */
  async listNodePoolServiceCandidates(): Promise<NodePoolServiceCandidate[]> {
    const terminal = TERMINAL_STATES.map(() => '?').join(', ');
    return this.db.query<NodePoolServiceCandidate>(
      `SELECT d.id, d.node_pool_id AS nodePoolId, d.state
       FROM workloads d INDEXED BY idx_workloads_node_pool
       WHERE d.node_pool_id IS NOT NULL AND d.state NOT IN (${terminal})
       ORDER BY d.started_at ASC, d.id ASC`,
      TERMINAL_STATES,
    );
  }

  /**
   * Whether a Service still references the node pool: any row whose native
   * objects may still exist, which is every row cleanup has not confirmed.
   */
  async hasLiveNodePoolReferences(nodePoolId: string): Promise<boolean> {
    const rows = await this.db.query<{ present: number }>(
      `SELECT 1 AS present FROM workloads INDEXED BY idx_workloads_node_pool
       WHERE ${liveNodePoolWorkloadSql('', '?')}
       LIMIT 1`,
      [nodePoolId],
    );
    return rows.length > 0;
  }

  /** Ids of the node pool's live Workloads, for waking their reconciles. */
  async listLiveNodePoolWorkloadIds(nodePoolId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM workloads INDEXED BY idx_workloads_node_pool
       WHERE ${liveNodePoolWorkloadSql('', '?')}`,
      [nodePoolId],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Whether every live Service on the node pool that has a public record
   * reads it as published at `ip`: an entry hand-off's cue.
   */
  async publishedAt(nodePoolId: string, ip: string): Promise<boolean> {
    const terminal = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = await this.db.query<{ present: number }>(
      `SELECT 1 AS present FROM workloads INDEXED BY idx_workloads_node_pool
       WHERE node_pool_id = ? AND state NOT IN (${terminal})
         AND dns_record_id IS NOT NULL
         AND (public_endpoint_ip IS NOT ? OR public_endpoint_state IS NOT 'published')
       LIMIT 1`,
      [nodePoolId, ...TERMINAL_STATES, ip],
    );
    return rows.length === 0;
  }

  /** Node pool-targeted Workloads whose cleanup has not confirmed removal. */
  async countLiveNodePoolReferences(nodePoolId: string): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workloads INDEXED BY idx_workloads_node_pool
       WHERE ${liveNodePoolWorkloadSql('', '?')}`,
      [nodePoolId],
    );
    return rows[0]?.count ?? 0;
  }
}
