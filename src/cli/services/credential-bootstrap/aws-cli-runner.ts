import { execa, type ExecaError } from 'execa';
import { withRetry } from '../../../shared/utils.js';

const CLI_TIMEOUT_MS = 60_000;
const CLI_MAX_BUFFER_BYTES = 1024 * 1024;

const READ_OPERATIONS = new Map([
  ['sts get-caller-identity', 'STS GetCallerIdentity'],
  ['iam get-user', 'IAM GetUser'],
  ['iam list-user-tags', 'IAM ListUserTags'],
]);
// A replay after a lost success answers NoSuchEntity, which cleanup treats as done.
const IDEMPOTENT_DELETES = new Map([
  ['iam delete-access-key', 'IAM DeleteAccessKey'],
  ['iam delete-user-policy', 'IAM DeleteUserPolicy'],
  ['iam delete-user', 'IAM DeleteUser'],
]);
const OTHER_OPERATIONS = new Map([
  ['iam create-user', 'IAM CreateUser'],
  ['iam put-user-policy', 'IAM PutUserPolicy'],
  ['iam create-access-key', 'IAM CreateAccessKey'],
]);

type FailureCategory =
  | 'CLI unavailable'
  | 'command timeout'
  | 'output limit exceeded'
  | 'authentication failure'
  | 'permission denied'
  | 'throttling'
  | 'temporary service error'
  | 'provider error'
  | 'connection timeout'
  | 'read timeout'
  | 'connection failure'
  | 'command failure';

const PROVIDER_ERRORS = new Map<string, FailureCategory>([
  ['NoSuchEntity', 'provider error'],
  ['EntityAlreadyExists', 'provider error'],
  ['AccessDenied', 'permission denied'],
  ['AccessDeniedException', 'permission denied'],
  ['UnauthorizedOperation', 'permission denied'],
  ['InvalidClientTokenId', 'authentication failure'],
  ['InvalidAccessKeyId', 'authentication failure'],
  ['UnrecognizedClientException', 'authentication failure'],
  ['ExpiredToken', 'authentication failure'],
  ['ExpiredTokenException', 'authentication failure'],
  ['SignatureDoesNotMatch', 'authentication failure'],
  ['InvalidSignatureException', 'authentication failure'],
  ['LimitExceeded', 'provider error'],
  ['InvalidInput', 'provider error'],
  ['ValidationError', 'provider error'],
  ['MalformedPolicyDocument', 'provider error'],
  ['Throttling', 'throttling'],
  ['ThrottlingException', 'throttling'],
  ['TooManyRequestsException', 'throttling'],
  ['RequestLimitExceeded', 'throttling'],
  ['RequestTimeout', 'read timeout'],
  ['RequestTimeoutException', 'read timeout'],
  ['ServiceFailure', 'temporary service error'],
  ['InternalFailure', 'temporary service error'],
  ['InternalError', 'temporary service error'],
  ['ServiceUnavailable', 'temporary service error'],
  ['ServiceUnavailableException', 'temporary service error'],
]);
const TRANSIENT_FAILURES = new Set<FailureCategory>([
  'command timeout',
  'connection timeout',
  'read timeout',
  'connection failure',
  'throttling',
  'temporary service error',
]);

export interface AWSOperator {
  profile: string;
  environment: NodeJS.ProcessEnv;
}

/** Keep the selected profile's configuration, not ambient credential overrides. */
export function awsOperatorEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const profileSettings = new Set([
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_LOGIN_CACHE_DIRECTORY',
    'AWS_CA_BUNDLE',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !name.startsWith('AWS_') || profileSettings.has(name),
      ),
    ),
    AWS_EC2_METADATA_DISABLED: 'true',
    // Botocore otherwise falls back to legacy, non-profile Boto credentials.
    BOTO_CONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    AWS_CLI_AUTO_PROMPT: 'off',
    AWS_PAGER: '',
    // Each subprocess dispatches once; only allowlisted reads and idempotent
    // deletes may be retried by runAWSCLI within its shared deadline.
    // https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html
    AWS_MAX_ATTEMPTS: '1',
    AWS_RETRY_MODE: 'standard',
  };
}

export class AWSCliError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly category: FailureCategory = 'command failure',
  ) {
    super(message);
    this.name = 'AWSCliError';
  }
}

/** Whether the runner retries this failure on a read-only command or an idempotent delete. */
export function isTransientAWSCliFailure(error: unknown): boolean {
  return error instanceof AWSCliError && TRANSIENT_FAILURES.has(error.category);
}

export function awsOperator(
  profile: string,
  environment: NodeJS.ProcessEnv = process.env,
): AWSOperator {
  if (
    !profile.trim() ||
    profile.startsWith('-') ||
    [...profile].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('Select a valid AWS operator profile with --profile.');
  }
  return { profile, environment: awsOperatorEnvironment(environment) };
}

