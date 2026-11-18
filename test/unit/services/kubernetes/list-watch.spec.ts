import { KubeConfig } from '@kubernetes/client-node';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKubernetesListWatch,
  KubernetesHttpError,
} from '../../../../src/api/services/kubernetes/list-watch.js';

const httpServers: Server[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.restoreAllMocks();
});

async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  httpServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [
      {
        name: 'cluster',
        server: `http://127.0.0.1:${address.port}`,
        skipTLSVerify: true,
      },
    ],
    users: [
      { name: 'user', token: 'watch-token', impersonateUser: 'observing-user' },
    ],
    contexts: [{ name: 'context', user: 'user', cluster: 'cluster' }],
    currentContext: 'context',
  });
  const controller = new AbortController();
  controllers.push(controller);
  const events = vi.fn();
  const listWatch = createKubernetesListWatch(kubeConfig);
  const watch = () =>
    listWatch.watch(
      '/api/v1/pods',
      {
        labelSelector: 'app.kubernetes.io/managed-by=anycloud',
        resourceVersion: '71',
      },
      controller.signal,
      (event) => events(event.type, event.object.metadata?.name),
    );
  return { kubeConfig, controller, events, watch, listWatch, server };
}

const event = (name: string, type = 'MODIFIED') =>
  JSON.stringify({ type, object: { metadata: { name } } }) + '\n';

