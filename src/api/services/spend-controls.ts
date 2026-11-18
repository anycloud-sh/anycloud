/**
 * Spend Controls
 *
 * Policy functions that the provisioning scheduler uses to enforce
 * throttle and budget caps. Reactive model: spend is recomputed from
 * workloads+vms on every scheduler tick. No reservations, no estimates for
 * not-yet-running jobs.
 *
 * Window-bounded spend prorates each VM's cost by the intersection of its
 * lifetime with the window. Settled v.cost is divided pro-rata; in-flight
 * VMs use price_per_hour * elapsed_within_window.
 */

import { memoizeAsync } from '../../shared/utils.js';
import { formatNotificationUsd } from '../../shared/notifications/format.js';
import { getSpendControlsStore } from './persistence.js';
import {
  type BlockAlertIdentity,
  type Budget,
  type Period,
  type SessionSpendBreakdown,
  type Scope,
  type SpendBreakdown,
  type Throttle,
} from './spend-controls-store.js';

export interface CapBlock {
  kind: 'throttle' | 'budget';
  scope: Scope;
  period?: Period; // present for budget
  sessionId?: string; // present when scope === 'agent-session'
  capUsd: number;
  spentUsd: number; // for throttle: projected burn rate $/hr including candidate; for budget: window-to-date spend
  windowStartMs?: number; // start of the budget's calendar window; never set for throttles
  resumesAtMs?: number; // calendar reset for budgets; never set for throttles (instantaneous)
}

/**
 * Start of the current calendar window, UTC. Reset semantics:
 *   day   — 00:00 UTC
 *   week  — Monday 00:00 UTC (ISO week)
 *   month — 1st of month, 00:00 UTC
 */
export function calendarWindowStartMs(period: Period, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'day') {
    return Date.UTC(y, m, d);
  }
  if (period === 'month') {
    return Date.UTC(y, m, 1);
  }
  // week — Monday-anchored
  const dow = now.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  return Date.UTC(y, m, d - daysSinceMonday);
}

/**
 * End of the current calendar window — next reset boundary. Used to tell the
 * user when a blocked workload will auto-resume.
 */
export function calendarWindowEndMs(period: Period, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'day') {
    return Date.UTC(y, m, d + 1);
  }
  if (period === 'month') {
    return Date.UTC(y, m + 1, 1);
  }
  const dow = now.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  return Date.UTC(y, m, d - daysSinceMonday + 7);
}

/**
 * Live burn rate ($/hr): sum of price_per_hour across VMs currently running.
 * Throttle compares against this snapshot — no window, no proration. Burst-
 * and-die patterns clear the moment the VMs end.
 *
 * sessionFilter:
 *   null/undefined — account-wide (all in-flight VMs)
 *   string         — only VMs from workloads with d.session = string
 *
 * Filters mirror computeSpend: ip IS NOT NULL excludes failed-attempt rows,
 * price_per_hour IS NOT NULL skips uncatalogued VMs (contribute 0). A pool VM
 * counts from its attempt, so concurrent passes see it while it provisions
 * (RFC 0044 decision 22).
 */
export async function currentBurnRate(opts: {
  sessionFilter?: string | null;
}): Promise<number> {
  return getSpendControlsStore().currentBurnRate(opts);
}

/**
 * Compute spend in [windowStartMs, windowEndMs] for either the whole account
 * or a single agent-session. Returns actual / estimated / total breakdown
 * (actual = settled v.cost prorated; estimated = catalog fallback prorated).
 *
 * sessionFilter:
 *   null      — account-wide (all workloads)
 *   string    — only workloads with d.session = string
 *   undefined — same as null
 */
export async function computeSpend(opts: {
  windowStartMs: number;
  windowEndMs: number;
  sessionFilter?: string | null;
  nowMs?: number;
}): Promise<SpendBreakdown> {
  return getSpendControlsStore().computeSpend(opts);
}

/**
 * Per-session calendar-window spend: same SQL as `computeSpend`, grouped by
 * `d.session`. Returns actual+estimated breakdown per session. Used by
 * `anycloud spend show` to surface per-session budget rows.
 */
export async function computeSpendBySession(opts: {
  windowStartMs: number;
  windowEndMs: number;
  nowMs?: number;
}): Promise<SessionSpendBreakdown[]> {
  return getSpendControlsStore().computeSpendBySession(opts);
}

/**
 * Per-tick cache for `computeSpend` results, keyed by window+session.
 * Used by budget checks so multiple queued workloads in the same tick share
 * the same DB query.
 */
