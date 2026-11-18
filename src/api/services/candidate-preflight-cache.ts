import {
  memoizeAsyncTtl,
  withTimeout,
  type MemoizeAsyncTtlEntry,
} from '../../shared/utils.js';

export interface CandidatePreflightCacheOptions<T> {
  ttlMs: number;
  maxPendingShareMs: number;
  waitTimeoutMs: number;
  signal?: AbortSignal;
  shouldCache?: (value: T) => boolean;
  ttlFor?: (value: T) => number;
  onFailOpen: (err: unknown) => void;
}

/**
 * Best-effort cache for provider candidate preflight sweeps.
 *
 * Identical sweeps share work, successful results are reused briefly, caller
 * waits are bounded, and late success can still populate the TTL cache.
 */
export class CandidatePreflightCache<T> {
  private readonly cache = new Map<string, MemoizeAsyncTtlEntry<T>>();

  async get(
    key: string,
    operationName: string,
    runSweep: () => Promise<T>,
    options: CandidatePreflightCacheOptions<T>,
  ): Promise<T | null> {
    const sweepPromise = memoizeAsyncTtl(this.cache, key, runSweep, {
      ttlMs: options.ttlMs,
      maxPendingShareMs: options.maxPendingShareMs,
      shouldCache: options.shouldCache,
      ttlFor: options.ttlFor,
    });

    let removeAbortListener: (() => void) | undefined;
    try {
      const signal = options.signal;
      if (!signal) {
        return await withTimeout(
          sweepPromise,
          options.waitTimeoutMs,
          operationName,
        );
      }

      const callerAbort = new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException(
                  'The candidate preflight caller was aborted',
                  'AbortError',
                ),
          );
        removeAbortListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener('abort', abort, { once: true });
        }
      });
      return await withTimeout(
        Promise.race([sweepPromise, callerAbort]),
        options.waitTimeoutMs,
        operationName,
      );
    } catch (err) {
      options.onFailOpen(err);
      return null;
    } finally {
      removeAbortListener?.();
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

interface CandidatePreflightUnitFailure<TUnit> {
  unit: TUnit;
  error: unknown;
}

export interface CandidatePreflightUnitSweepResult<TUnit, TValue> {
  values: Map<TUnit, TValue>;
  failures: CandidatePreflightUnitFailure<TUnit>[];
  durationMs: number;
}

export interface CandidatePreflightUnitSweepOptions<TUnit, TValue> {
  units: readonly TUnit[];
  concurrency: number;
  perUnitTimeoutMs: number;
  signal?: AbortSignal;
  operationName: (unit: TUnit) => string;
  readUnit: (unit: TUnit, signal: AbortSignal) => Promise<TValue>;
}

/**
 * Run a provider candidate preflight over many independent units without
 * letting one wedged regional/zone endpoint poison the whole sweep. Failed units
 * are returned to the caller so provider probes can mark only those units
 * unknown while keeping successful reads authoritative.
 */
export async function runCandidatePreflightUnitSweep<TUnit, TValue>({
  units,
  concurrency,
  perUnitTimeoutMs,
  signal,
  operationName,
  readUnit,
}: CandidatePreflightUnitSweepOptions<TUnit, TValue>): Promise<
  CandidatePreflightUnitSweepResult<TUnit, TValue>
> {
  const startedAt = Date.now();
  const values = new Map<TUnit, TValue>();
  const failures: CandidatePreflightUnitFailure<TUnit>[] = [];
  let next = 0;
  const workerCount = Math.max(
    1,
    Math.min(Math.floor(concurrency) || 1, units.length || 1),
  );

  const worker = async (): Promise<void> => {
    while (next < units.length) {
      const unit = units[next]!;
      next += 1;
      const controller = new AbortController();
      const unitSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let removeAbortListener: (() => void) | undefined;
      try {
        signal?.throwIfAborted();
        const readPromise = readUnit(unit, unitSignal);
        const boundedRead = signal
          ? Promise.race([
              readPromise,
              new Promise<never>((_, reject) => {
                const abort = () =>
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new DOMException(
                          'The candidate preflight was aborted',
                          'AbortError',
                        ),
                  );
                removeAbortListener = () =>
                  signal.removeEventListener('abort', abort);
                if (signal.aborted) {
                  abort();
                } else {
                  signal.addEventListener('abort', abort, { once: true });
                }
              }),
            ])
          : readPromise;
        const value = await withTimeout(
          boundedRead,
          perUnitTimeoutMs,
          operationName(unit),
        );
        values.set(unit, value);
      } catch (error) {
        // withTimeout bounds our wait but cannot cancel a promise by itself.
        // Give provider SDKs the signal so timed-out reads do not continue
        // consuming sockets while the next partial sweep starts.
        controller.abort(error);
        failures.push({ unit, error });
      } finally {
        removeAbortListener?.();
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { values, failures, durationMs: Date.now() - startedAt };
}
