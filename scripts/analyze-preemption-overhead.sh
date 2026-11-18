#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage: scripts/analyze-preemption-overhead.sh /path/to/api.db

Read-only analysis of preemption-caused repeated setup overhead.

The script does not write to the database. It runs sqlite3 with -readonly and
sets PRAGMA query_only=ON before running SELECT-only CTEs.
USAGE
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

db_path=$1

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 127
fi

sqlite3 -readonly "$db_path" <<'SQL'
.bail on
.headers on
.mode column
PRAGMA query_only = ON;

WITH
preempted_jobs AS (
  SELECT DISTINCT workload_id
  FROM vms
  WHERE preempt = 1
),
ordered_events AS (
  SELECT
    e.id,
    e.workload_id,
    e.state,
    e.metadata,
    e.created_at,
    LEAD(e.created_at) OVER (
      PARTITION BY e.workload_id
      ORDER BY e.created_at, e.id
    ) AS next_at,
    LEAD(e.state) OVER (
      PARTITION BY e.workload_id
      ORDER BY e.created_at, e.id
    ) AS next_state,
    LEAD(e.metadata) OVER (
      PARTITION BY e.workload_id
      ORDER BY e.created_at, e.id
    ) AS next_metadata
  FROM workload_events e
),
intervals AS (
  SELECT *
  FROM ordered_events
  WHERE next_at IS NOT NULL
    AND next_at > created_at
),
recoveries AS (
  SELECT
    r.id,
    r.workload_id,
    r.created_at AS start_at,
    (
      SELECT MIN(e2.created_at)
      FROM workload_events e2
      WHERE e2.workload_id = r.workload_id
        AND e2.state = 'running'
        AND e2.created_at > r.created_at
    ) AS end_at
  FROM workload_events r
  WHERE r.state = 'recovering'
    AND r.metadata LIKE '%preemption%'
),
recovery_windows AS (
  SELECT *
  FROM recoveries
  WHERE end_at IS NOT NULL
    AND end_at > start_at
),
setup_intervals AS (
  SELECT i.*
  FROM intervals i
  WHERE i.state IN (
      'initializing',
      'downloading',
      'syncing',
      'starting',
      'baking'
    )
    AND (
      (
        i.next_state = 'recovering'
        AND i.next_metadata LIKE '%preemption%'
      )
      OR EXISTS (
        SELECT 1
        FROM recovery_windows rw
        WHERE rw.workload_id = i.workload_id
          AND rw.start_at < i.next_at
          AND rw.end_at > i.created_at
      )
    )
),
ended_vms AS (
  SELECT
    *,
    1.0 * (ended_at - created_at) AS vm_ms,
    (ended_at - created_at) / 3600000.0 AS runtime_h,
    CASE
      WHEN cost IS NOT NULL THEN cost
      WHEN ip IS NOT NULL
        AND price_per_hour IS NOT NULL
        THEN price_per_hour * (ended_at - created_at) / 3600000.0
      ELSE 0
    END AS estimated_cost
  FROM vms
  WHERE ended_at IS NOT NULL
),
overlaps AS (
  SELECT
    s.id AS interval_id,
    s.workload_id,
    s.state,
    v.cloud_id,
    v.ip,
    v.cost,
    v.price_per_hour,
    v.estimated_cost,
    v.vm_ms,
    CASE
      WHEN MIN(s.next_at, v.ended_at) > MAX(s.created_at, v.created_at)
        THEN 1.0 * (
          MIN(s.next_at, v.ended_at) - MAX(s.created_at, v.created_at)
        )
      ELSE 0.0
    END AS overlap_ms
  FROM setup_intervals s
  JOIN ended_vms v
    ON v.workload_id = s.workload_id
   AND v.created_at < s.next_at
   AND v.ended_at > s.created_at
),
base AS (
  SELECT
    COUNT(*) AS ended_rows,
    COUNT(*) FILTER (WHERE ip IS NOT NULL) AS ip_rows,
    COUNT(*) FILTER (WHERE cost IS NOT NULL) AS cost_rows,
    COUNT(*) FILTER (WHERE price_per_hour IS NOT NULL) AS price_rows,
    COUNT(*) FILTER (
      WHERE cost IS NOT NULL
         OR (ip IS NOT NULL AND price_per_hour IS NOT NULL)
    ) AS estimated_rows,
    SUM(runtime_h) AS all_runtime_h,
    SUM(CASE WHEN ip IS NOT NULL THEN runtime_h ELSE 0 END) AS ip_runtime_h,
    SUM(CASE WHEN cost IS NOT NULL THEN cost ELSE 0 END) AS recorded_cost,
    SUM(estimated_cost) AS estimated_cost
  FROM ended_vms
),
by_state AS (
  SELECT
    state,
    SUM(overlap_ms) / 3600000.0 AS all_overhead_h,
    SUM(CASE WHEN ip IS NOT NULL THEN overlap_ms ELSE 0 END) / 3600000.0
      AS ip_overhead_h,
    SUM(
      CASE
        WHEN cost IS NOT NULL AND vm_ms > 0 THEN cost * overlap_ms / vm_ms
        ELSE 0
      END
    ) AS recorded_cost_overhead,
    SUM(
      CASE
        WHEN vm_ms > 0 THEN estimated_cost * overlap_ms / vm_ms
        ELSE 0
      END
    ) AS estimated_cost_overhead
  FROM overlaps
  WHERE overlap_ms > 0
  GROUP BY state
),
overhead AS (
  SELECT
    SUM(all_overhead_h) AS all_overhead_h,
    SUM(ip_overhead_h) AS ip_overhead_h,
    SUM(recorded_cost_overhead) AS recorded_cost_overhead,
    SUM(estimated_cost_overhead) AS estimated_cost_overhead
  FROM by_state
),
per_interval AS (
  SELECT
    interval_id,
    workload_id,
    SUM(CASE WHEN ip IS NOT NULL THEN overlap_ms ELSE 0 END) AS ip_ms,
    SUM(overlap_ms) AS all_ms
  FROM overlaps
  WHERE overlap_ms > 0
  GROUP BY interval_id, workload_id
),
per_preempted_job AS (
  SELECT
    p.workload_id,
    COALESCE(SUM(pi.ip_ms), 0) / 60000.0 AS ip_vm_minutes,
    COALESCE(SUM(pi.all_ms), 0) / 60000.0 AS all_vm_minutes
  FROM preempted_jobs p
  LEFT JOIN per_interval pi
    ON pi.workload_id = p.workload_id
  GROUP BY p.workload_id
),
ranked_ip_nonzero AS (
  SELECT
    ip_vm_minutes,
    ROW_NUMBER() OVER (ORDER BY ip_vm_minutes) AS rn,
    COUNT(*) OVER () AS n
  FROM per_preempted_job
  WHERE ip_vm_minutes > 0
),
ranked_all_nonzero AS (
  SELECT
    all_vm_minutes,
    ROW_NUMBER() OVER (ORDER BY all_vm_minutes) AS rn,
    COUNT(*) OVER () AS n
  FROM per_preempted_job
  WHERE all_vm_minutes > 0
),
per_job_stats AS (
  SELECT
    COUNT(*) AS preempted_jobs,
    COUNT(*) FILTER (WHERE ip_vm_minutes = 0) AS ip_zero_jobs,
    COUNT(*) FILTER (WHERE ip_vm_minutes > 0) AS ip_nonzero_jobs,
    COUNT(*) FILTER (WHERE all_vm_minutes = 0) AS all_zero_jobs,
    COUNT(*) FILTER (WHERE all_vm_minutes > 0) AS all_nonzero_jobs,
    AVG(ip_vm_minutes) AS avg_ip_minutes,
    AVG(all_vm_minutes) AS avg_all_minutes,
    (
      SELECT AVG(ip_vm_minutes)
      FROM ranked_ip_nonzero
      WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
    ) AS median_ip_nonzero_minutes,
    (
      SELECT AVG(all_vm_minutes)
      FROM ranked_all_nonzero
      WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
    ) AS median_all_nonzero_minutes
  FROM per_preempted_job
),
metrics AS (
  SELECT 10 AS sort, 'coverage' AS section, 'ended VM rows' AS metric,
         printf('%.0f', ended_rows) AS value
  FROM base
  UNION ALL
  SELECT 11, 'coverage', 'rows in product duration estimate',
         printf('%.0f (%.1f%%)', ip_rows, 100.0 * ip_rows / ended_rows)
  FROM base
  UNION ALL
  SELECT 12, 'coverage', 'rows with recorded provider cost',
         printf('%.0f (%.1f%%)', cost_rows, 100.0 * cost_rows / ended_rows)
  FROM base
  UNION ALL
  SELECT 13, 'coverage', 'rows with catalog price',
         printf('%.0f (%.1f%%)', price_rows, 100.0 * price_rows / ended_rows)
  FROM base
  UNION ALL
  SELECT 14, 'coverage', 'rows with cost or estimable price',
         printf('%.0f (%.1f%%)', estimated_rows, 100.0 * estimated_rows / ended_rows)
  FROM base
  UNION ALL
  SELECT 20, 'cost', 'AnyCloud estimated compute cost',
         printf('$%.2f', estimated_cost)
  FROM base
  UNION ALL
  SELECT 21, 'cost', 'AnyCloud estimated compute cost overhead',
         printf('$%.2f (%.4f%%)', estimated_cost_overhead, 100.0 * estimated_cost_overhead / estimated_cost)
  FROM base, overhead
  UNION ALL
  SELECT 22, 'cost', 'recorded provider cost',
         printf('$%.2f', recorded_cost)
  FROM base
  UNION ALL
  SELECT 23, 'cost', 'recorded provider cost overhead',
         printf('$%.2f (%.4f%%)', recorded_cost_overhead, 100.0 * recorded_cost_overhead / recorded_cost)
  FROM base, overhead
  UNION ALL
  SELECT 30, 'per preempted job', 'preempted jobs',
         printf('%.0f', preempted_jobs)
  FROM per_job_stats
  UNION ALL
  SELECT 31, 'per preempted job', 'no billable-candidate repeated setup',
         printf('%.0f (%.1f%%)', ip_zero_jobs, 100.0 * ip_zero_jobs / preempted_jobs)
  FROM per_job_stats
  UNION ALL
  SELECT 32, 'per preempted job', 'median billable-candidate setup where nonzero',
         printf('%.1f minutes', median_ip_nonzero_minutes)
  FROM per_job_stats
  UNION ALL
  SELECT 33, 'per preempted job', 'average billable-candidate setup across preempted jobs',
         printf('%.1f minutes', avg_ip_minutes)
  FROM per_job_stats
  UNION ALL
  SELECT 34, 'per preempted job', 'placeholder-inclusive median where nonzero',
         printf('%.1f minutes', median_all_nonzero_minutes)
  FROM per_job_stats
  UNION ALL
  SELECT 40 + ROW_NUMBER() OVER (ORDER BY state), 'state cost',
         state || ' / estimated overhead',
         printf('$%.2f', estimated_cost_overhead)
  FROM by_state
  UNION ALL
  SELECT 50, 'runtime diagnostics', 'all ended row runtime',
         printf('%.1f VM-hours', all_runtime_h)
  FROM base
  UNION ALL
  SELECT 51, 'runtime diagnostics', 'billable-candidate runtime',
         printf('%.1f VM-hours', ip_runtime_h)
  FROM base
  UNION ALL
  SELECT 52, 'runtime diagnostics', 'all-row repeated setup overhead',
         printf('%.1f VM-hours (%.4f%%)', all_overhead_h, 100.0 * all_overhead_h / all_runtime_h)
  FROM base, overhead
  UNION ALL
  SELECT 53, 'runtime diagnostics', 'billable-candidate repeated setup overhead',
         printf('%.1f VM-hours (%.4f%%)', ip_overhead_h, 100.0 * ip_overhead_h / ip_runtime_h)
  FROM base, overhead
  UNION ALL
  SELECT 60 + ROW_NUMBER() OVER (ORDER BY state), 'state runtime diagnostics',
         state || ' / billable-candidate overhead',
         printf('%.1f VM-hours', ip_overhead_h)
  FROM by_state
)
SELECT section, metric, value
FROM metrics
ORDER BY sort, section, metric;
SQL
