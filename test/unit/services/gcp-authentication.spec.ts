import { generateKeyPairSync, verify } from 'crypto';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GCP } from '../../../src/api/services/gateways/gcp.js';
import { canListBuckets } from '../../../src/api/services/gateways/cloud.js';
import { completeCloudConfig } from '../../../src/shared/cloud-config.js';
import { CloudType } from '../../../src/shared/cloud.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const credentials = {
  projectId: 'selected-project',
  clientEmail: 'selected@selected-project.iam.gserviceaccount.com',
  privateKey,
};
let provider: GCP | undefined;

beforeEach(() => {
  vi.stubEnv('GCP_API_ENDPOINT', undefined);
  vi.stubEnv('GOOGLE_CLOUD_UNIVERSE_DOMAIN', undefined);
  vi.stubEnv(
    'GOOGLE_APPLICATION_CREDENTIALS',
    '/ambient-credential-must-not-be-used.json',
  );
  nock.disableNetConnect();
});
afterEach(async () => {
  vi.useRealTimers();
  if (provider)
    await Promise.all(
      [
        provider.instancesClient,
        provider.firewallsClient,
        provider.globalOperationsClient,
        provider.zoneOperationsClient,
        provider.imagesClient,
        provider.disksClient,
        provider.machineTypesClient,
      ].map((client) => client.close()),
    );
  provider = undefined;
  nock.cleanAll();
  nock.enableNetConnect();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function gateway(): GCP {
  provider = new GCP(
    completeCloudConfig({
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      availabilityZone: 'a',
      vmType: 'n1-standard-1',
      credentials,
    }),
  );
  return provider;
}

describe('0038/S4 canonical GCP Compute OAuth with the installed SDK', () => {
  it('preserves structured invalid_grant through Compute credential validation without an endpoint override', async () => {
    let assertion: Record<string, unknown> | undefined;
    const oauth = nock('https://oauth2.googleapis.com')
      .post('/token', (body) => {
        const encoded =
          typeof body === 'string'
            ? new URLSearchParams(body).get('assertion')
            : body.assertion;
        assertion = JSON.parse(
          Buffer.from(encoded.split('.')[1], 'base64url').toString(),
        );
        return true;
      })
      .reply(400, {
        error: 'invalid_grant',
        error_description: 'Invalid JWT Signature.',
      });
    const error = await gateway()
      .compute()
      .validateCredentials()
      .catch((value: unknown) => value);
    expect(oauth.isDone()).toBe(true);
    expect(assertion).toMatchObject({
      iss: credentials.clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect(error).toMatchObject({
      response: {
        status: 400,
        data: {
          error: 'invalid_grant',
          error_description: 'Invalid JWT Signature.',
        },
      },
    });
    expect(process.env.GCP_API_ENDPOINT).toBeUndefined();
  });

  it('authenticates with the selected key, then makes the canonical Compute request', async () => {
    const oauth = nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, {
        access_token: 'selected-oauth-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    const compute = nock('https://compute.googleapis.com', {
      reqheaders: { authorization: 'Bearer selected-oauth-token' },
    })
      .get(
        '/compute/v1/projects/selected-project/zones/us-central1-a/instances',
      )
      .query(true)
      .reply(200, { items: [] });
    await gateway().compute().validateCredentials();
    expect(oauth.isDone()).toBe(true);
    expect(compute.isDone()).toBe(true);
  });
});

function listBuckets(gcp: GCP, signal?: AbortSignal) {
  const storage = gcp.storage();
  if (!canListBuckets(storage))
    throw new Error('GCP must support bucket listing.');
  return storage.listBuckets({ pageSize: 10 }, { signal });
}

describe('0038/S3 first-use GCP bucket authentication', () => {
  const failure = {
    response: {
      status: 400,
      data: {
        error: 'invalid_grant',
        error_description: 'Invalid JWT Signature.',
      },
    },
  };
  const accountFailure = {
    response: {
      status: 400,
      data: {
        error: 'invalid_grant',
        error_description: 'Invalid grant: account not found',
      },
    },
  };
  const retryableFailures = [
    { name: 'signature', failure },
    { name: 'account-not-found', failure: accountFailure },
  ];

  it.each(retryableFailures)(
    'recovers the exact OAuth $name failure with the selected key through the installed Storage SDK',
    async ({ failure: authFailure }) => {
      const assertions: string[] = [];
      const captureAssertion = (body: unknown): boolean => {
        const assertion =
          typeof body === 'string'
            ? new URLSearchParams(body).get('assertion')
            : body && typeof body === 'object' && 'assertion' in body
              ? body.assertion
              : undefined;
        if (typeof assertion !== 'string') return false;
        assertions.push(assertion);
        return true;
      };
      const oauth = nock('https://www.googleapis.com')
        .post('/oauth2/v4/token', captureAssertion)
        .reply(400, authFailure.response.data)
        .post('/oauth2/v4/token', captureAssertion)
        .reply(200, {
          access_token: 'new-key-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      const storage = nock('https://storage.googleapis.com', {
        reqheaders: { authorization: 'Bearer new-key-token' },
      })
        .get('/storage/v1/b')
        .query((query) => query.project === credentials.projectId)
        .reply(200, { items: [] });
      expect(await listBuckets(gateway())).toMatchObject({
        buckets: [],
        nextCursor: null,
      });
      expect(oauth.isDone()).toBe(true);
      expect(storage.isDone()).toBe(true);
      expect(assertions).toHaveLength(2);
      for (const assertion of assertions) {
        const [header, payload, signature] = assertion.split('.');
        const claims: unknown = JSON.parse(
          Buffer.from(payload, 'base64url').toString(),
        );
        expect(claims).toMatchObject({ iss: credentials.clientEmail });
        expect(
          verify(
            'RSA-SHA256',
            Buffer.from(header + '.' + payload),
            publicKey,
            Buffer.from(signature, 'base64url'),
          ),
        ).toBe(true);
      }
    },
  );

  it.each(retryableFailures)(
    'stops after six exact $name failures within the existing backoff and preserves the last error',
    async ({ failure: authFailure }) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const attemptedAt: number[] = [];
      const failures = Array.from({ length: 6 }, () => ({ ...authFailure }));
      const gcp = gateway();
      const getBuckets = vi
        .spyOn(gcp.storageClient, 'getBuckets')
        .mockImplementation(() => {
          attemptedAt.push(Date.now() - startedAt);
          return Promise.reject(failures[attemptedAt.length - 1]);
        });
      const result = listBuckets(gcp).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBe(failures[5]);
      expect(getBuckets).toHaveBeenCalledTimes(6);
      expect(attemptedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
    },
  );

  it.each([
    {
      response: {
        status: 403,
        data: {
          error: 'invalid_grant',
          error_description: 'Invalid JWT Signature.',
        },
      },
    },
    {
      response: {
        status: 400,
        data: {
          error: 'invalid_grant',
          error_description: 'Invalid JWT: Token must be a short-lived token.',
        },
      },
    },
    { response: { ...accountFailure.response, status: 403 } },
    { response: { ...accountFailure.response, status: '400' } },
    {
      response: {
        status: 400,
        data: { ...accountFailure.response.data, error: 'invalid_client' },
      },
    },
    ...[
      'Invalid grant: account not found.',
      'Invalid grant: account not found ',
      'Invalid grant: Account not found',
      'account not found',
      null,
    ].map((error_description) => ({
      response: {
        status: 400,
        data: { error: 'invalid_grant', error_description },
      },
    })),
    { response: { status: 400, data: { error: 'invalid_grant' } } },
    { response: { status: 400, data: 'Invalid grant: account not found' } },
    { response: { status: 400, data: null } },
    { response: null },
    null,
    { code: 403, message: 'Permission denied' },
    new Error('invalid_grant: Invalid JWT Signature.'),
    new Error('invalid_grant: Invalid grant: account not found'),
  ])(
    'leaves unrelated authentication and permission failures terminal: %j',
    async (error) => {
      vi.useFakeTimers();
      const gcp = gateway();
      const getBuckets = vi
        .spyOn(gcp.storageClient, 'getBuckets')
        .mockRejectedValue(error);
      const result = listBuckets(gcp).catch((value: unknown) => value);
      await vi.runAllTimersAsync();
      expect(await result).toBe(error);
      expect(getBuckets).toHaveBeenCalledTimes(1);
    },
  );

  // The bucket check, creation and deletion are the other consumers a
  // just-saved key first exchanges through; they keep S3's exact contract.
  // Bucket names are unique per call: existence and creation are coordinated
  // process-wide per bucket, so a cached answer would hide the raw consumer.
  let smoke = 0;
  const bucketConsumers: Array<{
    name: string;
    method:
      | 'hasBucketUncoordinated'
      | 'upsertBucketUncoordinated'
      | 'deleteBucket';
    run: (gcp: GCP) => Promise<unknown>;
  }> = [
    {
      name: 'check',
      method: 'hasBucketUncoordinated',
      run: (gcp) =>
        gcp.storage().hasBucket(`anycloud-onb-smoke-${++smoke}-ab12`),
    },
    {
      name: 'creation',
      method: 'upsertBucketUncoordinated',
      run: (gcp) =>
        gcp
          .storage()
          .upsertBucket(`anycloud-onb-smoke-${++smoke}-ab12`, 'v', 'w', 'u'),
    },
    {
      name: 'deletion',
      method: 'deleteBucket',
      run: (gcp) =>
        gcp.storage().deleteBucket(`anycloud-onb-smoke-${++smoke}-ab12`),
    },
  ];
  const spyOnConsumer = (gcp: GCP, method: string) =>
    vi.spyOn(gcp as unknown as Record<string, () => Promise<unknown>>, method);

  it.each(bucketConsumers)(
    'recovers the exact signature failure once on the bucket $name',
    async ({ run, method }) => {
      const gcp = gateway();
      const consumer = spyOnConsumer(gcp, method)
        .mockRejectedValueOnce({ ...failure })
        .mockResolvedValue(true);
      await run(gcp);
      expect(consumer).toHaveBeenCalledTimes(2);
    },
  );

  it.each(bucketConsumers)(
    'stops after six exact signature failures on the bucket $name and preserves the last error',
    async ({ run, method }) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const attemptedAt: number[] = [];
      const failures = Array.from({ length: 6 }, () => ({ ...failure }));
      const gcp = gateway();
      const consumer = spyOnConsumer(gcp, method).mockImplementation(() => {
        attemptedAt.push(Date.now() - startedAt);
        return Promise.reject(failures[attemptedAt.length - 1]);
      });
      const result = run(gcp).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBe(failures[5]);
      expect(consumer).toHaveBeenCalledTimes(6);
      expect(attemptedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
    },
  );

  it.each(retryableFailures)(
    'does not start another $name authentication attempt after cancellation',
    async ({ failure: authFailure }) => {
      vi.useFakeTimers();
      const gcp = gateway();
      const getBuckets = vi
        .spyOn(gcp.storageClient, 'getBuckets')
        .mockRejectedValue(authFailure);
      const controller = new AbortController();
      const reason = new Error('Caller cancelled');
      const result = listBuckets(gcp, controller.signal).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);
      await vi.runAllTimersAsync();
      expect(await result).toBe(reason);
      expect(getBuckets).toHaveBeenCalledTimes(1);
    },
  );
});
