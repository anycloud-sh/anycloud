import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { parseFamiliarName } from '@swimlane/docker-reference';
import { singleFlight, withRetry } from './utils.js';
import {
  GHCR_TOKEN_USERNAME,
  ImageInspectionFailureReason,
  ImageRuntime,
  ImageVerdict,
} from './image.js';

/**
 * Server-side image preflight via a direct registry HTTP manifest request — done
 * server-side (no docker binary, no daemon) so it covers the CLI, the Python SDK,
 * and CI uniformly, before provisioning a VM.
 *
 *   'ok'           — manifest definitively contains a linux/amd64 entry
 *   'no_amd64'     — manifest definitively lacks one (VM workloads require x86_64)
 *   'not_found'    — registry returned a definitive 404 for the reference
 *   'unauthorized' — definitive 401/403 (private/inaccessible, even after auth)
 *   'unknown'      — couldn't determine (network/timeout/unsupported shape) →
 *                    caller should PROCEED; we never make submit worse than today.
 *
 * Only definitive verdicts should block a submit; 'unknown' degrades.
 */
export interface ImageInspection {
  verdict: ImageVerdict;
  // The linux/amd64 manifest digest (sha256:...) when the verdict is 'ok' and
  // the registry exposed it. Persisted as server-owned immutable image identity;
  // null when the registry cannot provide it.
  amd64Digest: string | null;
  // GPU runtime the image's amd64 base expects. Always one of the three literals
  // (never undefined): 'unknown' whenever it can't be determined or the verdict
  // isn't 'ok'. Persisted at submit so the optimizer can drop incompatible
  // accelerators at VM-host startup (it can't re-inspect the image there).
  imageRuntime: ImageRuntime;
  // Sum of compressed layer sizes from the selected linux/amd64 manifest when
  // the registry exposes them. This is a lower bound on VM disk usage; null when
  // unknown.
  compressedLayerBytes: number | null;
  // The linux/amd64 config's `Env` ("KEY=VALUE"), only when that manifest and
  // its config blob matched their digests, so a pinned image binds it. An API
  // image names its chart here.
  env?: string[];
  // The same config's `Entrypoint` and `Cmd`, empty when it sets none: a pool
  // Job's runner starts the Entrypoint with the Job's command, or `Cmd`
  // without one, as Docker does.
  entrypoint?: string[];
  cmd?: string[];
  // Optional machine-readable diagnostic for a definitive preflight failure.
  // This is intentionally narrow: callers still use verdict for broad control
  // flow, while failureReason lets UX avoid misleading fallback messages.
  failureReason?: ImageInspectionFailureReason;
}

const MANIFEST_FETCH_TIMEOUT_MS = 5_000;
const MANIFEST_FETCH_MAX_ATTEMPTS = 3;
const MANIFEST_FETCH_RETRY_BASE_MS = 75;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/i;

// Single-flight map: concurrent submits of the same image share one registry
// probe, so a burst of identical inspections can't trip the registry's rate
// limit. Deliberately no result cache — each fresh (non-concurrent) inspection
// re-checks the registry.
const inFlightInspections = new Map<string, Promise<ImageInspection>>();

function noDigest(
  verdict: ImageVerdict,
  failureReason?: ImageInspectionFailureReason,
): ImageInspection {
  return {
    verdict,
    amd64Digest: null,
    imageRuntime: ImageRuntime.Unknown,
    compressedLayerBytes: null,
    ...(failureReason ? { failureReason } : {}),
  };
}

// Env entries / paths that mark a ROCm (AMD) base image. Checked BEFORE the CUDA
// markers so a dual-tagged base resolves deterministically to 'rocm'.
const ROCM_ENV_MARKER = /\/opt\/rocm|^HSA_|^ROCM_|^HIP_|^ROCR_/;
// Env keys that mark a CUDA (NVIDIA) base image.
const CUDA_ENV_MARKER = /^NVIDIA_REQUIRE_CUDA|^CUDA_VERSION/;

function labelsMatch(
  labels: Record<string, string> | undefined,
  pattern: RegExp,
): boolean {
  if (!labels || typeof labels !== 'object') return false;
  for (const [key, value] of Object.entries(labels)) {
    const k = String(key).toLowerCase();
    const v = typeof value === 'string' ? value.toLowerCase() : '';
    if (pattern.test(k) || pattern.test(v)) return true;
  }
  return false;
}

/**
 * Pure, shape-based classifier for the GPU runtime an image config declares.
 * Reads the OCI image config's `Env` (array of "KEY=VALUE") and `Labels`
 * (object). NO test-name / image-name awareness — only env-var and label shape.
 *
 * ROCm is checked before CUDA so a base tagged for both resolves deterministically.
 * Anything unrecognized (incl. malformed config) → 'unknown' (keep-all signal).
 */
