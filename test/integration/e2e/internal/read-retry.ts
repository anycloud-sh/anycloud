import { stripVTControlCharacters } from 'node:util';

import { isRecord, type CommandResult } from './types.js';
import type { ProbeRetryPolicy } from './wait.js';

type FailureSource =
  | { readonly kind: 'database' }
  | { readonly kind: 'python-sdk'; readonly action: string };

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

function sdkStatus(result: CommandResult, action: string): number | undefined {
  if (
    !['get_deployment', 'list_deployments'].includes(action) ||
    result.stdout.trim()
  )
    return undefined;
  const exceptions = [
    ...result.stderr.matchAll(
      /^anycloud\.exceptions\.([A-Za-z_][A-Za-z0-9_]*): \((\d{3})\)\r?$/gmu,
    ),
  ];
  const receipts = result.stderr
    .split(/\r?\n/u)
    .filter((line) =>
      line.trimStart().startsWith('{"kind":"python-sdk-finalization"'),
    );
  if (exceptions.length !== 1 || receipts.length !== 1) return undefined;
  let receipt: unknown;
  try {
    receipt = JSON.parse(receipts[0]);
  } catch {
    return undefined;
  }
  if (
    !isRecord(receipt) ||
    receipt.kind !== 'python-sdk-finalization' ||
    receipt.action !== action ||
    receipt.client !== 'AsyncClient' ||
    receipt.transportClosed !== true ||
    receipt.pendingTasks !== 0 ||
    !Array.isArray(receipt.errors) ||
    receipt.errors.length !== 1
  )
    return undefined;
  const error: unknown = receipt.errors[0];
  if (
    !isRecord(error) ||
    error.phase !== 'action' ||
    error.type !== exceptions[0][1]
  )
    return undefined;
  return Number(exceptions[0][2]);
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
      error.source?.kind === 'database'
        ? databaseStatus(result)
        : error.source?.kind === 'python-sdk'
          ? sdkStatus(result, error.source.action)
          : undefined;
    return status !== undefined && unavailableStatuses.has(status);
  },
};
