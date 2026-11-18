import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  azureManagementScope,
  createAzureCredential,
} from '../../../src/api/services/provider-clients/azure.js';
import type { AzureRoleCreds } from '../../../src/shared/cloud.js';

const tokens = vi.hoisted(() => ({ audiences: [] as string[] }));
vi.mock(
  '../../../src/api/services/kubernetes/service-account-token.js',
  () => ({
    apiServiceAccountToken: async (audience: string) => {
      tokens.audiences.push(audience);
      return `sa-token-${tokens.audiences.length}`;
    },
  }),
);

const login = 'https://login.microsoftonline.com';

function role(applicationId: string): AzureRoleCreds {
  return {
    kind: 'role',
    applicationId,
    directoryId: '00000000-0000-0000-0000-00000000000d',
    subscriptionId: '00000000-0000-0000-0000-00000000000e',
    issuer: 'https://issuer.example.com',
    audience: 'api://AzureADTokenExchange',
    subject: 'system:serviceaccount:anycloud-system:anycloud-api',
  };
}

/** Entra ID for one tenant; records each token request's assertion. */
function entraId(tenant: string, expiresIn = 3600) {
  const assertions: string[] = [];
  const base = `${login}/${tenant}`;
  nock(login)
    .persist()
    .get('/common/discovery/instance')
    .query(true)
    .reply(200, {
      tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
      metadata: [],
    })
    .get(`/${tenant}/v2.0/.well-known/openid-configuration`)
    .reply(200, {
      token_endpoint: `${base}/oauth2/v2.0/token`,
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      end_session_endpoint: `${base}/oauth2/v2.0/logout`,
      issuer: `${base}/v2.0`,
      jwks_uri: `${base}/discovery/v2.0/keys`,
    })
    .post(`/${tenant}/oauth2/v2.0/token`)
    .query(true)
    .reply(200, (_uri, body) => {
      assertions.push(
        new URLSearchParams(body as string).get('client_assertion') ?? '',
      );
      return {
        token_type: 'Bearer',
        access_token: 'arm',
        expires_in: expiresIn,
      };
    });
  return assertions;
}

beforeEach(() => {
  nock.disableNetConnect();
  tokens.audiences.length = 0;
});
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('0047 amendment 9: Azure credentials on a role connection', () => {
  it('asserts with the API’s token and shares one cached token per role across gateways', async () => {
    const connection = role('00000000-0000-0000-0000-00000000000a');
    const assertions = entraId(connection.directoryId);

    const first = await createAzureCredential(connection).getToken(
      azureManagementScope(),
    );
    const second = await createAzureCredential(connection).getToken(
      azureManagementScope(),
    );

    expect(first?.token).toBe('arm');
    expect(second?.token).toBe('arm');
    expect(assertions).toEqual(['sa-token-1']);
    // MSAL may read the assertion more often than it sends one.
    expect(new Set(tokens.audiences)).toEqual(
      new Set(['api://AzureADTokenExchange']),
    );
  });

  it('asserts with a new ServiceAccount token once the cached one nears expiry', async () => {
    const connection = role('00000000-0000-0000-0000-0000000000b1');
    const assertions = entraId(connection.directoryId, 60);

    await createAzureCredential(connection).getToken(azureManagementScope());
    await createAzureCredential(connection).getToken(azureManagementScope());

    expect(assertions).toHaveLength(2);
    expect(new Set(assertions).size).toBe(2);
  });

  it('keeps one credential per role', () => {
    const a = role('00000000-0000-0000-0000-0000000000a1');
    expect(createAzureCredential(a)).toBe(createAzureCredential({ ...a }));
    expect(createAzureCredential(a)).not.toBe(
      createAzureCredential(role('00000000-0000-0000-0000-0000000000a2')),
    );
    expect(
      createAzureCredential({ ...a, issuer: 'https://other.example.com' }),
    ).not.toBe(createAzureCredential(a));
    // The audience is part of the trust the assertion is made under.
    expect(createAzureCredential({ ...a, audience: 'api://other' })).not.toBe(
      createAzureCredential(a),
    );
  });
});
