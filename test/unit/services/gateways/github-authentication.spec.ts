import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  getByUsername: vi.fn(),
  octokit: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: mocks.octokit.mockImplementation(function () {
    return {
      users: {
        getAuthenticated: mocks.getAuthenticated,
        getByUsername: mocks.getByUsername,
      },
    };
  }),
}));

vi.unmock('../../../../src/api/services/gateways/github.js');

import Github from '../../../../src/api/services/gateways/github.js';
import { GithubUnavailableError } from '../../../../src/shared/errors.js';
import {
  TEST_USER_ID,
  TEST_USERNAMES,
} from '../../../../src/api/services/test-identity.js';

function requestError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('GitHub authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IS_TEST', 'false');
    mocks.getAuthenticated.mockResolvedValue({
      data: { id: 583231, login: 'octocat' },
      headers: { 'x-oauth-scopes': 'read:org, read:packages' },
    });
    mocks.getByUsername.mockResolvedValue({
      data: { id: 42, login: 'canonical-user' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports the account and the scopes GitHub lists for the token', async () => {
    await expect(Github.authenticate('gho_token')).resolves.toEqual({
      id: '583231',
      username: 'octocat',
      scopes: ['read:org', 'read:packages'],
    });
    mocks.getAuthenticated.mockResolvedValueOnce({
      data: { id: 583231, login: 'octocat' },
      headers: {},
    });
    await expect(Github.authenticate('github_pat_token')).resolves.toEqual(
      expect.objectContaining({ scopes: [] }),
    );
  });

  it('asks GitHub every time, so a revoked token stops working at once', async () => {
    await Github.authenticate('gho_token');
    mocks.getAuthenticated.mockRejectedValueOnce(
      requestError(401, 'Bad credentials'),
    );
    await expect(Github.authenticate('gho_token')).rejects.toThrow(
      'Bad credentials',
    );
  });

  it('reports an outage or a rate limit as retryable', async () => {
    for (const error of [
      requestError(503, 'outage'),
      requestError(429, 'Too Many Requests'),
    ]) {
      mocks.getAuthenticated.mockRejectedValueOnce(error);
      await expect(Github.authenticate('gho_token')).rejects.toBeInstanceOf(
        GithubUnavailableError,
      );
    }
  });

  it('asks a fake GitHub only at a loopback address', async () => {
    const baseUrls = async (url: string) => {
      vi.stubEnv('ANYCLOUD_GITHUB_API_URL', url);
      mocks.octokit.mockClear();
      await Github.authenticate('gho_token');
      return (mocks.octokit.mock.calls[0]?.[0] as { baseUrl?: string }).baseUrl;
    };
    await expect(baseUrls('http://127.0.0.1:4000')).resolves.toBe(
      'http://127.0.0.1:4000',
    );
    await expect(baseUrls('https://github.attacker.test')).resolves.toBe(
      undefined,
    );
  });

  it('resolves a supplied username to its canonical immutable identity', async () => {
    await expect(
      Github.resolveUser('owner-token', 'Canonical-User'),
    ).resolves.toEqual({
      id: '42',
      username: 'canonical-user',
    });
    expect(mocks.getByUsername).toHaveBeenCalledWith({
      username: 'Canonical-User',
    });
  });
});

describe('test-mode stub identities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IS_TEST', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the single default identity for an unnamed token', async () => {
    // Every suite predating named tokens passes an opaque placeholder; those
    // must keep seeing exactly one account.
    await expect(Github.authenticate('dummy-token-for-test')).resolves.toEqual(
      expect.objectContaining({
        id: TEST_USER_ID,
        username: TEST_USERNAMES[0],
      }),
    );
    await expect(Github.authenticate('test-token:')).resolves.toEqual(
      expect.objectContaining({ username: TEST_USERNAMES[0] }),
    );
  });

  it('presents the account a named token asks for', async () => {
    const teammate = await Github.authenticate('test-token:teammate');
    expect(teammate.username).toBe('teammate');
    expect(teammate.id).not.toBe(TEST_USER_ID);

    // Stable across calls, so an id granted in one request still authenticates
    // in the next.
    const again = await Github.authenticate('test-token:teammate');
    expect(again.id).toBe(teammate.id);
  });

  it('resolves and authenticates the same account to the same id', async () => {
    // The property the whole mechanism rests on: `api access add teammate`
    // grants the id that `test-token:teammate` later signs in as. If these
    // drifted, a grant would admit an account nobody could authenticate as.
    const resolved = await Github.resolveUser('any-token', 'Teammate');
    const authenticated = await Github.authenticate('test-token:teammate');

    expect(resolved.id).toBe(authenticated.id);
    expect(resolved.username).toBe(authenticated.username);
  });

  it('gives different accounts different ids', async () => {
    const a = await Github.authenticate('test-token:alice');
    const b = await Github.authenticate('test-token:bob');
    expect(a.id).not.toBe(b.id);
  });
});
