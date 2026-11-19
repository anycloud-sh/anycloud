import type { Command } from 'commander';
import { ORPCError } from '@orpc/client';
import {
  isApiRestart,
  networkErrorCode,
} from '../../shared/services/api-client/rpc.js';
import { LocalApiUnavailableError } from '../../shared/services/api-client/runtime.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { LocalApiStillStartingError } from '../services/local-api-update.js';
import { printError } from './output.js';

/**
 * Exit statuses of the lifecycle commands an embedding product drives
 * (`cluster create`, `node-pool create`, `node-pool delete`, `api upgrade`;
 * RFC 0049 C26 (d)), the same as `anycloud wait`'s: 0 done, 1 refused or
 * failed, 2 not run (a usage error, an unreachable API, or a sign-in it needs;
 * run it again), 4 a
 * wait timed out or the new local API was still starting, 130 Ctrl-C.
 */
export const NOT_RUN_EXIT_CODE = 2;

/** The `--help` lines every lifecycle command shares. */
export const LIFECYCLE_EXIT_HELP = `With --json, stdout holds one JSON document: the result, or
{"error": {"code", "message"}} with the API's error code or INVALID_ARGUMENT,
API_UNREACHABLE or UNEXPECTED, or {"actionRequired": {...}} when a GitHub
sign-in is needed (exit 2). Exit codes: 0 done, 1 refused or failed,
2 not run (a usage error, an unreachable API or a sign-in; run it again), 130 Ctrl-C
(no document).`;

/** A hosted API's upgrade `api upgrade --sign-in-apps` gave up waiting on; exits 4. */
export class HostedApiStillStartingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedApiStillStartingError';
  }
}

/** A flag or argument the command can't run with; exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * A request that never reached the API: a refused, reset or timed-out
 * connection (Node nests the network error as a TypeError's cause; Bun throws
 * it with its code), or no local API. A TypeError from our own code is not.
 */
function unreachable(error: unknown): boolean {
  if (error instanceof ORPCError) return isApiRestart(error);
  if (error instanceof LocalApiUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  const code = networkErrorCode(error);
  return (
    error.name === 'TimeoutError' ||
    error.message.includes('fetch failed') ||
    (typeof code === 'string' &&
      /^(ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_\w+|Connection\w+)$/.test(
        code,
      ))
  );
}

/**
 * The error document's code, the API's declared one or the CLI's own, and the
 * exit status. `ownCode` names a command's own failures (exit 1).
 */
export function lifecycleError(
  error: unknown,
  ownCode?: (error: unknown) => string | undefined,
): {
  code: string;
  message: string;
  exitCode: number;
} {
  const own = ownCode?.(error);
  const [code, exitCode] = own
    ? [own, 1]
    : error instanceof LocalApiStillStartingError
      ? ['LOCAL_API_STILL_STARTING', 4]
      : error instanceof HostedApiStillStartingError
        ? ['HOSTED_API_STILL_STARTING', 4]
        : error instanceof UsageError
          ? ['INVALID_ARGUMENT', NOT_RUN_EXIT_CODE]
          : unreachable(error)
            ? ['API_UNREACHABLE', NOT_RUN_EXIT_CODE]
            : error instanceof ORPCError && error.defined
              ? [error.code, 1]
              : ['UNEXPECTED', 1];
  return { code, message: errorMessage(error), exitCode };
}

/**
 * Report a lifecycle command's failure and exit: with `--json`, the one
 * document on stdout is `{"error": {"code", "message"}}`; otherwise
 * `<failure>: <message>` on stderr.
 */
export function exitWithLifecycleError(
  failure: string,
  error: unknown,
  json: boolean | undefined,
  ownCode?: (error: unknown) => string | undefined,
): never {
  const { exitCode, ...reported } = lifecycleError(error, ownCode);
  if (json) console.log(JSON.stringify({ error: reported }));
  else printError(`${failure}: ${reported.message}`);
  process.exit(exitCode);
}

/**
 * A usage error Commander finds (a missing or invalid option) exits 2 too,
 * with the error document when `--json` was given.
 */
export function withLifecycleUsageExit(command: Command): Command {
  return command.exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    if (process.argv.includes('--json')) {
      const document = { code: 'INVALID_ARGUMENT', message: error.message };
      console.log(JSON.stringify({ error: document }));
    }
    process.exit(NOT_RUN_EXIT_CODE);
  });
}
