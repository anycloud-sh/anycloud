import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { inspectImage } from '../../src/shared/image-registry.js';
import { listGitHubPackages } from '../../src/cli/services/ghcr.js';
import { ImageRuntime, ImageVerdict } from '../../src/shared/image.js';

const NET_TIMEOUT_MS = 30_000;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Private to the anycloud-sh org; it exists only for these checks.
const CI_PRIVATE_IMAGE = 'ghcr.io/anycloud-sh/ci-private:latest';

function currentDepsImage(): string {
  const depsHash = execFileSync(
    'bash',
    ['scripts/resolve-deps-image.sh', 'hash'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ).trim();

  return `${packageJson.apiImage}-deps-full:${depsHash}`;
}

function requiredToken(name: string): string {
  const token = process.env[name];
  if (!token) {
    throw new Error(
      `${name} is required; CI sets it from the same-named secret.`,
    );
  }
  return token;
}

/**
 * Authenticate through the API's real GitHub gateway, which the unit setup
 * replaces with a stub, and record every URL it fetches.
 */
async function authenticateForReal(token: string) {
  const { default: Github } = await vi.importActual<
    typeof import('../../src/api/services/gateways/github.js')
  >('../../src/api/services/gateways/github.js');
  vi.stubEnv('IS_TEST', 'false');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const user = await Github.authenticate(token);
  const urls = fetchSpy.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input),
  );
  return { user, urls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('private GHCR manifest auth', () => {
  it(
    'resolves the linux/amd64 manifest digest for a private GHCR image',
    async () => {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error(
          'GITHUB_TOKEN is required for the private GHCR auth canary. In CI, set it from E2E_SERVE_GITHUB_TOKEN.',
        );
      }

      const image = currentDepsImage();
      const result = await inspectImage(image, githubToken);

      if (result.verdict === ImageVerdict.NotFound) {
        throw new Error(
          `${image} does not exist. Build API deps base publishes it after a dependency change merges; to build it for this branch, run: gh workflow run build-deps-base.yml --ref <branch>`,
        );
      }
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.failureReason).toBeUndefined();
      expect(result.amd64Digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
    },
    NET_TIMEOUT_MS,
  );
});

describe('a token with exactly the login scopes (read:org read:packages)', () => {
  // A classic token with exactly read:org and read:packages.
  const token = () => requiredToken('E2E_GH_TOKEN_ORG_PACKAGES');

  it(
    'authenticates with the API without reading the account emails',
    async () => {
      const { user, urls } = await authenticateForReal(token());

      expect(user.username).not.toBe('');
      expect(urls).toContain('https://api.github.com/user');
      expect(urls.filter((url) => url.includes('/user/emails'))).toEqual([]);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'resolves a private org image and lists it among the org images',
    async () => {
      const result = await inspectImage(CI_PRIVATE_IMAGE, token());
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.amd64Digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const { packages, warnings } = await listGitHubPackages(token());
      expect(warnings).toEqual([]);
      expect(packages.map((pkg) => pkg.name)).toContain(
        'ghcr.io/anycloud-sh/ci-private',
      );
    },
    NET_TIMEOUT_MS,
  );
});

describe('a token with no scopes', () => {
  const token = () => requiredToken('E2E_GH_TOKEN_NO_SCOPE');

  it(
    'authenticates with the API but cannot read a private image',
    async () => {
      const { user } = await authenticateForReal(token());
      expect(user.username).not.toBe('');

      const result = await inspectImage(CI_PRIVATE_IMAGE, token());
      expect(result.verdict).not.toBe(ImageVerdict.Ok);
      expect(result.amd64Digest).toBeNull();
    },
    NET_TIMEOUT_MS,
  );
});
