import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';

const mocks = vi.hoisted(() => ({
  inspectLocalApiContainer: vi.fn(),
}));

vi.mock('../../../src/shared/local-api-container.js', () => ({
  inspectLocalApiContainer: mocks.inspectLocalApiContainer,
  localApiUrlForPort: (port: number) => `http://localhost:${port}`,
}));

const statusRequest = {
  params: { id: 'test-workload' },
  query: {},
};
const accessToken = 'test-token';

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function successfulFetch() {
  return vi.fn().mockResolvedValue(Response.json({ status: 'up', events: [] }));
}

async function loadApiClient() {
  vi.resetModules();
  const [{ createApiClient }, runtime] = await Promise.all([
    import('../../../src/shared/services/api-client/rpc.js'),
    import('../../../src/shared/services/api-client/runtime.js'),
  ]);
  return {
    ...runtime,
    getWorkloadStatus: (request: typeof statusRequest) =>
      createApiClient(accessToken).workloads.status(request),
  };
}

describe('API client request-scoped target resolution', () => {
  let anycloudDir: string;

  beforeEach(() => {
    anycloudDir = mkdtempSync(join(tmpdir(), 'anycloud-api-client-url-'));
    vi.stubEnv('ANYCLOUD_DIR', anycloudDir);
    vi.stubEnv('IS_TEST', 'false');
    delete process.env.API_URL;
    vi.clearAllMocks();
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    rmSync(anycloudDir, { recursive: true, force: true });
  });

  it('uses one Docker inspection and one dynamic URL for a complete status request', async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    const preFlightCheck = vi.fn(() => ({
      running: true,
      hostPort: 8787,
    }));
    const { getWorkloadStatus, setPreFlightCheck } = await loadApiClient();
    setPreFlightCheck(preFlightCheck);

    await getWorkloadStatus(statusRequest);

    expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    expect(preFlightCheck).not.toHaveBeenCalled();
    const requestedUrls = fetchMock.mock.calls.map(([input]) =>
      requestUrl(input),
    );
    expect(requestedUrls).toEqual([
      'http://localhost:8787/v1/workloads/test-workload',
    ]);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(
      (request as Request).headers.get(ANYCLOUD_CLIENT_VERSION_HEADER),
    ).toBe(pkg.version);
    expect(requestedUrls.some((url) => url.includes(':8080'))).toBe(false);
  });

  it.each([
    {
      label: 'missing container',
      inspection: {
        running: false,
        hostPort: null,
        failure: 'missing' as const,
      },
      message: 'No local API is running',
    },
    {
      label: 'stopped container',
      inspection: { running: false, hostPort: 8787 },
      message: 'No local API is running',
    },
    {
      label: 'Docker timeout',
      inspection: {
        running: false,
        hostPort: null,
        failure: 'timeout' as const,
      },
      message:
        'Timed out checking the local API container. Check that Docker is responsive.',
    },
    {
      label: 'unavailable Docker daemon',
      inspection: {
        running: false,
        hostPort: null,
        failure: 'unavailable' as const,
      },
      message: 'Docker is unavailable. Start Docker and try again.',
    },
    {
      label: 'malformed Docker response',
      inspection: {
        running: false,
        hostPort: null,
        failure: 'malformed' as const,
      },
      message:
        'Docker returned an invalid response while checking the local API container.',
    },
  ])(
    'reuses a $label inspection for preflight and never fetches',
    async ({ inspection, message }) => {
      mocks.inspectLocalApiContainer.mockReturnValue(inspection);
      const fetchMock = successfulFetch();
      vi.stubGlobal('fetch', fetchMock);
      const preFlightCheck = vi.fn(() => ({
        running: true,
        hostPort: 8787,
      }));
      const { getWorkloadStatus, setPreFlightCheck } = await loadApiClient();
      setPreFlightCheck(preFlightCheck);

      await expect(getWorkloadStatus(statusRequest)).rejects.toThrow(message);

      expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
      expect(preFlightCheck).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('inspects once to preflight an explicitly configured localhost URL', async () => {
    vi.stubEnv('API_URL', 'http://127.0.0.1:9090');
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: false,
      hostPort: null,
      failure: 'missing',
    });
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    const preFlightCheck = vi.fn(() => mocks.inspectLocalApiContainer());
    const { getWorkloadStatus, setPreFlightCheck } = await loadApiClient();
    setPreFlightCheck(preFlightCheck);

    await expect(getWorkloadStatus(statusRequest)).rejects.toThrow(
      'No local API is running',
    );

    expect(preFlightCheck).toHaveBeenCalledTimes(1);
    expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not inspect Docker for a remote API URL', async () => {
    vi.stubEnv('API_URL', 'https://api.example.test');
    const fetchMock = successfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    const preFlightCheck = vi.fn(() => mocks.inspectLocalApiContainer());
    const { getWorkloadStatus, setPreFlightCheck } = await loadApiClient();
    setPreFlightCheck(preFlightCheck);

    await getWorkloadStatus(statusRequest);

    expect(preFlightCheck).not.toHaveBeenCalled();
    expect(mocks.inspectLocalApiContainer).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toContain(
      'https://api.example.test/v1/workloads/test-workload',
    );
  });

  it('keeps one resolved dynamic URL across request retries', async () => {
    let statusCalls = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_input: string | URL | Request) => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error('fetch failed');
        return Response.json({ status: 'up', events: [] });
      });
    vi.stubGlobal('fetch', fetchMock);
    const { getWorkloadStatus, setPreFlightCheck } = await loadApiClient();
    setPreFlightCheck(() => ({ running: true, hostPort: 8787 }));

    await getWorkloadStatus(statusRequest);

    expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    expect(statusCalls).toBe(2);
    expect(
      fetchMock.mock.calls.every(([url]) =>
        requestUrl(url).startsWith('http://localhost:8787/'),
      ),
    ).toBe(true);
  });
});

describe('the local API pre-flight', () => {
  // The same loopback rule the client uses to choose its bearer.
  it.each([
    ['http://[::1]:8080', true],
    ['https://localhost.example.com', false],
  ])('checks Docker for %s: %s', async (url, checked) => {
    vi.resetModules();
    vi.stubEnv('IS_TEST', '');
    const { assertLocalApiRunning, setPreFlightCheck } = await import(
      '../../../src/shared/services/api-client/runtime.js'
    );
    const check = vi.fn(() => ({ running: false, hostPort: null }));
    setPreFlightCheck(check);
    try {
      if (checked)
        expect(() => assertLocalApiRunning({ url })).toThrow(
          'No local API is running',
        );
      else assertLocalApiRunning({ url });
      expect(check).toHaveBeenCalledTimes(checked ? 1 : 0);
    } finally {
      setPreFlightCheck(null);
      vi.unstubAllEnvs();
    }
  });
});