export function classifyImageRuntime(
  config: { Env?: unknown; Labels?: unknown } | null | undefined,
): ImageRuntime {
  const env = Array.isArray(config?.Env)
    ? config.Env.filter((e): e is string => typeof e === 'string')
    : [];
  const labels =
    config?.Labels && typeof config.Labels === 'object'
      ? (config.Labels as Record<string, string>)
      : undefined;

  const rocmLabel = /rocm|amd\.com/;
  if (
    env.some((e) => ROCM_ENV_MARKER.test(e)) ||
    labelsMatch(labels, rocmLabel)
  ) {
    return ImageRuntime.Rocm;
  }

  const cudaLabel = /com\.nvidia|nvidia|cuda/;
  if (
    env.some((e) => CUDA_ENV_MARKER.test(e)) ||
    labelsMatch(labels, cudaLabel)
  ) {
    return ImageRuntime.Cuda;
  }

  return ImageRuntime.Unknown;
}

// OCI image index / Docker manifest list, plus single image manifests so the
// registry returns the index when one exists.
const ACCEPT_MANIFEST =
  'application/vnd.oci.image.index.v1+json, ' +
  'application/vnd.docker.distribution.manifest.list.v2+json, ' +
  'application/vnd.oci.image.manifest.v1+json, ' +
  'application/vnd.docker.distribution.manifest.v2+json';
const ACCEPT_CONFIG_BLOB =
  'application/vnd.oci.image.config.v1+json, ' +
  'application/vnd.docker.container.image.v1+json, ' +
  'application/json';

function isLinuxAmd64Platform(platform: any): boolean {
  return platform?.os === 'linux' && platform?.architecture === 'amd64';
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function registryPathReference(reference: string): string {
  return validDigest(reference) ? reference : encodeURIComponent(reference);
}

// Docker Hub's familiar domain (`docker.io`) is served by a different host for
// the v2 registry API.
function registryApiHost(domain: string): string {
  return domain === 'docker.io' || domain === 'index.docker.io'
    ? 'registry-1.docker.io'
    : domain;
}

// SSRF guard. The registry host comes from a user-supplied image ref, so refuse
// to probe loopback / private / link-local / unspecified addresses (e.g.
// 127.0.0.1, 169.254.169.254 cloud-metadata, 10.x) — whether named directly or
// as such an IP literal. A public DNS name is allowed (resolving it to catch a
// name→private-IP rebind is a deeper, separate hardening). Applied to both the
// manifest host and the bearer-challenge token realm.
function isInternalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = isIP(h);
  if (kind === 4) return isPrivateV4(h);
  if (kind === 6) return isPrivateV6(h);
  return false;
}

function isPrivateV4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true; // malformed → treat as unsafe
  const [a, b] = o;
  return (
    a === 0 || // 0.0.0.0/8 (this host)
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

function isPrivateV6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local fc00::/7
  const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

// Bare hostname from a registry "host[:port]" (or bracketed IPv6), or null.
function hostnameOf(hostWithPort: string): string | null {
  try {
    return new URL(`https://${hostWithPort}`).hostname;
  } catch {
    return null;
  }
}

function fetchOnceWithTimeout(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return withRetry(
    async () => {
      const res = await fetchOnceWithTimeout(url, headers);
      if (isRetryableStatus(res.status)) throw new Error(`HTTP ${res.status}`);
      return res;
    },
    'Fetch the image manifest',
    {
      maxAttempts: MANIFEST_FETCH_MAX_ATTEMPTS,
      retryDelayMs: (_error, attempt) =>
        MANIFEST_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 25,
    },
  );
}

// Parse a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."` header.
function parseBearerChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header)) !== null) {
    params[match[1]] = match[2];
  }
  return params;
}

// Resolve a pull token from a Bearer challenge. For ghcr.io we try the GitHub
// token first (needed to read PRIVATE images), then fall back to an anonymous
// token — so a PUBLIC image still resolves even when the token is invalid or
// lacks access to that package. SSRF / token-exfiltration guard: the GitHub
// token is only ever sent to ghcr.io's token endpoint, never an arbitrary realm
// a malicious image ref points at.
type RegistryTokenResult = {
  token: string | null;
  authFailed: boolean;
};

type BearerTokenResult = {
  token: string | null;
  failureReason?: ImageInspectionFailureReason;
};

