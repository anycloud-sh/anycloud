import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CandidatePreflightCache,
  type CandidatePreflightCacheOptions,
  runCandidatePreflightUnitSweep,
} from '../../../src/api/services/candidate-preflight-cache.js';

function options<T>(
  onFailOpen = vi.fn(),
  overrides: Partial<CandidatePreflightCacheOptions<T>> = {},
): CandidatePreflightCacheOptions<T> {
  return {
    ttlMs: 1_000,
    maxPendingShareMs: 100,
    waitTimeoutMs: 50,
    onFailOpen,
    ...overrides,
  };
}

describe('CandidatePreflightCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares concurrent callers and caches success until the TTL expires', async () => {
    vi.useFakeTimers();
    const cache = new CandidatePreflightCache<string>();
    let release!: (value: string) => void;
    const runSweep = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce('fresh');

    const first = cache.get('same', 'candidate preflight', runSweep, options());
    const second = cache.get(
      'same',
      'candidate preflight',
      runSweep,
      options(),
    );
    expect(runSweep).toHaveBeenCalledTimes(1);

    release('cached');
    await expect(first).resolves.toBe('cached');
    await expect(second).resolves.toBe('cached');

    await expect(
      cache.get('same', 'candidate preflight', runSweep, options()),
    ).resolves.toBe('cached');
    expect(runSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(
      cache.get('same', 'candidate preflight', runSweep, options()),
    ).resolves.toBe('fresh');
    expect(runSweep).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected sweep', async () => {
    const cache = new CandidatePreflightCache<number>();
    const onFailOpen = vi.fn();
    const runSweep = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(7);

    await expect(
      cache.get('same', 'candidate preflight', runSweep, options(onFailOpen)),
    ).resolves.toBeNull();
    await expect(
      cache.get('same', 'candidate preflight', runSweep, options(onFailOpen)),
    ).resolves.toBe(7);

    expect(runSweep).toHaveBeenCalledTimes(2);
    expect(onFailOpen).toHaveBeenCalledTimes(1);
  });

  it('does not cache values rejected by shouldCache', async () => {
    const cache = new CandidatePreflightCache<number>();
    const runSweep = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(
      cache.get(
        'same',
        'candidate preflight',
        runSweep,
        options(vi.fn(), { shouldCache: (value) => value > 0 }),
      ),
    ).resolves.toBe(0);
    await expect(
      cache.get(
        'same',
        'candidate preflight',
        runSweep,
        options(vi.fn(), { shouldCache: (value) => value > 0 }),
      ),
    ).resolves.toBe(1);

    expect(runSweep).toHaveBeenCalledTimes(2);
  });

  it('fails open independently for callers sharing provider work', async () => {
    vi.useFakeTimers();
    const cache = new CandidatePreflightCache<number>();
    const onFailOpen = vi.fn();
    const runSweep = vi.fn(() => new Promise<number>(() => {}));
    const opts = options<number>(onFailOpen);

    const first = cache.get('same', 'candidate preflight', runSweep, opts);
    const second = cache.get('same', 'candidate preflight', runSweep, opts);
    expect(runSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(51);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(onFailOpen).toHaveBeenCalledTimes(2);
  });

  it('shares provider work without sharing different caller wait budgets', async () => {
    vi.useFakeTimers();
    const cache = new CandidatePreflightCache<number>();
    const onFailOpen = vi.fn();
    let release!: (value: number) => void;
    const runSweep = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const shortWait = cache.get(
      'same',
      'candidate preflight',
      runSweep,
      options(onFailOpen, { waitTimeoutMs: 50 }),
    );
    const longWait = cache.get(
      'same',
      'candidate preflight',
      runSweep,
      options(onFailOpen, { waitTimeoutMs: 100 }),
    );
    let longWaitSettled = false;
    void longWait.then(() => {
      longWaitSettled = true;
    });
    expect(runSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(51);
    await expect(shortWait).resolves.toBeNull();
    expect(longWaitSettled).toBe(false);

    release(42);
    await vi.advanceTimersByTimeAsync(0);
    await expect(longWait).resolves.toBe(42);
    expect(onFailOpen).toHaveBeenCalledTimes(1);
  });

  it('cancels one caller wait without cancelling shared provider work', async () => {
    const cache = new CandidatePreflightCache<number>();
    const onFailOpen = vi.fn();
    let release!: (value: number) => void;
    const runSweep = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const survivingWait = cache.get(
      'same',
      'candidate preflight',
      runSweep,
      options(onFailOpen, { waitTimeoutMs: 1_000 }),
    );
    const cancelledCaller = new AbortController();
    const cancelledWait = cache.get(
      'same',
      'candidate preflight',
      runSweep,
      options(onFailOpen, {
        waitTimeoutMs: 1_000,
        signal: cancelledCaller.signal,
      }),
    );

    cancelledCaller.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(cancelledWait).resolves.toBeNull();
    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(onFailOpen).toHaveBeenCalledTimes(1);

    release(42);

    await expect(survivingWait).resolves.toBe(42);
    await expect(
      cache.get('same', 'candidate preflight', runSweep, options()),
    ).resolves.toBe(42);
  });

  it('lets late success populate the TTL cache after callers timed out', async () => {
    vi.useFakeTimers();
    const cache = new CandidatePreflightCache<number>();
    const onFailOpen = vi.fn();
    let release!: (value: number) => void;
    const runSweep = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const timedOut = cache.get(
      'same',
      'candidate preflight',
      runSweep,
      options(onFailOpen),
    );
    await vi.advanceTimersByTimeAsync(51);
    await expect(timedOut).resolves.toBeNull();

    release(42);
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      cache.get('same', 'candidate preflight', runSweep, options(onFailOpen)),
    ).resolves.toBe(42);
    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(onFailOpen).toHaveBeenCalledTimes(1);
  });

  it('starts fresh work after the pending-share window even if an old wait remains', async () => {
    vi.useFakeTimers();
    const cache = new CandidatePreflightCache<number>();
    const onFailOpen = vi.fn();
    const runSweep = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>(() => {}))
      .mockResolvedValueOnce(8);
    const opts = options<number>(onFailOpen, {
      maxPendingShareMs: 100,
      waitTimeoutMs: 50,
    });

    const first = cache.get('same', 'candidate preflight', runSweep, opts);
    await vi.advanceTimersByTimeAsync(51);
    await expect(first).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(25);
    const oldWait = cache.get('same', 'candidate preflight', runSweep, opts);
    expect(runSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(26);
    await expect(
      cache.get('same', 'candidate preflight', runSweep, opts),
    ).resolves.toBe(8);
    expect(runSweep).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(25);
    await expect(oldWait).resolves.toBeNull();
    expect(onFailOpen).toHaveBeenCalledTimes(2);
  });
});

