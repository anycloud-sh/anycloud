import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import {
  ClusterUnavailableError,
  ClusterInvalidError,
} from '../../../src/api/services/cluster-errors.js';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import { resetTestStore } from '../utils.js';

const actor = {
  id: '1',
  username: 'test-user',
  token: 'test-token',
};
const request = {
  name: 'production',
  credentialName: 'missing-credential',
  region: 'us-east-1',
  vmType: 't3.medium',
};

describe('cluster installer process composition', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPersistence();
  });

  it('disables the installer on a Helm-managed API', async () => {
    await resetTestStore();
    resetPersistence();
    vi.stubEnv('ANYCLOUD_SYSTEM_RELEASE', 'helm');
    await expect(
      createApiRpcDomains().clusters.create(actor, request),
    ).rejects.toBeInstanceOf(ClusterUnavailableError);
  });

  it('keeps the installer available on a local API', async () => {
    await resetTestStore();
    resetPersistence();
    vi.stubEnv('ANYCLOUD_SYSTEM_RELEASE', '');
    await expect(
      createApiRpcDomains().clusters.create(actor, request),
    ).rejects.toBeInstanceOf(ClusterInvalidError);
  });
});
