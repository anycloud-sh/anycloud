import { sleep, withTimeout } from '../../../shared/utils.js';

export const VM_RESTART_CONSECUTIVE_OBSERVATIONS = 3;

/** Tracks the budget for restart observations, retries, and settling. */
export class VMRestartAttempt {
  readonly startedAt = Date.now();
  readonly deadlineAt = this.startedAt + 5 * 60_000;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  constructor(private readonly description: string) {}

  remainingMs(deadlineAt = this.deadlineAt): number {
    const remaining = Math.min(deadlineAt, this.deadlineAt) - Date.now();
    if (remaining <= 0 || this.signal.aborted) {
      throw new Error(`${this.description} deadline exceeded`);
    }
    return remaining;
  }

  async run<T>(
    operation: () => Promise<T>,
    deadlineAt = this.deadlineAt,
  ): Promise<T> {
    const remaining = this.remainingMs(deadlineAt);
    const result = await withTimeout(operation(), remaining, this.description);
    // An SDK can ignore cancellation or return after a clock/deadline change.
    // Late observations must never authorize another mutation or success.
    this.remainingMs(deadlineAt);
    return result;
  }

  wait(deadlineAt = this.deadlineAt): Promise<void> {
    return this.run(
      () => sleep(Math.min(5000, this.remainingMs(deadlineAt)), this.signal),
      deadlineAt,
    );
  }

  abort(): void {
    this.controller.abort();
  }
}
