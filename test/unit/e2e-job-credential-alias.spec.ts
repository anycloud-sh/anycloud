import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { CloudType } from '../../src/shared/cloud.js';
import { createDatabase } from '../../src/api/services/repositories/db.js';
import { CredentialSecretStore } from '../../src/api/services/repositories/credential-secrets.js';
import {
  createCredentialsDomain,
  CredentialNotFoundError,
} from '../../src/api/services/credentials-domain.js';
import { JobAuthorization } from '../integration/e2e/internal/job-authorization.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';

test('rejects a borrowed material alias without renaming or deleting the original API record', async () => {
  const db = createDatabase();
  try {
    const store = new CredentialSecretStore(db);
    const domain = createCredentialsDomain({
      store,
      encrypt: async (v) => JSON.stringify(v),
      decrypt: async (v) => JSON.parse(v),
      hash: (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex'),
      checkRoleConnection: null,
    });
    const material = {
      cloudProvider: CloudType.Lambda,
      apiKey: 'offline-borrowed-token',
    } as const;
    const name = 'lambda-test';
    const oldName = 'previous-credential';
    await domain.save({ name: oldName, ...material, overwrite: false });
    const original = await store.getNamedCredential(oldName);
    const api = {
      controller: { url: 'http://offline-controller.invalid', generation: 1 },
      readCredential: async (name: string) => {
        try {
          return await domain.get(name);
        } catch (error) {
          if (error instanceof CredentialNotFoundError) return undefined;
          throw error;
        }
      },
      saveCredential: async (name: string, value: typeof material) =>
        domain.save({ name, ...value, overwrite: false }),
      deleteCredential: async (name: string) => domain.delete(name, true),
      listCredentials: async () => domain.list(),
    };
    const database = {
      queryComplete: (query: string) =>
        db.query<Record<string, unknown>>(query),
    };
    const commands = new JobPrivateCommands(
      {
        run: async () => {
          throw new Error('no native commands');
        },
      },
      new AbortController().signal,
    );
    const cleanup = new CleanupStack();
    const authorization = new JobAuthorization(
      {
        api,
        cleanupApi: api,
        database,
        cleanupDatabase: database,
        cleanup,
        commands,
        cleanupCommands: commands,
        cli: {
          run: async () => {
            throw new Error('no CLI');
          },
        },
        files: {
          directory: async () => '/unused',
          privateText: async () => '/unused',
          remove: async () => undefined,
        },
        redactor: { add: () => undefined },
        artifacts: { json: async () => '' },
      },
      {
        name,
        profile: {
          slug: 'lambda',
          provider: CloudType.Lambda,
          credentialName: name,
          credential: material,
          vmTypes: ['cpu_4x_general'],
        },
        mode: 'bootstrap',
        cleanupMs: 30000,
        dependentsAbsent: () => undefined,
      },
    );
    await expect(authorization.create(Date.now() + 10000)).rejects.toThrow(
      'material was already owned',
    );
    await cleanup.run();
    expect(await store.getNamedCredential(oldName)).toEqual(original);
    expect(await store.getNamedCredential(name)).toBeNull();
    expect(await db.query('SELECT id, name FROM credentials')).toEqual([
      { id: original!.id, name: oldName },
    ]);
    expect(cleanup.observations()[0].completed).toBe(true);
  } finally {
    db.close();
  }
});
