import { STUCK_ACTIVE_TIMEOUT_MS } from '../config.js';
import { getWorkloadLifecycle, getWorkloadQueryStore } from './persistence.js';
import { type WorkloadReconcileCandidate } from './repositories/workload-queries.js';
import type { RetryCandidate } from './repositories/retry-candidates.js';
import { log } from './logger.js';
import { computeRetryWait } from './retry-backoff.js';
import { Scheduler } from './reconciliation/scheduler.js';
import {
  WorkloadState,
  WorkloadType,
  isDeployPipelineState,
  PREEMPTIBLE_STATES,
  TERMINAL_STATES,
} from '../../shared/workload.js';

const WORKLOAD_RECONCILE_DISCOVERY_INTERVAL_MS = 30_000;
const WORKLOAD_RECONCILE_PUMP_INTERVAL_MS = 1_000;
export const WORKLOAD_RECONCILE_POLL_INTERVAL_MS = 30_000;
export const WORKLOAD_RECONCILE_RETRY_INTERVAL_MS = 60_000;
export const WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS = 5 * 60_000;
// Pending cleanup leaves the provider VM running. Start below the lane interval
// and escalate up to it, so a teardown that needs a second attempt costs
// seconds rather than a flat five minutes of a GPU node.
const WORKLOAD_RECONCILE_CLEANUP_MIN_INTERVAL_MS = 20_000;
export const WORKLOAD_RECONCILE_STUCK_INTERVAL_MS = 5 * 60_000;
const WORKLOAD_RECONCILE_SHUTDOWN_DRAIN_MS = 10_000;
const MAX_RECONCILE_IN_FLIGHT = 40;

export type WorkloadReconcileLane =
  | 'retry'
  | 'finalization'
  | 'cleanup'
  | 'stuck'
  | 'poll';

type WorkloadReconcileWorkKind =
  | 'poll'
  | 'retry-prepare'
  | 'retry-launch'
  | 'finalization'
  | 'cleanup'
  | 'active-recovery';

type WorkloadReconcileDisposition = 'completed' | 'deferred' | 'stale';
type WorkloadReconcileOutcome = WorkloadReconcileDisposition | 'failed';

export interface WorkloadReconcileResult {
  disposition: WorkloadReconcileDisposition;
  /** Required VM retirement is still unconfirmed after a release attempt. */
  reason?: 'release-pending';
}

type RetryWorkKind = 'retry-prepare' | 'retry-launch';
type NonRetryWorkKind = Exclude<WorkloadReconcileWorkKind, RetryWorkKind>;

export type WorkloadReconcileWork =
  | {
      workloadId: string;
      kind: NonRetryWorkKind;
    }
  | {
      workloadId: string;
      kind: RetryWorkKind;
      retry: RetryCandidate;
      expectedRevision: number;
    };

/** The retry facts the reconciler reads to rebuild retry timing. */
interface RetryCandidateReads {
  getRetryCandidatesByIds(ids: string[]): Promise<RetryCandidate[]>;
}

function workloadLifecycle(): RetryCandidateReads {
  return getWorkloadLifecycle();
}

/** How far behind scheduled reconciliation is right now, for the watchdog. */
export interface WorkloadReconcileBacklog {
  /** Entries holding a slot in the map that are not currently being worked. */
  scheduledCount: number;
  inFlightCount: number;
  /** Age of the oldest entry already due; zero when nothing is overdue. */
  oldestDueAgeMs: number;
}

export interface WorkloadReconcileDrainStatus {
  processedCount: number;
  failureCount: number;
  deferredCount: number;
  staleCount: number;
  hitDrainBudget: boolean;
  remainingDueCount: number;
  oldestDueAgeMs: number;
  drainMs: number;
  failed: boolean;
}

export interface WorkloadReconcilerOptions {
  reconcile: (
    work: WorkloadReconcileWork,
  ) => Promise<WorkloadReconcileResult | void>;
  /** Test override; production uses the fixed process-local safety bound. */
  maxInFlight?: number;
  discoveryIntervalMs?: number;
  pumpIntervalMs?: number;
  now?: () => number;
  random?: () => number;
}

