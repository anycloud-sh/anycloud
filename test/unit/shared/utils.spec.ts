import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withTimeout,
  withRetry,
  pollUntilReady,
  shellEscape,
  singleFlight,
  memoizeAsync,
  memoizeAsyncTtl,
  ConcurrencyLimiter,
  TemporalGate,
  DwellGate,
  extractErrorLines,
  sanitizeRcloneDiagnostics,
  type MemoizeAsyncTtlEntry,
} from '../../../src/shared/utils';
import { rejectionOf } from '../helpers/rejection';

const IGNORED_SYSTEMD_WARNING =
  'Jul 10 23:26:13 vm-1 systemd[1]: rclone-output.service: Failed to kill control group /system.slice/rclone-output.service, ignoring: Invalid argument';
const RCLONE_ERROR =
  '2026/07/10 23:26:14 ERROR : results.json: Failed to copy: permission denied';

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('extractErrorLines', () => {
  it('structuredOnly matches explicit ERROR/FATAL/CRITICAL levels but not keyword lines', () => {
    // CRITICAL is how rclone reports fs-init failures (bad/missing storage
    // auth) — the only failure line a permanently-broken sync ever emits,
    // and it has no space before the colon.
    const rcloneCritical =
      '2026/07/12 09:57:34 CRITICAL: Failed to create file system for "az:results": no authentication method configured';
    const logs = [
      IGNORED_SYSTEMD_WARNING, // "Failed to kill" would match the keyword net
      'Jul 10 23:26:12 vm-1 systemd[1]: Started rclone-output.',
      RCLONE_ERROR,
      'ERROR : checkpoint.tar: Failed to copy: timeout', // level at start of line
      '2026/07/10 23:26:15 FATAL - could not read config',
      rcloneCritical,
    ].join('\n');

    expect(extractErrorLines(logs, { structuredOnly: true })).toEqual([
      RCLONE_ERROR,
      'ERROR : checkpoint.tar: Failed to copy: timeout',
      '2026/07/10 23:26:15 FATAL - could not read config',
      rcloneCritical,
    ]);
  });

  it('keeps the wide keyword net for unstructured (docker) logs by default', () => {
    // Docker container output is arbitrary workload text with no levels —
    // scoping the keyword removal to rclone sources must not change this.
    // The column-0 WARNING line pins that the INFO/NOTICE/WARNING skip stays
    // un-anchored: level-at-line-start docker formats must keep reaching the
    // keyword net.
    const logs = [
      'starting model server',
      'failed to bind to port 8080',
      'WARNING - checkpoint upload failed, retrying',
      'Traceback (most recent call last):',
    ].join('\n');

    expect(extractErrorLines(logs)).toEqual([
      'failed to bind to port 8080',
      'WARNING - checkpoint upload failed, retrying',
      'Traceback (most recent call last):',
    ]);
  });
});

