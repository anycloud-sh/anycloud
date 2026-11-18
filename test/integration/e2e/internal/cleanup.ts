import { errorMessage } from './types.js';

interface CleanupEntry {
  readonly label: string;
  readonly action: () => Promise<void>;
  active: boolean;
}

export interface CleanupRegistration {
  complete(): void;
}

export class CleanupStack {
  readonly #entries: CleanupEntry[] = [];
  readonly #report: (message: string) => void;
  #finished = false;

  /** `report` sees each step start and finish, with its duration, as it happens. */
  constructor(report: (message: string) => void = () => undefined) {
    this.#report = report;
  }

  observations(): readonly { label: string; completed: boolean }[] {
    return this.#entries.map(({ label, active }) => ({
      label,
      completed: !active,
    }));
  }

  defer(label: string, action: () => Promise<void>): CleanupRegistration {
    if (this.#finished) {
      throw new Error(`Cannot register cleanup after teardown: ${label}`);
    }
    const entry: CleanupEntry = { label, action, active: true };
    this.#entries.push(entry);
    return {
      complete: () => {
        entry.active = false;
      },
    };
  }

  async run(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;

    const failures: Error[] = [];
    for (const entry of [...this.#entries].reverse()) {
      if (!entry.active) continue;
      const startedAt = Date.now();
      const elapsed = () =>
        `${String(Math.round((Date.now() - startedAt) / 1_000))}s`;
      this.#report(`cleanup: ${entry.label}`);
      try {
        await entry.action();
        entry.active = false;
        this.#report(`cleanup: ${entry.label} done in ${elapsed()}`);
      } catch (error) {
        this.#report(
          `cleanup: ${entry.label} failed in ${elapsed()}: ${errorMessage(error)}`,
        );
        failures.push(
          new Error(`${entry.label}: ${errorMessage(error)}`, {
            cause: error,
          }),
        );
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `E2E cleanup failed:\n- ${failures.map((failure) => failure.message).join('\n- ')}`,
      );
    }
  }
}