interface DurableSnapshot {
  candidate: WorkloadReconcileCandidate;
  retry?: RetryCandidate;
}

interface InternalEntry extends DurableSnapshot {
  dueAt: number;
  kind: WorkloadReconcileWorkKind;
  retryDueAt?: number;
}

function isRetryState(state: WorkloadState): boolean {
  return state === WorkloadState.Retrying || state === WorkloadState.Recovering;
}

function sameCandidate(
  left: WorkloadReconcileCandidate,
  right: WorkloadReconcileCandidate,
): boolean {
  if (
    left.id !== right.id ||
    left.state !== right.state ||
    left.workloadType !== right.workloadType ||
    left.spot !== right.spot
  ) {
    return false;
  }
  // Each lane's identity tracks only the durable facts its scheduling reads.
  // Terminal cleanup paces from completed_at alone, so event-log drift on a
  // pending teardown is not new work and must not reset its deadline; retry
  // fencing and active recovery are what depend on the event-log fields.
  if (TERMINAL_STATES.includes(left.state)) {
    return left.completedAt === right.completedAt;
  }
  return (
    left.revision === right.revision &&
    left.latestEventAt === right.latestEventAt
  );
}

function sameRetry(
  left: RetryCandidate | undefined,
  right: RetryCandidate | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.id === right.id &&
    left.state === right.state &&
    left.retryCount === right.retryCount &&
    left.lastRetryAt === right.lastRetryAt &&
    left.failedAtState === right.failedAtState &&
    left.resubmitCount === right.resubmitCount
  );
}

function sameSnapshot(
  snapshot: DurableSnapshot,
  entry: InternalEntry,
): boolean {
  return (
    sameCandidate(snapshot.candidate, entry.candidate) &&
    sameRetry(snapshot.retry, entry.retry)
  );
}

const LANE_BY_KIND: Record<WorkloadReconcileWorkKind, WorkloadReconcileLane> = {
  'retry-prepare': 'retry',
  'retry-launch': 'retry',
  finalization: 'finalization',
  cleanup: 'cleanup',
  'active-recovery': 'stuck',
  poll: 'poll',
};

const INTERVAL_BY_LANE: Record<WorkloadReconcileLane, number> = {
  retry: WORKLOAD_RECONCILE_RETRY_INTERVAL_MS,
  cleanup: WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
  stuck: WORKLOAD_RECONCILE_STUCK_INTERVAL_MS,
  finalization: WORKLOAD_RECONCILE_POLL_INTERVAL_MS,
  poll: WORKLOAD_RECONCILE_POLL_INTERVAL_MS,
};

function laneForKind(kind: WorkloadReconcileWorkKind) {
  return LANE_BY_KIND[kind];
}

function intervalForKind(kind: WorkloadReconcileWorkKind) {
  return INTERVAL_BY_LANE[laneForKind(kind)];
}

/**
 * Gap before the next cleanup attempt for a teardown that has already been
 * outstanding for `pendingForMs`: 20s, then roughly doubling, capped at the
 * lane interval. Teardown is idempotent and cheap, so retrying early costs a
 * couple of provider calls; not retrying early costs billed VM time.
 *
 * Derived from how long cleanup has been pending rather than an attempt
 * counter, for the same reason the retry lane derives its wait from the durable
 * `retryCount`: an in-memory tally resets on restart, which would drop a
 * long-stuck teardown back to 20-second polling forever.
 */
export function cleanupRetryDelayMs(pendingForMs: number): number {
  return Math.min(
    Math.max(pendingForMs, WORKLOAD_RECONCILE_CLEANUP_MIN_INTERVAL_MS),
    WORKLOAD_RECONCILE_CLEANUP_INTERVAL_MS,
  );
}

/** The terminal transition writes `completed_at` and its event atomically, and
 *  no later event can move it — so cleanup pacing stays durable across
 *  restarts and cannot be reset by anything the event log gains afterwards. */
function cleanupPendingSince(
  candidate: WorkloadReconcileCandidate,
  now: number,
): number {
  return candidate.completedAt ?? now;
}

