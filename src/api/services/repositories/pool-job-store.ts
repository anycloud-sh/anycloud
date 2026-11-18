/**
 * Reads of pool Jobs on managed Deployments (RFC 0044): `logs`' window, the
 * Jobs `api upgrade` drains, and `node-pool status`'s runners.
 */

import {
  LIVE_EXECUTION_STATES,
  type WorkloadState,
} from '../../../shared/workload.js';
import type { DB } from './db.js';

/** An attempt's kept log tail, or why it couldn't be read. */
export interface PoolJobLogTail {
  state: 'captured' | 'unavailable';
  text: string;
}

/** What `logs` reads for a pool Job: its replica and its current attempt. */
export interface PoolJobLogWindow {
  managed: boolean;
  deploymentId: string;
  nodePoolId: string;
  state: WorkloadState;
  /** Null until a runner first claims the Job. */
  attempt: {
    podUid: string;
    openedAt: number;
    endedAt: number | null;
    tail: PoolJobLogTail | null;
  } | null;
}

export interface PoolJobInFlight {
  id: string;
  state: WorkloadState;
  deploymentId: string;
  nodePoolId: string;
  nodePool: string;
  executionId: string;
  podUid: string;
  /** Its managed Deployment's runner release (RFC 0049 C27). */
  runnerRelease: string | null;
}

export class PoolJobStore {
  constructor(private readonly db: DB) {}

  async logWindow(jobId: string): Promise<PoolJobLogWindow | null> {
    const [row] = await this.db.query<{
      managed: number;
      deploymentId: string;
      nodePoolId: string;
      state: WorkloadState;
      podUid: string | null;
      openedAt: number | null;
      endedAt: number | null;
      logTail: string | null;
      logTailState: PoolJobLogTail['state'] | null;
    }>(
      `SELECT d.managed, d.id AS deploymentId, d.node_pool_id AS nodePoolId,
              w.state, p.pod_uid AS podUid, a.opened_at AS openedAt,
              a.ended_at AS endedAt, a.log_tail AS logTail,
              a.log_tail_state AS logTailState
       FROM workloads w JOIN deployments d ON d.id = w.deployment_id
       LEFT JOIN workload_attempts a ON a.execution_id = w.current_execution_id
       LEFT JOIN pod_attempts p ON p.attempt_id = a.id
       WHERE w.id = ?`,
      [jobId],
    );
    if (!row) return null;
    const { podUid, openedAt, logTail, logTailState } = row;
    return {
      managed: row.managed === 1,
      deploymentId: row.deploymentId,
      nodePoolId: row.nodePoolId,
      state: row.state,
      attempt:
        podUid === null || openedAt === null
          ? null
          : {
              podUid,
              openedAt,
              endedAt: row.endedAt,
              tail:
                logTailState === null
                  ? null
                  : { state: logTailState, text: logTail ?? '' },
            },
    };
  }

  /** The pool Jobs runners hold now, which `api upgrade` waits for. */
  async inFlight(): Promise<PoolJobInFlight[]> {
    return this.db.query<PoolJobInFlight>(
      `SELECT w.id, w.state, w.deployment_id AS deploymentId,
              d.node_pool_id AS nodePoolId, n.name AS nodePool,
              w.current_execution_id AS executionId, p.pod_uid AS podUid,
              d.runner_release AS runnerRelease
       FROM workloads w
       JOIN deployments d ON d.id = w.deployment_id AND d.managed = 1
       JOIN node_pools n ON n.id = d.node_pool_id
       JOIN workload_attempts a ON a.execution_id = w.current_execution_id
       JOIN pod_attempts p ON p.attempt_id = a.id
       WHERE w.state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')})
       ORDER BY w.submitted_at, w.id`,
      [...LIVE_EXECUTION_STATES],
    );
  }

  /** A pool's managed Deployments and the replicas holding their pool Jobs. */
  async runnerRows(
    nodePoolId: string,
  ): Promise<{ id: string; podUid: string | null }[]> {
    return this.db.query(
      `SELECT d.id, p.pod_uid AS podUid FROM deployments d
       LEFT JOIN workloads w ON w.deployment_id = d.id
         AND w.state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')})
       LEFT JOIN workload_attempts a ON a.execution_id = w.current_execution_id
       LEFT JOIN pod_attempts p ON p.attempt_id = a.id
       WHERE d.node_pool_id = ? AND d.managed = 1 AND d.deleted_at IS NULL`,
      [...LIVE_EXECUTION_STATES, nodePoolId],
    );
  }
}
