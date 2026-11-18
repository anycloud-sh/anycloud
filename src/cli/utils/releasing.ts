import chalk from 'chalk';
import { formatDurationCompact } from './duration.js';

/**
 * One vocabulary for "the outcome is final but the machine is not gone yet",
 * shared by every surface that renders it (`status` header, `status` VM list,
 * `list` rows) so the wording cannot drift between them. Phrasing differs by
 * how much room each surface has; the word does not. Plain text — callers add
 * their own colour so tests can match without ANSI codes.
 */
export const RELEASING_LABELS = {
  /** Appended to a terminal state line that still owns a VM. */
  state: ' · releasing VM (still billing)',
  /** Compact form for the `list` table's state cell. */
  stateCompact: ' · releasing',
  /** Appended to a deleting node pool whose VMs are gone but whose network is not. */
  network: ' · releasing network resources',
  /** Appended to a live VM's address under a terminal workload. */
  vm: ' (still running — releasing)',
} as const;

/**
 * Below this, the wait is an ordinary provider round-trip: teardown confirms
 * termination with no initial delay, so a healthy release lands in well under a
 * second. Every teardown records a request, so rendering those would append
 * "(0s awaiting release)" to virtually every terminated workload and teach
 * people to skip the line on the one teardown where it matters.
 */
const AWAITING_RELEASE_NOTICE_FLOOR_MS = 60_000;

/**
 * How much of a billed duration was spent waiting for the provider to release
 * the machine, shown only when that wait was long enough to be worth
 * explaining. Colocated with RELEASING_LABELS so the wording cannot drift
 * between `status` and `cost`; nothing in `yarn verify` lints CLI copy.
 *
 * Rendered beside the total, never subtracted from it — the provider charges
 * the customer's own account for that time.
 */
export function awaitingReleaseSuffix(awaitingMs: number | null): string {
  if (!awaitingMs || awaitingMs < AWAITING_RELEASE_NOTICE_FLOOR_MS) return '';
  return chalk.dim(` (${formatDurationCompact(awaitingMs)} awaiting release)`);
}
