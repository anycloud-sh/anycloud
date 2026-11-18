import {
  RETRY_JITTER_BASE_MS,
  RETRY_PROVISIONING_BASE_MS,
  RETRY_PROVISIONING_CAP_MS,
} from '../config.js';
import { type WorkloadEventState } from './workload-record.js';
import { WorkloadState } from '../../shared/workload.js';

/**
 * Fraction of the ceiling below which a provisioning retry never fires.
 *
 * Relative rather than absolute so the jitter window stays proportionally wide
 * at every attempt. An absolute floor collapses the window to a narrow band
 * once the ceiling saturates, which re-synchronises a fleet on the cap — the
 * opposite of what the jitter is for.
 */
const PROVISIONING_FLOOR_FRACTION = 0.1;

const NON_PROVISIONING_JITTER = 0.4;

/**
 * The bounded window a retry is sampled from at a given attempt.
 *
 * Exported so the reconciler, status readers and tests reason about one bound
 * instead of re-deriving it from the constants and drifting when a curve is
 * retuned.
 */
export function retryWindow(
  failedAtState: WorkloadEventState | null,
  retryCount: number,
  regionDenied = false,
): { minMs: number; maxMs: number } {
  // The next attempt goes to a target not yet tried (a region denied to the
  // credential is never retried), so it starts at once instead of waiting
  // out a backoff per refused target.
  if (regionDenied) return { minMs: 0, maxMs: 0 };
  const attempt = Math.max(1, retryCount);
  if (failedAtState === WorkloadState.Provisioning) {
    const ceiling = Math.min(
      RETRY_PROVISIONING_BASE_MS * Math.pow(2, attempt - 1),
      RETRY_PROVISIONING_CAP_MS,
    );
    return {
      minMs: Math.floor(ceiling * PROVISIONING_FLOOR_FRACTION),
      maxMs: ceiling,
    };
  }
  const base = Math.min(
    RETRY_JITTER_BASE_MS * Math.pow(1.6, attempt - 1),
    300_000,
  );
  return {
    minMs: Math.floor(base - NON_PROVISIONING_JITTER * base),
    maxMs: Math.floor(base + NON_PROVISIONING_JITTER * base),
  };
}

/**
 * Compute the wait before a retry attempt, sampled from {@link retryWindow}.
 *
 * Provisioning failures use a capped exponential whose ceiling doubles per
 * attempt. Later pipeline failures use a gentler 60-second, ×1.6, five-minute
 * curve.
 *
 * The process-local reconciler samples this once per durable retry revision and
 * retains the resulting deadline in memory. On restart it may sample a
 * different point in the same bounded window, but the window remains anchored
 * to the durable retry-event timestamp.
 */
export function computeRetryWait(
  failedAtState: WorkloadEventState | null,
  retryCount: number,
  random: () => number = Math.random,
  regionDenied = false,
): number {
  const jitter = Math.min(1, Math.max(0, random()));
  const { minMs, maxMs } = retryWindow(failedAtState, retryCount, regionDenied);
  return Math.floor(minMs + jitter * (maxMs - minMs));
}
