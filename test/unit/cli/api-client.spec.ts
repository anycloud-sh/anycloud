import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { ORPCError } from '@orpc/client';
import { Readable } from 'node:stream';

// Provide a local API server URL so getApiUrl() doesn't throw
process.env.API_URL = 'http://localhost:8080';
import {
  downloadBucketObject,
  executeWorkloadCommand,
  streamWorkloadLogs,
  uploadBucketObject,
} from '../../../src/shared/services/api-client/native.js';
import { summarizeErrorBody } from '../../../src/shared/services/api-client/outage.js';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import {
  checkApiVersion,
  getAnycloudVersion,
  setPreFlightCheck,
} from '../../../src/shared/services/api-client/runtime.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { quotaStatusTimeoutMs } from '../../../src/shared/api-contract/quota.js';
import { type WorkloadAdmissionInput as WorkloadRequest } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import {
  type CostReportRequest,
  type WorkloadCostRequest,
  type WorkloadListInput as ListRequest,
  type WorkloadStatusInput as StatusRequest,
  type WorkloadTerminateInput as TerminateRequest,
} from '../../../src/shared/api-contract/workload-management-schemas.js';
import { type CloudCredentials } from '../../../src/shared/cloud.js';
import { type WorkloadAdmissionCloudConfig } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import pkg from '../../../package.json';
import { CloudType } from '../../../src/shared/cloud.js';

// Small test conveniences: each call still exercises the production contract
// client; these only keep the transport-focused cases below concise.
type Authed<T> = T & { accessToken: string };

function createWorkload(request: Authed<WorkloadRequest>) {
  const { accessToken, ...input } = request;
  return createApiClient(accessToken).admission.submit(input);
}

function listWorkloads(request: Authed<ListRequest>) {
  const { accessToken, limit, sinceMs, sessionExact, ...query } = request;
  return createApiClient(accessToken).workloads.list({
    query: {
      ...query,
      limit: limit === undefined ? undefined : String(limit),
      sinceMs: sinceMs === undefined ? undefined : String(sinceMs),
      sessionExact:
        sessionExact === undefined
          ? undefined
          : sessionExact
            ? 'true'
            : 'false',
    },
  });
}

async function getWorkloadCosts(request: Authed<WorkloadCostRequest>) {
  const { accessToken, id, sessionExact, ...query } = request;
  return createApiClient(accessToken).workloads.cost({
    params: { id },
    query: {
      ...query,
      sessionExact:
        sessionExact === undefined
          ? undefined
          : sessionExact
            ? 'true'
            : 'false',
    },
  });
}

async function getCostReport(request: Authed<CostReportRequest>) {
  const { accessToken, sinceMs, sessionExact, ...query } = request;
  return createApiClient(accessToken).workloads.costReport({
    query: {
      ...query,
      sinceMs: String(sinceMs),
      sessionExact:
        sessionExact === undefined
          ? undefined
          : sessionExact
            ? 'true'
            : 'false',
    },
  });
}

function getWorkloadStatus(
  request: Authed<StatusRequest>,
  timeoutMs?: number,
  options: { signal?: AbortSignal } = {},
) {
  return createApiClient(request.accessToken, {
    requestTimeoutMs: timeoutMs,
  }).workloads.status(
    {
      params: { id: request.id },
      query: { verbose: request.verbose ? 'true' : undefined },
    },
    { signal: options.signal },
  );
}

function getApiCredential(accessToken: string, name: string) {
  return createApiClient(accessToken).credentials.get({ params: { name } });
}

function saveApiCredential(
  accessToken: string,
  name: string,
  credential: CloudCredentials,
  options: { overwrite: boolean },
) {
  return createApiClient(accessToken).credentials.save({
    params: { name },
    query: { overwrite: options.overwrite ? 'true' : 'false' },
    body: credential,
  });
}

function deleteApiCredential(accessToken: string, name: string) {
  return createApiClient(accessToken).credentials.delete({
    params: { name },
    query: { force: 'false' },
  });
}

function listApiAccessUsers(accessToken: string) {
  return createApiClient(accessToken).apiAccess.list();
}

function grantApiAccessUser(accessToken: string, username: string) {
  return createApiClient(accessToken).apiAccess.grant({ username });
}

function revokeApiAccessUser(accessToken: string, userId: string) {
  return createApiClient(accessToken).apiAccess.revoke({
    params: { userId },
  });
}

function terminateWorkload(request: Authed<TerminateRequest>) {
  return createApiClient(request.accessToken).workloads.terminate({
    params: { id: request.id },
    query: { session: request.session },
  });
}

function fetchCallFor(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes(path));
  if (!call) throw new Error(`No fetch call for ${path}`);
  return call;
}

function fetchCallCountFor(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(path))
    .length;
}