function activeRecoveryAt(
  candidate: WorkloadReconcileCandidate,
  now: number,
): number {
  return (candidate.latestEventAt ?? now) + STUCK_ACTIVE_TIMEOUT_MS;
}

/**
 * Four low-volume turns and 24 poll turns per 40 continuously-backlogged
 * selections. Missing lanes spill their turns to the remaining work.
 */
const FAIR_LANE_CYCLE: WorkloadReconcileLane[] = [
  'retry',
  'finalization',
  'cleanup',
  'stuck',
  'poll',
  'poll',
  'poll',
  'poll',
  'poll',
  'poll',
];

/**
 * Single-process, reconstructible workload-state controller.
 *
 * SQLite remains authoritative for workload/events/VM state. This class owns
 * only disposable timing, de-duplication, and fair admission. A restart loses
 * the map, performs one lightweight discovery, and safely rebuilds it.
 */
export class WorkloadReconciler {
  private readonly scheduler: Scheduler<InternalEntry, WorkloadReconcileLane>;
  private readonly reconcile: (
    work: WorkloadReconcileWork,
  ) => Promise<WorkloadReconcileResult | void>;
  private readonly maxInFlight: number;
  private readonly discoveryIntervalMs: number;
  private readonly pumpIntervalMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  private running = false;
  private discovering = false;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private processedCount = 0;
  private failureCount = 0;
  private deferredCount = 0;
  private staleCount = 0;

  constructor(options: WorkloadReconcilerOptions) {
    this.reconcile = options.reconcile;
    this.maxInFlight = Math.max(
      1,
      Math.floor(options.maxInFlight ?? MAX_RECONCILE_IN_FLIGHT),
    );
    this.discoveryIntervalMs =
      options.discoveryIntervalMs ?? WORKLOAD_RECONCILE_DISCOVERY_INTERVAL_MS;
    this.pumpIntervalMs =
      options.pumpIntervalMs ?? WORKLOAD_RECONCILE_PUMP_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.scheduler = new Scheduler({
      laneCycle: FAIR_LANE_CYCLE,
      maxInFlight: this.maxInFlight,
      key: (entry) => entry.candidate.id,
      lane: (entry) => laneForKind(entry.kind),
      now: this.now,
      shouldRefill: () => this.running,
      run: (entry) => this.runEntry(entry),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Inspect active pipeline facts immediately on process start. The work
      // kind and handler are identical to timeout-driven reconciliation.
      await this.discoverNow({ activeRecoveryNow: true });
      await this.pumpNow();
    } catch (error) {
      this.running = false;
      throw error;
    }

    this.scheduleDiscovery();
    this.schedulePump();
    log.info('Started workload reconciler', {
      id: 'system',
      maxInFlight: this.maxInFlight,
      discoveryIntervalMs: this.discoveryIntervalMs,
      pumpIntervalMs: this.pumpIntervalMs,
      scheduledCount: Math.max(
        0,
        this.scheduler.entryCount - this.scheduler.inFlightCount,
      ),
      inFlightCount: this.scheduler.inFlightCount,
    });
  }

  async stop(
    drainMs: number = WORKLOAD_RECONCILE_SHUTDOWN_DRAIN_MS,
  ): Promise<void> {
    this.running = false;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.discoveryTimer = null;
    this.pumpTimer = null;

    if (this.scheduler.inFlightCount > 0 && drainMs > 0) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        this.scheduler.waitForInFlight(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, drainMs);
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }

    log.info('Stopped workload reconciler', {
      id: 'system',
      remainingInFlight: this.scheduler.inFlightCount,
    });
  }

  async discoverNow(options?: { activeRecoveryNow?: boolean }): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const now = this.now();
      const candidates =
        await getWorkloadQueryStore().listWorkloadReconcileCandidates();
      const seen = new Set(candidates.map((candidate) => candidate.id));
      const retryIds = candidates
        .filter((candidate) => {
          if (!isRetryState(candidate.state)) return false;
          const existing = this.scheduler.get(candidate.id);
          return !existing || !sameCandidate(existing.candidate, candidate);
        })
        .map((candidate) => candidate.id);
      const retryById = await this.loadRetryCandidates(retryIds);