/** Classify diagnostics without retaining output, argv, credentials, or causes. */
function classifyFailure(
  error: unknown,
  deadlineExpired: boolean,
): AWSCliError {
  const failure = error as ExecaError<{ encoding: 'latin1' }>;
  let category: FailureCategory = 'command failure';
  let code: string | undefined;
  if (failure.code === 'ENOENT') {
    category = 'CLI unavailable';
  } else if (failure.isMaxBuffer) {
    category = 'output limit exceeded';
  } else if (failure.timedOut || deadlineExpired) {
    category = 'command timeout';
  } else {
    const stderr = Buffer.from(failure.stderr ?? '', 'latin1').toString('utf8');
    // Credential helpers may embed provider errors from their own requests.
    if (
      /Unable to locate credentials|Error when retrieving credentials|SSO session.*(?:expired|invalid)|config profile .* could not be found/i.test(
        stderr,
      )
    ) {
      return new AWSCliError(
        'AWS CLI command failed.',
        undefined,
        'authentication failure',
      );
    }
    const providerCode = stderr.match(
      /An error occurred \(([^)\r\n]+)\) when calling /,
    )?.[1];
    if (providerCode) {
      // A provider rejection takes precedence over words in its message.
      // Unknown codes remain terminal and cannot escape the allowlist.
      const knownCategory = PROVIDER_ERRORS.get(providerCode);
      if (knownCategory) {
        code = providerCode;
        category = knownCategory;
      }
    } else if (
      /Connect timeout on endpoint URL|ConnectTimeoutError/i.test(stderr)
    ) {
      category = 'connection timeout';
    } else if (/Read timeout on endpoint URL|ReadTimeoutError/i.test(stderr)) {
      category = 'read timeout';
    } else if (
      /(?:Could not|Failed to) connect to (?:the )?(?:endpoint|proxy) URL|ConnectionClosedError|connection (?:was )?(?:closed|reset)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|NameResolutionError|socket hang up/i.test(
        stderr,
      )
    ) {
      category = 'connection failure';
    }
  }
  return new AWSCliError('AWS CLI command failed.', code, category);
}

async function runAWSCLIAttempt(
  operator: AWSOperator,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  retryable: boolean,
): Promise<string> {
  const child = execa(
    'aws',
    [
      ...args,
      '--profile',
      operator.profile,
      '--output',
      'json',
      '--no-cli-pager',
      '--no-cli-auto-prompt',
      '--cli-connect-timeout',
      '10',
      '--cli-read-timeout',
      '45',
    ],
    {
      // Bun-compatible byte capture; see slurp/cli-exec.ts.
      encoding: 'latin1',
      stripFinalNewline: false,
      timeout: timeoutMs,
      cancelSignal: signal,
      maxBuffer: CLI_MAX_BUFFER_BYTES,
      windowsHide: true,
      env: awsOperatorEnvironment(operator.environment),
      extendEnv: false,
      cleanup: false,
      forceKillAfterDelay: false,
      // A stalled retryable call must not outlive the total retry budget.
      killSignal: retryable ? 'SIGKILL' : 'SIGTERM',
      verbose: 'none',
    },
  );
  let captureClosed = false;
  const stopCapture = () => {
    if (captureClosed) return;
    captureClosed = true;
    if (!child.nodeChildProcess.killed)
      child.kill(retryable ? 'SIGKILL' : 'SIGTERM');
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.once('close', () => {
      if (!stream.readableEnded) stopCapture();
    });
  }
  // Close inherited pipes at the deadline too; see azure-cli-runner.ts.
  const captureDeadline = setTimeout(stopCapture, timeoutMs);
  signal.addEventListener('abort', stopCapture, { once: true });
  const { stdout } = await child.finally(() => {
    clearTimeout(captureDeadline);
    signal.removeEventListener('abort', stopCapture);
  });
  return Buffer.from(stdout, 'latin1').toString('utf8');
}

/** Retry only named reads and idempotent deletes; other IAM mutations are never replayed. */
export async function runAWSCLI(
  operator: AWSOperator,
  args: readonly string[],
): Promise<string> {
  const key = `${args[0]} ${args[1]}`;
  const readOnly = READ_OPERATIONS.has(key);
  const retryable = readOnly || IDEMPOTENT_DELETES.has(key);
  // Operation names are fixed labels, never user-controlled arguments.
  const operation =
    READ_OPERATIONS.get(key) ??
    IDEMPOTENT_DELETES.get(key) ??
    OTHER_OPERATIONS.get(key) ??
    'AWS CLI command';
  const startedAt = Date.now();
  const budget = new AbortController();
  const deadline = setTimeout(() => budget.abort(), CLI_TIMEOUT_MS);
  let attempts = 0;
  let lastFailure: AWSCliError | undefined;
  try {
    return await withRetry(
      async () => {
        const remainingMs = CLI_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          budget.abort();
          throw lastFailure ?? new AWSCliError('AWS CLI retry budget expired.');
        }
        attempts += 1;
        try {
          return await runAWSCLIAttempt(
            operator,
            args,
            budget.signal,
            remainingMs,
            retryable,
          );
        } catch (error) {
          lastFailure = classifyFailure(error, budget.signal.aborted);
          throw lastFailure;
        }
      },
      operation,
      {
        maxAttempts: retryable ? 3 : 1,
        waitMs: 1_000,
        maxWaitMs: 2_000,
        jitterFloorFraction: 0.5,
        signal: budget.signal,
        shouldRetry: (error) => retryable && isTransientAWSCliFailure(error),
      },
    );
  } catch {
    const failure =
      lastFailure ??
      new AWSCliError('AWS CLI timed out.', undefined, 'command timeout');
    const detail =
      failure.category === 'CLI unavailable'
        ? 'AWS CLI is not installed'
        : failure.category;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    throw new AWSCliError(
      `${operation} failed after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} (${elapsedMs} ms): ${detail}${failure.code ? ` (${failure.code})` : ''}.` +
        (!readOnly && isTransientAWSCliFailure(failure)
          ? ' The request may have succeeded.'
          : ''),
      failure.code,
      failure.category,
    );
  } finally {
    clearTimeout(deadline);
  }
}
