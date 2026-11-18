import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageProvider } from '../../../../src/api/services/cloud-config.js';
import { canMintScopedStorageToken } from '../../../../src/api/services/gateways/cloud.js';
import { createCloudflareStorage } from '../../../../src/api/services/gateways/cloudflare.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { ObjectNotFoundError } from '../../../../src/shared/errors.js';

const API = 'https://api.cloudflare.com';
const ACCOUNT = 'acct';
const BUCKETS = `/client/v4/accounts/${ACCOUNT}/r2/buckets`;
const S3 = (bucket: string, jurisdiction = '') =>
  `https://${bucket}.${ACCOUNT}.${jurisdiction}r2.cloudflarestorage.com`;

function storage(jurisdiction?: 'eu', region?: string) {
  return createCloudflareStorage(
    completeCloudConfig({
      cloudProvider: CloudType.Cloudflare,
      credentials: {
        accountId: ACCOUNT,
        apiToken: 'cf-token',
        ...(jurisdiction ? { jurisdiction } : {}),
      },
      ...(region ? { region } : {}),
    }),
  );
}

function minter(jurisdiction?: 'eu') {
  const r2 = storage(jurisdiction);
  if (!canMintScopedStorageToken(r2)) throw new Error('R2 storage must mint');
  return r2;
}

function verifiedToken() {
  return nock(API)
    .get(`/client/v4/accounts/${ACCOUNT}/tokens/verify`)
    .reply(200, {
      success: true,
      result: { id: 'token-id', status: 'active' },
    });
}

