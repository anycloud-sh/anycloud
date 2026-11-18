/**
 * Workload attempts (RFC 0044 decision 24): one row per try of a Job, the
 * Job's one retry budget (O15), and `recordAttemptOutcome`, the one fenced
 * writer that closes an attempt and applies its Workload's transition, with
 * `recordAttemptPhase` for a runner's steps before that. Each
 * substrate keeps its own facts in an extension table this module never
 * touches.
 */

import type { DB, DBTransaction } from './db.js';
import type { JobChanges } from '../job-changes.js';
import {
  UNUSABLE_GPU_POOL_RERUN,
  UNUSABLE_GPU_POOL_RETRY,
  type Cause,
  type Outcome,
} from '../job-outcome.js';
import { FAILED_DEPLOY_MAX_ATTEMPTS } from '../../config.js';
import {
  LIVE_EXECUTION_STATES,
  WorkloadState,
  endReasonOfState,
  isTerminalState,
  type EndReason,
} from '../../../shared/workload.js';
import { redactValue } from '../redact.js';
import { eventMetadataColumn } from '../workload-event-metadata.js';
import {
  commitWorkloadChanges,
  POOL_MANAGED_CHECKPOINT_SQL,
} from './workload-lifecycle.js';

/**
 * How an attempt ended. `Terminated` acknowledges that the instance stopped
 * after its Job ended: it settles cleanup and changes no outcome.
 */
export interface AttemptEnd {
  state: Outcome['state'] | WorkloadState.Terminated;
  /** The retry reason or the outcome's message. */
  reason?: string;
  /** The substrate's classification; absent when the program reported. */
  cause?: Cause;
  /**
   * A Retrying end's own budget: once more than `max` attempts since the
   * Job was submitted retried with this reason, the Job ends `ends`
   * (default Failed) with `failed`.
   */
  retryCap?: { max: number; failed: string; ends?: WorkloadState.Errored };
}

/**
 * Open the Workload's next attempt in the caller's transaction and return
 * its ID. It opens no occupancy and no extension row; the substrate adds its
 * own, so a Slurm attempt opens the same way.
 */
export function openAttempt(
  tx: DBTransaction,
  input: {
    workloadId: string;
    executionId: string;
    generation: number | null;
    substrate: 'pod' | 'slurm';
    now: number;
  },
): number {
  const [opened] = tx.query<{ id: number }>(
    `INSERT INTO workload_attempts
       (workload_id, attempt, execution_id, generation, substrate, opened_at)
     SELECT ?, COALESCE(MAX(attempt), 0) + 1, ?, ?, ?, ?
     FROM workload_attempts WHERE workload_id = ?
     RETURNING id`,
    [
      input.workloadId,
      input.executionId,
      input.generation,
      input.substrate,
      input.now,
      input.workloadId,
    ],
  );
  // INSERT … SELECT over an aggregate always returns its one row.
  return opened.id;
}

/**
 * Attempts since the Job was last submitted that retried and match `where`,
 * or all of them: a resubmit renews the budget.
 */
function attemptsUsed(
  tx: DBTransaction,
  workloadId: string,
  where?: string,
  ...params: unknown[]
): number {
  const retried = where === undefined ? '' : ` AND a.outcome = ? AND ${where}`;
  return (
    tx.query<{ used: number }>(
      `SELECT COUNT(*) AS used FROM workload_attempts a
       JOIN workloads w ON w.id = a.workload_id
       WHERE a.workload_id = ? AND a.opened_at >= w.started_at${retried}`,
      where === undefined
        ? [workloadId]
        : [workloadId, WorkloadState.Retrying, ...params],
    )[0]?.used ?? 0
  );
}

/** What a substrate's classification says ended an attempt. */
const CAUSE_END_REASON: Record<Cause['kind'], EndReason> = {
  exit: 'exited',
  disrupted: 'reclaimed',
  'evicted-storage': 'invalid',
  deadline: 'timeout',
  unrecoverable: 'invalid',
  transfer: 'lost',
  lost: 'lost',
};

