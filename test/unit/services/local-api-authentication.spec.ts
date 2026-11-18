import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalApiAuthentication,
  githubOwner,
  readLocalApiToken,
} from '../../../src/api/services/api-authentication.js';
import Github from '../../../src/api/services/gateways/github.js';
import {
  DeployError,
  GithubSignInRequiredError,
  GithubUnavailableError,
} from '../../../src/shared/errors.js';

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

describe('githubOwner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('stops a local caller without a GitHub sign-in', async () => {
    await expect(
      githubOwner(
        { id: OWNER, username: 'local', token: null },
        'Clusters need',
      ),
    ).rejects.toBeInstanceOf(GithubSignInRequiredError);
  });

  it('resolves a local caller to the GitHub account behind its token', async () => {
    vi.spyOn(Github, 'authenticate').mockResolvedValue({
      id: '42',
      username: 'octocat',
      scopes: [],
    });
    await expect(
      githubOwner(
        { id: OWNER, username: 'local', token: 'gho_signed_in' },
        'Clusters need',
      ),
    ).resolves.toEqual({
      id: '42',
      username: 'octocat',
      token: 'gho_signed_in',
    });
  });

  it.each([401, 403])(
    'asks a local caller to sign in again when GitHub answers %i',
    async (status) => {
      vi.spyOn(Github, 'authenticate').mockRejectedValue(
        Object.assign(new Error('Bad credentials'), { status }),
      );
      const refusal = githubOwner(
        { id: OWNER, username: 'local', token: 'gho_expired' },
        'Clusters need',
      );
      await expect(refusal).rejects.toBeInstanceOf(GithubSignInRequiredError);
      await expect(refusal).rejects.toThrow('Your GitHub sign-in was rejected');
    },
  );

  it('keeps a GitHub outage retryable', async () => {
    vi.spyOn(Github, 'authenticate').mockRejectedValue(
      new GithubUnavailableError(502),
    );
    await expect(
      githubOwner(
        { id: OWNER, username: 'local', token: 'gho_valid' },
        'Clusters need',
      ),
    ).rejects.toBeInstanceOf(GithubUnavailableError);
  });

  it('keeps a hosted caller as the account it already is', async () => {
    const lookup = vi.spyOn(Github, 'authenticate');
    await expect(
      githubOwner(
        { id: '7', username: 'owner', token: 'gho_x' },
        'Clusters need',
      ),
    ).resolves.toEqual({ id: '7', username: 'owner', token: 'gho_x' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
