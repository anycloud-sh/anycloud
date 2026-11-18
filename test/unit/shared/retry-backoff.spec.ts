import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../../src/shared/utils';

describe('withRetry exponential backoff and jitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should use exponential backoff by default', async () => {
    const sleepTimes: number[] = [];
    let attempts = 0;

    const operation = vi.fn(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Fail');
      }
      return 'success';
    });

    // Spy on setTimeout to capture sleep durations
    const originalSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: any,
      ms: number,
    ) => {
      if (ms > 0) sleepTimes.push(ms);
      return originalSetTimeout(callback, 0);
    }) as any);

    const promise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 1000,
      jitter: false, // Disable jitter for predictable testing
    });

    await vi.runAllTimersAsync();
    await promise;

    // With exponential backoff:
    // Attempt 1 fails → wait 1000ms (1000 * 2^0)
    // Attempt 2 fails → wait 2000ms (1000 * 2^1)
    // Attempt 3 succeeds
    expect(sleepTimes).toHaveLength(2);
    expect(sleepTimes[0]).toBe(1000);
    expect(sleepTimes[1]).toBe(2000);
    expect(attempts).toBe(3);
  });

  it('should add jitter by default', async () => {
    const sleepTimes: number[] = [];
    let attempts = 0;

    const operation = vi.fn(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Fail');
      }
      return 'success';
    });

    // Spy on setTimeout to capture sleep durations
    const originalSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: any,
      ms: number,
    ) => {
      if (ms > 0) sleepTimes.push(ms);
      return originalSetTimeout(callback, 0);
    }) as any);

    const promise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 1000,
    });

    await vi.runAllTimersAsync();
    await promise;

    // With jitter, wait times should be randomized between 0 and base wait
    // Attempt 1 fails → wait random(0, 1000)
    // Attempt 2 fails → wait random(0, 2000)
    expect(sleepTimes).toHaveLength(2);

    // First wait should be between 0 and 1000
    expect(sleepTimes[0]).toBeGreaterThanOrEqual(0);
    expect(sleepTimes[0]).toBeLessThanOrEqual(1000);

    // Second wait should be between 0 and 2000 (exponential backoff with jitter)
    expect(sleepTimes[1]).toBeGreaterThanOrEqual(0);
    expect(sleepTimes[1]).toBeLessThanOrEqual(2000);

    // Jitter means waits are NOT exactly 1000 and 2000
    expect(sleepTimes[0]).not.toBe(1000);
    expect(sleepTimes[1]).not.toBe(2000);
  });

  it('should use uncapped exponential backoff', async () => {
    const sleepTimes: number[] = [];
    let attempts = 0;

    const operation = vi.fn(async () => {
      attempts++;
      if (attempts < 4) {
        throw new Error('Fail');
      }
      return 'success';
    });

    const originalSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: any,
      ms: number,
    ) => {
      if (ms > 0) sleepTimes.push(ms);
      return originalSetTimeout(callback, 0);
    }) as any);

    const promise = withRetry(operation, 'test', {
      maxAttempts: 4,
      waitMs: 10000,
      jitter: false,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Uncapped exponential backoff:
    // Attempt 1 fails → 10000ms (10000 * 2^0)
    // Attempt 2 fails → 20000ms (10000 * 2^1)
    // Attempt 3 fails → 40000ms (10000 * 2^2)
    expect(sleepTimes).toEqual([10000, 20000, 40000]);
  });

  it('should allow disabling exponential backoff', async () => {
    const sleepTimes: number[] = [];
    let attempts = 0;

    const operation = vi.fn(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Fail');
      }
      return 'success';
    });

    const originalSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: any,
      ms: number,
    ) => {
      if (ms > 0) sleepTimes.push(ms);
      return originalSetTimeout(callback, 0);
    }) as any);

    const promise = withRetry(operation, 'test', {
      maxAttempts: 3,
      waitMs: 1000,
      exponentialBackoff: false,
      jitter: false,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Fixed wait time (no exponential backoff)
    expect(sleepTimes).toEqual([1000, 1000]);
  });
});
