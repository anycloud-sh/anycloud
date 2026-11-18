/**
 * Deployment executions: targeted-Job discovery, claims (each opens a Pod
 * attempt), claim-deadline expiry, execution reports and cleanup through the
 * attempt writer, Pod evidence and counts.
 */

import { type DB, type DBTransaction } from './db.js';
import { managedSlot, overSessionThrottle } from './claim-spend-gate.js';
import { createJobChanges, type JobChanges } from '../job-changes.js';
import {
  LIVE_EXECUTION_STATES,
  WorkloadState,
  TERMINAL_STATES,
  endReasonOfState,
  isTerminalState,
} from '../../../shared/workload.js';
import {
  decodeContainerSpec,
  type EncodedContainerSpec,
} from '../container-spec.js';
import { eventMetadataColumn } from '../workload-event-metadata.js';
import {
  commitWorkloadChanges,
  POOL_MANAGED_CHECKPOINT_SQL,
} from './workload-lifecycle.js';
import {
  openAttempt,
  recordAttemptLogTail,
  recordAttemptOutcome,
  recordAttemptPhase,
  type AttemptLogTail,
  type AttemptEnd,
} from './workload-attempts.js';
import type { SubmissionReceipt } from './workload-outcomes.js';
import { assertRequestActive } from '../request-budget.js';
import type { WorkloadRow } from './workload-queries.js';
import type { ImagePullTelemetry } from '../../../shared/image.js';

interface TargetedJobSelection {
  jobId: string;
  executionId: string;
}

/** UUID model decoders may canonicalize the spelling of a prior UUID. */
function samePriorExecution(
  left: string | null,
  right: string | null,
): boolean {
  return left?.toLowerCase() === right?.toLowerCase();
}

export interface TargetedJobCandidate {
  jobId: string;
  submissionRevision: number;
  previousExecutionId: string | null;
}

/** A managed Deployment's Job clears its session's caps at this slot charge. */
export interface ClaimSpendGate {
  session: string | null;
  hourlyUsd?: number;
}

export interface TargetedDeploymentRuntime {
  deploymentId: string;
  generation: number;
  podUid: string;
  containerId: string;
  ready?: boolean;
  /** The replica's image pull, kept on the claim's event. */
  imagePull?: ImagePullTelemetry;
  signal?: AbortSignal;
}

export type TargetedJobClaimResult =
  | ({ kind: 'selected' } & TargetedJobSelection)
  | { kind: 'conflict' | 'stale' | 'execution-used' };

export interface TargetedExecutionIdentity {
  jobId: string;
  executionId: string;
  deploymentId: string;
  generation: number;
  podUid: string;
  containerId: string;
  state: WorkloadState;
  cleanedAt: number | null;
  /** When the runner claimed it: its log span starts here. */
  openedAt: number;
  /** When its attempt ended, or null while its instance may still run. */
  endedAt: number | null;
}

export interface TargetedJobCounts {
  queued: number;
  running: number;
  retrying: number;
  terminal: number;
  unreleased: number;
}

interface TargetedExecutionBlocker {
  jobId: string;
  executionId: string | null;
  generation: number | null;
  state: WorkloadState;
}

export interface TargetedJobStatusSnapshot {
  counts: TargetedJobCounts;
  blockers: TargetedExecutionBlocker[];
}

