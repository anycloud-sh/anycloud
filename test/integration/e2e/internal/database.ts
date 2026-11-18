import type { CliClient } from './cli.js';
import { cliArgs } from './cli-surface.js';
import { dbQueryResponseSchema } from '../../../../src/shared/api-contract/database-schemas.js';
import { awaitWithSignal } from '../../../../src/api/services/request-budget.js';
import { CommandFailure } from './read-retry.js';
import { isRecord } from './types.js';

export function escapedSql(value: string): string {
  return value.replaceAll("'", "''");
}

export function databaseInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))
  ) {
    throw new Error(`${label} was not an unsigned decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} was invalid`);
  }
  return parsed;
}

export class CliDatabase {
  readonly #cli: Pick<CliClient, 'run'>;

  constructor(cli: Pick<CliClient, 'run'>) {
    this.#cli = cli;
  }

  /** Native cleanup needs every row, including ended and partial attempts. */
  async queryComplete(
    sql: string,
    label: string,
    deadlineAt = Date.now() + 60_000,
  ): Promise<readonly Record<string, unknown>[]> {
    const timeoutMs = Math.min(60_000, deadlineAt - Date.now());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error('Database inventory deadline expired or is invalid');
    const result = await awaitWithSignal(
      this.#cli.run(cliArgs('db query', { json: true }, [sql]), {
        timeoutMs,
        label,
        recordArtifact: false,
      }),
      AbortSignal.timeout(timeoutMs),
    );
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.spawnError ||
      result.outputTruncated ||
      result.signal !== null
    ) {
      // The query itself failed; say how, or the failure reads like a budget.
      throw new Error(
        `Database inventory ${label} did not complete (exit ${String(result.exitCode)}, timed out ${String(result.timedOut)}, aborted ${String(result.aborted)}, signal ${String(result.signal)}, truncated ${String(result.outputTruncated)}): ${result.stderr.trim().slice(0, 400)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Database inventory ${label} was not JSON`);
    }
    const response = dbQueryResponseSchema.safeParse(parsed);
    if (
      !response.success ||
      response.data.truncated ||
      response.data.rowCount !== response.data.rows.length ||
      Date.now() >= deadlineAt
    ) {
      throw new Error(`Database inventory ${label} was incomplete or invalid`);
    }
    return response.data.rows;
  }

  async query(
    sql: string,
    label: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#cli.run(
      cliArgs('db query', { json: true }, [sql]),
      {
        timeoutMs: 60_000,
        label,
      },
    );
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.spawnError ||
      result.outputTruncated ||
      result.signal !== null
    ) {
      throw new CommandFailure(
        `Database query failed: ${result.combined}`,
        result,
        { kind: 'database' },
      );
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.rows) ||
      !parsed.rows.every(isRecord)
    ) {
      throw new Error(
        `Database query returned an unexpected shape: ${result.stdout}`,
      );
    }
    return parsed.rows;
  }
}
