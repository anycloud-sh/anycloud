import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { CloudType } from '../../../src/shared/cloud.js';
import { createDatabase } from '../../../src/api/services/repositories/db.js';
import { CredentialSecretStore } from '../../../src/api/services/repositories/credential-secrets.js';
import {
  createCredentialsDomain,
  CredentialNotFoundError,
  InvalidCredentialUpdateError,
  RoleConnectionCheckError,
  RoleConnectionRefusedError,
  type CredentialsDomainDependencies,
} from '../../../src/api/services/credentials-domain.js';

const original = {
  cloudProvider: CloudType.AWS,
  accessKeyId: 'AKIAORIGINAL',
  secretAccessKey: 'original-secret',
} as const;

async function withDomain(
  use: (world: {
    domain: ReturnType<typeof createCredentialsDomain>;
    store: CredentialSecretStore;
    onDecrypt: (hook: () => Promise<void>) => void;
  }) => Promise<void>,
  checkRoleConnection: CredentialsDomainDependencies['checkRoleConnection'] = null,
): Promise<void> {
  const db = createDatabase();
  try {
    const store = new CredentialSecretStore(db);
    let hook: (() => Promise<void>) | undefined;
    const domain = createCredentialsDomain({
      store,
      encrypt: async (value) => JSON.stringify(value),
      decrypt: async (value) => {
        const run = hook;
        hook = undefined;
        await run?.();
        return JSON.parse(value);
      },
      hash: (value) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      checkRoleConnection,
    });
    await domain.save({ name: 'prod', overwrite: true, ...original });
    await use({ domain, store, onDecrypt: (next) => (hook = next) });
  } finally {
    db.close();
  }
}

async function stored(store: CredentialSecretStore) {
  const row = await store.getNamedCredential('prod');
  return row && JSON.parse(row.encryptedData);
}

test('a concurrent edit cannot overwrite another with a mismatched pair', async () => {
  await withDomain(async ({ domain, store }) => {
    const results = await Promise.allSettled([
      domain.update({ name: 'prod', fields: { accessKeyId: 'AKIAROTATED' } }),
      domain.update({
        name: 'prod',
        fields: { secretAccessKey: 'rotated-secret' },
      }),
    ]);

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { statusCode: 409 } });
    expect([
      { ...original, accessKeyId: 'AKIAROTATED' },
      { ...original, secretAccessKey: 'rotated-secret' },
    ]).toContainEqual(await stored(store));
  });
});

test('an edit racing a delete does not bring the credential back', async () => {
  await withDomain(async ({ domain, store, onDecrypt }) => {
    onDecrypt(async () => {
      await store.deleteNamedCredentialIfNotReferenced('prod', true);
    });

    await expect(
      domain.update({ name: 'prod', fields: { secretAccessKey: 'late' } }),
    ).rejects.toBeInstanceOf(CredentialNotFoundError);
    expect(await store.getNamedCredential('prod')).toBeNull();
  });
});

describe('role connections', () => {
  const request = {
    cloudProvider: CloudType.AWS,
    kind: 'role',
    roleArn: 'arn:aws:iam::123456789012:role/anycloud',
  } as const;
  const trust = {
    issuer: 'https://issuer.example.com/cluster',
    audience: 'sts.amazonaws.com',
    subject: 'system:serviceaccount:anycloud-system:anycloud-api',
  };

  test('0047 invariant 7: the checked connection is stored, with no secret, and listed by its role', async () => {
    const checked: unknown[] = [];
    await withDomain(
      async ({ domain, store }) => {
        await domain.save({ name: 'role', overwrite: true, ...request });

        expect(checked).toEqual([request]);
        const row = await store.getNamedCredential('role');
        expect(JSON.parse(row!.encryptedData)).toEqual({
          ...request,
          ...trust,
        });
        expect(await domain.get('role')).toEqual({ name: 'role', ...request });
      },
      async (input) => {
        checked.push(input);
        return { ...request, ...trust };
      },
    );
  });

  test("a cloud's refusal names the connection and stores nothing", async () => {
    await withDomain(
      async ({ domain, store }) => {
        const refusal = await domain
          .save({ name: 'role', overwrite: true, ...request })
          .catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(RoleConnectionRefusedError);
        expect((refusal as Error).message).toContain('"role"');
        expect((refusal as Error).message).toContain('MaxSessionDuration');
        expect(await store.getNamedCredential('role')).toBeNull();
      },
      async () => {
        throw new RoleConnectionCheckError('set its MaxSessionDuration');
      },
    );
  });

  test('has no fields to edit, and says to save it again', async () => {
    await withDomain(
      async ({ domain }) => {
        await domain.save({ name: 'role', overwrite: true, ...request });

        const refusal = await domain
          .update({ name: 'role', fields: { accessKeyId: 'AKIANEW' } })
          .catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(InvalidCredentialUpdateError);
        expect((refusal as Error).message).toBe(
          'AWS credential "role" is a role connection, which has no editable fields; save it again instead',
        );
      },
      async () => ({ ...request, ...trust }),
    );
  });
});

test('saving or editing a credential backs up the database, so backup.json lists it', async () => {
  const db = createDatabase();
  try {
    const requestBackup = vi.fn();
    const domain = createCredentialsDomain({
      requestBackup,
      store: new CredentialSecretStore(db),
      encrypt: async (value) => JSON.stringify(value),
      decrypt: async (value) => JSON.parse(value),
      hash: (value) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      checkRoleConnection: null,
    });
    await domain.save({ name: 'prod', overwrite: true, ...original });
    await domain.update({ name: 'prod', fields: { accessKeyId: 'AKIANEW' } });
    expect(requestBackup.mock.calls).toEqual([
      ['credential prod saved'],
      ['credential prod saved'],
    ]);
  } finally {
    db.close();
  }
});