describe('cancellable authenticated Kubernetes list-watch', () => {
  it('watches cluster-wide through the SDK authentication path', async () => {
    const requests: Array<{
      url: string;
      authorization?: string;
      impersonation?: string | string[];
    }> = [];
    const f = await fixture((req, res) => {
      requests.push({
        url: req.url!,
        authorization: req.headers.authorization,
        impersonation: req.headers['impersonate-user'],
      });
      res.writeHead(200);
      res.end(event('replica'));
    });
    await f.watch();
    const url = new URL(requests[0].url, 'http://fixture');
    expect(url.pathname).toBe('/api/v1/pods');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      labelSelector: 'app.kubernetes.io/managed-by=anycloud',
      resourceVersion: '71',
      watch: 'true',
    });
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer watch-token',
      impersonation: 'observing-user',
    });
    expect(f.events.mock.calls).toEqual([['MODIFIED', 'replica']]);
    f.kubeConfig.users = [
      { ...f.kubeConfig.getCurrentUser()!, token: 'refreshed-token' },
    ];
    await f.watch();
    expect(requests[1].authorization).toBe('Bearer refreshed-token');
  });

  it('lists with timestamps as Dates and the list resourceVersion', async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(200);
      const body = JSON.stringify({
        metadata: { resourceVersion: '72' },
        items: [
          {
            metadata: {
              name: 'replica',
              creationTimestamp: '2026-10-05T10:00:00Z',
            },
          },
        ],
      });
      res.write(body.slice(0, 20));
      res.end(body.slice(20));
    });
    const listed = await f.listWatch.list(
      '/api/v1/pods',
      { resourceVersion: '0' },
      f.controller.signal,
    );
    expect(listed.resourceVersion).toBe('72');
    expect(listed.items[0]?.metadata?.creationTimestamp).toEqual(
      new Date('2026-10-05T10:00:00Z'),
    );
  });

  it('rejects a list without a resourceVersion, which it could not watch from', async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ items: [] }));
    });
    await expect(
      f.listWatch.list('/api/v1/pods', {}, f.controller.signal),
    ).rejects.toThrow('no resourceVersion');
  });

  it("carries a 429's Retry-After", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(429, { 'retry-after': '3' });
      res.end();
    });
    await expect(
      f.listWatch.list('/api/v1/nodes', {}, f.controller.signal),
    ).rejects.toMatchObject({ code: 429, retryAfterMs: 3_000 });
  });

  it('decodes fragmented UTF-8 events, bookmarks and deletions', async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(200);
      const data = Buffer.from(
        event('d-é') +
          JSON.stringify({
            type: 'BOOKMARK',
            object: { metadata: { name: 'bookmark', resourceVersion: '72' } },
          }) +
          '\n\n' + // a blank line between events is skipped
          event('d-é', 'DELETED') +
          '  ', // so is trailing whitespace at the end of the stream
      );
      const multibyte = data.indexOf(Buffer.from('é'));
      res.write(data.subarray(0, multibyte + 1));
      setImmediate(() => res.end(data.subarray(multibyte + 1)));
    });
    await f.watch();
    expect(f.events.mock.calls).toEqual([
      ['MODIFIED', 'd-é'],
      ['BOOKMARK', 'bookmark'],
      ['DELETED', 'd-é'],
    ]);
  });

  it('uses the configured proxy agent rather than making a direct connection', async () => {
    const tunnels: string[] = [];
    const requests: string[] = [];
    const direct = vi.fn();
    const f = await fixture(direct);
    // The SDK's hpagent uses CONNECT for HTTP as well as HTTPS targets.
    f.server.on('connect', (request, socket) => {
      tunnels.push(request.url!);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data: Buffer) => {
        requests.push(data.toString());
        const body = event('proxied');
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    });
    const cluster = f.kubeConfig.clusters[0];
    f.kubeConfig.clusters = [
      {
        ...cluster,
        proxyUrl: cluster.server,
        server: 'http://kubernetes.invalid/',
      },
    ];
    await f.watch();
    expect(tunnels).toEqual(['kubernetes.invalid:80']);
    expect(requests[0]).toContain('GET /api/v1/pods?');
    expect(direct).not.toHaveBeenCalled();
    expect(f.events.mock.calls).toEqual([['MODIFIED', 'proxied']]);
  });

  it.each(['before headers', 'during stream'] as const)(
    'cancels the owned HTTP request %s',
    async (phase) => {
      const closed = vi.fn();
      let arrived!: () => void;
      const received = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const f = await fixture((req, res) => {
        req.socket.once('close', closed);
        if (phase === 'during stream') {
          res.writeHead(200);
          res.write(event('first'));
        }
        arrived();
      });
      const result = f.watch();
      const rejection = expect(result).rejects.toThrow();
      await received;
      if (phase === 'during stream')
        await vi.waitFor(() => expect(f.events).toHaveBeenCalledOnce());
      f.controller.abort(new Error('receiver disconnected'));
      await rejection;
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    },
  );

  it('does not send a request after cancelled authentication eventually returns', async () => {
    const received = vi.fn();
    const f = await fixture(received);
    let finish!: () => void;
    vi.spyOn(
      f.kubeConfig,
      'applySecurityAuthentication',
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const result = f.watch();
    const reason = new Error('receiver disconnected');
    const rejection = expect(result).rejects.toBe(reason);
    f.controller.abort(reason);
    finish();
    await rejection;
    expect(received).not.toHaveBeenCalled();
  });

  it.each([
    [
      'expired resourceVersion',
      JSON.stringify({ type: 'ERROR', object: { code: 410 } }) + '\n',
      new KubernetesHttpError(410),
    ],
    ['malformed JSON', '{broken}\n', 'Invalid Kubernetes watch JSON'],
    [
      'invalid event',
      JSON.stringify({ type: 'UNEXPECTED' }) + '\n',
      'Invalid Kubernetes watch event',
    ],
    ['incomplete event', '{"type":', 'incomplete event'],
    ['oversized event', 'x'.repeat(2 * 1024 * 1024 + 1), 'size bound'],
  ])(
    'rejects %s so the informer can resume or relist',
    async (_name, data, error) => {
      const f = await fixture((_req, res) => {
        res.writeHead(200);
        res.end(data);
      });
      await expect(f.watch()).rejects.toThrow(error);
      expect(f.events).not.toHaveBeenCalled();
    },
  );

  it('releases an unavailable API response instead of retaining its body', async () => {
    const closed = vi.fn();
    const f = await fixture((req, res) => {
      req.socket.once('close', closed);
      res.writeHead(503);
      res.write('unavailable');
    });
    await expect(f.watch()).rejects.toThrow('HTTP 503');
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(f.events).not.toHaveBeenCalled();
  });
});
