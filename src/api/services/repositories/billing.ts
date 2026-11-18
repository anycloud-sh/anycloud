import type { CloudType } from '../../../shared/cloud.js';
import { ClusterState } from '../../../shared/clusters.js';
import { NodePoolState } from '../../../shared/node-pools.js';
import { TERMINAL_STATES } from '../../../shared/workload.js';
import { getDB, type DB } from './db.js';
import { scalarCredentialSql } from './credential-reference.js';

/** One ended VM attempt eligible for a provider's cost allocation. */
export interface VmNeedingCost {
  cloud_id: string;
  workload_id: string | null;
  node_pool_id: string | null;
  cluster_id: string | null;
  resource_id: string;
  resource_tag: 'anycloud_deployment' | 'anycloud_resource';
  credential_id: string | null;
  created_at: number;
  ended_at: number;
  cloud_provider: CloudType;
  region: string | null;
  vm_type: string | null;
}

interface VmCostGroupMember extends VmNeedingCost {
  /** Immutable attempt identity; cloud IDs can repeat across accounts/attempts. */
  id: number;
  /** When the owner reached the state that made its group billable. */
  billable_at: number | null;
}

export interface VmCostGroupCursor {
  resource_tag: VmNeedingCost['resource_tag'];
  resource_id: string;
  credential_present: 0 | 1;
  credential_key: string;
}

export interface VmCostGroupPageOptions {
  /** Groups with no VM end or owner deletion after this keep the estimate. */
  oldestEndedMs: number;
  cutoffMs: number;
  pageSize: number;
  cursor: VmCostGroupCursor | null;
}

export interface VmCostGroupPage {
  groups: VmCostGroupMember[][];
  examinedGroups: number;
  cursor: VmCostGroupCursor | null;
  finished: boolean;
}

export interface VmCostSettlement {
  vmId: number;
  costUsd: number;
}

const GROUP_INDEX = 'idx_vms_pending_cost_group';
// Must match the idx_vms_pending_cost_group expressions exactly (0126).
const KEY_EXPRESSIONS = [
  "CASE WHEN v.workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END",
  'COALESCE(v.node_pool_id, v.cluster_id, v.workload_id)',
  '(v.credential_id IS NOT NULL)',
  "COALESCE(v.credential_id, '')",
];
const KEY_NAMES: (keyof VmCostGroupCursor)[] = [
  'resource_tag',
  'resource_id',
  'credential_present',
  'credential_key',
];
const PENDING_GROUP_PREDICATE = `v.cost IS NULL
  AND v.ended_at IS NOT NULL
  AND (v.workload_id IS NOT NULL OR v.node_pool_id IS NOT NULL
       OR v.cluster_id IS NOT NULL)`;
const KEY_PROJECTION = KEY_EXPRESSIONS.map(
  (expression, index) => `${expression} AS ${KEY_NAMES[index]}`,
).join(', ');
const FIRST_GROUP_SQL = `SELECT ${KEY_PROJECTION}
  FROM vms v INDEXED BY ${GROUP_INDEX}
  WHERE ${PENDING_GROUP_PREDICATE}
  ORDER BY ${KEY_EXPRESSIONS.join(', ')}
  LIMIT 1`;

// SQLite scans this expression index for a row-value tuple comparison. Scalar
// suffix seeks instead skip the complete preceding group, including ineligible
// rows. Ordering only the unequal suffix avoids sorting the entire remaining
// index. The first lookup alone walks its first entry, with LIMIT 1.
const NEXT_GROUP_SEEKS = KEY_EXPRESSIONS.map((_, suffix) => ({
  suffix,
  sql: `SELECT ${KEY_PROJECTION}
    FROM vms v INDEXED BY ${GROUP_INDEX}
    WHERE ${PENDING_GROUP_PREDICATE}
      AND ${[
        ...KEY_EXPRESSIONS.slice(0, suffix).map(
          (expression) => `${expression} = ?`,
        ),
        `${KEY_EXPRESSIONS[suffix]} > ?`,
      ].join(' AND ')}
    ORDER BY ${KEY_EXPRESSIONS.slice(suffix).join(', ')}
    LIMIT 1`,
})).reverse();

const VM_COLUMNS = `v.cloud_id, v.workload_id, v.node_pool_id,
  v.cluster_id,
  COALESCE(v.node_pool_id, v.cluster_id, v.workload_id) AS resource_id,
  CASE WHEN v.workload_id IS NOT NULL
    THEN 'anycloud_deployment' ELSE 'anycloud_resource'
  END AS resource_tag,
  v.credential_id, v.created_at, v.ended_at,
  v.region, v.vm_type, c.cloud_provider`;
const OWNER_AND_CREDENTIAL_JOINS = `LEFT JOIN workloads d ON d.id = v.workload_id
  LEFT JOIN node_pools p ON p.id = v.node_pool_id
  LEFT JOIN clusters r ON r.id = v.cluster_id
  JOIN credentials c
    ON c.id = COALESCE(v.credential_id, ${scalarCredentialSql('d.credential_id')})`;