describe('sanitizeRcloneDiagnostics', () => {
  it('removes only synthetic sync blocks whose sole diagnostic is the warning', () => {
    expect(
      sanitizeRcloneDiagnostics(
        `workload output\noutput-sync: running\n  ${IGNORED_SYSTEMD_WARNING}`,
      ),
    ).toBe('workload output');
    expect(
      sanitizeRcloneDiagnostics(
        `output-sync: running\n  ${IGNORED_SYSTEMD_WARNING}\n  ${RCLONE_ERROR}`,
      ),
    ).toBe(`output-sync: running\n  ${RCLONE_ERROR}`);
  });

  it('strips bare warning lines and returns undefined when nothing remains', () => {
    expect(
      sanitizeRcloneDiagnostics(
        IGNORED_SYSTEMD_WARNING.replaceAll(
          'rclone-output',
          'rclone-checkpoint',
        ),
      ),
    ).toBeUndefined();
    expect(sanitizeRcloneDiagnostics(undefined)).toBeUndefined();
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve if promise completes before timeout', async () => {
    const promise = Promise.resolve('success');

    const result = await withTimeout(promise, 5000, 'Timed out');

    expect(result).toBe('success');
  });

  it('should reject with timeout error if promise takes too long', async () => {
    const promise = new Promise((resolve) => setTimeout(resolve, 10000));

    const resultPromise = withTimeout(promise, 5000, 'Test operation');

    // Catch the rejection before advancing timers to avoid unhandled rejection
    const catchPromise = rejectionOf(resultPromise);

    await vi.advanceTimersByTimeAsync(5001);

    const error = await catchPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Test operation timed out after');
  });

  it('should reject with original error if promise fails before timeout', async () => {
    const promise = Promise.reject(new Error('Original error'));

    await expect(withTimeout(promise, 5000, 'Timed out')).rejects.toThrow(
      'Original error',
    );
  });

  it('should pass through the resolved value correctly', async () => {
    const data = { id: 123, name: 'test' };
    const promise = Promise.resolve(data);

    const result = await withTimeout(promise, 5000, 'Timed out');

    expect(result).toEqual(data);
  });

  it('should not timeout if promise resolves just before deadline', async () => {
    const promise = new Promise((resolve) =>
      setTimeout(() => resolve('just in time'), 4999),
    );

    const resultPromise = withTimeout(promise, 5000, 'Timed out');

    await vi.advanceTimersByTimeAsync(4999);

    await expect(resultPromise).resolves.toBe('just in time');
  });

  it('should clear the timeout when promise resolves to prevent memory leak', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const promise = Promise.resolve('done');

    await withTimeout(promise, 5000, 'Test');

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  it('should clear the timeout when promise rejects to prevent memory leak', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const promise = Promise.reject(new Error('failed'));

    await expect(withTimeout(promise, 5000, 'Test')).rejects.toThrow('failed');

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  it('should attach a catch handler to the original promise when the timeout wins to prevent unhandled rejection', async () => {
    // Regression: SSH_CONNECT_TIMEOUT (2 min) > monitor withTimeout (30s).
    // When the outer timeout fires and the inner SSH promise keeps running, it will
    // eventually reject with "Timed out while waiting for handshake". Without a
    // .catch() attached, that becomes an unhandled rejection.
    //
    // We verify structurally: withTimeout must call .catch() on the inner promise
    // after the timeout wins so the late rejection is silently swallowed.
    let rejectInner!: (err: Error) => void;
    let innerCatchCalled = false;

    const slowPromise = new Promise<never>((_, reject) => {
      rejectInner = reject;
    });

    // Shadow .catch() on this specific instance to detect if withTimeout attaches a handler.
    // Promise.race() uses .then(resolve, reject) internally — never .catch() — so this
    // spy is only triggered by an explicit promise.catch() call.
    const originalCatch = Promise.prototype.catch.bind(slowPromise);
    (slowPromise as any).catch = (fn?: (reason: unknown) => unknown) => {
      innerCatchCalled = true;
      return originalCatch(fn);
    };

    const result = withTimeout(slowPromise, 1000, 'test op');
    result.catch(() => {}); // consume the expected TimeoutError

    await vi.advanceTimersByTimeAsync(1001); // fire the timeout
    await Promise.resolve(); // let the finally block run

    expect(innerCatchCalled).toBe(true);

    // Cleanup: reject inner promise now that it has a handler
    rejectInner(new Error('Timed out while waiting for handshake'));
    await Promise.resolve();
  });
});

describe('ConcurrencyLimiter', () => {
  it('bounds active operations and starts waiters in submission order', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const started: number[] = [];
    const releases: Array<(() => void) | undefined> = [];
    let active = 0;
    let peak = 0;

    const pending = Array.from({ length: 4 }, (_, index) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(index);
            active += 1;
            peak = Math.max(peak, active);
            releases[index] = () => {
              active -= 1;
              resolve(index);
            };
          }),
      ),
    );

    await flushAsyncWork();
    expect(started).toEqual([0, 1]);

    releases[0]!();
    await flushAsyncWork();
    expect(started).toEqual([0, 1, 2]);

    releases[1]!();
    await flushAsyncWork();
    expect(started).toEqual([0, 1, 2, 3]);

    releases[2]!();
    releases[3]!();
    await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('releases a slot when an operation rejects', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const failed = limiter.run(async () => {
      throw new Error('boom');
    });
    const next = limiter.run(async () => 'continued');

    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('continued');
  });

  it.each([0, -1, 1.5])('rejects an invalid limit of %s', (limit) => {
    expect(() => new ConcurrencyLimiter(limit)).toThrow(
      'Concurrency limit must be a positive integer',
    );
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses through the injected sleep', async () => {
    const error = new Error('always fails');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delays = [5, 1, 30];

    await expect(
      withRetry(operation, 'test', {
        maxAttempts: 4,
        retryDelayMs: (_error, attempt) => delays[attempt - 1],
        sleep,
      }),
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[5], [1], [30]]);
  });

  it('should return result on first success', async () => {
    const operation = vi.fn().mockResolvedValue('success');

    const result = await withRetry(operation, 'test');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed on second attempt', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(operation, 'test', { waitMs: 100 });

    // First attempt fails immediately
    await vi.advanceTimersByTimeAsync(0);
    // Wait for retry delay
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('should throw after max attempts exhausted', async () => {
    const error = new Error('always fails');
    const operation = vi.fn().mockRejectedValue(error);

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 100,
      exponentialBackoff: false,
      jitter: false,
    });

    const errorPromise = resultPromise.catch((e) => e);

    // Exhaust all attempts
    await vi.advanceTimersByTimeAsync(0); // attempt 1
    await vi.advanceTimersByTimeAsync(100); // attempt 2
    await vi.advanceTimersByTimeAsync(100); // attempt 3

    const thrownError = await errorPromise;

    expect(thrownError).toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback on each retry', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('success');

    const onRetry = vi.fn();

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 100,
      exponentialBackoff: false,
      jitter: false,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails
    await vi.advanceTimersByTimeAsync(100); // attempt 2 fails
    await vi.advanceTimersByTimeAsync(100); // attempt 3 succeeds

    await resultPromise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 3, expect.any(Error), 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 3, expect.any(Error), 100);
  });

  it('should not call onRetry on final failure', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('always fails'));
    const onRetry = vi.fn();

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 2,
      waitMs: 100,
      onRetry,
    });

    const errorPromise = resultPromise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(0); // attempt 1
    await vi.advanceTimersByTimeAsync(100); // attempt 2

    await errorPromise;

    // Only called once (after attempt 1, not after final attempt 2)
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('should use default options when not specified', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(operation, 'test');

    // Default waitMs is 10000
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10000);

    const result = await resultPromise;

    expect(result).toBe('success');
  });

  it('should cap exponential backoff at maxWaitMs', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 5,
      waitMs: 1000,
      maxWaitMs: 2000,
      jitter: false,
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails
    await vi.advanceTimersByTimeAsync(1000); // wait 1000 → attempt 2 fails
    await vi.advanceTimersByTimeAsync(2000); // wait 2000 → attempt 3 fails
    // 3rd backoff is 1000 * 2^2 = 4000ms uncapped, but must be capped to 2000ms.
    // Advancing only 2000ms must reach attempt 4. Without the cap it stays
    // pending (would need 4000ms), so this asserts the cap is applied.
    await vi.advanceTimersByTimeAsync(2000);

    expect(operation).toHaveBeenCalledTimes(4);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should keep jitter above a requested fraction of the wait window', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(operation, 'test', {
      waitMs: 1_000,
      jitterFloorFraction: 0.5,
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
    random.mockRestore();
  });

  it('should select jitter from the failure being retried', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const fixedDelay = new Error('fixed delay');
    const jitteredDelay = new Error('jittered delay');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(fixedDelay)
      .mockRejectedValueOnce(jitteredDelay)
      .mockResolvedValueOnce('success');
    const selectJitter = vi.fn((error: unknown) => error === jitteredDelay);

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 1_000,
      exponentialBackoff: false,
      jitter: selectJitter,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toBe('success');
    expect(selectJitter).toHaveBeenNthCalledWith(1, fixedDelay);
    expect(selectJitter).toHaveBeenNthCalledWith(2, jitteredDelay);
    expect(random).toHaveBeenCalledOnce();
    random.mockRestore();
  });

  it('should preserve the type of the returned value', async () => {
    interface Data {
      id: number;
      name: string;
    }
    const data: Data = { id: 1, name: 'test' };
    const operation = vi.fn().mockResolvedValue(data);

    const result = await withRetry<Data>(operation, 'test');

    expect(result).toEqual(data);
    expect(result.id).toBe(1);
  });

  it('should short-circuit when shouldRetry returns false (preserves original error)', async () => {
    const terminalError = new Error('Unknown region');
    const operation = vi.fn().mockRejectedValue(terminalError);

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 3,
      shouldRetry: (err) => !/Unknown region/.test((err as Error).message),
    });

    await expect(resultPromise).rejects.toBe(terminalError);
    // No retry attempt — exactly one call.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should still retry transient errors when shouldRetry returns true', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    const resultPromise = withRetry(operation, 'test', {
      waitMs: 100,
      shouldRetry: () => true,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(await resultPromise).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('should stop retry backoff when the signal is aborted', async () => {
    const abortError = new Error('cancelled');
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new Error('transient'));

    const resultPromise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 1000,
      jitter: false,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort(abortError);

    await expect(resultPromise).rejects.toBe(abortError);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('pollUntilReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve immediately if all items are ready', async () => {
    const check = vi.fn().mockResolvedValue(true);

    const promise = pollUntilReady({
      items: ['a', 'b', 'c'],
      getKey: (x) => x,
      check,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // Each item checked once
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('should retry items until they become ready', async () => {
    let callCount = 0;
    const check = vi.fn().mockImplementation(async (item) => {
      callCount++;
      // 'a' ready immediately, 'b' ready after 2 calls
      if (item === 'a') return true;
      if (item === 'b') return callCount > 2;
      return false;
    });

    const promise = pollUntilReady({
      items: ['a', 'b'],
      getKey: (x) => x,
      check,
      intervalMs: 100,
    });

    // First poll: 'a' ready, 'b' not ready
    await vi.advanceTimersByTimeAsync(0);
    // Wait for interval, second poll: 'b' ready
    await vi.advanceTimersByTimeAsync(100);

    await promise;

    // 'a' checked once (removed after first), 'b' checked twice
    expect(check).toHaveBeenCalledWith('a');
    expect(check).toHaveBeenCalledWith('b');
  });

  it('should propagate errors from check function (fail-fast)', async () => {
    const check = vi.fn().mockRejectedValue(new Error('container exited'));

    const promise = pollUntilReady({
      items: ['failing'],
      getKey: (x) => x,
      check,
      intervalMs: 100,
    });

    await expect(promise).rejects.toThrow('container exited');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('should use custom getKey function', async () => {
    interface Item {
      id: string;
      ready: boolean;
    }
    const items: Item[] = [
      { id: 'x', ready: true },
      { id: 'y', ready: true },
    ];
    const check = vi.fn().mockResolvedValue(true);

    const promise = pollUntilReady({
      items,
      getKey: (item) => item.id,
      check,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(check).toHaveBeenCalledWith(items[0]);
    expect(check).toHaveBeenCalledWith(items[1]);
  });

  it('should not re-check items that are already ready', async () => {
    const checkCounts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const check = vi.fn().mockImplementation(async (item: string) => {
      checkCounts[item]++;
      // 'a' ready on first call, 'b' on second, 'c' on third
      if (item === 'a') return true;
      if (item === 'b') return checkCounts[item] >= 2;
      if (item === 'c') return checkCounts[item] >= 3;
      return false;
    });

    const promise = pollUntilReady({
      items: ['a', 'b', 'c'],
      getKey: (x) => x,
      check,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0); // First poll
    await vi.advanceTimersByTimeAsync(100); // Second poll
    await vi.advanceTimersByTimeAsync(100); // Third poll

    await promise;

    // 'a' checked once (removed after first poll)
    expect(checkCounts.a).toBe(1);
    // 'b' checked twice (removed after second poll)
    expect(checkCounts.b).toBe(2);
    // 'c' checked three times
    expect(checkCounts.c).toBe(3);
  });

  it('should handle empty items array', async () => {
    const check = vi.fn();

    const promise = pollUntilReady({
      items: [],
      getKey: (x) => x,
      check,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(check).not.toHaveBeenCalled();
  });
});

describe('shellEscape', () => {
  it('should wrap simple strings in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
    expect(shellEscape('world')).toBe("'world'");
  });

  it('should escape single quotes within strings', () => {
    // "it's" becomes 'it'\''s'
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape("don't")).toBe("'don'\\''t'");
  });

  it('should handle multiple single quotes', () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('should handle empty strings', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('should prevent shell metacharacter injection', () => {
    // These dangerous inputs should be safely escaped
    expect(shellEscape('; rm -rf /')).toBe("'; rm -rf /'");
    expect(shellEscape('$(whoami)')).toBe("'$(whoami)'");
    expect(shellEscape('`id`')).toBe("'`id`'");
    expect(shellEscape('foo && bar')).toBe("'foo && bar'");
    expect(shellEscape('foo | bar')).toBe("'foo | bar'");
    expect(shellEscape('foo > /etc/passwd')).toBe("'foo > /etc/passwd'");
  });

  it('should handle strings with newlines', () => {
    expect(shellEscape('line1\nline2')).toBe("'line1\nline2'");
  });

  it('should handle strings with special characters', () => {
    expect(shellEscape('$HOME')).toBe("'$HOME'");
    expect(shellEscape('~/.ssh')).toBe("'~/.ssh'");
    expect(shellEscape('foo*bar')).toBe("'foo*bar'");
    expect(shellEscape('foo?bar')).toBe("'foo?bar'");
  });

  it('should handle JSON strings', () => {
    const json = '{"key": "value", "nested": {"a": 1}}';
    expect(shellEscape(json)).toBe(`'${json}'`);
  });

  it('should handle JSON with single quotes in values', () => {
    const json = `{"message": "it's working"}`;
    expect(shellEscape(json)).toBe(`'{"message": "it'\\''s working"}'`);
  });
});

describe('singleFlight', () => {
  it('shares one in-flight run across concurrent callers for the same key', async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    let resolve!: (n: number) => void;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => {
        resolve = r;
      });
    };

    const a = singleFlight(map, 'k', fn);
    const b = singleFlight(map, 'k', fn);
    expect(calls).toBe(1); // deduped while in flight
    resolve(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
  });

  it('evicts on settle, so a later call re-runs', async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = () => Promise.resolve(++calls);

    expect(await singleFlight(map, 'k', fn)).toBe(1);
    expect(map.has('k')).toBe(false); // evicted after settle
    expect(await singleFlight(map, 'k', fn)).toBe(2); // re-ran
  });

  it('evicts on rejection too', async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    await expect(singleFlight(map, 'k', fn)).rejects.toThrow('boom');
    expect(map.has('k')).toBe(false);
    await expect(singleFlight(map, 'k', fn)).rejects.toThrow('boom');
    expect(calls).toBe(2); // each call re-ran
  });

  it('isolates by key', async () => {
    const map = new Map<string, Promise<string>>();
    const a = await singleFlight(map, 'a', () => Promise.resolve('A'));
    const b = await singleFlight(map, 'b', () => Promise.resolve('B'));
    expect([a, b]).toEqual(['A', 'B']);
  });
});

describe('memoizeAsync', () => {
  it('runs once and reuses the resolved value', async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = () => Promise.resolve(++calls);

    expect(await memoizeAsync(map, 'k', fn)).toBe(1);
    expect(await memoizeAsync(map, 'k', fn)).toBe(1); // cached, not re-run
    expect(calls).toBe(1);
    expect(map.has('k')).toBe(true); // kept on success
  });

  it('shares one in-flight run across concurrent callers', async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    let resolve!: (n: number) => void;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => {
        resolve = r;
      });
    };
    const a = memoizeAsync(map, 'k', fn);
    const b = memoizeAsync(map, 'k', fn);
    expect(calls).toBe(1);
    resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
  });

  it('evicts a rejection so the next call retries (no permanent poisoning)', async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve(99);
    };

    await expect(memoizeAsync(map, 'k', fn)).rejects.toThrow('transient');
    expect(map.has('k')).toBe(false); // rejection evicted
    expect(await memoizeAsync(map, 'k', fn)).toBe(99); // retried, succeeded
    expect(calls).toBe(2);
  });
});

