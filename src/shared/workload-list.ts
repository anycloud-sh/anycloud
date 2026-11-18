/**
 * Bounds for the workload collection, shared by the CLI (which sizes
 * its `-n/--limit` flag and default fetch) and the API (which enforces the
 * ceiling regardless of what the client sends).
 */

/** Workloads `anycloud list` returns when `-n/--limit` is omitted. */
export const DEFAULT_LIST_LIMIT = 200;

/**
 * Hard ceiling on a single list query. The server clamps to this no matter
 * what the client requests, so no caller — including old binaries still in the
 * field — can ask for an unbounded whole-history scan.
 */
export const MAX_LIST_LIMIT = 1000;

/** Smallest reporting window accepted by `anycloud cost`. */
export const MIN_COST_REPORT_PERIOD_DAYS = 1;

/** Largest reporting window accepted by `anycloud cost`. */
export const MAX_COST_REPORT_PERIOD_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const COST_REPORT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export const MIN_COST_REPORT_PERIOD_MS = MIN_COST_REPORT_PERIOD_DAYS * DAY_MS;
export const MAX_COST_REPORT_PERIOD_MS = MAX_COST_REPORT_PERIOD_DAYS * DAY_MS;

/**
 * Validate a client-computed cost cutoff and pin small clock/transport drift
 * back inside the server-owned 1..90 day range. Returning `null` means the
 * request is not a valid cost window.
 */
export function normalizeCostReportSinceMs(
  sinceMs: unknown,
  nowMs: number,
): number | null {
  if (!Number.isSafeInteger(sinceMs)) return null;

  const cutoff = sinceMs as number;
  const periodMs = nowMs - cutoff;
  if (
    periodMs <
      MIN_COST_REPORT_PERIOD_MS - COST_REPORT_CLOCK_SKEW_TOLERANCE_MS ||
    periodMs > MAX_COST_REPORT_PERIOD_MS + COST_REPORT_CLOCK_SKEW_TOLERANCE_MS
  ) {
    return null;
  }

  return Math.min(
    nowMs - MIN_COST_REPORT_PERIOD_MS,
    Math.max(nowMs - MAX_COST_REPORT_PERIOD_MS, cutoff),
  );
}

/**
 * Normalize a client-supplied `limit` into a bounded value the store can run.
 * The cap ({@link MAX_LIST_LIMIT}) is universal — it applies to every query
 * regardless of any filter, since a filter (e.g. `--status completed`) can
 * still match most of an account's history.
 *
 * - missing / non-numeric → `defaultLimit` (callers pass {@link MAX_LIST_LIMIT}
 *   for picker/stateClass queries that want the full actionable set, else
 *   {@link DEFAULT_LIST_LIMIT})
 * - numeric → truncated and clamped into [1, {@link MAX_LIST_LIMIT}]
 *
 * Routes reject explicit non-positive limits before calling this helper. The
 * floor remains defense in depth for direct callers and positive fractions.
 */
export function clampListLimit(
  limit: unknown,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.min(Math.trunc(limit), MAX_LIST_LIMIT));
}
