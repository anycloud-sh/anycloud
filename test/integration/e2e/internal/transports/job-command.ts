import { setTimeout as pause } from 'node:timers/promises';

import type { ProcessRunner } from '../process.js';
import type { CommandResult } from '../types.js';
import { MAX_WAIT_MS, Waiter, type WaitOptions } from '../wait.js';

const PROVIDER_ENVIRONMENT =
  /^(?:AWS_|AZURE_|ARM_|CLOUDSDK_|GCLOUD_|GOOGLE_|GCP_|LAMBDA_|MSI_|IDENTITY_|BOTO_|ANYCLOUD_CLOUD_PROVIDER$)/iu;
const NATIVE_ERROR_CODES = [
  'NoSuchEntity',
  'NoSuchBucket',
  'NoSuchKey',
  'AccessDenied',
  'InvalidClientTokenId',
  'InvalidClientToken',
  'InvalidAccessKeyId',
  'UnrecognizedClientException',
  'AuthFailure',
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
  'ResourceNotFound',
  'Request_ResourceNotFound',
  'AuthorizationFailed',
  'Authorization_RequestDenied',
  'AuthenticationFailed',
  'PermissionDenied',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'ABORTED',
  'FAILED_PRECONDITION',
  'CONFLICT',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'RequestTimeout',
  'InternalError',
  'InternalFailure',
  'ServiceFailure',
  'ServiceUnavailable',
  'OperationNotAllowed',
  'Conflict',
  'AnotherOperationInProgress',
] as const;

/** Explicit undefined values survive ProcessRunner's merge with process.env. */
export function isolatedJobEnvironment(
  bindings: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const removed = Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => PROVIDER_ENVIRONMENT.test(name))
      .map((name) => [name, undefined]),
  );
  return {
    ...removed,
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    AWS_PAGER: '',
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    ...bindings,
  };
}

/**
 * Backoff for eventually consistent post-delete inventories (GCP
 * `serviceAccounts.list`, Entra `ad sp|app list`, ARM role assignments): ≈ 75 s,
 * always bounded by the cleanup deadline.
 */
export const INVENTORY_SETTLE_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
] as const;

export function jobOperationTimeout(
  deadlineAt: number,
  maximumMs = 30_000,
): number {
  const remaining = Math.min(maximumMs, deadlineAt - Date.now());
  if (!Number.isSafeInteger(remaining) || remaining <= 0)
    throw new Error('Job private operation deadline expired or is invalid');
  return remaining;
}

/**
 * `az rest` prints a failed response as `ERROR: <reason>(<body>)` (azure-cli
 * core `send_raw_request`); only Graph's `error.code` leaves this function.
 */