describe('memoizeAsyncTtl', () => {
  const TTL_MS = 60_000;
  const SHARE_MS = 30_000;

  it('shares one in-flight run across concurrent callers', async () => {
    const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
    let calls = 0;
    let resolve!: (n: number) => void;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => {
        resolve = r;
      });
    };

    const a = memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS });
    const b = memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS });
    expect(calls).toBe(1);
    resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
  });

  it('reuses a resolved value until the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
      let calls = 0;
      const fn = () => Promise.resolve(++calls);

      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(1);
      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(1);
      vi.advanceTimersByTime(TTL_MS + 1);
      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(2);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts a resolved value after the TTL even without another read', async () => {
    vi.useFakeTimers();
    try {
      const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
      let calls = 0;
      const fn = () => Promise.resolve(++calls);

      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(1);
      expect(map.has('k')).toBe(true);
      await vi.advanceTimersByTimeAsync(TTL_MS);
      expect(map.has('k')).toBe(false);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts a rejection so the next call retries', async () => {
    const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
    let calls = 0;
    const fn = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve(99);
    };

    await expect(
      memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS }),
    ).rejects.toThrow('transient');
    expect(map.has('k')).toBe(false);
    expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(99);
    expect(calls).toBe(2);
  });

  it('can return a successful value without caching it', async () => {
    const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
    let calls = 0;
    const fn = () => Promise.resolve(++calls);

    expect(
      await memoizeAsyncTtl(map, 'k', fn, {
        ttlMs: TTL_MS,
        shouldCache: () => false,
      }),
    ).toBe(1);
    expect(map.has('k')).toBe(false);
    expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(2);
  });

  it('stops sharing a pending promise after the share window', async () => {
    vi.useFakeTimers();
    try {
      const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
      let calls = 0;
      const fn = () => {
        calls++;
        return new Promise<number>(() => {});
      };

      void memoizeAsyncTtl(map, 'k', fn, {
        ttlMs: TTL_MS,
        maxPendingShareMs: SHARE_MS,
      });
      void memoizeAsyncTtl(map, 'k', fn, {
        ttlMs: TTL_MS,
        maxPendingShareMs: SHARE_MS,
      });
      expect(calls).toBe(1);

      vi.advanceTimersByTime(SHARE_MS + 1);
      void memoizeAsyncTtl(map, 'k', fn, {
        ttlMs: TTL_MS,
        maxPendingShareMs: SHARE_MS,
      });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an old expiry timer delete a newer entry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const map = new Map<string, MemoizeAsyncTtlEntry<number>>();
      let calls = 0;
      const fn = () => Promise.resolve(++calls);

      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(1);
      vi.setSystemTime(TTL_MS + 1);
      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(2);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(0);
      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(2);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late predecessor does not clobber its replacement', async () => {
    vi.useFakeTimers();
    try {
      const map = new Map<string, MemoizeAsyncTtlEntry<string>>();
      let releaseFirst: (value: string) => void = () => {};
      const promises = [
        new Promise<string>((resolve) => {
          releaseFirst = resolve;
        }),
        Promise.resolve('fresh'),
      ];
      let calls = 0;
      const fn = () => promises[calls++];

      const slow = memoizeAsyncTtl(map, 'k', fn, {
        ttlMs: TTL_MS,
        maxPendingShareMs: SHARE_MS,
      });
      vi.advanceTimersByTime(SHARE_MS + 1);
      expect(
        await memoizeAsyncTtl(map, 'k', fn, {
          ttlMs: TTL_MS,
          maxPendingShareMs: SHARE_MS,
        }),
      ).toBe('fresh');

      releaseFirst('late');
      expect(await slow).toBe('late');
      await Promise.resolve();
      expect(await memoizeAsyncTtl(map, 'k', fn, { ttlMs: TTL_MS })).toBe(
        'fresh',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TemporalGate', () => {
  it('is closed before expiry, opens after expiry, and cleans expired entries', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const gate = new TemporalGate<string>();
      gate.closeFor('k', 1_000);

      vi.advanceTimersByTime(1_000);
      expect(gate.isClosed('k')).toBe(true);
      expect(gate.opensAt('k')).toBe(1_000);

      vi.advanceTimersByTime(1);
      expect(gate.isClosed('k')).toBe(false);
      expect(gate.opensAt('k')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the later expiry and never shortens an existing close', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const gate = new TemporalGate<string>();
      gate.closeFor('k', 30_000);
      gate.closeFor('k', 10_000);

      vi.advanceTimersByTime(10_001);
      expect(gate.isClosed('k')).toBe(true);

      vi.advanceTimersByTime(20_000);
      expect(gate.isClosed('k')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports forever closes, reset, and clear', () => {
    const gate = new TemporalGate<string>();
    gate.closeForever('a');
    gate.closeFor('b', 1_000);

    expect(gate.isClosed('a')).toBe(true);
    expect(gate.opensAt('a')).toBe(Number.POSITIVE_INFINITY);

    gate.reset('a');
    expect(gate.isClosed('a')).toBe(false);
    expect(gate.isClosed('b')).toBe(true);

    gate.clear();
    expect(gate.isClosed('b')).toBe(false);
  });
});

describe('DwellGate', () => {
  it('keeps the first observation stable across repeated marks', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const gate = new DwellGate<string>();
      expect(gate.markObserved('k')).toBe(0);

      vi.advanceTimersByTime(1_000);
      expect(gate.markObserved('k')).toBe(0);
      expect(gate.observedAt('k')).toBe(0);
      expect(gate.observedForMs('k')).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports maturity without deleting the observation', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const gate = new DwellGate<string>();
      gate.markObserved('k');

      vi.advanceTimersByTime(999);
      expect(gate.isMature('k', 1_000)).toBe(false);

      vi.advanceTimersByTime(1);
      expect(gate.isMature('k', 1_000)).toBe(true);
      expect(gate.observedAt('k')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports reset and clear', () => {
    const gate = new DwellGate<string>();
    gate.markObserved('a');
    gate.markObserved('b');

    gate.reset('a');
    expect(gate.observedAt('a')).toBeUndefined();
    expect(gate.observedAt('b')).toBeDefined();

    gate.clear();
    expect(gate.observedAt('b')).toBeUndefined();
  });
});