const ok = (result: unknown = {}) => ({ success: true, errors: [], result });

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('Cloudflare R2 storage', () => {
  it('signs S3 requests with the token ID and the SHA-256 of the token', async () => {
    verifiedToken();
    let authorization = '';
    nock(S3('data'))
      .head('/')
      .reply(function () {
        authorization = String(this.req.headers.authorization);
        return [200];
      });

    await expect(storage().hasBucket('data')).resolves.toBe(true);
    expect(authorization).toContain('Credential=token-id/');
    expect(authorization).toContain('/auto/s3/aws4_request');
  });

  it('creates a missing bucket in its jurisdiction and treats a conflict as ours', async () => {
    verifiedToken();
    nock(S3('out', 'eu.'))
      .head('/')
      .reply(404)
      .head('/')
      .reply(404)
      .head('/')
      .reply(200);
    let jurisdiction: string | undefined;
    const create = nock(API)
      .post(BUCKETS, { name: 'out' })
      .reply(function () {
        jurisdiction = String(this.req.headers['cf-r2-jurisdiction']);
        return [200, ok()];
      })
      .post(BUCKETS, { name: 'out' })
      .reply(409, {
        success: false,
        errors: [{ code: 10004, message: 'exists' }],
      });

    const r2 = storage('eu');
    await r2.upsertBucket('out', '0.1.68', 'job-1', 'user-1');
    await r2.upsertBucket('out', '0.1.68', 'job-2', 'user-1');

    expect(jurisdiction).toBe('eu');
    expect(create.isDone()).toBe(true);
  });

  it('empties a bucket, aborts unfinished uploads, then deletes it', async () => {
    verifiedToken();
    nock(S3('old'))
      .get('/')
      .query((q) => q['list-type'] === '2')
      .reply(
        200,
        '<ListBucketResult><Contents><Key>a</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
      )
      .post('/')
      .query((q) => 'delete' in q)
      .reply(
        200,
        '<DeleteResult><Deleted><Key>a</Key></Deleted></DeleteResult>',
      )
      .get('/')
      .query((q) => 'uploads' in q)
      .reply(
        200,
        '<ListMultipartUploadsResult><Upload><Key>big</Key><UploadId>u1</UploadId></Upload><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>',
      )
      .delete('/big')
      .query((q) => q.uploadId === 'u1')
      .reply(204);
    const remove = nock(API).delete(`${BUCKETS}/old`).reply(200, ok());

    await storage().deleteBucket('old');

    expect(remove.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats deleting a missing bucket as done', async () => {
    verifiedToken();
    nock(S3('gone'))
      .get('/')
      .query(true)
      .reply(
        404,
        '<Error><Code>NoSuchBucket</Code><Message>missing</Message></Error>',
      );

    await expect(storage().deleteBucket('gone')).resolves.toBeUndefined();
  });

  it('reports a missing object as ObjectNotFoundError', async () => {
    verifiedToken();
    nock(S3('data'))
      .get('/absent.txt')
      .query(true)
      .reply(
        404,
        '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>',
      );

    await expect(
      storage().downloadObject('data', 'absent.txt'),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('pages bucket listings through the REST API', async () => {
    nock(API)
      .get(BUCKETS)
      .query({ per_page: '2', cursor: 'c1' })
      .reply(200, {
        ...ok({
          buckets: [
            { name: 'a', creation_date: '2026-10-01T00:00:00.000Z' },
            { name: 'b' },
          ],
        }),
        result_info: { cursor: 'c2' },
      });

    const r2 = storage() as unknown as {
      listBuckets(o: { pageSize: number; cursor?: string }): Promise<unknown>;
    };
    await expect(
      r2.listBuckets({ pageSize: 2, cursor: 'c1' }),
    ).resolves.toEqual({
      buckets: [
        {
          name: 'a',
          region: 'default',
          createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
        },
        { name: 'b', region: 'default', createdAt: null },
      ],
      nextCursor: 'c2',
    });
  });

  it('classifies a refused REST call as denied', async () => {
    nock(API)
      .get(BUCKETS)
      .query(true)
      .reply(403, {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      });
    const r2 = storage();
    const error = await (
      r2 as unknown as {
        listBuckets(o: { pageSize: number }): Promise<unknown>;
      }
    )
      .listBuckets({ pageSize: 10 })
      .catch((e: unknown) => e);

    await expect(r2.classifyStorageFailure!(error)).resolves.toEqual({
      kind: 'denied',
      code: 'HTTP 403',
    });
  });

  it('is the storage a Cloudflare credential builds', () => {
    expect(
      createStorageProvider({
        cloudProvider: CloudType.Cloudflare,
        credentials: { accountId: ACCOUNT, apiToken: 'cf-token' },
      }).type,
    ).toBe(CloudType.Cloudflare);
  });

  it('mints one-bucket temporary credentials with an expiry counted from the request', async () => {
    verifiedToken();
    let jurisdiction: string | undefined;
    let body: Record<string, unknown> = {};
    nock(API)
      .post(`/client/v4/accounts/${ACCOUNT}/r2/temp-access-credentials`)
      .reply(function (_uri, requestBody) {
        jurisdiction = String(this.req.headers['cf-r2-jurisdiction']);
        body = requestBody as Record<string, unknown>;
        return [
          200,
          ok({
            accessKeyId: 'temp-key',
            secretAccessKey: 'temp-secret',
            sessionToken: 'temp-session',
          }),
        ];
      });
    const before = Date.now();

    const r2 = minter('eu');
    const token = await r2.mintScopedStorageToken([
      { bucket: 'out', mode: 'readwrite' },
    ]);

    expect(body).toEqual({
      bucket: 'out',
      parentAccessKeyId: 'token-id',
      permission: 'object-read-write',
      ttlSeconds: 129_600,
    });
    expect(jurisdiction).toBe('eu');
    expect(token?.credentials).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'temp-key',
      secretAccessKey: 'temp-secret',
      sessionToken: 'temp-session',
    });
    expect(token!.expiresAt).toBeGreaterThanOrEqual(before + 129_600_000);
    expect(r2.s3Endpoint).toBe(
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    );
  });

  it('mints read-only for read grants and refuses grants across buckets', async () => {
    verifiedToken();
    let permission: unknown;
    nock(API)
      .post(`/client/v4/accounts/${ACCOUNT}/r2/temp-access-credentials`)
      .reply(function (_uri, requestBody) {
        permission = (requestBody as { permission?: unknown }).permission;
        return [
          200,
          ok({ accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' }),
        ];
      });
    const r2 = minter();

    await r2.mintScopedStorageToken([{ bucket: 'in', mode: 'read' }]);
    expect(permission).toBe('object-read-only');
    await expect(
      r2.mintScopedStorageToken([
        { bucket: 'in', mode: 'read' },
        { bucket: 'out', mode: 'readwrite' },
      ]),
    ).rejects.toThrow('R2 temporary credentials cover one bucket');
    await expect(r2.mintScopedStorageToken([])).resolves.toBeUndefined();
  });

  it('names the account when Cloudflare refuses to mint', async () => {
    verifiedToken();
    nock(API)
      .post(`/client/v4/accounts/${ACCOUNT}/r2/temp-access-credentials`)
      .reply(403, {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      });

    await expect(
      minter().mintScopedStorageToken([{ bucket: 'in', mode: 'read' }]),
    ).rejects.toThrow(
      `Cloudflare refused R2 temporary credentials for account ${ACCOUNT}`,
    );
  });

  it('refuses a region, since the jurisdiction picks the endpoint', () => {
    expect(() => storage(undefined, 'us-east-1')).toThrow('R2 has no regions');
    expect(() => storage(undefined, 'auto')).not.toThrow();
  });
});
