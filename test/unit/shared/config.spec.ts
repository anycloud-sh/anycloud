import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inspectLocalApiContainer: vi.fn(),
}));

vi.mock('../../../src/shared/local-api-container.js', () => ({
  inspectLocalApiContainer: mocks.inspectLocalApiContainer,
  localApiUrlForPort: (port: number) => `http://localhost:${port}`,
}));

async function loadConfig() {
  vi.resetModules();
  return await import('../../../src/shared/config.js');
}

describe('shared config API URL resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anycloud-config-'));
    vi.stubEnv('ANYCLOUD_DIR', dir);
    delete process.env.API_URL;
    delete process.env.CONDUCTOR_URL;
    vi.clearAllMocks();
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: false,
      hostPort: null,
      failure: 'missing',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to local API when no target is configured', async () => {
    const { getApiUrl, getApiUrlSource } = await loadConfig();

    expect(getApiUrl()).toBe('http://localhost:8080');
    expect(getApiUrlSource()).toBe('default');
  });

  it('defaults to the running local API container port when present', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    const { getApiUrl, getApiUrlSource, resolveApiTarget } = await loadConfig();

    expect(getApiUrl()).toBe('http://localhost:8787');
    expect(getApiUrlSource()).toBe('default');
    expect(resolveApiTarget()).toEqual({
      url: 'http://localhost:8787',
      source: 'default',
      localApiContainer: { running: true, hostPort: 8787 },
    });
  });

  it('keeps running-container evidence when its mapped port is unavailable', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: null,
      failure: 'malformed',
    });
    const { resolveApiTarget } = await loadConfig();

    expect(resolveApiTarget()).toEqual({
      url: 'http://localhost:8080',
      source: 'default',
      localApiContainer: {
        running: true,
        hostPort: null,
        failure: 'malformed',
      },
    });
  });

  it('uses persisted api-url when API_URL is absent', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    writeFileSync(join(dir, 'api-url'), 'https://api.example.test/\n');
    const { getApiUrl, getApiUrlSource } = await loadConfig();

    expect(getApiUrl()).toBe('https://api.example.test');
    expect(getApiUrlSource()).toBe('file');
    expect(mocks.inspectLocalApiContainer).not.toHaveBeenCalled();
  });

  it('lets API_URL override persisted api-url', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    writeFileSync(join(dir, 'api-url'), 'https://file.example.test\n');
    vi.stubEnv('API_URL', 'https://env.example.test/');
    const { getApiUrl, getApiUrlSource } = await loadConfig();

    expect(getApiUrl()).toBe('https://env.example.test');
    expect(getApiUrlSource()).toBe('env');
    expect(mocks.inspectLocalApiContainer).not.toHaveBeenCalled();
  });

  it('resolves local Docker independently when API_URL points remote', async () => {
    mocks.inspectLocalApiContainer.mockReturnValue({
      running: true,
      hostPort: 8787,
    });
    vi.stubEnv('API_URL', 'https://hosted.example.test');
    const { resolveApiTarget, resolveLocalApiTarget } = await loadConfig();

    expect(resolveApiTarget()).toEqual({
      url: 'https://hosted.example.test',
      source: 'env',
    });
    expect(resolveLocalApiTarget()).toEqual({
      url: 'http://localhost:8787',
      source: 'default',
      localApiContainer: { running: true, hostPort: 8787 },
    });
  });

  it('ignores legacy CONDUCTOR_URL', async () => {
    vi.stubEnv('CONDUCTOR_URL', 'https://legacy.example.test');
    const { getApiUrl, getApiUrlSource } = await loadConfig();

    expect(getApiUrl()).toBe('http://localhost:8080');
    expect(getApiUrlSource()).toBe('default');
  });
});

describe('normalizeApiUrl', () => {
  it('trims whitespace and trailing slashes', async () => {
    const { normalizeApiUrl } = await loadConfig();

    expect(normalizeApiUrl('  https://api.example.test/// ')).toBe(
      'https://api.example.test',
    );
    expect(normalizeApiUrl('http://localhost:8080/')).toBe(
      'http://localhost:8080',
    );
  });

  it('throws on an empty or whitespace-only URL', async () => {
    const { normalizeApiUrl } = await loadConfig();

    expect(() => normalizeApiUrl('   ')).toThrow('API URL cannot be empty');
  });

  it('throws on an unparseable URL', async () => {
    const { normalizeApiUrl } = await loadConfig();

    expect(() => normalizeApiUrl('not a url')).toThrow(/Invalid API URL/);
  });

  it('rejects non-http(s) protocols', async () => {
    const { normalizeApiUrl } = await loadConfig();

    expect(() => normalizeApiUrl('ftp://api.example.test')).toThrow(
      /must start with http/,
    );
  });

  it('rejects URLs that embed credentials', async () => {
    const { normalizeApiUrl } = await loadConfig();

    expect(() => normalizeApiUrl('https://user:pass@api.example.test')).toThrow(
      /must not contain credentials/,
    );
    expect(() => normalizeApiUrl('https://user@api.example.test')).toThrow(
      /must not contain credentials/,
    );
  });
});

describe('getLoopbackApiPort', () => {
  it.each([
    ['http://localhost:9000', 9000],
    ['http://127.0.0.1:8787/', 8787],
    ['http://[::1]:8081', 8081],
    ['http://localhost', 80],
    ['https://localhost', 443],
  ])('resolves %s to port %s', async (url, expectedPort) => {
    const { getLoopbackApiPort } = await loadConfig();

    expect(getLoopbackApiPort(url)).toBe(expectedPort);
  });

  it.each([
    'https://api.anycloud.sh',
    'http://192.168.1.10:8080',
    'http://localhost.example.com:8080',
  ])('does not classify remote URL %s as loopback', async (url) => {
    const { getLoopbackApiPort } = await loadConfig();

    expect(getLoopbackApiPort(url)).toBeUndefined();
  });
});

describe('isLoopbackApiUrl', () => {
  it.each([
    'http://localhost:8080',
    'http://LOCALHOST:8080',
    'http://api.localhost:8080',
    'http://localhost.:8080',
    'http://api.localhost.:8080',
    'http://127.0.0.1:8080',
    'http://127.255.10.3:8080',
    // WHATWG URL parsing canonicalizes shorthand IPv4 to 127.0.0.1.
    'http://127.1:8080',
    'http://0.0.0.0:8080',
    'http://[::1]:8080',
    'http://[0:0:0:0:0:0:0:1]:8080',
    'http://[::]:8080',
    'http://[::ffff:127.0.0.1]:8080',
    'http://[::ffff:127.1.2.3]:8080',
    'http://[::ffff:0.0.0.0]:8080',
    'http://[::ffff:0:0]:8080',
  ])('classifies %s as loopback', async (url) => {
    const { isLoopbackApiUrl } = await loadConfig();

    expect(isLoopbackApiUrl(url)).toBe(true);
  });

  it.each([
    'https://api.anycloud.sh',
    'http://10.0.0.5:8080',
    'http://126.255.255.255:8080',
    'http://128.0.0.1:8080',
    'http://127.0.0.1.example.com:8080',
    'http://localhost.example.com:8080',
    'http://[::2]:8080',
    'http://[::ffff:10.0.0.5]:8080',
    'http://[::ffff:128.0.0.1]:8080',
    'http://localhost..:8080',
  ])('does not classify %s as loopback', async (url) => {
    const { isLoopbackApiUrl } = await loadConfig();

    expect(isLoopbackApiUrl(url)).toBe(false);
  });
});
