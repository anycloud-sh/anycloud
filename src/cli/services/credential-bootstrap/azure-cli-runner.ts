import { execa, type ExecaError } from 'execa';

const AZURE_CLI_TIMEOUT_MS = 60_000;
const AZURE_CLI_MAX_BUFFER_BYTES = 1024 * 1024;
const AZURE_CLI_ERROR_MESSAGE_LIMIT = 2_000;

export interface AzureCliRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AzureCliCommandErrorDetails {
  code?: string;
  statusCode?: number;
  requestId?: string;
  exitCode?: number;
  aborted?: boolean;
  timedOut?: boolean;
  mayHaveSucceeded?: boolean;
}

export class AzureCliCommandError extends Error {
  readonly code?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly exitCode?: number;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly mayHaveSucceeded: boolean;

  constructor(message: string, details: AzureCliCommandErrorDetails = {}) {
    super(message);
    this.name = 'AzureCliCommandError';
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.requestId = details.requestId;
    this.exitCode = details.exitCode;
    this.aborted = details.aborted ?? false;
    this.timedOut = details.timedOut ?? false;
    this.mayHaveSucceeded = details.mayHaveSucceeded ?? false;
  }
}

interface AzureFailureDetails {
  code?: string;
  message?: string;
  statusCode?: number;
  requestId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) {
      return Number(value);
    }
  }
  return undefined;
}

function parseJsonError(stderr: string): AzureFailureDetails | undefined {
  const trimmed = stderr.trim().replace(/^ERROR:\s*/i, '');
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const root = record(JSON.parse(candidate));
      if (!root) continue;
      const detail = record(root.error) ?? root;
      const inner =
        record(detail.innerError) ??
        record(detail.innererror) ??
        record(detail.details);
      return {
        code: firstString(detail, ['code', 'Code']),
        message: firstString(detail, ['message', 'Message']),
        statusCode:
          firstNumber(detail, ['statusCode', 'status', 'httpStatusCode']) ??
          firstNumber(root, ['statusCode', 'status', 'httpStatusCode']),
        requestId:
          firstString(detail, [
            'requestId',
            'request-id',
            'clientRequestId',
            'client-request-id',
            'correlationId',
            'correlation-id',
          ]) ??
          firstString(inner, [
            'requestId',
            'request-id',
            'clientRequestId',
            'client-request-id',
            'correlationId',
            'correlation-id',
          ]),
      };
    } catch {
      // Azure CLI also emits a human envelope; parse that below.
    }
  }
  return undefined;
}

function parseHumanError(stderr: string): AzureFailureDetails {
  const code =
    stderr.match(/^\s*ERROR:\s*\(([^)]+)\)/im)?.[1]?.trim() ??
    stderr.match(/^\s*Code:\s*([^\s]+)\s*$/im)?.[1]?.trim();
  const explicitMessage = stderr.match(/^\s*Message:\s*(.+)$/im)?.[1]?.trim();
  const envelopeMessage = stderr
    .match(/^\s*ERROR:\s*(?:\([^)]+\)\s*)?(.+)$/im)?.[1]
    ?.trim();
  const statusCodeText = stderr.match(/\b(?:HTTP\s*)?([45]\d{2})\b/i)?.[1];
  const requestId = stderr
    .match(
      /\b(?:client[- ]?)?request(?:[- ]?id)?\s*[:=]\s*([A-Za-z0-9._:-]+)/i,
    )?.[1]
    ?.trim();
  return {
    ...(code ? { code } : {}),
    ...(explicitMessage || envelopeMessage
      ? { message: explicitMessage ?? envelopeMessage }
      : {}),
    ...(statusCodeText ? { statusCode: Number(statusCodeText) } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function collectSecretValues(value: unknown, secrets: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, secrets);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, nested] of Object.entries(object)) {
    if (
      typeof nested === 'string' &&
      /^(?:secretText|clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|password)$/i.test(
        key,
      )
    ) {
      if (nested) secrets.add(nested);
      continue;
    }
    collectSecretValues(nested, secrets);
  }
}

