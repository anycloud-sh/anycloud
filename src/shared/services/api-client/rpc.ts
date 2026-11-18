import {
  createORPCClient,
  isORPCErrorJson,
  ORPCError,
  type ClientContext,
} from '@orpc/client';
import { ClientRetryPlugin } from '@orpc/client/plugins';
import { type ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import {
  OpenAPILink,
  type OpenAPILinkOptions,
} from '@orpc/openapi-client/fetch';
import { apiContract } from '../../api-contract/contract.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../api-version.js';
import { type ApiContractMeta } from '../../api-contract/base.js';
import { apiContractProcedurePolicy as procedurePolicy } from '../../api-contract/inspection.js';
import {
  getLoopbackApiPort,
  normalizeApiUrl,
  resolveApiTarget,
  type ResolvedApiTarget,
} from '../../config.js';
import { githubSignInHeader } from '../auth.js';
import {
  type ApiUnavailableGuidance,
  apiUnavailableDiagnostics,
  temporaryApiUnavailableMessage,
} from './outage.js';
import { retryAfterMs } from '../../retry-after.js';
import {
  assertLocalApiRunning,
  getAnycloudVersion,
  throwIfAborted,
} from './runtime.js';

const DEFAULT_RETRY_DELAY_MS = 500;
const NOT_PROCESSED_RETRY_DELAY_MS = 1_000;
const RETRY_COUNTS = {
  never: 0,
  safe: 2,
  'not-processed': 4,
} as const satisfies Record<ApiContractMeta['replay'], number>;
/**
 * A hosted upgrade replaces the single API Pod: about 20–60 s of 503s, and a
 * second, shorter gap if its chart repair restarts it. Backoff from 0.5 s to
 * 5 s waits at most 26 retries or 120 s from the first failure.
 */
const RESTART_RETRIES = 26;
const RESTART_BUDGET_MS = 120_000;
const RESTART_MAX_DELAY_MS = 5_000;
/**
 * The edge with no API behind it; 520–523 are Cloudflare's origin errors.
 * 524 is not: the origin accepted the request and answered nothing for 100 s.
 */
const RESTART_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523]);
/** fetch's network causes for an API that is gone or going, not misconfigured. */
const RESTART_CAUSES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
]);
/**
 * A cloud provider throttling a bucket call, answered as `BUCKET_THROTTLED`
 * with its `Retry-After`. Its own budget from the first throttled answer, so
 * it neither spends nor extends the restart ride-out.
 */
const THROTTLE_RETRIES = 8;
const THROTTLE_BUDGET_MS = 30_000;
const THROTTLE_MAX_DELAY_MS = 8_000;
/**
 * A role connection the cloud has not granted yet, answered as
 * `ROLE_CONNECTION_PENDING`: GCP IAM took 61–91 s to admit a new binding in
 * the spikes. Each save makes one exchange, so it is repeated.
 */
const ROLE_PENDING_BUDGET_MS = 150_000;
const ROLE_PENDING_DELAY_MS = 15_000;
/** Once per process: a `--watch` loop makes many clients. */
let restartAnnounced = false;

export type ApiClient = JsonifiedClient<
  ContractRouterClient<typeof apiContract>
>;

export interface CreateApiClientOptions {
  apiUrl?: string;
  /** An already resolved target, so its local API inspection is reused. */
  target?: Pick<ResolvedApiTarget, 'url' | 'localApiContainer'>;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number | null;
  retryDelayMs?: number;
  /** Run around each call and see its decoded error. */
  interceptors?: OpenAPILinkOptions<ClientContext>['interceptors'];
}

/** One call's retries; budgets for each failure kind start at its first. */
interface CallRetries {
  firstFailureAt?: number;
  throttledAt?: number;
  throttleRetries: number;
  pendingAt?: number;
  pendingRetries: number;
  /** The last 503's headers, for its `Retry-After`. */
  headers?: Headers;
}

function isRoleConnectionPending(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    error.defined &&
    error.code === 'ROLE_CONNECTION_PENDING'
  );
}

function isBucketThrottled(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    error.defined &&
    error.code === 'BUCKET_THROTTLED'
  );
}

/** Jittered exponential backoff from 1 s to 8 s, no earlier than `Retry-After`. */
function throttleDelayMs(call: CallRetries): number {
  const ceiling = Math.min(
    1_000 * 2 ** (call.throttleRetries - 1),
    THROTTLE_MAX_DELAY_MS,
  );
  const backoff = ceiling / 2 + (Math.random() * ceiling) / 2;
  const now = Date.now();
  const remaining = (call.throttledAt ?? 0) + THROTTLE_BUDGET_MS - now;
  const retryAfter = retryAfterMs(call.headers, now) ?? 0;
  return Math.max(0, Math.min(Math.max(backoff, retryAfter), remaining));
}

