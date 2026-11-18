import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiRpcDomains } from '../../../src/api/composition.js';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { DeploymentWorkloadError } from '../../../src/api/services/deployment-errors.js';
import type { DeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';

const EXECUTION_ID = '9d6a8176-dfae-4c68-a18f-f28472727cb0';

describe('cluster Deployment workload routes', () => {
  let server: Server;
  let baseUrl: string;
  let workload: {
    [Key in keyof DeploymentWorkloadDomain]: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    workload = {
      candidate: vi.fn().mockResolvedValue({ status: 204 }),
      claim: vi
        .fn()
        .mockResolvedValue({ jobId: 'job-a', executionId: EXECUTION_ID }),
      cancellation: vi.fn().mockResolvedValue({ cancelled: false }),
      outcome: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      execution: vi.fn(),
      report: vi.fn(),
    };
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: vi.fn(),
        domains: createApiRpcDomains({
          overrides: {
            deploymentWorkload: workload as DeploymentWorkloadDomain,
          },
        }),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}/v1/deployments/target-a/jobs`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function request(path: string, options: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: 'Bearer workload-token',
        ...options.headers,
      },
    });
  }

  it('strips adapter-owned envelope fields while preserving workload inputs', async () => {
    const candidate = await request('/candidate', {
      method: 'GET',
    });
    const cancellation = await request(
      `/job-a/cancellation?executionId=${EXECUTION_ID}`,
      {
        method: 'GET',
      },
    );
    const outcome = await request('/job-a/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId: EXECUTION_ID, outcome: 'completed' }),
    });
    const cleanup = await request('/job-a/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId: EXECUTION_ID }),
    });

    expect(candidate.status).toBe(204);
    expect(cancellation.status).toBe(200);
    expect(outcome.status).toBe(204);
    expect(cleanup.status).toBe(204);
    expect(workload.candidate).toHaveBeenCalledWith(
      'target-a',
      0,
      'Bearer workload-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
    );
    expect(workload.cancellation).toHaveBeenCalledWith(
      'target-a',
      'job-a',
      EXECUTION_ID,
      'Bearer workload-token',
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
    );
    expect(workload.outcome).toHaveBeenCalledWith(
      'target-a',
      'job-a',
      { executionId: EXECUTION_ID, outcome: 'completed' },
      'Bearer workload-token',
      undefined,
    );
    expect(workload.cleanup).toHaveBeenCalledWith(
      'target-a',
      'job-a',
      EXECUTION_ID,
      'Bearer workload-token',
      undefined,
    );
  });
  it.each([0, 20_000])(
    'accepts discovery waitMs=%s and returns its exact candidate identity',
    async (waitMs) => {
      workload.candidate.mockResolvedValue({
        status: 200,
        body: {
          jobId: 'job-a',
          submissionRevision: 2,
          previousExecutionId: null,
        },
      });
      const response = await request(`/candidate?waitMs=${waitMs}`, {
        method: 'GET',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jobId: 'job-a',
        submissionRevision: 2,
        previousExecutionId: null,
      });
      expect(workload.candidate).toHaveBeenCalledWith(
        'target-a',
        waitMs,
        'Bearer workload-token',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        undefined,
      );
    },
  );

  it.each(['-1', '20001', '1.5', 'no'])(
    'rejects invalid discovery waitMs=%s',
    async (value) => {
      expect(
        (await request(`/candidate?waitMs=${value}`, { method: 'GET' })).status,
      ).toBe(400);
      expect(workload.candidate).not.toHaveBeenCalled();
    },
  );

  it('requires an explicit nullable previous execution and a safe integer revision', async () => {
    for (const body of [
      { submissionRevision: 0 },
      { submissionRevision: -1, previousExecutionId: null },
      {
        submissionRevision: Number.MAX_SAFE_INTEGER + 1,
        previousExecutionId: null,
      },
      { submissionRevision: 0, previousExecutionId: 'bad' },
    ]) {
      expect(
        (
          await request('/job-a/claim', {
            method: 'POST',
            headers: {
              'Idempotency-Key': EXECUTION_ID,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(workload.claim).not.toHaveBeenCalled();
    const response = await request('/job-a/claim', {
      method: 'POST',
      headers: {
        'Idempotency-Key': EXECUTION_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        submissionRevision: 0,
        previousExecutionId: null,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobId: 'job-a',
      executionId: EXECUTION_ID,
    });
  });

  it.each(['WORKLOAD_CANDIDATE_STALE', 'WORKLOAD_EXECUTION_USED'] as const)(
    'preserves permanent claim result %s on the wire',
    async (code) => {
      workload.claim.mockRejectedValue(
        new DeploymentWorkloadError('permanent', 409, code),
      );
      const response = await request('/job-a/claim', {
        method: 'POST',
        headers: {
          'Idempotency-Key': EXECUTION_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          submissionRevision: 0,
          previousExecutionId: null,
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code });
    },
  );
});
