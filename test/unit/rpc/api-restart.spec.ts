import type { Server } from 'node:http';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../../../src/api/server.js';
import { createApiRequestTracker } from '../../../src/api/services/http-shutdown.js';
import type { createApiClient as CreateApiClient } from '../../../src/shared/services/api-client/rpc.js';
import { testAuthenticate } from '../../helpers/test-authentication.js';

const owner = { userId: '1', username: 'owner' };
const ADMISSION = { image: 'alpine:3.20', cloudConfig: {} };

describe('API restart', () => {
  let draining: Server;
  let drainingUrl: string;
  let stderr: string[];
  let createApiClient: typeof CreateApiClient;

  beforeAll(async () => {
    const requests = createApiRequestTracker();
    requests.beginDrain();
    draining = await new Promise((resolve) => {
      const server = createApp({
        requests,
        authenticate: testAuthenticate,
      }).listen(0, '127.0.0.1', () => resolve(server));
    });
    const address = draining.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    drainingUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise((resolve) => draining.close(resolve)));

  beforeEach(async () => {
    // The wait is announced once per process.
    vi.resetModules();
    ({ createApiClient } = await import(
      '../../../src/shared/services/api-client/rpc.js'
    ));
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    return () => vi.restoreAllMocks();
  });

  /** The first `outages` requests meet the outage; the next one answers `body`. */
  function client(
    outages: number,
    outage:
      | 'draining'
      | 'proxy'
      | 'cloudflare'
      | 'reset'
      | 'bun-reset'
      | 'bun-refused'
      | 'timeout'
      | 'dns',
    body: unknown,
  ) {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      attempts += 1;
      if (attempts > outages) return Response.json(body);
      if (outage === 'timeout') {
        throw new DOMException('timed out', 'TimeoutError');
      }
      if (outage === 'bun-reset' || outage === 'bun-refused') {
        // Bun's fetch: the network error itself, with no cause.
        const code =
          outage === 'bun-reset' ? 'ECONNRESET' : 'ConnectionRefused';
        throw Object.assign(new Error('socket closed'), { code });
      }
      if (outage === 'reset' || outage === 'dns') {
        const code = outage === 'reset' ? 'ECONNRESET' : 'ENOTFOUND';
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(code), { code }),
        });
      }
      if (outage === 'proxy') {
        return new Response('no available server', { status: 503 });
      }
      if (outage === 'cloudflare') return new Response('', { status: 522 });
      const request = new Request(input, init);
      const url = new URL(request.url);
      return globalThis.fetch(
        new Request(`${drainingUrl}${url.pathname}`, request),
      );
    };
    const api = createApiClient('token', {
      apiUrl: 'http://api.example.test',
      fetch,
      retryDelayMs: 0,
    });
    return { api, attempts: () => attempts };
  }

  it('answers a declared API_RESTARTING 503 with Retry-After while draining', async () => {
    const response = await fetch(`${drainingUrl}/health`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toEqual({
      defined: true,
      code: 'API_RESTARTING',
      status: 503,
      message: 'API server is restarting',
    });
  });

  it('replays a not-processed admission through the drain, announcing the wait once', async () => {
    const { api, attempts } = client(5, 'draining', { id: 'job-1' });
    await expect(api.admission.submit(ADMISSION)).resolves.toEqual({
      id: 'job-1',
    });
    expect(attempts()).toBe(6);
    expect(stderr).toEqual(['API restarting, waiting…\n']);
    await client(1, 'draining', { id: 'job-2' }).api.admission.submit(
      ADMISSION,
    );
    expect(stderr).toHaveLength(1);
  });

  it('retries safe reads through proxy 503s, Cloudflare 52x and reset connections', async () => {
    for (const outage of [
      'proxy',
      'cloudflare',
      'reset',
      'bun-reset',
    ] as const) {
      const { api, attempts } = client(8, outage, { owner, users: [] });
      await expect(api.apiAccess.list()).resolves.toEqual({ owner, users: [] });
      expect(attempts()).toBe(9);
    }
  });

  it.each([
    ['a not-processed admission behind a proxy 503', 'proxy', 'submit'],
    ['a never-replayed command while draining', 'draining', 'grant'],
    ['a never-replayed command behind a proxy 503', 'proxy', 'grant'],
  ] as const)('sends %s once', async (_name, outage, call) => {
    const { api, attempts } = client(1, outage, owner);
    const failed =
      call === 'submit'
        ? api.admission.submit(ADMISSION)
        : api.apiAccess.grant({ username: 'u' });
    await expect(failed).rejects.toMatchObject({ status: 503 });
    if (outage === 'proxy') {
      await expect(failed).rejects.toThrow(/Check whether the operation/);
    }
    expect(attempts()).toBe(1);
  });

  it.each([
    ['a timeout', 'timeout'],
    ['a DNS failure', 'dns'],
    ["Bun's refused connection, which DNS failures share", 'bun-refused'],
  ] as const)('treats %s as no restart', async (_name, outage) => {
    const { api, attempts } = client(100, outage, owner);
    await expect(api.apiAccess.list()).rejects.toThrow();
    // At most the short profile: no restart wait, no announcement.
    expect(attempts()).toBeLessThanOrEqual(3);
    expect(stderr).toEqual([]);
  });

  it('stops waiting 120 s after the first failure', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 30_000));
    const { api, attempts } = client(100, 'proxy', owner);
    await expect(api.apiAccess.list()).rejects.toThrow(/HTTP 503/);
    expect(attempts()).toBe(4);
    expect(stderr.at(-1)).toBe('API still unavailable after 3 retries.\n');
  });

  it('gives up after its retry cap and says so', async () => {
    const { api, attempts } = client(100, 'proxy', owner);
    await expect(api.apiAccess.list()).rejects.toThrow(/HTTP 503/);
    expect(attempts()).toBe(27);
    expect(stderr).toEqual([
      'API restarting, waiting…\n',
      'API still unavailable after 26 retries.\n',
    ]);
  });
});
