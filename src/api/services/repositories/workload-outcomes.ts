/** Terminal outcomes, termination, resubmission, and cleanup facts over the shared Workload database. */
import {
  WorkloadState,
  WorkloadType,
  VALID_TRANSITIONS,
  RESUBMITTABLE_STATES,
  TERMINAL_STATES,
  endReasonOfState,
  isTerminalState,
  type EndReason,
  type WorkloadTypeValue,
} from '../../../shared/workload.js';
import { log } from '../logger.js';
import { redactSecrets } from '../redact.js';
import {
  eventMetadataColumn,
  type WorkloadEventMetadataInput,
} from '../workload-event-metadata.js';
import type { JobChanges } from '../job-changes.js';
import {
  commitWorkloadChanges,
  hasError,
  POOL_MANAGED_CHECKPOINT_SQL,
} from './workload-lifecycle.js';
import { ownershipPredicate, type OwnershipScope } from './ownership-filter.js';
import type { DB } from './db.js';

export interface SubmissionReceipt {
  submissionRevision: number;
  claimDeadlineAt: number | null;
}

/**
 * The definition of outstanding cleanup: a durable terminal outcome whose
 * provider teardown has not been confirmed. Discovery, the completion write,
 * and the resubmission gate must agree on it, so they all read it from here.
 * Binds one parameter per terminal state. Pass the enclosing query's alias, or
 * omit it when the statement targets `workloads` directly.
 */
export function cleanupNeededSql(alias?: string): string {
  const col = alias ? `${alias}.` : '';
  const terminal = TERMINAL_STATES.map(() => '?').join(', ');
  return `${col}state IN (${terminal}) AND ${col}completed_at IS NOT NULL AND ${col}cleaned_at IS NULL`;
}

const CLEANUP_ERROR_MAX_CHARS = 500;

/** One line, secrets out, bounded: what `anycloud status` may show. */
function boundCleanupError(reason: string): string {
  const line = redactSecrets(reason).replace(/\s+/g, ' ').trim();
  return line.length > CLEANUP_ERROR_MAX_CHARS
    ? `${line.slice(0, CLEANUP_ERROR_MAX_CHARS - 1)}…`
    : line;
}

export class WorkloadOutcomeStore {
  constructor(
    private readonly db: DB,
    private readonly jobChanges: JobChanges,
  ) {}

