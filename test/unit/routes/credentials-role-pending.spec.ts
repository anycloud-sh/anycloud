import { describe, expect, it, vi } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import { RoleConnectionPendingError } from '../../../src/api/services/credentials-domain.js';
import { log } from '../../../src/api/services/logger.js';

// A self-hosted API whose check finds the cloud has not granted the role yet.
vi.mock('../../../src/api/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/config.js')>()),
  isHelmManagedApi: () => true,
}));
vi.mock('../../../src/api/services/role-connection-check.js', () => ({
  createRoleConnectionCheck: () => async () => {
    throw new RoleConnectionPendingError('Waiting for GCP IAM to let it');
  },
}));

describe('PUT /v1/credentials/{name} with a pending role connection', () => {
  it('answers ROLE_CONNECTION_PENDING (503), stores nothing and logs no error', async () => {
    const error = vi.spyOn(log, 'error');
    const res = await callApi('https://example.com/v1/credentials/gcp-role', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer mock-github-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cloudProvider: 'GCP',
        kind: 'role',
        workloadIdentityProvider:
          'projects/1/locations/global/workloadIdentityPools/a/providers/b',
        serviceAccountEmail: 'anycloud@my-project.iam.gserviceaccount.com',
      }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: 'ROLE_CONNECTION_PENDING',
      message: 'Waiting for GCP IAM to let it',
      data: { name: 'gcp-role' },
    });
    expect(error).not.toHaveBeenCalled();
    const get = await callApi('https://example.com/v1/credentials/gcp-role', {
      headers: { Authorization: 'Bearer mock-github-token' },
    });
    expect(get.status).toBe(404);
  });
});
