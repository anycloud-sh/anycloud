/**
 * Parse a human duration like `30d`, `12h`, `90m`, `45s`, or `500ms` into
 * milliseconds. A bare number defaults to days (`7` === `7d`). Throws on
 * malformed input so callers can surface the message through their own error
 * handling.
 */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) {
    throw new Error('Duration must look like 30d, 12h, 60m, 10s, or 0s.');
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 'd';
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
  };
  return amount * multipliers[unit]!;
}

/**
 * Format a duration in ms as "Xd Yh", "Xh Ym", "Xm", or "Xs".
 */
export function formatDurationCompact(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/**
 * Format a timestamp as a human-readable relative age
 * e.g., "2h", "5d", "3m", "45s"
 */
export function formatAge(timestamp: number | null): string {
  if (timestamp === null) return 'unknown';
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  if (diffMinutes > 0) return `${diffMinutes}m`;
  return `${diffSeconds}s`;
}