function retryDelayMs(
  path: readonly string[],
  error: unknown,
  attemptIndex: number,
): number {
  if (isApiRestart(error)) {
    return Math.min(500 * 2 ** attemptIndex, RESTART_MAX_DELAY_MS);
  }
  return procedurePolicy(path).replay === 'not-processed'
    ? NOT_PROCESSED_RETRY_DELAY_MS
    : DEFAULT_RETRY_DELAY_MS;
}

function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error instanceof TypeError ||
    error.message.includes('fetch failed') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ECONNRESET') ||
    error.message.includes('UND_ERR_SOCKET') ||
    error.message.includes('EPIPE')
  );
}

/**
 * The draining API's declared answer, an edge with no API behind it, or a
 * refused or reset connection. A timeout, a DNS or TLS failure, or a
 * TypeError from our own code is not a restart.
 */
export function isApiRestart(error: unknown): boolean {
  if (error instanceof ORPCError) {
    return error.defined
      ? error.code === 'API_RESTARTING'
      : RESTART_STATUSES.has(error.status);
  }
  const code = networkErrorCode(error);
  return code !== undefined && RESTART_CAUSES.has(code);
}

/**
 * Node's fetch nests the network error as the TypeError's cause; Bun, which
 * runs the shipped CLI, throws it directly. Bun's `ConnectionRefused` also
 * covers DNS failures, so it isn't a restart cause.
 */
export function networkErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { cause } = error as { cause?: unknown };
  const failure =
    error instanceof TypeError && typeof cause === 'object' && cause !== null
      ? cause
      : error;
  const { code } = failure as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function isDeclaredServiceUnavailable(
  path: readonly string[],
  error: ORPCError<string, unknown>,
): boolean {
  if (!error.defined || error.status !== 503) return false;
  return procedurePolicy(path).declaredServiceUnavailableCodes.has(error.code);
}

function apiUnavailableGuidance(
  path: readonly string[],
  method: string,
): ApiUnavailableGuidance {
  if (procedurePolicy(path).replay === 'safe') return 'retry';
  // `never` can also mean a read intentionally opts out of automatic retries;
  // that does not make the read's outcome ambiguous to the user.
  return method === 'GET' || method === 'HEAD' ? 'retry' : 'verify';
}

