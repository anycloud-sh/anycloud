import { createServer, type RequestListener, type Server } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  API_SHUTDOWN_TIMEOUT_MS,
  createApiRequestTracker,
  createApiShutdown,
  type ApiRequestTracker,
} from '../../../src/api/services/http-shutdown.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ListeningFixture {
  server: Server;
  port: number;
  serverSockets: Set<Socket>;
  clients: Array<{ socket: Socket; closed: boolean; received: string }>;
}

const fixtures: ListeningFixture[] = [];

async function listen(handler: RequestListener): Promise<ListeningFixture> {
  const server = createServer(handler);
  const serverSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    serverSockets.add(socket);
    socket.once('close', () => serverSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  const fixture = { server, port: address.port, serverSockets, clients: [] };
  fixtures.push(fixture);
  return fixture;
}

async function connect(fixture: ListeningFixture, request: string) {
  const socket = createConnection({ host: '127.0.0.1', port: fixture.port });
  const client = { socket, closed: false, received: '' };
  fixture.clients.push(client);
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    client.received += chunk;
  });
  socket.once('close', () => {
    client.closed = true;
  });
  // Forced shutdown can reset a connection with an incomplete request body.
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  socket.write(request);
  return client;
}

function options(server: Server, requests: ApiRequestTracker) {
  return {
    server,
    requests,
    abortRequests: vi.fn(),
    stopBackground: vi.fn().mockResolvedValue(undefined),
    prepareRecovery: vi.fn().mockResolvedValue(undefined),
    closeDatabase: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(undefined),
    timeoutMs: 1_000,
    httpGraceMs: 25,
    telemetryGraceMs: 25,
  };
}

/** Check the production close before fallback fixture cleanup can mask a leak. */
async function expectClosed(fixture: ListeningFixture): Promise<void> {
  await vi.waitFor(() => {
    expect(fixture.clients.every((client) => client.closed)).toBe(true);
    expect(fixture.serverSockets.size).toBe(0);
  });
  expect(fixture.server.listening).toBe(false);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const client of fixture.clients) client.socket.destroy();
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