function closeAttempt(
  tx: DBTransaction,
  attemptId: number,
  end: AttemptEnd,
  reason: string | null,
  now: number,
): void {
  const { cause } = end;
  tx.query(
    `UPDATE workload_attempts
     SET outcome = ?, cause = ?, exit_code = ?, reason = ?, ended_at = ?
     WHERE id = ? AND ended_at IS NULL`,
    [
      end.state,
      cause?.kind ?? null,
      cause?.kind === 'exit' ? cause.code : null,
      reason,
      now,
      attemptId,
    ],
  );
}

/**
 * Record how one attempt ended. Only this attempt's execution may move its
 * Workload, and only from a live state (syncing, running or finalizing); a Retrying end at the budget becomes
 * Failed. After an operator's termination won, the end closes the attempt
 * and settles cleanup without replacing the outcome. A replay of the
 * recorded end returns true; any other stale end returns false.
 */
export async function recordAttemptOutcome(
  db: DB,
  jobChanges: JobChanges,
  workloadId: string,
  executionId: string,
  end: AttemptEnd,
): Promise<boolean> {
  const now = Date.now();
  const reason = redactValue(end.reason ?? null) as string | null;
  return commitWorkloadChanges(db, jobChanges, (tx, changed) => {
    const row = tx.query<{
      id: number;
      outcome: string | null;
      reason: string | null;
      state: WorkloadState;
      cleanedAt: number | null;
      current: number;
      maxRetries: number | null;
    }>(
      `SELECT a.id, a.outcome, a.reason, w.state, w.cleaned_at AS cleanedAt,
              w.max_retries AS maxRetries,
              w.current_execution_id IS a.execution_id AS current
       FROM workload_attempts a JOIN workloads w ON w.id = a.workload_id
       WHERE a.workload_id = ? AND a.execution_id = ?`,
      [workloadId, executionId],
    )[0];
    if (!row) return false;
    const replay = row.outcome === end.state && row.reason === reason;
    if (row.current !== 1) return replay;

    if (
      row.state === WorkloadState.Terminated ||
      (end.state === WorkloadState.Terminated && isTerminalState(row.state))
    ) {
      closeAttempt(tx, row.id, end, reason, now);
      if (row.cleanedAt === null) {
        tx.query(
          `UPDATE workloads
           SET cleaned_at = CASE WHEN ${POOL_MANAGED_CHECKPOINT_SQL}
             THEN NULL ELSE MAX(?, completed_at) END
           WHERE id = ?`,
          [now, workloadId],
        );
        changed(workloadId);
      }
      return true;
    }
    if (
      !LIVE_EXECUTION_STATES.includes(row.state) ||
      end.state === WorkloadState.Terminated
    ) {
      return replay;
    }

    closeAttempt(tx, row.id, end, reason, now);
    const retrying = end.state === WorkloadState.Retrying;
    const used = retrying ? attemptsUsed(tx, workloadId) : 0;
    const capped =
      retrying &&
      end.retryCap !== undefined &&
      attemptsUsed(tx, workloadId, 'a.reason = ?', reason) > end.retryCap.max;
    const exhausted = capped || used >= FAILED_DEPLOY_MAX_ATTEMPTS;
    // The Job's own `maxRetries` (RFC 0049 C3) counts retries after a
    // disruption or a runner exit (a `disrupted`, `lost` or `exit` cause):
    // never a handler's retry, another cause, or a GPU rerun with its own cap. It ends the Job with what ended
    // this attempt, not as a spent system budget.
    const stopped =
      !exhausted &&
      retrying &&
      row.maxRetries !== null &&
      attemptsUsed(
        tx,
        workloadId,
        "a.cause IN ('disrupted', 'lost', 'exit') AND a.reason NOT IN (?, ?)",
        UNUSABLE_GPU_POOL_RETRY,
        UNUSABLE_GPU_POOL_RERUN,
      ) > row.maxRetries;
    const state = exhausted
      ? (capped && end.retryCap!.ends) || WorkloadState.Failed
      : stopped
        ? WorkloadState.Failed
        : end.state;
    const terminal = state !== WorkloadState.Retrying;
    const attemptEnd = end.cause ? CAUSE_END_REASON[end.cause.kind] : null;
    const endReason: EndReason | null = !terminal
      ? null
      : exhausted
        ? 'retries-exhausted'
        : stopped
          ? attemptEnd
          : state === end.state && attemptEnd
            ? attemptEnd
            : endReasonOfState(state);
    tx.query(
      `UPDATE workloads
       SET state = ?, end_reason = ?, last_attempt_end_reason = ?,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
           cleaned_at = CASE WHEN ? = 1 AND NOT ${POOL_MANAGED_CHECKPOINT_SQL}
             THEN ? ELSE cleaned_at END
       WHERE id = ? AND state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')})
         AND current_execution_id = ?`,
      [
        state,
        endReason,
        exhausted ? attemptEnd : stopped ? endReason : null,
        terminal ? 1 : 0,
        now,
        terminal ? 1 : 0,
        now,
        workloadId,
        ...LIVE_EXECUTION_STATES,
        executionId,
      ],
    );
    tx.query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, ?, ?)`,
      [
        workloadId,
        state,
        eventMetadataColumn(
          state === WorkloadState.Failed && exhausted
            ? {
                executionId,
                reason: capped
                  ? end.retryCap!.failed
                  : 'retry attempts exhausted',
              }
            : stopped
              ? {
                  executionId,
                  reason: `max retries (${row.maxRetries}) reached: ${end.reason}`,
                }
              : state === WorkloadState.Retrying
                ? { executionId, reason: end.reason }
                : {
                    executionId,
                    message: capped ? end.retryCap!.failed : end.reason,
                  },
        ),
        now,
      ],
    );
    changed(workloadId);
    return true;
  });
}

/**
 * A runner's step through its execution: `syncing` → `running` →
 * `finalizing`. False when the execution moved on. A replay is true, and so
 * is a termination the runner hasn't seen yet: it still uploads, then
 * reports or cleans up.
 */
export async function recordAttemptPhase(
  db: DB,
  jobChanges: JobChanges,
  workloadId: string,
  executionId: string,
  phase: WorkloadState.Running | WorkloadState.Finalizing,
): Promise<boolean> {
  const from =
    phase === WorkloadState.Running
      ? WorkloadState.Syncing
      : WorkloadState.Running;
  return commitWorkloadChanges(db, jobChanges, (tx, changed) => {
    const updated = tx.query<{ rowsAffected: number }>(
      `UPDATE workloads SET state = ?
       WHERE id = ? AND current_execution_id = ? AND state = ?`,
      [phase, workloadId, executionId, from],
    );
    if (updated[0]?.rowsAffected !== 1) {
      return (
        tx.query(
          `SELECT 1 FROM workloads
           WHERE id = ? AND current_execution_id = ? AND cleaned_at IS NULL
             AND state IN (?, ?)`,
          [workloadId, executionId, phase, WorkloadState.Terminated],
        ).length === 1
      );
    }
    tx.query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, ?, ?)`,
      [workloadId, phase, eventMetadataColumn({ executionId }), Date.now()],
    );
    changed(workloadId);
    return true;
  });
}

/** An attempt's log tail, or the sentence saying why it couldn't be read. */
export interface AttemptLogTail {
  state: 'captured' | 'unavailable';
  text: string;
}

/**
 * Store an attempt's log tail, once: the substrate reads it before it lets
 * the instance go, and may write it before or after the close.
 */
export async function recordAttemptLogTail(
  db: DB,
  executionId: string,
  tail: AttemptLogTail,
): Promise<void> {
  await db.query(
    `UPDATE workload_attempts SET log_tail = ?, log_tail_state = ?
     WHERE execution_id = ? AND log_tail_state IS NULL`,
    [tail.text, tail.state, executionId],
  );
}
