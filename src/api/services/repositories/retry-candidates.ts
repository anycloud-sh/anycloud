import { WorkloadState } from '../../../shared/workload.js';
import type { WorkloadEventState } from '../workload-record.js';

/**
 * Read-only retry facts for a bounded set of Workloads, shared by the
 * reconciler (through the lifecycle writer) and status reads.
 */

// Retry facts hydrated for a bounded set of reconciler candidates.
export interface RetryCandidate {
  id: string;
  state: WorkloadState;
  retryCount: number;
  lastRetryAt: number;
  failedAtState: WorkloadEventState | null;
  resubmitCount: number;
  /**
   * 1 when the latest retry goes elsewhere at once: its region was denied to
   * the credential, or it failed over while a target was still untried.
   */
  regionDenied: 0 | 1;
  /** Such immediate retries; they do not grow the backoff. */
  deniedRetryCount: number;
}

/**
 * A launch that failed over, recorded against its attempt, after a claim that
 * saw an untried target: the next claim picks one, so waiting gains nothing.
 */
const failoverToUntried = (e: string) =>
  `(COALESCE(json_extract(${e}.metadata, '$.launchFailover'), 0) = 1
    AND COALESCE((SELECT json_extract(p.metadata, '$.untriedTargets')
                  FROM workload_events p INDEXED BY idx_events_workload_id
                  WHERE p.workload_id = ${e}.workload_id AND p.id < ${e}.id
                    AND p.state = '${WorkloadState.Provisioning}' AND json_valid(p.metadata)
                    AND json_type(p.metadata, '$.untriedTargets') IS NOT NULL
                  ORDER BY p.id DESC LIMIT 1), 0) > 0)`;

export function retryCandidatesQuery(ids: readonly string[]): {
  sql: string;
  params: unknown[];
} {
  const placeholders = ids.map(() => '?').join(', ');
  return {
    sql: `WITH retry_candidates AS (
         SELECT d.id,
                d.state,
                COUNT(e.id)      AS retryCount,
                SUM(CASE
                      WHEN json_valid(e.metadata)
                      THEN json_type(e.metadata, '$.targetRegionDenied') IS NOT NULL
                           OR ${failoverToUntried('e')}
                      ELSE 0
                    END)         AS deniedRetryCount,
                MAX(e.created_at) AS lastRetryAt,
                MAX(e.id)        AS maxRetryId
         FROM workloads d
         CROSS JOIN workload_events e INDEXED BY idx_events_workload_id
         WHERE d.id IN (${placeholders})
           AND d.state IN (?, ?)
           AND e.workload_id = d.id
           AND e.state IN (?, ?)
           AND NOT (
             e.state = ?
             AND COALESCE(
               CASE
                 WHEN json_valid(e.metadata)
                 THEN json_extract(e.metadata, '$.inPlaceRestartSucceeded')
               END,
               0
             ) = 1
           )
         GROUP BY d.id
       )
       SELECT rc.id,
              rc.state,
              rc.retryCount,
              rc.deniedRetryCount,
              rc.lastRetryAt,
              (SELECT e.state
               FROM workload_events e INDEXED BY idx_events_workload_id
               WHERE e.workload_id = rc.id
                 AND e.id < rc.maxRetryId
               ORDER BY e.id DESC
               LIMIT 1) AS failedAtState,
              (SELECT COUNT(*)
               FROM workload_events e INDEXED BY idx_events_resubmit
               WHERE e.workload_id = rc.id
                 AND json_valid(e.metadata)
                 AND json_extract(e.metadata, '$.reason') = 'resubmitted') AS resubmitCount,
              (SELECT CASE
                        WHEN json_valid(e.metadata)
                        THEN json_type(e.metadata, '$.targetRegionDenied') IS NOT NULL
                             OR ${failoverToUntried('e')}
                        ELSE 0
                      END
               FROM workload_events e
               WHERE e.id = rc.maxRetryId) AS regionDenied
       FROM retry_candidates rc`,
    params: [
      ...ids,
      WorkloadState.Retrying,
      WorkloadState.Recovering,
      WorkloadState.Retrying,
      WorkloadState.Recovering,
      WorkloadState.Recovering,
    ],
  };
}
