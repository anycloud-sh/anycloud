import { errorMessage } from '../../../shared/log-diagnostics.js';

export interface SmolvmPortSpec {
  host: number;
  guest: number;
}

interface SmolvmMountSpec {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface SmolvmCreateMachineRequest {
  name: string;
  from?: string;
  network?: boolean;
  networkBackend?: string;
  ports?: SmolvmPortSpec[];
  mounts?: SmolvmMountSpec[];
  cpus?: number;
  memoryMb?: number;
  overlayGb?: number;
  storageGb?: number;
}

export interface SmolvmExecRequest {
  command: string[];
  timeoutSecs?: number;
  workdir?: string;
  stdin?: string;
}

export interface SmolvmExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SmolvmMachineInfo {
  name: string;
  state: string;
  cpus?: number;
  memoryMb?: number;
  network?: boolean;
  networkBackend?: string | null;
  overlayGb?: number | null;
  storageGb?: number | null;
  createdAt?: number | string;
  ports?: SmolvmPortSpec[];
  [key: string]: unknown;
}

export interface SmolvmServeClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Deadline for machine creation and start. Defaults to three minutes. */
  provisionTimeoutMs?: number;
}

export interface SmolvmHealth {
  status?: string;
  version?: string;
}

export class SmolvmServeError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body: unknown,
    /**
     * True when this client abandoned the request at its own deadline. A
     * refused connection and an expired deadline both surface as a null
     * status, but only the former says anything about smolvm's health.
     */
    public readonly timedOut = false,
  ) {
    super(message);
    this.name = 'SmolvmServeError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Creating a machine materializes its overlay and storage images, and starting
// one boots a kernel. Both are disk- and CPU-bound, so several in parallel can
// take minutes on a small host — far longer than a request that merely reads
// state. Abandoning them early is expensive: the caller retries at the
// workload level, which costs whole minutes of backoff for work that would
// have finished.
const DEFAULT_PROVISION_TIMEOUT_MS = 180_000;

// An exec request carries its own guest-side deadline, which can exceed the
// client's default request timeout. smolvm withholds response headers until the
// command finishes, so the HTTP deadline must always outlast the guest one or
// the client aborts a command the server is still legitimately running.
const EXEC_TIMEOUT_HEADROOM_MS = 10_000;

export class SmolvmServeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly provisionTimeoutMs: number;

  constructor(options: SmolvmServeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.provisionTimeoutMs = Math.max(
      this.timeoutMs,
      options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS,
    );
  }

  async health(): Promise<string> {
    const text = await this.requestText('/health');
    return text.trim();
  }

  async listMachines(): Promise<SmolvmMachineInfo[]> {
    const body = await this.requestJson<unknown>('GET', '/api/v1/machines');
    if (Array.isArray(body)) return body as SmolvmMachineInfo[];
    if (isRecord(body) && Array.isArray(body.machines)) {
      return body.machines as SmolvmMachineInfo[];
    }
    throw new SmolvmServeError(
      'smolvm serve returned an unsupported machine list shape',
      null,
      body,
    );
  }

  async createMachine(
    request: SmolvmCreateMachineRequest,
  ): Promise<SmolvmMachineInfo> {
    return this.requestJson<SmolvmMachineInfo>(
      'POST',
      '/api/v1/machines',
      request,
      this.provisionTimeoutMs,
    );
  }

  async getMachine(name: string): Promise<SmolvmMachineInfo> {
    return this.requestJson<SmolvmMachineInfo>(
      'GET',
      `/api/v1/machines/${encodeURIComponent(name)}`,
    );
  }

  async startMachine(name: string): Promise<SmolvmMachineInfo> {
    return this.requestJson<SmolvmMachineInfo>(
      'POST',
      `/api/v1/machines/${encodeURIComponent(name)}/start`,
      {},
      this.provisionTimeoutMs,
    );
  }

  async execMachine(
    name: string,
    request: SmolvmExecRequest,
  ): Promise<SmolvmExecResponse> {
    return this.requestJson<SmolvmExecResponse>(
      'POST',
      `/api/v1/machines/${encodeURIComponent(name)}/exec`,
      request,
      this.execTimeoutMs(request.timeoutSecs),
    );
  }

  private execTimeoutMs(timeoutSecs: number | undefined): number {
    if (timeoutSecs === undefined) return this.timeoutMs;
    return Math.max(
      this.timeoutMs,
      timeoutSecs * 1000 + EXEC_TIMEOUT_HEADROOM_MS,
    );
  }

  async stopMachine(name: string): Promise<SmolvmMachineInfo> {
    return this.requestJson<SmolvmMachineInfo>(
      'POST',
      `/api/v1/machines/${encodeURIComponent(name)}/stop`,
      {},
    );
  }

  async deleteMachine(name: string, force = true): Promise<void> {
    const query = force ? '?force=true' : '';
    await this.requestJson<unknown>(
      'DELETE',
      `/api/v1/machines/${encodeURIComponent(name)}${query}`,
    );
  }

  private async requestText(path: string): Promise<string> {
    const response = await this.fetchWithTimeout(path, { method: 'GET' });
    const responseText = await response.text();
    if (!response.ok) {
      throw new SmolvmServeError(
        `smolvm serve ${path} failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`,
        response.status,
        responseText,
      );
    }
    return responseText;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.fetchWithTimeout(
      path,
      {
        method,
        headers:
          body === undefined
            ? undefined
            : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    );
    const responseText = await response.text();
    const parsed = parseJsonOrText(responseText);

    if (!response.ok) {
      const message = errorMessageFromBody(parsed) ?? responseText;
      throw new SmolvmServeError(
        `smolvm serve ${method} ${path} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`,
        response.status,
        parsed,
      );
    }

    return parsed as T;
  }

  private async fetchWithTimeout(
    path: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(path, `${this.baseUrl}/`);
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      throw new SmolvmServeError(
        `smolvm serve request failed: ${errorMessage(error)}`,
        null,
        null,
        controller.signal.aborted,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function isSmolvmNotFound(error: unknown): boolean {
  if (error instanceof SmolvmServeError) {
    if (error.status === 404) return true;
    // The body is usually a parsed JSON object, which stringifies to
    // "[object Object]" — serialize it and keep the message, which already
    // carries the body's error/message/detail field.
    return /not found|no such|does not exist|unknown machine/i.test(
      `${error.message} ${JSON.stringify(error.body ?? null)}`,
    );
  }
  return /not found|no such|does not exist|unknown machine/i.test(
    errorMessage(error),
  );
}

export function isSmolvmPortInUse(error: unknown): boolean {
  return (
    error instanceof SmolvmServeError &&
    error.status === 409 &&
    typeof error.body === 'object' &&
    error.body !== null &&
    'code' in error.body &&
    error.body.code === 'PORT_IN_USE'
  );
}

export function assertSmolvmHealth(
  healthText: string,
  expectedVersion: string,
): SmolvmHealth {
  const parsed = parseSmolvmHealth(healthText);
  if (!parsed.version) {
    throw new Error(
      `smolvm /health did not report a version. Response: ${healthText}`,
    );
  }
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `Expected smolvm ${expectedVersion}, got ${parsed.version}. Response: ${healthText}`,
    );
  }
  if (parsed.status && parsed.status !== 'ok') {
    throw new Error(
      `Expected smolvm health status ok, got ${parsed.status}. Response: ${healthText}`,
    );
  }
  return parsed;
}

/**
 * Epoch milliseconds for a machine's reported creation time, or undefined when
 * smolvm reports none this release understands. smolvm reports the field as a
 * number or a string, in seconds or milliseconds, so both readers — the VM
 * listing and the resource-sweep age guard — must resolve it the same way: a
 * disagreement over the unit dates a live machine to 1970 and makes cleanup
 * delete it.
 */
export function smolvmCreatedAtMs(
  value: number | string | undefined,
): number | undefined {
  if (typeof value === 'number') return secondsOrMillisToMs(value);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) {
    const numeric = Number(normalized);
    return Number.isSafeInteger(numeric)
      ? secondsOrMillisToMs(numeric)
      : undefined;
  }
  const parsed = new Date(normalized).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Epoch values below this bound are seconds; at or above it, milliseconds. */
const MAX_EPOCH_SECONDS = 10_000_000_000;

function secondsOrMillisToMs(value: number): number {
  return value < MAX_EPOCH_SECONDS ? value * 1000 : value;
}

export function parseSmolvmHealth(healthText: string): SmolvmHealth {
  try {
    const parsed: unknown = JSON.parse(healthText);
    if (!isRecord(parsed)) return {};
    return {
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
    };
  } catch {
    return {};
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new SmolvmServeError('smolvm serve base URL is empty', null, null);
  }
  return trimmed.replace(/\/+$/g, '');
}

function parseJsonOrText(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessageFromBody(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (!isRecord(body)) return undefined;
  const message = body.message ?? body.error ?? body.detail;
  return typeof message === 'string' ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
