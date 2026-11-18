import { vi } from 'vitest';

/**
 * Records peak concurrent in-flight calls per label, for asserting a fan-out is
 * bounded. Wrap the method under test with `track(label, fn)`, which holds each
 * call for one macrotask so siblings overlap in the counter.
 *
 * DETERMINISM REQUIRES FAKE TIMERS. The hold is a real `setTimeout`, so under
 * REAL timers the measurement is load-dependent: cold-start / GC can disturb the
 * hold↔decrement interleaving and `peak()` over-counts (observed `peak == N` on a
 * cold run). Drive the tick under `vi.useFakeTimers()` + `await
 * vi.runAllTimersAsync()` so the schedule is deterministic regardless of host load.
 */
export class ConcurrencyMeter {
  private inFlight = new Map<string, number>();
  private peaks = new Map<string, number>();
  private counts = new Map<string, number>();
  // Aggregate in-flight across ALL labels — the bound the unified reconcile loop
  // enforces (one K over a mix of states), which a per-label peak cannot see: a
  // tick running 100 preemption + 40 completion + 40 cleanup is 180 concurrent
  // cloud calls but every per-label `peak()` stays under its own cap. `peakTotal`
  // sums every tracked call regardless of label so the merge's single-K invariant
  // is measurable.
  private totalInFlight = 0;
  private totalPeak = 0;

  track<A extends unknown[], T>(
    label: string,
    fn: (...args: A) => Promise<T>,
  ): (...args: A) => Promise<T> {
    return async (...args: A) => {
      const now = (this.inFlight.get(label) ?? 0) + 1;
      this.inFlight.set(label, now);
      this.peaks.set(label, Math.max(this.peaks.get(label) ?? 0, now));
      this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
      this.totalInFlight += 1;
      this.totalPeak = Math.max(this.totalPeak, this.totalInFlight);
      try {
        await new Promise((r) => setTimeout(r, 0)); // hold the slot one macrotask
        return await fn(...args);
      } finally {
        this.inFlight.set(label, (this.inFlight.get(label) ?? 1) - 1);
        this.totalInFlight -= 1;
      }
    };
  }

  peak(label: string): number {
    return this.peaks.get(label) ?? 0;
  }

  /**
   * Peak concurrent in-flight calls across EVERY label — the aggregate bound the
   * unified reconcile loop must hold at ≤ K regardless of how the K claimed rows
   * distribute across states. Use this (not the per-label `peak`) for the
   * mixed-state aggregate-K scale test.
   */
  peakTotal(): number {
    return this.totalPeak;
  }

  count(label: string): number {
    return this.counts.get(label) ?? 0;
  }
}

/**
 * Run a monitor tick under fake timers and return the VIRTUAL time it took to
 * drain — the tick's wall-time on a deterministic clock. Pair with a fake whose
 * per-item op `await sleep(D)` models real latency: with fan-out cap C over N
 * items, drain ≈ ⌈N/C⌉·D, so this measures THROUGHPUT (does the tick keep up?),
 * not just concurrency width. Relies on per-item timeouts clearing on success
 * (withTimeout does) so no stray timer inflates the reading.
 */
export async function measureTickDrainMs(
  // The meter only awaits the tick; what it resolves to is the caller's.
  runTick: () => Promise<unknown>,
): Promise<number> {
  // Keep setImmediate real so the loop can yield to SQLite/native promises
  // between timer waves. Reconciler preflight performs asynchronous DB reads
  // before scheduling the modeled provider timer, so one runAllTimersAsync()
  // call is not sufficient to observe later waves.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const start = Date.now();
    const tick = runTick();
    let settled = false;
    void tick.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await vi.runAllTimersAsync();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await tick;
    return Date.now() - start;
  } finally {
    vi.useRealTimers();
  }
}