function graphErrorCode(stderr: string): string | undefined {
  const body = /^ERROR: [A-Za-z][A-Za-z ]*\((\{.*\})\)\s*$/u.exec(stderr)?.[1];
  if (body === undefined) return undefined;
  try {
    const code: unknown = (JSON.parse(body) as { error?: { code?: unknown } })
      .error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export class JobPrivateCommandFailure extends Error {
  readonly nativeCode: (typeof NATIVE_ERROR_CODES)[number] | undefined;
  readonly timedOut: boolean;

  constructor(result: CommandResult) {
    const completeFailure =
      result.exitCode !== null &&
      result.exitCode !== 0 &&
      result.signal === null &&
      !result.timedOut &&
      !result.aborted &&
      !result.outputTruncated &&
      !result.spawnError &&
      result.stdout.trim() === '';
    const code = completeFailure
      ? (/^\s*(?:aws: \[ERROR\]: )?An error occurred \(([A-Za-z0-9_]+)\) when calling the [A-Za-z]+ operation:[^\r\n]*\s*$/u.exec(
          result.stderr,
        )?.[1] ??
        /^ERROR: \(([A-Za-z0-9_]+)\)/mu.exec(result.stderr)?.[1] ??
        /^ERROR: \(gcloud\.[a-z.-]+\) ([A-Z_]+):/mu.exec(result.stderr)?.[1] ??
        (result.executable === 'az'
          ? graphErrorCode(result.stderr)
          : undefined))
      : undefined;
    const nativeCode = NATIVE_ERROR_CODES.find(
      (candidate) => candidate === code,
    );
    // `az ad` keeps only Graph's message, so this exact safe one is named
    // without inventing a code or retaining provider output. A command the
    // budget ended, or that gcloud refused as a usage error, is named as
    // such: neither is a provider outcome to read a native code from.
    const description =
      nativeCode ??
      (result.timedOut
        ? 'timeout'
        : result.aborted
          ? 'aborted'
          : result.exitCode === 2 &&
              result.executable === 'gcloud' &&
              /unrecognized arguments/u.test(result.stderr)
            ? 'gcloud usage error (unrecognized argument)'
            : completeFailure &&
                result.executable === 'az' &&
                result.stderr.trim() ===
                  'ERROR: Insufficient privileges to complete the operation.'
              ? 'Azure Graph insufficient-privileges message'
              : 'unclassified');
    super(
      `Job private command failed: ${description}; exit=${String(result.exitCode)}, signal=${String(result.signal)}, timeout=${result.timedOut}, aborted=${result.aborted}, truncated=${result.outputTruncated}, elapsed=${result.durationMs}ms`,
    );
    this.nativeCode = nativeCode;
    this.timedOut = result.timedOut;
  }
}

/** Nothing from a secret-producing command reaches the artifact recorder. */
export function privateJobOutput(result: CommandResult): string {
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.aborted ||
    result.outputTruncated ||
    result.spawnError
  )
    throw new JobPrivateCommandFailure(result);
  return result.stdout;
}

export class JobPrivateCommands {
  readonly #runner: Pick<ProcessRunner, 'run'>;
  readonly #signal: AbortSignal;

  constructor(runner: Pick<ProcessRunner, 'run'>, signal: AbortSignal) {
    this.#runner = runner;
    this.#signal = signal;
  }

  async wait(milliseconds: number, deadlineAt: number): Promise<void> {
    this.#signal.throwIfAborted();
    await pause(jobOperationTimeout(deadlineAt, milliseconds), undefined, {
      signal: this.#signal,
    });
    jobOperationTimeout(deadlineAt);
  }

  async run(
    executable: 'aws' | 'az' | 'gcloud' | 'node' | 'docker',
    args: readonly string[],
    bindings: Readonly<NodeJS.ProcessEnv>,
    deadlineAt: number,
    maximumMs = 30_000,
    stream: 'stdout' | 'combined' = 'stdout',
  ): Promise<string> {
    const timeoutMs = jobOperationTimeout(deadlineAt, maximumMs);
    this.#signal.throwIfAborted();
    // ProcessRunner owns cancellation and waits for the child to drain/reap.
    // Racing that promise would let cleanup begin before a timed-out mutation ends.
    let result: CommandResult;
    try {
      result = await this.#runner.run(executable, args, {
        env: isolatedJobEnvironment(bindings),
        recordArtifact: false,
        timeoutMs,
        signal: this.#signal,
      });
    } catch {
      throw new Error('Job private command did not return a process receipt');
    }
    const output = privateJobOutput(result);
    jobOperationTimeout(deadlineAt);
    return stream === 'combined' ? result.combined : output;
  }

  /** Waits until `deadlineAt`; `sleep` replaces the pause between probes. */
  waitFor<T>(
    label: string,
    probe: () => Promise<T>,
    options: Omit<WaitOptions<T>, 'timeoutMs'>,
    deadlineAt: number,
    sleep?: (milliseconds: number) => Promise<void>,
  ): Promise<T> {
    const timeoutMs = jobOperationTimeout(deadlineAt, MAX_WAIT_MS);
    const { intervalMs = 2_000 } = options;
    return new Waiter(this.#signal, sleep).for(label, probe, {
      ...options,
      timeoutMs,
      intervalMs:
        typeof intervalMs === 'number'
          ? Math.min(intervalMs, timeoutMs)
          : intervalMs,
    });
  }

  signal(deadlineAt: number, maximumMs = 30_000): AbortSignal {
    this.#signal.throwIfAborted();
    return AbortSignal.any([
      this.#signal,
      AbortSignal.timeout(jobOperationTimeout(deadlineAt, maximumMs)),
    ]);
  }
}

export function privateJobJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Job private command returned malformed JSON');
  }
}

/** Single-quote one shell word, escaping embedded quotes. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
