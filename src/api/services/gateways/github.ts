import { createHash } from 'crypto';
import { Octokit } from '@octokit/rest';

import type { GithubSignIn, User } from '../entities.js';
import {
  isTestStubUser,
  TEST_USER_ID,
  TEST_USERNAMES,
} from '../test-identity.js';
import { GithubUnavailableError } from '../../../shared/errors.js';
import { getLoopbackApiPort } from '../../../shared/config.js';
import { GITHUB_LOGIN_SCOPES } from '../../../shared/hosted-api.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { assertRequestActive, awaitWithSignal } from '../request-budget.js';

function hasStatus(err: unknown): err is { status: unknown } {
  return typeof err === 'object' && err !== null && 'status' in err;
}

function statusOf(err: unknown): number {
  if (!hasStatus(err)) return 0;
  const n = typeof err.status === 'number' ? err.status : Number(err.status);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GitHub serves an HTML "Unicorn!" outage page (not JSON) during incidents, and
 * Octokit surfaces that whole page verbatim as the error message. Detect it so
 * we never relay it to the caller.
 */
export function looksLikeHtmlBody(message: string): boolean {
  const head = message.trimStart().slice(0, 512).toLowerCase();
  return head.includes('<!doctype') || head.includes('<html');
}

/** GitHub answers a rate limit with 429, or with a 403 that says so. */
function isRateLimit(err: unknown, status: number, message: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const headers =
    (err as { response?: { headers?: Record<string, unknown> } }).response
      ?.headers ?? {};
  return (
    headers['x-ratelimit-remaining'] === '0' ||
    headers['retry-after'] !== undefined ||
    /rate limit/i.test(message)
  );
}

/**
 * Map a failure from the GitHub auth calls onto a clean, caller-facing error.
 * Any 5xx, transport failure (Octokit reports these as status 500), or non-JSON
 * HTML body is upstream unavailability, and a rate limit is retryable the same
 * way. Any other 4xx (a bad or expired token) already carries Octokit's short,
 * actionable message, so it passes through unchanged.
 */
export function toGithubAuthError(err: unknown): Error {
  const status = statusOf(err);
  const message = errorMessage(err);
  if (status >= 500 || looksLikeHtmlBody(message)) {
    return new GithubUnavailableError(status || undefined);
  }
  if (isRateLimit(err, status, message)) {
    return new GithubUnavailableError(status, 'rate-limit');
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * A GitHub account resolved from a username. `type` matters because
 * `GET /users/{username}` answers for organizations and bots too, and neither
 * can ever authenticate against an API.
 */
export interface GithubAccount {
  id: string;
  username: string;
  type: string;
}

/**
 * A test token naming the account it presents. One API process serves every
 * caller, so a test identity cannot come from the server's environment — it has
 * to travel on the request, which is what lets an integration run act as two
 * different people against one API.
 */
const TEST_TOKEN_PREFIX = 'test-token:';

/**
 * The single source of stub identity, shared by both test-mode paths below.
 * `api access add <name>` and authenticating as `<name>` must agree on the id
 * or a grant would admit an account nobody can sign in as.
 *
 * Ids are derived from the username so they stay stable across API restarts,
 * and the canonical test user keeps the id `authenticate` hands out so adding
 * it collides with the owner as it would in production. The 1000 floor keeps
 * stub ids clear of the small owner ids the hosted-API tests assign.
 */
function stubIdentity(username: string): Pick<User, 'id' | 'username'> {
  const login = username.trim().toLowerCase();
  if (isTestStubUser(login)) {
    return { id: TEST_USER_ID, username: login };
  }
  const digest = createHash('sha256').update(login).digest('hex').slice(0, 8);
  return {
    id: String(1000 + (parseInt(digest, 16) % 1_000_000)),
    username: login,
  };
}

/**
 * Test-mode counterpart to the `authenticate` stub below. Without it the
 * integration harness's placeholder token turns every `api access add` into a
 * 401 from the real GitHub API.
 */
function stubResolvedUser(username: string): GithubAccount {
  return { ...stubIdentity(username), type: 'User' };
}

/**
 * Which stub account a test token presents. An unprefixed token — every token
 * the suites used before this existed — keeps the single default identity, so
 * only a run that opts in by naming an account sees more than one.
 */
function stubAuthenticatedUsername(accessToken: string): string {
  if (!accessToken.startsWith(TEST_TOKEN_PREFIX)) return TEST_USERNAMES[0];
  return (
    accessToken.slice(TEST_TOKEN_PREFIX.length).trim() || TEST_USERNAMES[0]
  );
}

/**
 * A fake GitHub on this machine, for the tests that run a hosted API without
 * `IS_TEST`. Any other URL is ignored, so the variable can't redirect a real
 * API's sign-in checks off the machine.
 */
function githubClient(auth: string, signal?: AbortSignal): Octokit {
  const baseUrl = process.env.ANYCLOUD_GITHUB_API_URL?.trim();
  return new Octokit({
    auth,
    request: { signal },
    ...(baseUrl && getLoopbackApiPort(baseUrl) !== undefined
      ? { baseUrl }
      : {}),
  });
}

// https://octokit.github.io/rest.js
export default class Github {
  static async resolveUser(
    accessToken: string,
    username: string,
  ): Promise<GithubAccount> {
    if (process.env.IS_TEST === 'true') {
      return stubResolvedUser(username);
    }

    const client = githubClient(accessToken);
    try {
      const response = await client.users.getByUsername({ username });
      return {
        id: String(response.data.id),
        username: response.data.login,
        type: response.data.type,
      };
    } catch (err) {
      throw toGithubAuthError(err);
    }
  }

  static async authenticate(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<GithubSignIn> {
    assertRequestActive(signal);
    // In test mode, bypass GitHub API and return a stub user. The token decides
    // which one, so a suite can exercise two callers against one API.
    if (process.env.IS_TEST === 'true') {
      return {
        ...stubIdentity(stubAuthenticatedUsername(accessToken)),
        scopes: GITHUB_LOGIN_SCOPES,
      };
    }
    const client = githubClient(accessToken, signal);
    try {
      const { data, headers } = await awaitWithSignal(
        client.users.getAuthenticated(),
        signal,
      );
      return {
        id: String(data.id),
        username: data.login,
        scopes: (headers['x-oauth-scopes'] ?? '')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean),
      };
    } catch (err) {
      assertRequestActive(signal);
      throw toGithubAuthError(err);
    }
  }
}