interface LegacyFetchResult {
  ok?: boolean;
  status?: number;
  headers?: HeadersInit;
  body?: BodyInit | null;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

// Loose by design: legacy cases hand the adapter response-shaped objects
// rather than real Response instances.
type FetchMockCall = (
  url: string,
  init?: RequestInit,
) => Promise<Response | LegacyFetchResult> | Response | LegacyFetchResult;

function errorCode(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_SERVER_ERROR';
}

/**
 * Keep these transport tests readable while exercising the real oRPC codec.
 * Older cases return small response-shaped objects and inspect URL/init pairs;
 * the adapter presents those to the mock, then returns a standards Response to
 * the contract client.
 */
function adaptFetchMock(fetchMock: Mock<FetchMockCall>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const contentType = request.headers.get('content-type');
    const authorization = request.headers.get('authorization');
    const accept = request.headers.get('accept');
    const clientVersion = request.headers.get(ANYCLOUD_CLIENT_VERSION_HEADER);
    const headers: Record<string, string> = Object.fromEntries(
      request.headers.entries(),
    );
    if (contentType) headers['Content-Type'] = contentType;
    if (authorization) headers.Authorization = authorization;
    if (accept) headers.Accept = accept;
    if (clientVersion) {
      headers[ANYCLOUD_CLIENT_VERSION_HEADER] = clientVersion;
    }
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.clone().text();
    const result = (await fetchMock(request.url, {
      ...init,
      method: request.method,
      headers,
      body,
      signal: init?.signal ?? request.signal,
    })) as Response | LegacyFetchResult;
    if (result instanceof Response) return result;

    const status = result.status ?? (result.ok === false ? 500 : 200);
    const responseHeaders = new Headers(result.headers);
    let responseBody = result.body;
    if (result.json) {
      const json = await result.json();
      responseBody = JSON.stringify(
        status >= 400 && json && typeof json === 'object'
          ? { defined: true, ...json }
          : json,
      );
      responseHeaders.set('content-type', 'application/json');
    } else if (result.text) {
      const message = await result.text();
      responseBody =
        status >= 400
          ? JSON.stringify({
              defined: false,
              code: errorCode(status),
              status,
              message,
            })
          : message;
      if (status >= 400) {
        responseHeaders.set('content-type', 'application/json');
      }
    }
    return new Response(responseBody, { status, headers: responseHeaders });
  }) as typeof fetch;
}

describe('API Client - summarizeErrorBody', () => {
  it('passes short plain-text API errors through unchanged', () => {
    expect(summarizeErrorBody('Credential "missing" not found')).toBe(
      'Credential "missing" not found',
    );
    expect(summarizeErrorBody('  boom  ')).toBe('boom');
    expect(summarizeErrorBody('')).toBe('');
  });

  it('replaces an HTML error page (e.g. a misrouted URL hitting GitHub) with a hint', () => {
    const githubUnicorn =
      '<!DOCTYPE html>\n<html><head><title>Unicorn!</title></head>' +
      '<body>'.padEnd(12_000, 'x') +
      '</body></html>';
    const summary = summarizeErrorBody(githubUnicorn);
    expect(summary).toMatch(/^<HTML error page \(\d+ bytes\)/);
    expect(summary).toContain('is your anycloud API URL correct?');
    // The whole page must not leak into the summary.
    expect(summary.length).toBeLessThan(200);
    expect(summary).not.toContain('<body>');
  });

  it('length-caps a large non-HTML body instead of dumping it', () => {
    const big = 'x'.repeat(5_000);
    const summary = summarizeErrorBody(big);
    expect(summary.length).toBeLessThan(600);
    expect(summary).toContain('5000 bytes total');
    expect(summary.startsWith('x'.repeat(500))).toBe(true);
  });
});

describe('API Client - version', () => {
  const originalVersionEnv = process.env.ANYCLOUD_VERSION;

  afterEach(() => {
    if (originalVersionEnv === undefined) {
      delete process.env.ANYCLOUD_VERSION;
    } else {
      process.env.ANYCLOUD_VERSION = originalVersionEnv;
    }
  });

  it('reports the package version and ignores ANYCLOUD_VERSION', () => {
    process.env.ANYCLOUD_VERSION = '9.9.9';

    expect(getAnycloudVersion()).toBe(pkg.version);
  });
});

describe('API Client - API version compatibility', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reports an exact match for explicit diagnostics', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: pkg.version }),
    });

    await expect(checkApiVersion()).resolves.toMatchObject({
      apiVersion: pkg.version,
      compatible: true,
    });
  });

  it('reports a mismatch without enforcing it as a request preflight', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.0.1' }),
    });

    await expect(checkApiVersion()).resolves.toMatchObject({
      apiVersion: '0.0.1',
      compatible: false,
      reason: 'API version is 0.0.1',
    });
  });

  it('accepts an API one release newer, and not one release older', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.1', previousVersion: pkg.version }),
    });
    await expect(checkApiVersion()).resolves.toMatchObject({
      apiVersion: '99.0.1',
      compatible: true,
    });

    // The older API admits only its own predecessor, not this CLI.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: pkg.previousVersion,
        previousVersion: '0.0.1',
      }),
    });
    await expect(checkApiVersion()).resolves.toMatchObject({
      apiVersion: pkg.previousVersion,
      compatible: false,
    });
  });

  it('reports when the API has no diagnostic version endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(checkApiVersion()).resolves.toMatchObject({
      compatible: false,
      reason: '/v1/version returned HTTP 404',
    });
  });

  it('reports a malformed diagnostic version response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await expect(checkApiVersion()).resolves.toMatchObject({
      compatible: false,
      reason: '/v1/version response is missing version',
    });
  });
});

