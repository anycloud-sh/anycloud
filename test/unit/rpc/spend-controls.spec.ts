import { request as httpRequest, type Server } from 'node:http';
import { ORPCError } from '@orpc/client';
import express from 'express';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import {
  API_RPC_BODY_LIMIT_BYTES,
  createApiRpcMiddleware,
} from '../../../src/api/rpc/express.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import type { AuthenticateApiRequest } from '../../../src/api/services/api-authentication.js';
import type { User } from '../../../src/api/services/entities.js';
import type { SpendControlsDomain } from '../../../src/api/services/spend-controls-domain.js';
import type {
  ListBudgetsResponse,
  ListThrottlesResponse,
} from '../../../src/shared/api-contract/spend-controls-schemas.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { getAnycloudVersion } from '../../../src/shared/services/api-client/runtime.js';
import {
  createApiClient,
  type ApiClient,
} from '../../../src/shared/services/api-client/rpc.js';

const ACTOR = {
  id: 'user-1',
  username: 'octocat',
  token: 'valid-token',
} satisfies User;

function createDomain(): SpendControlsDomain {
  return {
    listThrottles: vi.fn(async () => ({
      entries: [],
      burnRate: { account: { currentUsd: 0 } },
    })),
    setThrottle: vi.fn(async () => undefined),
    unsetThrottle: vi.fn(async () => undefined),
    listBudgets: vi.fn(async () => ({ entries: [], spend: [] })),
    setBudget: vi.fn(async () => undefined),
    unsetBudget: vi.fn(async () => undefined),
  };
}

