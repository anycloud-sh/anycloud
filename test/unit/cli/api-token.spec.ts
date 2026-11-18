import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalApiContainerInspection } from '../../../src/shared/local-api-container.js';

const LOCAL_API_TOKEN = 'd'.repeat(64);
const GITHUB_SIGN_IN = 'gho_api_token_spec';
const GITHUB_HEADER = 'anycloud-github-token';

const inspectLocalApiContainer = vi.fn(
  (): LocalApiContainerInspection => ({ running: true, hostPort: 8080 }),
);
vi.mock('../../../src/shared/local-api-container.js', async (original) => ({
  ...(await original<
    typeof import('../../../src/shared/local-api-container.js')
  >()),
  inspectLocalApiContainer: () => inspectLocalApiContainer(),
}));

let anycloudDir: string;

// A terminal session: a sign-in a command still needs is reported, not relayed.
vi.mock('../../../src/cli/session/detect.js', async (original) => ({
  ...(await original<typeof import('../../../src/cli/session/detect.js')>()),
  isUnattended: () => false,
}));

async function loadAuth() {
  vi.resetModules();
  return import('../../../src/cli/services/auth.js');
}

/** Each request's auth headers; the API refuses it so nothing else runs. */
async function sentHeaders(apiUrl: string): Promise<Headers> {
  const { apiClient } = await loadAuth();
  let headers: Headers | undefined;
  const fetch = vi.fn(async (request: Request) => {
    headers = request.headers;
    return Response.json(
      { defined: true, code: 'UNAUTHORIZED', status: 401, message: 'no' },
      { status: 401 },
    );
  });
  const client = await apiClient({
    apiUrl,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  await expect(client.credentials.list()).rejects.toThrow();
  if (!headers) throw new Error('No request was sent');
  return headers;
}

describe('API token selection', () => {
  beforeEach(() => {
    anycloudDir = mkdtempSync(join(tmpdir(), 'anycloud-api-token-'));
    writeFileSync(join(anycloudDir, 'local-api-token'), LOCAL_API_TOKEN);
    vi.stubEnv('ANYCLOUD_DIR', anycloudDir);
    vi.stubEnv('GITHUB_TOKEN', GITHUB_SIGN_IN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(anycloudDir, { recursive: true, force: true });
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:8787', 'http://[::1]:9'])(
    'sends a loopback API (%s) its own token, with GitHub beside it',
    async (apiUrl) => {
      const headers = await sentHeaders(apiUrl);
      expect(headers.get('authorization')).toBe(`Bearer ${LOCAL_API_TOKEN}`);
      expect(headers.get(GITHUB_HEADER)).toBe(GITHUB_SIGN_IN);
    },
  );

  it('sends no GitHub header to a loopback API when signed out', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const headers = await sentHeaders('http://localhost:8080');
    expect(headers.get('authorization')).toBe(`Bearer ${LOCAL_API_TOKEN}`);
    expect(headers.get(GITHUB_HEADER)).toBeNull();
  });

  it('treats an unreadable saved sign-in as signed out for a local API', async () => {
    mkdirSync(join(anycloudDir, '.token')); // a directory can't be read as a file
    vi.stubEnv('GITHUB_TOKEN', '');
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const headers = await sentHeaders('http://localhost:8080');
      expect(headers.get('authorization')).toBe(`Bearer ${LOCAL_API_TOKEN}`);
      expect(headers.get(GITHUB_HEADER)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('inspects the default local API once per client, not per request', async () => {
    vi.stubEnv('IS_TEST', ''); // run the Docker pre-flight
    inspectLocalApiContainer.mockClear();
    const { apiClient } = await loadAuth();
    const { setPreFlightCheck } = await import(
      '../../../src/shared/services/api-client/runtime.js'
    );
    const { inspectLocalApiContainer: inspect } = await import(
      '../../../src/shared/local-api-container.js'
    );
    setPreFlightCheck(inspect);
    try {
      const fetch = vi.fn(async () => Response.json([]));
      const client = await apiClient({
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      await client.credentials.list();
      await client.credentials.list();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(inspectLocalApiContainer).toHaveBeenCalledTimes(1);
    } finally {
      setPreFlightCheck(null);
    }
  });

  describe('a refused connection to the default local API', () => {
    const refused = () =>
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      });

    async function listWith(fetch: ReturnType<typeof vi.fn>) {
      vi.stubEnv('IS_TEST', ''); // run the Docker pre-flight
      const { apiClient } = await loadAuth();
      const { setPreFlightCheck } = await import(
        '../../../src/shared/services/api-client/runtime.js'
      );
      const { inspectLocalApiContainer: inspect } = await import(
        '../../../src/shared/local-api-container.js'
      );
      setPreFlightCheck(inspect);
      try {
        const client = await apiClient({
          fetch: fetch as unknown as typeof globalThis.fetch,
          retryDelayMs: 0,
        });
        return await client.credentials.list();
      } finally {
        setPreFlightCheck(null);
      }
    }

    it('stops at once when the API container has stopped', async () => {
      inspectLocalApiContainer
        .mockReset()
        .mockReturnValueOnce({ running: true, hostPort: 8080 })
        .mockReturnValue({ running: false, hostPort: null });
      const fetch = vi.fn(async () => {
        throw refused();
      });
      await expect(listWith(fetch)).rejects.toThrow('anycloud api start');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('rides out a restart Bun reports as ConnectionRefused', async () => {
      inspectLocalApiContainer
        .mockReset()
        .mockReturnValue({ running: true, hostPort: 8080 });
      const bunRefused = () =>
        Object.assign(new Error('Unable to connect'), {
          code: 'ConnectionRefused',
        });
      const fetch = vi.fn();
      for (let i = 0; i < 5; i += 1) fetch.mockRejectedValueOnce(bunRefused());
      fetch.mockResolvedValue(Response.json([]));
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await expect(listWith(fetch)).resolves.toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(6);
    });

    it('rides out a restart while the container runs', async () => {
      inspectLocalApiContainer
        .mockReset()
        .mockReturnValue({ running: true, hostPort: 8080 });
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValue(Response.json([]));
      await expect(listWith(fetch)).resolves.toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('a missing local API token, checked against Docker', () => {
    async function missingTokenMessage(running: boolean): Promise<string> {
      rmSync(join(anycloudDir, 'local-api-token'));
      vi.stubEnv('IS_TEST', ''); // run the Docker pre-flight
      inspectLocalApiContainer
        .mockReset()
        .mockReturnValue({ running, hostPort: running ? 8080 : null });
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { apiClient } = await loadAuth();
      const { setPreFlightCheck } = await import(
        '../../../src/shared/services/api-client/runtime.js'
      );
      const { inspectLocalApiContainer: inspect } = await import(
        '../../../src/shared/local-api-container.js'
      );
      setPreFlightCheck(inspect);
      try {
        await expect(
          apiClient({ apiUrl: 'http://localhost:8080' }),
        ).rejects.toThrow('process.exit:1');
        return stderr.mock.calls.flat().join(' ');
      } finally {
        setPreFlightCheck(null);
        exit.mockRestore();
        stderr.mockRestore();
      }
    }

    it('names `anycloud update` for a running API from an earlier release', async () => {
      const message = await missingTokenMessage(true);
      expect(message).toContain('from an earlier release');
      expect(message).toContain('`anycloud update`');
    });

    it('names `anycloud api start` when no API is running', async () => {
      const message = await missingTokenMessage(false);
      expect(message).toContain(
        'No local API is running. Run `anycloud api start`.',
      );
      expect(message).not.toContain('anycloud update');
    });
  });

  it('names `anycloud api start` when the local token is missing', async () => {
    rmSync(join(anycloudDir, 'local-api-token'));
    vi.stubEnv('IS_TEST', 'true'); // skip the Docker pre-flight
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { apiClient } = await loadAuth();
      await expect(
        apiClient({ apiUrl: 'http://localhost:8080' }),
      ).rejects.toThrow('process.exit:1');
      expect(stderr.mock.calls.flat().join(' ')).toContain(
        '`anycloud api start`',
      );
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  describe('a hosted API', () => {
    const API_TOKEN = `acapi_${'a'.repeat(43)}`;

    /** Records each request's bearer; `exchange` answers the token exchange. */
    function hostedApi(exchange: () => Response) {
      const seen: Array<{ path: string; bearer: string | null }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request | string, init?: RequestInit) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          expect([...request.headers.values()].join(' ')).not.toContain(
            LOCAL_API_TOKEN,
          );
          expect(request.headers.get(GITHUB_HEADER)).toBeNull();
          const path = new URL(request.url).pathname;
          seen.push({ path, bearer: request.headers.get('authorization') });
          return path === '/v1/api-token' ? exchange() : Response.json([]);
        }),
      );
      return seen;
    }

    async function listTwice(apiUrl: string): Promise<void> {
      const { apiClient } = await loadAuth();
      for (let i = 0; i < 2; i += 1) {
        await (await apiClient({ apiUrl })).credentials.list();
      }
    }

    afterEach(() => vi.unstubAllGlobals());

    it.each([
      'https://api.example.com',
      'https://abc123.anycloud.sh',
      'http://devbox:8080',
    ])(
      'exchanges the sign-in once and sends %s only its own token',
      async (apiUrl) => {
        const seen = hostedApi(() => Response.json({ token: API_TOKEN }));
        await listTwice(apiUrl);
        expect(seen).toEqual([
          { path: '/v1/api-token', bearer: `Bearer ${GITHUB_SIGN_IN}` },
          { path: '/v1/credentials', bearer: `Bearer ${API_TOKEN}` },
          { path: '/v1/credentials', bearer: `Bearer ${API_TOKEN}` },
        ]);
        const saved = join(anycloudDir, 'api-tokens.json');
        expect(statSync(saved).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual({
          [apiUrl.replace(/\/$/u, '')]: API_TOKEN,
        });
      },
    );

    it.each([
      ['has no exchange route', () => new Response('', { status: 404 })],
      [
        'refuses this version before routing',
        () =>
          Response.json(
            {
              defined: true,
              code: 'CLIENT_VERSION_MISMATCH',
              status: 400,
              message: 'mismatch',
            },
            { status: 400 },
          ),
      ],
    ])(
      'sends its sign-in to an API older than API tokens that %s',
      async (_case, exchange) => {
        const seen = hostedApi(exchange);
        await listTwice('https://old.anycloud.sh');
        expect(seen.filter(({ path }) => path !== '/v1/api-token')).toEqual([
          { path: '/v1/credentials', bearer: `Bearer ${GITHUB_SIGN_IN}` },
          { path: '/v1/credentials', bearer: `Bearer ${GITHUB_SIGN_IN}` },
        ]);
        expect(existsSync(join(anycloudDir, 'api-tokens.json'))).toBe(false);
      },
    );

    it('replaces a damaged token file with the next exchange', async () => {
      writeFileSync(join(anycloudDir, 'api-tokens.json'), '{"half":');
      const seen = hostedApi(() => Response.json({ token: API_TOKEN }));
      await listTwice('https://api.example.com');
      expect(seen[0]?.path).toBe('/v1/api-token');
      expect(
        JSON.parse(readFileSync(join(anycloudDir, 'api-tokens.json'), 'utf8')),
      ).toEqual({ 'https://api.example.com': API_TOKEN });
    });

    it('leaves the sign-in behind ANYCLOUD_API_TOKEN to its own login', async () => {
      vi.stubEnv('ANYCLOUD_API_TOKEN', API_TOKEN);
      vi.stubEnv('API_URL', 'https://api.example.com');
      const seen: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request | string, init?: RequestInit) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          seen.push(new URL(request.url).pathname);
          return Response.json(
            {
              defined: true,
              code: 'GITHUB_SIGN_IN_REQUIRED',
              status: 403,
              message: 'Your GitHub sign-in was rejected.',
            },
            { status: 403 },
          );
        }),
      );
      const { apiClient } = await loadAuth();
      const client = await apiClient({ apiUrl: 'https://api.example.com' });
      await expect(client.credentials.list()).rejects.toThrow('rejected');
      // This machine's GITHUB_TOKEN may be another account's: no exchange.
      expect(seen).toEqual(['/v1/credentials']);
    });

    it('takes ANYCLOUD_API_TOKEN only when API_URL names the same API', async () => {
      const fromEnv = `acapi_${'e'.repeat(43)}`;
      vi.stubEnv('ANYCLOUD_API_TOKEN', fromEnv);
      vi.stubEnv('API_URL', 'https://api.example.com/');
      const seen = hostedApi(() => Response.json({ token: API_TOKEN }));
      await listTwice('https://api.example.com');
      await listTwice('https://other.example.com');
      expect(seen.map(({ bearer }) => bearer)).toEqual([
        `Bearer ${fromEnv}`,
        `Bearer ${fromEnv}`,
        `Bearer ${GITHUB_SIGN_IN}`,
        `Bearer ${API_TOKEN}`,
        `Bearer ${API_TOKEN}`,
      ]);
    });
  });
});