describe('API Client - createWorkload', () => {
  let fetchMock: Mock<FetchMockCall>;
  let originalFetch: typeof global.fetch;
  let originalIsTest: string | undefined;

  beforeEach(() => {
    originalIsTest = process.env.IS_TEST;
    // Store original fetch
    originalFetch = global.fetch;

    // Create a fetch mock that returns the workload admission response.
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return {
        ok: true,
        json: async () => ({
          id: 'test-workload-123',
        }),
      };
    });

    // Replace global fetch
    global.fetch = adaptFetchMock(fetchMock);
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    if (originalIsTest === undefined) delete process.env.IS_TEST;
    else process.env.IS_TEST = originalIsTest;
    setPreFlightCheck(null);
    vi.restoreAllMocks();
  });

  it('should send cloudConfig in request payload', async () => {
    // Arrange
    const image = 'nginx:alpine';
    const cloudConfig: WorkloadAdmissionCloudConfig = {
      cloudProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_B1s',
      credentials: {
        applicationId: 'test-app-id',
        secret: 'test-secret',
        directoryId: 'test-dir-id',
        subscriptionId: 'test-sub-id',
      },
    };
    const accessToken = 'github-token';
    const workloadType = 'job';

    // Act
    const response = await createWorkload({
      image,
      cloudConfig,
      accessToken,
      workloadType,
    });

    // Assert
    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);

    const callArgs = fetchCallFor(fetchMock, '/v1/workloads');
    const requestBody = JSON.parse(callArgs[1].body);

    // Verify cloudConfig is sent correctly
    expect(requestBody.cloudConfig).toBeDefined();
    expect(requestBody.cloudConfig.cloudProvider).toBe('Azure');
    expect(requestBody.cloudConfig.region).toBe('eastus');
    expect(requestBody.cloudConfig.credentials).toBeDefined();

    // Verify other fields
    expect(requestBody.image).toBe(image);
    expect(requestBody).not.toHaveProperty('accessToken');
    expect(callArgs[1].headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(requestBody).not.toHaveProperty('version');
    expect(callArgs[1].headers[ANYCLOUD_CLIENT_VERSION_HEADER]).toBe(
      pkg.version,
    );

    // Verify response from server
    expect(response.id).toBe('test-workload-123');
  });

  const minimalRequest = (): Authed<WorkloadRequest> => {
    const cloudConfig: WorkloadAdmissionCloudConfig = {
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't2.micro',
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    };
    return {
      image: 'nginx:alpine',
      cloudConfig,
      accessToken: 'gh',
      workloadType: 'job',
    };
  };

  it('retries on a 503 (not processed) and then succeeds', async () => {
    vi.useFakeTimers();
    try {
      let newCalls = 0;
      fetchMock.mockImplementation(async (_url) => {
        newCalls += 1;
        if (newCalls === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              code: 'WORKLOAD_ADMISSION_UNAVAILABLE',
              status: 503,
              message: 'Cloud storage is temporarily unavailable',
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ id: 'dep-after-retry' }),
        };
      });

      const p = createWorkload(minimalRequest());
      await vi.runAllTimersAsync();
      await expect(p).resolves.toEqual({ id: 'dep-after-retry' });
      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits one second between not-processed retries', async () => {
    vi.useFakeTimers();
    try {
      let newCalls = 0;
      fetchMock.mockImplementation(async (_url) => {
        newCalls += 1;
        if (newCalls === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              code: 'WORKLOAD_ADMISSION_UNAVAILABLE',
              status: 503,
              message: 'Cloud storage is temporarily unavailable',
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ id: 'dep-after-backoff' }),
        };
      });

      const response = createWorkload(minimalRequest());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(response).resolves.toEqual({ id: 'dep-after-backoff' });
      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry an undefined proxy 503', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async (_url) => ({
        ok: false,
        status: 503,
        text: async () => 'upstream unavailable',
      }));

      const assertion = expect(
        createWorkload(minimalRequest()),
      ).rejects.toMatchObject({ status: 503, defined: false });
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trust an undeclared proxy error marked as defined', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async (_url) => ({
        ok: false,
        status: 503,
        json: async () => ({
          code: 'UPSTREAM_PROXY_UNAVAILABLE',
          status: 503,
          message: 'upstream unavailable',
        }),
      }));

      const assertion = expect(
        createWorkload(minimalRequest()),
      ).rejects.toMatchObject({
        code: 'UPSTREAM_PROXY_UNAVAILABLE',
        status: 503,
        defined: true,
      });
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry on a 500 (the server may have processed it)', async () => {
    fetchMock.mockImplementation(async (_url) => {
      return {
        ok: false,
        status: 500,
        text: async () => 'boom',
      };
    });
    await expect(createWorkload(minimalRequest())).rejects.toBeInstanceOf(
      ORPCError,
    );
    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);
  });

  it('should send workloadType in payload', async () => {
    // Arrange
    const image = 'nginx:alpine';
    const cloudConfig: WorkloadAdmissionCloudConfig = {
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't2.micro',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
    };
    const accessToken = 'github-token';
    const workloadType = 'job';

    // Act
    const response = await createWorkload({
      image,
      cloudConfig,
      accessToken,
      workloadType,
    });

    // Assert
    const callArgs = fetchCallFor(fetchMock, '/v1/workloads');
    const requestBody = JSON.parse(callArgs[1].body);

    // Verify workloadType is included
    expect(requestBody.workloadType).toBe('job');
    expect(requestBody.cloudConfig).toBeDefined();
    expect(requestBody.cloudConfig.cloudProvider).toBe('AWS');

    // Verify response
    expect(response.id).toBe('test-workload-123');
  });

  it('should send correct payload structure to API', async () => {
    // Arrange
    const image = 'nginx:alpine';
    const cloudConfig: WorkloadAdmissionCloudConfig = {
      cloudProvider: CloudType.GCP,
      region: 'us-east4-a',
      vmType: 'f1-micro',
      credentials: {
        projectId: 'test-project',
        privateKey: 'test-key',
        clientEmail: 'test@test.com',
      },
    };
    const accessToken = 'github-token';
    const workloadType = 'job';

    // Act
    const response = await createWorkload({
      image,
      cloudConfig,
      accessToken,
      workloadType,
    });

    // Assert
    const callArgs = fetchCallFor(fetchMock, '/v1/workloads');
    const [url, options] = callArgs;

    // Verify URL
    expect(url).toContain('/v1/workloads');

    // Verify request options
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    // Verify payload structure matches what server expects
    const requestBody = JSON.parse(options.body);
    expect(requestBody).toMatchObject({
      image,
      cloudConfig,
    });
    expect(requestBody).not.toHaveProperty('accessToken');

    // Verify response
    expect(response.id).toBe('test-workload-123');
  });

  it('should send named credential requests without cloudProvider', async () => {
    await createWorkload({
      image: 'nginx:alpine',
      cloudConfig: {
        region: 'us-central1',
        vmType: 'e2-standard-2',
        spot: true,
        inputBucket: 'input-bucket',
        outputBucket: 'output-bucket',
        diskSizeGb: 100,
        availabilityZone: 'a',
      },
      credentialName: 'gcp-test',
      accessToken: 'github-token',
      workloadType: 'job',
    });

    const callArgs = fetchCallFor(fetchMock, '/v1/workloads');
    const requestBody = JSON.parse(callArgs[1].body);

    expect(requestBody.credentialName).toBe('gcp-test');
    expect(requestBody.cloudConfig).toEqual({
      region: 'us-central1',
      vmType: 'e2-standard-2',
      spot: true,
      inputBucket: 'input-bucket',
      outputBucket: 'output-bucket',
      diskSizeGb: 100,
      availabilityZone: 'a',
    });
    expect(requestBody.cloudConfig).not.toHaveProperty('cloudProvider');
    expect(requestBody.cloudConfig).not.toHaveProperty('credentials');
  });
});

