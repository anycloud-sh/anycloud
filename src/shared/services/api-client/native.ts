import { Readable } from 'node:stream';

import { getApiUrl, resolveApiTarget } from '../../config.js';
import {
  type ExecRequest,
  type ExecStreamEvent,
  type LogsRequest,
} from '../../api-contract/native-schemas.js';
import type { NativeBucketObjectRequest } from '../../api-contract/native-schemas.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../api-version.js';
import {
  assertLocalApiRunning,
  createAbortError,
  getAnycloudVersion,
  throwIfAborted,
} from './runtime.js';
import {
  type ApiUnavailableGuidance,
  summarizeErrorBody,
  temporaryApiUnavailableMessage,
} from './outage.js';

export class ApiHttpError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number,
    message: string,
    /** The API's error code, when the response carried one. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export interface ExecStreamHandlers {
  stdout?: (chunk: Buffer) => void | Promise<void>;
  stderr?: (chunk: Buffer) => void | Promise<void>;
}

export async function executeWorkloadCommand(
  accessToken: string,
  request: ExecRequest,
  handlers: ExecStreamHandlers = {},
): Promise<number> {
  const target = resolveApiTarget();
  const apiUrl = target.url;
  assertLocalApiRunning(target);
  const endpoint = `/v1/workloads/${encodeURIComponent(request.id)}/exec`;

  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      Authorization: `Bearer ${accessToken}`,
      [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
    },
    body: JSON.stringify({
      command: request.command,
      replica: request.replica,
    }),
  });

  if (!response.ok) {
    throw await nativeHttpError(endpoint, response, 'verify');
  }
  return await consumeExecStream(response, endpoint, handlers);
}

async function consumeExecStream(
  response: Response,
  endpoint: string,
  handlers: ExecStreamHandlers,
  signal?: AbortSignal,
): Promise<number> {
  if (!response.body) {
    throw new Error(`Empty response body from ${endpoint}`);
  }

  const stream = Readable.fromWeb(response.body as never);
  const abort = () => {
    const reason =
      signal?.reason instanceof Error ? signal.reason : createAbortError();
    stream.destroy(reason);
  };
  const decoder = new TextDecoder();
  let buffer = '';
  let exitCode: number | undefined;

  const handleEvent = async (line: string) => {
    if (line.length === 0) return;
    const event = JSON.parse(line) as ExecStreamEvent;
    switch (event.type) {
      case 'stdout':
        await handlers.stdout?.(Buffer.from(event.data, 'base64'));
        return;
      case 'stderr':
        await handlers.stderr?.(Buffer.from(event.data, 'base64'));
        return;
      case 'exit':
        exitCode = event.code;
        return;
      case 'error':
        throw new Error(event.error);
      case 'heartbeat':
        return;
      default:
        throw new Error(`Unknown exec stream event: ${JSON.stringify(event)}`);
    }
  };

  throwIfAborted(signal);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        await handleEvent(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  throwIfAborted(signal);

  buffer += decoder.decode();
  const remaining = buffer.trim();
  if (remaining.length > 0) await handleEvent(remaining);

  if (exitCode === undefined) {
    throw new Error('Exec stream ended before exit event');
  }
  return exitCode;
}

export async function streamWorkloadLogs(
  accessToken: string,
  request: LogsRequest,
  handlers: ExecStreamHandlers = {},
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const target = resolveApiTarget();
  const apiUrl = target.url;
  throwIfAborted(options.signal);
  assertLocalApiRunning(target);
  throwIfAborted(options.signal);
  const endpoint = `/v1/workloads/${encodeURIComponent(request.id)}/logs`;
  const url = new URL(`${apiUrl}${endpoint}`);
  if (request.follow !== undefined) {
    url.searchParams.set('follow', request.follow ? 'true' : 'false');
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/x-ndjson',
      Authorization: `Bearer ${accessToken}`,
      [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
    },
    signal: options.signal,
  });

  if (!response.ok) {
    throw await nativeHttpError(endpoint, response, 'retry');
  }

  return await consumeExecStream(response, endpoint, handlers, options.signal);
}

async function nativeHttpError(
  endpoint: string,
  response: Response,
  guidance: ApiUnavailableGuidance,
): Promise<ApiHttpError> {
  const raw = await response.text().catch(() => '');
  let parsed: { error?: unknown; message?: unknown; code?: unknown } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // Not a JSON error envelope; the raw body is summarized below.
  }
  const code = typeof parsed.code === 'string' ? parsed.code : undefined;
  const reported =
    typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error === 'string'
        ? parsed.error
        : undefined;
  const message =
    response.status >= 500 && reported === undefined
      ? temporaryApiUnavailableMessage(response.status, guidance)
      : summarizeErrorBody(reported ?? raw) || `HTTP ${response.status}`;
  return new ApiHttpError(endpoint, response.status, message, code);
}

export async function uploadBucketObject(
  bearerToken: string,
  body: NodeJS.ReadableStream,
  contentLength: number | undefined,
  params: NativeBucketObjectRequest['params'] &
    NativeBucketObjectRequest['query'],
): Promise<void> {
  const endpoint = bucketObjectContentEndpoint(params);
  const url = `${getApiUrl()}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    Authorization: `Bearer ${bearerToken}`,
    [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
  };
  if (contentLength !== undefined) {
    headers['Content-Length'] = String(contentLength);
  }
  const init: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers,
    body: body as unknown as BodyInit,
    duplex: 'half',
  };
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await nativeHttpError(endpoint, response, 'verify');
  }
}

export async function downloadBucketObject(
  bearerToken: string,
  params: NativeBucketObjectRequest['params'] &
    NativeBucketObjectRequest['query'],
): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number }> {
  const endpoint = bucketObjectContentEndpoint(params);
  const url = `${getApiUrl()}${endpoint}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
    },
  });
  if (!response.ok) {
    throw await nativeHttpError(endpoint, response, 'retry');
  }
  if (!response.body) {
    throw new Error(`Empty response body from ${endpoint}`);
  }
  const stream = Readable.fromWeb(response.body as never);
  const lenHeader =
    response.headers.get('x-anycloud-object-size') ??
    response.headers.get('content-length');
  const contentLength =
    lenHeader === null || !/^\d+$/.test(lenHeader)
      ? undefined
      : Number(lenHeader);
  if (
    lenHeader !== null &&
    (contentLength === undefined || !Number.isSafeInteger(contentLength))
  ) {
    stream.destroy();
    throw new Error(`Invalid object size from ${endpoint}: ${lenHeader}`);
  }
  return { stream, contentLength };
}

function bucketObjectContentEndpoint(
  params: NativeBucketObjectRequest['params'] &
    NativeBucketObjectRequest['query'],
): string {
  const endpoint = `/v1/credentials/${encodeURIComponent(params.credentialName)}/buckets/${encodeURIComponent(params.bucketName)}/object-content`;
  const query = new URLSearchParams({ remotePath: params.remotePath });
  if (params.region !== undefined) query.set('region', params.region);
  return `${endpoint}?${query.toString()}`;
}
