import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callApi, getTestApiUrl } from '../helpers/api-test-helper';
import { getDB } from '../../../src/api/services/repositories/db';
import {
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy';
import Github from '../../../src/api/services/gateways/github';
import { GITHUB_LOGIN_SCOPES as LOGIN_SCOPES } from '../../../src/shared/hosted-api';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import { log } from '../../../src/api/services/logger';
import { authenticateApiToken } from '../../../src/api/services/api-authentication';
import { getWorkloadApiUrl } from '../../../src/api/config';

const AUTH = { Authorization: 'Bearer owner-token' };

function apiAccessRequest(
  path = '',
  options: RequestInit = {},
): Promise<Response> {
  return callApi(`https://example.com/v1/api-access/users${path}`, {
    ...options,
    headers: { ...AUTH, ...options.headers },
  });
}

describe('hosted API access routes', () => {
  beforeAll(async () => {
    await getDB().init?.();
  });

  beforeEach(async () => {
    await getDB().query('DELETE FROM api_tokens');
    await getDB().query('DELETE FROM api_access_users');
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1');
    vi.mocked(Github.authenticate).mockReset();
    vi.mocked(Github.authenticate).mockResolvedValue({
      id: '1',
      username: 'owner',
      scopes: LOGIN_SCOPES,
    });
    vi.mocked(Github.resolveUser).mockReset();
    vi.mocked(Github.resolveUser).mockResolvedValue({
      id: '2',
      username: 'member',
      type: 'User',
    });
  });

  it('requires authentication', async () => {
    const response = await callApi('https://example.com/v1/api-access/users');
    expect(response.status).toBe(401);
  });

  it('adds a GitHub account and lists it alongside the owner', async () => {
    const added = await apiAccessRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Member' }),
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({
      kind: 'github',
      userId: '2',
      username: 'member',
    });
    expect(Github.resolveUser).toHaveBeenCalledWith('owner-token', 'Member');

    const listed = await apiAccessRequest();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      owner: { userId: '1', username: 'owner' },
      users: [{ kind: 'github', userId: '2', username: 'member' }],
    });
  });

  it('rejects an add request with no username', async () => {
    const missing = await apiAccessRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  });

  it('lists the owner once even when the allowlist also names them', async () => {
    // The owner is admitted by the policy, so an allowlist row for them is
    // inert. Adding one is accepted like any other add rather than treated as a
    // special case, and the listing still shows them exactly once.
    vi.mocked(Github.resolveUser).mockResolvedValueOnce({
      id: '1',
      username: 'owner',
      type: 'User',
    });
    const added = await apiAccessRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner' }),
    });
    expect(added.status).toBe(200);

    const listed = await apiAccessRequest();
    expect(await listed.json()).toEqual({
      owner: { userId: '1', username: 'owner' },
      users: [],
    });
  });

  it('drops an owner row seeded outside the API from the listing', async () => {
    await upsertApiAccessUser({ userId: '1', username: 'owner' });
    await upsertApiAccessUser({ userId: '2', username: 'member' });

    const listed = await apiAccessRequest();
    expect(await listed.json()).toEqual({
      owner: { userId: '1', username: 'owner' },
      users: [{ kind: 'github', userId: '2', username: 'member' }],
    });
  });

  it('refuses a GitHub account that is not a user', async () => {
    vi.mocked(Github.resolveUser).mockResolvedValueOnce({
      id: '9',
      username: 'acme-inc',
      type: 'Organization',
    });

    const response = await apiAccessRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'acme-inc' }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'acme-inc is a GitHub organization, not a user account',
    );
    expect(await getDB().query('SELECT user_id FROM api_access_users')).toEqual(
      [],
    );
  });

  it('names the login for this API when GitHub rejects the stored sign-in', async () => {
    vi.mocked(Github.resolveUser).mockRejectedValue(
      Object.assign(new Error('Bad credentials'), { status: 401 }),
    );
    const response = await apiAccessRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'member' }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('GITHUB_SIGN_IN_REQUIRED');
    expect(body.message).toContain(
      `Run \`anycloud login ${getWorkloadApiUrl()}\`, then retry.`,
    );
  });

  it('lets a member list access but not grant or remove it, even for the owner or themselves', async () => {
    await upsertApiAccessUser({ userId: '2', username: 'member' });
    await upsertApiAccessUser({ userId: '3', username: 'departing-member' });
    vi.mocked(Github.authenticate).mockResolvedValue({
      id: '2',
      username: 'member',
      scopes: LOGIN_SCOPES,
    });
    const before = {
      owner: { userId: '1', username: 'owner' },
      users: [
        { kind: 'github', userId: '3', username: 'departing-member' },
        { kind: 'github', userId: '2', username: 'member' },
      ],
    };
    const listed = await apiAccessRequest();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(before);

    for (const response of [
      await apiAccessRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'second-member' }),
      }),
      await apiAccessRequest('/3', { method: 'DELETE' }),
      await apiAccessRequest('/2', { method: 'DELETE' }),
      await apiAccessRequest('/1', { method: 'DELETE' }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'API_ACCESS_OWNER_REQUIRED',
        message:
          'Only the owner of this hosted API, owner, can grant or remove access',
      });
    }
    expect(Github.resolveUser).not.toHaveBeenCalled();
    expect(await (await apiAccessRequest()).json()).toEqual(before);
  });

  it('reconciles a response lost after a completed removal', async () => {
    await upsertApiAccessUser({ userId: '2', username: 'member' });
    const fetchImpl = globalThis.fetch.bind(globalThis);
    let attempts = 0;
    const loseFirstResponse: typeof fetch = async (input, init) => {
      attempts += 1;
      const response = await fetchImpl(input, init);
      if (attempts === 1) {
        await response.arrayBuffer();
        throw new TypeError('fetch failed after request was processed');
      }
      return response;
    };

    await expect(
      createApiClient('owner-token', {
        apiUrl: getTestApiUrl(),
        fetch: loseFirstResponse,
        retryDelayMs: 0,
      }).apiAccess.revoke({ params: { userId: '2' } }),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(2);
    await expect(
      apiAccessRequest().then((response) => response.json()),
    ).resolves.toMatchObject({ users: [] });
  });

  it('does not remove the hosted API owner', async () => {
    const response = await apiAccessRequest('/1', { method: 'DELETE' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('owner cannot be removed');
  });

  it('reports invalid removal targets and treats an absent user idempotently', async () => {
    const invalid = await apiAccessRequest('/not-an-id', { method: 'DELETE' });
    expect(invalid.status).toBe(400);

    const missing = await apiAccessRequest('/99', { method: 'DELETE' });
    expect(missing.status).toBe(204);
    expect(await missing.text()).toBe('');
  });

  it('rejects an unauthenticated caller before any allowlist work', async () => {
    const response = await callApi('https://example.com/v1/api-access/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'member' }),
    });
    expect(response.status).toBe(401);
  });

  it('reports that sharing does not apply on a local API', async () => {
    await getDB().query('DELETE FROM api_access_policy');

    const response = await apiAccessRequest();
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('only available on a hosted API');

    const removal = await apiAccessRequest('/2', { method: 'DELETE' });
    expect(removal.status).toBe(400);
    expect(await removal.text()).toContain('only available on a hosted API');
  });
});

