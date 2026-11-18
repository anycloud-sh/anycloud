import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CoreV1Api, KubeConfig, loadAllYaml } from '@kubernetes/client-node';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createApiServiceAccountTokens,
  TRUST_PROBE_SERVICE_ACCOUNT,
} from '../../../../src/api/services/kubernetes/service-account-token.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function kubeConfigFor(server: string): KubeConfig {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: 'c', server, skipTLSVerify: true }],
    users: [{ name: 'u', token: 'api' }],
    contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
    currentContext: 'x',
  });
  return kubeConfig;
}

/** A loopback port nothing listens on, so connections to it are refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Settle a TokenRequest under fake timers: real sockets get a turn of the event
 * loop, then the retry's backoff elapses. `onWait` runs before each backoff.
 */
async function settle<T>(
  request: Promise<T>,
  onWait: () => Promise<void> = async () => {},
): Promise<{ result: PromiseSettledResult<T>; elapsedMs: number }> {
  const start = Date.now();
  let result: PromiseSettledResult<T> | undefined;
  void request.then(
    (value) => (result = { status: 'fulfilled', value }),
    (reason: unknown) => (result = { status: 'rejected', reason }),
  );
  while (!result) {
    await new Promise((resolve) => setImmediate(resolve));
    if (vi.getTimerCount() > 0) {
      await onWait();
      await vi.advanceTimersToNextTimerAsync();
    }
  }
  return { result, elapsedMs: Date.now() - start };
}

test('a TokenRequest refused while the API server restarts succeeds once it listens again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const port = await closedPort();
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenRequest',
        spec: { audiences: ['sts.amazonaws.com'] },
        status: {
          token: `jwt for ${request.url}`,
          expirationTimestamp: '2026-11-09T00:00:00Z',
        },
      }),
    );
  });
  let refused = 0;
  try {
    const { result } = await settle(
      createApiServiceAccountTokens(kubeConfigFor(`http://127.0.0.1:${port}`))(
        'sts.amazonaws.com',
      ),
      async () => {
        // The server comes back after the third refusal.
        if (++refused === 3)
          await new Promise<void>((resolve) =>
            server.listen(port, '127.0.0.1', resolve),
          );
      },
    );
    expect(result).toEqual({
      status: 'fulfilled',
      value:
        'jwt for /api/v1/namespaces/anycloud-system/serviceaccounts/anycloud-api/token',
    });
    expect(refused).toBe(3);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test('a TokenRequest the API server keeps refusing fails after about two minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const port = await closedPort();
  let refused = 0;
  const { result, elapsedMs } = await settle(
    createApiServiceAccountTokens(kubeConfigFor(`http://127.0.0.1:${port}`))(
      'sts.amazonaws.com',
    ),
    async () => {
      refused++;
    },
  );

  expect(result.status).toBe('rejected');
  expect(
    (result as PromiseRejectedResult).reason as { code?: string },
  ).toMatchObject({ code: 'ECONNREFUSED' });
  expect(refused).toBe(17);
  expect(elapsedMs).toBeGreaterThanOrEqual(110_000);
  expect(elapsedMs).toBeLessThanOrEqual(120_000);
});

test('a cancelled TokenRequest stops waiting for a refusing API server', async () => {
  const port = await closedPort();
  const controller = new AbortController();
  const reason = new Error('request cancelled');
  const request = createApiServiceAccountTokens(
    kubeConfigFor(`http://127.0.0.1:${port}`),
  )('sts.amazonaws.com', controller.signal);
  // Real timers: the first backoff is 1 s, so a prompt rejection proves the
  // abort ended the wait rather than the retry running out.
  setTimeout(() => controller.abort(reason), 100);
  const start = Date.now();

  await expect(request).rejects.toBe(reason);
  expect(Date.now() - start).toBeLessThan(900);
});

test('a TokenRequest the API server answers with an error is not repeated', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.statusCode = 403;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ kind: 'Status', status: 'Failure', code: 403 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await expect(
      createApiServiceAccountTokens(kubeConfigFor(`http://127.0.0.1:${port}`))(
        'sts.amazonaws.com',
      ),
    ).rejects.toMatchObject({ code: 403 });
    expect(requests).toBe(1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("requests the API's own and the trust probe's tokens for one audience, which the chart lets it do and nothing more", async () => {
  const request = vi
    .spyOn(CoreV1Api.prototype, 'createNamespacedServiceAccountToken')
    .mockResolvedValue({
      spec: { audiences: [] },
      status: { token: 'jwt', expirationTimestamp: new Date() },
    });
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: 'c', server: 'https://127.0.0.1:6443' }],
    users: [{ name: 'u' }],
    contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
    currentContext: 'x',
  });

  await expect(
    createApiServiceAccountTokens(kubeConfig)('sts.amazonaws.com'),
  ).resolves.toBe('jwt');
  await createApiServiceAccountTokens(
    kubeConfig,
    TRUST_PROBE_SERVICE_ACCOUNT,
  )('sts.amazonaws.com');

  const calls = request.mock.calls.map(([call]) => call);
  expect(calls.map(({ body }) => body.spec.audiences)).toEqual([
    ['sts.amazonaws.com'],
    ['sts.amazonaws.com'],
  ]);
  expect(new Set(calls.map(({ namespace }) => namespace))).toEqual(
    new Set(['anycloud-system']),
  );
  const docs = loadAllYaml(
    readFileSync('charts/anycloud-api/templates/rbac.yaml', 'utf8').replace(
      /^.*\{\{.*\}\}.*$/gm,
      '',
    ),
  ) as {
    kind?: string;
    metadata?: { name?: string };
    rules?: unknown;
    subjects?: { name?: string }[];
    automountServiceAccountToken?: boolean;
  }[];
  const role = docs.find(
    (doc) =>
      doc?.kind === 'Role' && doc.metadata?.name === 'anycloud-api-token',
  );
  expect(role?.rules).toEqual([
    {
      apiGroups: [''],
      resources: ['serviceaccounts/token'],
      resourceNames: calls.map(({ name }) => name),
      verbs: ['create'],
    },
  ]);
  // The probe exists, no Pod mounts it, and nothing grants it anything.
  expect(
    docs.find(
      (doc) =>
        doc?.kind === 'ServiceAccount' &&
        doc.metadata?.name === TRUST_PROBE_SERVICE_ACCOUNT,
    )?.automountServiceAccountToken,
  ).toBe(false);
  expect(
    docs.flatMap((doc) => doc?.subjects ?? []).map(({ name }) => name),
  ).not.toContain(TRUST_PROBE_SERVICE_ACCOUNT);
});
