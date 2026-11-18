/**
 * Spend reads over the shared Workload database: the windowed cost report
 * behind `anycloud cost` and the budget cap's alert, the exact per-workload
 * cost, and the notifications digest's start counts and VM spend.
 */

import { type DB } from './db.js';
import { computedWorkloadCloudProviderSql } from './credential-reference.js';
import {
  type CostAttributionSummary as CostAgentSummary,
  type CostAttributionSummary as CostUserSummary,
  type CostProviderSummary,
  type WorkloadCostReport as CostReport,
  type WorkloadCostRow as CostRow,
} from '../../../shared/api-contract/workload-management-schemas.js';
import type { WorkloadTypeValue } from '../../../shared/workload.js';
import { workloadTypeBucket } from '../../../shared/workload-behavior.js';
import {
  ownershipBranches,
  ownershipPredicate,
  type OwnershipIdentity,
  type OwnershipScope,
} from './ownership-filter.js';
import {
  parseStringOrArray,
  vmAggregateColumnsSql,
  workloadAttributionFiltersSql,
  type WorkloadAttributionFilter,
  type WorkloadRow,
} from './workload-queries.js';

/**
 * Windowed spend SQL for provisioned VMs over the half-open window
 * [startMs, endMs), shared by the cost report, the digest and the spend caps.
 * A live VM ends at min(nowMs, endMs), so it is charged only for time it has
 * already run. Reconciled `cost` is prorated by the in-window share of the
 * VM's lifetime; otherwise the estimate is price_per_hour × in-window hours.
 * Never-provisioned placeholders (ip IS NULL) do not represent VM usage, so
 * they never overlap a window.
 */
export function windowedVmSpendSql(window: {
  startMs: number;
  endMs: number;
  nowMs: number;
}): {
  overlapsWindow: string;
  overlappingVms: (from?: string) => string;
  overlapMs: string;
  actualCost: string;
  estimatedCost: string;
} {
  const { startMs, endMs } = window;
  const liveEndMs = Math.min(window.nowMs, endMs);
  const vmEnd = `COALESCE(v.ended_at, ${liveEndMs})`;
  // Written with explicit CASE because SQLite's MIN/MAX scalar forms can be
  // misparsed as aggregate variants when nested inside SUM(CASE ...).
  const overlapMs = `((CASE WHEN ${vmEnd} < ${endMs} THEN ${vmEnd} ELSE ${endMs} END)
    - (CASE WHEN v.created_at > ${startMs} THEN v.created_at ELSE ${startMs} END))`;
  const columns = `v.workload_id, v.ip, v.created_at, v.ended_at,
      v.price_per_hour, v.cost`;
  return {
    overlapsWindow: `v.ip IS NOT NULL
      AND v.created_at < (CASE WHEN v.ended_at IS NULL THEN ${liveEndMs} ELSE ${endMs} END)
      AND ${vmEnd} > ${startMs}`,
    // Live and ended rows are deliberately separate: the former is an
    // equality probe on ended_at=NULL, while the latter is a range probe on
    // ended_at. Combining them behind OR or COALESCE lets SQLite choose a full
    // index scan as history grows.
    overlappingVms: (from = 'vms AS v') => `SELECT ${columns}
    FROM ${from}
    WHERE v.ip IS NOT NULL
      AND v.ended_at IS NULL
      AND v.created_at < ${liveEndMs}
      AND ${liveEndMs} > ${startMs}
    UNION ALL
    SELECT ${columns}
    FROM ${from}
    WHERE v.ip IS NOT NULL
      AND v.ended_at IS NOT NULL
      AND v.ended_at > ${startMs}
      AND v.created_at < ${endMs}`,
    overlapMs,
    actualCost: `(CASE WHEN v.cost IS NOT NULL
      THEN v.cost * ${overlapMs} / NULLIF(${vmEnd} - v.created_at, 0)
      ELSE 0 END)`,
    estimatedCost: `(CASE WHEN v.cost IS NULL AND v.price_per_hour IS NOT NULL
      THEN v.price_per_hour * ${overlapMs} / 3600000.0
      ELSE 0 END)`,
  };
}

/** A session's live burn ($/hr): its priced in-flight VMs. */
export const SESSION_BURN_SQL = `SELECT COALESCE(SUM(v.price_per_hour), 0) AS rate
  FROM vms v INDEXED BY idx_vms_active JOIN workloads d ON d.id = v.workload_id
  WHERE v.ended_at IS NULL AND v.ip IS NOT NULL
    AND v.price_per_hour IS NOT NULL AND d.session = ?`;