describe('hosted API tokens', () => {
  const SIGN_IN = 'gho_owner_sign_in';

  function exchange(bearer = SIGN_IN): Promise<Response> {
    return callApi('https://example.com/v1/api-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    });
  }

  async function exchangedToken(): Promise<string> {
    const response = await exchange();
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(token).toMatch(/^acapi_[A-Za-z0-9_-]{43}$/u);
    return token;
  }

  beforeEach(async () => {
    await getDB().query('DELETE FROM api_tokens');
    await getDB().query('DELETE FROM api_access_users');
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1');
    vi.mocked(Github.authenticate).mockReset();
    vi.mocked(Github.authenticate).mockResolvedValue({
      id: '1',
      username: 'owner',
      scopes: LOGIN_SCOPES,
    });
  });

  it('returns one token for every exchange and logs each without it', async () => {
    const info = vi.spyOn(log, 'info');
    const token = await exchangedToken();
    await expect(exchangedToken()).resolves.toBe(token);
    const logged = info.mock.calls.filter(
      ([message]) => message === 'API token exchanged',
    );
    expect(logged).toHaveLength(2);
    for (const secret of [token, SIGN_IN])
      expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    info.mockRestore();
  });

  it('keeps the newest GitHub sign-in for GHCR, DNS and clusters', async () => {
    await exchangedToken();
    await exchange('gho_newer_sign_in');
    const [row] = await getDB().query<{ github_ciphertext: string }>(
      'SELECT github_ciphertext FROM api_tokens',
    );
    const { decryptSecret } = await import(
      '../../../src/api/services/secret-crypto'
    );
    await expect(decryptSecret(row.github_ciphertext)).resolves.toBe(
      'gho_newer_sign_in',
    );
  });

  it("refuses a personal access token without asking GitHub, and another app's scopes", async () => {
    const pat = await exchange('ghp_personal_access_token');
    expect(pat.status).toBe(401);
    expect(Github.authenticate).not.toHaveBeenCalled();

    vi.mocked(Github.authenticate).mockResolvedValue({
      id: '1',
      username: 'owner',
      scopes: ['repo', 'read:org', 'read:packages'],
    });
    const foreign = await exchange('gho_another_app');
    expect(foreign.status).toBe(401);
    expect(await foreign.text()).toContain('anycloud login');
    expect(await getDB().query('SELECT user_id FROM api_tokens')).toEqual([]);
  });

  it('names `anycloud login` for a sign-in GitHub rejects', async () => {
    vi.mocked(Github.authenticate).mockRejectedValue(
      Object.assign(new Error('Bad credentials'), { status: 401 }),
    );
    const response = await exchange();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'GITHUB_SIGN_IN_REQUIRED',
    });
  });

  it('refuses an account the API does not admit', async () => {
    vi.mocked(Github.authenticate).mockResolvedValue({
      id: '7',
      username: 'stranger',
      scopes: LOGIN_SCOPES,
    });
    expect((await exchange()).status).toBe(403);
  });

  it('rotates the caller to a new token that later exchanges return', async () => {
    const token = await exchangedToken();
    const rotated = await callApi('https://example.com/v1/api-token/rotate', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-api-token' },
    });
    expect(rotated.status).toBe(200);
    const { token: replacement } = (await rotated.json()) as { token: string };
    expect(replacement).not.toBe(token);
    await expect(exchangedToken()).resolves.toBe(replacement);
  });
});

