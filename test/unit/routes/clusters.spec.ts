import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import type { User } from '../../../src/api/services/entities.js';

import { type ClustersDomain } from '../../../src/api/services/clusters-domain.js';
import {
  HostedApiAccessError,
  ClusterReachableError,
  ClusterUnreachableError,
  ClusterVmPresentError,
} from '../../../src/api/services/cluster-errors.js';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { getAnycloudVersion } from '../../../src/shared/services/api-client/runtime.js';

const actor: User = {
  id: 'test-user',
  username: 'test-user',
  token: 'test-token',
};
const auth = {
  Authorization: 'Bearer test-token',
  [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
};

describe('kubernetes cluster routes', () => {
  let server: Server;
  let baseUrl: string;
  let destroy: ReturnType<typeof vi.fn<ClustersDomain['destroy']>>;
  let forget: ReturnType<typeof vi.fn<ClustersDomain['forget']>>;

  beforeEach(async () => {
    resetPersistence();
    destroy = vi.fn<ClustersDomain['destroy']>();
    forget = vi.fn<ClustersDomain['forget']>();
    const clusters: ClustersDomain = {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      destroy,
      forget,
    };
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: vi.fn(async (token) => {
          if (token !== actor.token) throw new Error('Invalid access token');
          return actor;
        }),
        domains: createApiRpcDomains({
          overrides: { clusters },
        }),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}/v1`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it.each([
    [
      'DELETE',
      '',
      () => destroy,
      new ClusterUnreachableError('restore it'),
      'CLUSTER_UNREACHABLE',
    ],
    [
      'POST',
      '/forget',
      () => forget,
      new ClusterReachableError('delete it'),
      'CLUSTER_REACHABLE',
    ],
    [
      'POST',
      '/forget',
      () => forget,
      new ClusterVmPresentError('terminate it'),
      'CLUSTER_VM_PRESENT',
    ],
  ] as const)(
    'maps a %s%s refusal to its declared code',
    async (method, suffix, handler, error, code) => {
      handler().mockRejectedValue(error);
      const response = await fetch(`${baseUrl}/clusters/install-1${suffix}`, {
        method,
        headers: auth,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code,
        message: error.message,
      });
    },
  );

  it('maps a hosted API that refused the destroy inventory to 400', async () => {
    destroy.mockRejectedValue(
      new HostedApiAccessError('https://install-1.anycloud.sh', 403),
    );
    const response = await fetch(
      `${baseUrl}/clusters/install-1?deleteBuckets=true`,
      { method: 'DELETE', headers: auth },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe('CLUSTER_INVALID');
    expect(body.message).toContain('refused this account (HTTP 403)');
    expect(destroy).toHaveBeenCalledWith(
      expect.anything(),
      'install-1',
      { deleteBuckets: true },
      expect.anything(),
    );
  });
});