  /**
   * Atomically publish one terminal outcome from the expected active state.
   * Optional durable predicates let specialized outcomes fence the exact
   * workload type and resources they observed without duplicating the
   * timestamp, event, and logging transaction.
   */
  async publishTerminalOutcome(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    options?: {
      metadata?: WorkloadEventMetadataInput;
      logMetadata?: object;
      workloadType?: WorkloadTypeValue;
      condition?: { sql: string; params: unknown[] };
      /** The runtime work was already released before this outcome. */
      cleanupComplete?: boolean;
      /** Defaults to what `targetState` implies. */
      endReason?: EndReason;
      /** With `retries-exhausted`: what ended the final attempt, if known. */
      lastAttemptEndReason?: EndReason;
    },
  ): Promise<boolean> {
    if (!isTerminalState(targetState)) {
      throw new Error(`Workload ${workloadId}: ${targetState} is not terminal`);
    }
    if (
      isTerminalState(expectedState) ||
      !VALID_TRANSITIONS[targetState].includes(expectedState)
    ) {
      return false;
    }

    const completedAt = Date.now();
    const workloadTypeClause = options?.workloadType
      ? ' AND workload_type = ?'
      : '';
    const conditionClause = options?.condition
      ? ` AND (${options.condition.sql})`
      : '';
    const outcome = await commitWorkloadChanges(
      this.db,
      this.jobChanges,
      (tx, changed) => {
        const updated = tx.query<{ rowsAffected: number }>(
          `UPDATE workloads
         SET state = ?, end_reason = ?, last_attempt_end_reason = ?,
             completed_at = ?, cleaned_at = ?
         WHERE id = ?
           AND state = ?${workloadTypeClause}${conditionClause}`,
          [
            targetState,
            options?.endReason ?? endReasonOfState(targetState),
            options?.lastAttemptEndReason ?? null,
            completedAt,
            options?.cleanupComplete ? completedAt : null,
            workloadId,
            expectedState,
            ...(options?.workloadType ? [options.workloadType] : []),
            ...(options?.condition?.params ?? []),
          ],
        );
        if (!updated[0]?.rowsAffected) return false;
        changed(workloadId);

        tx.query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, ?, ?)`,
          [
            workloadId,
            targetState,
            eventMetadataColumn(options?.metadata),
            completedAt,
          ],
        );
        return true;
      },
    );

    if (outcome) {
      const context = {
        id: workloadId,
        state: targetState,
        ...(options?.logMetadata ?? options?.metadata),
      };
      if (hasError(context)) {
        log.error(`State transition: ${targetState}`, context);
      } else {
        log.info(`State transition: ${targetState}`, context);
      }
    }
    return outcome;
  }

  /**
   * Atomically fail a Running persistent VM whose sole live host was confirmed
   * absent by its cloud provider. The exact workload type/state and VM
   * identity fence races with user termination or any replacement/duplicate
   * host.
   *
   * The ledger row deliberately stays live. A missing VM does not mean its
   * directly-attached resources (disk, NIC, public IP) are gone, and cleanup
   * derives both its delete set and its completion predicate from unended rows:
   * ending the row here would drop the host from prepareTermination's cloudIds
   * and let markCleanupComplete commit before those resources were released.
   * Terminal cleanup ends the row once the provider confirms the teardown.
   */
  async failMissingVmHost(
    workloadId: string,
    vm: { cloudId: string; ip: string },
    options: { reason: string },
  ): Promise<boolean> {
    return this.publishTerminalOutcome(
      workloadId,
      WorkloadState.Failed,
      WorkloadState.Running,
      {
        workloadType: WorkloadType.Vm,
        metadata: { cloudId: vm.cloudId, reason: options.reason },
        logMetadata: { cloudId: vm.cloudId, error: options.reason },
        condition: {
          sql: `1 = (
                  SELECT COUNT(*)
                  FROM vms
                  WHERE workload_id = ?
                    AND ended_at IS NULL
                )
                AND EXISTS (
                  SELECT 1
                  FROM vms
                  WHERE workload_id = ?
                    AND cloud_id = ?
                    AND ip = ?
                    AND ended_at IS NULL
                )`,
          params: [workloadId, workloadId, vm.cloudId, vm.ip],
        },
      },
    );
  }

  /**
   * Commit teardown completion once no provisioning attempt remains live.
   * The attempt count commits in the same UPDATE: pass `ensureAttemptCounted`
   * when the entry-time bump failed, so a cleaned workload can never record
   * zero cleanup passes (RFC 0031).
   */
  async markCleanupComplete(
    workloadId: string,
    options: { ensureAttemptCounted?: boolean } = {},
  ): Promise<boolean> {
    // Wall clocks can move backwards (or be mocked that way in tests). Cleanup
    // is causally after the outcome, so never persist an impossible ordering.
    const cleanedAt = Date.now();
    const updated = await this.db.query<{
      state: WorkloadState;
      cleanedAt: number;
      deploymentId: string | null;
    }>(
      `UPDATE workloads
       SET cleaned_at = MAX(?, completed_at),
           cleanup_error = NULL,
           cleanup_attempts = COALESCE(cleanup_attempts, 0) + ?
       WHERE id = ?
         AND ${cleanupNeededSql()}
         AND NOT EXISTS (
           SELECT 1
           FROM vms
           WHERE workload_id = workloads.id
             AND ended_at IS NULL
         )
       RETURNING state, cleaned_at AS cleanedAt, deployment_id AS deploymentId`,
      [
        cleanedAt,
        options.ensureAttemptCounted ? 1 : 0,
        workloadId,
        ...TERMINAL_STATES,
      ],
    );
    const result = updated[0];
    if (result) {
      this.jobChanges.notify(workloadId);
      if (result.deploymentId)
        this.jobChanges.notifyDeployment(result.deploymentId, { waiters: 1 });
      log.info('Workload resource cleanup completed', {
        id: workloadId,
        state: result.state,
        cleanedAt: result.cleanedAt,
      });
    }
    return result !== undefined;
  }

  /** Ended Workloads whose cleanup hasn't committed, with its last error. */
  async listCleanupNeeded(): Promise<
    Array<{ id: string; error: string | null }>
  > {
    return this.db.query<{ id: string; error: string | null }>(
      `SELECT id, cleanup_error AS error FROM workloads
       WHERE ${cleanupNeededSql()} ORDER BY id`,
      [...TERMINAL_STATES],
    );
  }

  /**
   * Count a cleanup pass at its entry. Best-effort: a failed write only
   * undercounts, and markCleanupComplete's ensureAttemptCounted backstop keeps
   * a cleaned workload from ever recording zero passes.
   */
  async recordCleanupAttempt(workloadId: string): Promise<boolean> {
    try {
      const updated = await this.db.query<{ rowsAffected: number }>(
        `UPDATE workloads
         SET cleanup_attempts = COALESCE(cleanup_attempts, 0) + 1
         WHERE id = ?
           AND ${cleanupNeededSql()}`,
        [workloadId, ...TERMINAL_STATES],
      );
      if (updated[0]?.rowsAffected) return true;
      log.warn('Cleanup pass not counted — workload not pending cleanup', {
        id: workloadId,
      });
    } catch (error) {
      log.warn('Failed to count cleanup pass', {
        id: workloadId,
        error: error,
      });
    }
    return false;
  }

  /**
   * Why cleanup is still pending: the last failed attempt's reason, kept only
   * while the workload is terminal and not yet cleaned (markCleanupComplete
   * clears it). Bounded and redacted before it reaches any status surface.
   */
  async recordCleanupError(workloadId: string, reason: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE workloads SET cleanup_error = ?
         WHERE id = ? AND ${cleanupNeededSql()}`,
        [boundCleanupError(reason), workloadId, ...TERMINAL_STATES],
      );
    } catch (error) {
      log.warn('Failed to record cleanup error', { id: workloadId, error });
    }
  }

  /**
   * Resubmit a workload that didn't succeed: reset state to Queued and clear
   * completedAt. Returns false if the workload isn't resubmittable — i.e. it's
   * still active, its previous resource cleanup is incomplete, or it's a
   * successful Completed run (re-run those with a fresh submit rather than
   * resetting the completed record in place).
   */
  async resubmitWorkload(
    workloadId: string,
    callerSession?: string | null,
  ): Promise<boolean> {
    return (await this.commitResubmission(workloadId, callerSession)) !== false;
  }

  async resubmitWorkloadForScope(
    workloadId: string,
    scope: OwnershipScope,
    callerSession?: string | null,
    options?: { claimDeadlineAt?: number | null },
  ): Promise<SubmissionReceipt | false> {
    return this.commitResubmission(workloadId, callerSession, scope, options);
  }

  private async commitResubmission(
    workloadId: string,
    callerSession?: string | null,
    scope?: OwnershipScope,
    options?: { claimDeadlineAt?: number | null },
  ): Promise<SubmissionReceipt | false> {
    const now = Date.now();
    const placeholders = RESUBMITTABLE_STATES.map(() => '?').join(', ');
    const owner = scope ? ownershipPredicate(scope) : undefined;

    const metadata: Record<string, string> = { reason: 'resubmitted' };
    if (callerSession) metadata.callerSession = callerSession;

    const resubmitted = await commitWorkloadChanges(
      this.db,
      this.jobChanges,
      (tx, changed) => {
        const result = tx.query<SubmissionReceipt>(
          `UPDATE workloads
         SET state = ?,
             started_at = ?,
             completed_at = NULL,
             end_reason = NULL,
             last_attempt_end_reason = NULL,
             cleaned_at = NULL,
             current_execution_id = NULL,
             submission_revision = submission_revision + 1,
             first_claimed_at = NULL,
             claim_deadline_at = CASE WHEN deployment_id IS NOT NULL THEN ? ELSE NULL END
         WHERE id = ?
           ${owner ? `AND ${owner.sql}` : ''}
           AND state IN (${placeholders})
           AND cleaned_at IS NOT NULL
           AND (
             deployment_id IS NULL
             OR EXISTS (
               SELECT 1 FROM deployments target
               WHERE target.id = workloads.deployment_id
                 AND target.deletion_requested_at IS NULL
                 AND target.deleted_at IS NULL
             )
           )
           AND (
             node_pool_id IS NULL
             OR EXISTS (
               SELECT 1 FROM node_pools p
               WHERE p.id = workloads.node_pool_id AND p.state = 'ready'
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM vms
             WHERE workload_id = ?
               AND ended_at IS NULL
           )
         RETURNING submission_revision AS submissionRevision, claim_deadline_at AS claimDeadlineAt`,
          [
            WorkloadState.Queued,
            now,
            options?.claimDeadlineAt ?? null,
            workloadId,
            ...(owner?.params ?? []),
            ...RESUBMITTABLE_STATES,
            workloadId,
          ],
        );
        if (!result[0]) return false;
        changed(workloadId);

        tx.query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, ?, ?)`,
          [
            workloadId,
            WorkloadState.Queued,
            eventMetadataColumn(metadata),
            now,
          ],
        );
        return result[0];
      },
    );

    if (!resubmitted) {
      return false;
    }

    log.info(`Resubmit: ${workloadId}`, { id: workloadId });
    return resubmitted;
  }

  /**
   * Atomically commit a user termination request.
   *
   * A terminal workload is already cleanup-eligible, so terminating one is a
   * no-op that preserves its Completed/Errored/Failed outcome. Active
   * workloads transition to Terminated.
   */
  async requestTermination(
    workloadId: string,
    scope: OwnershipScope,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<{
    previousState: WorkloadState;
  } | null> {
    const now = Date.now();
    const owner = ownershipPredicate(scope);

    const result = await commitWorkloadChanges(
      this.db,
      this.jobChanges,
      (tx, changed) => {
        const rows = tx.query<{
          state: WorkloadState;
          deployment_id: string | null;
        }>(
          `SELECT state, deployment_id
         FROM workloads
         WHERE id = ? AND ${owner.sql}`,
          [workloadId, ...owner.params],
        );
        const previous = rows[0];
        const previousState = previous?.state;
        if (!previous || !previousState) return null;

        if (isTerminalState(previousState)) {
          return {
            previousState,
            transitioned: false,
          };
        }
        if (
          !VALID_TRANSITIONS[WorkloadState.Terminated].includes(previousState)
        ) {
          throw new Error(
            `Workload ${workloadId}: ${previousState} cannot transition to Terminated`,
          );
        }

        const completesCleanupImmediately =
          previous.deployment_id !== null &&
          (previousState === WorkloadState.Queued ||
            previousState === WorkloadState.Retrying);

        const transitioned = tx.query<{ rowsAffected: number }>(
          `UPDATE workloads
         SET state = ?, end_reason = 'cancelled', completed_at = ?,
             cleaned_at = CASE WHEN ${POOL_MANAGED_CHECKPOINT_SQL}
               THEN NULL ELSE ? END
         WHERE id = ?
           AND ${owner.sql}
           AND state = ?`,
          [
            WorkloadState.Terminated,
            now,
            completesCleanupImmediately ? now : null,
            workloadId,
            ...owner.params,
            previousState,
          ],
        );
        if (!transitioned[0]?.rowsAffected) {
          throw new Error(
            `Workload ${workloadId}: termination transition was not applied`,
          );
        }

        tx.query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, ?, ?)`,
          [
            workloadId,
            WorkloadState.Terminated,
            eventMetadataColumn(options?.metadata),
            now,
          ],
        );
        changed(workloadId);
        return {
          previousState,
          transitioned: true,
        };
      },
    );

    if (result?.transitioned) {
      log.info(`State transition: ${WorkloadState.Terminated}`, {
        id: workloadId,
        state: WorkloadState.Terminated,
        ...options?.metadata,
      });
    }
    return result
      ? {
          previousState: result.previousState,
        }
      : null;
  }
}
