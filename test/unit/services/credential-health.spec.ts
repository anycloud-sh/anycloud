import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import {
  getCredentialSecretStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  encryptCredential,
  hashCredential,
} from '../../../src/api/services/cloud-config';
import { CloudType } from '../../../src/shared/cloud.js';
import config from '../../../src/api/config';

const AZURE_CRED = {
  cloudProvider: CloudType.Azure,
  applicationId: 'app-id',
  secret: 'shh',
  subscriptionId: 'sub-id',
  directoryId: 'dir-id',
} as const;

async function saveAzureCred(name: string): Promise<string> {
  const store = getCredentialSecretStore();
  const id = hashCredential(AZURE_CRED);
  await store.saveNamedCredential(
    name,
    id,
    await encryptCredential(AZURE_CRED),
    CloudType.Azure,
  );
  return id;
}

describe('credential health — persisted auth_failed_at', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(() => {
    resetPersistence();
  });

  it('defaults to healthy (auth_failed_at NULL) on save', async () => {
    const store = getCredentialSecretStore();
    const id = await saveAzureCred('az');
    expect(await store.isCredentialAuthFailed(id)).toBe(false);
    const [row] = await store.listNamedCredentials();
    expect(row.authFailedAt).toBeNull();
  });

  it('marks, surfaces, and clears the auth-failed signal', async () => {
    const store = getCredentialSecretStore();
    const id = await saveAzureCred('az');

    await store.markCredentialAuthFailed(id);
    expect(await store.isCredentialAuthFailed(id)).toBe(true);
    const [marked] = await store.listNamedCredentials();
    expect(typeof marked.authFailedAt).toBe('number');

    await store.clearCredentialAuthFailed(id);
    expect(await store.isCredentialAuthFailed(id)).toBe(false);
  });

  it('keeps the first failure timestamp on repeated marks', async () => {
    const store = getCredentialSecretStore();
    const id = await saveAzureCred('az');
    await store.markCredentialAuthFailed(id);
    const [first] = await store.listNamedCredentials();
    await store.markCredentialAuthFailed(id);
    const [second] = await store.listNamedCredentials();
    expect(second.authFailedAt).toBe(first.authFailedAt);
  });
});
