import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiException, KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createKubernetesClients } from '../../src/api/services/kubernetes/client.js';
import { kubernetesStatusCode } from '../integration/e2e/internal/kubernetes-client.js';
import {
  KubernetesApiReads,
  retryableKubernetesRead,
} from '../integration/e2e/internal/kubernetes-reads.js';

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0)) await close();
});

function namespace() {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'kube-system' },
  };
}

async function fixture(
  reply: (
    request: IncomingMessage,
    response: ServerResponse,
    index: number,
  ) => void,
) {
  const requests: { method: string | undefined; path: string | undefined }[] =
    [];
  let closed = 0;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.on('close', () => {
      closed += 1;
    });
    reply(request, response, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  dispose.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const port = (server.address() as AddressInfo).port;
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [
      { name: 'test', server: `http://127.0.0.1:${port}`, skipTLSVerify: true },
    ],
    users: [{ name: 'test', token: 'test-only-token' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  });
  return {
    clients: createKubernetesClients(kubeConfig),
    requests,
    closed: () => closed,
    disconnect: () => server.closeAllConnections(),
  };
}

function fetchFailure(code: string): Error {
  return Object.assign(new Error('Native connection failed'), {
    name: 'FetchError',
    type: 'system',
    code,
    errno: code,
  });
}

describe('bounded native Kubernetes reads', () => {
  test.each([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
  ])(
    'recovers a real system %s classification within one observation',
    async (code) => {
      const calls = vi
        .fn()
        .mockRejectedValueOnce(fetchFailure(code))
        .mockResolvedValue(namespace());
      const reads = new KubernetesApiReads({
        timeoutMs: 100,
        attemptMs: 30,
        intervalMs: 1,
      });
      expect(await reads.read('namespace', calls)).toEqual(namespace());
      expect(calls).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    new Error('ETIMEDOUT 503 in a diagnostic'),
    Object.assign(new Error('partial body'), {
      name: 'FetchError',
      type: 'invalid-json',
      code: 'ECONNRESET',
      errno: 'ECONNRESET',
    }),
    Object.assign(new Error('wrong exception origin'), {
      type: 'system',
      code: 'ETIMEDOUT',
      errno: 'ETIMEDOUT',
    }),
    Object.assign(new Error('aborted outside this request'), {
      name: 'AbortError',
      type: 'aborted',
    }),
    new ApiException(401, 'Unauthorized: prior upstream503', { code: 503 }, {}),
    new ApiException(403, 'Forbidden', { code: 403 }, {}),
    new ApiException(404, 'Not Found', { code: 404 }, {}),
    new ApiException(503, 'conflicting body', { code: 401 }, {}),
    new SyntaxError('malformed Kubernetes body'),
  ])(
    'does not retry terminal, ambiguous or unrelated failures %#',
    async (error) => {
      const request = vi.fn().mockRejectedValue(error);
      const reads = new KubernetesApiReads({
        timeoutMs: 100,
        attemptMs: 20,
        intervalMs: 1,
      });
      expect(retryableKubernetesRead(error)).toBe(false);
      await expect(reads.read('terminal read', request)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test('uses the installed SDK, keeps authentication and records an actual unavailable HTTP response before success', async () => {
    const auth: (string | undefined)[] = [];
    const world = await fixture((request, response, index) => {
      auth.push(request.headers.authorization);
      response.writeHead(index === 1 ? 503 : 200, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify(
          index === 1
            ? { kind: 'Status', code: 503, message: 'unavailable' }
            : namespace(),
        ),
      );
    });
    const artifacts: unknown[] = [];
    const reads = new KubernetesApiReads({
      timeoutMs: 1_000,
      attemptMs: 300,
      intervalMs: 1,
      artifacts: {
        json: async (_label, value) => {
          artifacts.push(value);
          return '';
        },
      },
    });
    await expect(
      reads.read('kube-system', (options) =>
        world.clients.core.readNamespace({ name: 'kube-system' }, options),
      ),
    ).resolves.toMatchObject({ metadata: { name: 'kube-system' } });
    expect(world.requests).toEqual([
      { method: 'GET', path: '/api/v1/namespaces/kube-system' },
      { method: 'GET', path: '/api/v1/namespaces/kube-system' },
    ]);
    expect(auth).toEqual(['Bearer test-only-token', 'Bearer test-only-token']);
    expect(artifacts).toMatchObject([
      { statusCode: 503, attempt: 1, label: 'kube-system', timedOut: false },
    ]);
  });

  test('aborts real SDK body reads at each request deadline and drains them before the final failure', async () => {
    const world = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"kind":"Namespace",');
    });
    const reads = new KubernetesApiReads({
      timeoutMs: 90,
      attemptMs: 20,
      intervalMs: 1,
      // Independent test cancellation and socket closure also bound a broken
      // implementation that never attaches the request signal to the SDK.
      signal: AbortSignal.timeout(750),
    });
    const started = Date.now();
    const failsafe = setTimeout(() => world.disconnect(), 800);
    try {
      await expect(
        reads.read('stalled namespace', (options) =>
          world.clients.core.readNamespace({ name: 'kube-system' }, options),
        ),
      ).rejects.toThrow('Kubernetes read unavailable');
    } finally {
      clearTimeout(failsafe);
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(world.requests.length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(world.closed()).toBe(world.requests.length), {
      timeout: 500,
    });
  });

  test('rejects a mutation before sending it through the retry path', async () => {
    const world = await fixture((_request, response) => {
      response.end('{}');
    });
    const reads = new KubernetesApiReads({
      timeoutMs: 100,
      attemptMs: 20,
      intervalMs: 1,
    });
    await expect(
      reads.read('must not delete', (options) =>
        world.clients.core.deleteNamespace({ name: 'kube-system' }, options),
      ),
    ).rejects.toThrow('require a GET request');
    expect(world.requests).toEqual([]);
  });

  test('closes a stalled terminal authorization response without retrying or replacing its HTTP failure', async () => {
    const world = await fixture((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.write('{"code":401,');
    });
    const reads = new KubernetesApiReads({
      timeoutMs: 100,
      attemptMs: 50,
      intervalMs: 1,
    });
    await expect(
      reads.read('unauthorized namespace', (options) =>
        world.clients.core.readNamespace({ name: 'kube-system' }, options),
      ),
    ).rejects.toMatchObject({ code: 401 });
    expect(world.requests).toHaveLength(1);
    await vi.waitFor(() => expect(world.closed()).toBe(1), { timeout: 500 });
  });

  test('keeps a malformed successful SDK response terminal even if a later response would be valid', async () => {
    const world = await fixture((_request, response, index) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(index === 1 ? '{invalid' : JSON.stringify(namespace()));
    });
    const reads = new KubernetesApiReads({
      timeoutMs: 100,
      attemptMs: 50,
      intervalMs: 1,
    });
    await expect(
      reads.read('malformed namespace', (options) =>
        world.clients.core.readNamespace({ name: 'kube-system' }, options),
      ),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(world.requests).toHaveLength(1);
    await vi.waitFor(() => expect(world.closed()).toBe(1), { timeout: 500 });
  });

  test('foreground cancellation closes the actual request and does not cancel cleanup reads', async () => {
    const world = await fixture((_request, response, index) => {
      if (index === 1) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(namespace()));
    });
    const foreground = new AbortController();
    const reads = new KubernetesApiReads({
      signal: foreground.signal,
      timeoutMs: 1_000,
      attemptMs: 500,
      intervalMs: 1,
    });
    const failure = new Error('foreground test cancelled');
    const promise = reads.read('foreground namespace', (options) =>
      world.clients.core.readNamespace({ name: 'kube-system' }, options),
    );
    const rejection = expect(promise).rejects.toBe(failure);
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    foreground.abort(failure);
    await rejection;
    const cleanup = new KubernetesApiReads({
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      attemptMs: 500,
      intervalMs: 1,
    });
    expect(
      (
        await cleanup.read('cleanup namespace', (options) =>
          world.clients.core.readNamespace({ name: 'kube-system' }, options),
        )
      ).metadata?.name,
    ).toBe('kube-system');
    expect(world.requests).toHaveLength(2);
    await vi.waitFor(() => expect(world.closed()).toBe(2), { timeout: 500 });
  });

  test('preserves the original unavailable exception as the exhausted observation cause', async () => {
    const original = fetchFailure('ETIMEDOUT');
    const reads = new KubernetesApiReads({
      timeoutMs: 10,
      attemptMs: 5,
      intervalMs: 1,
    });
    const [result] = await Promise.allSettled([
      reads.read('bounded native read', async () => {
        throw original;
      }),
    ]);
    if (result?.status !== 'rejected')
      throw new Error('Expected native read exhaustion');
    const failure: unknown = result.reason;
    if (!(failure instanceof Error))
      throw new Error('Expected native read failure with original cause');
    expect(failure.cause).toBe(original);
  });

  test('takes missing-resource status from HTTP metadata, never a quoted body', () => {
    expect(
      kubernetesStatusCode(new ApiException(401, 'auth', { code: 404 }, {})),
    ).toBe(401);
    expect(
      kubernetesStatusCode(
        new ApiException(503, 'unavailable', { code: 404 }, {}),
      ),
    ).toBe(503);
    expect(
      kubernetesStatusCode(new ApiException(404, 'gone', { code: 404 }, {})),
    ).toBe(404);
    expect(kubernetesStatusCode({ body: { code: 404 } })).toBeUndefined();
    expect(
      kubernetesStatusCode({ statusCode: 401, body: '{"code":404}' }),
    ).toBe(401);
  });
});