describe('API Client - node pools', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses bearer-authenticated create, list, get, and delete endpoints', async () => {
    const response = {
      nodePool: {
        id: 'training-a1b2',
        name: 'training',
        clusterId: 'cluster-a',
        state: 'provisioning',
        releasing: false,
        cloudProvider: 'aws',
        region: 'us-east-1',
        zone: null,
        vmType: 't3.large',
        minVmCount: 2,
        maxVmCount: 2,
        capacity: {
          readyVmCount: 0,
          startingVmCount: 0,
          drainingVmCount: 0,
          locations: [],
        },
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const fetchMock = vi.fn<FetchMockCall>().mockImplementation(async () => ({
      ok: true,
      json: async () => response,
    }));
    const client = createApiClient('token', {
      fetch: adaptFetchMock(fetchMock),
      retryDelayMs: 0,
    });
    const request = {
      name: 'training',
      credentialName: 'compute',
      region: 'us-east-1',
      vmTypes: ['t3.large'],
      minVmCount: 2,
      maxVmCount: 2,
    };

    await expect(client.nodePools.create(request)).resolves.toEqual(response);
    await client.nodePools.list();
    await client.nodePools.get({ params: { id: 'training/name' } });
    await client.nodePools.delete({
      params: { id: 'training/name' },
    });

    const calls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/v1/node-pools'),
    );
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual(request);
    expect(calls[1]?.[1]?.method).toBe('GET');
    expect(String(calls[2]?.[0])).toContain('/training%2Fname');
    expect(calls[3]?.[1]?.method).toBe('DELETE');
  });

  it('does not retry node pool creation after an ambiguous transport failure', async () => {
    let createAttempts = 0;
    const fetchMock = vi.fn<FetchMockCall>().mockImplementation(async () => {
      createAttempts += 1;
      throw new Error('response lost');
    });
    const client = createApiClient('token', {
      fetch: adaptFetchMock(fetchMock),
      retryDelayMs: 0,
    });

    await expect(
      client.nodePools.create({
        name: 'training',
        credentialName: 'compute',
        region: 'us-east-1',
        vmTypes: ['t3.large'],
        minVmCount: 1,
        maxVmCount: 1,
      }),
    ).rejects.toThrow('response lost');
    expect(createAttempts).toBe(1);
  });
});

describe('API Client - credentials', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws a typed oRPC error with status for credential HTTP failures', async () => {
    global.fetch = adaptFetchMock(
      vi.fn().mockImplementation(async (_url) => {
        return {
          ok: false,
          status: 404,
          json: async () => ({
            code: 'CREDENTIAL_NOT_FOUND',
            status: 404,
            message: 'Credential "missing" not found',
            data: { name: 'missing' },
          }),
        };
      }),
    );

    await expect(getApiCredential('token', 'missing')).rejects.toMatchObject({
      status: 404,
      message: 'Credential "missing" not found',
    });
  });

  it('submits a create-only credential mutation once on a definitive rejection', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async (_url) => {
        return {
          ok: false,
          status: 409,
          text: async () => 'Credential already exists',
        };
      });
    global.fetch = adaptFetchMock(fetchMock);

    try {
      const save = saveApiCredential(
        'token',
        'new-name',
        {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIAONCE',
          secretAccessKey: 'secret-once',
        },
        { overwrite: false },
      );
      const assertion = expect(save).rejects.toMatchObject({
        status: 409,
      });
      await vi.runAllTimersAsync();
      await assertion;

      expect(
        fetchCallCountFor(
          fetchMock,
          '/v1/credentials/new-name?overwrite=false',
        ),
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an idempotent credential delete after a lost response', async () => {
    let attempts = 0;
    const fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async (_url) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return { ok: true, status: 204 };
      });
    global.fetch = adaptFetchMock(fetchMock);

    await expect(deleteApiCredential('token', 'prod')).resolves.toBeUndefined();
    expect(fetchCallCountFor(fetchMock, '/v1/credentials/prod')).toBe(2);
  });
});