/**
 * Windowed `vm_duration_ms` / `total_cost` / `cost_source` aggregates for the
 * cost report ({@link WorkloadSpendStore.getCostReportInWindow}) and the
 * host-global digest spend scan ({@link WorkloadSpendStore.sumVmSpendInWindow}).
 */
function windowedVmCostExprs(
  window: Parameters<typeof windowedVmSpendSql>[0],
): ReturnType<typeof windowedVmSpendSql> & {
  durationMs: string;
  totalCost: string;
  costSource: string;
} {
  const spend = windowedVmSpendSql(window);
  const { overlapsWindow, overlapMs, actualCost, estimatedCost } = spend;
  return {
    ...spend,
    durationMs: `SUM(CASE WHEN ${overlapsWindow} THEN ${overlapMs} ELSE 0 END)`,
    totalCost: `SUM(CASE
      WHEN ${overlapsWindow} THEN ${actualCost} + ${estimatedCost}
      ELSE 0
    END)`,
    costSource: `CASE WHEN COALESCE(SUM(CASE
        WHEN ${overlapsWindow}
          AND v.price_per_hour IS NOT NULL AND v.cost IS NULL THEN 1
        ELSE 0
      END), 0) = 0 THEN 'actual' ELSE 'estimated' END`,
  };
}

type CostWorkloadRow = Pick<
  WorkloadRow,
  | 'id'
  | 'workload_type'
  | 'computed_cloud_provider'
  | 'requested_compute_provider'
  | 'region'
  | 'vm_type'
  | 'spot'
  | 'vm_duration_ms'
  | 'awaiting_release_ms'
  | 'total_cost'
  | 'cost_source'
  | 'agent'
> & { image: string | null; container_spec_owner_id: string | null };

interface CostReportRow {
  dimension: 'total' | 'provider' | 'agent' | 'user';
  key: string | null;
  total_cost: number;
  duration_ms: number;
  jobs: number;
  services: number;
  vms: number;
  workloads_without_price: number;
  has_spot: number;
  includes_other_users: number;
}

function toCostRow(row: CostWorkloadRow): CostRow {
  if (row.container_spec_owner_id === null || row.image === null) {
    throw new Error(
      `Workload ${row.id}: container spec ownership is incomplete`,
    );
  }
  return {
    id: row.id,
    workloadType: row.workload_type,
    image: row.image,
    cloudProvider:
      row.computed_cloud_provider ?? row.requested_compute_provider ?? null,
    region: row.region,
    vmType: parseStringOrArray(row.vm_type),
    spot: row.spot === 1,
    vmDurationMs: row.vm_duration_ms ?? null,
    awaitingReleaseMs: row.awaiting_release_ms ?? null,
    totalCost: row.total_cost ?? null,
    costSource: row.cost_source ?? null,
    agent: row.agent,
  };
}

function toCostReport(rows: CostReportRow[], periodMs: number): CostReport {
  const total = rows.find(({ dimension }) => dimension === 'total');
  const byProvider: Record<string, CostProviderSummary> = {};
  const byAgent: Record<string, CostAgentSummary> = {};
  const byUser: Record<string, CostUserSummary> = {};
  for (const row of rows) {
    if (row.key === null) continue;
    if (row.dimension === 'provider') {
      byProvider[row.key] = {
        cost: row.total_cost,
        durationMs: row.duration_ms,
        jobs: row.jobs,
        services: row.services,
        vms: row.vms,
        hasSpot: row.has_spot === 1,
      };
    } else if (row.dimension === 'agent') {
      byAgent[row.key] = {
        cost: row.total_cost,
        durationMs: row.duration_ms,
        jobs: row.jobs,
        services: row.services,
        vms: row.vms,
      };
    } else if (row.dimension === 'user') {
      byUser[row.key] = {
        cost: row.total_cost,
        durationMs: row.duration_ms,
        jobs: row.jobs,
        services: row.services,
        vms: row.vms,
      };
    }
  }
  return {
    periodMs,
    totalCost: total?.total_cost ?? 0,
    totalDurationMs: total?.duration_ms ?? 0,
    totalJobs: total?.jobs ?? 0,
    totalServices: total?.services ?? 0,
    totalVms: total?.vms ?? 0,
    workloadsWithoutPrice: total?.workloads_without_price ?? 0,
    byProvider,
    byAgent,
    byUser,
    includesOtherUsers: total?.includes_other_users === 1,
  };
}