export class SpendCache {
  private cache = new Map<string, Promise<SpendBreakdown>>();

  get(opts: {
    windowStartMs: number;
    windowEndMs: number;
    sessionFilter?: string | null;
  }): Promise<SpendBreakdown> {
    const key = `${opts.windowStartMs}|${opts.windowEndMs}|${opts.sessionFilter ?? ''}`;
    return memoizeAsync(this.cache, key, () => computeSpend(opts));
  }
}

/**
 * Per-tick cache for the live burn-rate query, keyed by sessionFilter.
 * Mutable: when a candidate clears all caps, its hourlyUsd is charged into
 * the cached value so the next candidate in the same tick sees the new rate
 * (prevents burst-overshoot within a single scheduler tick).
 *
 * `withLock` serializes read-charge cycles so concurrent findBlockingCap
 * callers don't all read the same pre-burst snapshot.
 */
export class BurnRateCache {
  private cache = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  async get(sessionFilter: string | null): Promise<number> {
    const key = sessionFilter ?? '';
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const rate = await currentBurnRate({ sessionFilter });
    this.cache.set(key, rate);
    return rate;
  }

  charge(sessionFilter: string | null, hourlyUsd: number): void {
    const key = sessionFilter ?? '';
    const current = this.cache.get(key) ?? 0;
    this.cache.set(key, current + hourlyUsd);
  }
}

/**
 * Check every cap against the candidate workload. Returns the first cap
 * that blocks dispatch, or null if all clear.
 *
 * Throttle compares the live burn rate ($/hr across in-flight VMs) plus the
 * candidate's hourlyUsd against its cap. On clear, the candidate's charge
 * is committed to BurnRateCache so a burst within one tick serializes.
 * If hourlyUsd is undefined (catalog can't price the candidate's
 * vmType/region), falls back to reactive — no pre-charge.
 *
 * Budget compares calendar-window spend (actual settled cost + estimated
 * for unsettled VMs) against its cap. No pre-charge — calendar windows are
 * large enough that a tick's overshoot is negligible.
 */
export async function findBlockingCap(
  candidate: {
    session: string | null;
    hourlyUsd?: number;
  },
  throttles: Throttle[],
  budgets: Budget[],
  caches: { burn: BurnRateCache; spend: SpendCache },
  now: Date = new Date(),
): Promise<CapBlock | null> {
  // Serialize the read-charge cycle so concurrent callers don't all read the
  // same pre-burst snapshot of the live burn rate.
  return caches.burn.withLock(async () => findBlockingCapLocked());

  async function findBlockingCapLocked(): Promise<CapBlock | null> {
    const candidateCharge = candidate.hourlyUsd ?? 0;
    const throttleSessionFiltersToCommit: Array<string | null> = [];
    for (const t of throttles) {
      const sessionFilter = scopeToSessionFilter(t.scope, candidate.session);
      if (sessionFilter === SKIP) continue;
      const rate = await caches.burn.get(sessionFilter);
      const projectedRate = rate + candidateCharge;
      if (projectedRate >= t.capUsd) {
        return {
          kind: 'throttle',
          scope: t.scope,
          sessionId:
            t.scope === 'agent-session'
              ? (candidate.session ?? undefined)
              : undefined,
          capUsd: t.capUsd,
          spentUsd: projectedRate,
        };
      }
      throttleSessionFiltersToCommit.push(sessionFilter);
    }
    const budgetBlock = await findBlockingBudget(
      { session: candidate.session },
      budgets,
      caches.spend,
      now,
    );
    if (budgetBlock) return budgetBlock;
    // Candidate cleared every cap — commit its hourly charge into BurnRateCache
    // so subsequent candidates in this tick see the new rate.
    if (candidateCharge > 0) {
      for (const sessionFilter of throttleSessionFiltersToCommit) {
        caches.burn.charge(sessionFilter, candidateCharge);
      }
    }
    return null;
  }
}

/**
 * Budget-only gate that does not need a resolved VM price. This can run before
 * provider/target resolution for already-exceeded account or session budgets.
 */