describe('API Client - hosted API access', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses bearer-authenticated list, grant, and revoke endpoints', async () => {
    const access = {
      owner: { userId: '1', username: 'owner' },
      users: [{ userId: '2', username: 'member' }],
    };
    const fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async (url, init) => {
        if (init?.method === 'GET') {
          return { ok: true, json: async () => access };
        }
        if (init?.method === 'DELETE') {
          return { ok: true, status: 204 };
        }
        return { ok: true, json: async () => access.users[0] };
      });
    global.fetch = adaptFetchMock(fetchMock);

    await expect(listApiAccessUsers('owner-token')).resolves.toEqual(access);
    await expect(grantApiAccessUser('owner-token', 'Member')).resolves.toEqual(
      access.users[0],
    );
    await expect(
      revokeApiAccessUser('owner-token', '2'),
    ).resolves.toBeUndefined();

    const endpointCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/v1/api-access/users'),
    );
    expect(endpointCalls).toHaveLength(3);
    for (const [, init] of endpointCalls) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer owner-token',
      });
    }
    expect(JSON.parse(String(endpointCalls[1][1]?.body))).toEqual({
      username: 'Member',
    });
    expect(String(endpointCalls[2][0])).toContain('/v1/api-access/users/2');
    expect(endpointCalls[2][1]?.method).toBe('DELETE');
  });

  it('reconciles a lost revoke response as an idempotent success', async () => {
    // The first DELETE is processed but never answered, so every retry finds
    // the entry gone. Surfacing that 404 would report a revocation that did
    // happen as a failure.
    let deleteAttempts = 0;
    const fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async (_url) => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error('fetch failed');
        return {
          ok: true,
          status: 204,
        };
      });
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      revokeApiAccessUser('owner-token', '2'),
    ).resolves.toBeUndefined();
    expect(deleteAttempts).toBe(2);
  });

  it('still surfaces a non-404 revoke failure', async () => {
    const fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async (_url) => {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            code: 'API_ACCESS_OWNER_CANNOT_BE_REMOVED',
            status: 400,
            message: 'The hosted API owner cannot be removed',
          }),
        };
      });
    global.fetch = adaptFetchMock(fetchMock);

    await expect(revokeApiAccessUser('owner-token', '1')).rejects.toThrow(
      'The hosted API owner cannot be removed',
    );
  });
});

