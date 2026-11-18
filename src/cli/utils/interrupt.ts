/**
 * Ctrl-C handling for commands that run until the user stops them
 * (`status --watch`, `logs --follow`).
 *
 * Node's default SIGINT handler kills the process mid-request, which surfaces
 * as a spurious transport failure ("No local API is running") from whatever
 * call was in flight. These commands own SIGINT instead: Ctrl-C aborts their
 * own work, unwinds quietly, and exits 130.
 */

export const SIGINT_EXIT_CODE = 130;

export class InterruptedError extends Error {
  constructor(what: string) {
    super(`${what} interrupted`);
    this.name = 'InterruptedError';
  }
}

export function isInterrupted(error: unknown): boolean {
  return error instanceof InterruptedError;
}

/**
 * Run `work` with an abort signal wired to SIGINT, restoring the previous
 * handler on the way out. Ctrl-C aborts the signal with an `InterruptedError`,
 * so `work` can propagate the abort reason (a fetch signal, `sleep(ms, signal)`)
 * and callers get one error type back. Any result or failure produced after
 * the abort is replaced by `InterruptedError`: cancellation must not be
 * reported as a real transport error or mistaken for successful completion.
 */
export async function runUntilInterrupted<T>(
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort(new InterruptedError(what));
  };

  process.once('SIGINT', interrupt);
  try {
    const result = await work(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new InterruptedError(what);
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
  }
}
