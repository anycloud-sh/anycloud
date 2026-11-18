import { describe, it, expect } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import packageJson from '../../../package.json' with { type: 'json' };

describe('Health endpoint', () => {
  it('should return ok for GET /health', async () => {
    const response = await callApi('https://example.com/health', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
    const body = await response.text();
    expect(body).toBe('ok');
  });

  it('should return 404 for POST /health', async () => {
    const response = await callApi('https://example.com/health', {
      method: 'POST',
    });

    expect(response.status).toBe(404);
  });

  it('should return API version for GET /v1/version', async () => {
    const response = await callApi('https://example.com/v1/version', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      version: packageJson.version,
      previousVersion: packageJson.previousVersion,
      schemaVersion: packageJson.version,
    });
  });
});
