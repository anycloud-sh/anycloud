import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyImageRuntime,
  clearImageInspectionCache,
  inspectImage,
} from '../../../src/shared/image-registry.js';
import { resolveApiImage } from '../../../src/shared/api-image.js';
import {
  ImageInspectionFailureReason,
  ImageRuntime,
  ImageVerdict,
} from '../../../src/shared/image.js';

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
) {
  const status = init?.status ?? 200;
  const headers = Object.fromEntries(
    Object.entries(init?.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

/** The sha256 digest of what `jsonResponse(body)` serves. */
const digestOf = (body: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;

// A 401 with a Bearer challenge pointing at the given token-endpoint host.
const challenge = (tokenHost: string, scope: string) =>
  jsonResponse(
    {},
    {
      status: 401,
      headers: {
        'www-authenticate': `Bearer realm="https://${tokenHost}/token",service="${tokenHost}",scope="${scope}"`,
      },
    },
  );

const fetchMock = vi.fn();

const AMD64_DIGEST = `sha256:${'a'.repeat(64)}`;
const ARM64_DIGEST = `sha256:${'b'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'d'.repeat(64)}`;
const DIGEST_BY_ARCH: Record<string, string> = {
  amd64: AMD64_DIGEST,
  arm64: ARM64_DIGEST,
};

const index = (...arches: string[]) => ({
  manifests: arches.map((architecture) => ({
    digest: DIGEST_BY_ARCH[architecture] ?? `sha256:${'c'.repeat(64)}`,
    platform: { os: 'linux', architecture },
  })),
});

const singleManifest = (
  configDigest = CONFIG_DIGEST,
  layerSizes: number[] = [],
) => ({
  schemaVersion: 2,
  config: { digest: configDigest },
  layers: layerSizes.map((size) => ({ size })),
});

const ghcrBasicAuth = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

const verdictOf = async (image: string, token?: string) =>
  (await inspectImage(image, token)).verdict;

describe('inspectImage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearImageInspectionCache();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "ok", the amd64 digest, and compressed layer bytes when the index has a linux/amd64 entry', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('arm64', 'amd64')))
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(CONFIG_DIGEST, [10, 20])),
      );
    const result = await inspectImage('python:3.11');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.compressedLayerBytes).toBe(30);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      `/v2/library/python/manifests/${AMD64_DIGEST}`,
    );
  });

  it('treats accelerated-format layer annotations as ordinary OCI metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('amd64')))
      .mockResolvedValueOnce(
        jsonResponse({
          ...singleManifest(CONFIG_DIGEST),
          layers: [
            {
              size: 42,
              mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
              annotations: {
                'containerd.io/snapshot/stargz/toc.digest': `sha256:${'e'.repeat(64)}`,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(imageConfig({})));

    const result = await inspectImage('ghcr.io/x/y:tag');

    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.compressedLayerBytes).toBe(42);
    expect(result).not.toHaveProperty('stargzDigest');
  });

  it('returns "ok" with a null digest when the amd64 entry has no/invalid digest', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }],
      }),
    );
    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBeNull();
    expect(result.compressedLayerBytes).toBeNull();
  });

  it('returns "ok" and the manifest digest for a single linux/amd64 manifest', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(CONFIG_DIGEST, [100, 200]), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'amd64' }),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.compressedLayerBytes).toBe(300);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      `/v2/x/y/blobs/${CONFIG_DIGEST}`,
    );
  });

  it("reports the amd64 config's Env only when the manifests and config match their digests", async () => {
    const env = ['PATH=/usr/bin', 'ANYCLOUD_API_CHART=oci://r/api-k8-chart@x'];
    const config = imageConfig({ Env: env });
    const manifest = singleManifest(digestOf(config));
    const platformIndex = {
      manifests: [
        {
          digest: digestOf(manifest),
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    };
    const tampered = imageConfig({ Env: ['ANYCLOUD_API_CHART=oci://evil'] });
    fetchMock
      // By tag through an index: the index matches its header digest.
      .mockResolvedValueOnce(
        jsonResponse(platformIndex, {
          headers: { 'docker-content-digest': digestOf(platformIndex) },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse(config))
      // Pinned to the platform manifest.
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse(config))
      // A registry serving another config under the pinned digest.
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse(tampered))
      // Pinned to the index itself.
      .mockResolvedValueOnce(jsonResponse(platformIndex))
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse(config))
      // An index by tag with no digest header binds nothing.
      .mockResolvedValueOnce(jsonResponse(platformIndex))
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse(config));

    expect((await inspectImage('ghcr.io/x/y:tag')).env).toEqual(env);
    const pinned = `ghcr.io/x/y:tag@${digestOf(manifest)}`;
    expect((await inspectImage(pinned)).env).toEqual(env);
    const forged = await inspectImage(pinned);
    expect(forged.verdict).toBe(ImageVerdict.Ok);
    expect(forged).not.toHaveProperty('env');
    expect(
      (await inspectImage(`ghcr.io/x/y:tag@${digestOf(platformIndex)}`)).env,
    ).toEqual(env);
    const headerless = await inspectImage('ghcr.io/x/y:tag');
    expect(headerless).toMatchObject({
      verdict: ImageVerdict.Ok,
      digest: digestOf(manifest),
    });
    expect(headerless).not.toHaveProperty('env');
  });

  it('returns null compressed layer bytes when a layer size is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ...singleManifest(),
            layers: [{ size: 100 }, { digest: ARM64_DIGEST }],
          },
          {
            headers: { 'docker-content-digest': AMD64_DIGEST },
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'amd64' }),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.compressedLayerBytes).toBeNull();
  });

  it('returns "ok" with a null digest for single amd64 manifests without a digest header', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleManifest()))
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'amd64' }),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBeNull();
  });

  it('returns "no_platform" for a single linux/arm64 manifest', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': ARM64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'arm64' }),
      );

    expect(await verdictOf('ghcr.io/x/arm-only:tag')).toBe(
      ImageVerdict.NoPlatform,
    );
  });

  it('returns "no_platform" for a single windows/amd64 manifest', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ os: 'windows', architecture: 'amd64' }),
      );

    expect(await verdictOf('ghcr.io/x/windows-amd64:tag')).toBe(
      ImageVerdict.NoPlatform,
    );
  });

  it('returns "unknown" for a single manifest when its config blob cannot be read', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }));

    expect(await verdictOf('ghcr.io/x/y:tag')).toBe(ImageVerdict.Unknown);
  });

  it('inspects a digest-pinned single manifest and returns the pinned digest when it is amd64', async () => {
    const pinnedDigest = `sha256:${'e'.repeat(64)}`;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleManifest()))
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'amd64' }),
      );

    const result = await inspectImage(`ghcr.io/x/y@${pinnedDigest}`);

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(pinnedDigest);
  });

  it('resolves a digest-pinned image index to the linux/amd64 child digest', async () => {
    const pinnedIndexDigest = `sha256:${'e'.repeat(64)}`;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('arm64', 'amd64')))
      .mockResolvedValueOnce(jsonResponse(singleManifest(CONFIG_DIGEST, [12])));

    const result = await inspectImage(`ghcr.io/x/y@${pinnedIndexDigest}`);

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.compressedLayerBytes).toBe(12);
  });

  it('resolves an index to its linux/arm64 child for an arm64 VM', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('amd64', 'arm64')))
      .mockResolvedValueOnce(jsonResponse(singleManifest(CONFIG_DIGEST, [7])));

    const result = await inspectImage(
      'docker.io/library/alpine:3',
      null,
      'arm64',
    );

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(ARM64_DIGEST);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(ARM64_DIGEST);
  });

  it('returns "no_platform" for an arm64 VM when the index has only amd64', async () => {
    fetchMock.mockResolvedValue(jsonResponse(index('amd64')));

    const result = await inspectImage('ghcr.io/x/amd-only:tag', null, 'arm64');

    expect(result.verdict).toBe(ImageVerdict.NoPlatform);
    expect(result.digest).toBeNull();
  });

  it('accepts a single linux/arm64 manifest for an arm64 VM', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': ARM64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'arm64' }),
      );

    const result = await inspectImage('ghcr.io/x/arm-only:tag', null, 'arm64');

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(ARM64_DIGEST);
  });

  it('returns "no_platform" when the index lacks amd64 (ignoring attestation entries)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        manifests: [
          { platform: { os: 'linux', architecture: 'arm64' } },
          { platform: { os: 'unknown', architecture: 'unknown' } },
        ],
      }),
    );
    expect(await verdictOf('ghcr.io/x/arm-only:tag')).toBe(
      ImageVerdict.NoPlatform,
    );
  });

  it('returns "not_found" on a definitive 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    expect(await verdictOf('ghcr.io/x/typo:tag')).toBe(ImageVerdict.NotFound);
  });

  it('returns "unauthorized" on a definitive 403', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }));
    expect(await verdictOf('ghcr.io/x/private:tag')).toBe(
      ImageVerdict.Unauthorized,
    );
  });

  it('accepts a PUBLIC Docker Hub image via the anonymous bearer challenge', async () => {
    fetchMock
      .mockResolvedValueOnce(
        challenge('auth.docker.io', 'repository:library/python:pull'),
      )
      .mockResolvedValueOnce(jsonResponse({ token: 'anon-token' }))
      .mockResolvedValueOnce(jsonResponse(index('arm64', 'amd64')))
      .mockResolvedValueOnce(jsonResponse(singleManifest(CONFIG_DIGEST, [10])));

    expect(await verdictOf('python:3.11')).toBe(ImageVerdict.Ok);
    // The token endpoint was hit anonymously (no GitHub token to a non-ghcr host).
    expect(fetchMock.mock.calls[1][1]?.headers?.Authorization).toBeUndefined();
  });

  it('returns "unknown" when a Docker Hub bearer token cannot be resolved', async () => {
    fetchMock
      .mockResolvedValueOnce(
        challenge('auth.docker.io', 'repository:library/nginx:pull'),
      )
      .mockRejectedValueOnce(new Error('token timeout'))
      .mockRejectedValueOnce(new Error('token timeout'))
      .mockRejectedValueOnce(new Error('token timeout'));

    expect(await verdictOf('nginx:alpine')).toBe(ImageVerdict.Unknown);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries transient token and manifest failures before accepting a public image', async () => {
    fetchMock
      .mockResolvedValueOnce(
        challenge('auth.docker.io', 'repository:library/nginx:pull'),
      )
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockRejectedValueOnce(new Error('token reset'))
      .mockResolvedValueOnce(jsonResponse({ token: 'anon-token' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(index('arm64', 'amd64')))
      // The amd64 entry triggers the metadata hop: platform manifest for
      // compressed layers, then config blob for runtime detection.
      .mockResolvedValueOnce(jsonResponse(singleManifest(CONFIG_DIGEST, [10])))
      .mockResolvedValueOnce(jsonResponse(imageConfig({})));

    expect(await verdictOf('nginx:alpine')).toBe(ImageVerdict.Ok);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('deduplicates concurrent inspections so they share one registry probe', async () => {
    fetchMock
      .mockResolvedValueOnce(
        challenge('auth.docker.io', 'repository:library/nginx:pull'),
      )
      .mockResolvedValueOnce(jsonResponse({ token: 'anon-token' }))
      .mockResolvedValueOnce(jsonResponse(index('amd64')))
      // Metadata hop (platform manifest + config blob).
      .mockResolvedValueOnce(jsonResponse(singleManifest(CONFIG_DIGEST, [10])))
      .mockResolvedValueOnce(jsonResponse(imageConfig({})));

    const results = await Promise.all([
      inspectImage('nginx:alpine'),
      inspectImage('nginx:alpine'),
      inspectImage('nginx:alpine'),
    ]);

    // Three concurrent submits collapse to one inspection: challenge + token +
    // index + metadata hop (platform manifest + config blob) = 5
    // fetches, not 15. (No result cache: a later, non-concurrent submit re-probes.)
    expect(results.map((r) => r.verdict)).toEqual([
      ImageVerdict.Ok,
      ImageVerdict.Ok,
      ImageVerdict.Ok,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('accepts a PUBLIC ghcr image even when the token is invalid (anonymous fallback)', async () => {
    // Reproduces the reported repro: a dummy/no-access token must not turn a
    // public image into "unauthorized".
    fetchMock
      .mockResolvedValueOnce(
        challenge('ghcr.io', 'repository:anycloud-sh/arm64-only-test:pull'),
      )
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 })) // credentialed token denied
      .mockResolvedValueOnce(jsonResponse({ token: 'anon-token' })) // anonymous fallback
      .mockResolvedValueOnce(jsonResponse(index('arm64'))); // retry → arm64-only

    expect(
      await verdictOf(
        'ghcr.io/anycloud-sh/arm64-only-test:latest',
        'dummy-token-for-test',
      ),
    ).toBe(ImageVerdict.NoPlatform);

    // Initial manifest probe is anonymous...
    expect(fetchMock.mock.calls[0][1]?.headers?.Authorization).toBeUndefined();
    // ...the credentialed token attempt carried the GitHub token using GHCR's
    // Docker-compatible Basic auth, not the GitHub API Bearer scheme...
    expect(fetchMock.mock.calls[1][1]?.headers?.Authorization).toBe(
      ghcrBasicAuth('dummy-token-for-test'),
    );
    // ...and the anonymous fallback did not.
    expect(fetchMock.mock.calls[2][1]?.headers?.Authorization).toBeUndefined();
  });

  it('returns "unauthorized" when private ghcr token exchange denies the GitHub token', async () => {
    fetchMock
      .mockResolvedValueOnce(challenge('ghcr.io', 'repository:x/private:pull'))
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 })) // credentialed token denied
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 })); // anonymous token denied

    const result = await inspectImage('ghcr.io/x/private:tag', 'bad-token');

    expect(result.verdict).toBe(ImageVerdict.Unauthorized);
    expect(result.failureReason).toBe(
      ImageInspectionFailureReason.GhcrTokenExchangeFailed,
    );
  });

  it('returns "unauthorized" for a private ghcr image without a GitHub sign-in', async () => {
    fetchMock
      .mockResolvedValueOnce(challenge('ghcr.io', 'repository:x/private:pull'))
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 })); // anonymous token denied

    const result = await inspectImage('ghcr.io/x/private:tag');

    expect(result.verdict).toBe(ImageVerdict.Unauthorized);
    expect(result.failureReason).toBe(
      ImageInspectionFailureReason.GhcrSignInRequired,
    );
  });

  it('returns "unauthorized" for a private image when the token lacks access', async () => {
    fetchMock
      .mockResolvedValueOnce(challenge('ghcr.io', 'repository:x/private:pull'))
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 })) // credentialed token denied
      .mockResolvedValueOnce(jsonResponse({ token: 'anon-token' })) // anonymous fallback
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 })); // retry denied (private)
    expect(await verdictOf('ghcr.io/x/private:tag', 'bad-token')).toBe(
      ImageVerdict.Unauthorized,
    );
  });

  it('returns "unknown" on a network error — degrade, never block', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await verdictOf('python:3.11')).toBe(ImageVerdict.Unknown);
  });

  it('returns "unknown" for a digest-pinned ref when the registry probe fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await verdictOf(`ghcr.io/x/y@sha256:${'a'.repeat(64)}`)).toBe(
      ImageVerdict.Unknown,
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it('returns "unknown" for a single (non-index) manifest', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ schemaVersion: 2, config: {}, layers: [] }),
    );
    expect(await verdictOf('example.com/single:tag')).toBe(
      ImageVerdict.Unknown,
    );
  });

  it('never sends the GitHub token to a non-ghcr registry (SSRF guard)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(index('amd64')));
    await inspectImage('docker.io/library/python:3.11', 'gh_secret');
    for (const [, options] of fetchMock.mock.calls) {
      expect(JSON.stringify(options?.headers ?? {})).not.toContain('gh_secret');
    }
  });

  it('never sends the GitHub token to a non-ghcr registry while fetching a config blob', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'amd64' }),
      );

    await inspectImage('docker.io/library/python:3.11', 'gh_secret');

    for (const [, options] of fetchMock.mock.calls) {
      expect(JSON.stringify(options?.headers ?? {})).not.toContain('gh_secret');
    }
  });

  it('does not attach the GitHub token to the initial manifest request', async () => {
    fetchMock.mockResolvedValue(jsonResponse(index('amd64')));
    await inspectImage('ghcr.io/x/y:tag', 'gh_secret');
    const [, options] = fetchMock.mock.calls[0];
    expect(options?.headers?.Authorization).toBeUndefined();
  });

  it('handles a 401 Bearer challenge: anonymous probe, ghcr token exchange, retry', async () => {
    fetchMock
      .mockResolvedValueOnce(challenge('ghcr.io', 'repository:x/y:pull'))
      .mockResolvedValueOnce(jsonResponse({ token: 'pull-token-123' }))
      .mockResolvedValueOnce(jsonResponse(index('amd64')))
      .mockResolvedValueOnce(jsonResponse(singleManifest(CONFIG_DIGEST, [10])));

    expect(await verdictOf('ghcr.io/x/y:tag', 'gh_secret')).toBe(
      ImageVerdict.Ok,
    );

    // Initial probe anonymous; token endpoint carries the GitHub token; retry
    // uses the resolved pull token.
    expect(fetchMock.mock.calls[0][1]?.headers?.Authorization).toBeUndefined();
    const tokenCall = fetchMock.mock.calls[1];
    expect(String(tokenCall[0])).toContain('https://ghcr.io/token');
    expect(tokenCall[1]?.headers?.Authorization).toBe(
      ghcrBasicAuth('gh_secret'),
    );
    expect(fetchMock.mock.calls[2][1]?.headers?.Authorization).toBe(
      'Bearer pull-token-123',
    );
  });

  it('handles a 401 Bearer challenge while fetching a single-manifest config blob', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(challenge('ghcr.io', 'repository:x/y:pull'))
      .mockResolvedValueOnce(jsonResponse({ token: 'blob-token-123' }))
      .mockResolvedValueOnce(
        jsonResponse({ os: 'linux', architecture: 'amd64' }),
      );

    const result = await inspectImage('ghcr.io/x/y:tag', 'gh_secret');

    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(fetchMock.mock.calls[0][1]?.headers?.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][1]?.headers?.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[2][1]?.headers?.Authorization).toBe(
      ghcrBasicAuth('gh_secret'),
    );
    expect(fetchMock.mock.calls[3][1]?.headers?.Authorization).toBe(
      'Bearer blob-token-123',
    );
  });

  // SSRF guard: a user-supplied image ref must not make the API server probe
  // internal infrastructure.
  it.each([
    ['127.0.0.1:8443/repo:tag', 'loopback'],
    ['169.254.169.254/meta:tag', 'link-local / cloud metadata'],
    ['10.0.0.5/repo:tag', 'private'],
    ['192.168.1.10:5000/repo:tag', 'private'],
    ['localhost:5000/repo:tag', 'localhost'],
  ])('skips internal host %s (%s) without any request', async (ref) => {
    fetchMock.mockResolvedValue(jsonResponse(index('amd64')));
    expect(await verdictOf(ref, 'gh_secret')).toBe(ImageVerdict.Unknown);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a Bearer realm pointing at an internal host', async () => {
    fetchMock.mockResolvedValueOnce(
      challenge('127.0.0.1', 'repository:x/y:pull'),
    );
    // No token can be fetched from the internal realm, so the challenged 401 is
    // not treated as definitive.
    expect(await verdictOf('ghcr.io/x/y:tag', 'gh_secret')).toBe(
      ImageVerdict.Unknown,
    );
    // Only the manifest probe ran — never the internal token endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// OCI image config JSON nests the runtime fields under `config`:
// { architecture, os, config: { Env, Labels, ... } }. These helpers build the
// nested shape the detector reads.
const imageConfig = (
  inner: { Env?: string[]; Labels?: Record<string, string> } = {},
) => ({
  architecture: 'amd64',
  os: 'linux',
  config: inner,
});

describe('classifyImageRuntime (pure)', () => {
  it('detects cuda from NVIDIA_REQUIRE_CUDA / CUDA_VERSION env', () => {
    expect(
      classifyImageRuntime({ Env: ['NVIDIA_REQUIRE_CUDA=cuda>=11.0'] }),
    ).toBe(ImageRuntime.Cuda);
    expect(classifyImageRuntime({ Env: ['CUDA_VERSION=12.2.0'] })).toBe(
      ImageRuntime.Cuda,
    );
  });

  it('detects cuda from an nvidia label', () => {
    expect(
      classifyImageRuntime({ Labels: { 'com.nvidia.cuda.version': '12.2' } }),
    ).toBe(ImageRuntime.Cuda);
  });

  it('detects rocm from ROCm env markers', () => {
    expect(
      classifyImageRuntime({ Env: ['HSA_OVERRIDE_GFX_VERSION=11.0.0'] }),
    ).toBe(ImageRuntime.Rocm);
    expect(classifyImageRuntime({ Env: ['PATH=/opt/rocm/bin:/usr/bin'] })).toBe(
      'rocm',
    );
    expect(classifyImageRuntime({ Env: ['ROCM_PATH=/opt/rocm'] })).toBe(
      ImageRuntime.Rocm,
    );
  });

  it('detects rocm from an amd/rocm label', () => {
    expect(classifyImageRuntime({ Labels: { 'com.amd.rocm': '1' } })).toBe(
      'rocm',
    );
  });

  it('prefers rocm over cuda for a dual-tagged base (deterministic order)', () => {
    expect(
      classifyImageRuntime({
        Env: ['CUDA_VERSION=12.2', 'ROCM_PATH=/opt/rocm'],
      }),
    ).toBe(ImageRuntime.Rocm);
  });

  it('returns unknown for a plain config with no GPU markers', () => {
    expect(classifyImageRuntime({ Env: ['PATH=/usr/bin'] })).toBe(
      ImageRuntime.Unknown,
    );
    expect(classifyImageRuntime({})).toBe(ImageRuntime.Unknown);
    expect(classifyImageRuntime(null)).toBe(ImageRuntime.Unknown);
  });

  it('returns unknown for malformed config (non-array Env, non-object Labels)', () => {
    expect(classifyImageRuntime({ Env: 'not-an-array' })).toBe(
      ImageRuntime.Unknown,
    );
    expect(classifyImageRuntime({ Labels: 'not-an-object' })).toBe(
      ImageRuntime.Unknown,
    );
  });
});

describe('inspectImage imageRuntime detection', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearImageInspectionCache();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- SINGLE manifest path (manifest -> config blob) ---

  it('detects cuda on a single amd64 manifest from the config blob', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(imageConfig({ Env: ['NVIDIA_REQUIRE_CUDA=cuda>=11.0'] })),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.imageRuntime).toBe(ImageRuntime.Cuda);
  });

  it('detects rocm on a single amd64 manifest from the config blob', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(imageConfig({ Env: ['HSA_OVERRIDE_GFX_VERSION=11.0.0'] })),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.imageRuntime).toBe(ImageRuntime.Rocm);
  });

  it('detects rocm via an amd label on a single manifest', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(imageConfig({ Labels: { 'com.amd.rocm': '1' } })),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.imageRuntime).toBe(ImageRuntime.Rocm);
  });

  it('returns unknown runtime for a plain single amd64 image (no GPU env/labels)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleManifest(), {
          headers: { 'docker-content-digest': AMD64_DIGEST },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(imageConfig({})));

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
  });

  // --- INDEX / multi-arch path (index -> platform manifest -> config blob) ---

  it('detects cuda on an index via the platform-manifest + config-blob hop', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('arm64', 'amd64'))) // index
      .mockResolvedValueOnce(jsonResponse(singleManifest())) // platform manifest for amd64 entry
      .mockResolvedValueOnce(
        jsonResponse(imageConfig({ Env: ['CUDA_VERSION=12.2'] })),
      ); // config blob

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.imageRuntime).toBe(ImageRuntime.Cuda);
    // The platform-manifest hop was made against the amd64 entry digest.
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      `/v2/x/y/manifests/${AMD64_DIGEST}`,
    );
  });

  it('detects rocm on an index via the extra hop', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('amd64')))
      .mockResolvedValueOnce(jsonResponse(singleManifest()))
      .mockResolvedValueOnce(
        jsonResponse(imageConfig({ Env: ['ROCM_PATH=/opt/rocm'] })),
      );

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.imageRuntime).toBe(ImageRuntime.Rocm);
  });

  it('keeps verdict "ok" with runtime "unknown" when the index config hop fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('amd64')))
      .mockResolvedValueOnce(jsonResponse(singleManifest()))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 })); // config blob unreadable

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
  });

  it('keeps verdict "ok" with runtime "unknown" when the platform-manifest hop fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(index('amd64')))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 })); // platform manifest unreadable (non-retryable)

    const result = await inspectImage('ghcr.io/x/y:tag');
    expect(result.verdict).toBe(ImageVerdict.Ok);
    expect(result.digest).toBe(AMD64_DIGEST);
    expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
  });
});