function costWorkloadColumnsSql(nowMs: number): string {
  return `d.id,
    d.workload_type,
    s.workload_id AS container_spec_owner_id,
    s.image,
    ${computedWorkloadCloudProviderSql('d')} AS computed_cloud_provider,
    d.requested_compute_provider,
    d.region,
    d.vm_type,
    d.spot,
    d.agent,
    ${vmAggregateColumnsSql(nowMs)}`;
}

/**
 * Per-workload-type slice of
 * {@link WorkloadSpendStore.summarizeWorkloadStartsInWindow}.
 */
export interface WorkloadTypeStarts {
  initialSubmissions: number;
  resubmissions: number;
}

export interface UserWorkloadStarts {
  userId: string;
  ownerUserId: string | null;
  jobs: WorkloadTypeStarts;
  services: WorkloadTypeStarts;
  vms: WorkloadTypeStarts;
}

/**
 * Per-workload-type slice of {@link WorkloadSpendStore.sumVmSpendInWindow}.
 */
export interface WindowedVmSpend {
  runningCost: number;
  costSource: 'actual' | 'estimated';
  activeVmCount: number;
  unpricedVmCount: number;
  durationMs: number;
}

export interface UserWindowedVmSpend {
  userId: string;
  ownerUserId: string | null;
  jobs: WindowedVmSpend;
  services: WindowedVmSpend;
  vms: WindowedVmSpend;
}

// Legacy usernames cannot identify a current account: handles can be reassigned.
export function digestUserKey(
  ownerUserId: string | null,
  userId: string,
): string {
  return ownerUserId ?? `legacy:${userId.toLowerCase()}`;
}

export class WorkloadSpendStore {
  constructor(private readonly db: DB) {}