function secretsFromOutput(stdout: string): Set<string> {
  const secrets = new Set<string>();
  try {
    collectSecretValues(JSON.parse(stdout), secrets);
  } catch {
    for (const match of stdout.matchAll(
      /["']?(?:secretText|clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|password)["']?\s*[:=]\s*["']([^"'\s,}]+)["']/gi,
    )) {
      if (match[1]) secrets.add(match[1]);
    }
  }
  return secrets;
}

function redactDiagnostic(value: string, ...providerOutputs: string[]): string {
  let redacted = value;
  for (const output of providerOutputs) {
    for (const secret of secretsFromOutput(output)) {
      redacted = redacted.split(secret).join('<redacted>');
    }
  }
  redacted = redacted
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '<redacted>')
    .replace(
      /((?:secretText|clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|password)\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1<redacted>',
    );
  return redacted
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AZURE_CLI_ERROR_MESSAGE_LIMIT);
}

function commandError(
  error: ExecaError<{ encoding: 'latin1' }>,
  timeoutMs: number,
): AzureCliCommandError {
  const exitCode = error.isMaxBuffer ? undefined : error.exitCode;
  if (error.timedOut) {
    return new AzureCliCommandError(
      `Azure CLI command timed out after ${timeoutMs}ms.`,
      { exitCode, timedOut: true, mayHaveSucceeded: true },
    );
  }
  if (error.isMaxBuffer) {
    return new AzureCliCommandError(
      `Azure CLI output exceeded the ${AZURE_CLI_MAX_BUFFER_BYTES}-byte limit.`,
      {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        exitCode,
        mayHaveSucceeded: true,
      },
    );
  }

  const stdout = Buffer.from(error.stdout ?? '', 'latin1').toString('utf8');
  const stderr = Buffer.from(error.stderr ?? '', 'latin1').toString('utf8');
  const parsed = parseJsonError(stderr) ?? parseHumanError(stderr);
  const safeMessage = parsed.message
    ? redactDiagnostic(parsed.message, stdout, stderr)
    : '';
  const code =
    parsed.code ?? (typeof error.code === 'string' ? error.code : undefined);
  return new AzureCliCommandError(
    safeMessage ||
      (code
        ? `Azure CLI command failed (${code}).`
        : 'Azure CLI command failed.'),
    {
      code,
      statusCode: parsed.statusCode,
      requestId: parsed.requestId,
      exitCode,
    },
  );
}

/** Run Azure CLI without a shell and return its bounded stdout. */
export async function runAzureCli(
  args: readonly string[],
  options: AzureCliRunOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? AZURE_CLI_TIMEOUT_MS;
  let onAbort: (() => void) | undefined;
  try {
    const child = execa('az', args, {
      // Bun-compatible byte capture; see slurp/cli-exec.ts.
      encoding: 'latin1',
      stripFinalNewline: false,
      maxBuffer: AZURE_CLI_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      env: process.env,
      extendEnv: false,
      windowsHide: true,
      cleanup: false,
      forceKillAfterDelay: false,
      verbose: 'none',
    });
    let captureClosed = false;
    const stopCapture = () => {
      if (captureClosed) return;
      captureClosed = true;
      if (!child.nodeChildProcess.killed) child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.once('close', () => {
        if (!stream.readableEnded) stopCapture();
      });
    }
    // Execa signals on timeout but waits for inherited pipes. Close them on the
    // same deadline without resending SIGTERM; keep Execa's error classification.
    const captureDeadline =
      timeoutMs > 0 ? setTimeout(stopCapture, timeoutMs) : undefined;
    const canceled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        stopCapture();
        reject(
          new AzureCliCommandError('Azure CLI command was canceled.', {
            code: 'ABORT_ERR',
            aborted: true,
            mayHaveSucceeded: true,
          }),
        );
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    // Keep observing completion after cancellation, even if SIGTERM is ignored.
    const { stdout } = await Promise.race([child, canceled]).finally(() =>
      clearTimeout(captureDeadline),
    );
    return Buffer.from(stdout, 'latin1').toString('utf8');
  } catch (error) {
    if (error instanceof AzureCliCommandError) throw error;
    throw commandError(error as ExecaError<{ encoding: 'latin1' }>, timeoutMs);
  } finally {
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
