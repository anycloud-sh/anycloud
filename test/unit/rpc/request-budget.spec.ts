import { call } from '@orpc/server';
import { request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedImplementation } from '../../../src/api/rpc/base.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import type { ApiRpcContext } from '../../../src/api/rpc/context.js';
import type { User } from '../../../src/api/services/entities.js';
import { waitForPoll } from '../../../src/api/services/request-budget.js';
import { getAnycloudVersion } from '../../../src/shared/services/api-client/runtime.js';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { withRequestBudget } from '../../../src/api/rpc/request-budget.js';
import { apiContractProcedurePolicy } from '../../../src/shared/api-contract/inspection.js';
import { assertRequestActive } from '../../../src/api/services/request-budget.js';
import { createApiRequestTracker } from '../../../src/api/services/http-shutdown.js';

const actor: User = {
  id: 'budget-user',
  username: 'budget-user',
  token: 'budget-token',
};
const listed = {
  owner: { userId: '1', username: 'owner' },
  users: [],
};
const QUERY = apiContractProcedurePolicy(['apiAccess', 'list']);
const COMMAND = apiContractProcedurePolicy(['credentials', 'save']);

function context(overrides: Partial<ApiRpcContext> = {}): ApiRpcContext {
  return {
    receivedAt: performance.now(),
    authorization: `Bearer ${actor.token}`,
    clientVersion: getAnycloudVersion(),
    authenticate: async () => actor,
    domains: createApiRpcDomains(),
    ...overrides,
  };
}

/** A query under the elapsed budget, as the RPC middleware runs a bounded route. */
function bounded(
  handler: (options: { context: ApiRpcContext }) => unknown,
  current: ApiRpcContext,
  signal?: AbortSignal,
) {
  const procedure = authenticatedImplementation.apiAccess.list.handler(
    handler as never,
  );
  return withRequestBudget(current, signal, QUERY, (operation) =>
    call(procedure, undefined, {
      context: { ...current, operation },
      signal: operation.signal,
    }),
  );
}