function targetedJobCountsQuery(deploymentId: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT
         SUM(CASE WHEN state = ? AND (first_claimed_at IS NOT NULL OR claim_deadline_at IS NULL OR claim_deadline_at > ?) THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN state = ? THEN 1 ELSE 0 END) AS retrying,
         SUM(CASE WHEN state IN (${TERMINAL_STATES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END) AS terminal,
         SUM(CASE
           WHEN state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')}) THEN 1
           WHEN state IN (${TERMINAL_STATES.map(() => '?').join(', ')})
             AND cleaned_at IS NULL
             AND current_execution_id IS NOT NULL THEN 1
           ELSE 0
         END) AS unreleased
       FROM workloads WHERE deployment_id = ?`,
    params: [
      WorkloadState.Queued,
      Date.now(),
      ...LIVE_EXECUTION_STATES,
      WorkloadState.Retrying,
      ...TERMINAL_STATES,
      ...LIVE_EXECUTION_STATES,
      ...TERMINAL_STATES,
      deploymentId,
    ],
  };
}

function targetedJobCounts(row?: TargetedJobCounts): TargetedJobCounts {
  return {
    queued: row?.queued ?? 0,
    running: row?.running ?? 0,
    retrying: row?.retrying ?? 0,
    terminal: row?.terminal ?? 0,
    unreleased: row?.unreleased ?? 0,
  };
}

export class DeploymentExecutionStore {
  /** Replica Pod UIDs closed to new claims, with when; see `closeReplica`. */
  readonly #closed = new Map<string, number>();
  /** Until when `api upgrade` holds every managed Deployment's claims. */
  #managedClaimsPausedUntil = 0;
  /** Executions `api upgrade --force` stopped, which retry if unreported. */
  readonly #forced = new Set<string>();
  /**
   * The Job discovery last offered each replica, until when, so
   * concurrent waiters discover distinct Jobs. A hint only: the claim stays
   * the commit point, and a lapsed offer is offered again.
   */
  readonly #offered = new Map<string, { podUid: string; until: number }>();

  constructor(
    private readonly db: DB,
    private readonly jobChanges: JobChanges = createJobChanges(),
  ) {}

  /**
   * Refuse every later claim on a replica its owner is releasing.
   * Claims commit in synchronous transactions in this process, so each one
   * either commits before this call, where the owner's next execution read
   * sees it, or is refused. Entries are pruned once older than an hour,
   * which outlives any claim request in flight (30 s budget).
   */
  closeReplica(podUid: string, now = Date.now()): void {
    for (const [uid, at] of this.#closed) {
      if (now - at > 3_600_000) this.#closed.delete(uid);
    }
    this.#closed.set(podUid, now);
  }

  /** Collect wake-ups in the transaction; a rollback publishes none of them. */
  async #commitJobChanges<T>(
    write: (
      tx: DBTransaction,
      changed: JobChanges['notify'],
    ) => T extends PromiseLike<unknown> ? never : T,
  ): Promise<T> {
    return commitWorkloadChanges(this.db, this.jobChanges, write);
  }

  private targetedCapacity(
    tx: DBTransaction,
    input: TargetedDeploymentRuntime,
  ): 'available' | 'full' | 'conflict' {
    const target = tx.query<{
      max_concurrent_jobs_per_replica: number;
      managed: number;
    }>(
      `SELECT max_concurrent_jobs_per_replica, managed FROM deployments
       WHERE id = ? AND generation = ?
         AND deletion_requested_at IS NULL AND deleted_at IS NULL`,
      [input.deploymentId, input.generation],
    )[0];
    if (!target) return 'conflict';
    // A closed replica long-polls instead of discovering what it can't claim.
    if (
      input.ready === false ||
      this.#closed.has(input.podUid) ||
      (target.managed === 1 && Date.now() < this.#managedClaimsPausedUntil)
    ) {
      return 'full';
    }
    // Each replica claims up to its own limit: count only the
    // executions this Pod runs or has yet to release.
    const occupied =
      tx.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pod_attempts p
       JOIN workload_attempts a ON a.id = p.attempt_id
       JOIN workloads w ON w.current_execution_id = a.execution_id
       WHERE p.pod_uid = ? AND w.deployment_id = ? AND (
         w.state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')}) OR (w.state IN (${TERMINAL_STATES.map(() => '?').join(', ')})
           AND w.cleaned_at IS NULL)
       )`,
        [
          input.podUid,
          input.deploymentId,
          ...LIVE_EXECUTION_STATES,
          ...TERMINAL_STATES,
        ],
      )[0]?.count ?? 0;
    return occupied < target.max_concurrent_jobs_per_replica
      ? 'available'
      : 'full';
  }

  /**
   * Decision 30: `api upgrade` stops claims on managed Deployments while it
   * waits for their pool Jobs and the API is replaced. Each of its polls
   * renews the hold, so an upgrade given up resumes claims once it lapses.
   */
  pauseManagedClaims(until: number): void {
    this.#managedClaimsPausedUntil = until;
  }

  markForcedStop(executionId: string): void {
    this.#forced.add(executionId);
  }

  wasForcedStop(executionId: string): boolean {
    return this.#forced.has(executionId);
  }

  /** Clear a draining mark whose replica outlived its scale-down (RA). */
  reopenReplica(podUid: string): void {
    this.#closed.delete(podUid);
  }

  private targetedCandidate(
    tx: DBTransaction,
    deploymentId: string,
    now: number,
    skipSessions: readonly string[],
    skipJobs: readonly string[],
  ): (TargetedJobCandidate & { session: string | null }) | undefined {
    return tx.query<TargetedJobCandidate & { session: string | null }>(
      `SELECT id AS jobId, submission_revision AS submissionRevision,
              current_execution_id AS previousExecutionId, session
       FROM workloads WHERE deployment_id = ? AND state = ?
         AND (first_claimed_at IS NOT NULL OR claim_deadline_at IS NULL OR claim_deadline_at > ?)
         AND (session IS NULL OR session NOT IN (SELECT value FROM json_each(?)))
         AND id NOT IN (SELECT value FROM json_each(?))
       ORDER BY submitted_at, id LIMIT 1`,
      [
        deploymentId,
        WorkloadState.Queued,
        now,
        JSON.stringify(skipSessions),
        JSON.stringify(skipJobs),
      ],
    )[0];
  }

  /**
   * Discovery observes capacity and the queue, past `skipSessions`, without
   * recording ownership. A managed Deployment's head carries its spend gate.
   */
  async discoverTargetedJob(
    input: TargetedDeploymentRuntime & { skipSessions?: readonly string[] },
  ): Promise<
    | {
        kind: 'candidate';
        candidate: TargetedJobCandidate;
        gate?: ClaimSpendGate;
      }
    | { kind: 'empty' | 'full' | 'conflict' }
  > {
    return this.db.transaction((tx) => {
      assertRequestActive(input.signal);
      const capacity = this.targetedCapacity(tx, input);
      if (capacity !== 'available') return { kind: capacity };
      const now = Date.now();
      const others: string[] = [];
      for (const [jobId, offer] of this.#offered) {
        if (offer.until <= now || offer.podUid === input.podUid)
          this.#offered.delete(jobId);
        else others.push(jobId);
      }
      const head = this.targetedCandidate(
        tx,
        input.deploymentId,
        now,
        input.skipSessions ?? [],
        others,
      );
      if (!head) return { kind: 'empty' };
      const { session, ...candidate } = head;
      const slot = managedSlot(tx, input);
      if (slot === null) return { kind: 'full' };
      // As long as a claim request may run (30 s budget).
      this.#offered.set(candidate.jobId, {
        podUid: input.podUid,
        until: now + 30_000,
      });
      const gate = slot && { session, hourlyUsd: slot.hourlyUsd ?? undefined };
      return { kind: 'candidate', candidate, gate };
    });
  }

  private targetedReplay(
    tx: DBTransaction,
    input: TargetedDeploymentRuntime &
      TargetedJobCandidate & { executionId: string },
  ): TargetedJobClaimResult | undefined {
    const replay = tx.query<
      TargetedExecutionIdentity & {
        submissionRevision: number | null;
        previousExecutionId: string | null;
      }
    >(
      `SELECT d.id AS jobId, d.deployment_id AS deploymentId,
              d.current_execution_id AS executionId, d.state AS state,
              d.cleaned_at AS cleanedAt,
              CAST(json_extract(e.metadata, '$.generation') AS INTEGER) AS generation,
              json_extract(e.metadata, '$.podUid') AS podUid,
              json_extract(e.metadata, '$.containerId') AS containerId,
              json_extract(e.metadata, '$.submissionRevision') AS submissionRevision,
              json_extract(e.metadata, '$.previousExecutionId') AS previousExecutionId
       FROM workloads d LEFT JOIN workload_events e ON e.id = (
         SELECT id FROM workload_events WHERE workload_id = d.id
           AND state IN (?, ?) AND json_valid(metadata)
           AND json_extract(metadata, '$.executionId') = d.current_execution_id
         ORDER BY id DESC LIMIT 1
       ) WHERE d.current_execution_id = ? LIMIT 1`,
      [WorkloadState.Syncing, WorkloadState.Running, input.executionId],
    )[0];
    if (replay) {
      if (
        replay.deploymentId !== input.deploymentId ||
        replay.generation !== input.generation ||
        replay.podUid !== input.podUid ||
        replay.containerId !== input.containerId ||
        replay.jobId !== input.jobId ||
        replay.submissionRevision !== input.submissionRevision ||
        !samePriorExecution(
          replay.previousExecutionId,
          input.previousExecutionId,
        )
      )
        return { kind: 'conflict' };
      if (
        LIVE_EXECUTION_STATES.includes(replay.state) ||
        (replay.state === WorkloadState.Terminated && replay.cleanedAt === null)
      ) {
        return {
          kind: 'selected',
          jobId: replay.jobId,
          executionId: input.executionId,
        };
      }
      return { kind: 'execution-used' };
    }
    const used = tx.query<{ found: number }>(
      `SELECT 1 AS found FROM workload_events INDEXED BY idx_events_execution
       WHERE json_valid(metadata)
         AND json_extract(metadata, '$.executionId') IS NOT NULL
         AND json_extract(metadata, '$.executionId') = ? LIMIT 1`,
      [input.executionId],
    )[0];
    return used ? { kind: 'execution-used' } : undefined;
  }

  private writeTargetedClaim(
    tx: DBTransaction,
    changed: JobChanges['notify'],
    input: TargetedDeploymentRuntime & { executionId: string },
    candidate: TargetedJobCandidate,
    now: number,
  ): TargetedJobClaimResult {
    assertRequestActive(input.signal);
    // A managed Deployment's runner stages the Job first (RFC 0044).
    const state =
      tx.query<{ managed: number }>(
        'SELECT managed FROM deployments WHERE id = ?',
        [input.deploymentId],
      )[0]?.managed === 1
        ? WorkloadState.Syncing
        : WorkloadState.Running;
    const updated = tx.query<{ rowsAffected: number }>(
      `UPDATE workloads SET state = ?, current_execution_id = ?,
         first_claimed_at = COALESCE(first_claimed_at, ?)
       WHERE id = ? AND deployment_id = ? AND state = ?
         AND submission_revision = ? AND current_execution_id IS ? COLLATE NOCASE
         AND (first_claimed_at IS NOT NULL OR claim_deadline_at IS NULL OR claim_deadline_at > ?)`,
      [
        state,
        input.executionId,
        now,
        candidate.jobId,
        input.deploymentId,
        WorkloadState.Queued,
        candidate.submissionRevision,
        candidate.previousExecutionId,
        now,
      ],
    );
    if (updated[0]?.rowsAffected !== 1) return { kind: 'conflict' };
    const attemptId = openAttempt(tx, {
      workloadId: candidate.jobId,
      executionId: input.executionId,
      generation: input.generation,
      substrate: 'pod',
      now,
    });
    tx.query(
      'INSERT INTO pod_attempts (attempt_id, pod_uid, container_id) VALUES (?, ?, ?)',
      [attemptId, input.podUid, input.containerId],
    );
    tx.query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, ?, ?)`,
      [
        candidate.jobId,
        state,
        eventMetadataColumn({
          executionId: input.executionId,
          generation: input.generation,
          podUid: input.podUid,
          containerId: input.containerId,
          submissionRevision: candidate.submissionRevision,
          previousExecutionId: candidate.previousExecutionId,
          imagePull: input.imagePull,
        }),
        now,
      ],
    );
    changed(candidate.jobId);
    return {
      kind: 'selected',
      jobId: candidate.jobId,
      executionId: input.executionId,
    };
  }

  /** Claim one exact candidate; only durable evidence produces permanent errors. */
  async claimTargetedJob(
    input: TargetedDeploymentRuntime &
      TargetedJobCandidate & { executionId: string },
  ): Promise<TargetedJobClaimResult> {
    this.#offered.delete(input.jobId);
    return this.#commitJobChanges((tx, changed) => {
      assertRequestActive(input.signal);
      const now = Date.now();
      const replay = this.targetedReplay(tx, input);
      if (replay) return replay;
      const job = tx.query<WorkloadRow>(
        'SELECT * FROM workloads WHERE id = ?',
        [input.jobId],
      )[0];
      // Missing Jobs, future revisions and unknown UUIDs may become valid later.
      if (!job || input.submissionRevision > job.submission_revision)
        return { kind: 'conflict' };
      if (
        job.deployment_id !== input.deploymentId ||
        input.submissionRevision < job.submission_revision
      )
        return { kind: 'stale' };
      if (
        !samePriorExecution(input.previousExecutionId, job.current_execution_id)
      ) {
        if (input.previousExecutionId === null) return { kind: 'stale' };
        const previous = tx.query<{ found: number }>(
          `SELECT 1 AS found FROM workload_events INDEXED BY idx_events_workload_id
           WHERE workload_id = ? AND json_valid(metadata)
             AND json_extract(metadata, '$.executionId') = ? COLLATE NOCASE LIMIT 1`,
          [input.jobId, input.previousExecutionId],
        )[0];
        return { kind: previous ? 'stale' : 'conflict' };
      }
      if (
        this.expireTargetedSubmission(
          tx,
          changed,
          input.jobId,
          input.submissionRevision,
          now,
          input.signal,
        )
      )
        return { kind: 'stale' };
      // A closed replica's refusal is stale, which the SDK absorbs.
      if (isTerminalState(job.state) || this.#closed.has(input.podUid))
        return { kind: 'stale' };
      if (
        job.state !== WorkloadState.Queued ||
        this.targetedCapacity(tx, input) !== 'available' ||
        overSessionThrottle(tx, input, job.session)
      )
        return { kind: 'conflict' };
      return this.writeTargetedClaim(tx, changed, input, input, now);
    });
  }

  private expireTargetedSubmission(
    tx: DBTransaction,
    changed: JobChanges['notify'],
    jobId: string,
    submissionRevision: number,
    now: number,
    signal?: AbortSignal,
  ): boolean {
    assertRequestActive(signal);
    const updated = tx.query<{ rowsAffected: number }>(
      `UPDATE workloads
       SET state = ?, end_reason = 'timeout', completed_at = ?, cleaned_at = ?
       WHERE id = ? AND deployment_id IS NOT NULL AND submission_revision = ?
         AND state = ? AND first_claimed_at IS NULL
         AND claim_deadline_at IS NOT NULL AND claim_deadline_at <= ?`,
      [
        WorkloadState.Terminated,
        now,
        now,
        jobId,
        submissionRevision,
        WorkloadState.Queued,
        now,
      ],
    );
    if (updated[0]?.rowsAffected !== 1) return false;
    tx.query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
      [
        jobId,
        WorkloadState.Terminated,
        eventMetadataColumn({
          reason: 'claim-deadline-expired',
          submissionRevision,
        }),
        now,
      ],
    );
    changed(jobId);
    return true;
  }

  private targetedSubmissionExpired(
    tx: DBTransaction,
    jobId: string,
    revision: number,
  ): boolean {
    return (
      tx.query<{ found: number }>(
        `SELECT 1 AS found FROM workload_events WHERE workload_id = ? AND state = ?
       AND json_valid(metadata) AND json_extract(metadata, '$.reason') = 'claim-deadline-expired'
       AND json_extract(metadata, '$.submissionRevision') = ? LIMIT 1`,
        [jobId, WorkloadState.Terminated, revision],
      ).length > 0
    );
  }

  async expireDueTargetedJobSubmissions(now?: number): Promise<number> {
    return this.#commitJobChanges((tx, changed) => {
      const sampledAt = now ?? Date.now();
      // Bound each background transaction. Due rows remain ineligible for
      // pickup, and direct observation can expire any row outside this batch.
      const due = tx.query<{ id: string; submission_revision: number }>(
        `SELECT id, submission_revision FROM workloads
         WHERE deployment_id IS NOT NULL AND first_claimed_at IS NULL
           AND claim_deadline_at IS NOT NULL AND claim_deadline_at <= ? AND state = ?
         ORDER BY claim_deadline_at, id LIMIT 256`,
        [sampledAt, WorkloadState.Queued],
      );
      return due.filter((job) =>
        this.expireTargetedSubmission(
          tx,
          changed,
          job.id,
          job.submission_revision,
          sampledAt,
        ),
      ).length;
    });
  }

  async observeTargetedJobSubmission(
    jobId: string,
    submissionRevision: number,
    signal?: AbortSignal,
  ): Promise<
    | (SubmissionReceipt & {
        claimed: boolean;
        outcome: 'pending' | 'claimed' | 'expired' | 'terminated' | 'changed';
      })
    | null
  > {
    return this.#commitJobChanges((tx, changed) => {
      assertRequestActive(signal);
      this.expireTargetedSubmission(
        tx,
        changed,
        jobId,
        submissionRevision,
        Date.now(),
        signal,
      );
      const job = tx.query<WorkloadRow>(
        'SELECT * FROM workloads WHERE id = ?',
        [jobId],
      )[0];
      if (!job || job.deployment_id === null) return null;
      const claimed = job.first_claimed_at !== null;
      const outcome =
        job.submission_revision !== submissionRevision
          ? 'changed'
          : claimed
            ? 'claimed'
            : this.targetedSubmissionExpired(tx, jobId, submissionRevision)
              ? 'expired'
              : isTerminalState(job.state)
                ? 'terminated'
                : 'pending';
      return {
        submissionRevision: job.submission_revision,
        claimDeadlineAt: job.claim_deadline_at,
        claimed,
        outcome,
      };
    });
  }

  /** Whether the replica has claimed a Job: only its first waited for its pull. */
  async podHasClaimed(podUid: string): Promise<boolean> {
    const rows = await this.db.query(
      'SELECT 1 FROM pod_attempts WHERE pod_uid = ? LIMIT 1',
      [podUid],
    );
    return rows.length > 0;
  }

  async getTargetedExecution(
    jobId: string,
  ): Promise<TargetedExecutionIdentity | null> {
    const rows = await this.db.query<TargetedExecutionIdentity>(
      `SELECT d.id AS jobId, d.current_execution_id AS executionId,
              d.deployment_id AS deploymentId, a.generation,
              p.pod_uid AS podUid, p.container_id AS containerId,
              d.state AS state, d.cleaned_at AS cleanedAt,
              a.opened_at AS openedAt, a.ended_at AS endedAt
       FROM workloads d
       JOIN workload_attempts a ON a.execution_id = d.current_execution_id
       JOIN pod_attempts p ON p.attempt_id = a.id
       WHERE d.id = ? AND d.deployment_id IS NOT NULL`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  async listTargetedExecutions(
    deploymentId: string,
  ): Promise<TargetedExecutionIdentity[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM workloads
       WHERE deployment_id = ?
         AND current_execution_id IS NOT NULL
         AND (
           state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')})
           OR (state IN (${TERMINAL_STATES.map(() => '?').join(', ')})
               AND cleaned_at IS NULL)
         )
       ORDER BY started_at, id`,
      [deploymentId, ...LIVE_EXECUTION_STATES, ...TERMINAL_STATES],
    );
    const executions = await Promise.all(
      rows.map(({ id }) => this.getTargetedExecution(id)),
    );
    return executions.filter(
      (execution): execution is TargetedExecutionIdentity => execution !== null,
    );
  }

  /**
   * Apply one report from the process that owns a targeted execution, or its
   * cleanup acknowledgement (`Terminated`), through the one fenced writer.
   * That transaction is also the ordering point with operator termination.
   */
  async reportTargetedJobExecution(
    jobId: string,
    executionId: string,
    end: AttemptEnd,
  ): Promise<boolean> {
    return recordAttemptOutcome(
      this.db,
      this.jobChanges,
      jobId,
      executionId,
      end,
    );
  }

  async completeTargetedJobCleanup(
    jobId: string,
    executionId: string,
  ): Promise<boolean> {
    return this.reportTargetedJobExecution(jobId, executionId, {
      state: WorkloadState.Terminated,
    });
  }

  /** A runner's step through its execution (RFC 0044). */
  reportTargetedJobPhase(
    jobId: string,
    executionId: string,
    phase: WorkloadState.Running | WorkloadState.Finalizing,
  ): Promise<boolean> {
    return recordAttemptPhase(
      this.db,
      this.jobChanges,
      jobId,
      executionId,
      phase,
    );
  }

  /** What a runner starts: the Job's command and env (RT8 admission writes them). */
  async getTargetedJobSpec(
    jobId: string,
  ): Promise<{ command: string[]; env: Record<string, string> }> {
    const [row] = await this.db.query<EncodedContainerSpec>(
      'SELECT * FROM container_specs WHERE workload_id = ?',
      [jobId],
    );
    if (!row) return { command: [], env: {} };
    const spec = await decodeContainerSpec(row, `Job ${jobId}`);
    return { command: spec.command ?? [], env: spec.env ?? {} };
  }

  /** The Deployment owner records the Node its execution's instance ran on, once. */
  async recordPodNode(executionId: string, node: string): Promise<void> {
    await this.db.query(
      `UPDATE pod_attempts SET node = ?
       WHERE node IS NULL AND attempt_id = (
         SELECT id FROM workload_attempts WHERE execution_id = ?
       )`,
      [node, executionId],
    );
  }

  /** The Deployment owner keeps the instance's log tail before it lets it go. */
  recordAttemptLogTail(
    executionId: string,
    tail: AttemptLogTail,
  ): Promise<void> {
    return recordAttemptLogTail(this.db, executionId, tail);
  }

  async countTargetedJobs(deploymentId: string): Promise<TargetedJobCounts> {
    const query = targetedJobCountsQuery(deploymentId);
    const rows = await this.db.query<TargetedJobCounts>(
      query.sql,
      query.params,
    );
    return targetedJobCounts(rows[0]);
  }

  async targetedJobStatusSnapshot(
    deploymentId: string,
  ): Promise<TargetedJobStatusSnapshot> {
    const query = targetedJobCountsQuery(deploymentId);
    return this.db.transaction((tx) => {
      const counts = targetedJobCounts(
        tx.query<TargetedJobCounts>(query.sql, query.params)[0],
      );
      const blockers = tx.query<TargetedExecutionBlocker>(
        `SELECT d.id AS jobId, d.state AS state,
                d.current_execution_id AS executionId, a.generation
         FROM workloads d
         LEFT JOIN workload_attempts a ON a.execution_id = d.current_execution_id
         WHERE d.deployment_id = ? AND (
           d.state IN (${LIVE_EXECUTION_STATES.map(() => '?').join(', ')}) OR (d.state IN (${TERMINAL_STATES.map(() => '?').join(', ')})
             AND d.cleaned_at IS NULL AND d.current_execution_id IS NOT NULL)
         )
         ORDER BY d.started_at, d.id LIMIT 10`,
        [deploymentId, ...LIVE_EXECUTION_STATES, ...TERMINAL_STATES],
      );
      return { counts, blockers };
    });
  }

  /**
   * End every Job no replica holds: terminated when its Deployment goes, or
   * `invalid` with `message` when no replica can run any (RFC 0044), then
   * only those submitted before `before`, which a newer token may yet pull.
   */
  async terminateUnassignedTargetedJobs(
    deploymentId: string,
    invalid?: { message: string; before: number },
  ): Promise<void> {
    const now = Date.now();
    const state = invalid ? WorkloadState.Invalid : WorkloadState.Terminated;
    await this.#commitJobChanges((tx, changed) => {
      const jobs = tx.query<{ id: string }>(
        `SELECT id FROM workloads
         WHERE deployment_id = ? AND state IN (?, ?) AND submitted_at < ?`,
        [
          deploymentId,
          WorkloadState.Queued,
          WorkloadState.Retrying,
          invalid?.before ?? Number.MAX_SAFE_INTEGER,
        ],
      );
      for (const job of jobs) {
        const updated = tx.query<{ rowsAffected: number }>(
          `UPDATE workloads
           SET state = ?, end_reason = ?, completed_at = ?,
               cleaned_at = CASE WHEN ${POOL_MANAGED_CHECKPOINT_SQL}
                 THEN NULL ELSE ? END
           WHERE id = ? AND state IN (?, ?)`,
          [
            state,
            endReasonOfState(state),
            now,
            now,
            job.id,
            WorkloadState.Queued,
            WorkloadState.Retrying,
          ],
        );
        if (updated[0]?.rowsAffected !== 1) continue;
        changed(job.id);
        tx.query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
           VALUES (?, ?, ?, ?)`,
          [
            job.id,
            state,
            eventMetadataColumn(
              invalid
                ? { message: invalid.message }
                : { reason: 'target-deletion' },
            ),
            now,
          ],
        );
      }
    });
  }
}
