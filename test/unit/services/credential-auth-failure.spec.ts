import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { completeCloudConfig } from '../../../src/shared/cloud-config.js';
import { randomBytes } from 'crypto';

import {
  markCredentialOnAuthFailure,
  _resetCredentialInvalidAlerts,
} from '../../../src/api/services/credential-auth-failure';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud.js';
import { Azure } from '../../../src/api/services/gateways/azure';
import { CloudType } from '../../../src/shared/cloud.js';
import { getCredentialSecretStore } from '../../../src/api/services/persistence.js';
import { resetTestStore } from '../utils';
import config from '../../../src/api/config';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';

describe('markCredentialOnAuthFailure', () => {
  const azure = new Azure(
    completeCloudConfig({
      cloudProvider: CloudType.Azure,
      credentials: {
        subscriptionId: 'sub',
        directoryId: 'tenant',
        applicationId: 'app',
        secret: 'secret',
      },
      region: 'eastus',
      vmType: 'Standard_NC4as_T4_v3',
    }),
  );

  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });
  beforeEach(async () => {
    await resetTestStore();
    _resetCredentialInvalidAlerts();
  });

  it('durably marks on a terminal auth error (invalid secret)', async () => {
    const store = getCredentialSecretStore();
    await upsertCredential(getDB(), 'cred-bad', 'enc', CloudType.Azure);
    await markCredentialOnAuthFailure(
      CloudFailureDiagnosis.BadCredential,
      new Error('AADSTS7000215: Invalid client secret provided'),
      azure.compute(),
      'cred-bad',
      'Azure',
    );
    expect(await store.isCredentialAuthFailed('cred-bad')).toBe(true);
  });

  it('does not durably mark a transient auth error', async () => {
    const store = getCredentialSecretStore();
    await upsertCredential(getDB(), 'cred-tx', 'enc', CloudType.Azure);
    await markCredentialOnAuthFailure(
      CloudFailureDiagnosis.BadCredential,
      new Error('ExpiredAuthenticationToken: the access token has expired'),
      azure.compute(),
      'cred-tx',
      'Azure',
    );
    expect(await store.isCredentialAuthFailed('cred-tx')).toBe(false);
  });

  it('does not mark on a non-credential diagnosis', async () => {
    const store = getCredentialSecretStore();
    await upsertCredential(getDB(), 'cred-ok', 'enc', CloudType.Azure);
    await markCredentialOnAuthFailure(
      CloudFailureDiagnosis.CapacityExhausted,
      new Error('AADSTS7000215'),
      azure.compute(),
      'cred-ok',
      'Azure',
    );
    expect(await store.isCredentialAuthFailed('cred-ok')).toBe(false);
  });
});