describe('runCandidatePreflightUnitSweep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns successful unit values and failed units without rejecting the sweep', async () => {
    const result = await runCandidatePreflightUnitSweep({
      units: ['zero', 'good', 'bad'],
      concurrency: 2,
      perUnitTimeoutMs: 100,
      operationName: (unit) => `unit ${unit}`,
      readUnit: async (unit) => {
        if (unit === 'bad') throw new Error('regional endpoint unavailable');
        return unit === 'zero' ? 0 : 96;
      },
    });

    expect(result.values).toEqual(
      new Map([
        ['zero', 0],
        ['good', 96],
      ]),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ unit: 'bad' });
  });

  it('bounds each unit read so one hung endpoint cannot hang the sweep', async () => {
    vi.useFakeTimers();
    let hungSignal: AbortSignal | undefined;
    const resultPromise = runCandidatePreflightUnitSweep({
      units: ['hung', 'fast'],
      concurrency: 2,
      perUnitTimeoutMs: 50,
      operationName: (unit) => `unit ${unit}`,
      readUnit: async (unit, signal) => {
        if (unit === 'hung') {
          hungSignal = signal;
          return new Promise<number>(() => {});
        }
        return 7;
      },
    });

    await vi.advanceTimersByTimeAsync(51);
    const result = await resultPromise;

    expect(result.values).toEqual(new Map([['fast', 7]]));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ unit: 'hung' });
    expect(hungSignal?.aborted).toBe(true);
  });
});
