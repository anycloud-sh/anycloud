import { getDB } from './db.js';
import { type QuotaRequestEntry } from '../../../shared/api-contract/quota-schemas.js';
import { CloudType } from '../../../shared/cloud.js';
import {
  QuotaOperationStatus,
  QuotaOperationTargetStatus,
  QuotaRequestStatus,
} from '../../../shared/quota.js';
import { canonicalizeQuotaRequestEntries } from '../../../shared/quota-groups.js';
import { ownershipBranches, type OwnershipScope } from './ownership-filter.js';

interface QuotaOperationTargetRow {
  id: string;
  operation_id: string;
  target_index: number;
  vm_type: string;
  region: string;
  spot: number;
  include_public_ip_quota: number | null;
  status: QuotaOperationTargetStatus;
  attempts: number;
  entries_json: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface QuotaStatusOperationTargetRow extends QuotaOperationTargetRow {
  operation_status: QuotaOperationStatus;
  operation_cloud_provider: CloudType;
  operation_credential_name: string | null;
  operation_created_at: number;
  operation_updated_at: number;
}

/**
 * Safely read persisted quota request entries at the API boundary. Historical
 * resource keys are canonicalized in memory; the stored JSON is never
 * rewritten as a side effect of reading it.
 */
export function parseStoredQuotaRequestEntries(
  entriesJson: string | null | undefined,
  cloud: CloudType,
): QuotaRequestEntry[] {
  if (!entriesJson) return [];
  try {
    const parsed = JSON.parse(entriesJson) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (entry) =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      )
    ) {
      return [];
    }
    return canonicalizeQuotaRequestEntries(
      cloud,
      parsed as QuotaRequestEntry[],
    );
  } catch {
    return [];
  }
}

export async function listQuotaStatusOperationTargets(
  input:
    | {
        scope: OwnershipScope;
        cloud: CloudType;
        credentialName?: string;
        region?: string;
      }
    | { scope: OwnershipScope; canceledOnly: true },
): Promise<QuotaStatusOperationTargetRow[]> {
  const db = getDB();
  const ownerBranches = ownershipBranches(input.scope, 'o');
  const params: unknown[] = ownerBranches.flatMap((branch) => branch.params);
  const where = ['o.dry_run = 0'];
  if ('canceledOnly' in input) {
    where.push("t.status = 'completed'", "t.error LIKE 'Canceled:%'");
  } else {
    where.push(
      'o.cloud_provider = ?',
      `(
      (
        o.status IN (?, ?)
        AND t.status IN (?, ?)
      )
      OR (
        t.status = ?
        AND t.entries_json IS NOT NULL
        AND t.entries_json != '[]'
        AND (
          LOWER(t.entries_json) LIKE ?
          OR LOWER(t.entries_json) LIKE ?
          OR LOWER(t.entries_json) LIKE ?
          OR LOWER(t.entries_json) LIKE ?
        )
      )
      OR (t.status = 'completed' AND t.error LIKE ?)
    )`,
    );
    params.push(
      input.cloud,
      QuotaOperationStatus.Queued,
      QuotaOperationStatus.Running,
      QuotaOperationTargetStatus.Pending,
      QuotaOperationTargetStatus.Running,
      QuotaOperationTargetStatus.Completed,
      `%"status":"${QuotaRequestStatus.Submitted}"%`,
      `%"status":"${QuotaRequestStatus.Watching}"%`,
      `%"status":"${QuotaRequestStatus.TimedOut}"%`,
      `%"status":"${QuotaRequestStatus.Approved}"%`,
      'Canceled:%',
    );
    if (input.credentialName) {
      where.push('o.credential_name = ?');
      params.push(input.credentialName);
    }
    if (input.region) {
      where.push('t.region = ?');
      params.push(input.region);
    }
  }

  return db.query<QuotaStatusOperationTargetRow>(
    `WITH owned_operations AS NOT MATERIALIZED (
       ${ownerBranches
         .map(
           (branch) => `SELECT o.* FROM quota_operations o WHERE ${branch.sql}`,
         )
         .join('\n       UNION ALL\n       ')}
     )
    SELECT
      t.*,
      o.status AS operation_status,
      o.cloud_provider AS operation_cloud_provider,
      o.credential_name AS operation_credential_name,
      o.created_at AS operation_created_at,
      o.updated_at AS operation_updated_at
    FROM owned_operations o
    JOIN quota_operation_targets t ON t.operation_id = o.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.created_at ASC, t.target_index ASC
  `,
    params,
  );
}
