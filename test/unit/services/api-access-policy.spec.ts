import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  type DB,
} from '../../../src/api/services/repositories/db';
import {
  assertApiAccess,
  getApiAccessPolicy,
  listApiAccessUsers,
  removeApiAccessUser,
  resolveOwnershipScope,
  setApiGithubApps,
  upsertApiAccessUser,
  upsertApiAccessOwner,
} from '../../../src/api/services/repositories/api-access-policy';
import { ApiAccessDeniedError } from '../../../src/shared/errors';

describe('api access policy', () => {
  let db: DB;

  beforeEach(async () => {
    db = createDatabase();
    await db.init?.();
  });

  it('allows access when no hosted owner policy exists', async () => {
    await expect(
      assertApiAccess({ id: '100', username: 'any-github-user' }, db),
    ).resolves.toBeUndefined();
  });

  it('stores and reads the durable API owner identity', async () => {
    await upsertApiAccessOwner('octocat', '583231', [], db);

    await expect(getApiAccessPolicy(db)).resolves.toMatchObject({
      ownerUser: 'octocat',
      ownerUserId: '583231',
    });
  });

  it('seeds the GitHub Apps on the first start only; the owner replaces them', async () => {
    await upsertApiAccessOwner('octocat', '583231', [5622376, 7], db);
    await expect(getApiAccessPolicy(db)).resolves.toMatchObject({
      githubAppIds: [5622376, 7],
    });
    // A restart keeps what the database holds, whatever the release values say.
    await upsertApiAccessOwner('octocat', '583231', [], db);
    await expect(getApiAccessPolicy(db)).resolves.toMatchObject({
      githubAppIds: [5622376, 7],
    });
    await setApiGithubApps([42], db);
    await expect(getApiAccessPolicy(db)).resolves.toMatchObject({
      githubAppIds: [42],
    });
  });

  it('allows the owner by immutable user id', async () => {
    await upsertApiAccessOwner('octocat', '583231', [], db);

    await expect(
      assertApiAccess({ id: '583231', username: 'octocat' }, db),
    ).resolves.toBeUndefined();
  });

  it('keeps access and refreshes the username after a rename', async () => {
    await upsertApiAccessOwner('octocat', '583231', [], db);

    await expect(
      assertApiAccess({ id: '583231', username: 'renamed-octocat' }, db),
    ).resolves.toBeUndefined();
    await expect(getApiAccessPolicy(db)).resolves.toMatchObject({
      ownerUser: 'renamed-octocat',
      ownerUserId: '583231',
    });
  });

  it('denies a different id even when the username matches', async () => {
    await upsertApiAccessOwner('octocat', '583231', [], db);

    await expect(
      assertApiAccess({ id: '999999', username: 'octocat' }, db),
    ).rejects.toThrow(ApiAccessDeniedError);
  });

  it('allows an explicitly added user by immutable id', async () => {
    await upsertApiAccessOwner('owner', '100', [], db);
    await upsertApiAccessUser({ userId: '200', username: 'member' }, db);

    await expect(
      assertApiAccess({ id: '200', username: 'member' }, db),
    ).resolves.toBeUndefined();
  });

  it('refreshes an allowed user username after a rename', async () => {
    await upsertApiAccessOwner('owner', '100', [], db);
    await upsertApiAccessUser({ userId: '200', username: 'old-member' }, db);

    await assertApiAccess({ id: '200', username: 'renamed-member' }, db);

    await expect(listApiAccessUsers(db)).resolves.toEqual([
      { userId: '200', username: 'renamed-member' },
    ]);
  });

  it('does not transfer access when a username is reassigned', async () => {
    await upsertApiAccessOwner('owner', '100', [], db);
    await upsertApiAccessUser({ userId: '200', username: 'member' }, db);

    await expect(
      assertApiAccess({ id: '300', username: 'member' }, db),
    ).rejects.toThrow(ApiAccessDeniedError);
  });

  it('removes an allowlist entry by immutable user id', async () => {
    await upsertApiAccessUser({ userId: '200', username: 'member' }, db);

    await expect(removeApiAccessUser(' 200 ', db)).resolves.toEqual({
      userId: '200',
      username: 'member',
    });
    await expect(listApiAccessUsers(db)).resolves.toEqual([]);
    await expect(removeApiAccessUser('200', db)).resolves.toBeNull();
  });

  it('denies an allowlist entry dropped outside the CLI on the next request', async () => {
    await upsertApiAccessOwner('owner', '100', [], db);
    await upsertApiAccessUser({ userId: '200', username: 'member' }, db);
    await db.query(`DELETE FROM api_access_users WHERE user_id = '200'`);

    // Nothing caches admission, so an entry removed by an operator takes effect
    // on the very next call rather than at cache expiry or restart.
    await expect(
      assertApiAccess({ id: '200', username: 'member' }, db),
    ).rejects.toThrow(ApiAccessDeniedError);
  });

  it('scopes every caller to the whole API', async () => {
    // A hosted API's members share its workloads; a local API has one owner.
    await expect(resolveOwnershipScope()).resolves.toEqual({ kind: 'api' });
  });

  it('fails closed until a migrated policy is bound to an id', async () => {
    const now = Date.now();
    await db.query(
      `INSERT INTO api_access_policy (
         id, owner_user, owner_user_id, created_at, updated_at
       ) VALUES (1, 'octocat', NULL, ?, ?)`,
      [now, now],
    );

    await expect(
      assertApiAccess({ id: '583231', username: 'octocat' }, db),
    ).rejects.toThrow(ApiAccessDeniedError);
  });

  it('refuses to replace a bound owner id', async () => {
    await upsertApiAccessOwner('octocat', '583231', [], db);

    await expect(upsertApiAccessOwner('octocat', '42', [], db)).rejects.toThrow(
      'already bound',
    );
  });

  it('binds a migrated policy whose handle predates a rename', async () => {
    const now = Date.now();
    await db.query(
      `INSERT INTO api_access_policy (
         id, owner_user, owner_user_id, created_at, updated_at
       ) VALUES (1, 'octocat', NULL, ?, ?)`,
      [now, now],
    );

    // The stored handle is only what the owner was called at the last start.
    // Refusing here would crash the boot of the database this feature exists
    // for — one whose owner renamed before upgrading.
    await expect(
      upsertApiAccessOwner('renamed-octocat', '583231', [], db),
    ).resolves.toBeUndefined();
    await expect(getApiAccessPolicy(db)).resolves.toMatchObject({
      ownerUser: 'renamed-octocat',
      ownerUserId: '583231',
    });
    await expect(
      assertApiAccess({ id: '583231', username: 'renamed-octocat' }, db),
    ).resolves.toBeUndefined();
  });

  it('still refuses to rebind a policy already bound to another id', async () => {
    await upsertApiAccessOwner('octocat', '583231', [], db);

    await expect(upsertApiAccessOwner('octocat', '42', [], db)).rejects.toThrow(
      'already bound',
    );
  });
});
