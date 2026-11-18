import { stripVTControlCharacters } from 'node:util';

import type { CommandResult } from './types.js';
import type { ProbeRetryPolicy } from './wait.js';

type FailureSource = { readonly kind: 'database' };

/** Preserve the completed process evidence when an adapter rejects its result. */
export class CommandFailure extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
    readonly source?: FailureSource,
  ) {
    super(message, { cause: result });
  }
}

const unavailableStatuses = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

function databaseStatus(result: CommandResult): number | undefined {
  // The CLI may print the same terminal diagnostic to both output streams.
  // Additional or conflicting messages are not an unavailable-read receipt.
  const lines = stripVTControlCharacters(result.combined)
    .trim()
    .split(/\r?\n/u);
  const statuses = lines.map(
    (line) =>
      /^\s*(?:✗ Query failed: )?The (?:anycloud )?API is temporarily unavailable \(HTTP (\d{3})\)\.?(?: It may be restarting or updating; try again shortly\.)?$/u.exec(
        line,
      )?.[1],
  );
  if (
    statuses.some((status) => status === undefined) ||
    new Set(statuses).size !== 1
  )
    return undefined;
  return Number(statuses[0]);
}

/** Only use for read-only probes inside an existing deadline and abort scope. */
export const retryUnavailableApiRead: ProbeRetryPolicy = {
  retry(error) {
    if (!(error instanceof CommandFailure)) return false;
    const result = error.result;
    if (
      result.exitCode === null ||
      result.exitCode <= 0 ||
      result.timedOut ||
      result.aborted ||
      result.spawnError ||
      result.outputTruncated ||
      result.signal !== null
    ) {
      return false;
    }
    const status =
      error.source?.kind === 'database' ? databaseStatus(result) : undefined;
    return status !== undefined && unavailableStatuses.has(status);
  },
};