// Resource-scoped owners settle once the owner is deleted, so the shared
// scope tag covers a complete group; Workload VMs settle on terminal state.
const OWNER_ELIGIBILITY = `(
  (v.workload_id IS NOT NULL AND d.state IN (${TERMINAL_STATES.map(() => '?').join(', ')}))
  OR (v.node_pool_id IS NOT NULL AND p.state = ?)
  OR (v.cluster_id IS NOT NULL AND r.state = ?)
)`;
const OWNER_ELIGIBILITY_PARAMS = [
  ...TERMINAL_STATES,
  NodePoolState.Deleted,
  ClusterState.Destroyed,
];
// Deleted/Destroyed transitions stamp updated_at; terminal Workloads stamp
// completed_at.
const LOAD_GROUP_SQL = `SELECT v.id, ${VM_COLUMNS},
  CASE WHEN v.workload_id IS NOT NULL THEN d.completed_at
    WHEN v.node_pool_id IS NOT NULL THEN p.updated_at ELSE r.updated_at
  END AS billable_at
  FROM vms v INDEXED BY ${GROUP_INDEX}
  ${OWNER_AND_CREDENTIAL_JOINS}
  WHERE ${PENDING_GROUP_PREDICATE}
    AND ${KEY_EXPRESSIONS.map((expression) => `${expression} = ?`).join(' AND ')}
    AND v.cloud_id IS NOT NULL
    AND v.ended_at <= ?
    AND ${OWNER_ELIGIBILITY}`;

/** Retained complete read for diagnostics; the monitor uses bounded pages. */
export function listVmsNeedingCost(
  db: DB,
  cutoffMs: number,
): Promise<VmNeedingCost[]> {
  return db.query<VmNeedingCost>(
    `SELECT ${VM_COLUMNS}
     FROM vms v INDEXED BY idx_vms_needing_cost
     ${OWNER_AND_CREDENTIAL_JOINS}
     WHERE v.cost IS NULL
       AND v.ended_at IS NOT NULL
       AND v.ended_at <= ?
       AND v.cloud_id IS NOT NULL
       AND ${OWNER_ELIGIBILITY}
     ORDER BY resource_tag, resource_id, v.credential_id`,
    [cutoffMs, ...OWNER_ELIGIBILITY_PARAMS],
  );
}

async function nextGroup(
  db: DB,
  cursor: VmCostGroupCursor | null,
): Promise<VmCostGroupCursor | null> {
  if (cursor === null) {
    return (await db.query<VmCostGroupCursor>(FIRST_GROUP_SQL))[0] ?? null;
  }
  const values = KEY_NAMES.map((name) => cursor[name]);
  for (const { suffix, sql } of NEXT_GROUP_SEEKS) {
    const [candidate] = await db.query<VmCostGroupCursor>(
      sql,
      values.slice(0, suffix + 1),
    );
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Budget examined identities, not just eligible results: missing credentials,
 * live parents, and groups newer than the fixed cutoff must consume budget too.
 * A group is never split; one unusually large group remains an unbounded case.
 * The caller retains this cursor for one sweep and yields between pages. No
 * snapshot spans provider requests; eligibility gained behind the cursor is
 * picked up on the next sweep.
 */
export async function listVmCostGroupsPage({
  oldestEndedMs,
  cutoffMs,
  pageSize,
  cursor: after,
}: VmCostGroupPageOptions): Promise<VmCostGroupPage> {
  if (!Number.isFinite(cutoffMs)) {
    throw new Error('Billing cutoff must be a finite timestamp');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('Billing page size must be a positive integer');
  }
  const db = getDB();
  const groups: VmCostGroupMember[][] = [];
  let cursor = after;
  let examinedGroups = 0;
  while (examinedGroups < pageSize) {
    const candidate = await nextGroup(db, cursor);
    if (candidate === null) {
      return { groups, examinedGroups, cursor, finished: true };
    }
    cursor = candidate;
    examinedGroups++;
    const rows = await db.query<VmCostGroupMember>(LOAD_GROUP_SQL, [
      ...KEY_NAMES.map((name) => candidate[name]),
      cutoffMs,
      ...OWNER_ELIGIBILITY_PARAMS,
    ]);
    const recent = (row: VmCostGroupMember) =>
      Math.max(row.ended_at, row.billable_at ?? 0) > oldestEndedMs;
    if (rows.some(recent)) groups.push(rows);
  }
  return { groups, examinedGroups, cursor, finished: false };
}

/** Commit exactly one provider response; no provider await runs in this scope. */
export async function settleVmCostGroup(
  costs: readonly VmCostSettlement[],
): Promise<void> {
  if (costs.length === 0) return;
  await getDB().transaction((tx) => {
    for (const { vmId, costUsd } of costs) {
      const [result] = tx.query<{ rowsAffected: number }>(
        'UPDATE vms SET cost = ? WHERE id = ? AND cost IS NULL',
        [costUsd, vmId],
      );
      if (result?.rowsAffected !== 1) {
        throw new Error('Billing group changed before its costs could settle');
      }
    }
  });
}