function ghcrTokenAuthHeader(githubToken: string): string {
  return `Basic ${Buffer.from(`${GHCR_TOKEN_USERNAME}:${githubToken}`).toString(
    'base64',
  )}`;
}

async function resolveBearerToken(
  wwwAuthenticate: string | null,
  githubToken: string | undefined,
): Promise<BearerTokenResult> {
  if (!wwwAuthenticate || !/^bearer /i.test(wwwAuthenticate)) {
    return { token: null };
  }
  const params = parseBearerChallenge(wwwAuthenticate);
  if (!params.realm) return { token: null };

  let tokenUrl: URL;
  try {
    tokenUrl = new URL(params.realm);
  } catch {
    return { token: null };
  }
  // SSRF guard: a registry could point the token realm at an internal host.
  if (tokenUrl.protocol !== 'https:' || isInternalHost(tokenUrl.hostname)) {
    return { token: null };
  }
  if (params.service) tokenUrl.searchParams.set('service', params.service);
  if (params.scope) tokenUrl.searchParams.set('scope', params.scope);

  let credentialedAuthFailed = false;
  if (githubToken && tokenUrl.hostname === 'ghcr.io') {
    const credentialed = await requestRegistryToken(
      tokenUrl,
      ghcrTokenAuthHeader(githubToken),
    );
    if (credentialed.token) return { token: credentialed.token };
    credentialedAuthFailed = credentialed.authFailed;
  }

  const anonymous = await requestRegistryToken(tokenUrl);
  if (anonymous.token) return { token: anonymous.token };
  if (credentialedAuthFailed && anonymous.authFailed) {
    return {
      token: null,
      failureReason: ImageInspectionFailureReason.GhcrTokenExchangeFailed,
    };
  }
  // GHCR refuses anonymous tokens for private (and missing) packages, so
  // without a sign-in this is the private-image case, not an unknown one.
  if (!githubToken && tokenUrl.hostname === 'ghcr.io' && anonymous.authFailed) {
    return {
      token: null,
      failureReason: ImageInspectionFailureReason.GhcrSignInRequired,
    };
  }
  return { token: null };
}

async function requestRegistryToken(
  tokenUrl: URL,
  authorization?: string,
): Promise<RegistryTokenResult> {
  try {
    const headers: Record<string, string> = {};
    if (authorization) headers.Authorization = authorization;
    const res = await fetchWithRetry(tokenUrl.toString(), headers);
    if (!res.ok) {
      return {
        token: null,
        authFailed: res.status === 401 || res.status === 403,
      };
    }
    const body = await res.json();
    return {
      token: body?.token || body?.access_token || null,
      authFailed: false,
    };
  } catch {
    return { token: null, authFailed: false };
  }
}

type RegistryResourceResult = {
  response: Response | null;
  failureReason?: ImageInspectionFailureReason;
};

async function fetchRegistryResource(
  url: string,
  headers: Record<string, string>,
  githubTokenForHost: string | undefined,
): Promise<RegistryResourceResult> {
  let res = await fetchWithRetry(url, headers);
  // 401 often just kicks off the token dance (registries 401 even anonymous
  // pulls) — resolve a token and retry once before treating it as definitive.
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate');
    const bearer = await resolveBearerToken(challenge, githubTokenForHost);
    if (/^bearer /i.test(challenge ?? '') && !bearer.token) {
      return { response: null, failureReason: bearer.failureReason };
    }
    if (bearer.token) {
      res = await fetchWithRetry(url, {
        ...headers,
        Authorization: `Bearer ${bearer.token}`,
      });
    }
  }
  return { response: res };
}

// Read the GPU runtime from a fetched image config blob. OCI image config JSON is
// `{ architecture, os, config: { Env, Labels, ... }, rootfs, ... }` — the runtime
// fields live NESTED under `config.config`, not at the top level (which carries
// os/architecture). A null/failed blob yields 'unknown' (never blocks submit).
function runtimeFromConfigBlob(blob: any | null | undefined): ImageRuntime {
  return classifyImageRuntime(blob?.config);
}

// Fetch plumbing shared by the single- and index-manifest paths so the config
// blob is read identically on both (DRY). Returns the parsed config blob JSON or
// null on any failure (the caller degrades to imageRuntime 'unknown').
type RegistryFetcher = (
  url: string,
  headers: Record<string, string>,
) => Promise<Response | null>;

async function fetchRegistryResponse(
  url: string,
  headers: Record<string, string>,
  githubTokenForHost: string | undefined,
): Promise<Response | null> {
  const result = await fetchRegistryResource(url, headers, githubTokenForHost);
  return result.response;
}

