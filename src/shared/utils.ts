import { join } from 'path';
import { homedir } from 'os';
import { createConnection } from 'net';

/** Normalize a scalar, array, or nullable value to an array. */
export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function getAnycloudDir(): string {
  return process.env.ANYCLOUD_DIR || join(homedir(), '.anycloud');
}

/**
 * Escape a string for safe use as a shell argument.
 * Wraps in single quotes and escapes any single quotes within.
 * This is the safest approach as single quotes prevent all shell interpretation.
 */
export function shellEscape(arg: string): string {
  // Replace single quotes with: end quote, escaped single quote, start quote
  // e.g., "it's" becomes 'it'\''s'
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Format milliseconds as human-readable string */
function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return seconds === 1 ? '1 second' : `${seconds} seconds`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    // Round to 1 decimal place for cleaner display
    const rounded = Math.round(minutes * 10) / 10;
    return rounded === 1 ? '1 minute' : `${rounded} minutes`;
  }
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return rounded === 1 ? '1 hour' : `${rounded} hours`;
}

/** Error thrown when an operation times out */
export class TimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`${operationName} timed out after ${formatMs(timeoutMs)}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Add a timeout to a promise.
 *
 * USE WHEN: You want to ensure an operation doesn't run indefinitely.
 * - Wrapping network calls with max wait time
 * - Adding time limits to polling operations
 * - Any async operation that needs a deadline
 *
 * HOW IT WORKS: Races the promise against a timeout. Throws TimeoutError if timeout wins.
 *
 * EXAMPLE:
 *   await withTimeout(
 *     fetchData(),
 *     30000,
 *     'Fetch data'
 *   );
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new TimeoutError(operationName, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId!);
    // Suppress unhandled rejection from the abandoned promise when the timeout wins.
    // Without this, a long-running operation (e.g. SSH connect with a 2-min readyTimeout)
    // keeps running after withTimeout gives up and eventually rejects with no handler,
    // triggering an unhandledRejection event.
    promise.catch(() => {});
  }
}

function createAbortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw getAbortReason(signal);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(getAbortReason(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal ? getAbortReason(signal) : createAbortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Bound concurrently active async operations across otherwise independent
 * callers. Waiting operations start in submission order, and every slot is
 * released after either fulfillment or rejection.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Concurrency limit must be a positive integer');
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        void (async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          } finally {
            this.active -= 1;
            this.waiters.shift()?.();
          }
        })();
      };

      if (this.active < this.limit) {
        start();
      } else {
        this.waiters.push(start);
      }
    });
  }
}

/**
 * Single-flight: run `fn` once per `key`, sharing the in-flight promise with any
 * concurrent caller, and evict the entry as soon as it settles so the next call
 * recomputes. Dedupe-while-in-flight — NOT a result cache.
 *
 * USE WHEN: concurrent callers would otherwise launch identical expensive/external
 * work (e.g. a burst of inspections of the same image hitting a rate limit).
 */
export function singleFlight<K, V>(
  inFlight: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
): Promise<V> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  // Evict on settle. The `=== pending` guard avoids clobbering a newer entry
  // (e.g. from a reset) when this promise's finally runs.
  const pending = fn().finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

/**
 * Memoize an async result per `key`: the first call runs `fn` and the resolved
 * value is reused by every later caller, but a REJECTION is evicted so the next
 * call retries — a transient failure never poisons the slot permanently.
 *
 * USE WHEN: an expensive lookup should run once and be reused (e.g. "ensure the
 * shared security group exists", "list VM SKUs"), but a transient first-call
 * failure must not break the slot for the object's lifetime.
 *
 * CAVEAT: pending work is shared with no deadline — a promise that never
 * settles pins its slot for the store's lifetime. That is the right trade
 * when re-running concurrently is worse than waiting (e.g. the shared-infra
 * ensure wrapping a slow Azure LRO); for fan-out cloud reads that must
 * recover from a wedged call, use memoizeAsyncTtl with maxPendingShareMs.
 */
export function memoizeAsync<K, V>(
  store: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
): Promise<V> {
  const existing = store.get(key);
  if (existing) return existing;
  const pending = fn();
  // Re-arm on failure only (success stays cached); the `=== pending` guard
  // avoids clobbering a newer entry from a retry.
  pending.catch(() => {
    if (store.get(key) === pending) store.delete(key);
  });
  store.set(key, pending);
  return pending;
}

export interface MemoizeAsyncTtlEntry<V> {
  promise: Promise<V>;
  startedAt: number;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface MemoizeAsyncTtlOptions<V> {
  ttlMs: number;
  /**
   * Pending work older than this stops being shared and is replaced on the next
   * call. Defaults to Infinity, matching memoizeAsync's "share forever pending"
   * behavior.
   */
  maxPendingShareMs?: number;
  /**
   * Return false to serve a successful value to the current caller but evict it
   * immediately. Useful for fail-open sentinels that are represented as success.
   */
  shouldCache?: (value: V) => boolean;
  /** The TTL for this value, when it differs from `ttlMs`. */
  ttlFor?: (value: V) => number;
}

/**
 * Memoize an async result per `key` for a bounded TTL. Pending work is shared
 * like memoizeAsync, but can be replaced after maxPendingShareMs so wedged
 * cloud SDK calls do not pin the key forever. Rejections are evicted.
 *
 * USE WHEN: a short-lived external read is expensive enough to share across a
 * burst, but stale forever would be wrong (e.g. account quota/availability
 * preflight).
 */
export function memoizeAsyncTtl<K, V>(
  store: Map<K, MemoizeAsyncTtlEntry<V>>,
  key: K,
  fn: () => Promise<V>,
  options: MemoizeAsyncTtlOptions<V>,
): Promise<V> {
  const {
    ttlMs,
    maxPendingShareMs = Infinity,
    shouldCache = () => true,
  } = options;
  const now = Date.now();
  const existing = store.get(key);
  if (existing) {
    if (existing.expiresAt !== undefined) {
      if (now < existing.expiresAt) return existing.promise;
      store.delete(key);
    } else if (now - existing.startedAt < maxPendingShareMs) {
      return existing.promise;
    }
  }

  const entry: MemoizeAsyncTtlEntry<V> = {
    promise: Promise.resolve(undefined as V),
    startedAt: now,
  };
  const promise = fn().then(
    (value) => {
      if (store.get(key) === entry) {
        if (shouldCache(value)) {
          const ttl = options.ttlFor?.(value) ?? ttlMs;
          entry.expiresAt = Date.now() + ttl;
          entry.expiryTimer = setTimeout(() => {
            if (store.get(key) === entry) store.delete(key);
          }, ttl);
          (
            entry.expiryTimer as ReturnType<typeof setTimeout> & {
              unref?: () => void;
            }
          ).unref?.();
        } else {
          store.delete(key);
        }
      }
      return value;
    },
    (err) => {
      if (store.get(key) === entry) store.delete(key);
      throw err;
    },
  );
  entry.promise = promise;
  store.set(key, entry);
  return promise;
}

/**
 * Temporal gate: track keys that are closed until a timestamp.
 *
 * USE WHEN: the timestamp answers "may this side effect happen now?" rather
 * than "is this payload fresh?" Examples: temporary blocklists, alert cooldowns,
 * and suppression windows.
 */
export class TemporalGate<K> {
  private readonly closedUntil = new Map<K, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  closeFor(key: K, ttlMs: number): void {
    this.closeUntil(key, this.now() + ttlMs);
  }

  closeUntil(key: K, timestamp: number): void {
    const existing = this.closedUntil.get(key);
    if (existing !== undefined && existing > timestamp) return;
    this.closedUntil.set(key, timestamp);
  }

  closeForever(key: K): void {
    this.closeUntil(key, Number.POSITIVE_INFINITY);
  }

  isClosed(key: K): boolean {
    return this.opensAt(key) !== undefined;
  }

  opensAt(key: K): number | undefined {
    const timestamp = this.closedUntil.get(key);
    if (timestamp === undefined) return undefined;
    if (this.now() > timestamp) {
      this.closedUntil.delete(key);
      return undefined;
    }
    return timestamp;
  }

  reset(key: K): void {
    this.closedUntil.delete(key);
  }

  clear(): void {
    this.closedUntil.clear();
  }
}

/**
 * Dwell gate: track the first time a key was observed and let callers decide
 * when enough time has elapsed to act. Maturity does not auto-delete the key.
 */
export class DwellGate<K> {
  private readonly observed = new Map<K, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  markObserved(key: K): number {
    const existing = this.observed.get(key);
    if (existing !== undefined) return existing;
    const timestamp = this.now();
    this.observed.set(key, timestamp);
    return timestamp;
  }

  observedAt(key: K): number | undefined {
    return this.observed.get(key);
  }

  observedForMs(key: K): number | undefined {
    const timestamp = this.observedAt(key);
    return timestamp === undefined ? undefined : this.now() - timestamp;
  }

  isMature(key: K, dwellMs: number): boolean {
    const elapsed = this.observedForMs(key);
    return elapsed !== undefined && elapsed >= dwellMs;
  }

  reset(key: K): void {
    this.observed.delete(key);
  }

  clear(): void {
    this.observed.clear();
  }
}

/**
 * Retry an operation until it succeeds or max attempts reached.
 *
 * USE WHEN: Operation throws errors and you want to retry on failure.
 * - Network calls that might fail transiently
 * - API calls that return errors (including quota/throttling errors)
 * - Operations that need to succeed eventually
 *
 * HOW IT WORKS: Catches exceptions and retries with exponential backoff + jitter.
 * Stops when operation succeeds (doesn't throw).
 *
 * EXPONENTIAL BACKOFF: Each retry waits longer (waitMs * 2^attempt), no cap
 * JITTER: Adds randomization to prevent thundering herd (all retries at same time)
 *
 * DEFAULTS: 10 attempts, 10s initial wait, uncapped exponential backoff
 * Total possible retry time: ~2.8 hours (10s + 20s + 40s + 80s + 160s + 320s + 640s + 1280s + 2560s + 5120s)
 *
 * EXAMPLE:
 *   await withRetry(
 *     () => api.createResource(),
 *     'Create resource'
 *   );
 *   // Uses defaults: 10 attempts with uncapped exponential backoff
 *
 *   await withRetry(
 *     () => api.quickOperation(),
 *     'Quick operation',
 *     { maxAttempts: 3, waitMs: 1000 }
 *   );
 *   // Custom: 3 attempts, 1s initial wait
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  name: string,
  options: {
    maxAttempts?: number;
    waitMs?: number;
    /**
     * Upper bound on a single backoff wait (before jitter). Caps exponential
     * growth so a few failures can't balloon into multi-minute sleeps that blow
     * past an enclosing timeout. Defaults to no cap.
     */
    maxWaitMs?: number;
    /**
     * Lower bound for jitter as a fraction of the calculated wait. The default
     * 0 preserves full jitter; 0.5 samples from the upper half of the window.
     */
    jitterFloorFraction?: number;
    onRetry?: (
      attempt: number,
      maxAttempts: number,
      error: any,
      waitMs: number,
    ) => void;
    exponentialBackoff?: boolean;
    /**
     * Replaces the backoff for one failure, e.g. with a server's
     * `Retry-After`; the result is neither capped nor jittered. Return
     * undefined to keep the backoff.
     */
    retryDelayMs?: (error: unknown, attempt: number) => number | undefined;
    /** Enable jitter globally, or select it from the failure being retried. */
    jitter?: boolean | ((error: unknown) => boolean);
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    /**
     * Predicate to gate retries — if it returns false, the original error is
     * thrown immediately. Lets callers short-circuit on terminal errors
     * (e.g. malformed input) so a flaky later attempt doesn't replace the
     * meaningful first error.
     */
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 10,
    waitMs = 10000,
    maxWaitMs = Infinity,
    jitterFloorFraction = 0,
    onRetry,
    exponentialBackoff = true,
    jitter = true,
    signal,
    shouldRetry,
    retryDelayMs,
    sleep: pause = (ms: number) => sleep(ms, signal),
  } = options;
  const startTime = Date.now();
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      lastError = error;
      throwIfAborted(signal);
      if (shouldRetry && !shouldRetry(error)) throw error;
      if (attempt < maxAttempts) {
        // Calculate wait time with exponential backoff
        let wait = waitMs;
        if (exponentialBackoff) {
          // Double the wait time for each retry: waitMs * 2^(attempt-1)
          // attempt=1 → waitMs * 1 = waitMs
          // attempt=2 → waitMs * 2
          // attempt=3 → waitMs * 4
          wait = waitMs * Math.pow(2, attempt - 1);
        }

        // Cap the backoff so a long retry chain can't outlive an enclosing
        // timeout (e.g. the 15-minute provisioning budget).
        wait = Math.min(wait, maxWaitMs);

        const override = retryDelayMs?.(error, attempt);
        if (override !== undefined) {
          wait = override;
        } else {
          // Add jitter to prevent thundering herd. Full jitter is the default;
          // callers that cannot safely retry near zero can retain a wider
          // bounded window with jitterFloorFraction.
          const jitterThisFailure =
            typeof jitter === 'function' ? jitter(error) : jitter;
          if (jitterThisFailure) {
            const floor = Math.min(1, Math.max(0, jitterFloorFraction));
            wait *= floor + Math.random() * (1 - floor);
          }
        }

        onRetry?.(attempt, maxAttempts, error, wait);
        await pause(wait);
      }
    }
  }

  // If all retries failed with TimeoutError, provide better context
  if (lastError instanceof TimeoutError && maxAttempts > 1) {
    const totalElapsed = Date.now() - startTime;
    throw new Error(
      `${name} failed after ${maxAttempts} attempts (${formatMs(totalElapsed)} total, ${lastError.message})`,
    );
  }

  throw lastError;
}

export interface PollOptions<T> {
  items: T[];
  getKey: (item: T) => string;
  check: (item: T) => Promise<boolean>;
  intervalMs?: number;
  /** Max polling iterations before throwing. Unbounded if omitted. */
  maxAttempts?: number;
}

/**
 * Poll until all items pass the check function.
 *
 * USE WHEN: You have multiple items to poll in parallel until all are ready.
 * - Waiting for multiple VMs to become ready
 * - Checking multiple resources in parallel
 * - Batch operations where all items must reach a state
 *
 * HOW IT WORKS: Polls all pending items in parallel using Promise.all.
 * Removes items from pending set as they pass the check.
 *
 * EXAMPLE:
 *   await pollUntilReady({
 *     items: [vm1, vm2, vm3],
 *     getKey: (vm) => vm.id,
 *     check: async (vm) => (await getStatus(vm.id)) === 'ready',
 *     intervalMs: 10000
 *   });
 *
 * NOTE: Errors from check function propagate up (fail-fast on permanent failures).
 * Caller should wrap with runStep timeout.
 */
export async function pollUntilReady<T>(
  options: PollOptions<T>,
): Promise<void> {
  const { items, getKey, check, intervalMs = 10_000, maxAttempts } = options;
  const pending = new Set(items.map(getKey));

  let attempt = 0;
  while (pending.size > 0) {
    if (maxAttempts !== undefined && attempt >= maxAttempts) {
      const remaining = [...pending].join(', ');
      throw new Error(
        `pollUntilReady timed out after ${attempt} attempts. Still pending: ${remaining}`,
      );
    }

    const results = await Promise.all(
      items
        .filter((item) => pending.has(getKey(item)))
        .map(async (item) => ({ key: getKey(item), ready: await check(item) })),
    );

    for (const { key, ready } of results) {
      if (ready) pending.delete(key);
    }

    if (pending.size > 0) {
      await sleep(intervalMs);
    }
    attempt++;
  }
}

/**
 * Retry a single operation until a condition is met.
 *
 * USE WHEN: Operation succeeds but you're polling until result satisfies a condition.
 * - Waiting for a VM to get an IP address
 * - Polling cloud API until resource reaches desired state
 * - Checking if spot termination reason appears
 * - Any single-item polling scenario
 *
 * HOW IT WORKS: Executes operation repeatedly. Stops when condition(result) returns true.
 * Operation itself must succeed (not throw) - use withRetry if operation throws errors.
 *
 * EXAMPLE:
 *   const vm = await retryUntil(
 *     () => cloud.getVM(id),
 *     (vm) => vm.ipAddress !== null,
 *     'VM IP assignment',
 *     { maxAttempts: 30, waitMs: 2000 }
 *   );
 *
 * COMPARE WITH:
 * - Use withRetry when operation throws errors you want to retry
 * - Use pollUntilReady when polling multiple items in parallel
 */
export async function retryUntil<T>(
  operation: () => Promise<T>,
  condition: (result: T) => boolean,
  name: string,
  options: {
    maxAttempts?: number;
    waitMs?: number;
    /** The error once the attempts run out, from the last result. */
    error?: (last: T) => Error;
  } = {},
): Promise<T> {
  const { maxAttempts = 30, waitMs = 5000 } = options;

  for (let attempt = 1; ; attempt++) {
    const result = await operation();
    if (condition(result)) {
      return result;
    }
    if (attempt >= maxAttempts) {
      throw (
        options.error?.(result) ??
        new Error(`${name} failed after ${maxAttempts} attempts`)
      );
    }
    await sleep(waitMs);
  }
}

const BENIGN_RCLONE_SYSTEMD_CGROUP_WARNING =
  /\brclone-(?:output|checkpoint)\.service: Failed to kill control group \S+, ignoring: Invalid argument\s*$/;

function isBenignRcloneSystemdWarning(line: string): boolean {
  return BENIGN_RCLONE_SYSTEMD_CGROUP_WARNING.test(line);
}

/**
 * Remove the ignored systemd cgroup-cleanup warning from rclone diagnostics
 * already persisted in workload events. systemd emits it while the rclone
 * service stays active and explicitly ignores the kernel EINVAL, so it is not
 * a transfer failure. captureRcloneLogs used to store it beneath a synthetic
 * `output-sync: running`/`checkpoint-sync: running` header; drop that header
 * too when the warning was its only diagnostic, but retain it when a real
 * rclone error remains in the same block.
 */
export function sanitizeRcloneDiagnostics(
  logs: string | undefined,
): string | undefined {
  if (!logs) return undefined;

  const lines = logs.split('\n');
  const sanitized: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isBenignRcloneSystemdWarning(line)) continue;

    if (!/^(?:output|checkpoint)-sync:\s/.test(line.trimStart())) {
      sanitized.push(line);
      continue;
    }

    const block: string[] = [];
    let next = index + 1;
    while (
      next < lines.length &&
      (!lines[next].trim() || /^\s/.test(lines[next]))
    ) {
      block.push(lines[next]);
      next++;
    }

    const filteredBlock = block.filter(
      (blockLine) => !isBenignRcloneSystemdWarning(blockLine),
    );
    const removedWarning = filteredBlock.length !== block.length;
    const hasRemainingDiagnostic = filteredBlock.some((blockLine) =>
      blockLine.trim(),
    );
    if (!removedWarning || hasRemainingDiagnostic) {
      sanitized.push(line, ...filteredBlock);
    }
    index = next - 1;
  }

  const result = sanitized.join('\n');
  return result.trim() ? result : undefined;
}

/**
 * Extract error lines from log output.
 *
 * Handles both structured logs (with timestamps and levels) and unstructured logs.
 * Returns lines containing ERROR/FATAL level messages or error indicators.
 *
 * Structured format (rclone, syslog): "2025/12/25 15:33:42 ERROR : message"
 * Unstructured format (docker): any line with error keywords
 *
 * `structuredOnly` restricts matching to explicit ERROR/FATAL levels. rclone
 * runs with --verbose and always tags failures with a structured level, while
 * its log tail (and, on older VMs, the journald fallback) is full of benign
 * lines that contain words like "failed" — so rclone/systemd sources must not
 * use the unstructured keyword net. Docker container output is arbitrary
 * user-workload text with no levels, so it keeps the wide net.
 *
 * @param logs - Log output to parse
 * @returns Array of lines containing errors (max 30 most recent), empty if no errors
 */
export function extractErrorLines(
  logs: string | undefined,
  options: { structuredOnly?: boolean } = {},
): string[] {
  if (!logs) return [];

  const lines = logs.split('\n').filter((line) => line.trim());

  const errorLines = lines.filter((line) => {
    // Structured log format: check for explicit ERROR/FATAL/CRITICAL level
    // Matches: "YYYY/MM/DD HH:MM:SS ERROR :" or "YYYY/MM/DD HH:MM:SS FATAL -"
    // (also with the timestamp prefix stripped, i.e. at start of line), and
    // rclone's fs-init failures "YYYY/MM/DD HH:MM:SS CRITICAL: message" —
    // note no space before the separator there, hence \s?.
    // Also matches: "[ERROR]", "[FATAL]", "level=error", "level=fatal"
    // IMPORTANT: Must not match NOTICE, WARNING, or INFO levels
    if (
      /(?:^|\s)(ERROR|FATAL|CRITICAL)\s?[:-]/.test(line) || // Level word with separator
      /\[(ERROR|FATAL|CRITICAL)\]/.test(line) || // Bracketed level
      /level=(error|fatal|critical)/i.test(line) // Key-value level
    ) {
      return true;
    }

    if (options.structuredOnly) {
      return false;
    }

    // Skip structured log lines that are INFO, NOTICE, WARNING level.
    // Deliberately NOT anchored to start-of-line: docker containers log
    // arbitrary formats, and a column-0 "WARNING - upload failed" line must
    // keep reaching the keyword net below.
    if (/\s(INFO|NOTICE|WARNING)\s[:-]/.test(line)) {
      return false;
    }

    // Skip JSON diagnostic output (lines starting with { or containing only key:value)
    if (/^\s*[{"]/.test(line) || /^\s*"\w+":\s/.test(line)) {
      return false;
    }

    // Unstructured logs: check for error indicators
    // Cast wider net for unstructured logs (docker container output)
    const lower = line.toLowerCase();
    return (
      lower.includes('error') ||
      lower.includes('exception') ||
      lower.includes('failed') ||
      lower.includes('fatal') ||
      lower.includes('panic') ||
      lower.includes('traceback') ||
      line.includes('Error:') ||
      !!line.match(/^\s+at\s/) // Stack trace lines
    );
  });

  // Return last 30 error lines (most recent)
  return errorLines.slice(-30);
}

/**
 * TCP connect probe — returns true if a TCP connection to host:port
 * succeeds within timeoutMs, false otherwise.
 */
export function tcpPing(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Controller self-check: verify our own network is up before blaming remote VMs.
 * TCP connects to Google DNS (8.8.8.8:53) with a short timeout.
 * Returns true if reachable, false if the API server's own network is down.
 */
export function checkNetworkConnectivity(): Promise<boolean> {
  return tcpPing('8.8.8.8', 53, 5000);
}
