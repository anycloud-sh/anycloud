import { parseDurationMs } from './duration.js';

/** Raw `-p/--period` and `-n/--limit` flags as commander hands them over. */
export interface ListWindowFlags {
  period?: string;
  limit?: string;
}

/** Raw list intent derived from the window flags. The server owns bounding. */
export interface ResolvedListWindow {
  /**
   * Row count from `-n`, or undefined to let the server pick the default.
   * Never clamped client-side — the API owns the cap.
   */
  limit?: number;
  /** `started_at >= sinceMs` lower bound, or undefined for no time filter. */
  sinceMs?: number;
}

/**
 * Translate the `-p/--period` and `-n/--limit` flags shared by `list` and the
 * workload pickers into raw list intent. The CLI stays thin: it validates
 * the flag *shape* (so a typo fails fast) but does NOT clamp or default — the
 * API server owns the cap and the default. `period` becomes a `now - duration`
 * cutoff (the window only ever narrows). Throws with a human-readable message
 * on malformed input.
 */
export function resolveListWindow(
  flags: ListWindowFlags,
  now: number = Date.now(),
): ResolvedListWindow {
  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('--limit must be a positive integer (e.g. -n 200).');
    }
    limit = n;
  }
  const sinceMs =
    flags.period !== undefined
      ? now - parseDurationMs(flags.period)
      : undefined;
  return { limit, sinceMs };
}