  /**
   * Complete aggregate cost report for provisioned VM usage overlapping the
   * half-open reporting window [windowStartMs, windowEndMs). The VM window is
   * scanned once, costs are clipped and rolled up once per workload, then
   * the materialized workload rows feed the total/provider/agent summaries.
   * Result size therefore does not grow with workload history.
   */
  async getCostReportInWindow(
    scope: OwnershipScope,
    windowStartMs: number,
    windowEndMs: number,
    filter?: WorkloadAttributionFilter,
    viewer?: OwnershipIdentity,
  ): Promise<CostReport> {
    const { clauses, params } = workloadAttributionFiltersSql('d', filter);
    const workloadDriven = Boolean(filter?.session);
    const { overlappingVms, durationMs, totalCost } = windowedVmCostExprs({
      startMs: windowStartMs,
      endMs: windowEndMs,
      nowMs: Date.now(),
    });
    // The workload-driven branch enters `workloads` through the session or
    // ownership indexes, so it needs each ownership branch as a separately
    // indexable arm (team scope contributes a single unfiltered arm). The
    // VM-driven branch is already bounded by the VM window and reaches each
    // workload by primary key, so it filters ownership inline: SQLite cannot
    // flatten a compound CTE into the inner side of a join, so an
    // `owned_workloads` arm there materializes every column of the owner's
    // whole history and builds an automatic index over it before the id lookup
    // that was going to bound the scan anyway.
    const ownerBranches = ownershipBranches(scope, 'd');
    const owner = ownershipPredicate(scope, 'd');
    const attributionWhere =
      clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
    const attributionIndex =
      filter?.session && filter.sessionExact
        ? ' INDEXED BY idx_workloads_session'
        : '';
    // `owned_workloads` has already filtered a session's report.
    const ownership = workloadDriven
      ? ''
      : ` AND ${owner.sql}${attributionWhere}`;
    const includesOtherUsersSql = viewer
      ? `COALESCE(MAX(CASE
          WHEN total_cost > 0 AND (
            (owner_user_id IS NOT NULL AND owner_user_id != ?)
            OR (owner_user_id IS NULL AND user_id != ? COLLATE NOCASE)
          ) THEN 1 ELSE 0 END), 0)`
      : '0';
    const rows = await this.db.query<CostReportRow>(
      `WITH ${
        workloadDriven
          ? `owned_workloads AS NOT MATERIALIZED (
           ${ownerBranches
             .map(
               (branch) => `SELECT d.* FROM workloads d${attributionIndex}
           WHERE ${branch.sql}${attributionWhere}`,
             )
             .join('\n           UNION ALL\n           ')}
         ),
         overlapping_vms AS NOT MATERIALIZED (
           ${overlappingVms('owned_workloads d JOIN vms AS v ON v.workload_id = d.id')}
         ),`
          : `overlapping_vms AS NOT MATERIALIZED (
           ${overlappingVms()}
         ),`
      }
       workload_costs AS MATERIALIZED (
         SELECT d.id,
                d.workload_type,
                ${computedWorkloadCloudProviderSql('d')} AS cloud_provider,
                d.agent,
                d.user_id,
                d.owner_user_id,
                d.spot,
                ${durationMs} AS duration_ms,
                ${totalCost} AS total_cost
         FROM overlapping_vms v
         CROSS JOIN workloads d
         WHERE d.id = v.workload_id${ownership}
         GROUP BY d.id
       )
       SELECT 'total' AS dimension,
              NULL AS key,
              COALESCE(SUM(CASE WHEN total_cost > 0 THEN total_cost ELSE 0 END), 0) AS total_cost,
              COALESCE(SUM(CASE WHEN total_cost > 0 THEN duration_ms ELSE 0 END), 0) AS duration_ms,
              COALESCE(SUM(CASE WHEN total_cost > 0 AND workload_type = 'job' THEN 1 ELSE 0 END), 0) AS jobs,
              COALESCE(SUM(CASE WHEN total_cost > 0 AND workload_type = 'service' THEN 1 ELSE 0 END), 0) AS services,
              COALESCE(SUM(CASE WHEN total_cost > 0 AND workload_type = 'vm' THEN 1 ELSE 0 END), 0) AS vms,
              COALESCE(SUM(CASE WHEN COALESCE(total_cost, 0) = 0 AND duration_ms > 0 THEN 1 ELSE 0 END), 0) AS workloads_without_price,
              0 AS has_spot,
              ${includesOtherUsersSql} AS includes_other_users
       FROM workload_costs
       UNION ALL
       SELECT 'provider' AS dimension,
              COALESCE(cloud_provider, 'Unknown') AS key,
              SUM(total_cost) AS total_cost,
              SUM(duration_ms) AS duration_ms,
              SUM(CASE WHEN workload_type = 'job' THEN 1 ELSE 0 END) AS jobs,
              SUM(CASE WHEN workload_type = 'service' THEN 1 ELSE 0 END) AS services,
              SUM(CASE WHEN workload_type = 'vm' THEN 1 ELSE 0 END) AS vms,
              0 AS workloads_without_price,
              MAX(CASE WHEN spot = 1 THEN 1 ELSE 0 END) AS has_spot,
              0 AS includes_other_users
       FROM workload_costs
       WHERE total_cost > 0
       GROUP BY COALESCE(cloud_provider, 'Unknown')
       UNION ALL
       SELECT 'agent' AS dimension,
              agent AS key,
              SUM(total_cost) AS total_cost,
              SUM(duration_ms) AS duration_ms,
              SUM(CASE WHEN workload_type = 'job' THEN 1 ELSE 0 END) AS jobs,
              SUM(CASE WHEN workload_type = 'service' THEN 1 ELSE 0 END) AS services,
              SUM(CASE WHEN workload_type = 'vm' THEN 1 ELSE 0 END) AS vms,
              0 AS workloads_without_price,
              0 AS has_spot,
              0 AS includes_other_users
       FROM workload_costs
       WHERE total_cost > 0 AND agent IS NOT NULL AND agent != ''
       GROUP BY agent
       UNION ALL
       SELECT 'user' AS dimension,
              user_id AS key,
              SUM(total_cost) AS total_cost,
              SUM(duration_ms) AS duration_ms,
              SUM(CASE WHEN workload_type = 'job' THEN 1 ELSE 0 END) AS jobs,
              SUM(CASE WHEN workload_type = 'service' THEN 1 ELSE 0 END) AS services,
              SUM(CASE WHEN workload_type = 'vm' THEN 1 ELSE 0 END) AS vms,
              0 AS workloads_without_price,
              0 AS has_spot,
              0 AS includes_other_users
       FROM workload_costs
       WHERE total_cost > 0 AND user_id IS NOT NULL AND user_id != ''
       GROUP BY user_id`,
      [
        ...(workloadDriven
          ? ownerBranches.flatMap((branch) => [...branch.params, ...params])
          : [...owner.params, ...params]),
        ...(viewer ? [viewer.id, viewer.username] : []),
      ],
    );
    return toCostReport(rows, windowEndMs - windowStartMs);
  }

