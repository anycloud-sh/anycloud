/**
 * The claim's spend gate for a managed Deployment's Jobs (SLOT), read inside
 * the discovery and claim transactions.
 */

import { type DBTransaction } from './db.js';
import { SESSION_BURN_SQL } from './workload-spend.js';

/**
 * The asking replica's slot on a managed Deployment: undefined on a user
 * Deployment, null while the replica's bind isn't recorded.
 */
export function managedSlot(
  tx: DBTransaction,
  replica: { deploymentId: string; podUid: string },
): { hourlyUsd: number | null } | null | undefined {
  const [slot] = tx.query<{ bound: string | null; hourlyUsd: number | null }>(
    `SELECT o.pod_uid AS bound,
            o.hourly_usd / t.max_concurrent_jobs_per_replica AS hourlyUsd
     FROM deployments t LEFT JOIN pool_occupancy o ON o.deployment_id = t.id
       AND o.pod_uid = ? AND o.ended_at IS NULL
     WHERE t.id = ? AND t.managed = 1`,
    [replica.podUid, replica.deploymentId],
  );
  return slot && (slot.bound === null ? null : slot);
}

/**
 * Re-checks the session throttle inside the claim, so concurrent claims that
 * each passed discovery can't together exceed it. An unbound replica fails.
 */
export function overSessionThrottle(
  tx: DBTransaction,
  replica: { deploymentId: string; podUid: string },
  session: string | null,
): boolean {
  const slot = managedSlot(tx, replica);
  if (!slot || session === null) return slot === null;
  return (
    tx.query(
      `SELECT 1 FROM throttles WHERE scope = 'agent-session'
         AND (${SESSION_BURN_SQL}) + ? >= cap_usd`,
      [session, session, slot.hourlyUsd ?? 0],
    ).length > 0
  );
}
