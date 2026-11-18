import type { Server } from 'node:http';
import { ORPCError } from '@orpc/client';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { DeploymentDomainError } from '../../../src/api/services/deployment-errors.js';
import type { DeploymentsDomain } from '../../../src/api/services/deployments-domain.js';
import type { User } from '../../../src/api/services/entities.js';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import { InvalidAnycloudConfigError } from '../../../src/shared/errors.js';
import packageJson from '../../../package.json' with { type: 'json' };

const actor = {
  id: 'user-id',
  username: 'user',
  token: 'valid-token',
} satisfies User;

describe('Deployment RPC', () => {
  let server: Server;
  let apiUrl: string;
  let domain: DeploymentsDomain;

  beforeEach(async () => {
    domain = {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: vi.fn(async () => actor),
        domains: createApiRpcDomains({
          overrides: { deployments: domain },
        }),
      }),
    );
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
  });

  it.each([undefined, {}, { query: {} }])(
    'keeps unfiltered list calls working: %j',
    async (input) => {
      vi.mocked(domain.list).mockResolvedValue({ deployments: [] });
      const client = createApiClient(actor.token, { apiUrl });
      await expect(client.deployments.list(input)).resolves.toEqual({
        deployments: [],
      });
      expect(domain.list).toHaveBeenCalledWith(
        actor,
        undefined,
        expect.anything(),
      );
    },
  );

  it('sends the node pool list filter through the typed HTTP client', async () => {
    vi.mocked(domain.list).mockResolvedValue({ deployments: [] });
    const client = createApiClient(actor.token, { apiUrl });
    await expect(
      client.deployments.list({ query: { nodePool: 'aws-east' } }),
    ).resolves.toEqual({ deployments: [] });
    expect(domain.list).toHaveBeenLastCalledWith(
      actor,
      { nodePool: 'aws-east' },
      expect.anything(),
    );
  });

  it('returns the declared validation error for an unknown node pool', async () => {
    vi.mocked(domain.list).mockRejectedValue(
      new DeploymentDomainError('Node pool not found', 400),
    );
    const client = createApiClient(actor.token, { apiUrl, retryDelayMs: 0 });
    await expect(
      client.deployments.list({ query: { nodePool: 'missing' } }),
    ).rejects.toMatchObject({
      code: 'DEPLOYMENT_INVALID',
      status: 400,
      message: 'Node pool not found',
      defined: true,
    });
  });

  it('rejects the removed Cluster routes', async () => {
    const headers = { Authorization: `Bearer ${actor.token}` };
    const [collection, workload] = await Promise.all([
      fetch(`${apiUrl}/v1/cluster-deployments`, { headers }),
      fetch(`${apiUrl}/v1/cluster-deployments/deployment/jobs/next`, {
        method: 'POST',
        headers,
      }),
    ]);

    expect(collection.status).toBe(404);
    expect(workload.status).toBe(404);
    expect(domain.list).not.toHaveBeenCalled();
  });

  it.each([
    [400 as const, 'DEPLOYMENT_INVALID'],
    [503 as const, 'DEPLOYMENT_UNAVAILABLE'],
  ])('maps status %i to the declared %s error', async (statusCode, code) => {
    const failure = new DeploymentDomainError(
      'Kubernetes validation failed',
      statusCode,
    );
    vi.mocked(domain.create).mockRejectedValue(failure);

    await expect(
      createApiClient(actor.token, {
        apiUrl,
        retryDelayMs: 0,
      }).deployments.create({
        name: 'deployment',
        image: 'deployment:latest',
        nodePool: 'training',
        maxConcurrentJobsPerReplica: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ORPCError<string, unknown>>>({
        code,
        status: statusCode,
        defined: true,
      }),
    );
  });

  it('accepts the shared GPU option representation and maps semantic failures', async () => {
    vi.mocked(domain.create).mockRejectedValue(
      new InvalidAnycloudConfigError(
        'GPU options are incompatible with capacity',
      ),
    );
    const input = {
      name: 'deployment',
      image: 'deployment:latest',
      nodePool: 'training',
      maxConcurrentJobsPerReplica: 1,
      dockerOptions: { gpus: 'all', runtime: 'nvidia' },
    };
    await expect(
      createApiClient(actor.token, {
        apiUrl,
        retryDelayMs: 0,
      }).deployments.create(input),
    ).rejects.toMatchObject({ status: 400, code: 'DEPLOYMENT_INVALID' });
    expect(domain.create).toHaveBeenCalledWith(actor, input, expect.anything());
  });

  it('rejects the removed GPU count input before invoking the domain', async () => {
    const input = {
      name: 'deployment',
      image: 'deployment:latest',
      nodePool: 'training',
      maxConcurrentJobsPerReplica: 1,
      gpuCount: 1,
    };
    const client = createApiClient(actor.token, { apiUrl, retryDelayMs: 0 });
    await expect(client.deployments.create(input)).rejects.toMatchObject({
      status: 400,
    });
    const update = {
      params: { id: 'deployment' },
      body: { dockerOptions: { gpus: 'all' }, gpuCount: 1 },
    };
    await expect(client.deployments.update(update)).rejects.toMatchObject({
      status: 400,
    });
    expect(domain.create).not.toHaveBeenCalled();
    expect(domain.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      dockerOptions: {
        cpus: '6',
        memory: null,
        privileged: false,
        binds: [],
      },
    },
    { dockerOptions: { cpus: '6' } },
    { dockerOptions: null },
  ])(
    'preserves update values on the wire and does not replay a generation conflict: %j',
    async (body) => {
      vi.mocked(domain.update).mockRejectedValue(
        new DeploymentDomainError(
          'Deployment changed while it was being updated',
          409,
        ),
      );
      await expect(
        createApiClient(actor.token, {
          apiUrl,
          retryDelayMs: 0,
        }).deployments.update({
          params: { id: 'deployment' },
          body,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'DEPLOYMENT_CONFLICT',
        defined: true,
      });
      expect(domain.update).toHaveBeenCalledExactlyOnceWith(
        actor,
        'deployment',
        body,
        expect.any(AbortSignal),
      );
    },
  );

  it.each([
    { dockerOptions: {} },
    { dockerOptions: { cpus: 6 } },
    { dockerOptions: { privileged: 'false' } },
    { dockerOptionsUpdate: { cpus: '6' } },
    { dockerOptions: { cpus: '2' }, dockerOptionsUpdate: { cpus: '6' } },
  ])(
    'rejects empty, invalid, and removed option inputs before the domain: %j',
    async (body) => {
      const response = await fetch(`${apiUrl}/v1/deployments/deployment`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${actor.token}`,
          'AnyCloud-Client-Version': packageJson.version,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(domain.update).not.toHaveBeenCalled();
    },
  );
});