      for (const candidate of candidates) {
        const existing = this.scheduler.get(candidate.id);
        if (this.scheduler.hasInFlight(candidate.id)) continue;
        const snapshot: DurableSnapshot = {
          candidate,
          retry: isRetryState(candidate.state)
            ? (retryById.get(candidate.id) ?? existing?.retry)
            : undefined,
        };
        if (existing && sameSnapshot(snapshot, existing)) {
          if (
            isDeployPipelineState(candidate.state) &&
            (options?.activeRecoveryNow === true ||
              (existing.kind !== 'active-recovery' &&
                activeRecoveryAt(candidate, now) <= now))
          ) {
            this.scheduler.replace({
              ...existing,
              kind: 'active-recovery',
              dueAt: Math.min(existing.dueAt, now),
            });
          }
          continue;
        }
        this.replaceFromSnapshot(
          snapshot,
          existing,
          options?.activeRecoveryNow === true,
          now,
        );
      }

      for (const {
        candidate: { id },
      } of this.scheduler.entries()) {
        if (!seen.has(id) && !this.scheduler.hasInFlight(id)) {
          this.scheduler.remove(id);
        }
      }
      log.debug('Workload reconciler discovery completed', {
        id: 'system',
        candidateCount: candidates.length,
        scheduledCount: Math.max(
          0,
          this.scheduler.entryCount - this.scheduler.inFlightCount,
        ),
        inFlightCount: this.scheduler.inFlightCount,
      });
    } finally {
      this.discovering = false;
    }
  }

  /**
   * Pace an active step whose detached pipeline could not safely inspect its
   * provider resource. Install a replacement entry even while the previous
   * reconcile handoff is still in flight; refreshAfterWork preserves the newer
   * object so its completion cannot overwrite this deadline.
   */
  async deferActiveRecovery(workloadId: string): Promise<boolean> {
    const candidate =
      await getWorkloadQueryStore().getWorkloadReconcileCandidate(workloadId);
    if (!candidate || !isDeployPipelineState(candidate.state)) return false;

    this.scheduler.replace({
      candidate,
      dueAt: this.now() + WORKLOAD_RECONCILE_STUCK_INTERVAL_MS,
      kind: 'active-recovery',
    });
    return true;
  }

  /** Wake pending terminal cleanup immediately. */
  async enqueueCleanupNow(workloadId: string): Promise<boolean> {
    const candidate =
      await getWorkloadQueryStore().getWorkloadReconcileCandidate(workloadId);
    if (!candidate || !TERMINAL_STATES.includes(candidate.state)) return false;

    if (this.scheduler.hasInFlight(workloadId)) {
      return true;
    }

    this.scheduler.replace({
      candidate,
      dueAt: this.now(),
      kind: 'cleanup',
    });
    if (this.running) await this.pumpNow();
    return true;
  }

  /**
   * Poll a Running detached Workload now. Installed even over an in-flight
   * entry, whose refresh keeps the newer one; it runs once that entry settles.
   */
  async enqueuePollNow(workloadId: string): Promise<boolean> {
    const candidate =
      await getWorkloadQueryStore().getWorkloadReconcileCandidate(workloadId);
    if (candidate?.state !== WorkloadState.Running) return false;
    this.scheduler.replace({ candidate, dueAt: this.now(), kind: 'poll' });
    if (this.running && !this.scheduler.hasInFlight(workloadId))
      await this.pumpNow();
    return true;
  }

  /**
   * Schedule a Retrying Workload whose retry is immediate (a denied region, or
   * a failover to a target not yet tried) at once, instead of at the next
   * discovery. Any other retry keeps its backoff and its discovery.
   */
  async enqueueImmediateRetryNow(workloadId: string): Promise<boolean> {
    const snapshot = await this.readSnapshot(workloadId);
    if (
      snapshot?.candidate.state !== WorkloadState.Retrying ||
      snapshot.retry?.regionDenied !== 1
    )
      return false;
    // Installed even over an in-flight entry, whose refresh keeps the newer
    // one (as deferActiveRecovery); it runs once that entry settles.
    this.replaceFromSnapshot(snapshot, this.scheduler.get(workloadId));
    if (this.running && !this.scheduler.hasInFlight(workloadId))
      await this.pumpNow();
    return true;
  }

  /**
   * Fill every available in-flight position. Completion requests an immediate
   * refill; the timer is a safety pump for newly due work.
   */
  async pumpNow(): Promise<number> {
    return this.scheduler.pump().length;
  }

  async waitForInFlight(): Promise<void> {
    await this.scheduler.waitForInFlight();
  }

  /**
   * Diagnostic one-shot: process each item due at entry at most once through
   * the same fair selector and in-flight path as the live controller.
   */
  async drainDue(budgetMs: number): Promise<WorkloadReconcileDrainStatus> {
    const startedAt = this.now();
    const pending = new Set(
      this.scheduler
        .entries()
        .filter(
          (entry) =>
            !this.scheduler.hasInFlight(entry.candidate.id) &&
            entry.dueAt <= startedAt,
        )
        .map((entry) => entry.candidate.id),
    );
    const before = {
      processed: this.processedCount,
      failures: this.failureCount,
      deferred: this.deferredCount,
      stale: this.staleCount,
    };

    while (pending.size > 0 && this.now() - startedAt < budgetMs) {
      if (this.scheduler.inFlightCount >= this.maxInFlight) {
        await this.waitForInFlight();
        continue;
      }
      const selected = this.scheduler.pump(pending);
      if (selected.length === 0) break;
      for (const entry of selected) {
        pending.delete(entry.candidate.id);
      }
      await this.waitForInFlight();
    }

    const now = this.now();
    let oldestDueAgeMs = 0;
    for (const id of pending) {
      const entry = this.scheduler.get(id);
      if (entry) oldestDueAgeMs = Math.max(oldestDueAgeMs, now - entry.dueAt);
    }
    return {
      processedCount: this.processedCount - before.processed,
      failureCount: this.failureCount - before.failures,
      deferredCount: this.deferredCount - before.deferred,
      staleCount: this.staleCount - before.stale,
      hitDrainBudget: pending.size > 0 && now - startedAt >= budgetMs,
      remainingDueCount: pending.size,
      oldestDueAgeMs: Math.max(0, oldestDueAgeMs),
      drainMs: now - startedAt,
      failed: false,
    };
  }

  /**
   * Read-only backlog snapshot. Due work is normally launched within a pump
   * interval, so a large `oldestDueAgeMs` means the in-flight bound is
   * saturated by work that is not finishing.
   */
  backlogStatus(): WorkloadReconcileBacklog {
    return this.scheduler.backlog();
  }

  /** @internal Test visibility without exposing mutable controller state. */
  entriesForTests() {
    return this.scheduler.entries().map((entry) => ({
      id: entry.candidate.id,
      state: entry.candidate.state,
      revision: entry.candidate.revision,
      dueAt: entry.dueAt,
      lane: laneForKind(entry.kind),
      kind: entry.kind,
      retryDueAt: entry.retryDueAt,
    }));
  }

  private async loadRetryCandidates(
    ids: string[],
  ): Promise<Map<string, RetryCandidate>> {
    if (ids.length === 0) return new Map();
    const candidates = await workloadLifecycle().getRetryCandidatesByIds(ids);
    return new Map(candidates.map((candidate) => [candidate.id, candidate]));
  }

  private classifySnapshot(
    snapshot: DurableSnapshot,
    previous: InternalEntry | undefined,
    activeRecoveryNow: boolean,
    now: number,
  ): InternalEntry | null {
    let retryDueAt: number | undefined;
    if (snapshot.candidate.state === WorkloadState.Retrying && snapshot.retry) {
      retryDueAt =
        previous && sameRetry(previous.retry, snapshot.retry)
          ? previous.retryDueAt
          : undefined;
      retryDueAt ??=
        snapshot.retry.lastRetryAt +
        computeRetryWait(
          snapshot.retry.failedAtState,
          snapshot.retry.retryCount - snapshot.retry.deniedRetryCount,
          this.random,
          snapshot.retry.regionDenied === 1,
        );
    }

    const { candidate, retry } = snapshot;
    let kind: WorkloadReconcileWorkKind;
    let dueAt = now;
    if (isRetryState(candidate.state)) {
      if (candidate.state === WorkloadState.Retrying && retry) {
        if (retryDueAt === undefined) return null;
        kind = retryDueAt <= now ? 'retry-launch' : 'retry-prepare';
        dueAt = kind === 'retry-launch' ? retryDueAt : now;
      } else {
        kind = 'retry-launch';
      }
    } else if (candidate.state === WorkloadState.Finalizing) {
      kind = 'finalization';
    } else if (TERMINAL_STATES.includes(candidate.state)) {
      kind = 'cleanup';
    } else if (isDeployPipelineState(candidate.state)) {
      const recoveryAt = activeRecoveryAt(candidate, now);
      if (activeRecoveryNow || recoveryAt <= now) {
        kind = 'active-recovery';
      } else if (
        candidate.spot &&
        PREEMPTIBLE_STATES.includes(candidate.state)
      ) {
        kind = 'poll';
      } else {
        kind = 'active-recovery';
        dueAt = recoveryAt;
      }
    } else if (
      ((candidate.workloadType === WorkloadType.Job ||
        candidate.workloadType === WorkloadType.Vm ||
        candidate.workloadType === WorkloadType.Service) &&
        candidate.state === WorkloadState.Running) ||
      (candidate.spot && PREEMPTIBLE_STATES.includes(candidate.state))
    ) {
      kind = 'poll';
    } else {
      return null;
    }

    return {
      candidate,
      retry,
      dueAt,
      kind,
      retryDueAt,
    };
  }

  private replaceFromSnapshot(
    snapshot: DurableSnapshot,
    previous: InternalEntry | undefined,
    activeRecoveryNow = false,
    now = this.now(),
  ): void {
    const entry = this.classifySnapshot(
      snapshot,
      previous,
      activeRecoveryNow,
      now,
    );
    if (entry) this.scheduler.replace(entry);
    else this.scheduler.remove(snapshot.candidate.id);
  }

  private async readSnapshot(id: string): Promise<DurableSnapshot | null> {
    const store = getWorkloadQueryStore();
    const candidate = await store.getWorkloadReconcileCandidate(id);
    if (!candidate) return null;
    const retry = isRetryState(candidate.state)
      ? (await workloadLifecycle().getRetryCandidatesByIds([id]))[0]
      : undefined;
    return { candidate, retry };
  }

  private async runEntry(entry: InternalEntry): Promise<void> {
    const id = entry.candidate.id;
    let outcome: WorkloadReconcileOutcome = 'completed';
    let work: WorkloadReconcileWork | null = null;
    let releasePendingStartedAt: number | undefined;
    try {
      work = await this.preflight(entry);
      if (work) {
        const startedAt = this.now();
        const result = await this.reconcile(work);
        outcome = result?.disposition ?? 'completed';
        if (outcome === 'deferred' && result?.reason === 'release-pending') {
          releasePendingStartedAt = startedAt;
        }
      } else {
        outcome = 'stale';
      }
    } catch (error) {
      outcome = 'failed';
      if (this.scheduler.isCurrent(entry)) {
        this.scheduler.replaceIfCurrent(entry, {
          ...entry,
          dueAt: this.now() + intervalForKind(entry.kind),
        });
      }
      log.error('Workload reconcile item failed', {
        id,
        state: entry.candidate.state,
        lane: laneForKind(entry.kind),
        kind: entry.kind,
        error: error,
      });
    }

    if (work) {
      try {
        await this.refreshAfterWork(entry, outcome, releasePendingStartedAt);
      } catch (error) {
        outcome = 'failed';
        this.scheduler.replace({
          ...entry,
          dueAt: this.now() + intervalForKind(entry.kind),
        });
        log.error('Workload reconcile refresh failed', {
          id,
          error: error,
        });
      }
    }

    this.processedCount += 1;
    switch (outcome) {
      case 'failed':
        this.failureCount += 1;
        break;
      case 'deferred':
        this.deferredCount += 1;
        break;
      case 'stale':
        this.staleCount += 1;
        break;
      case 'completed':
        break;
    }
  }

  /**
   * Re-read durable scheduling state after admission. Discovery is only a hint:
   * changed or no-longer-due work is replaced without invoking a handler.
   */
  private async preflight(
    previous: InternalEntry,
  ): Promise<WorkloadReconcileWork | null> {
    const id = previous.candidate.id;
    const snapshot = await this.readSnapshot(id);
    if (!snapshot) {
      this.scheduler.remove(id);
      return null;
    }
    if (!sameSnapshot(snapshot, previous)) {
      this.replaceFromSnapshot(snapshot, previous);
      return null;
    }
    if (previous.dueAt > this.now()) return null;

    if (previous.kind === 'retry-prepare' || previous.kind === 'retry-launch') {
      if (!snapshot.retry) {
        this.scheduler.remove(id);
        return null;
      }
      return {
        workloadId: id,
        kind: previous.kind,
        retry: snapshot.retry,
        expectedRevision: snapshot.candidate.revision,
      };
    }
    return { workloadId: id, kind: previous.kind };
  }

  private async refreshAfterWork(
    previous: InternalEntry,
    outcome: WorkloadReconcileOutcome,
    releasePendingStartedAt?: number,
  ): Promise<void> {
    const id = previous.candidate.id;
    const snapshot = await this.readSnapshot(id);

    // A detached pipeline may settle while this handoff is refreshing and
    // explicitly replace the entry with a paced retry. Never let the older
    // handoff overwrite that newer scheduling decision.
    if (!this.scheduler.isCurrent(previous)) return;

    if (!snapshot) {
      this.scheduler.removeIfCurrent(previous);
      return;
    }

    if (
      previous.kind === 'retry-prepare' &&
      snapshot.retry &&
      sameRetry(snapshot.retry, previous.retry) &&
      outcome === 'completed'
    ) {
      const scheduled = this.classifySnapshot(
        snapshot,
        previous,
        false,
        this.now(),
      );
      if (!scheduled) {
        this.scheduler.remove(id);
        return;
      }
      this.scheduler.replace({
        ...scheduled,
        kind: 'retry-launch',
        dueAt: previous.retryDueAt ?? scheduled.retryDueAt ?? this.now(),
      });
      return;
    }

    if (sameSnapshot(snapshot, previous)) {
      // Terminal snapshot identity is scoped to completed_at, so this branch
      // governs the cleanup cadence no matter what the event log gains between
      // attempts. Escalate from a short first gap instead of charging a flat
      // lane interval of VM time per attempt.
      const now = this.now();
      const releasePending =
        releasePendingStartedAt !== undefined &&
        (previous.kind === 'retry-prepare' || previous.kind === 'retry-launch');
      // A confirmation batch may already have spent several minutes polling.
      // Count that time toward the retry gap, while pacing short failures from
      // the actual handler start. Keep retryDueAt anchored to the same event.
      const dueAt = releasePending
        ? Math.max(
            now,
            releasePendingStartedAt + intervalForKind(previous.kind),
          )
        : now +
          (previous.kind === 'cleanup'
            ? cleanupRetryDelayMs(
                now - cleanupPendingSince(snapshot.candidate, now),
              )
            : intervalForKind(previous.kind));
      this.scheduler.replace({
        ...previous,
        candidate: snapshot.candidate,
        retry: snapshot.retry,
        dueAt,
      });
      return;
    }

    this.replaceFromSnapshot(snapshot, previous);
  }

  private scheduleDiscovery(): void {
    if (!this.running || this.discoveryTimer) return;
    this.discoveryTimer = setTimeout(async () => {
      this.discoveryTimer = null;
      try {
        await this.discoverNow();
        await this.pumpNow();
      } catch (error) {
        log.error('Workload reconciler discovery failed', {
          id: 'system',
          error: error,
        });
      } finally {
        this.scheduleDiscovery();
      }
    }, this.discoveryIntervalMs);
    this.discoveryTimer.unref();
  }

  private schedulePump(): void {
    if (!this.running || this.pumpTimer) return;
    this.pumpTimer = setTimeout(async () => {
      this.pumpTimer = null;
      try {
        await this.pumpNow();
      } finally {
        this.schedulePump();
      }
    }, this.pumpIntervalMs);
    this.pumpTimer.unref();
  }
}
