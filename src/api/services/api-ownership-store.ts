import type { CloudType } from '../../shared/cloud.js';
import type { DB } from './repositories/db.js';

const BACKFILL_SEED_METADATA_KEY = 'api_ownership_backfill_v1_seed';

export const ApiOwnershipTargetStatus = {
  Pending: 'pending',
  Retry: 'retry',
  Completed: 'completed',
  Missing: 'missing',
  Unsupported: 'unsupported',
  Conflict: 'conflict',
} as const;

export type ApiOwnershipTargetStatus =
  (typeof ApiOwnershipTargetStatus)[keyof typeof ApiOwnershipTargetStatus];

export interface ApiOwnershipBackfillTarget {
  vmRowId: number;
  cloudId: string;
  ownerKind: 'workload' | 'resource';
  ownerId: string;
  userId: string;
  endedAt: number | null;
  credentialId: string | null;
  cloudProvider: CloudType | null;
  region: string | null;
  availabilityZone: string | null;
  vmType: string | null;
}

export interface ApiOwnershipBackfillSummary {
  pending: number;
  retry: number;
  completed: number;
  missing: number;
  unsupported: number;
  conflict: number;
}

export interface ApiOwnershipRepository {
  seedLegacyTargets(apiIdentity: string): Promise<number>;
  listActionableTargets(limit: number): Promise<ApiOwnershipBackfillTarget[]>;
  recordTargetResult(
    vmRowId: number,
    status: Exclude<ApiOwnershipTargetStatus, 'pending'>,
    error?: string,
  ): Promise<void>;
  summarize(): Promise<ApiOwnershipBackfillSummary>;
}

export class ApiOwnershipStore implements ApiOwnershipRepository {
  constructor(private readonly db: DB) {}

  /** Atomically snapshot only resources that predate identity-aware boot. */
  async seedLegacyTargets(apiIdentity: string): Promise<number> {
    return this.db.transaction((tx) => {
      const seed = tx.query<{ value: string }>(
        'SELECT value FROM _metadata WHERE key = ?',
        [BACKFILL_SEED_METADATA_KEY],
      )[0]?.value;
      if (seed) {
        if (seed !== apiIdentity) {
          throw new Error(
            `API ownership backfill was seeded for ${seed}, not ${apiIdentity}`,
          );
        }
        return 0;
      }

      const inserted = tx.query<{ rowsAffected: number }>(
        `INSERT INTO api_ownership_backfill_targets (
           vm_id, status, attempts, last_error, updated_at
         )
         SELECT id, 'pending', 0, NULL, ?
         FROM vms
         WHERE ended_at IS NULL
           AND ip IS NOT NULL`,
        [Date.now()],
      );
      tx.query(`INSERT INTO _metadata (key, value) VALUES (?, ?)`, [
        BACKFILL_SEED_METADATA_KEY,
        apiIdentity,
      ]);
      return inserted[0]?.rowsAffected ?? 0;
    });
  }

  async listActionableTargets(
    limit: number,
  ): Promise<ApiOwnershipBackfillTarget[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('API ownership backfill limit must be positive');
    }
    return this.db.query<ApiOwnershipBackfillTarget>(
      `SELECT t.vm_id AS vmRowId,
              v.cloud_id AS cloudId,
              CASE WHEN v.workload_id IS NOT NULL
                   THEN 'workload' ELSE 'resource' END AS ownerKind,
              COALESCE(v.workload_id, v.node_pool_id) AS ownerId,
              COALESCE(d.user_id, p.owner_user_id) AS userId,
              v.ended_at AS endedAt,
              COALESCE(v.credential_id, d.credential_id) AS credentialId,
              COALESCE(creds.cloud_provider, d.requested_compute_provider)
                AS cloudProvider,
              COALESCE(v.region, d.region, p.region) AS region,
              COALESCE(v.availability_zone, d.availability_zone)
                AS availabilityZone,
              v.vm_type AS vmType
       FROM api_ownership_backfill_targets t
       JOIN vms v ON v.id = t.vm_id
       LEFT JOIN workloads d ON d.id = v.workload_id
       LEFT JOIN node_pools p ON p.id = v.node_pool_id
       LEFT JOIN credentials creds
         ON creds.id = COALESCE(v.credential_id, d.credential_id)
       WHERE t.status IN ('pending', 'retry')
       ORDER BY t.attempts, t.updated_at, t.vm_id
       LIMIT ?`,
      [limit],
    );
  }

  async recordTargetResult(
    vmRowId: number,
    status: Exclude<ApiOwnershipTargetStatus, 'pending'>,
    error?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE api_ownership_backfill_targets
       SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE vm_id = ?`,
      [status, error ?? null, Date.now(), vmRowId],
    );
  }

  async summarize(): Promise<ApiOwnershipBackfillSummary> {
    const rows = await this.db.query<{
      status: ApiOwnershipTargetStatus;
      count: number;
    }>(
      `SELECT status, COUNT(*) AS count
       FROM api_ownership_backfill_targets
       GROUP BY status`,
    );
    const summary: ApiOwnershipBackfillSummary = {
      pending: 0,
      retry: 0,
      completed: 0,
      missing: 0,
      unsupported: 0,
      conflict: 0,
    };
    for (const row of rows) summary[row.status] = row.count;
    return summary;
  }
}
