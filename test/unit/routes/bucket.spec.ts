import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { Readable } from 'stream';
import { once } from 'events';
import { stat } from 'fs/promises';
import type { Server } from 'http';
import { createApp } from '../../../src/api/server.js';
import {
  createApiRequestTracker,
  type ApiRequestTracker,
} from '../../../src/api/services/http-shutdown.js';
import { callApi, getTestApiUrl } from '../helpers/api-test-helper';
import { TEST_DAEMON_VERSION } from '../config';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import Github from '../../../src/api/services/gateways/github.js';
import {
  BucketNotFoundError,
  ObjectNotFoundError,
} from '../../../src/shared/errors.js';
import { testAuthenticate } from '../../helpers/test-authentication.js';

const AUTH_HEADER = { Authorization: 'Bearer mock-github-token' };

async function withTrackedNativeApi(
  run: (
    url: string,
    server: Server,
    requests: ApiRequestTracker,
  ) => Promise<void>,
): Promise<void> {
  const requests = createApiRequestTracker();
  const server = createApp({ requests, authenticate: testAuthenticate }).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No API port');
  try {
    await run(
      `http://127.0.0.1:${address.port}/v1/credentials/prod/buckets/b/object-content?remotePath=k`,
      server,
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const NATIVE_HEADERS = {
  ...AUTH_HEADER,
  'AnyCloud-Client-Version': TEST_DAEMON_VERSION,
};

const mockUploadObject = vi.fn();
const mockDownloadObject = vi.fn();
const mockUpsertBucket = vi.fn();
const mockDeleteBucket = vi.fn();
const mockHasBucket = vi.fn();
const mockDeleteObject = vi.fn();
const mockListBuckets = vi.fn();
const mockListObjects = vi.fn();
const mockResolveCredentialByName = vi.fn();
const mockIsCredentialNotReady = vi.fn(() => false);
const mockClassifyStorageFailure = vi.fn();
const mockMint = vi.fn();
const mockCreateStorageProvider = vi.fn((_cloudConfig?: unknown) => ({
  type: 'AWS',
  region: 'us-east-1',
  mintScopedStorageToken: mockMint,
  validateScopedStorageTokenSource: () => undefined,
  uploadObject: mockUploadObject,
  downloadObject: mockDownloadObject,
  upsertBucket: mockUpsertBucket,
  deleteBucket: mockDeleteBucket,
  hasBucket: mockHasBucket,
  deleteObject: mockDeleteObject,
  listBuckets: mockListBuckets,
  listObjects: mockListObjects,
  isCredentialNotReady: mockIsCredentialNotReady,
  classifyStorageFailure: mockClassifyStorageFailure,
}));

const requestOperationOptions = () => ({
  signal: expect.any(AbortSignal),
});

async function expectNoContent(response: Response): Promise<void> {
  expect(response.status).toBe(204);
  await expect(response.text()).resolves.toBe('');
}

vi.mock('../../../src/api/services/cloud-config', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...actual,
    resolveCredentialByName: (name: string) =>
      mockResolveCredentialByName(name),
    createStorageProvider: (cc: unknown) => mockCreateStorageProvider(cc),
  };
});

describe('Bucket API routes', () => {
  beforeEach(() => {
    mockUploadObject.mockReset();
    mockDownloadObject.mockReset();
    mockUpsertBucket.mockReset();
    mockDeleteBucket.mockReset();
    mockHasBucket.mockReset();
    mockDeleteObject.mockReset();
    mockListBuckets.mockReset();
    mockListObjects.mockReset();
    mockResolveCredentialByName.mockReset();
    mockIsCredentialNotReady.mockReset();
    mockIsCredentialNotReady.mockReturnValue(false);
    mockClassifyStorageFailure.mockReset();
    mockClassifyStorageFailure.mockResolvedValue(undefined);
    mockCreateStorageProvider.mockClear();
    vi.mocked(Github.authenticate).mockClear();
  });

  it('list returns 401 without auth', async () => {
    const res = await callApi('https://example.com/v1/credentials/c/buckets', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('list returns a paged bucket summary', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockListBuckets.mockResolvedValue({
      buckets: [
        { name: 'z-bucket', region: null, createdAt: null },
        { name: 'a-bucket', region: 'us-east-1', createdAt: 123 },
      ],
      nextCursor: 'next',
    });

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets?region=us-east-1&pageSize=25&cursor=cursor-1',
      { method: 'GET', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      buckets: [
        { name: 'a-bucket', region: 'us-east-1', createdAt: 123 },
        { name: 'z-bucket', region: null, createdAt: null },
      ],
      nextCursor: 'next',
    });
    expect(mockListBuckets).toHaveBeenCalledWith(
      {
        pageSize: 25,
        cursor: 'cursor-1',
      },
      requestOperationOptions(),
    );
    expect(mockCreateStorageProvider).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-1' }),
    );
  });

  it.each(['0', '1001', '1.5', '1e2', 'many'])(
    'list rejects invalid page size %s',
    async (pageSize) => {
      const res = await callApi(
        `https://example.com/v1/credentials/prod/buckets?pageSize=${pageSize}`,
        { method: 'GET', headers: AUTH_HEADER },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'BAD_REQUEST' });
      expect(JSON.stringify(body)).toContain('between 1 and 1000');
      expect(mockResolveCredentialByName).not.toHaveBeenCalled();
    },
  );

  it('list rejects repeated region parameters', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets?region=a&region=b',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'BAD_REQUEST' });
    expect(JSON.stringify(body)).toContain('received array');
    expect(mockResolveCredentialByName).not.toHaveBeenCalled();
  });

  it('list resolves the named credential and defaults the page size', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Azure',
      creds: { cloudProvider: 'Azure' },
    });
    mockListBuckets.mockResolvedValue({ buckets: [], nextCursor: null });

    const res = await callApi(
      'https://example.com/v1/credentials/azure-prod/buckets',
      { method: 'GET', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    expect(mockResolveCredentialByName).toHaveBeenCalledWith('azure-prod');
    expect(mockListBuckets).toHaveBeenCalledWith(
      { pageSize: 1000 },
      requestOperationOptions(),
    );
    expect(await res.json()).toEqual({ buckets: [], nextCursor: null });
  });

  it('list rejects an unknown named credential', async () => {
    mockResolveCredentialByName.mockResolvedValue(null);
    const res = await callApi(
      'https://example.com/v1/credentials/missing/buckets',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BUCKET_REQUEST_INVALID',
      message: 'Credential "missing" not found',
    });
    expect(mockCreateStorageProvider).not.toHaveBeenCalled();
  });

  it('list rejects credentials without storage listing', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Lambda',
      creds: { cloudProvider: 'Lambda' },
    });
    const res = await callApi(
      'https://example.com/v1/credentials/lambda/buckets',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('do not support bucket listing');
  });

  it('objects forwards hierarchy, prefix, and pagination options', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'GCP',
      creds: { cloudProvider: 'GCP' },
    });
    mockListObjects.mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'models/z.bin',
          sizeBytes: 2,
          lastModifiedAt: 3,
        },
        { kind: 'prefix', key: 'models/a/' },
      ],
      nextCursor: null,
    });

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/objects?prefix=models%2F&recursive=false&pageSize=50&cursor=c',
      { method: 'GET', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        { kind: 'prefix', key: 'models/a/' },
        {
          kind: 'object',
          key: 'models/z.bin',
          sizeBytes: 2,
          lastModifiedAt: 3,
        },
      ],
      nextCursor: null,
    });
    expect(mockListObjects).toHaveBeenCalledWith(
      'b',
      {
        prefix: 'models/',
        recursive: false,
        pageSize: 50,
        cursor: 'c',
      },
      requestOperationOptions(),
    );
  });

  it('objects rejects an invalid recursive value', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/objects?recursive=yes',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'BAD_REQUEST' });
    expect(JSON.stringify(body)).toContain('recursive must be true or false');
  });

  it('does not return a partial response when the provider listing fails', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockListObjects.mockRejectedValue(new Error('provider page failed'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errorLog.mockRestore());
    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/objects',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(
      errorLog.mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toContainEqual(
      expect.objectContaining({
        message: 'API procedure failed',
        procedure: 'bucket.objects',
      }),
    );
  });

  it('declares a missing bucket listing as not found, requested once and not logged', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Azure',
      creds: { cloudProvider: 'Azure' },
    });
    mockListObjects.mockRejectedValue(
      new BucketNotFoundError('gone', new Error('ContainerNotFound')),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errorLog.mockRestore());

    await expect(
      createApiClient('mock-github-token', {
        apiUrl: getTestApiUrl(),
        retryDelayMs: 0,
      }).bucket.objects({
        params: { bucketName: 'gone', credentialName: 'prod' },
        query: {},
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'BUCKET_NOT_FOUND',
      message: 'Bucket not found: gone',
    });
    expect(mockListObjects).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('declares an exhausted Azure propagation window as retryable', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Azure',
      creds: { cloudProvider: 'Azure' },
    });
    mockUpsertBucket.mockRejectedValue(new Error('AuthorizationFailed'));
    mockIsCredentialNotReady.mockReturnValue(true);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b',
      { method: 'PUT', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'BUCKET_CREDENTIAL_NOT_READY',
      message: expect.stringContaining('propagating'),
    });
    expect(JSON.stringify(body)).not.toContain('AuthorizationFailed');
  });

  it('upload returns 401 without auth', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/b/object-content?remotePath=k',
      { method: 'PUT', body: 'x' },
    );
    expect(res.status).toBe(401);
  });

  it('download returns 401 without auth', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/b/object-content?remotePath=k',
      { method: 'GET' },
    );
    expect(res.status).toBe(401);
  });

  it('upload rejects missing bucketName', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/%20/object-content?remotePath=k',
      { method: 'PUT', headers: AUTH_HEADER, body: 'x' },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bucketName');
  });

  it('upload rejects unknown credential name', async () => {
    mockResolveCredentialByName.mockResolvedValue(null);
    const res = await callApi(
      'https://example.com/v1/credentials/missing/buckets/b/object-content?remotePath=k',
      { method: 'PUT', headers: AUTH_HEADER, body: 'x' },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
      message: 'Credential "missing" not found',
    });
  });

  it('upload spools the request body to a replayable file source', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockUploadObject.mockResolvedValue(undefined);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k&region=us-east-1',
      {
        method: 'PUT',
        headers: { ...AUTH_HEADER, 'Content-Type': 'application/octet-stream' },
        body: 'payload',
      },
    );
    expect(res.status).toBe(204);
    expect(Github.authenticate).toHaveBeenCalledTimes(1);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockCreateStorageProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudProvider: 'AWS',
        region: 'us-east-1',
      }),
    );
    expect(mockUploadObject).toHaveBeenCalledTimes(1);
    const [bucket, remotePath, source] = mockUploadObject.mock.calls[0];
    expect(bucket).toBe('b');
    expect(remotePath).toBe('k');
    expect(source).toEqual(
      expect.objectContaining({
        kind: 'file',
        contentLength: 'payload'.length,
      }),
    );
    expect(source.path).toContain('anycloud-upload-');
  });

  it('maps exhausted upload credential propagation to a retryable error', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Azure',
      creds: { cloudProvider: 'Azure' },
    });
    const providerError = Object.assign(
      new Error('AuthorizationFailed: provider detail'),
      { statusCode: 403 },
    );
    mockUploadObject.mockRejectedValue(providerError);
    mockIsCredentialNotReady.mockReturnValue(true);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
      { method: 'PUT', headers: AUTH_HEADER, body: 'payload' },
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'BUCKET_CREDENTIAL_NOT_READY',
      message: expect.stringContaining('propagating'),
    });
    expect(JSON.stringify(body)).not.toContain('AuthorizationFailed');
    expect(mockIsCredentialNotReady).toHaveBeenCalledWith(providerError);
  });

  it('preserves an unrelated upload permission failure as a 403', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Azure',
      creds: { cloudProvider: 'Azure' },
    });
    const providerError = Object.assign(new Error('Access denied'), {
      statusCode: 403,
    });
    mockUploadObject.mockRejectedValue(providerError);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
      { method: 'PUT', headers: AUTH_HEADER, body: 'payload' },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'BUCKET_OPERATION_FAILED',
      message: 'Access denied',
    });
    expect(mockIsCredentialNotReady).toHaveBeenCalledWith(providerError);
  });

  it.each([
    [
      'an upload to a missing bucket',
      'PUT',
      mockUploadObject,
      new BucketNotFoundError('b', null),
    ],
    [
      'a download from a missing bucket',
      'GET',
      mockDownloadObject,
      new BucketNotFoundError('b', null),
    ],
    [
      'a download of a missing object',
      'GET',
      mockDownloadObject,
      new ObjectNotFoundError('b', 'k', null),
    ],
  ])(
    'declares %s as a 404 without an error log',
    async (_case, method, operation, error) => {
      mockResolveCredentialByName.mockResolvedValue({
        id: 'cred-1',
        cloudProvider: 'GCP',
        creds: { cloudProvider: 'GCP' },
      });
      operation.mockRejectedValue(error);
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => errorLog.mockRestore());

      const res = await callApi(
        'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
        {
          method,
          headers: AUTH_HEADER,
          ...(method === 'PUT' ? { body: 'payload' } : {}),
        },
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code:
          error instanceof BucketNotFoundError
            ? 'BUCKET_NOT_FOUND'
            : 'OBJECT_NOT_FOUND',
        message: error.message,
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  // The shape @aws-sdk/client-s3 throws for a 403; the raw message and
  // request ID must reach only the server log.
  const accessDenied = () =>
    Object.assign(new Error('User arn:aws:iam::123:user/alice is denied'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'REQ123' },
    });

  it.each([
    ['upload', 'PUT', mockUploadObject, 'upload to b/k'],
    ['download', 'GET', mockDownloadObject, 'download b/k'],
  ])(
    'declares a denied %s as a 403 from one request with a WARN log only',
    async (_case, method, operation, subject) => {
      mockResolveCredentialByName.mockResolvedValue({
        id: 'cred-1',
        cloudProvider: 'AWS',
        creds: { cloudProvider: 'AWS' },
      });
      const providerError = accessDenied();
      operation.mockRejectedValue(providerError);
      mockClassifyStorageFailure.mockResolvedValue({
        kind: 'denied',
        code: 'AccessDenied',
      });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => {
        errorLog.mockRestore();
        warnLog.mockRestore();
      });

      const res = await callApi(
        'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
        {
          method,
          headers: AUTH_HEADER,
          ...(method === 'PUT' ? { body: 'payload' } : {}),
        },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'BUCKET_ACCESS_DENIED',
        message: `Access denied: credential "prod" cannot ${subject} (AWS AccessDenied). Check the credential and its AWS permissions.`,
      });
      expect(JSON.stringify(body)).not.toMatch(/arn:aws|REQ123/);
      expect(mockClassifyStorageFailure).toHaveBeenCalledWith(
        providerError,
        'b',
        'k',
      );
      expect(operation).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
      const warning = JSON.parse(String(warnLog.mock.calls[0]?.[0]));
      expect(warning).toMatchObject({
        level: 'WARN',
        code: 'BUCKET_ACCESS_DENIED',
        message: body.message,
      });
      expect(warning.error).toMatchObject({
        message: providerError.message,
        $metadata: { requestId: 'REQ123' },
      });
    },
  );

  // The AWS SDK's hidden raw response, carrying S3's Retry-After.
  const slowDown = (retryAfter: string) =>
    Object.defineProperty(new Error('SlowDown'), '$response', {
      value: { statusCode: 503, headers: { 'retry-after': retryAfter } },
    });

  it('declares a throttled download as a retryable 503', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockDownloadObject.mockRejectedValue(slowDown('5'));
    mockClassifyStorageFailure.mockResolvedValue({
      kind: 'throttled',
      code: 'SlowDown',
    });
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnLog.mockRestore());

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
      { method: 'GET', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({
      code: 'BUCKET_THROTTLED',
      message:
        'AWS throttled credential "prod" trying to download b/k (SlowDown). Retry shortly.',
    });
  });

  const typedClient = () =>
    createApiClient('mock-github-token', {
      apiUrl: getTestApiUrl(),
      retryDelayMs: 0,
    });
  const bucketInput = {
    params: { credentialName: 'prod', bucketName: 'b' },
    query: {},
  };

  it.each([
    [
      'list',
      mockListBuckets,
      () =>
        typedClient().bucket.list({
          params: { credentialName: 'prod' },
          query: {},
        }),
      'list buckets',
    ],
    [
      'objects',
      mockListObjects,
      () => typedClient().bucket.objects(bucketInput),
      'list objects in b',
    ],
    [
      'exists',
      mockHasBucket,
      () => typedClient().bucket.exists(bucketInput),
      'check bucket b',
    ],
    [
      'create',
      mockUpsertBucket,
      () => typedClient().bucket.create(bucketInput),
      'create bucket b',
    ],
    [
      'delete',
      mockDeleteBucket,
      () => typedClient().bucket.delete(bucketInput),
      'delete bucket b',
    ],
    [
      'deleteObject',
      mockDeleteObject,
      () =>
        typedClient().bucket.deleteObject({
          params: bucketInput.params,
          query: { remotePath: 'k' },
        }),
      'delete b/k',
    ],
  ])(
    'declares a denied bucket.%s as BUCKET_ACCESS_DENIED from one request without an error log',
    async (_procedure, operation, call, subject) => {
      mockResolveCredentialByName.mockResolvedValue({
        id: 'cred-1',
        cloudProvider: 'AWS',
        creds: { cloudProvider: 'AWS' },
      });
      operation.mockRejectedValue(accessDenied());
      mockClassifyStorageFailure.mockResolvedValue({
        kind: 'denied',
        code: 'AccessDenied',
      });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => {
        errorLog.mockRestore();
        warnLog.mockRestore();
      });

      await expect(call()).rejects.toMatchObject({
        status: 403,
        code: 'BUCKET_ACCESS_DENIED',
        message: `Access denied: credential "prod" cannot ${subject} (AWS AccessDenied). Check the credential and its AWS permissions.`,
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it('declares a throttled listing as BUCKET_THROTTLED with the provider Retry-After, which the client retries', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockListObjects.mockRejectedValue(slowDown('6'));
    mockClassifyStorageFailure.mockResolvedValue({
      kind: 'throttled',
      code: 'SlowDown',
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => {
      errorLog.mockRestore();
      warnLog.mockRestore();
    });

    const raw = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/objects',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(raw.status).toBe(503);
    expect(raw.headers.get('retry-after')).toBe('6');
    mockListObjects.mockClear();

    await expect(
      typedClient().bucket.objects(bucketInput),
    ).rejects.toMatchObject({ status: 503, code: 'BUCKET_THROTTLED' });
    // The client's throttle budget allows eight retries.
    expect(mockListObjects).toHaveBeenCalledTimes(9);
  });

  it('create returns 401 without auth', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/b',
      { method: 'PUT' },
    );
    expect(res.status).toBe(401);
  });

  it('create rejects missing bucketName', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/%20',
      { method: 'PUT', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bucketName');
  });

  it('repeated create calls the idempotent bucket upsert', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockUpsertBucket.mockResolvedValue(undefined);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b?region=us-east-1',
      { method: 'PUT', headers: AUTH_HEADER },
    );
    const replay = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b?region=us-east-1',
      { method: 'PUT', headers: AUTH_HEADER },
    );
    await expectNoContent(res);
    await expectNoContent(replay);
    expect(mockUpsertBucket).toHaveBeenCalledTimes(2);
    const [bucket, version, workloadId, userId] =
      mockUpsertBucket.mock.calls[0];
    expect(bucket).toBe('b');
    expect(version).toBe(TEST_DAEMON_VERSION);
    expect(workloadId).toMatch(/^cli-.+-\d+$/);
    expect(userId).toBeTruthy();
  });

  it('keeps the typed client output empty for a 204 response', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockUpsertBucket.mockResolvedValue(undefined);

    const result = await createApiClient('mock-github-token', {
      apiUrl: getTestApiUrl(),
      retryDelayMs: 0,
    }).bucket.create({
      params: {
        bucketName: 'b',
        credentialName: 'prod',
      },
      query: {},
    });

    expect(result).toBeUndefined();
  });

  it('delete returns 401 without auth', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/b',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(401);
  });

  it('delete rejects missing bucketName', async () => {
    const res = await callApi(
      'https://example.com/v1/credentials/c/buckets/%20',
      { method: 'DELETE', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bucketName');
  });

  it('repeated delete calls the idempotent bucket deletion', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockDeleteBucket.mockResolvedValue(undefined);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b?region=us-east-1',
      { method: 'DELETE', headers: AUTH_HEADER },
    );
    const replay = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b?region=us-east-1',
      { method: 'DELETE', headers: AUTH_HEADER },
    );
    await expectNoContent(res);
    await expectNoContent(replay);
    expect(mockDeleteBucket).toHaveBeenCalledTimes(2);
    expect(mockDeleteBucket).toHaveBeenNthCalledWith(
      1,
      'b',
      requestOperationOptions(),
    );
    expect(mockDeleteBucket).toHaveBeenNthCalledWith(
      2,
      'b',
      requestOperationOptions(),
    );
  });

  it('exists returns the gateway bucket existence result', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockHasBucket.mockResolvedValue(true);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b?region=us-east-1',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ name: 'b' });
    expect(mockCreateStorageProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudProvider: 'AWS',
        region: 'us-east-1',
      }),
    );
    expect(mockHasBucket).toHaveBeenCalledWith('b', requestOperationOptions());
  });

  it('surfaces an absent bucket to the typed client as a declared error', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockHasBucket.mockResolvedValue(false);

    // A bodiless response would reach the client as a generic NOT_FOUND, so
    // this has to run over real HTTP through the contract client.
    await expect(
      createApiClient('mock-github-token', {
        apiUrl: getTestApiUrl(),
        retryDelayMs: 0,
      }).bucket.exists({
        params: { bucketName: 'b', credentialName: 'prod' },
        query: {},
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'BUCKET_NOT_FOUND',
      message: 'Bucket not found',
    });
  });

  it('repeated rm calls the idempotent object deletion', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockDeleteObject.mockResolvedValue(undefined);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/objects?remotePath=k&region=us-east-1',
      { method: 'DELETE', headers: AUTH_HEADER },
    );
    const replay = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/objects?remotePath=k&region=us-east-1',
      { method: 'DELETE', headers: AUTH_HEADER },
    );
    await expectNoContent(res);
    await expectNoContent(replay);
    expect(mockDeleteObject).toHaveBeenCalledTimes(2);
    expect(mockDeleteObject).toHaveBeenNthCalledWith(
      1,
      'b',
      'k',
      requestOperationOptions(),
    );
    expect(mockDeleteObject).toHaveBeenNthCalledWith(
      2,
      'b',
      'k',
      requestOperationOptions(),
    );
  });

  it('preserves opaque object-key whitespace on deletion', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockDeleteObject.mockResolvedValue(undefined);

    const remotePath = ' models/final.bin ';
    const res = await callApi(
      `https://example.com/v1/credentials/prod/buckets/b/objects?remotePath=${encodeURIComponent(remotePath)}`,
      { method: 'DELETE', headers: AUTH_HEADER },
    );

    await expectNoContent(res);
    expect(mockDeleteObject).toHaveBeenCalledWith(
      'b',
      remotePath,
      requestOperationOptions(),
    );
  });

  it('download streams the gateway response', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'GCP',
      creds: { cloudProvider: 'GCP' },
    });
    const payload = Buffer.from('hello-bytes');
    mockDownloadObject.mockResolvedValue({
      stream: Readable.from([payload]),
      contentLength: payload.length,
    });

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
      { method: 'GET', headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    expect(Github.authenticate).toHaveBeenCalledTimes(1);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-length')).toBe(String(payload.length));
    expect(res.headers.get('x-anycloud-object-size')).toBe(
      String(payload.length),
    );
    expect(await res.text()).toBe('hello-bytes');
    expect(mockDownloadObject).toHaveBeenCalledWith('b', 'k');
  });

  it('tracks a disconnected download until the source finishes cleanup', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'GCP',
      creds: { cloudProvider: 'GCP' },
    });
    let finishDestroy: (() => void) | undefined;
    let notifyDestroy!: () => void;
    const destroying = new Promise<void>((resolve) => {
      notifyDestroy = resolve;
    });
    let sent = false;
    const stream = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.from('first chunk'));
        }
      },
      destroy(error, callback) {
        finishDestroy = () => callback(error);
        notifyDestroy();
      },
    });
    mockDownloadObject.mockResolvedValue({ stream });

    await withTrackedNativeApi(async (url, server, requests) => {
      const response = await fetch(url, { headers: NATIVE_HEADERS });
      try {
        expect(response.status).toBe(200);
        expect(requests.pending()).toMatchObject({ 'native.download': 1 });
        server.closeAllConnections();
        await destroying;
        expect(stream.destroyed).toBe(true);
        expect(requests.pending()).toMatchObject({ 'native.download': 1 });
      } finally {
        stream.destroy();
        finishDestroy?.();
        await response.body?.cancel().catch(() => {});
      }
      await requests.waitForIdle();
      expect(requests.pending()).toEqual({});
      expect(stream.closed).toBe(true);
    });
  });

  it('tracks an accepted upload through provider completion and file cleanup after disconnect', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    let finishUpload!: () => void;
    let notifyUpload!: () => void;
    const uploading = new Promise<void>((resolve) => {
      notifyUpload = resolve;
    });
    const uploaded = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    mockUploadObject.mockImplementation(async () => {
      notifyUpload();
      await uploaded;
    });

    await withTrackedNativeApi(async (url, server, requests) => {
      const response = fetch(url, {
        method: 'PUT',
        headers: NATIVE_HEADERS,
        body: 'payload',
      }).catch((error: unknown) => error);
      await uploading;
      const source = mockUploadObject.mock.calls[0][2];
      try {
        server.closeAllConnections();
        await response;
        expect(requests.pending()).toMatchObject({ 'native.upload': 1 });
        await expect(stat(source.path)).resolves.toMatchObject({ size: 7 });
      } finally {
        finishUpload();
      }
      await requests.waitForIdle();
      expect(requests.pending()).toEqual({});
      await expect(stat(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('maps exhausted download credential propagation to a retryable error', async () => {
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'Azure',
      creds: { cloudProvider: 'Azure' },
    });
    const providerError = Object.assign(
      new Error('AuthorizationFailed: provider detail'),
      { statusCode: 403 },
    );
    mockDownloadObject.mockRejectedValue(providerError);
    mockIsCredentialNotReady.mockReturnValue(true);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/b/object-content?remotePath=k',
      { method: 'GET', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'BUCKET_CREDENTIAL_NOT_READY',
      message: expect.stringContaining('propagating'),
    });
    expect(JSON.stringify(body)).not.toContain('AuthorizationFailed');
    expect(mockIsCredentialNotReady).toHaveBeenCalledWith(providerError);
  });

  // The backup bucket holds the API's cipher key and database.
  it.each([
    ['list objects in', 'GET', 'objects', mockListObjects],
    [
      'download from',
      'GET',
      'object-content?remotePath=cipher.key',
      mockDownloadObject,
    ],
    [
      'upload to',
      'PUT',
      'object-content?remotePath=cipher.key',
      mockUploadObject,
    ],
    [
      'delete an object in',
      'DELETE',
      'objects?remotePath=cipher.key',
      mockDeleteObject,
    ],
    ['check', 'GET', '', mockHasBucket],
    ['create', 'PUT', '', mockUpsertBucket],
    ['delete', 'DELETE', '', mockDeleteBucket],
  ])(
    'refuses to %s the API backup bucket',
    async (_action, method, suffix, operation) => {
      vi.stubEnv(
        'ANYCLOUD_BACKUP_CONFIG',
        JSON.stringify({
          bucket: 'api-backups',
          region: 'us-east-1',
          cloudProvider: 'AWS',
          credentials: { cloudProvider: 'AWS' },
        }),
      );
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      mockResolveCredentialByName.mockResolvedValue({
        id: 'cred-1',
        cloudProvider: 'AWS',
        creds: { cloudProvider: 'AWS' },
      });

      const res = await callApi(
        `https://example.com/v1/credentials/prod/buckets/api-backups${suffix ? `/${suffix}` : ''}`,
        {
          method,
          headers: AUTH_HEADER,
          ...(method === 'PUT' && suffix ? { body: 'payload' } : {}),
        },
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'BUCKET_ACCESS_DENIED',
        message: expect.stringContaining("API's own backup bucket"),
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  describe('storage tokens', () => {
    const mintRequest = (credential: string, body: object) =>
      callApi(
        `https://example.com/v1/credentials/${credential}/storage-tokens`,
        {
          method: 'POST',
          headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

    beforeEach(() => {
      mockMint.mockReset();
      mockMint.mockResolvedValue({
        credentials: {
          cloudProvider: 'AWS',
          accessKeyId: 'ASIA',
          secretAccessKey: 'secret',
          sessionToken: 'session',
        },
        expiresAt: 1_800_000_000_000,
      });
    });

    it('mints with the defaults and answers the declared errors', async () => {
      vi.stubEnv(
        'ANYCLOUD_BACKUP_CONFIG',
        JSON.stringify({
          bucket: 'api-backups',
          region: 'us-east-1',
          cloudProvider: 'AWS',
          credentials: { cloudProvider: 'AWS' },
        }),
      );
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      mockResolveCredentialByName.mockImplementation(async (name: string) => ({
        id: 'cred-1',
        cloudProvider: name === 'r2' ? 'Cloudflare' : 'AWS',
        creds: { cloudProvider: name === 'r2' ? 'Cloudflare' : 'AWS' },
      }));

      const minted = await mintRequest('prod', {
        grants: [{ bucket: 'cache', prefix: 'main/', mode: 'read' }],
      });
      expect(minted.status).toBe(200);
      expect(minted.headers.get('cache-control')).toBe('no-store');
      expect(await minted.json()).toEqual({
        cloud: 'AWS',
        region: 'us-east-1',
        tokens: [
          {
            grants: [0],
            expiresAt: 1_800_000_000_000,
            credentials: {
              accessKeyId: 'ASIA',
              secretAccessKey: 'secret',
              sessionToken: 'session',
            },
          },
        ],
      });
      expect(mockMint).toHaveBeenCalledWith(
        [{ bucket: 'cache', prefix: 'main/', mode: 'read', noDelete: true }],
        { lifetimeMs: 900_000 },
      );

      for (const [credential, grant, status, code] of [
        ['prod', { prefix: 'a/../' }, 400, 'BAD_REQUEST'],
        ['prod', { bucket: 'api-backups' }, 403, 'STORAGE_TOKEN_FORBIDDEN'],
        ['r2', {}, 400, 'STORAGE_TOKEN_UNSUPPORTED'],
        [
          'missing-bucket-name',
          { bucket: 'A*' },
          400,
          'STORAGE_TOKEN_REQUEST_INVALID',
        ],
      ] as const) {
        const refused = await mintRequest(credential, {
          grants: [{ bucket: 'cache', mode: 'read', ...grant }],
        });
        expect(refused.status).toBe(status);
        expect(await refused.json()).toMatchObject({ code });
      }
      expect(mockMint).toHaveBeenCalledOnce();
    });
  });

  it('allows a bucket on another cloud that shares the backup bucket name', async () => {
    vi.stubEnv(
      'ANYCLOUD_BACKUP_CONFIG',
      JSON.stringify({
        bucket: 'api-backups',
        region: 'us-central1',
        cloudProvider: 'GCP',
        credentials: { cloudProvider: 'GCP' },
      }),
    );
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    mockResolveCredentialByName.mockResolvedValue({
      id: 'cred-1',
      cloudProvider: 'AWS',
      creds: { cloudProvider: 'AWS' },
    });
    mockHasBucket.mockResolvedValue(true);

    const res = await callApi(
      'https://example.com/v1/credentials/prod/buckets/api-backups',
      { method: 'GET', headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    expect(mockHasBucket).toHaveBeenCalledOnce();
  });
});