async function normalizeServerResponse(
  response: Response,
  path: readonly string[],
  method: string,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  if (response.status < 500) return response;

  let rawBody = '';
  let body: unknown;
  try {
    rawBody = await response.clone().text();
    body = JSON.parse(rawBody);
  } catch {
    // The response is handled below as a malformed upstream 5xx.
  }
  throwIfAborted(callerSignal);

  if (isORPCErrorJson(body)) {
    const contentType = response.headers.get('content-type');
    if (!contentType || contentType.startsWith('application/json')) {
      return response;
    }

    // oRPC v1 chooses its body parser from Content-Type before decoding the
    // error envelope. Correct a valid envelope mislabeled by an intermediary.
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const guidance = apiUnavailableGuidance(path, method);
  throw new ORPCError('SERVICE_UNAVAILABLE', {
    status: response.status,
    message: temporaryApiUnavailableMessage(response.status, guidance),
    data: apiUnavailableDiagnostics(response, rawBody),
  });
}

function retryable(path: readonly string[], error: unknown): boolean {
  const { replay } = procedurePolicy(path);
  if (replay === 'never') return false;
  if (error instanceof ORPCError) {
    return replay === 'not-processed'
      ? isDeclaredServiceUnavailable(path, error)
      : error.status >= 500;
  }
  // A transport failure can happen after a request reaches the server. Only a
  // declared 503 handled above, such as API_RESTARTING, proves that a
  // pre-side-effect operation did not start; a proxy's undefined 503 does not.
  if (replay === 'not-processed') return false;
  return isTransportError(error) || isApiRestart(error);
}

function requestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | null,
): AbortSignal {
  if (timeoutMs === null) return callerSignal ?? new AbortController().signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

function procedureTimeoutMs(
  path: readonly string[],
  request: Request,
): number | null {
  const meta = procedurePolicy(path);
  if (!meta.waitMsTimeout) return meta.timeoutMs;

  const rawWaitMs = new URL(request.url).searchParams.get('waitMs');
  if (rawWaitMs === null) return meta.timeoutMs;
  const waitMs = Number(rawWaitMs);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return meta.timeoutMs;
  return Math.max(
    meta.waitMsTimeout.minimumMs,
    Math.floor(waitMs) + meta.waitMsTimeout.graceMs,
  );
}

/**
 * Direct contract client for JSON control-plane procedures. No generated code
 * or parallel DTO layer is involved; the CLI consumes the shared contract type.
 */
export function createApiClient(
  accessToken: string,
  options: CreateApiClientOptions = {},
): ApiClient {
  const target =
    options.target ??
    (options.apiUrl
      ? { url: normalizeApiUrl(options.apiUrl) }
      : resolveApiTarget());
  const apiUrl = target.url;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  // Each call's retries, by its per-call context object.
  const calls = new WeakMap<object, CallRetries>();
  const callRetries = (context: object): CallRetries => {
    let call = calls.get(context);
    if (!call)
      calls.set(context, (call = { throttleRetries: 0, pendingRetries: 0 }));
    return call;
  };
  const otherRetries = (attemptIndex: number, context: object) => {
    const call = callRetries(context);
    return attemptIndex - call.throttleRetries - call.pendingRetries;
  };
  const retryPlugin = new ClientRetryPlugin({
    default: {
      // Counted per failure kind in shouldRetry.
      retry: Number.POSITIVE_INFINITY,
      retryDelay: ({ path, error, attemptIndex, context }) =>
        options.retryDelayMs ??
        (isBucketThrottled(error)
          ? throttleDelayMs(callRetries(context))
          : isRoleConnectionPending(error)
            ? ROLE_PENDING_DELAY_MS
            : retryDelayMs(path, error, otherRetries(attemptIndex, context))),
      shouldRetry: ({ path, error, signal, attemptIndex, context }) => {
        const call = callRetries(context);
        if (signal?.aborted || !retryable(path, error)) return false;
        if (isBucketThrottled(error)) {
          call.throttledAt ??= Date.now();
          if (
            call.throttleRetries >= THROTTLE_RETRIES ||
            Date.now() - call.throttledAt >= THROTTLE_BUDGET_MS
          ) {
            return false;
          }
          call.throttleRetries += 1;
          return true;
        }
        if (isRoleConnectionPending(error)) {
          call.pendingAt ??= Date.now();
          if (Date.now() - call.pendingAt >= ROLE_PENDING_BUDGET_MS)
            return false;
          if (call.pendingRetries === 0)
            process.stderr.write(`${(error as Error).message}\n`);
          call.pendingRetries += 1;
          return true;
        }
        // Other failures keep their profiles, with throttling and waiting for
        // a role connection left out of their counts and their wall clock.
        const retries = otherRetries(attemptIndex, context);
        call.firstFailureAt ??= Date.now();
        if (!isApiRestart(error)) {
          return retries < RETRY_COUNTS[procedurePolicy(path).replay];
        }
        const elapsed = Date.now() - call.firstFailureAt;
        if (retries >= RESTART_RETRIES || elapsed >= RESTART_BUDGET_MS) {
          process.stderr.write(
            `API still unavailable after ${retries} retries.\n`,
          );
          return false;
        }
        if (!restartAnnounced) {
          process.stderr.write('API restarting, waiting…\n');
          restartAnnounced = true;
        }
        return true;
      },
    },
  });

  const link = new OpenAPILink<ClientContext>(apiContract, {
    url: `${apiUrl}/v1`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
      ...githubSignInHeader(apiUrl),
    },
    plugins: [retryPlugin],
    interceptors: options.interceptors,
    fetch: async (request, init, clientOptions, path) => {
      assertLocalApiRunning(target);
      const contractTimeoutMs = procedureTimeoutMs(path, request);
      const requestTimeoutMs =
        options.requestTimeoutMs === undefined
          ? contractTimeoutMs
          : options.requestTimeoutMs;
      let response: Response;
      try {
        response = await fetchImpl(request, {
          ...init,
          signal: requestSignal(clientOptions.signal, requestTimeoutMs),
        });
      } catch (error) {
        // A refused local API is inspected again: a stopped container fails
        // now, naming `anycloud api start`, while a running one (restarting)
        // is retried as a restart.
        const code = networkErrorCode(error);
        if (code === 'ECONNREFUSED' || code === 'ConnectionRefused')
          assertLocalApiRunning({ url: apiUrl });
        // Bun also says ConnectionRefused for DNS failures; a loopback one is
        // a refusal, so it gets the restart ride-out as Node's ECONNREFUSED.
        if (code === 'ConnectionRefused' && getLoopbackApiPort(apiUrl))
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(error as Error, { code: 'ECONNREFUSED' }),
          });
        throw error;
      }
      if (response.status === 503) {
        callRetries(clientOptions.context).headers = response.headers;
      }
      return normalizeServerResponse(
        response,
        path,
        request.method,
        clientOptions.signal,
      );
    },
  });

  return createORPCClient<ApiClient>(link);
}