  /** Exact, scope-bounded all-time workload cost lookup. */
  async listWorkloadCostsForId(
    scope: OwnershipScope,
    workloadId: string,
    filter?: WorkloadAttributionFilter,
  ): Promise<CostRow[]> {
    const nowMs = Date.now();
    const { clauses, params } = workloadAttributionFiltersSql('d', filter);
    const owner = ownershipPredicate(scope, 'd');
    const rows = await this.db.query<CostWorkloadRow>(
      `SELECT ${costWorkloadColumnsSql(nowMs)}
       FROM workloads d
       LEFT JOIN container_specs s ON s.workload_id = d.id
       LEFT JOIN vms v ON d.id = v.workload_id
       WHERE ${owner.sql} AND d.id = ?${clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''}
       GROUP BY d.id`,
      [...owner.params, workloadId, ...params],
    );
    return rows.map(toCostRow);
  }

  /**
   * Count original submissions and explicit resubmissions inside
   * [startMs, endMs), split by workload type. `submitted_at` is immutable,
   * while resubmissions come from their append-only events so repeated
   * attempts are counted independently.
   */
  async summarizeWorkloadStartsInWindow(
    startMs: number,
    endMs: number,
  ): Promise<{
    jobs: WorkloadTypeStarts;
    services: WorkloadTypeStarts;
    vms: WorkloadTypeStarts;
    users: UserWorkloadStarts[];
  }> {
    const rows = await this.db.query<{
      user_id: string;
      owner_user_id: string | null;
      workload_type: WorkloadTypeValue;
      initial_submissions: number;
      resubmissions: number;
    }>(
      `WITH activity AS (
         SELECT user_id, owner_user_id, workload_type,
                1 AS initial_submissions, 0 AS resubmissions
         FROM workloads
         WHERE submitted_at >= ? AND submitted_at < ?
         UNION ALL
         SELECT d.user_id, d.owner_user_id, d.workload_type,
                0 AS initial_submissions, 1 AS resubmissions
         FROM workload_events e
         JOIN workloads d ON d.id = e.workload_id
         WHERE json_valid(e.metadata)
           AND json_extract(e.metadata, '$.reason') = 'resubmitted'
           AND e.created_at >= ? AND e.created_at < ?
       )
       SELECT MIN(user_id) AS user_id, owner_user_id, workload_type,
              SUM(initial_submissions) AS initial_submissions,
              SUM(resubmissions) AS resubmissions
       FROM activity
       GROUP BY owner_user_id,
                CASE WHEN owner_user_id IS NULL THEN LOWER(user_id) END,
                workload_type
       ORDER BY user_id, owner_user_id`,
      [startMs, endMs, startMs, endMs],
    );
    const emptyStarts = (): WorkloadTypeStarts => ({
      initialSubmissions: 0,
      resubmissions: 0,
    });
    const jobs = emptyStarts();
    const services = emptyStarts();
    const vms = emptyStarts();
    const buckets = { jobs, services, vms };
    const users = new Map<string, UserWorkloadStarts>();
    for (const row of rows) {
      const bucket = buckets[workloadTypeBucket(row.workload_type)];
      bucket.initialSubmissions += row.initial_submissions;
      bucket.resubmissions += row.resubmissions;
      const userKey = digestUserKey(row.owner_user_id, row.user_id);
      let user = users.get(userKey);
      if (!user) {
        user = {
          userId: row.user_id,
          ownerUserId: row.owner_user_id,
          jobs: emptyStarts(),
          services: emptyStarts(),
          vms: emptyStarts(),
        };
        users.set(userKey, user);
      }
      const userBuckets = {
        jobs: user.jobs,
        services: user.services,
        vms: user.vms,
      };
      const userBucket = userBuckets[workloadTypeBucket(row.workload_type)];
      userBucket.initialSubmissions += row.initial_submissions;
      userBucket.resubmissions += row.resubmissions;
    }
    return {
      jobs,
      services,
      vms,
      users: [...users.values()].sort((a, b) =>
        a.userId.localeCompare(b.userId),
      ),
    };
  }