describe('API HTTP shutdown', () => {
  it('keeps transports available until managed recovery has finished', async () => {
    const fixture = await listen((_request, response) => response.end());
    const recovering = gate();
    const recovered = gate();
    const closeTransports = vi.fn().mockResolvedValue(undefined);
    const settings = {
      ...options(fixture.server, createApiRequestTracker()),
      prepareRecovery: async () => {
        recovering.resolve();
        await recovered.promise;
        expect(closeTransports).not.toHaveBeenCalled();
      },
      closeTransports,
    };
    const shutdown = createApiShutdown(settings)();
    await recovering.promise;
    expect(closeTransports).not.toHaveBeenCalled();
    recovered.resolve();
    await shutdown;
    expect(closeTransports).toHaveBeenCalledOnce();
    // The database closes last, once nothing can write, before telemetry.
    expect(closeTransports.mock.invocationCallOrder[0]).toBeLessThan(
      settings.closeDatabase.mock.invocationCallOrder[0],
    );
    expect(settings.closeDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      settings.flushTelemetry.mock.invocationCallOrder[0],
    );
  });

  it('ends the drain inside the chart grace period, before SIGKILL', () => {
    const grace = /terminationGracePeriodSeconds: (\d+)/u.exec(
      readFileSync('charts/anycloud-api/values.yaml', 'utf8'),
    )?.[1];
    expect(API_SHUTDOWN_TIMEOUT_MS + 30_000).toBeLessThanOrEqual(
      Number(grace) * 1_000,
    );
  });

  it('forces incomplete bodies and held responses closed before recovery', async () => {
    const bodyStarted = gate();
    const responseStarted = gate();
    const fixture = await listen((request, response) => {
      request.on('error', () => undefined);
      if (request.url === '/body') {
        request.once('data', bodyStarted.resolve);
      } else {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('still running');
        responseStarted.resolve();
      }
    });
    await connect(
      fixture,
      'POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{',
    );
    await connect(fixture, 'GET /held HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await Promise.all([bodyStarted.promise, responseStarted.promise]);
    const settings = options(fixture.server, createApiRequestTracker());

    await createApiShutdown(settings)();

    await expectClosed(fixture);
    expect(settings.abortRequests).toHaveBeenCalledOnce();
    expect(settings.stopBackground).toHaveBeenCalledOnce();
    expect(settings.prepareRecovery).toHaveBeenCalledOnce();
    expect(settings.stopBackground.mock.invocationCallOrder[0]).toBeLessThan(
      settings.prepareRecovery.mock.invocationCallOrder[0],
    );
  });

  it('lets a finite request finish and shares one idempotent shutdown', async () => {
    const started = gate();
    const finish = gate();
    const fixture = await listen((_request, response) => {
      started.resolve();
      void finish.promise.then(() => response.end('finished normally'));
    });
    const client = await connect(
      fixture,
      'GET /finite HTTP/1.1\r\nHost: localhost\r\n\r\n',
    );
    await started.promise;
    const settings = options(fixture.server, createApiRequestTracker());
    const shutdown = createApiShutdown(settings);
    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    finish.resolve();
    await first;

    await expectClosed(fixture);
    expect(client.received).toContain('200 OK');
    expect(client.received).toContain('finished normally');
    expect(settings.abortRequests).toHaveBeenCalledOnce();
    expect(settings.stopBackground).toHaveBeenCalledOnce();
    expect(settings.prepareRecovery).toHaveBeenCalledOnce();
    expect(settings.flushTelemetry).toHaveBeenCalledOnce();
    expect(shutdown()).toBe(first);
  });

  it('waits for an accepted mutation after socket closure before background and recovery', async () => {
    const requests = createApiRequestTracker();
    const started = gate();
    const finishMutation = gate();
    const order: string[] = [];
    const fixture = await listen((_request, response) => {
      void requests
        .track('workloads.create', async () => {
          started.resolve();
          await finishMutation.promise;
          expect(response.destroyed).toBe(true);
          order.push('mutation');
        })
        .catch((error: Error) => response.destroy(error));
    });
    await connect(
      fixture,
      'POST /mutation HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n',
    );
    await started.promise;
    const settings = options(fixture.server, requests);
    settings.stopBackground.mockImplementation(async () => {
      order.push('background');
    });
    settings.prepareRecovery.mockImplementation(async () => {
      order.push('recovery');
    });
    const shutdown = createApiShutdown(settings)();

    await expectClosed(fixture);
    expect(requests.pending()).toEqual({ 'workloads.create': 1 });
    expect(settings.stopBackground).not.toHaveBeenCalled();
    expect(settings.prepareRecovery).not.toHaveBeenCalled();
    const lateMutation = vi.fn();
    await expect(requests.track('late', lateMutation)).rejects.toThrow(
      'shutting down',
    );
    expect(lateMutation).not.toHaveBeenCalled();

    finishMutation.resolve();
    await shutdown;
    expect(order).toEqual(['mutation', 'background', 'recovery']);
    expect(requests.pending()).toEqual({});
  });

  it('fails its total deadline without recovery when an accepted mutation never settles', async () => {
    const requests = createApiRequestTracker();
    const started = gate();
    const fixture = await listen((_request, response) => {
      void requests
        .track('workloads.create', () => {
          started.resolve();
          return new Promise<never>(() => undefined);
        })
        .catch((error: Error) => response.destroy(error));
    });
    await connect(
      fixture,
      'POST /mutation HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n',
    );
    await started.promise;
    const settings = {
      ...options(fixture.server, requests),
      timeoutMs: 150,
      httpGraceMs: 10,
      telemetryGraceMs: 20,
    };

    // Keep socket closure real while controlling the elapsed shutdown budget.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'performance'],
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const httpClosed = once(fixture.server, 'close');
    const shutdown = createApiShutdown(settings)();
    const rejected = expect(shutdown).rejects.toThrow(
      'shutdown deadline exceeded',
    );
    await vi.advanceTimersByTimeAsync(settings.httpGraceMs);
    await httpClosed;
    await vi.advanceTimersByTimeAsync(
      settings.timeoutMs - settings.telemetryGraceMs - settings.httpGraceMs,
    );
    await rejected;
    vi.useRealTimers();

    await expectClosed(fixture);
    expect(settings.stopBackground).not.toHaveBeenCalled();
    expect(settings.prepareRecovery).not.toHaveBeenCalled();
    // A write may still be running, so the database is left for WAL recovery.
    expect(settings.closeDatabase).not.toHaveBeenCalled();
    expect(settings.flushTelemetry).toHaveBeenCalledOnce();
    expect(requests.pending()).toEqual({ 'workloads.create': 1 });
  });

  it('still closes sockets if the total deadline expires before HTTP grace', async () => {
    const started = gate();
    const fixture = await listen((_request, response) => {
      response.write('held');
      started.resolve();
    });
    await connect(fixture, 'GET /held HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await started.promise;
    const settings = {
      ...options(fixture.server, createApiRequestTracker()),
      timeoutMs: 80,
      httpGraceMs: 1_000,
      telemetryGraceMs: 10,
    };

    await expect(createApiShutdown(settings)()).rejects.toThrow(
      'shutdown deadline exceeded',
    );

    await expectClosed(fixture);
    expect(settings.prepareRecovery).not.toHaveBeenCalled();
  });

  it('rejects failed snapshot preparation after closing HTTP and stopping background work', async () => {
    const fixture = await listen((_request, response) => response.end());
    const settings = options(fixture.server, createApiRequestTracker());
    const failure = new Error('snapshot identity mismatch');
    settings.prepareRecovery.mockRejectedValue(failure);

    await expect(createApiShutdown(settings)()).rejects.toBe(failure);

    await expectClosed(fixture);
    expect(settings.stopBackground).toHaveBeenCalledOnce();
    expect(settings.prepareRecovery).toHaveBeenCalledOnce();
    expect(settings.flushTelemetry).toHaveBeenCalledOnce();
  });
});
