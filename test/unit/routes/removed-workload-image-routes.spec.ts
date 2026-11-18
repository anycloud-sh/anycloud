import { describe, expect, it } from 'vitest';
import { callApi } from '../helpers/api-test-helper';

describe('removed workload-image management routes', () => {
  it.each([
    '/v1/images/prune',
    '/v1/images/baked/list',
    '/v1/images/baked/copy',
  ])('does not expose %s', async (url) => {
    const response = await callApi(`https://example.com${url}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer mock-github-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });
});