describe('resolveApiImage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearImageInspectionCache();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One by-digest platform manifest whose config names this Env. */
  const serve = (env: string[]) => {
    const config = imageConfig({ Env: env });
    const manifest = singleManifest(digestOf(config));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse(config));
    return digestOf(manifest);
  };

  it('pins the image to its digest and returns the digest-pinned chart it names, anonymously', async () => {
    const chart = `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`;
    const digest = serve([`ANYCLOUD_API_CHART=${chart}`]);
    await expect(
      resolveApiImage(`ghcr.io/anycloud-sh/api:0.1.74@${digest}`),
    ).resolves.toEqual({ digest, chart });
    for (const [, init] of fetchMock.mock.calls) {
      expect(
        (init as { headers?: Record<string, string> } | undefined)?.headers,
      ).not.toHaveProperty('Authorization');
    }
  });

  it('refuses an image before 0.1.68, which names no digest-pinned chart, pointing at the upgrade doc', async () => {
    const unpinned = serve([
      'ANYCLOUD_API_CHART=oci://ghcr.io/anycloud-sh/api-k8-chart:0.1.67',
    ]);
    await expect(
      resolveApiImage(`ghcr.io/anycloud-sh/api:0.1.67@${unpinned}`),
    ).rejects.toThrow(
      'https://anycloud.sh/platform/hosted-apis#upgrade-a-hosted-api',
    );
    const none = serve(['PATH=/usr/bin']);
    await expect(
      resolveApiImage(`ghcr.io/anycloud-sh/api:0.1.60@${none}`),
    ).rejects.toThrow('ANYCLOUD_API_CHART is unset');
  });

  it('refuses an image the registry cannot resolve to a digest', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    await expect(
      resolveApiImage('ghcr.io/anycloud-sh/api:9.9.9'),
    ).rejects.toThrow('to an immutable digest (not_found)');
  });
});
