export interface DeadlineRetryOptions {
  deadline: number;
  initialDelayMs: number;
  maxDelayMs: number;
  now?: () => number;
  random?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
}

/** Retry a safe operation with jittered backoff, including one final deadline attempt. */
export async function retryUntilDeadline<T>(
  operation: () => Promise<T>,
  options: DeadlineRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  const shouldRetry = options.shouldRetry ?? (() => true);
  let delayMs = options.initialDelayMs;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const remainingMs = options.deadline - now();
      if (!shouldRetry(error) || remainingMs <= 0) throw error;

      const randomValue = Math.max(0, Math.min(1, random()));
      const jitteredDelayMs = Math.max(
        1,
        Math.round(delayMs * (0.5 + randomValue * 0.5)),
      );
      await wait(Math.min(jitteredDelayMs, remainingMs));
      delayMs = Math.min(options.maxDelayMs, delayMs * 2);
    }
  }
}