describe('production oRPC spend controls', () => {
  let server: Server;
  let apiUrl: string;
  let domain: SpendControlsDomain;
  let authenticate: AuthenticateApiRequest;

  beforeEach(async () => {
    domain = createDomain();
    authenticate = vi.fn(async (token) => {
      if (token !== ACTOR.token) throw new Error('Invalid access token');
      return ACTOR;
    });

    const app = express();
    app.get('/v1/version', (_req, res) => {
      res.json({ version: getAnycloudVersion() });
    });
    app.use(
      createApiRpcMiddleware({
        authenticate,
        domains: createApiRpcDomains({
          overrides: { spendControls: domain },
        }),
      }),
    );
    app.use(express.json());
    app.post('/v1/legacy-echo', (req, res) => {
      res.json({ echoed: req.body });
    });
    app.post('/v1/native-bytes', async (req, res) => {
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.isBuffer(chunk)
          ? chunk.byteLength
          : Buffer.byteLength(String(chunk));
      }
      res.json({ bytes });
    });

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address');
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.restoreAllMocks();
  });

  function client(
    options: Partial<Parameters<typeof createApiClient>[1]> = {},
  ): ApiClient {
    return createApiClient(ACTOR.token, {
      apiUrl,
      retryDelayMs: 0,
      ...options,
    });
  }

  function sendChunkedRequest(body: string): Promise<{
    status: number;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        `${apiUrl}/v1/spend/throttles/account`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${ACTOR.token}`,
            [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
            'content-type': 'application/json',
          },
        },
        (response) => {
          response.setEncoding('utf8');
          let responseBody = '';
          response.on('data', (chunk: string) => {
            responseBody += chunk;
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: responseBody,
            });
          });
        },
      );
      request.on('error', reject);
      const midpoint = Math.floor(body.length / 2);
      request.write(body.slice(0, midpoint));
      request.write(body.slice(midpoint));
      request.end();
    });
  }

  it('uses the shared client type for all six operations and preserves paths', async () => {
    const api = client();
    const setThrottle = await api.spend.throttles.set({
      params: { scope: 'agent-session' },
      body: { capUsd: 20 },
    });
    const throttles = await api.spend.throttles.list();
    const unsetThrottle = await api.spend.throttles.unset({
      params: { scope: 'agent-session' },
    });
    const setBudget = await api.spend.budgets.set({
      params: { period: 'month', scope: 'account' },
      body: { capUsd: 500 },
    });
    const budgets = await api.spend.budgets.list();
    const unsetBudget = await api.spend.budgets.unset({
      params: { period: 'month', scope: 'account' },
    });

    expect(setThrottle).toBeUndefined();
    expect(throttles).toEqual({
      entries: [],
      burnRate: { account: { currentUsd: 0 } },
    });
    expect(unsetThrottle).toBeUndefined();
    expect(setBudget).toBeUndefined();
    expect(budgets).toEqual({ entries: [], spend: [] });
    expect(unsetBudget).toBeUndefined();
    expect(authenticate).toHaveBeenCalledTimes(6);
    expect(domain.setThrottle).toHaveBeenCalledWith({
      scope: 'agent-session',
      capUsd: 20,
    });
    expectTypeOf(throttles).toEqualTypeOf<ListThrottlesResponse>();
    expectTypeOf(budgets).toEqualTypeOf<ListBudgetsResponse>();

    const rawDelete = await fetch(
      `${apiUrl}/v1/spend/throttles/agent-session`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${ACTOR.token}`,
          [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
        },
      },
    );
    expect(rawDelete.status).toBe(204);
    await expect(rawDelete.text()).resolves.toBe('');
  });

  it('authenticates by default and validates input and output at runtime', async () => {
    const missingAuth = await fetch(`${apiUrl}/v1/spend/throttles`, {
      headers: {
        [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
      },
    });
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Missing access token',
    });

    const malformed = await fetch(`${apiUrl}/v1/spend/throttles/account`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ACTOR.token}`,
        [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        capUsd: -1,
        invented: true,
      }),
    });
    expect(malformed.status).toBe(400);
    expect(domain.setThrottle).not.toHaveBeenCalled();

    const invalidOutput: ListBudgetsResponse = { entries: [], spend: [] };
    Object.defineProperty(invalidOutput, 'spend', {
      value: [
        {
          period: 'day',
          scope: 'account',
          startMs: 200,
          endMs: 100,
          actualUsd: 0,
          estimatedUsd: 0,
          totalUsd: 0,
        },
      ],
    });
    vi.mocked(domain.listBudgets).mockResolvedValue(invalidOutput);
    await expect(client().spend.budgets.list()).rejects.toMatchObject({
      status: 500,
    });
  });

  it('rejects a missing or mismatched client version before auth and domain logic', async () => {
    const missing = await fetch(`${apiUrl}/v1/spend/throttles`, {
      headers: { authorization: `Bearer ${ACTOR.token}` },
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      code: 'CLIENT_VERSION_MISMATCH',
    });

    const mismatched = await fetch(`${apiUrl}/v1/spend/throttles`, {
      headers: {
        authorization: `Bearer ${ACTOR.token}`,
        [ANYCLOUD_CLIENT_VERSION_HEADER]: '0.0.0-incompatible',
      },
    });
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toMatchObject({
      code: 'CLIENT_VERSION_MISMATCH',
    });

    expect(authenticate).not.toHaveBeenCalled();
    expect(domain.listThrottles).not.toHaveBeenCalled();

    const diagnostic = await fetch(`${apiUrl}/v1/version`);
    expect(diagnostic.status).toBe(200);
  });

  it('retries idempotent server failures but not validation errors', async () => {
    vi.mocked(domain.setThrottle)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);

    await expect(
      client().spend.throttles.set({
        params: { scope: 'account' },
        body: { capUsd: 10 },
      }),
    ).resolves.toBeUndefined();
    expect(domain.setThrottle).toHaveBeenCalledTimes(2);

    let endpointRequests = 0;
    const observingFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === '/v1/spend/throttles/account') endpointRequests += 1;
      return globalThis.fetch(input, init);
    };
    await expect(
      client({ fetch: observingFetch }).spend.throttles.set({
        params: { scope: 'account' },
        body: { capUsd: 0 },
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(endpointRequests).toBe(1);
  });

  it('does not retry a caller-aborted request', async () => {
    let endpointRequests = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blockingFetch: typeof globalThis.fetch = async (input, init) => {
      endpointRequests += 1;
      markStarted?.();
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('Expected request cancellation signal'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new Error('aborted')),
          { once: true },
        );
      });
    };

    const controller = new AbortController();
    const result = client({ fetch: blockingFetch }).spend.budgets.list(
      undefined,
      {
        signal: controller.signal,
      },
    );
    await started;
    controller.abort(new Error('caller canceled'));

    await expect(result).rejects.toThrow();
    expect(endpointRequests).toBe(1);
    expect(domain.listBudgets).not.toHaveBeenCalled();
  });

  it('rejects oversized declared-length and chunked contract bodies', async () => {
    const oversizedBody = JSON.stringify({
      capUsd: 10,
      padding: 'x'.repeat(API_RPC_BODY_LIMIT_BYTES),
    });
    const headers = {
      authorization: `Bearer ${ACTOR.token}`,
      [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
      'content-type': 'application/json',
    };

    const declaredLength = await fetch(`${apiUrl}/v1/spend/throttles/account`, {
      method: 'PUT',
      headers,
      body: oversizedBody,
    });
    expect(declaredLength.status).toBe(413);
    await expect(declaredLength.json()).resolves.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });

    const chunked = await sendChunkedRequest(oversizedBody);
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body)).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(domain.setThrottle).not.toHaveBeenCalled();
  });

  it('leaves unmatched JSON and byte-stream routes on Express', async () => {
    const legacy = await fetch(`${apiUrl}/v1/legacy-echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ still: 'express' }),
    });
    await expect(legacy.json()).resolves.toEqual({
      echoed: { still: 'express' },
    });

    const nativePayload = new Uint8Array(API_RPC_BODY_LIMIT_BYTES + 1);
    const bytes = await fetch(`${apiUrl}/v1/native-bytes`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: nativePayload,
    });
    await expect(bytes.json()).resolves.toEqual({
      bytes: nativePayload.byteLength,
    });
  });
});
