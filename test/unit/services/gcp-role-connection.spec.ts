import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGcpGatewayClients,
  gcpProjectId,
  mintGcpDownscopedToken,
} from '../../../src/api/services/provider-clients/gcp.js';
import type { GCPRoleCreds } from '../../../src/shared/cloud.js';

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

const PROVIDER =
  'projects/123/locations/global/workloadIdentityPools/anycloud/providers/cluster';

function role(name: string): GCPRoleCreds {
  return {
    kind: 'role',
    workloadIdentityProvider: PROVIDER,
    serviceAccountEmail: `${name}@my-project.iam.gserviceaccount.com`,
    issuer: 'https://issuer.example.com',
    audience: `https://iam.googleapis.com/${PROVIDER}`,
    subject: 'system:serviceaccount:anycloud-system:anycloud-api',
  };
}

/** STS and IAM Credentials for one role; counts each exchange. */
function federation(email: string, expiresInMs = 3_600_000) {
  const exchanges = {
    sts: 0,
    impersonations: 0,
    subjectTokens: [] as string[],
  };
  nock('https://sts.googleapis.com')
    .persist()
    .post('/v1/token')
    .reply(200, (_uri, body) => {
      exchanges.sts++;
      exchanges.subjectTokens.push(
        new URLSearchParams(body as string).get('subject_token') ?? '',
      );
      return {
        access_token: `federated-${exchanges.sts}`,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      };
    });
  nock('https://iamcredentials.googleapis.com')
    .persist()
    .post(`/v1/projects/-/serviceAccounts/${email}:generateAccessToken`)
    .reply(200, () => {
      exchanges.impersonations++;
      return {
        accessToken: 'impersonated',
        expireTime: new Date(Date.now() + expiresInMs).toISOString(),
      };
    });
  return exchanges;
}

beforeEach(() => {
  nock.disableNetConnect();
  tokens.audiences.length = 0;
});
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('0047 amendment 9: GCP clients on a role connection', () => {
  it('reads the project from the service account', () => {
    expect(gcpProjectId(role('anycloud'))).toBe('my-project');
  });

  it('signs Compute and Storage with the impersonated token, one exchange per library shared across gateways', async () => {
    const connection = role('shared');
    const exchanges = federation(connection.serviceAccountEmail);
    const authorizations: (string | undefined)[] = [];
    nock('https://compute.googleapis.com')
      .persist()
      .get(/\/compute\/v1\/projects\/my-project\/.*/)
      .reply(function () {
        authorizations.push(this.req.headers.authorization as string);
        return [200, {}];
      });
    nock('https://storage.googleapis.com')
      .persist()
      .get('/storage/v1/b')
      .query(true)
      .reply(function () {
        authorizations.push(this.req.headers.authorization as string);
        return [200, { items: [] }];
      });

    for (const _gateway of [1, 2]) {
      const clients = createGcpGatewayClients(connection, {});
      await clients.instances.list({
        project: 'my-project',
        zone: 'us-central1-a',
      });
      await clients.firewalls.list({ project: 'my-project' });
      await clients.storage.getBuckets();
    }

    expect(authorizations).toHaveLength(6);
    expect(new Set(authorizations)).toEqual(new Set(['Bearer impersonated']));
    // gax and Storage carry their own auth libraries: one exchange each.
    expect(exchanges.sts).toBe(2);
    expect(exchanges.impersonations).toBe(2);
    expect(new Set(tokens.audiences)).toEqual(new Set([connection.audience]));
  });

  it('exchanges under each connection’s own audience, even when only the audience differs', async () => {
    const connection = role('audience');
    federation(connection.serviceAccountEmail);
    nock('https://storage.googleapis.com')
      .persist()
      .get('/storage/v1/b')
      .query(true)
      .reply(200, { items: [] });

    await createGcpGatewayClients(connection, {}).storage.getBuckets();
    await createGcpGatewayClients(
      { ...connection, audience: 'https://other.example.com' },
      {},
    ).storage.getBuckets();

    expect(tokens.audiences).toEqual([
      connection.audience,
      'https://other.example.com',
    ]);
  });

  it('exchanges a new ServiceAccount token once the last one is within 5 minutes of expiry', async () => {
    // Both google-auth-library versions refresh 5 minutes early.
    const connection = role('expiring');
    const exchanges = federation(connection.serviceAccountEmail, 4 * 60_000);
    nock('https://compute.googleapis.com')
      .persist()
      .get(/\/compute\/v1\/projects\/my-project\/.*/)
      .reply(200, {});
    nock('https://storage.googleapis.com')
      .persist()
      .get('/storage/v1/b')
      .query(true)
      .reply(200, { items: [] });

    const clients = createGcpGatewayClients(connection, {});
    for (const _call of [1, 2]) {
      await clients.firewalls.list({ project: 'my-project' });
      await clients.storage.getBuckets();
    }

    expect(exchanges.impersonations).toBe(4);
    expect(new Set(exchanges.subjectTokens).size).toBe(4);
  });

  it('asks the impersonation for the requested lifetime, floored at 10 minutes', async () => {
    const connection = role('lifetime');
    const lifetimes: unknown[] = [];
    nock('https://sts.googleapis.com').persist().post('/v1/token').reply(200, {
      access_token: 'federated',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
    });
    nock('https://iamcredentials.googleapis.com')
      .persist()
      .post(
        `/v1/projects/-/serviceAccounts/${connection.serviceAccountEmail}:generateAccessToken`,
      )
      .reply(200, (_uri, body) => {
        const { lifetime } = body as { lifetime?: string };
        lifetimes.push(lifetime);
        return {
          accessToken: 'impersonated',
          expireTime: new Date(
            Date.now() + parseInt(lifetime ?? '3600', 10) * 1000,
          ).toISOString(),
        };
      });

    const grants = [{ bucket: 'out', mode: 'read' as const }];
    const short = await mintGcpDownscopedToken(connection, grants, 60_000);
    await mintGcpDownscopedToken(connection, grants, 1_800_000);
    await mintGcpDownscopedToken(connection, grants);

    expect(lifetimes).toEqual(['600s', '1800s', '3600s']);
    // The downscoped token reports its source's real expiry.
    expect(short.expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
    expect(short.expiresAt - Date.now()).toBeGreaterThan(590_000);
  });

  it('downscopes from a new exchange, so the token gets its source’s full hour', async () => {
    const connection = role('minter');
    const exchanges = federation(connection.serviceAccountEmail);

    const first = await mintGcpDownscopedToken(connection, [
      { bucket: 'out', mode: 'readwrite' },
    ]);
    await mintGcpDownscopedToken(connection, [{ bucket: 'in', mode: 'read' }]);

    expect(first.token).toMatch(/^federated-/);
    // Each mint: the role's exchange, then the Credential Access Boundary one.
    expect(exchanges.sts).toBe(4);
    expect(exchanges.impersonations).toBe(2);
    expect(
      exchanges.subjectTokens.filter((t) => t.startsWith('sa-token')),
    ).toHaveLength(2);
  });
});