describe('bounded RPC elapsed request budget', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retains the actual procedure until it settles after its response is cancelled', async () => {
    const requests = createApiRequestTracker();
    const abort = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const request = bounded(
      async () => {
        entered();
        // A transport timeout cannot assume an arbitrary domain dependency obeys
        // cancellation. Its continuation must remain owned until it settles.
        await waiting;
        events.push('operation finished');
        return listed;
      },
      context({ requests }),
      abort.signal,
    );
    const rejected = expect(request).rejects.toThrow('Client disconnected');
    await started;
    abort.abort(new Error('Client disconnected'));
    await rejected;
    requests.beginDrain();
    const idle = requests.waitForIdle().then(() => {
      events.push('snapshot may start');
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(Object.values(requests.pending())).toEqual([1]);
    release();
    await idle;
    expect(events).toEqual(['operation finished', 'snapshot may start']);
    expect(requests.pending()).toEqual({});
  });

  it.each(['disconnect', 'shutdown'])(
    'retains raw authentication after %s until its continuation settles',
    async (kind) => {
      const requests = createApiRequestTracker();
      const abort = new AbortController();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events: string[] = [];
      const handler = vi.fn();
      const request = bounded(
        handler,
        context({
          requests,
          ...(kind === 'shutdown' ? { shutdownSignal: abort.signal } : {}),
          authenticate: async (_token, signal) => {
            entered();
            await pending;
            expect(signal?.aborted).toBe(true);
            events.push('authentication settled');
            return actor;
          },
        }),
        kind === 'disconnect' ? abort.signal : undefined,
      );
      // Shutdown cuts a safe query off as a restart the caller rides out.
      const rejected = expect(request).rejects.toThrow(
        kind === 'shutdown'
          ? 'API server is restarting'
          : 'Authentication cancelled',
      );
      await started;
      abort.abort(new Error('Authentication cancelled'));
      await rejected;
      requests.beginDrain();
      const idle = requests.waitForIdle().then(() => events.push('snapshot'));
      expect(requests.pending()).toEqual({ authentication: 1 });
      await Promise.resolve();
      expect(events).toEqual([]);
      release();
      await idle;
      expect(events).toEqual(['authentication settled', 'snapshot']);
      expect(handler).not.toHaveBeenCalled();
      expect(requests.pending()).toEqual({});
    },
  );

  it('does not start authentication after shutdown begins draining', async () => {
    const requests = createApiRequestTracker();
    requests.beginDrain();
    const authenticate = vi.fn(async () => actor);
    const handler = vi.fn();
    await expect(
      bounded(handler, context({ requests, authenticate })),
    ).rejects.toThrow('API server is shutting down');
    expect(authenticate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(requests.pending()).toEqual({});
  });

  // A command may have acted when shutdown cut it off; a safe query did not.
  it('answers a query cut off by shutdown API_RESTARTING and keeps the shutdown error for a command', async () => {
    const cutOff = async (policy: typeof QUERY) => {
      const shutdown = new AbortController();
      const pending = withRequestBudget(
        context({ shutdownSignal: shutdown.signal }),
        undefined,
        policy,
        () => new Promise<never>(() => {}),
      );
      shutdown.abort(new Error('API server is shutting down'));
      return pending.catch((error: unknown) => error);
    };
    await expect(cutOff(COMMAND)).resolves.toMatchObject({
      message: 'API server is shutting down',
    });
    await expect(cutOff(QUERY)).resolves.toMatchObject({
      defined: true,
      code: 'API_RESTARTING',
      status: 503,
    });
  });

  it('aborts dependencies when a late checkpoint runs before the timer', async () => {
    const aborted = vi.fn();
    const mutate = vi.fn();
    const request = withRequestBudget(
      context(),
      undefined,
      COMMAND,
      async (operation) => {
        operation.signal.addEventListener('abort', aborted, { once: true });
        await Promise.resolve();
        vi.spyOn(performance, 'now').mockReturnValue(operation.deadlineAt);
        assertRequestActive(operation.signal);
        mutate();
      },
    );
    await expect(request).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
    expect(aborted).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects authentication that finishes after the clock cutoff before its timer', async () => {
    const handler = vi.fn();
    const current = context();
    current.authenticate = async () => {
      await Promise.resolve();
      vi.spyOn(performance, 'now').mockReturnValue(
        current.receivedAt! + 30_000,
      );
      return actor;
    };
    await expect(bounded(handler, current)).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['stalled', 'incremental'])(
    'bounds a %s incoming JSON body before authentication',
    async (kind) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      let bodyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      const authenticate = vi.fn(async () => actor);
      const domains = createApiRpcDomains();
      const observed = vi.spyOn(domains.credentials, 'save');
      const app = express();
      app.use((req, _res, next) => {
        req.once('data', bodyStarted);
        next();
      });
      app.use(createApiRpcMiddleware({ authenticate, domains }));
      const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected TCP listener');
      let request!: ReturnType<typeof httpRequest>;
      const socketErrors: NodeJS.ErrnoException[] = [];
      let socketClosed: Promise<void> | undefined;
      const response = new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          request = httpRequest(
            `http://127.0.0.1:${address.port}/v1/credentials/budget-credential`,
            {
              method: 'PUT',
              headers: {
                authorization: `Bearer ${actor.token}`,
                [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
                'content-type': 'application/json',
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, body }),
              );
            },
          );
          request.on('error', reject);
          request.once('socket', (socket) => {
            socketClosed = new Promise<void>((resolve) => {
              socket.once('close', () => resolve());
            });
            // A late body write can race the timeout response's socket close.
            // Observe the socket itself even after ClientRequest detaches it.
            socket.on('error', (error: NodeJS.ErrnoException) => {
              socketErrors.push(error);
            });
          });
          request.write('{"cloudProvider":');
        },
      );
      try {
        await started;
        if (kind === 'incremental') {
          await vi.advanceTimersByTimeAsync(10_000);
          request.write('"aws"');
          await vi.advanceTimersByTimeAsync(10_000);
          request.write(',"accessKeyId":');
          await vi.advanceTimersByTimeAsync(10_000);
        } else {
          await vi.advanceTimersByTimeAsync(30_000);
        }
        const result = await response;
        expect(result.status).toBe(504);
        expect(JSON.parse(result.body)).toMatchObject({ code: 'TIMEOUT' });
        request.end('"x"}');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(authenticate).not.toHaveBeenCalled();
        expect(observed).not.toHaveBeenCalled();
      } finally {
        request.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await socketClosed;
      }
      for (const error of socketErrors) {
        expect(error).toMatchObject({ code: 'EPIPE' });
      }
    },
  );

  it('charges authentication to the same deadline and prevents late continuation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let authenticate!: (user: User) => void;
    const mutated = vi.fn();
    const handler = vi.fn(
      async ({ context: current }: { context: ApiRpcContext }) => {
        await waitForPoll(2_000, current.operation?.signal);
        mutated();
        return listed;
      },
    );
    const request = bounded(
      handler,
      context({
        authenticate: () =>
          new Promise((resolve) => {
            authenticate = resolve;
          }),
      }),
    );
    const rejected = expect(request).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(29_000);
    authenticate(actor);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mutated).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'shutdown'])(
    'releases stalled authentication after %s',
    async (kind) => {
      const abort = new AbortController();
      let finishAuthentication!: (user: User) => void;
      let entered!: () => void;
      const authenticating = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const handler = vi.fn(async () => listed);
      const request = bounded(
        handler,
        context({
          ...(kind === 'shutdown' ? { shutdownSignal: abort.signal } : {}),
          authenticate: () =>
            new Promise((resolve) => {
              finishAuthentication = resolve;
              entered();
            }),
        }),
        kind === 'disconnect' ? abort.signal : undefined,
      );
      const rejected = expect(request).rejects.toThrow(
        kind === 'shutdown' ? 'API server is restarting' : kind,
      );
      await authenticating;
      abort.abort(new Error(kind));
      await rejected;
      finishAuthentication(actor);
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
