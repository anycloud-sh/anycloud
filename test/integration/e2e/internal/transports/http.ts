import type { ArtifactStore, Redactor } from '../artifacts.js';
import { awaitWithSignal } from '../../../../../src/api/services/request-budget.js';

export class TargetHttpProtocolError extends Error {}

export interface TargetHttpResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface TargetHttpOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  readonly redirect?: 'error';
}

interface TargetHttpRequestOptions extends TargetHttpOptions {
  readonly body?: unknown;
  readonly method: 'DELETE' | 'GET' | 'POST';
}

const MAX_TARGET_HTTP_TIMEOUT_MS = 120_000;

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The client's message plus the first system code beneath it, such as `ENOTFOUND`. */
export function probeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('code' in cause && typeof cause.code === 'string')
      return `${message} (${cause.code})`;
  }
  return message;
}

export class TargetHttpClient {
  readonly #artifacts: ArtifactStore;
  readonly #redactor: Redactor;
  readonly #signal: AbortSignal;
  readonly #artifactPrefix: string;
  #requestCount = 0;

  constructor(
    artifacts: ArtifactStore,
    redactor: Redactor,
    signal: AbortSignal = new AbortController().signal,
    artifactPrefix = 'target',
  ) {
    this.#artifacts = artifacts;
    this.#redactor = redactor;
    this.#signal = signal;
    this.#artifactPrefix = artifactPrefix;
  }

  async get(
    label: string,
    url: URL,
    options: TargetHttpOptions = {},
  ): Promise<TargetHttpResponse> {
    return this.#request(label, url, { ...options, method: 'GET' });
  }

  async post(
    label: string,
    url: URL,
    body: unknown,
    options: TargetHttpOptions = {},
  ): Promise<TargetHttpResponse> {
    return this.#request(label, url, {
      ...options,
      body,
      method: 'POST',
    });
  }

  async delete(
    label: string,
    url: URL,
    options: TargetHttpOptions = {},
  ): Promise<TargetHttpResponse> {
    return this.#request(label, url, { ...options, method: 'DELETE' });
  }

  async #request(
    label: string,
    url: URL,
    options: TargetHttpRequestOptions,
  ): Promise<TargetHttpResponse> {
    const requestedTimeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(requestedTimeoutMs) ||
      requestedTimeoutMs <= 0 ||
      requestedTimeoutMs > MAX_TARGET_HTTP_TIMEOUT_MS
    ) {
      throw new Error(
        `Target HTTP timeout must be between 1 and ${MAX_TARGET_HTTP_TIMEOUT_MS}ms`,
      );
    }
    if (
      options.deadlineAt !== undefined &&
      (!Number.isSafeInteger(options.deadlineAt) ||
        options.deadlineAt <= Date.now())
    ) {
      throw new Error('Target HTTP deadline has expired or is invalid');
    }
    const deadlineAt = Math.min(
      options.deadlineAt ?? Infinity,
      Date.now() + requestedTimeoutMs,
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      this.#signal,
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
    ]);
    try {
      signal.throwIfAborted();
      const response = await awaitWithSignal(
        fetch(url, {
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          headers: options.headers,
          method: options.method,
          ...(options.redirect === 'error'
            ? { redirect: 'manual' as const }
            : {}),
          signal,
        }),
        signal,
      );
      if (
        options.redirect === 'error' &&
        (response.redirected ||
          (response.status >= 300 && response.status < 400))
      ) {
        throw new TargetHttpProtocolError(`${label} rejected an HTTP redirect`);
      }
      const body = await awaitWithSignal(parseBody(response), signal);
      if (Date.now() >= deadlineAt)
        throw new Error('Target HTTP deadline expired');
      this.#requestCount += 1;
      await awaitWithSignal(
        this.#artifacts.json(
          `${String(this.#requestCount).padStart(3, '0')}-${this.#artifactPrefix}-${label}`,
          {
            label,
            method: options.method,
            origin: url.origin,
            path: url.pathname,
            status: response.status,
            // A failure's source: the API, the ingress or the edge.
            ...(!response.ok && {
              // service-terminology-ok: the HTTP `Server` response header
              server: response.headers.get('server'),
              cfRay: response.headers.get('cf-ray'),
              body: (typeof body === 'string'
                ? body
                : JSON.stringify(body)
              )?.slice(0, 2_000),
            }),
          },
        ),
        signal,
      );
      if (Date.now() >= deadlineAt)
        throw new Error('Target HTTP deadline expired');
      return { body, status: response.status };
    } catch (error) {
      if (error instanceof TargetHttpProtocolError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label} request failed: ${this.#redactor.text(message)}`,
        { cause: error },
      );
    } finally {
      controller.abort();
    }
  }
}
