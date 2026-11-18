/** One elapsed budget shared by authentication and the operation it admits. */
export interface RequestBudget {
  signal: AbortSignal;
  startedAt: number;
  deadlineAt: number;
}

const requestDeadlines = new WeakMap<
  AbortSignal,
  { deadlineAt: number; expire: () => void }
>();

/** Keep the elapsed cutoff available at dependency and transaction boundaries. */
export function registerRequestDeadline(
  signal: AbortSignal,
  deadlineAt: number,
  expire: () => void,
): void {
  requestDeadlines.set(signal, { deadlineAt, expire });
}

/** A delayed timer cannot extend the request or leave its dependencies active. */
export function assertRequestActive(signal?: AbortSignal): void {
  if (!signal) return;
  signal.throwIfAborted();
  const deadline = requestDeadlines.get(signal);
  if (deadline && performance.now() >= deadline.deadlineAt) deadline.expire();
  signal.throwIfAborted();
}

/** Bound a dependency even when its client cannot cancel the underlying work. */
export async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  let abort: () => void = () => undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      assertRequestActive(signal);
    });
    const result = await Promise.race([promise, cancelled]);
    assertRequestActive(signal);
    return result;
  } catch (error) {
    assertRequestActive(signal);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** A sequential poll sleep; the caller clips it to its observation cutoff. */
export async function waitForPoll(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  assertRequestActive(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await awaitWithSignal(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, milliseconds));
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
