/**
 * Stage timeline for the run log. Writes straight to stderr: Vitest buffers
 * console output until the test ends, and a job cancelled at its timeout
 * never gets there — the timeline is then all that says how far the run got.
 */
export class StageProgress {
  readonly #write: (line: string) => void;

  constructor(
    write: (line: string) => void = (line) => process.stderr.write(line),
  ) {
    this.#write = write;
  }

  mark(stage: string): void {
    this.#write(`[e2e ${new Date().toISOString()}] ${stage}\n`);
  }
}
