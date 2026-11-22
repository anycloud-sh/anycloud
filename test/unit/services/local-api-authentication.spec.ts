import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalApiAuthentication,
  readLocalApiToken,
} from '../../../src/api/services/api-authentication.js';
import { DeployError } from '../../../src/shared/errors.js';

const TOKEN = 'a'.repeat(64);
const OWNER = `local:${'1'.repeat(32)}`;
const authenticate = createLocalApiAuthentication({
  token: TOKEN,
  ownerId: OWNER,
});

describe('local API authentication', () => {
  afterEach(() => vi.restoreAllMocks());

  it('admits its own token as the local owner, carrying any GitHub sign-in', async () => {
    await expect(
      authenticate(TOKEN, undefined, { host: 'localhost:8080' }),
    ).resolves.toEqual({ id: OWNER, username: 'local', token: null });
    await expect(
      authenticate(TOKEN, undefined, {
        host: '127.0.0.1:8080',
        githubToken: 'gho_signed_in',
      }),
    ).resolves.toMatchObject({ id: OWNER, token: 'gho_signed_in' });
    await expect(
      authenticate(TOKEN, undefined, { host: '[::1]:8080' }),
    ).resolves.toMatchObject({ id: OWNER });
  });

  it.each(['b'.repeat(64), 'short', 'gho_github_token'])(
    'rejects another token: %s',
    async (token) => {
      await expect(
        authenticate(token, undefined, { host: 'localhost:8080' }),
      ).rejects.toThrow('Invalid local API token');
    },
  );

  it.each([undefined, 'devbox:8080', 'rebound.example', 'localhost.evil.test'])(
    'refuses requests addressed to another host: %s',
    async (host) => {
      const refusal = authenticate(TOKEN, undefined, { host });
      await expect(refusal).rejects.toBeInstanceOf(DeployError);
      await expect(refusal).rejects.toMatchObject({ statusCode: 403 });
      await expect(refusal).rejects.toThrow(
        'use a hosted API for remote access',
      );
    },
  );
});

describe('local API token file', () => {
  it('reads the token and names the fix when it is missing or malformed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'local-api-token-'));
    try {
      const file = path.join(directory, 'local-api-token');
      await expect(readLocalApiToken(file)).rejects.toThrow(
        'run `anycloud api start`',
      );
      await writeFile(file, `${TOKEN}\n`);
      await expect(readLocalApiToken(file)).resolves.toBe(TOKEN);
      await writeFile(file, 'not-a-token');
      await expect(readLocalApiToken(file)).rejects.toThrow(
        'is not a local API token',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
