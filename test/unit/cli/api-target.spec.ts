import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  anycloudDir: '',
}));

const mocks = vi.hoisted(() => ({
  assertLocalApiRunning: vi.fn(),
  checkApiVersion: vi.fn(),
  isJsonMode: vi.fn(() => false),
  printSuccess: vi.fn(),
  printWarning: vi.fn(),
  safePrompts: vi.fn(),
  inspectLocalApiContainer: vi.fn(),
}));

vi.mock('../../../src/shared/utils.js', () => ({
  getAnycloudDir: () => state.anycloudDir,
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  isJsonMode: mocks.isJsonMode,
  printSuccess: mocks.printSuccess,
  printWarning: mocks.printWarning,
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: mocks.safePrompts,
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  assertLocalApiRunning: mocks.assertLocalApiRunning,
  checkApiVersion: mocks.checkApiVersion,
  getAnycloudVersion: () => '0.1.34',
}));

vi.mock('../../../src/shared/local-api-container.js', () => ({
  inspectLocalApiContainer: mocks.inspectLocalApiContainer,
  localApiUrlForPort: (port: number) => `http://localhost:${port}`,
}));

function hostedApiWorkload(id = 'api-1') {
  return {
    id,
    workloadType: 'service',
    image: 'ghcr.io/anycloud-sh/api:0.1.34',
    state: 'running',
    cloudProvider: 'AWS',
    region: 'us-east-1',
    vmType: 't3.small',
    gpuType: null,
    version: '0.1.34',
  };
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function requestHeaders(
  input: string | URL | Request,
  init?: RequestInit,
): Headers {
  return input instanceof Request ? input.headers : new Headers(init?.headers);
}

async function loadApiTarget() {
  return await import('../../../src/cli/services/api-target.js');
}

describe('api target discovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const LOCAL_API_TOKEN = 'c'.repeat(64);
  let statusAuthorizations: Array<string | null>;

  beforeEach(() => {
    state.anycloudDir = mkdtempSync(join(tmpdir(), 'anycloud-api-target-'));
    // The legacy-Service lookup reads the local API with its own token.
    writeFileSync(join(state.anycloudDir, 'local-api-token'), LOCAL_API_TOKEN);
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.API_URL;
    statusAuthorizations = [];
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: false,
      hostPort: null,
      failure: 'missing',
    });
    mocks.checkApiVersion.mockImplementation(async (url: string) => ({
      url,
      cliVersion: '0.1.34',
      apiVersion: url.includes('api-old') ? '0.1.33' : '0.1.34',
      compatible: !url.includes('api-old'),
      reason: url.includes('api-old') ? 'API version is 0.1.33' : undefined,
    }));
    fetchMock = vi
      .fn()
      .mockImplementation(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = requestUrl(input);
          if (url.endsWith('/health')) {
            return new Response(null, { status: 200 });
          }
          if (url.endsWith('/v1/workloads/api-1')) {
            statusAuthorizations.push(
              requestHeaders(input, init).get('Authorization'),
            );
            return Response.json({ workload: hostedApiWorkload('api-1') });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
      );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(state.anycloudDir, { recursive: true, force: true });
    delete process.env.API_URL;
  });

  it('lists the local API only; VM-hosted Services are no longer targets and are not read while local is active', async () => {
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(discovery.warnings).toEqual([]);
    expect(discovery.targets.map((target) => target.id)).toEqual(['local']);
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      current: true,
      kind: 'local',
      health: 'healthy',
      compatible: true,
    });
    expect(statusAuthorizations).toEqual([]);
  });

  it('reads the local API in lockstep when the active remote must be checked against its Services', async () => {
    process.env.API_URL = 'https://api-1.anycloud.sh';
    const { discoverApiTargetRows } = await loadApiTarget();
    mocks.checkApiVersion.mockImplementation(async (url: string) => ({
      url,
      cliVersion: '0.1.34',
      apiVersion: url.includes('localhost') ? '0.1.33' : '0.1.34',
      compatible: !url.includes('localhost'),
      reason: url.includes('localhost') ? 'API version is 0.1.33' : undefined,
    }));

    const discovery = await discoverApiTargetRows();

    expect(statusAuthorizations[0]).toBe(`Bearer ${LOCAL_API_TOKEN}`);
    const statusCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith('/v1/workloads/api-1'),
    );
    expect(statusCall).toBeDefined();
    const [statusInput, statusInit] = statusCall!;
    const statusHeaders =
      statusInput instanceof Request
        ? statusInput.headers
        : new Headers(statusInit?.headers);
    expect(statusHeaders.get('AnyCloud-Client-Version')).toBe('0.1.34');
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      compatible: false,
      apiVersion: '0.1.33',
    });
    expect(
      discovery.targets.find(
        (target) => target.url === 'https://api-1.anycloud.sh',
      ),
    ).toMatchObject({ kind: 'manual', compatible: true });
  });

  it('uses the running local API container port for the default local target', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(discovery.activeUrl).toBe('http://localhost:8787');
    expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      current: true,
      kind: 'local',
      url: 'http://localhost:8787',
      health: 'healthy',
      source: 'default',
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).includes(':8080'),
      ),
    ).toBe(false);
    // Local is the active target: there is no remote to check against its Services.
    expect(statusAuthorizations).toEqual([]);
  });

  it('discovers the local manager independently when API_URL is set', async () => {
    process.env.API_URL = 'http://localhost:9090';
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    expect(discovery.activeUrl).toBe('http://localhost:9090');
    expect(discovery.targets[0]).toMatchObject({
      kind: 'manual',
      url: 'http://localhost:9090',
      current: true,
      source: 'env',
    });
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      url: 'http://localhost:8787',
      current: false,
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).startsWith(
          'http://localhost:8787/v1/workloads/api-1',
        ),
      ),
    ).toBe(false);
  });

  it('discovers the local manager independently when an api-url file is set', async () => {
    writeFileSync(
      join(state.anycloudDir, 'api-url'),
      'http://localhost:9091\n',
    );
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(mocks.inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    expect(discovery.activeUrl).toBe('http://localhost:9091');
    expect(discovery.targets[0]).toMatchObject({
      kind: 'manual',
      url: 'http://localhost:9091',
      current: true,
      source: 'file',
    });
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      url: 'http://localhost:8787',
      current: false,
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).startsWith(
          'http://localhost:8787/v1/workloads/api-1',
        ),
      ),
    ).toBe(false);
  });

  it('names an active VM-hosted API for what it is, with the migration to cluster create', async () => {
    process.env.API_URL = 'https://api-1.anycloud.sh';
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    const { discoverApiTargetRows, activeVmHostedApi } = await loadApiTarget();

    await expect(activeVmHostedApi()).resolves.toEqual({
      id: 'api-1',
      url: 'https://api-1.anycloud.sh',
      installerUrl: 'http://localhost:8787',
    });
    const discovery = await discoverApiTargetRows();

    expect(
      discovery.targets.find(
        (target) => target.url === 'https://api-1.anycloud.sh',
      ),
    ).toMatchObject({ current: true, kind: 'manual' });
    expect(discovery.warnings).toEqual([
      expect.stringContaining(
        'https://api-1.anycloud.sh is a VM-hosted API (the removed anycloud api serve)',
      ),
    ]);
    expect(discovery.warnings[0]).toContain('anycloud cluster create');
    expect(discovery.warnings[0]).toContain('anycloud terminate api-1');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).startsWith(
          'http://localhost:8787/v1/workloads/api-1',
        ),
      ),
    ).toBe(true);
  });

  it("an active remote that is not one of the local API's Services gets no migration note", async () => {
    process.env.API_URL = 'https://elsewhere.example.com';
    const { discoverApiTargetRows, activeVmHostedApi } = await loadApiTarget();

    await expect(activeVmHostedApi()).resolves.toBeNull();
    const discovery = await discoverApiTargetRows();
    expect(discovery.warnings).toEqual([]);
    expect(discovery.targets.map((target) => target.kind)).toEqual([
      'manual',
      'local',
    ]);
  });

  it('treats a missing legacy Service as a cluster or unrelated target, without listing workloads', async () => {
    process.env.API_URL = 'https://api-1.anycloud.sh';
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/v1/workloads/api-1'))
        return Response.json(
          { code: 'NOT_FOUND', message: 'Workload not found' },
          { status: 404 },
        );
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { activeVmHostedApi } = await loadApiTarget();
    await expect(activeVmHostedApi()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to localhost:8080 when Docker discovery fails', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: false,
      hostPort: null,
      failure: 'unavailable',
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(discovery.activeUrl).toBe('http://localhost:8080');
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      current: true,
      url: 'http://localhost:8080',
    });
  });

  it('warns that no local API is running when the implicit default is unreachable', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/health')) {
        throw new Error('connect failed');
      }
      if (url.endsWith('/v1/workloads/api-1')) {
        throw new Error('hosted discovery should be skipped');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(discovery.warnings).toEqual([
      'No local API server is running at http://localhost:8080. Start one with: anycloud api start',
    ]);
    expect(discovery.targets).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).endsWith('/v1/workloads/api-1'),
      ),
    ).toBe(false);
  });

  it('keeps an active remote target visible when the local manager is unavailable', async () => {
    process.env.API_URL = 'https://remote.example.test';
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === 'http://localhost:8080/health') {
        throw new Error('connect failed');
      }
      if (url.endsWith('/health')) return new Response(null, { status: 200 });
      if (url.endsWith('/v1/workloads/api-1')) {
        throw new Error('local hosted discovery should be skipped');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(discovery.warnings).toEqual([
      'No local API server is running at http://localhost:8080. Start one with: anycloud api start',
    ]);
    expect(discovery.targets).toEqual([
      expect.objectContaining({
        current: true,
        kind: 'manual',
        url: 'https://remote.example.test',
      }),
    ]);
  });

  it.each([
    {
      label: 'Docker inspection times out',
      inspection: {
        running: false,
        hostPort: null,
        failure: 'timeout' as const,
      },
      warning:
        'Timed out checking the local API container for http://localhost:8080. Check that Docker is responsive.',
    },
    {
      label: 'Docker is unavailable',
      inspection: {
        running: false,
        hostPort: null,
        failure: 'unavailable' as const,
      },
      warning:
        'Docker is unavailable, so the local API container at http://localhost:8080 could not be checked. Start Docker and try again.',
    },
    {
      label: 'Docker inspection output is malformed',
      inspection: {
        running: true,
        hostPort: null,
        failure: 'malformed' as const,
      },
      warning:
        'Docker returned an invalid response while checking the local API container for http://localhost:8080.',
    },
  ])(
    'reports actionable guidance when $label',
    async ({ inspection, warning }) => {
      mocks.inspectLocalApiContainer.mockReturnValue(inspection);
      fetchMock.mockImplementation(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith('/health')) {
          throw new Error('connect failed');
        }
        if (url.endsWith('/v1/workloads/api-1')) {
          throw new Error('hosted discovery should be skipped');
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const { discoverApiTargetRows } = await loadApiTarget();

      const discovery = await discoverApiTargetRows();

      expect(discovery.warnings).toEqual([warning]);
      expect(
        fetchMock.mock.calls.some(([input]) =>
          requestUrl(input).endsWith('/v1/workloads/api-1'),
        ),
      ).toBe(false);
    },
  );

  it('warns to inspect logs when the discovered local container is unreachable', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/health')) {
        throw new Error('connect failed');
      }
      if (url.endsWith('/v1/workloads/api-1')) {
        throw new Error('hosted discovery should be skipped');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { discoverApiTargetRows } = await loadApiTarget();

    const discovery = await discoverApiTargetRows();

    expect(discovery.warnings).toEqual([
      'Local API server at http://localhost:8787 is unreachable. Check logs with: anycloud api logs',
    ]);
    expect(
      discovery.targets.find((target) => target.id === 'local'),
    ).toMatchObject({
      current: true,
      health: 'unreachable',
      url: 'http://localhost:8787',
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).endsWith('/v1/workloads/api-1'),
      ),
    ).toBe(false);
  });

  it('reports no migration status when the local API is unreachable', async () => {
    process.env.API_URL = 'https://api-1.anycloud.sh';
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { activeVmHostedApi } = await loadApiTarget();
    await expect(activeVmHostedApi()).resolves.toBeNull();
  });

  it('keeps local info and reports a warning when the local API cannot list its Services', async () => {
    process.env.API_URL = 'https://api-1.anycloud.sh';
    const { discoverApiTargetRows } = await loadApiTarget();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/health')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/v1/workloads/api-1')) {
        return Response.json(
          {
            defined: true,
            code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
            status: 400,
            message: 'unavailable',
          },
          { status: 400 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const discovery = await discoverApiTargetRows();

    expect(discovery.targets.map((target) => target.kind)).toEqual([
      'manual',
      'local',
    ]);
    expect(discovery.warnings[0]).toContain('Could not inspect API api-1');
    expect(discovery.warnings[0]).toContain('unavailable');
  });

  it('api use resolves "local" and URLs only; a bare id names the cluster list', async () => {
    const { resolveApiTargetArgument } = await loadApiTarget();

    expect(resolveApiTargetArgument('https://api-1.anycloud.sh/')).toEqual({
      id: 'https://api-1.anycloud.sh',
      label: 'manual URL',
      url: 'https://api-1.anycloud.sh',
      source: 'manual',
    });
    expect(() => resolveApiTargetArgument('api-1')).toThrow(
      '"api-1" is not an API URL. Pass https://<cluster-id>.anycloud.sh (anycloud cluster list names it) or "local".',
    );
  });

  it('resolves local to the running local API container port', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    const { resolveApiTargetArgument } = await loadApiTarget();

    const target = await resolveApiTargetArgument('local');

    expect(target).toMatchObject({
      id: 'local',
      label: 'local',
      url: 'http://localhost:8787',
      source: 'local',
    });
  });

  it('selectable targets exclude unhealthy or incompatible APIs', async () => {
    const { discoverApiTargetRows, selectableApiTargets } =
      await loadApiTarget();

    const discovery = await discoverApiTargetRows();
    const selectable = selectableApiTargets(discovery.targets);

    expect(selectable.map((target) => target.id)).toEqual(['local']);
  });

  it('persists a local selection so it becomes an explicit, sticky target', async () => {
    const { persistApiTarget } = await loadApiTarget();

    await persistApiTarget({
      id: 'local',
      label: 'local',
      url: 'http://localhost:8080',
      source: 'local',
    });

    expect(readFileSync(join(state.anycloudDir, 'api-url'), 'utf-8')).toBe(
      'http://localhost:8080\n',
    );
  });

  it('does not persist a URL when its API version is incompatible', async () => {
    const { persistApiTarget } = await loadApiTarget();
    mocks.checkApiVersion.mockResolvedValueOnce({
      url: 'https://api-old.anycloud.sh',
      cliVersion: '0.1.34',
      apiVersion: '0.1.33',
      compatible: false,
      reason: 'API version is 0.1.33',
    });

    await expect(
      persistApiTarget({
        id: 'manual',
        label: 'manual URL',
        url: 'https://api-old.anycloud.sh',
        source: 'manual',
      }),
    ).rejects.toThrow('Cannot select incompatible API');

    expect(existsSync(join(state.anycloudDir, 'api-url'))).toBe(false);
  });
});
