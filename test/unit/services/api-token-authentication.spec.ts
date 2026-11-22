import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateApiToken } from '../../../src/api/services/api-authentication';
import { getDB } from '../../../src/api/services/repositories/db';
import {
  removeApiAccessUser,
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy';
import {
  exchangeApiToken,
  rotateApiToken,
} from '../../../src/api/services/repositories/api-tokens';
import { ApiAccessDeniedError } from '../../../src/shared/errors';

const MEMBER = { userId: '2', username: 'member', githubToken: 'gho_member' };

async function lastUsedAt(): Promise<number | null> {
  const [row] = await getDB().query<{ last_used_at: number | null }>(
    'SELECT last_used_at FROM api_tokens WHERE user_id = ?',
    [MEMBER.userId],
  );
  return row.last_used_at;
}

describe('hosted API token authentication', () => {
  beforeEach(async () => {
    await getDB().init?.();
    await getDB().query('DELETE FROM api_tokens');
    await getDB().query('DELETE FROM api_access_users');
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1');
    await upsertApiAccessUser({ userId: '2', username: 'member' });
  });

  afterEach(() => vi.restoreAllMocks());

  it('admits a token as its account, carrying the stored GitHub sign-in', async () => {
    const token = await exchangeApiToken(MEMBER);
    await expect(authenticateApiToken(token, undefined)).resolves.toEqual({
      id: '2',
      username: 'member',
      token: 'gho_member',
    });
  });

  it("admits a GitHub App sign-in's token without a GitHub sign-in", async () => {
    const token = await exchangeApiToken({ ...MEMBER, githubToken: null });
    await expect(authenticateApiToken(token, undefined)).resolves.toEqual({
      id: '2',
      username: 'member',
      token: null,
    });
  });

  it('refuses a GitHub token and names the login that replaces it', async () => {
    await expect(authenticateApiToken('gho_member', undefined)).rejects.toThrow(
      /not a GitHub token: .*anycloud login/u,
    );
  });

  it('cuts a rotated or removed token off on its next request', async () => {
    const token = await exchangeApiToken(MEMBER);
    const rotated = await rotateApiToken(MEMBER.userId);
    await expect(authenticateApiToken(token, undefined)).rejects.toThrow(
      'rotated or removed',
    );
    await removeApiAccessUser(MEMBER.userId);
    await expect(authenticateApiToken(rotated!, undefined)).rejects.toThrow(
      'rotated or removed',
    );
  });

  it('mints no token for an account the API no longer admits', async () => {
    // An exchange that passed the access check races the member's removal.
    await removeApiAccessUser(MEMBER.userId);
    await expect(exchangeApiToken(MEMBER)).rejects.toBeInstanceOf(
      ApiAccessDeniedError,
    );
    await expect(
      getDB().query('SELECT user_id FROM api_tokens'),
    ).resolves.toEqual([]);
  });

  it('admits no member while the owner predates durable ids', async () => {
    await getDB().query('UPDATE api_access_policy SET owner_user_id = NULL');
    await expect(exchangeApiToken(MEMBER)).rejects.toBeInstanceOf(
      ApiAccessDeniedError,
    );
  });

  it('checks the access policy on every request', async () => {
    const token = await exchangeApiToken(MEMBER);
    // A restore or a manual edit can leave a token without its allowlist entry.
    await getDB().query('DELETE FROM api_access_users');
    await expect(authenticateApiToken(token, undefined)).rejects.toBeInstanceOf(
      ApiAccessDeniedError,
    );
  });

  it('records use at most once an hour', async () => {
    const token = await exchangeApiToken(MEMBER);
    let now = Date.UTC(2026, 9, 10, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await authenticateApiToken(token, undefined);
    const first = await lastUsedAt();
    expect(first).toBe(now);
    now += 59 * 60 * 1000;
    await authenticateApiToken(token, undefined);
    expect(await lastUsedAt()).toBe(first);
    now += 60 * 1000;
    await authenticateApiToken(token, undefined);
    expect(await lastUsedAt()).toBe(now);
  });
});
