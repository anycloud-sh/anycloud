import { beforeEach, describe, expect, it } from 'vitest';
import { callApi, getTestApiUrl } from '../helpers/api-test-helper';
import {
  getCredentialSecretStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';

const AUTH = { Authorization: 'Bearer mock-github-token' };

function putSecret(
  name: string,
  body: Record<string, unknown>,
  authenticated = true,
): Promise<Response> {
  return callApi(`https://example.com/v1/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: {
      ...(authenticated ? AUTH : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function deleteSecret(name: string): Promise<Response> {
  return callApi(`https://example.com/v1/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: AUTH,
  });
}

describe('secrets HTTP', () => {
  beforeEach(() => resetPersistence());

  it('uses Bearer auth instead of accepting a legacy body token', async () => {
    const response = await putSecret(
      'model-token',
      {
        accessToken: 'legacy-body-token',
        values: { TOKEN: 'secret' },
      },
      false,
    );

    expect(response.status).toBe(401);
    await expect(
      getCredentialSecretStore().getSecretValues('model-token'),
    ).resolves.toBeNull();

    const queryToken = await callApi(
      'https://example.com/v1/secrets?accessToken=legacy-query-token',
      { headers: AUTH },
    );
    expect(queryToken.status).toBe(400);
  });

  it('accepts one leading underscore and still refuses other leading characters', async () => {
    for (const name of ['_job-1-token', 'a', `_${'a'.repeat(63)}`])
      expect((await putSecret(name, { values: { K: 'v' } })).status).toBe(204);
    for (const name of ['__x', '_-x', '-x', '_', `_${'a'.repeat(64)}`])
      expect((await putSecret(name, { values: { K: 'v' } })).status).toBe(400);
  });

  it('replaces one canonical resource without exposing its values', async () => {
    const first = await putSecret('model-token', {
      values: { TOKEN: 'first' },
    });
    const replacement = await putSecret('model-token', {
      values: { TOKEN: 'second' },
    });

    expect(first.status, await first.clone().text()).toBe(204);
    expect(replacement.status, await replacement.clone().text()).toBe(204);
    await expect(
      getCredentialSecretStore().getSecretValues('model-token'),
    ).resolves.toEqual({ TOKEN: 'second' });

    const listed = await callApi('https://example.com/v1/secrets', {
      headers: AUTH,
    });
    expect(listed.status).toBe(200);
    const payload = await listed.json();
    expect(payload).toEqual([expect.objectContaining({ name: 'model-token' })]);
    expect(JSON.stringify(payload)).not.toContain('second');
    expect(JSON.stringify(payload)).not.toContain('values');
  });

  it('reconciles a lost PUT response by replaying the same representation', async () => {
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
      createApiClient('mock-github-token', {
        apiUrl: getTestApiUrl(),
        fetch: loseFirstResponse,
        retryDelayMs: 0,
      }).secrets.save({
        params: { name: 'model-token' },
        body: { values: { TOKEN: 'stable' } },
      }),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(2);
    await expect(
      getCredentialSecretStore().getSecretValues('model-token'),
    ).resolves.toEqual({ TOKEN: 'stable' });
  });

  it('rejects body identity and treats repeated deletion as success', async () => {
    const duplicatedIdentity = await putSecret('model-token', {
      name: 'different-token',
      values: { TOKEN: 'secret' },
    });
    expect(duplicatedIdentity.status).toBe(400);

    await putSecret('model-token', { values: { TOKEN: 'secret' } });
    const first = await deleteSecret('model-token');
    const replay = await deleteSecret('model-token');

    expect(first.status, await first.clone().text()).toBe(204);
    expect(replay.status, await replay.clone().text()).toBe(204);
    await expect(
      getCredentialSecretStore().getSecretValues('model-token'),
    ).resolves.toBeNull();
  });
});
