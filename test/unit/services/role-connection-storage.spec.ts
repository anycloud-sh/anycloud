import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssumeRoleWithWebIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts';
import {
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { AWS } from '../../../src/api/services/gateways/aws.js';
import { resetAzureStorageAccountCacheForTests } from '../../../src/api/services/gateways/azure.js';
import {
  mintedUploadBuckets,
  renewAt,
} from '../../../src/api/services/vm-runtime-storage.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../../src/shared/cloud.js';
import { extractCredentials } from '../../../src/shared/cloud-config.js';
import {
  TEST_AWS_ROLE,
  TEST_AZURE_ROLE,
  TEST_GCP_ROLE,
  TEST_LAMBDA_CRED,
} from '../helpers/fixtures.js';

/**
 * RFC 0047 § Bucket tokens on role connections, through each cloud's SDK with
 * only the network stubbed: a VM-host Job's sync and a Service's renewal mint
 * through `mintedUploadBuckets`, then renew at `renewAt`. The live proof is
 * S14.
 */

const tokens = vi.hoisted(() => ({ issued: [] as string[] }));
vi.mock(
  '../../../src/api/services/kubernetes/service-account-token.js',
  () => ({
    apiServiceAccountToken: async (audience: string) => {
      const token = `sa-token-${tokens.issued.length + 1}`;
      tokens.issued.push(audience);
      return token;
    },
  }),
);
vi.mock('../../../src/api/services/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HOUR = 3_600_000;
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;

/** A Job on the role's own cloud, or on Lambda naming the role for output. */
function jobConfig(
  role: CloudCredentials,
  region: string,
  as: 'compute' | 'storage',
): CloudConfig {
  return as === 'compute'
    ? {
        cloudProvider: role.cloudProvider,
        credentials: extractCredentials(role),
        region,
        outputBucket: 'results',
      }
    : {
        cloudProvider: CloudType.Lambda,
        credentials: extractCredentials(TEST_LAMBDA_CRED),
        region: 'us-east-1',
        outputBucket: 'results',
        outputStorageCredentials: role,
        outputStorageRegion: region,
      };
}

beforeEach(() => {
  nock.disableNetConnect();
  tokens.issued.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('0047 § Bucket tokens: VM-host sync and renewal on a role connection', () => {
  it.each(['compute', 'storage'] as const)(
    'AWS as %s: AssumeRoleWithWebIdentity with a new token, the grant’s policy and 12 hours, renewed before expiry',
    async (as) => {
      vi.spyOn(
        AWS.prototype as unknown as Record<string, () => unknown>,
        'getBucketRegion',
      ).mockResolvedValue('us-east-1');
      const sent: AssumeRoleWithWebIdentityCommand[] = [];
      vi.spyOn(STSClient.prototype, 'send').mockImplementation(
        async (command: unknown) => {
          sent.push(command as AssumeRoleWithWebIdentityCommand);
          return {
            Credentials: {
              AccessKeyId: `ASIA${sent.length}`,
              SecretAccessKey: 'secret',
              SessionToken: 'session',
              Expiration: new Date(Date.now() + 12 * HOUR),
            },
          };
        },
      );
      const config = jobConfig(TEST_AWS_ROLE, 'us-east-1', as);

      const first = await mintedUploadBuckets(config, 'job-1');
      const second = await mintedUploadBuckets(config, 'job-1');

      expect(sent.map((c) => c.constructor)).toEqual([
        AssumeRoleWithWebIdentityCommand,
        AssumeRoleWithWebIdentityCommand,
      ]);
      expect(sent[0]!.input).toMatchObject({
        RoleArn: TEST_AWS_ROLE.roleArn,
        WebIdentityToken: 'sa-token-1',
        RoleSessionName: 'anycloud-results',
        DurationSeconds: 43_200,
      });
      expect(JSON.parse(sent[0]!.input.Policy!).Statement).toContainEqual({
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: 'arn:aws:s3:::results/*',
      });
      // A renewal reads a new ServiceAccount token: no reuse, no chaining.
      expect(sent[1]!.input.WebIdentityToken).toBe('sa-token-2');
      expect(tokens.issued).toEqual(['sts.amazonaws.com', 'sts.amazonaws.com']);
      expect(first.output?.credentials).toMatchObject({
        cloudProvider: CloudType.AWS,
        accessKeyId: 'ASIA1',
      });
      expect(second.output?.credentials).toMatchObject({
        accessKeyId: 'ASIA2',
      });
      expect(renewAt(first)).toBe(
        first.output!.credentialExpiresAt! - RENEW_BEFORE_EXPIRY_MS,
      );
    },
  );

  it('GCP as compute: a token downscoped to the bucket from a new federated exchange, renewed before its hour ends', async () => {
    const role = TEST_GCP_ROLE;
    const exchanges: URLSearchParams[] = [];
    nock('https://sts.googleapis.com')
      .persist()
      .post('/v1/token')
      .reply(200, (_uri, body) => {
        exchanges.push(new URLSearchParams(body as string));
        return {
          access_token: `sts-${exchanges.length}`,
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 3600,
        };
      });
    const impersonations = nock('https://iamcredentials.googleapis.com')
      .persist()
      .post(
        `/v1/projects/-/serviceAccounts/${role.serviceAccountEmail}:generateAccessToken`,
      )
      .reply(200, () => ({
        accessToken: 'impersonated',
        expireTime: new Date(Date.now() + HOUR).toISOString(),
      }));
    const config = jobConfig(TEST_GCP_ROLE, 'us-central1', 'compute');

    const first = await mintedUploadBuckets(config, 'job-1');
    await mintedUploadBuckets(config, 'job-1');

    // Each mint: the role's exchange from a new ServiceAccount token, the
    // impersonation, then the Credential Access Boundary exchange.
    expect(impersonations.isDone()).toBe(true);
    expect(exchanges.map((e) => e.get('subject_token'))).toEqual([
      'sa-token-1',
      'impersonated',
      'sa-token-2',
      'impersonated',
    ]);
    const boundary = JSON.parse(
      decodeURIComponent(exchanges[1]!.get('options')!),
    );
    expect(boundary.accessBoundary.accessBoundaryRules).toEqual([
      {
        availableResource:
          '//storage.googleapis.com/projects/_/buckets/results',
        availablePermissions: ['inRole:roles/storage.objectUser'],
      },
    ]);
    expect(first.output?.credentials).toEqual({
      cloudProvider: CloudType.GCP,
      accessToken: 'sts-2',
    });
    expect(renewAt(first)).toBe(
      first.output!.credentialExpiresAt! - RENEW_BEFORE_EXPIRY_MS,
    );
  });

  it('Azure as compute: a container SAS signed with the account key the role lists through ARM, renewed before expiry', async () => {
    resetAzureStorageAccountCacheForTests();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const role = TEST_AZURE_ROLE;
    const login = 'https://login.microsoftonline.com';
    const base = `${login}/${role.directoryId}`;
    const assertions: string[] = [];
    nock(login)
      .persist()
      .get('/common/discovery/instance')
      .query(true)
      .reply(200, {
        tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
        metadata: [],
      })
      .get(`/${role.directoryId}/v2.0/.well-known/openid-configuration`)
      .reply(200, {
        token_endpoint: `${base}/oauth2/v2.0/token`,
        authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
        end_session_endpoint: `${base}/oauth2/v2.0/logout`,
        issuer: `${base}/v2.0`,
        jwks_uri: `${base}/discovery/v2.0/keys`,
      })
      .post(`/${role.directoryId}/oauth2/v2.0/token`)
      .query(true)
      .reply(200, (_uri, body) => {
        assertions.push(
          new URLSearchParams(body as string).get('client_assertion') ?? '',
        );
        return { token_type: 'Bearer', access_token: 'arm', expires_in: 3600 };
      });
    const account = 'anycloudrole0000';
    const accountKey = Buffer.from('r'.repeat(64)).toString('base64');
    const path = `/subscriptions/${role.subscriptionId}/resourceGroups/anycloud-storage/providers/Microsoft.Storage/storageAccounts/${account}`;
    const authorizations: string[] = [];
    nock('https://management.azure.com')
      .persist()
      .get(path)
      .query(true)
      .reply(200, function () {
        authorizations.push(String(this.req.headers.authorization));
        return { name: account, location: 'eastus', properties: {} };
      })
      .post(`${path}/listKeys`)
      .query(true)
      .reply(200, function () {
        authorizations.push(String(this.req.headers.authorization));
        return { keys: [{ keyName: 'key1', value: accountKey }] };
      });

    const { output } = await mintedUploadBuckets(
      jobConfig(TEST_AZURE_ROLE, 'eastus', 'compute'),
      'job-1',
    );

    // The client assertion is the API's ServiceAccount token; no secret.
    expect(assertions).toEqual(['sa-token-1']);
    expect(authorizations).toEqual(['Bearer arm', 'Bearer arm']);
    const query = new URLSearchParams(
      (output?.credentials as { sasToken: string }).sasToken,
    );
    expect(query.get('sr')).toBe('c');
    expect(query.get('sp')).toBe('racwdl');
    expect(query.get('sig')).toBe(
      generateBlobSASQueryParameters(
        {
          containerName: 'results',
          permissions: ContainerSASPermissions.parse('racwdl'),
          startsOn: new Date(query.get('st')!),
          expiresOn: new Date(query.get('se')!),
          protocol: SASProtocol.Https,
          version: query.get('sv')!,
        },
        new StorageSharedKeyCredential(account, accountKey),
      ).signature,
    );
    expect(renewAt({ output })).toBe(
      output!.credentialExpiresAt! - RENEW_BEFORE_EXPIRY_MS,
    );

    // A renewal within the key's 15-minute cache signs a new SAS with it.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const renewed = (
      await mintedUploadBuckets(
        jobConfig(TEST_AZURE_ROLE, 'eastus', 'compute'),
        'job-1',
      )
    ).output!;
    expect(renewed.credentialExpiresAt).toBe(
      output!.credentialExpiresAt! + 10 * 60_000,
    );
    expect(authorizations).toHaveLength(2);

    // A connection differing only in audience shares neither the exchange
    // nor the cached account key.
    await mintedUploadBuckets(
      jobConfig(
        { ...TEST_AZURE_ROLE, audience: 'api://other' },
        'eastus',
        'compute',
      ),
      'job-1',
    );
    expect(tokens.issued.at(-1)).toBe('api://other');
    expect(assertions).toHaveLength(2);
    expect(authorizations).toHaveLength(4);
  });
});