/** Content addressed: the parsed body, and whether its bytes are `digest`. */
async function readContent(
  res: Response,
  digest: string | null,
): Promise<{ json: any; verified: boolean }> {
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    json: JSON.parse(bytes.toString('utf8')),
    verified:
      digest !== null &&
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` ===
        digest.toLowerCase(),
  };
}

async function fetchConfigBlobByDigest(
  host: string,
  repository: string,
  configDigest: string,
  fetchResource: RegistryFetcher,
): Promise<{ json: any; verified: boolean } | null> {
  if (!validDigest(configDigest)) return null;
  const blobUrl = `https://${host}/v2/${repository}/blobs/${registryPathReference(
    configDigest,
  )}`;
  const blobRes = await fetchResource(blobUrl, { Accept: ACCEPT_CONFIG_BLOB });
  if (!blobRes?.ok) return null;
  try {
    return await readContent(blobRes, configDigest);
  } catch {
    return null;
  }
}

function envFromConfig(
  manifestVerified: boolean,
  config: { json: any; verified: boolean } | null,
): Pick<ImageInspection, 'env' | 'entrypoint' | 'cmd'> {
  if (!manifestVerified || !config?.verified) return {};
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
  const env = strings(config.json?.config?.Env);
  return {
    ...(env && { env }),
    entrypoint: strings(config.json?.config?.Entrypoint) ?? [],
    cmd: strings(config.json?.config?.Cmd) ?? [],
  };
}

function sumLayerSizes(manifest: any): number | null {
  if (!Array.isArray(manifest?.layers)) return null;

  let total = 0;
  for (const layer of manifest.layers) {
    if (!Number.isFinite(layer?.size) || layer.size < 0) return null;
    total += layer.size;
  }
  return total;
}

async function configFromPlatformManifest(
  manifest: any,
  host: string,
  repository: string,
  fetchResource: RegistryFetcher,
): Promise<{ json: any; verified: boolean } | null> {
  try {
    const configDigest = manifest?.config?.digest;
    if (!validDigest(configDigest)) return null;
    return await fetchConfigBlobByDigest(
      host,
      repository,
      configDigest,
      fetchResource,
    );
  } catch {
    return null;
  }
}

// Verdict + amd64 manifest digest from a parsed index/list manifest. The amd64
// path also fetches the platform manifest so it can read compressed layer sizes
// and inspect the config blob for GPU runtime. Those extra probes never
// downgrade the verdict; failures keep the verdict 'ok' with unknown metadata.
async function classifyIndexManifest(
  { json: index, verified }: { json: any; verified: boolean },
  host: string,
  repository: string,
  fetchResource: RegistryFetcher,
): Promise<ImageInspection> {
  const entries: any[] = Array.isArray(index?.manifests) ? index.manifests : [];
  // Skip attestation/SBOM entries (platform os/architecture === 'unknown').
  const real = entries.filter(
    (m: any) => m?.platform?.os && m.platform.os !== 'unknown',
  );
  if (real.length === 0) return noDigest(ImageVerdict.Unknown);
  const amd64 = real.find((m: any) => isLinuxAmd64Platform(m.platform));
  if (!amd64) return noDigest(ImageVerdict.NoAmd64);
  const digest = validDigest(amd64.digest) ? amd64.digest : null;
  let child: { json: any; verified: boolean } | null = null;
  if (digest) {
    try {
      const manifestUrl = `https://${host}/v2/${repository}/manifests/${registryPathReference(
        digest,
      )}`;
      const res = await fetchResource(manifestUrl, { Accept: ACCEPT_MANIFEST });
      if (res?.ok) child = await readContent(res, digest);
    } catch {
      child = null;
    }
  }
  const childManifest = child?.json ?? null;
  const config = childManifest
    ? await configFromPlatformManifest(
        childManifest,
        host,
        repository,
        fetchResource,
      )
    : null;
  return {
    verdict: ImageVerdict.Ok,
    amd64Digest: digest,
    imageRuntime: runtimeFromConfigBlob(config?.json),
    compressedLayerBytes: sumLayerSizes(childManifest),
    ...envFromConfig(verified && child?.verified === true, config),
  };
}

async function classifySingleManifest(
  { json: manifest, verified }: { json: any; verified: boolean },
  manifestDigest: string | null,
  host: string,
  repository: string,
  fetchResource: RegistryFetcher,
): Promise<ImageInspection> {
  const configDigest = manifest?.config?.digest;
  if (!validDigest(configDigest)) return noDigest(ImageVerdict.Unknown);

  const fetched = await fetchConfigBlobByDigest(
    host,
    repository,
    configDigest,
    fetchResource,
  );
  const config = fetched?.json;
  if (!config) return noDigest(ImageVerdict.Unknown);

  if (config.os === 'linux' && config.architecture === 'amd64') {
    const amd64Digest = validDigest(manifestDigest) ? manifestDigest : null;
    return {
      verdict: ImageVerdict.Ok,
      amd64Digest,
      imageRuntime: runtimeFromConfigBlob(config),
      compressedLayerBytes: sumLayerSizes(manifest),
      ...envFromConfig(verified, fetched),
    };
  }

  if (config.os && config.architecture) {
    return noDigest(ImageVerdict.NoAmd64);
  }

  return noDigest(ImageVerdict.Unknown);
}

export function inspectImage(
  image: string,
  githubToken?: string | null,
): Promise<ImageInspection> {
  const token = githubToken ?? undefined;
  return singleFlight(
    inFlightInspections,
    inspectionCacheKey(image, token),
    () => inspectImageUncached(image, token),
  );
}

function inspectionCacheKey(image: string, githubToken?: string): string {
  let authScope = 'anonymous';
  try {
    const ref = parseFamiliarName(image);
    if (ref.domain === 'ghcr.io' && githubToken) {
      authScope = createHash('sha256').update(githubToken).digest('hex');
    }
  } catch {
    // Invalid refs never use the token; grouping them is fine.
  }
  return `${image}\0${authScope}`;
}

export function clearImageInspectionCache(): void {
  inFlightInspections.clear();
}

async function inspectImageUncached(
  image: string,
  githubToken?: string,
): Promise<ImageInspection> {
  let ref;
  try {
    ref = parseFamiliarName(image);
  } catch {
    return noDigest(ImageVerdict.Unknown);
  }

  const domain = ref.domain;
  const repository = ref.repository;
  const reference = ref.digest || ref.tag || 'latest';
  if (!domain || !repository) return noDigest(ImageVerdict.Unknown);

  const host = registryApiHost(domain);
  // SSRF guard: never issue the probe to an internal/loopback/link-local host.
  const hostname = hostnameOf(host);
  if (!hostname || isInternalHost(hostname)) {
    return noDigest(ImageVerdict.Unknown);
  }

  // Token-exfiltration guard: the image ref is user-supplied, so only attach the
  // GitHub token when the registry is ghcr.io. Everything else uses anonymous auth.
  const githubTokenForHost = domain === 'ghcr.io' ? githubToken : undefined;

  const manifestUrl = `https://${host}/v2/${repository}/manifests/${registryPathReference(
    reference,
  )}`;

  try {
    // Probe ANONYMOUSLY. Attaching a credential to the initial manifest request
    // makes ghcr reject a bad/dummy or no-access token with 403 (instead of
    // starting the anonymous bearer challenge), which would wrongly report a
    // PUBLIC image as 'unauthorized'. The GitHub token is used only at the token
    // exchange (resolveBearerToken), which itself falls back to anonymous.
    const headers: Record<string, string> = { Accept: ACCEPT_MANIFEST };

    const initial = await fetchRegistryResource(
      manifestUrl,
      headers,
      githubTokenForHost,
    );
    if (!initial.response) {
      return noDigest(
        initial.failureReason
          ? ImageVerdict.Unauthorized
          : ImageVerdict.Unknown,
        initial.failureReason,
      );
    }
    const res = initial.response;

    if (res.ok) {
      // A single registry-resource fetcher (auth + retry + token dance) shared by
      // the manifest, platform-manifest and config-blob hops on both paths.
      const fetchResource: RegistryFetcher = (url, headers) =>
        fetchRegistryResponse(url, headers, githubTokenForHost);

      const headerDigest = res.headers.get('docker-content-digest');
      const manifestDigest = validDigest(ref.digest)
        ? ref.digest.toLowerCase()
        : validDigest(headerDigest)
          ? headerDigest.toLowerCase()
          : null;
      const content = await readContent(res, manifestDigest);
      const manifest = content.json;
      if (Array.isArray(manifest?.manifests)) {
        return classifyIndexManifest(content, host, repository, fetchResource);
      }

      return classifySingleManifest(
        content,
        manifestDigest,
        host,
        repository,
        fetchResource,
      );
    }
    if (res.status === 404) return noDigest(ImageVerdict.NotFound);
    if (res.status === 401 || res.status === 403) {
      return noDigest(ImageVerdict.Unauthorized);
    }
    return noDigest(ImageVerdict.Unknown);
  } catch {
    // Network error, timeout, malformed JSON — degrade, never block.
    return noDigest(ImageVerdict.Unknown);
  }
}