  /**
   * Host-global provisioned-VM activity and spend inside [startMs, endMs) for
   * the notifications digest, split by workload type. Unlike terminal
   * workload outcomes, this scans every VM that overlapped the window, so
   * long-running and later-finishing workloads contribute spend on the day
   * it was incurred.
   */
  async sumVmSpendInWindow(
    startMs: number,
    endMs: number,
  ): Promise<{
    jobs: WindowedVmSpend;
    services: WindowedVmSpend;
    vms: WindowedVmSpend;
    users: UserWindowedVmSpend[];
  }> {
    const { overlapsWindow, durationMs, totalCost, costSource } =
      windowedVmCostExprs({ startMs, endMs, nowMs: Date.now() });
    // An in-place restart opens another row on the same cloud VM; count VMs.
    const activeVmCount = `COUNT(DISTINCT CASE WHEN ${overlapsWindow} THEN v.cloud_id END)`;
    const unpricedVmCount = `COUNT(DISTINCT CASE
      WHEN ${overlapsWindow}
        AND v.price_per_hour IS NULL AND v.cost IS NULL THEN v.cloud_id
    END)`;
    const rows = await this.db.query<{
      running_cost: number | null;
      cost_source: 'actual' | 'estimated';
      active_vm_count: number | null;
      unpriced_vm_count: number | null;
      duration_ms: number | null;
      user_id: string;
      owner_user_id: string | null;
      workload_type: WorkloadTypeValue;
    }>(
      `SELECT MIN(d.user_id) AS user_id, d.owner_user_id, d.workload_type,
              ${totalCost} as running_cost,
              ${costSource} as cost_source,
              ${activeVmCount} as active_vm_count,
              ${unpricedVmCount} as unpriced_vm_count,
              ${durationMs} as duration_ms
       FROM vms v
       JOIN workloads d ON d.id = v.workload_id
       WHERE v.ip IS NOT NULL
         AND v.created_at < ${endMs}
         AND (v.ended_at IS NULL OR v.ended_at > ${startMs})
       GROUP BY d.owner_user_id,
                CASE WHEN d.owner_user_id IS NULL THEN LOWER(d.user_id) END,
                d.workload_type
       ORDER BY user_id, d.owner_user_id`,
    );
    const emptySpend = (): WindowedVmSpend => ({
      runningCost: 0,
      costSource: 'actual',
      activeVmCount: 0,
      unpricedVmCount: 0,
      durationMs: 0,
    });
    const jobs = emptySpend();
    const services = emptySpend();
    const vms = emptySpend();
    const buckets = { jobs, services, vms };
    const users = new Map<string, UserWindowedVmSpend>();
    for (const row of rows) {
      const bucket = buckets[workloadTypeBucket(row.workload_type)];
      bucket.runningCost += row.running_cost ?? 0;
      if (row.cost_source === 'estimated') bucket.costSource = 'estimated';
      bucket.activeVmCount += row.active_vm_count ?? 0;
      bucket.unpricedVmCount += row.unpriced_vm_count ?? 0;
      bucket.durationMs += row.duration_ms ?? 0;
      const userKey = digestUserKey(row.owner_user_id, row.user_id);
      let user = users.get(userKey);
      if (!user) {
        user = {
          userId: row.user_id,
          ownerUserId: row.owner_user_id,
          jobs: emptySpend(),
          services: emptySpend(),
          vms: emptySpend(),
        };
        users.set(userKey, user);
      }
      const userBuckets = {
        jobs: user.jobs,
        services: user.services,
        vms: user.vms,
      };
      const userBucket = userBuckets[workloadTypeBucket(row.workload_type)];
      userBucket.runningCost += row.running_cost ?? 0;
      if (row.cost_source === 'estimated') {
        userBucket.costSource = 'estimated';
      }
      userBucket.activeVmCount += row.active_vm_count ?? 0;
      userBucket.unpricedVmCount += row.unpriced_vm_count ?? 0;
      userBucket.durationMs += row.duration_ms ?? 0;
    }
    return {
      jobs,
      services,
      vms,
      users: [...users.values()].sort((a, b) =>
        a.userId.localeCompare(b.userId),
      ),
    };
  }
}
