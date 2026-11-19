import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { callApi } from '../helpers/api-test-helper.js';
import { createHostedApiAuthentication } from '../../../src/api/services/api-authentication.js';
import Github from '../../../src/api/services/gateways/github.js';
import {
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { GITHUB_LOGIN_SCOPES } from '../../../src/shared/hosted-api.js';

const TOKEN_PATTERN = /^acapi_[A-Za-z0-9_-]{43}$/u;
const authenticate = createHostedApiAuthentication({
  listServiceAccounts: async () => [],
  clusters: {
    resolve: () => Promise.reject(new Error('no cluster expected')),
  },
});

function asCaller(id: string, username: string): void {
  vi.mocked(Github.authenticate).mockResolvedValue({
    id,
    username,
    scopes: GITHUB_LOGIN_SCOPES,
  });
}

function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return callApi(`https://example.com/v1/api-access${path}`, {
    method,
    headers: {
      Authorization: 'Bearer caller',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function issue(name: string): Promise<string> {
  const response = await request('/services', 'POST', { name });
  expect(response.status).toBe(200);
  const issued = (await response.json()) as Record<string, unknown>;
  expect(issued).toEqual({
    kind: 'service',
    userId: `service:${name}`,
    username: name,
    token: expect.stringMatching(TOKEN_PATTERN),
  });
  return issued.token as string;
}

const refusal = (token: string) =>
  authenticate(token, undefined).then(
    () => 'admitted',
    (error: Error) => error.message,
  );

describe('owner-issued service tokens', () => {
  beforeAll(async () => {
    await getDB().init?.();
  });

  beforeEach(async () => {
    await getDB().query('DELETE FROM api_tokens');
    await getDB().query('DELETE FROM api_access_users');
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1');
    await upsertApiAccessUser({ userId: '2', username: 'member' });
    vi.mocked(Github.authenticate).mockReset();
    asCaller('1', 'owner');
  });

  it('admits an issued token as its service, keeping only its hash', async () => {
    const token = await issue('ci');

    await expect(authenticate(token, undefined)).resolves.toEqual({
      id: 'service:ci',
      username: 'ci',
      token: null,
    });
    const stored = JSON.stringify(
      await getDB().query('SELECT * FROM api_access_users'),
    );
    expect(stored).not.toContain(token);
    expect(await (await request('/users', 'GET')).json()).toEqual({
      owner: { userId: '1', username: 'owner' },
      users: [
        { kind: 'service', userId: 'service:ci', username: 'ci' },
        { kind: 'github', userId: '2', username: 'member' },
      ],
    });
  });

  it('rotation and removal refuse the previous token on its next request', async () => {
    const first = await issue('ci');
    const rotated = await request('/services/ci/token', 'POST');
    expect(rotated.status).toBe(200);
    const { token: second } = (await rotated.json()) as { token: string };
    expect(second).toMatch(TOKEN_PATTERN);

    expect(await refusal(first)).toContain('rotated or removed');
    expect(await refusal(second)).toBe('admitted');

    expect(
      (await request(`/users/${encodeURIComponent('service:ci')}`, 'DELETE'))
        .status,
    ).toBe(204);
    expect(await refusal(second)).toContain('rotated or removed');
  });

  it('refuses a second issue, an unknown rotation and a GitHub login’s name', async () => {
    await issue('ci');
    const cases: [string, unknown, number, string][] = [
      ['/services', { name: 'ci' }, 409, 'API_ACCESS_SERVICE_EXISTS'],
      ['/services/nope/token', undefined, 404, 'API_ACCESS_SERVICE_NOT_FOUND'],
      ['/services', { name: 'member' }, 400, 'API_ACCESS_NAME_TAKEN'],
      ['/services', { name: 'owner' }, 400, 'API_ACCESS_NAME_TAKEN'],
      ['/services', { name: 'Not_A-Name' }, 400, 'BAD_REQUEST'],
    ];
    for (const [path, body, status, code] of cases) {
      const response = await request(path, 'POST', body);
      expect(response.status, path).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
  });

  it('lets only the owner issue or rotate, not a member or a service', async () => {
    await issue('ci');
    for (const [id, username] of [
      ['2', 'member'],
      ['service:ci', 'ci'],
    ] as const) {
      asCaller(id, username);
      for (const response of [
        await request('/services', 'POST', { name: 'other' }),
        await request('/services/ci/token', 'POST'),
        await request(`/users/${encodeURIComponent('service:ci')}`, 'DELETE'),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: 'API_ACCESS_OWNER_REQUIRED',
        });
      }
    }
  });
});