export async function findBlockingBudget(
  candidate: { session: string | null },
  budgets: Budget[],
  spendCache: SpendCache,
  now: Date = new Date(),
): Promise<CapBlock | null> {
  for (const b of budgets) {
    const sessionFilter = scopeToSessionFilter(b.scope, candidate.session);
    if (sessionFilter === SKIP) continue;
    const startMs = calendarWindowStartMs(b.period, now);
    const endMs = calendarWindowEndMs(b.period, now);
    const spend = await spendCache.get({
      windowStartMs: startMs,
      windowEndMs: endMs,
      sessionFilter,
    });
    if (spend.totalUsd >= b.capUsd) {
      return {
        kind: 'budget',
        scope: b.scope,
        period: b.period,
        sessionId:
          b.scope === 'agent-session'
            ? (candidate.session ?? undefined)
            : undefined,
        capUsd: b.capUsd,
        spentUsd: spend.totalUsd,
        windowStartMs: startMs,
        resumesAtMs: endMs,
      };
    }
  }
  return null;
}

const SKIP = Symbol('skip');
type SessionFilter = string | null | typeof SKIP;

function scopeToSessionFilter(
  scope: Scope,
  session: string | null,
): SessionFilter {
  if (scope === 'account') return null;
  // agent-session: skip the cap entirely if the candidate has no session
  if (session === null) return SKIP;
  return session;
}

/**
 * Human-readable block reason written to workload metadata.message.
 * Stable wording — the CLI and docs reference it.
 */
export function formatBlockReason(block: CapBlock): string {
  const cap = formatNotificationUsd(block.capUsd, 0);
  if (block.kind === 'throttle') {
    const scope =
      block.scope === 'agent-session'
        ? ` (agent-session '${block.sessionId ?? ''}')`
        : '';
    const rate = `${formatNotificationUsd(block.spentUsd)}/hr`;
    return `blocked by throttle${scope}: projected rate ${rate} ≥ cap ${cap}/hr`;
  }
  const scope =
    block.scope === 'agent-session'
      ? ` (agent-session '${block.sessionId ?? ''}')`
      : '';
  const resumes = block.resumesAtMs
    ? ` — resumes ${new Date(block.resumesAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : '';
  const periodAdjective = { day: 'daily', week: 'weekly', month: 'monthly' }[
    block.period ?? 'day'
  ];
  const spent = formatNotificationUsd(block.spentUsd);
  return `blocked by ${periodAdjective} budget${scope}: spent ${spent} / ${cap}${resumes}`;
}

export function blockAlertIdentity(block: CapBlock): BlockAlertIdentity {
  if (block.kind === 'budget') {
    if (!block.period || block.resumesAtMs === undefined) {
      throw new Error('budget block alert identity requires period and reset');
    }
    return {
      kind: block.kind,
      scope: block.scope,
      sessionId: block.sessionId ?? null,
      period: block.period,
      windowResetAt: block.resumesAtMs,
    };
  }
  return {
    kind: block.kind,
    scope: block.scope,
    sessionId: block.sessionId ?? null,
    period: null,
    windowResetAt: null,
  };
}

export function sameBlockAlertIdentity(
  a: BlockAlertIdentity,
  b: BlockAlertIdentity,
): boolean {
  return (
    a.kind === b.kind &&
    a.scope === b.scope &&
    a.sessionId === b.sessionId &&
    a.period === b.period &&
    a.windowResetAt === b.windowResetAt
  );
}

/**
 * Who a cap is affecting, for APIs shared by more than one GitHub account.
 * Attribution is shown when the union of waiters and spenders names more than
 * one account. This includes the common case where one person's spend blocks a
 * different person's work, while a single-user API keeps its compact message.
 */
export interface SpendBlockAttribution {
  /** Usernames with queued work this cap is holding, most-affected first. */
  blockedUsers: string[];
  /** Spend in the cap's window per username, highest first. */
  spendByUser: Array<{ username: string; costUsd: number }>;
}

/** User-facing notification body for a newly-blocking cap. */
export function formatSpendBlockMessage(
  block: CapBlock,
  attribution?: SpendBlockAttribution,
): string {
  const lines = [
    '*anycloud: workloads waiting on spend cap*',
    formatBlockReason(block),
  ];
  if (attribution) {
    const involvedUsers = new Set([
      ...attribution.blockedUsers,
      ...attribution.spendByUser.map(({ username }) => username),
    ]);
    if (involvedUsers.size > 1) {
      if (attribution.blockedUsers.length > 0) {
        lines.push(`waiting: ${attribution.blockedUsers.join(', ')}`);
      }
      if (attribution.spendByUser.length > 0) {
        const spend = attribution.spendByUser
          .map(({ username, costUsd }) => `${username} $${costUsd.toFixed(2)}`)
          .join(', ');
        lines.push(`spend by user: ${spend}`);
      }
    }
  }
  return lines.join('\n');
}
