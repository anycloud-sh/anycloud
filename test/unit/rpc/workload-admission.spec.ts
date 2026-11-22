import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import type { User } from '../../../src/api/services/entities.js';
import type { ClustersDomain } from '../../../src/api/services/clusters-domain.js';
import type { WorkloadAdmissionDomain } from '../../../src/api/services/workload-admission-domain.js';
import {
  GithubSignInRequiredError,
  GithubUnavailableError,
  InvalidAnycloudConfigError,
  SERVICE_URL_NEEDS,
  SIGN_IN_INSTRUCTION,
  WorkloadIdExistsError,
} from '../../../src/shared/errors.js';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import { getWorkloadApiUrl } from '../../../src/api/config.js';

const actor = {
  id: 'user-id',
  username: 'user',
  token: 'valid-token',
} satisfies User;

describe('Workload admission RPC', () => {
  let server: Server;
  let apiUrl: string;
  let domain: WorkloadAdmissionDomain;

  beforeEach(async () => {
    domain = { submit: vi.fn() };
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: vi.fn(async () => actor),
        domains: createApiRpcDomains({
          overrides: { workloadAdmission: domain },
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

  it('reports a GitHub outage reached by a clusters call as a retryable 503', async () => {
    const clusters = { list: vi.fn() };
    clusters.list.mockRejectedValue(new GithubUnavailableError(502));
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: vi.fn(async () => actor),
        domains: createApiRpcDomains({
          overrides: {
            clusters: clusters as unknown as ClustersDomain,
          },
        }),
      }),
    );
    const clusterServer = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = clusterServer.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      await expect(
        createApiClient(actor.token, {
          apiUrl: `http://127.0.0.1:${address.port}`,
          retryDelayMs: 0,
        }).clusters.list(),
      ).rejects.toMatchObject({
        status: 503,
        code: 'AUTHENTICATION_UNAVAILABLE',
      });
    } finally {
      clusterServer.closeAllConnections();
      await new Promise((resolve) => clusterServer.close(resolve));
    }
  });

  it.each([
    [
      400,
      'WORKLOAD_ADMISSION_REJECTED',
      new InvalidAnycloudConfigError('Unknown region "mars-1"'),
    ],
    [409, 'WORKLOAD_ID_CONFLICT', new WorkloadIdExistsError()],
    [
      403,
      'GITHUB_SIGN_IN_REQUIRED',
      GithubSignInRequiredError.needs(SERVICE_URL_NEEDS),
    ],
    // The admission family maps any 503 to its own retryable code.
    [503, 'WORKLOAD_ADMISSION_UNAVAILABLE', new GithubUnavailableError(502)],
  ] as const)('reports %i %s', async (status, code, failure) => {
    vi.mocked(domain.submit).mockRejectedValue(failure);
    await expect(
      createApiClient(actor.token, {
        apiUrl,
        retryDelayMs: 0,
      }).admission.submit({ image: 'alpine:3.20', cloudConfig: {} }),
    ).rejects.toMatchObject({
      status,
      code,
      // A hosted caller's sign-in fix names the API it reached.
      message: failure.message.replace(
        SIGN_IN_INSTRUCTION,
        `Run \`anycloud login ${getWorkloadApiUrl()}\`, then retry.`,
      ),
      defined: true,
    });
  });
});
