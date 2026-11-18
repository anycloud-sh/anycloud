/**
 * Runs a CLI binary against an in-process fake API, with one output stream
 * piped into a slow reader, to catch output lost when the reader lags.
 *
 * The fake API touches a marker file named by each random UUID it receives as
 * the bearer (the run's local API token) or as the GitHub sign-in, when it
 * answers. The reader waits for that marker, then sleeps while the CLI
 * prints, so the delay starts when output is about to be written.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeLocalApiToken } from './local-api-token.js';

export interface Reply {
  status?: number;
  body: unknown;
  /** Writes the response itself, such as an endless NDJSON log stream. */
  stream?: (res: ServerResponse) => void;
}

/** Answers a request to a matching path, or returns undefined to pass it on. */
export type Route = (url: URL) => Reply | undefined;

export interface FakeApi {
  url: string;
  home: string;
  close(): Promise<void>;
}

/** A page of bucket objects, honouring the CLI's `pageSize` and `cursor`. */
export function pagedObjects(entries: readonly unknown[]): Route {
  return (url) => {
    if (
      !/^\/v1\/credentials\/[^/]+\/buckets\/[^/]+\/objects$/.test(url.pathname)
    ) {
      return undefined;
    }
    const size = Number(url.searchParams.get('pageSize') ?? 1000);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const end = start + size;
    return {
      body: {
        entries: entries.slice(start, end),
        nextCursor: end < entries.length ? String(end) : null,
      },
    };
  };
}

/** Serves `body` for an exact path. */
export function at(pathname: string, reply: Reply): Route {
  return (url) => (url.pathname === pathname ? reply : undefined);
}

/** An oRPC error envelope, which the CLI surfaces as the error message. */
export function orpcError(status: number, message: string): Reply {
  return {
    status,
    body: { defined: false, code: 'BAD_REQUEST', status, message },
  };
}

/** Starts the fake API; the first route that answers a request wins. */
export async function startFakeApi(routes: Route[]): Promise<FakeApi> {
  const home = await mkdtemp(join(tmpdir(), 'anycloud-piped-'));
  // What `api start` writes for the CLIs that use the shared ANYCLOUD_DIR.
  writeLocalApiToken(join(home, '.anycloud'), 'piped-local-api');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://api');
    const reply = routes.reduce<Reply | undefined>(
      (found, route) => found ?? route(url),
      undefined,
    ) ?? { status: 404, body: { message: `no fake for ${url.pathname}` } };
    const github = req.headers['anycloud-github-token'];
    for (const token of [
      req.headers.authorization?.replace('Bearer ', ''),
      typeof github === 'string' ? github : undefined,
    ])
      if (token && /^[0-9a-f-]{36}$/.test(token))
        writeFileSync(join(home, token), '');
    if (reply.stream) return reply.stream(res);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    home,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    },
  };
}

export interface PipedRun {
  /** What the slow reader received from the piped stream. */
  output: string;
  /** The CLI's own exit code. */
  exitCode: number;
}

/**
 * Runs `binary` with `args`, piping `stream` into the slow reader and
 * discarding the other stream. `env` overrides the inherited environment; an
 * undefined value unsets a variable.
 */
export async function runPiped(
  api: FakeApi,
  binary: string,
  args: readonly string[],
  stream: 'stdout' | 'stderr' = 'stdout',
  env: Record<string, string | undefined> = {},
): Promise<PipedRun> {
  const token = randomUUID();
  const marker = join(api.home, token);
  // The run's own local API token, so every route it calls leaves the marker.
  const anycloudDir = join(api.home, `anycloud-${token}`);
  writeLocalApiToken(anycloudDir, token);
  const redirect = stream === 'stdout' ? '2>/dev/null' : '2>&1 >/dev/null';
  const script = [
    // Wait at most 10 s, so a CLI that never calls the API fails, not hangs.
    `"$@" ${redirect} | (for _ in {1..200}; do [ -e "${marker}" ] && break; sleep 0.05; done; sleep 0.5; cat)`,
    `echo "\${PIPESTATUS[0]}" > "${marker}.exit"`,
  ].join('\n');
  const { stdout } = await promisify(execFile)(
    'bash',
    ['-c', script, 'bash', binary, ...args],
    {
      env: {
        // Drop the caller's ANYCLOUD_* settings: ANYCLOUD_DIR would point the
        // CLI at a real token file, and others change what commands do.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !k.startsWith('ANYCLOUD_'),
          ),
        ),
        ANYCLOUD_DIR: anycloudDir,
        HOME: api.home,
        API_URL: api.url,
        GITHUB_TOKEN: token,
        IS_TEST: 'true',
        ...env,
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return {
    output: stdout,
    exitCode: Number(await readFile(`${marker}.exit`, 'utf8')),
  };
}
