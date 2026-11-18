import { describe, expect, it } from 'vitest';
import { callApi } from '../helpers/api-test-helper.js';
import { createTestWorkload } from '../utils.js';
import { WorkloadState } from '../../../src/shared/workload.js';

const headers = {
  Authorization: 'Bearer mock-github-token',
  'Content-Type': 'application/json',
};

describe('Workload API names', () => {
  it('returns current status and history fields and rejects the old list filter', async () => {
    await createTestWorkload(
      'renamed-job',
      'test-user',
      WorkloadState.Completed,
    );
    const response = await callApi(
      'https://example.com/v1/workloads/renamed-job',
      { headers },
    );
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.workload).toMatchObject({
      id: 'renamed-job',
      workloadType: 'job',
    });
    expect(status).not.toHaveProperty('deployment');
    expect(status.workload).not.toHaveProperty('deploymentType');
    expect(status.events.length).toBeGreaterThan(0);
    for (const event of status.events) {
      expect(event.workloadId).toBe('renamed-job');
      expect(event).not.toHaveProperty('deploymentId');
    }
    const invalid = await callApi(
      'https://example.com/v1/workloads?deploymentType=job',
      { headers },
    );
    expect(invalid.status).toBe(400);
  });

  it('lists persistent Deployments separately from shared Workload records', async () => {
    await createTestWorkload(
      'distinct-job',
      'test-user',
      WorkloadState.Completed,
    );
    const response = await callApi('https://example.com/v1/deployments', {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deployments: [] });

    const invalid = await callApi('https://example.com/v1/deployments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: 'alpine:latest',
        workloadType: 'job',
        cloudConfig: {},
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it('rejects the removed Worker target field on Job submission', async () => {
    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers,
      body: JSON.stringify({ worker: 'model', workloadType: 'job' }),
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ['GET', '/v1/deployments/renamed-job'],
    ['DELETE', '/v1/deployments/renamed-job'],
    ['GET', '/v1/deployments/renamed-job/cost'],
    ['GET', '/v1/deployments/renamed-job/ssh-access'],
    ['POST', '/v1/deployments/renamed-job/resubmissions'],
    ['POST', '/v1/deployments/renamed-job/upgrades'],
    ['POST', '/v1/deployments/renamed-job/claim-observation'],
    ['GET', '/v1/deployment-costs'],
    ['GET', '/v1/workers'],
    ['POST', '/v1/workers'],
    ['GET', '/v1/workers/model'],
    ['PATCH', '/v1/workers/model'],
    ['DELETE', '/v1/workers/model'],
    ['GET', '/v1/workers/model/jobs/candidate'],
    ['POST', '/v1/workers/model/jobs/renamed-job/claim'],
    ['GET', '/v1/workers/model/jobs/renamed-job/cancellation'],
    ['POST', '/v1/workers/model/jobs/renamed-job/outcome'],
    ['POST', '/v1/workers/model/jobs/renamed-job/cleanup'],
  ])('does not register an alias for %s %s', async (method, path) => {
    const response = await callApi(`https://example.com${path}`, {
      method,
      headers,
      ...(method === 'POST' || method === 'PATCH' ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(404);
  });
});