describe('API Client - Retry Logic', () => {
  let fetchMock: Mock<FetchMockCall>;
  let originalFetch: typeof global.fetch;
  let originalIsTest: string | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalIsTest = process.env.IS_TEST;
    setPreFlightCheck(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalIsTest === undefined) delete process.env.IS_TEST;
    else process.env.IS_TEST = originalIsTest;
    setPreFlightCheck(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('gets exact costs from the workload resource', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return { ok: true, json: async () => [] };
    });
    global.fetch = adaptFetchMock(fetchMock);

    const promise = getWorkloadCosts({
      accessToken: 'test-token',
      id: 'historical-workload',
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);

    const [, init] = fetchCallFor(
      fetchMock,
      '/v1/workloads/historical-workload/cost',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(fetchCallCountFor(fetchMock, '/v1/workloads?')).toBe(0);
  });

  it('gets aggregate costs from the report resource', async () => {
    const report = {
      periodMs: 86_400_000,
      totalCost: 0,
      totalDurationMs: 0,
      totalJobs: 0,
      totalServices: 0,
      totalVms: 0,
      workloadsWithoutPrice: 0,
      byProvider: {},
      byAgent: {},
      byUser: {},
    };
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return { ok: true, json: async () => report };
    });
    global.fetch = adaptFetchMock(fetchMock);

    const promise = getCostReport({
      accessToken: 'test-token',
      sinceMs: 1234,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual(report);

    const [url, init] = fetchCallFor(fetchMock, '/v1/workload-costs');
    expect(init?.method).toBe('GET');
    expect(String(url)).toContain('sinceMs=1234');
    expect(fetchCallCountFor(fetchMock, '/v1/workloads?')).toBe(0);
  });

  it('reads the authoritative object-size header for streamed downloads', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return new Response(Buffer.from('payload'), {
        headers: {
          'Content-Length': '999',
          'X-Anycloud-Object-Size': '7',
        },
      });
    });
    global.fetch = adaptFetchMock(fetchMock);

    const { stream, contentLength } = await downloadBucketObject('token', {
      credentialName: 'prod',
      bucketName: 'bucket',
      remotePath: 'object',
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }

    expect(contentLength).toBe(7);
    expect(Buffer.concat(chunks).toString()).toBe('payload');
  });

  it('rejects a malformed streamed-download object size', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return new Response(Buffer.from('payload'), {
        headers: { 'X-Anycloud-Object-Size': 'not-a-size' },
      });
    });
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      downloadBucketObject('token', {
        credentialName: 'prod',
        bucketName: 'bucket',
        remotePath: 'object',
      }),
    ).rejects.toThrow(/Invalid object size/);
  });

  it('uses the provider-backed bucket timeout for JSON object deletion', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutSignal);
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      createApiClient('test-token').bucket.deleteObject({
        params: { credentialName: 'prod', bucketName: 'bucket' },
        query: { remotePath: 'slow-object' },
      }),
    ).resolves.toBeUndefined();

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(
      fetchCallCountFor(
        fetchMock,
        '/v1/credentials/prod/buckets/bucket/objects',
      ),
    ).toBe(1);
  });

  it('should retry listWorkloads on network error', async () => {
    let listCalls = 0;
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      listCalls += 1;
      if (listCalls <= 2) throw new TypeError('fetch failed');
      return {
        ok: true,
        json: async () => [],
      };
    });

    global.fetch = adaptFetchMock(fetchMock);

    // Start the request (don't await yet)
    const promise = listWorkloads({
      accessToken: 'test-token',
    });

    // Fast-forward through retries (5s timeout + 500ms backoff each)
    await vi.advanceTimersByTimeAsync(5000); // First timeout
    await vi.advanceTimersByTimeAsync(500); // First backoff
    await vi.advanceTimersByTimeAsync(5000); // Second timeout
    await vi.advanceTimersByTimeAsync(500); // Second backoff

    const result = await promise;

    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(3);
    expect(result).toEqual([]);
  });

  it('explains a malformed server error during an API update', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(
      async () =>
        new Response('<!doctype html><title>Cloudflare error 1016</title>', {
          status: 530,
          headers: {
            'Content-Type': 'text/html',
            'CF-Ray': 'ray-530',
          },
        }),
    );
    global.fetch = adaptFetchMock(fetchMock);

    const result = listWorkloads({ accessToken: 'test-token' }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 530,
      defined: false,
      message:
        'The API is temporarily unavailable (HTTP 530). It may be restarting or updating; try again shortly.',
      data: {
        body: '<!doctype html><title>Cloudflare error 1016</title>',
        headers: { 'cf-ray': 'ray-530' },
      },
    });
    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(3);
  });

  it.each([
    [
      'invalid JSON advertised as JSON',
      'x'.repeat(5_000),
      { 'Content-Type': 'application/json' },
    ],
    ['an empty body', null, undefined],
  ])('explains a server 5xx with %s', async (_label, body, headers) => {
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(
        async () => new Response(body, { status: 502, headers }),
      );
    global.fetch = adaptFetchMock(fetchMock);

    const result = listWorkloads({ accessToken: 'test-token' }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 502,
      defined: false,
      message:
        'The API is temporarily unavailable (HTTP 502). It may be restarting or updating; try again shortly.',
    });
    // An edge 5xx is a restart: about two minutes of backoff.
    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(27);
  });

  it('preserves a valid oRPC error with the wrong content type', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            defined: true,
            code: 'AUTHENTICATION_UNAVAILABLE',
            status: 503,
            message: 'Authentication is temporarily unavailable',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          },
        ),
    );
    global.fetch = adaptFetchMock(fetchMock);

    const result = createApiClient('test-token')
      .quota.status({
        query: { cloud: CloudType.AWS, credentialName: 'aws-prod' },
      })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      code: 'AUTHENTICATION_UNAVAILABLE',
      status: 503,
      defined: true,
      message: 'Authentication is temporarily unavailable',
    });
    expect(fetchCallCountFor(fetchMock, '/v1/quota/status')).toBe(1);
  });

  it('uses retry guidance without retrying a no-retry read', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(
      async () =>
        new Response('<html><title>upstream unavailable</title></html>', {
          status: 530,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    global.fetch = adaptFetchMock(fetchMock);

    const result = createApiClient('test-token')
      .quota.status({
        query: { cloud: CloudType.AWS, credentialName: 'aws-prod' },
      })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 530,
      defined: false,
      message:
        'The API is temporarily unavailable (HTTP 530). It may be restarting or updating; try again shortly.',
    });
    expect(fetchCallCountFor(fetchMock, '/v1/quota/status')).toBe(1);
  });

  it('does not suggest blindly retrying a malformed mutation response', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(
      async () =>
        new Response('<html><title>upstream unavailable</title></html>', {
          status: 530,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    global.fetch = adaptFetchMock(fetchMock);

    const result = grantApiAccessUser('test-token', 'octocat').catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 530,
      defined: false,
      message:
        'The API is temporarily unavailable (HTTP 530). It may be restarting or updating. Check whether the operation completed before retrying.',
    });
    expect(fetchCallCountFor(fetchMock, '/v1/api-access/users')).toBe(1);
  });

  it('does not retry an explicitly aborted JSON request', async () => {
    vi.useRealTimers();
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation((_url, options?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const rejectAborted = () =>
            reject(
              options?.signal?.reason ??
                new DOMException('The operation was aborted', 'AbortError'),
            );
          if (options?.signal?.aborted) {
            rejectAborted();
            return;
          }
          options?.signal?.addEventListener('abort', rejectAborted, {
            once: true,
          });
        });
      });
    global.fetch = adaptFetchMock(fetchMock);

    const controller = new AbortController();
    const request = createApiClient('test-token', {
      requestTimeoutMs: null,
      retryDelayMs: 0,
    }).workloads.list({ query: {} }, { signal: controller.signal });
    const assertion = expect(request).rejects.toThrow('JSON request cancelled');

    await vi.waitFor(() =>
      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1),
    );
    controller.abort(new DOMException('JSON request cancelled', 'AbortError'));

    await assertion;
    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);
  });

  it('preserves a caller abort while reading a 5xx response body', async () => {
    vi.useRealTimers();
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async (_url, options?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            const rejectAborted = () =>
              controller.error(
                options?.signal?.reason ??
                  new DOMException('The operation was aborted', 'AbortError'),
              );
            if (options?.signal?.aborted) {
              rejectAborted();
              return;
            }
            options?.signal?.addEventListener('abort', rejectAborted, {
              once: true,
            });
          },
        });
        return new Response(body, {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      });
    global.fetch = adaptFetchMock(fetchMock);

    const controller = new AbortController();
    const abortReason = new DOMException(
      'JSON response cancelled',
      'AbortError',
    );
    const request = createApiClient('test-token', {
      requestTimeoutMs: null,
      retryDelayMs: 0,
    }).workloads.list({ query: {} }, { signal: controller.signal });
    const assertion = expect(request).rejects.toBe(abortReason);

    await vi.waitFor(() =>
      expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1),
    );
    controller.abort(abortReason);

    await assertion;
    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);
  });

  it('should retry getWorkloadStatus on timeout', async () => {
    vi.useRealTimers();
    // First call hangs and gets aborted via AbortSignal; second succeeds.
    // The mock must honor the signal — real fetch cancels itself when aborted,
    // but a plain Promise mock ignores it and would hang forever.
    let statusCalls = 0;
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation((_url: string, options?: RequestInit) => {
        statusCalls += 1;
        if (statusCalls > 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ status: 'up', events: [] }),
          });
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ ok: true }), 10000);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      });

    global.fetch = adaptFetchMock(fetchMock);

    const result = await getWorkloadStatus(
      {
        id: 'test-id',
        accessToken: 'test-token',
      },
      1,
    );

    expect(fetchCallCountFor(fetchMock, '/v1/workloads/test-id')).toBe(2);
    expect(result.status).toBe('up');
  });

  it('submits quota status once on a 503', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async () => ({
      ok: false,
      status: 503,
      text: async () => 'quota providers unavailable',
    }));
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      createApiClient('test-token').quota.status({
        query: { cloud: CloudType.AWS, credentialName: 'aws-prod' },
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(fetchCallCountFor(fetchMock, '/v1/quota/status')).toBe(1);
  });

  it('submits quota status once when its request times out', async () => {
    vi.useRealTimers();
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation((_url, options?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      });
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      createApiClient('test-token', { requestTimeoutMs: 1 }).quota.status({
        query: { cloud: CloudType.AWS, credentialName: 'aws-prod' },
      }),
    ).rejects.toThrow();

    expect(fetchCallCountFor(fetchMock, '/v1/quota/status')).toBe(1);
  });

  it('reads the quota status timeout override with the legacy fallback', () => {
    expect(quotaStatusTimeoutMs({ QUOTA_STATUS_TIMEOUT_MS: '4321.9' })).toBe(
      4321,
    );
    expect(quotaStatusTimeoutMs({ QUOTA_STATUS_TIMEOUT_MS: 'invalid' })).toBe(
      120_000,
    );
  });

  it.each([
    ['3000', 5_000],
    ['120000', 122_000],
  ])(
    'derives the quota status timeout from waitMs=%s',
    async (waitMs, expectedTimeoutMs) => {
      const timeoutSignal = new AbortController().signal;
      const timeoutSpy = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(timeoutSignal);
      fetchMock = vi.fn<FetchMockCall>().mockResolvedValue({
        ok: true,
        json: async () => ({ entries: [] }),
      });
      global.fetch = adaptFetchMock(fetchMock);

      await expect(
        createApiClient('test-token').quota.status({
          query: {
            cloud: CloudType.AWS,
            credentialName: 'aws-prod',
            waitMs,
          },
        }),
      ).resolves.toEqual({ entries: [] });

      expect(timeoutSpy).toHaveBeenCalledWith(expectedTimeoutMs);
    },
  );

  it('streams executeWorkloadCommand output and returns the exit code', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: 'stdout',
              data: Buffer.from('out\n').toString('base64'),
            })}\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: 'stderr',
              data: Buffer.from('bad\n').toString('base64'),
            })}\n${JSON.stringify({ type: 'exit', code: 7 })}\n`,
          ),
        );
        controller.close();
      },
    });
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return {
        ok: true,
        body,
      };
    });

    global.fetch = adaptFetchMock(fetchMock);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const code = await executeWorkloadCommand(
      'test-token',
      {
        id: 'test-id',
        command: 'echo ok',
      },
      {
        stdout: (chunk) => {
          stdout.push(chunk);
        },
        stderr: (chunk) => {
          stderr.push(chunk);
        },
      },
    );

    expect(fetchCallCountFor(fetchMock, '/v1/workloads/test-id/exec')).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/v1/workloads/test-id/exec',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/x-ndjson',
          [ANYCLOUD_CLIENT_VERSION_HEADER]: pkg.version,
        }),
      }),
    );
    expect(Buffer.concat(stdout).toString()).toBe('out\n');
    expect(Buffer.concat(stderr).toString()).toBe('bad\n');
    expect(code).toBe(7);
  });

  it('parses executeWorkloadCommand events split across response chunks', async () => {
    const encoder = new TextEncoder();
    const payload =
      `${JSON.stringify({
        type: 'stdout',
        data: Buffer.from('split\n').toString('base64'),
      })}\n` + `${JSON.stringify({ type: 'exit', code: 0 })}\n`;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 9)));
        controller.enqueue(encoder.encode(payload.slice(9, 31)));
        controller.enqueue(encoder.encode(payload.slice(31)));
        controller.close();
      },
    });
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return {
        ok: true,
        body,
      };
    });
    global.fetch = adaptFetchMock(fetchMock);

    const stdout: Buffer[] = [];
    const code = await executeWorkloadCommand(
      'test-token',
      {
        id: 'test-id',
        command: 'echo ok',
      },
      {
        stdout: (chunk) => {
          stdout.push(chunk);
        },
      },
    );

    expect(Buffer.concat(stdout).toString()).toBe('split\n');
    expect(code).toBe(0);
  });

  it('runs the localhost pre-flight check before executeWorkloadCommand fetches', async () => {
    process.env.IS_TEST = 'false';
    setPreFlightCheck(() => ({
      running: false,
      hostPort: null,
      failure: 'missing',
    }));
    fetchMock = vi.fn<FetchMockCall>();
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      executeWorkloadCommand('test-token', {
        id: 'test-id',
        command: 'echo ok',
      }),
    ).rejects.toThrow('No local API is running');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry executeWorkloadCommand', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      throw new TypeError('fetch failed');
    });

    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      executeWorkloadCommand('test-token', {
        id: 'test-id',
        command: 'echo ok',
      }),
    ).rejects.toThrow('fetch failed');

    expect(fetchCallCountFor(fetchMock, '/v1/workloads/test-id/exec')).toBe(1);
  });

  it('uses outcome guidance for malformed native write responses', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(
      async () =>
        new Response('<html><title>upstream unavailable</title></html>', {
          status: 530,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    global.fetch = adaptFetchMock(fetchMock);
    const expected =
      'The API is temporarily unavailable (HTTP 530). It may be restarting or updating. Check whether the operation completed before retrying.';

    await expect(
      executeWorkloadCommand('test-token', {
        id: 'test-id',
        command: 'echo ok',
      }),
    ).rejects.toThrow(expected);
    await expect(
      uploadBucketObject('test-token', Readable.from('payload'), 7, {
        credentialName: 'prod',
        bucketName: 'bucket',
        remotePath: 'object',
      }),
    ).rejects.toThrow(expected);
  });

  it('uses retry guidance for malformed native read responses', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(
      async () =>
        new Response('<html><title>upstream unavailable</title></html>', {
          status: 530,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    global.fetch = adaptFetchMock(fetchMock);
    const expected =
      'The API is temporarily unavailable (HTTP 530). It may be restarting or updating; try again shortly.';

    await expect(
      streamWorkloadLogs('test-token', { id: 'test-id' }),
    ).rejects.toThrow(expected);
    await expect(
      downloadBucketObject('test-token', {
        credentialName: 'prod',
        bucketName: 'bucket',
        remotePath: 'object',
      }),
    ).rejects.toThrow(expected);
  });

  it('preserves a structured native 5xx error message', async () => {
    fetchMock = vi
      .fn<FetchMockCall>()
      .mockImplementation(async () =>
        Response.json(
          { message: 'The workload is temporarily locked' },
          { status: 503 },
        ),
      );
    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      executeWorkloadCommand('test-token', {
        id: 'test-id',
        command: 'echo ok',
      }),
    ).rejects.toThrow('The workload is temporarily locked');
  });

  it('aborts an in-flight logs stream with the caller signal', async () => {
    vi.useRealTimers();
    const body = new ReadableStream({
      start() {
        // Deliberately stays open until streamWorkloadLogs is aborted.
      },
    });
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      return { ok: true, body };
    });
    global.fetch = adaptFetchMock(fetchMock);

    const controller = new AbortController();
    const interrupted = new Error('log follow interrupted');
    const logs = streamWorkloadLogs(
      'test-token',
      {
        id: 'test-id',
        follow: true,
      },
      {},
      { signal: controller.signal },
    );

    await vi.waitFor(() =>
      expect(fetchCallCountFor(fetchMock, '/v1/workloads/test-id/logs')).toBe(
        1,
      ),
    );
    const [, requestOptions] = fetchCallFor(
      fetchMock,
      '/v1/workloads/test-id/logs',
    );
    expect(requestOptions.signal).toBe(controller.signal);

    controller.abort(interrupted);

    await expect(logs).rejects.toBe(interrupted);
  });

  it('should retry terminateWorkload on 5xx error', async () => {
    let terminateCalls = 0;
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      terminateCalls += 1;
      if (terminateCalls === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal server error',
        };
      }
      return {
        ok: true,
        json: async () => ({ message: 'Workload termination scheduled' }),
      };
    });

    global.fetch = adaptFetchMock(fetchMock);

    const promise = terminateWorkload({
      id: 'test-id',
      accessToken: 'test-token',
    });

    // Fast-forward through retry backoff (1s timeout + 500ms backoff)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;

    expect(fetchCallCountFor(fetchMock, '/v1/workloads/test-id')).toBe(2);
    expect(result.message).toContain('termination');
  });

  it('should not retry createWorkload on error', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      throw new TypeError('fetch failed');
    });

    global.fetch = adaptFetchMock(fetchMock);

    await expect(
      createWorkload({
        image: 'nginx',
        cloudConfig: {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't2.micro',
          credentials: {
            accessKeyId: 'key',
            secretAccessKey: 'secret',
          },
        },
        accessToken: 'token',
        workloadType: 'job',
      }),
    ).rejects.toThrow('fetch failed');

    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(1);
  });

  it('should fail after max retries exceeded', async () => {
    fetchMock = vi.fn<FetchMockCall>().mockImplementation(async (_url) => {
      throw new TypeError('fetch failed');
    });

    global.fetch = adaptFetchMock(fetchMock);

    const promise = listWorkloads({
      accessToken: 'test-token',
    }).catch((e) => e); // Catch to prevent unhandled rejection

    // Fast-forward through all retries (1s timeout + 500ms backoff × 3 attempts)
    await vi.advanceTimersByTimeAsync(1000); // First timeout
    await vi.advanceTimersByTimeAsync(500); // First backoff
    await vi.advanceTimersByTimeAsync(1000); // Second timeout
    await vi.advanceTimersByTimeAsync(500); // Second backoff
    await vi.advanceTimersByTimeAsync(1000); // Third timeout (final attempt, no backoff after)

    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('fetch failed');

    expect(fetchCallCountFor(fetchMock, '/v1/workloads')).toBe(3);
  });
});
