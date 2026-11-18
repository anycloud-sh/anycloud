import { describe, it, expect, beforeEach, vi } from 'vitest';
import { completeCloudConfig } from '../../../src/shared/cloud-config.js';
import { randomBytes } from 'crypto';

// Make a notifier appear configured and capture sends, without touching the
// network, so we can assert the alert is debounced (not sent every failure).
vi.mock('../../../src/api/services/notify', () => ({
  sendToNotifiers: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../src/shared/notifications/index', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/shared/notifications/index')
    >();
  return {
    ...real,
    loadNotifiers: vi.fn(() => [
      { name: 'slack' as const, send: vi.fn().mockResolvedValue(undefined) },
    ]),
  };
});

import {
  markCredentialOnAuthFailure,
  _resetCredentialInvalidAlerts,
} from '../../../src/api/services/credential-auth-failure';
import { sendToNotifiers } from '../../../src/api/services/notify';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud';
import { Azure } from '../../../src/api/services/gateways/azure';
import { resetTestStore } from '../utils';
import { CloudType } from '../../../src/shared/cloud.js';
import config from '../../../src/api/config';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';

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
const TERMINAL_AUTH_ERROR = new Error('AADSTS7000215: Invalid client secret');

describe('credential-invalid alert debounce', () => {
  beforeEach(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    await resetTestStore();
    _resetCredentialInvalidAlerts();
    vi.clearAllMocks();
  });

  it('alerts at most once per credential within the cooldown', async () => {
    await upsertCredential(getDB(), 'cred-z', 'enc', CloudType.Azure);

    await markCredentialOnAuthFailure(
      CloudFailureDiagnosis.BadCredential,
      TERMINAL_AUTH_ERROR,
      azure.compute(),
      'cred-z',
      'Azure',
    );
    await markCredentialOnAuthFailure(
      CloudFailureDiagnosis.BadCredential,
      TERMINAL_AUTH_ERROR,
      azure.compute(),
      'cred-z',
      'Azure',
    );

    expect(vi.mocked(sendToNotifiers)).toHaveBeenCalledTimes(1);
  });
});
