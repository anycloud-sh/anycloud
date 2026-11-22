import { errorMessage } from './types.js';

export interface WaitOptions<T> {
  readonly timeoutMs: number;
  /**
   * A number is the pause between probes. A schedule is the pause before each
   * retry, and the wait gives up once the schedule runs out.
   */
  readonly intervalMs?: number | readonly number[];
  /**
   * `'fail'` propagates the first probe error. A retry policy must name which
   * errors it is willing to wait through, so a permanent failure such as a
   * rejected credential aborts with its own message instead of being polled to
   * the deadline and reported as a bare timeout.
   */
  readonly probeError: 'fail' | ProbeRetryPolicy;
  /**
   * `undefined` accepts. A string names the condition that is not yet met and
   * is exactly what a timeout reports, so the decision to keep waiting and the
   * explanation for having waited cannot drift apart.
   */
  readonly unmet: (value: T) => string | undefined;
  /** A string aborts now: this outcome can no longer become acceptable. */
  readonly reject?: (value: T) => string | undefined;
}

export const MAX_WAIT_MS = 2 * 60 * 60 * 1000;

/** A failure that cannot become transient, however long the wait continues. */
const PERMANENT_PROBE_FAILURE =
  /\b40[13]\b|unauthoriz|unauthenticated|forbidden|invalid credential|authentication failed|access denied|credential mismatch/iu;

export interface ProbeRetryPolicy {
  readonly retry: (error: unknown) => boolean;
}

/**
 * The ordinary policy: a resource that is not up yet fails in many ways, so
 * keep waiting through anything except a rejected credential.
 */
export const retryTransientProbeError: ProbeRetryPolicy = {
  retry: (error) => !PERMANENT_PROBE_FAILURE.test(errorMessage(error)),
};

export class WaitDeadlineExceeded extends Error {}

export class WaitTimeoutError extends Error {}

/** For a retry whose callers expect its last attempt's own error. */
export function rethrowLastAttempt(error: unknown): never {
  throw error instanceof WaitTimeoutError && error.cause ? error.cause : error;
}

function validateDuration(name: string, value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}ms`);
  }
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('E2E wait aborted');
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('E2E wait aborted'));
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function probeBeforeDeadline<T>(
  probe: () => Promise<T>,
  remainingMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (remainingMs <= 0) throw new WaitDeadlineExceeded();
  if (signal.aborted) throw new Error('E2E wait aborted');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      action();
    };
    const abort = (): void =>
      finish(() => reject(new Error('E2E wait aborted')));
    const timer = setTimeout(
      () => finish(() => reject(new WaitDeadlineExceeded())),
      remainingMs,
    );
    signal.addEventListener('abort', abort, { once: true });
    void probe().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error('E2E wait probe rejected with a non-Error value', {
                  cause: error,
                }),
          ),
        ),
    );
  });
}

export class Waiter {
  readonly #signal: AbortSignal;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  /** `sleep` replaces the pause between probes, for example with a session's deadline-bounded wait. */
  constructor(
    signal: AbortSignal,
    sleep = (milliseconds: number) => pause(milliseconds, signal),
  ) {
    this.#signal = signal;
    this.#sleep = sleep;
  }

  async for<T>(
    label: string,
    probe: (deadlineAt: number) => Promise<T>,
    options: WaitOptions<T>,
  ): Promise<T> {
    validateDuration('wait timeout', options.timeoutMs, MAX_WAIT_MS);
    const pacing = options.intervalMs ?? 2_000;
    // A schedule entry may exceed the time left; the wait shortens that pause.
    if (typeof pacing === 'number')
      validateDuration('wait interval', pacing, options.timeoutMs);
    else
      for (const pauseMs of pacing)
        if (pauseMs !== 0)
          validateDuration('wait interval', pauseMs, MAX_WAIT_MS);

    const startedAt = Date.now();
    const deadline = startedAt + options.timeoutMs;
    let lastUnmet: string | undefined;
    let lastError: Error | undefined;
    let observed = false;
    let attempts = 0;
    const nextPause = (): number | undefined =>
      typeof pacing === 'number' ? pacing : pacing[attempts - 1];
    const pauseBeforeRetry = async (): Promise<boolean> => {
      const remainingMs = deadline - Date.now();
      const pauseMs = nextPause();
      if (remainingMs <= 0 || pauseMs === undefined) return false;
      await this.#sleep(Math.min(pauseMs, remainingMs));
      return true;
    };
    while (Date.now() < deadline) {
      if (this.#signal.aborted) throw new Error(`${label}: wait aborted`);
      attempts += 1;
      let value: T;
      try {
        value = await probeBeforeDeadline(
          () => probe(deadline),
          deadline - Date.now(),
          this.#signal,
        );
      } catch (error) {
        if (error instanceof WaitDeadlineExceeded) break;
        if (options.probeError === 'fail' || !options.probeError.retry(error)) {
          throw error;
        }
        lastError = error as Error;
        if (!(await pauseBeforeRetry())) break;
        continue;
      }
      observed = true;
      lastError = undefined;
      const rejection = options.reject?.(value);
      if (rejection) throw new Error(`${label}: ${rejection}`);
      lastUnmet = options.unmet(value);
      if (lastUnmet === undefined && Date.now() <= deadline) return value;
      if (!(await pauseBeforeRetry())) break;
    }

    // A wait that ends while its probe is failing must say so. Reporting only
    // the last accepted value hides a credential that broke mid-wait behind a
    // stale observation.
    const unmetReport = observed
      ? (lastUnmet ?? 'accepted after the deadline')
      : 'no observation';
    const observation =
      lastError === undefined
        ? unmetReport
        : observed
          ? `${unmetReport}; last probe error: ${errorMessage(lastError)}`
          : errorMessage(lastError);
    throw new WaitTimeoutError(
      `${label}: ${nextPause() === undefined ? `gave up after ${attempts} attempts` : `timed out after ${options.timeoutMs}ms`} (last observation: ${observation})`,
      { cause: lastError },
    );
  }
}
