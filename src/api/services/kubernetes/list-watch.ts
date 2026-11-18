import {
  HttpMethod,
  RequestContext,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { retryAfterMs } from '../../../shared/retry-after.js';
import { assertRequestActive } from '../request-budget.js';

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const TIMESTAMP_KEY = /(Timestamp|Time|At|^time)$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

interface KubernetesWatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK';
  object: KubernetesObject;
}

/** A non-200 answer: 410 means relist; 429 carries the server's Retry-After. */
export class KubernetesHttpError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Kubernetes list-watch returned HTTP ${code}`);
    this.name = 'KubernetesHttpError';
  }
}

/** Cluster-wide list and watch of one resource path, such as `/api/v1/pods`. */
export interface KubernetesListWatch {
  list(
    path: string,
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ items: KubernetesObject[]; resourceVersion: string }>;
  watch(
    path: string,
    query: Record<string, string>,
    signal: AbortSignal,
    onEvent: (event: KubernetesWatchEvent) => void,
  ): Promise<void>;
}

/** Dates as the SDK's deserializer gives them, so cached objects match reads. */
function parse(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) =>
    typeof value === 'string' &&
    TIMESTAMP_KEY.test(key) &&
    TIMESTAMP.test(value)
      ? new Date(value)
      : value,
  );
}

function watchEvent(line: string): KubernetesWatchEvent {
  let value: { type?: unknown; object?: { code?: unknown } } | null;
  try {
    value = parse(line) as typeof value;
  } catch {
    throw new Error('Invalid Kubernetes watch JSON');
  }
  if (value?.type === 'ERROR') {
    throw new KubernetesHttpError(Number(value.object?.code) || 500);
  }
  if (
    !['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK'].includes(
      String(value?.type),
    ) ||
    !value?.object ||
    typeof value.object !== 'object'
  ) {
    throw new Error('Invalid Kubernetes watch event');
  }
  return value as KubernetesWatchEvent;
}

/**
 * One owned GET through the SDK's authentication and agent path (exec/token
 * refresh, client certificates, TLS server name, impersonation and a
 * configured proxy), cancellable before response headers arrive.
 */
async function stream(
  kubeConfig: KubeConfig,
  path: string,
  query: Record<string, string>,
  signal: AbortSignal,
  onData: (chunk: string) => void,
): Promise<void> {
  assertRequestActive(signal);
  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) throw new Error('Kubernetes list-watch has no current cluster');
  const url = new URL(`${cluster.server.replace(/\/+$/u, '')}${path}`);
  url.search = new URLSearchParams(query).toString();
  const context = new RequestContext(url.toString(), HttpMethod.GET);
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  try {
    await kubeConfig.applySecurityAuthentication(context);
    assertRequestActive(signal);
    const send =
      url.protocol === 'https:'
        ? httpsRequest
        : url.protocol === 'http:'
          ? httpRequest
          : null;
    if (!send) throw new Error('Kubernetes list-watch requires HTTP or HTTPS');
    await new Promise<void>((resolve, reject) => {
      request = send(
        url,
        {
          method: 'GET',
          headers: context.getHeaders(),
          agent: context.getAgent(),
          signal,
        },
        (incoming) => {
          response = incoming;
          if (incoming.statusCode !== 200) {
            reject(
              new KubernetesHttpError(
                incoming.statusCode ?? 0,
                retryAfterMs(incoming.headers, Date.now()) || undefined,
              ),
            );
            return;
          }
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            try {
              assertRequestActive(signal);
              onData(chunk);
            } catch (error) {
              reject(error);
            }
          });
          incoming.once('end', resolve);
          incoming.once('error', reject);
          incoming.once('aborted', () =>
            reject(new Error('Kubernetes list-watch interrupted')),
          );
        },
      );
      request.once('error', reject);
      request.end();
    });
    assertRequestActive(signal);
  } finally {
    response?.destroy();
    request?.destroy();
    context.getAgent()?.destroy();
  }
}

export function createKubernetesListWatch(
  kubeConfig: KubeConfig,
): KubernetesListWatch {
  return {
    async list(path, query, signal) {
      let body = '';
      await stream(kubeConfig, path, query, signal, (chunk) => {
        body += chunk;
      });
      const list = parse(body) as {
        items?: KubernetesObject[];
        metadata?: { resourceVersion?: string };
      };
      const resourceVersion = list.metadata?.resourceVersion;
      if (!resourceVersion)
        throw new Error('Kubernetes list has no resourceVersion');
      return { items: list.items ?? [], resourceVersion };
    },
    async watch(path, query, signal, onEvent) {
      let pending = '';
      await stream(
        kubeConfig,
        path,
        { ...query, watch: 'true' },
        signal,
        (chunk) => {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.trim()) onEvent(watchEvent(line));
          }
          if (Buffer.byteLength(pending) > MAX_EVENT_BYTES)
            throw new Error('Kubernetes watch event exceeded its size bound');
        },
      );
      if (pending.trim())
        throw new Error('Kubernetes watch ended with an incomplete event');
    },
  };
}
