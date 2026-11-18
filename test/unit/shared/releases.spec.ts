import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASES_LATEST_URL,
  fetchLatestRelease,
  fetchLatestVersion,
  readVersionCache,
  releaseInternals,
  updateVersionCache,
  versionCachePath,
} from '../../../src/shared/releases.js';

class FakeRequest extends EventEmitter {
  readonly destroy = vi.fn();
}

class FakeResponse extends EventEmitter {
  readonly setEncoding = vi.fn();
  readonly resume = vi.fn();

  constructor(readonly statusCode: number) {
    super();
  }
}

// releases.ts reads statusCode and calls resume, setEncoding and on; the fakes
// implement that slice. Node's own types demand a socket, headers and the rest
// of a real exchange, none of which the module touches.
const asResponse = (response: FakeResponse): IncomingMessage =>
  response as unknown as IncomingMessage;
const asRequest = (request: FakeRequest): ClientRequest =>
  request as unknown as ClientRequest;

function mockReleaseResponse(
  status: number,
  body = '',
): {
  request: FakeRequest;
  response: FakeResponse;
} {
  const request = new FakeRequest();
  const response = new FakeResponse(status);
  vi.spyOn(releaseInternals, 'httpsGet').mockImplementation(
    (_url, _options, callback) => {
      if (typeof callback !== 'function') {
        throw new Error('httpsGet was called without a response callback');
      }
      queueMicrotask(() => {
        callback(asResponse(response));
        if (status === 200) {
          response.emit('data', body);
          response.emit('end');
        }
      });
      return asRequest(request);
    },
  );
  return { request, response };
}

describe('version cache', () => {
  let cacheDir: string;
  let originalAnycloudDir: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'anycloud-version-cache-'));
    originalAnycloudDir = process.env.ANYCLOUD_DIR;
    process.env.ANYCLOUD_DIR = cacheDir;
  });

  afterEach(() => {
    if (originalAnycloudDir === undefined) delete process.env.ANYCLOUD_DIR;
    else process.env.ANYCLOUD_DIR = originalAnycloudDir;
    rmSync(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'legacy two-field',
      cache: { latestVersion: '1.2.3', lastCheck: 123 },
    },
    {
      name: 'notification-aware',
      cache: {
        latestVersion: '1.2.3',
        lastCheck: 123,
        lastNotifiedVersion: '1.2.2',
      },
    },
  ])('reads the $name cache', ({ cache }) => {
    writeFileSync(versionCachePath(), JSON.stringify(cache));

    expect(readVersionCache()).toEqual(cache);
  });

  it('merges updates without discarding notification state', async () => {
    writeFileSync(
      versionCachePath(),
      JSON.stringify({
        latestVersion: '1.2.3',
        lastCheck: 123,
        lastNotifiedVersion: '1.2.3',
      }),
    );

    await updateVersionCache({ latestVersion: '1.2.4', lastCheck: 456 });

    expect(readVersionCache()).toEqual({
      latestVersion: '1.2.4',
      lastCheck: 456,
      lastNotifiedVersion: '1.2.3',
    });
  });

  it('atomically writes mode 0600 and leaves no temporary file', async () => {
    await updateVersionCache({ latestVersion: '1.2.3', lastCheck: 123 });

    expect(statSync(versionCachePath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(cacheDir)).toEqual(['version-cache.json']);
    expect(JSON.parse(readFileSync(versionCachePath(), 'utf8'))).toEqual({
      latestVersion: '1.2.3',
      lastCheck: 123,
    });
  });

  it('replaces a malformed cache when given complete valid metadata', async () => {
    writeFileSync(versionCachePath(), 'not json');

    await updateVersionCache({ latestVersion: '1.2.3', lastCheck: 123 });

    expect(readVersionCache()).toEqual({
      latestVersion: '1.2.3',
      lastCheck: 123,
    });
  });

  it('rejects an incomplete update when no valid cache exists', async () => {
    await expect(
      updateVersionCache({ lastNotifiedVersion: '1.2.3' }),
    ).rejects.toThrow(/missing valid release metadata/);
  });

  it('tightens an existing permissive cache file on the next update', async () => {
    writeFileSync(
      versionCachePath(),
      JSON.stringify({ latestVersion: '1.2.3', lastCheck: 123 }),
    );
    chmodSync(versionCachePath(), 0o644);

    await updateVersionCache({ latestVersion: '1.2.4', lastCheck: 456 });

    expect(statSync(versionCachePath()).mode & 0o777).toBe(0o600);
  });
});

describe('latest release client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns complete release metadata', async () => {
    mockReleaseResponse(
      200,
      JSON.stringify({
        tag_name: 'v1.2.3',
        html_url: 'https://github.com/anycloud-sh/releases/releases/tag/v1.2.3',
      }),
    );

    await expect(fetchLatestRelease()).resolves.toEqual({
      version: '1.2.3',
      url: 'https://github.com/anycloud-sh/releases/releases/tag/v1.2.3',
    });
    expect(releaseInternals.httpsGet).toHaveBeenCalledWith(
      RELEASES_LATEST_URL,
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    );
  });

  it('preserves tag-only version lookup compatibility', async () => {
    mockReleaseResponse(200, JSON.stringify({ tag_name: 'v1.2.3' }));

    await expect(fetchLatestVersion()).resolves.toBe('1.2.3');
  });

  it('rejects invalid tags and release URLs', async () => {
    mockReleaseResponse(
      200,
      JSON.stringify({
        tag_name: 'not-semver',
        html_url:
          'https://github.com/anycloud-sh/releases/releases/tag/not-semver',
      }),
    );
    await expect(fetchLatestRelease()).resolves.toBeNull();

    vi.restoreAllMocks();
    mockReleaseResponse(
      200,
      JSON.stringify({
        tag_name: 'v1.2.3',
        html_url: 'http://example.com',
      }),
    );
    await expect(fetchLatestRelease()).resolves.toBeNull();
  });

  it('returns null for malformed JSON and non-200 responses', async () => {
    mockReleaseResponse(200, '{');
    await expect(fetchLatestRelease()).resolves.toBeNull();

    vi.restoreAllMocks();
    const { response } = mockReleaseResponse(503);
    await expect(fetchLatestRelease()).resolves.toBeNull();
    expect(response.resume).toHaveBeenCalledOnce();
  });

  it('destroys a timed-out request and returns null', async () => {
    const request = new FakeRequest();
    vi.spyOn(releaseInternals, 'httpsGet').mockImplementation(() => {
      queueMicrotask(() => request.emit('timeout'));
      return asRequest(request);
    });

    await expect(fetchLatestRelease()).resolves.toBeNull();
    expect(request.destroy).toHaveBeenCalledOnce();
  });
});
