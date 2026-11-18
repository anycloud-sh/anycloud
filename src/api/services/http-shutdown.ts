import type { Server } from 'node:http';
import { log } from './logger.js';
import {
  assertRequestActive,
  awaitWithSignal,
  registerRequestDeadline,
  type RequestBudget,
} from './request-budget.js';

/**
 * The Helm chart gives the API pod `terminationGracePeriodSeconds: 120`
 * (charts/anycloud-api/values.yaml) before SIGKILL; the drain ends 30 s
 * earlier so its last steps, including the database checkpoint, still run.
 */
export const API_SHUTDOWN_TIMEOUT_MS = 90_000;

export interface ApiRequestTracker {
  readonly draining: boolean;
  beginDrain(): void;
  track<T>(name: string, execute: () => Promise<T>): Promise<T>;
  waitForIdle(): Promise<void>;
  pending(): Record<string, number>;
}

/** Own handler promises independently of sockets and foreground timeout races. */
export function createApiRequestTracker(): ApiRequestTracker {
  let draining = false;
  const active = new Map<Promise<unknown>, string>();
  return {
    get draining() {
      return draining;
    },
    beginDrain() {
      draining = true;
    },
    async track(name, execute) {
      if (draining) throw new Error('API server is shutting down');
      const work = Promise.resolve().then(execute);
      active.set(work, name);
      try {
        return await work;
      } finally {
        active.delete(work);
      }
    },
    async waitForIdle() {
      while (active.size > 0) {
        await Promise.allSettled([...active.keys()]);
      }
    },
    pending() {
      const counts: Record<string, number> = {};
      for (const name of active.values()) {
        // Names come from the contract or native route owner, never the URL.
        const key =
          name in counts || Object.keys(counts).length < 16 ? name : 'other';
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    },
  };
}

function shutdownBudget(deadlineAt: number) {
  const controller = new AbortController();
  const expire = () =>
    controller.abort(new Error('API shutdown deadline exceeded'));
  registerRequestDeadline(controller.signal, deadlineAt, expire);
  const timer = setTimeout(expire, Math.max(0, deadlineAt - performance.now()));
  const operation: RequestBudget = {
    signal: controller.signal,
    startedAt: performance.now(),
    deadlineAt,
  };
  return { operation, dispose: () => clearTimeout(timer) };
}

export interface ApiShutdownOptions {
  server: Server;
  requests: ApiRequestTracker;
  abortRequests(): void;
  stopBackground(): Promise<void>;
  prepareRecovery?(operation: RequestBudget): Promise<void>;
  closeTransports?(): Promise<void>;
  /** Runs last, once nothing can write: checkpoints and closes the database. */
  closeDatabase?(): void;
  flushTelemetry(): Promise<void>;
  timeoutMs?: number;
  httpGraceMs?: number;
  telemetryGraceMs?: number;
}

/** Exit zero is safe only after accepted mutations and recovery both settle. */
export function createApiShutdown(
  options: ApiShutdownOptions,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => (shutdown ??= shutdownApi(options));
}

async function shutdownApi(options: ApiShutdownOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? API_SHUTDOWN_TIMEOUT_MS;
  const deadlineAt = performance.now() + timeoutMs;
  const telemetryGraceMs = options.telemetryGraceMs ?? 5_000;
  const budget = shutdownBudget(deadlineAt - telemetryGraceMs);
  let failed = false;
  let failure: unknown;
  let stage = 'http';
  const runStage = async (name: string, work: () => Promise<void>) => {
    stage = name;
    const startedAt = performance.now();
    log.info('API shutdown stage started', { id: 'system', stage });
    assertRequestActive(budget.operation.signal);
    await awaitWithSignal(work(), budget.operation.signal);
    log.info('API shutdown stage completed', {
      id: 'system',
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  };

  options.requests.beginDrain();
  let forceClose: ReturnType<typeof setTimeout> | undefined;
  try {
    await runStage('http', async () => {
      const closed = new Promise<void>((resolve, reject) => {
        options.server.close((error) => (error ? reject(error) : resolve()));
      });
      forceClose = setTimeout(() => {
        log.info('Closing remaining API HTTP connections', {
          id: 'system',
          pending: options.requests.pending(),
        });
        options.server.closeAllConnections();
      }, options.httpGraceMs ?? 10_000);
      options.abortRequests();
      await closed;
      clearTimeout(forceClose);
    });
    await runStage('requests', () => options.requests.waitForIdle());
    await runStage('background', options.stopBackground);
    if (options.prepareRecovery) {
      const prepareRecovery = options.prepareRecovery;
      await runStage('recovery', () => prepareRecovery(budget.operation));
    }
    if (options.closeTransports) {
      await runStage('transports', options.closeTransports);
    }
    if (options.closeDatabase) {
      const closeDatabase = options.closeDatabase;
      await runStage('database', async () => closeDatabase());
    }
  } catch (error) {
    options.server.closeAllConnections();
    failed = true;
    failure = error;
    log.error('API shutdown failed', {
      id: 'system',
      stage,
      pending: options.requests.pending(),
      error,
    });
  } finally {
    clearTimeout(forceClose);
    budget.dispose();
  }

  const telemetry = shutdownBudget(
    Math.min(deadlineAt, performance.now() + telemetryGraceMs),
  );
  try {
    assertRequestActive(telemetry.operation.signal);
    await awaitWithSignal(options.flushTelemetry(), telemetry.operation.signal);
  } catch (error) {
    log.error('API shutdown telemetry failed', { id: 'system', error });
    if (!failed) failure = error;
    failed = true;
  } finally {
    telemetry.dispose();
  }
  if (failed) throw failure;
}