describe('GitHub App sign-ins', () => {
  // The backmesh App's id, as GET /user/installations reported it (run 44471531094).
  const APP = { id: 5622376, slug: 'backmesh' };

  function exchange(bearer: string): Promise<Response> {
    return callApi('https://example.com/v1/api-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    });
  }

  beforeEach(async () => {
    await getDB().query('DELETE FROM api_tokens');
    await getDB().query('DELETE FROM api_access_users');
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1', [APP.id]);
    vi.mocked(Github.authenticate).mockReset();
    // GitHub reports no OAuth scopes for an App's user token.
    vi.mocked(Github.authenticate).mockResolvedValue({
      id: '1',
      username: 'owner',
      scopes: [],
    });
    vi.mocked(Github.issuingApp).mockReset();
    vi.mocked(Github.issuingApp).mockResolvedValue(APP);
  });

  it("exchanges a listed App's user token and keeps no GitHub sign-in", async () => {
    const response = await exchange('ghu_app_sign_in');
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(token).toMatch(/^acapi_/u);
    expect(Github.issuingApp).toHaveBeenCalledWith(
      'ghu_app_sign_in',
      expect.anything(),
    );
    expect(
      await getDB().query('SELECT user_id, github_ciphertext FROM api_tokens'),
    ).toEqual([{ user_id: '1', github_ciphertext: null }]);
    // Requests with the API token carry no GitHub sign-in to GHCR, DNS or clusters.
    await expect(authenticateApiToken(token, undefined)).resolves.toEqual({
      id: '1',
      username: 'owner',
      token: null,
    });
  });

  it('forgets an OAuth sign-in kept earlier once the account signs in through an App', async () => {
    vi.mocked(Github.authenticate).mockResolvedValueOnce({
      id: '1',
      username: 'owner',
      scopes: LOGIN_SCOPES,
    });
    expect((await exchange('gho_owner_sign_in')).status).toBe(200);
    expect((await exchange('ghu_app_sign_in')).status).toBe(200);
    expect(
      await getDB().query('SELECT github_ciphertext FROM api_tokens'),
    ).toEqual([{ github_ciphertext: null }]);
  });

  it('refuses a user token from an App the API does not list, naming it', async () => {
    vi.mocked(Github.issuingApp).mockResolvedValue({ id: 99, slug: 'other' });
    const response = await exchange('ghu_other_app');
    expect(response.status).toBe(401);
    expect(await response.text()).toContain(
      'GitHub App other (id 99), which this API does not accept',
    );
    expect(await getDB().query('SELECT user_id FROM api_tokens')).toEqual([]);
  });

  it('refuses a user token that reaches no installation of its App', async () => {
    vi.mocked(Github.issuingApp).mockResolvedValue(null);
    const response = await exchange('ghu_no_installation');
    expect(response.status).toBe(401);
    expect(await response.text()).toContain(
      'reaches no installation of its GitHub App',
    );
    expect(await getDB().query('SELECT user_id FROM api_tokens')).toEqual([]);
  });

  it('refuses App user tokens on an API that lists no App, naming how to list one', async () => {
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1');
    const response = await exchange('ghu_app_sign_in');
    expect(response.status).toBe(401);
    expect(await response.text()).toContain(
      'This API accepts no GitHub App sign-in; its owner lists one with `anycloud api upgrade --sign-in-apps <id>`.',
    );
  });

  it("accepts a listed App's user token once an existing API's owner lists it", async () => {
    await getDB().query('DELETE FROM api_access_policy');
    // An API created before App sign-ins: its policy lists none.
    await upsertApiAccessOwner('owner', '1');
    expect((await exchange('ghu_app_sign_in')).status).toBe(401);

    const set = (bearer: string) =>
      callApi('https://example.com/v1/api-access/github-apps', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ githubAppIds: [APP.id] }),
      });
    vi.mocked(Github.authenticate).mockResolvedValueOnce({
      id: '2',
      username: 'member',
      scopes: LOGIN_SCOPES,
    });
    expect((await set('member-token')).status).toBe(403);
    vi.mocked(Github.authenticate).mockResolvedValueOnce({
      id: '1',
      username: 'owner',
      scopes: LOGIN_SCOPES,
    });
    const response = await set('owner-token');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ githubAppIds: [APP.id] });

    expect((await exchange('ghu_app_sign_in')).status).toBe(200);
  });

  it.each(['ghp_personal', 'github_pat_fine_grained', 'ghs_installation'])(
    'refuses %s without asking GitHub',
    async (bearer) => {
      const response = await exchange(bearer);
      expect(response.status).toBe(401);
      expect(Github.authenticate).not.toHaveBeenCalled();
      expect(Github.issuingApp).not.toHaveBeenCalled();
    },
  );
});
