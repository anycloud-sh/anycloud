import { setTimeout as pause } from 'node:timers/promises';

import {
  ApiException,
  HttpMethod,
  Observable,
  type ConfigurationOptions,
} from '@kubernetes/client-node';

import { kubernetesRequestOptions } from '../../../../src/api/services/kubernetes/request-options.js';
import type { ArtifactStore } from './artifacts.js';
import { isRecord } from './types.js';

const UNAVAILABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const UNAVAILABLE_CONNECTION = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

class NativeReadAttemptTimeout extends Error {}

function isNativeAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'AbortError' &&
    isRecord(error) &&
    error.type === 'aborted'
  );
}

/** Only genuine SDK HTTP failures or node-fetch system errors are retryable. */
export function retryableKubernetesRead(error: unknown): boolean {
  if (error instanceof NativeReadAttemptTimeout) return true;
  if (error instanceof ApiException) {
    if (
      isRecord(error.body) &&
      typeof error.body.code === 'number' &&
      error.body.code !== error.code
    )
      return false;
    return UNAVAILABLE_HTTP.has(error.code);
  }
  return (
    error instanceof Error &&
    error.name === 'FetchError' &&
    isRecord(error) &&
    error.type === 'system' &&
    typeof error.code === 'string' &&
    error.errno === error.code &&
    UNAVAILABLE_CONNECTION.has(error.code)
  );
}

function readOptions(signal: AbortSignal): ConfigurationOptions {
  const bounded = kubernetesRequestOptions(signal);
  return {
    ...bounded,
    middlewareMergeStrategy: 'append',
    middleware: [
      {
        pre(request) {
          // A future caller cannot accidentally replay a native mutation by
          // routing it through this read-only observation scope.
          if (request.getHttpMethod() !== HttpMethod.GET)
            throw new Error(
              'Kubernetes observation retries require a GET request',
            );
          return new Observable(Promise.resolve(request));
        },
        post(response) {
          return new Observable(Promise.resolve(response));
        },
      },
      ...(bounded?.middleware ?? []),
    ],
  };
}

/** Native read recovery stays within one finite observation budget. */
export class KubernetesApiReads {
  readonly #signal: AbortSignal;
  readonly #artifacts: Pick<ArtifactStore, 'json'> | undefined;
  readonly #prefix: string;
  readonly #timeoutMs: number;
  readonly #attemptMs: number;
  readonly #intervalMs: number;
  #count = 0;

  constructor(
    options: {
      readonly signal?: AbortSignal;
      readonly artifacts?: Pick<ArtifactStore, 'json'>;
      readonly prefix?: string;
      readonly timeoutMs?: number;
      readonly attemptMs?: number;
      readonly intervalMs?: number;
    } = {},
  ) {
    this.#signal = options.signal ?? new AbortController().signal;
    this.#artifacts = options.artifacts;
    this.#prefix = options.prefix ?? 'native';
    this.#timeoutMs = options.timeoutMs ?? 90_000;
    this.#attemptMs = options.attemptMs ?? 15_000;
    this.#intervalMs = options.intervalMs ?? 1_000;
    for (const [name, value, maximum] of [
      ['observation', this.#timeoutMs, 90_000],
      ['request', this.#attemptMs, this.#timeoutMs],
      ['interval', this.#intervalMs, this.#timeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`Kubernetes ${name} deadline is invalid`);
    }
  }

  async read<T>(
    label: string,
    request: (options: ConfigurationOptions) => Promise<T>,
  ): Promise<T> {
    this.#signal.throwIfAborted();
    const deadline = Date.now() + this.#timeoutMs;
    let lastError: unknown;
    let attempt = 0;
    // eslint-disable-next-line local/no-hand-written-retry-loops -- aborts each SDK request at its own deadline, records every retry, and rethrows the caller's abort reason
    while (Date.now() < deadline) {
      this.#signal.throwIfAborted();
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            new NativeReadAttemptTimeout(`${label} request deadline expired`),
          ),
        Math.min(this.#attemptMs, deadline - Date.now()),
      );
      const signal = AbortSignal.any([this.#signal, controller.signal]);
      try {
        const value = await request(readOptions(signal));
        this.#signal.throwIfAborted();
        if (controller.signal.aborted || Date.now() >= deadline)
          throw new NativeReadAttemptTimeout(
            `${label} observation arrived after its deadline`,
          );
        return value;
      } catch (error) {
        this.#signal.throwIfAborted();
        const timedOut = controller.signal.aborted && isNativeAbort(error);
        const failure = timedOut
          ? new NativeReadAttemptTimeout(`${label} request deadline expired`, {
              cause: error,
            })
          : error;
        if (!retryableKubernetesRead(failure)) throw error;
        lastError = failure;
        this.#count += 1;
        await this.#artifacts?.json(
          `${this.#prefix}-kubernetes-read-${this.#count}`,
          {
            label,
            attempt,
            observedAt: Date.now(),
            timedOut,
            ...(error instanceof ApiException
              ? { statusCode: error.code }
              : {}),
            ...(isRecord(error) && typeof error.code === 'string'
              ? { systemCode: error.code }
              : {}),
          },
        );
      } finally {
        clearTimeout(timer);
        // Some terminal SDK responses reject before consuming the body. Close
        // that request too; clearing its timer alone leaves a live body stream.
        controller.abort();
      }
      const remaining = deadline - Date.now();
      if (remaining > 0)
        await pause(Math.min(this.#intervalMs, remaining), undefined, {
          signal: this.#signal,
        });
    }
    throw new Error(
      `${label}: Kubernetes read unavailable after ${this.#timeoutMs}ms`,
      { cause: lastError },
    );
  }
}
