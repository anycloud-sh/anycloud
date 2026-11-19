import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const LOGIN_SCOPES = 'read:org, read:packages';

/**
 * A GitHub token for `login` as this fake reads it back:
 * - `anycloud`: what `anycloud login` gets, `gho_` with exactly its scopes;
 *   a `renewal` is the token a later login gets for the same account;
 * - `pat`: a classic personal access token with `repo`;
 * - `foreign`: another OAuth app's `gho_` with other scopes.
 */
export function githubToken(
  login: string,
  kind: 'anycloud' | 'pat' | 'foreign' = 'anycloud',
  renewal?: number,
): string {
  if (kind === 'pat') return `ghp_${login}`;
  if (kind === 'foreign') return `gho_${login}~repo,user`;
  return renewal === undefined ? `gho_${login}` : `gho_${login}.${renewal}`;
}

/** The GitHub App whose user tokens hosted fixtures list for sign-in. */
export const SIGN_IN_APP_ID = 5622376;

/**
 * A GitHub App's user token for `login`, reaching one installation of App
 * `appId`; App 0's token reaches none.
 */
export function appUserToken(login: string, appId: number): string {
  return `ghu_${login}@${appId}`;
}

/** Ids the hosted fixtures name as owners; anyone else gets a stable hash. */
const KNOWN_IDS: Readonly<Record<string, string>> = {
  'anycloud-test': '1',
  'hosted-owner': '2',
};

function accountId(login: string): string {
  const digest = createHash('sha256').update(login).digest('hex').slice(0, 8);
  return KNOWN_IDS[login] ?? String(1000 + (parseInt(digest, 16) % 1_000_000));
}

function account(
  token: string,
): { login: string; scopes: string | null; appId?: number } | null {
  const app = /^ghu_([a-z0-9-]+)@(\d+)$/u.exec(token);
  if (app) return { login: app[1], scopes: null, appId: Number(app[2]) };
  const match = /^(gho|ghp)_([a-z0-9-]+)(?:~([a-z:,]+)|\.\d+)?$/u.exec(token);
  if (!match) return null;
  const [, prefix, login, scopes] = match;
  if (prefix === 'ghp') return { login, scopes: 'repo' };
  return {
    login,
    scopes: scopes ? scopes.split(',').join(', ') : LOGIN_SCOPES,
  };
}

/**
 * The GitHub REST routes a hosted API calls: `GET /user` for the caller, with
 * the `X-OAuth-Scopes` header GitHub sends for OAuth and classic tokens (not
 * for an App's user token), `GET /user/installations`, which lists only the
 * issuing App's installations, and `GET /users/{login}` for `api access add`. The CLI's device flow, pointed
 * here by `ANYCLOUD_GITHUB_URL`, gets a code that is never approved.
 */
export class FakeGithub {
  readonly #server: Server;
  readonly #revoked: Set<string>;
  readonly url: string;

  private constructor(server: Server, revoked: Set<string>, url: string) {
    this.#server = server;
    this.#revoked = revoked;
    this.url = url;
  }

  /** GitHub stops accepting `token`, as when its grant is revoked or capped. */
  revoke(token: string): void {
    this.#revoked.add(token);
  }

  static async start(): Promise<FakeGithub> {
    const revoked = new Set<string>();
    const server = createServer((request, response) => {
      const send = (
        status: number,
        body: unknown,
        headers: Record<string, string> = {},
      ) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          ...headers,
        });
        response.end(JSON.stringify(body));
      };
      const path = new URL(request.url ?? '/', 'http://github').pathname;
      if (path === '/login/device/code') {
        send(200, {
          device_code: 'fake-device-code',
          user_code: 'FAKE-CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
        return;
      }
      if (path === '/login/oauth/access_token') {
        send(200, { error: 'authorization_pending' });
        return;
      }
      const token = /^(?:token|bearer)\s+(.+)$/iu.exec(
        request.headers.authorization ?? '',
      )?.[1];
      const caller = token && !revoked.has(token) ? account(token) : null;
      if (!caller) {
        send(401, { message: 'Bad credentials' });
        return;
      }
      if (path === '/user') {
        send(
          200,
          {
            id: Number(accountId(caller.login)),
            login: caller.login,
            company: null,
          },
          caller.scopes === null ? {} : { 'x-oauth-scopes': caller.scopes },
        );
        return;
      }
      if (path === '/user/installations') {
        if (caller.appId === undefined) {
          send(403, {
            message:
              'You must authenticate with an access token authorized to a GitHub App in order to list installations',
          });
          return;
        }
        const installations = caller.appId
          ? [{ id: 1, app_id: caller.appId, app_slug: `app-${caller.appId}` }]
          : [];
        send(200, { total_count: installations.length, installations });
        return;
      }
      const named = /^\/users\/([a-z0-9-]+)$/u.exec(path)?.[1];
      if (named) {
        send(200, {
          id: Number(accountId(named)),
          login: named,
          type: 'User',
        });
        return;
      }
      send(404, { message: 'Not Found' });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return new FakeGithub(server, revoked, `http://127.0.0.1:${address.port}`);
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
