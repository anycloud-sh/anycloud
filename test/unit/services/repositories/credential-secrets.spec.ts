import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import config from '../../../../src/api/config.js';
import {
  encryptCredential,
  hashCredential,
} from '../../../../src/api/services/cloud-config.js';
import {
  getCredentialSecretStore as credentials,
  resetPersistence,
  getWorkloadOutcomes as outcomes,
} from '../../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { encryptSecret } from '../../../../src/api/services/secret-crypto.js';
import {
  CloudType,
  type AWSCredentials,
} from '../../../../src/shared/cloud.js';
import {
  ACTIVE_STATES,
  WorkloadState,
} from '../../../../src/shared/workload.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

describe('CredentialSecretStore', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      ['test-credential-id'],
    );
  });

  describe('Credential management', () => {
    it('should deduplicate credentials with same content', async () => {
      const encrypted = 'authTag:iv:encryptedData';
      const hash = createHash('sha256').update('plaintext').digest('hex');

      const [id1, id2] = await Promise.all([
        upsertCredential(getDB(), hash, encrypted, CloudType.AWS),
        yieldToIo().then(() =>
          upsertCredential(getDB(), hash, encrypted, CloudType.AWS),
        ),
      ]);

      expect(id1).toBe(id2); // Same hash for same credentials
    });

    it('should create different credential IDs for different data', async () => {
      const encrypted1 = 'authTag:iv:encryptedData1';
      const encrypted2 = 'authTag:iv:encryptedData2';
      const hash1 = createHash('sha256').update('plaintext1').digest('hex');
      const hash2 = createHash('sha256').update('plaintext2').digest('hex');

      const id1 = await upsertCredential(
        getDB(),
        hash1,
        encrypted1,
        CloudType.AWS,
      );
      const id2 = await upsertCredential(
        getDB(),
        hash2,
        encrypted2,
        CloudType.AWS,
      );

      expect(id1).not.toBe(id2);
    });

    it('should retrieve credentials by ID', async () => {
      const store = credentials();
      const encrypted = 'authTag:iv:testCredentials';
      const hash = createHash('sha256').update('testCreds').digest('hex');

      const credId = await upsertCredential(
        getDB(),
        hash,
        encrypted,
        CloudType.GCP,
      );
      const retrieved = await store.getCredential(credId);

      expect(retrieved).toBe(encrypted);
    });

    it('should deduplicate when same credentials are encrypted twice (different ciphertexts)', async () => {
      const creds: AWSCredentials = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      };

      // Encrypt same credentials twice — random IV means different ciphertexts
      const encrypted1 = await encryptCredential(creds);
      const encrypted2 = await encryptCredential(creds);
      expect(encrypted1).not.toBe(encrypted2);

      // hashCredential hashes plaintext, so same creds → same hash
      const hash1 = hashCredential(creds);
      const hash2 = hashCredential(creds);
      expect(hash1).toBe(hash2);

      // Upsert both — should result in a single credential row for this hash
      await upsertCredential(getDB(), hash1, encrypted1, CloudType.AWS);
      await upsertCredential(getDB(), hash2, encrypted2, CloudType.AWS);

      const rows = await getDB().query<{ count: number }>(
        'SELECT COUNT(*) as count FROM credentials WHERE id = ?',
        [hash1],
      );
      expect(rows[0].count).toBe(1);
    });

    it('should update last_used_at when reusing credential', async () => {
      const encrypted = 'authTag:iv:reusedCreds';
      const hash = createHash('sha256').update('reusedCreds').digest('hex');

      // First use
      const id1 = await upsertCredential(
        getDB(),
        hash,
        encrypted,
        CloudType.AWS,
      );
      const cred1 = await getDB().query<{ last_used_at: number }>(
        'SELECT last_used_at FROM credentials WHERE id = ?',
        [id1],
      );
      const firstUse = cred1[0].last_used_at;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second use (should update last_used_at)
      await upsertCredential(getDB(), hash, encrypted, CloudType.AWS);
      const cred2 = await getDB().query<{ last_used_at: number }>(
        'SELECT last_used_at FROM credentials WHERE id = ?',
        [id1],
      );
      const secondUse = cred2[0].last_used_at;

      expect(secondUse).toBeGreaterThan(firstUse);
    });
  });

  describe('saveSecret', () => {
    it('allows concurrent initial saves of the same secret', async () => {
      const store = credentials();
      await encryptSecret('warm up encryption before independent requests');

      const results = await Promise.allSettled([
        store.saveSecret('shared', { TOKEN: 'first' }),
        yieldToIo().then(() => store.saveSecret('shared', { TOKEN: 'second' })),
      ]);

      expect(results).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(await store.getSecretValues('shared')).toEqual({
        TOKEN: 'second',
      });
    });

    it('preserves creation time when replacing secret values', async () => {
      const store = credentials();
      const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
      try {
        await store.saveSecret('shared', { TOKEN: 'first' });
        now.mockReturnValue(2000);
        await store.saveSecret('shared', { TOKEN: 'second' });

        expect(await store.listSecrets()).toEqual([
          { name: 'shared', createdAt: 1, updatedAt: 2 },
        ]);
        expect(await store.getSecretValues('shared')).toEqual({
          TOKEN: 'second',
        });
      } finally {
        now.mockRestore();
      }
    });
  });

  describe('deleteSecretIfNotReferenced', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('deletes the secret when no active workload references it', async () => {
      const store = credentials();
      await store.saveSecret('hf', { HF_TOKEN: 'x' });

      const result = await store.deleteSecretIfNotReferenced('hf', false);

      expect(result).toEqual({ deleted: true, blocking: [] });
      expect(await store.listSecrets()).toEqual([]);
    });

    it('refuses delete and reports blocking workloads when referenced', async () => {
      const store = credentials();
      await store.saveSecret('hf', { HF_TOKEN: 'x' });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'dep-using-hf',
        secretNames: ['hf'],
      });
      // Queued is in ACTIVE_STATES; workload should block delete.
      expect(ACTIVE_STATES).toContain(WorkloadState.Queued);

      const result = await store.deleteSecretIfNotReferenced('hf', false);

      expect(result.deleted).toBe(false);
      expect(result.blocking).toEqual(['dep-using-hf']);
      // Secret must still exist — delete was rolled back.
      expect((await store.listSecrets()).map((s) => s.name)).toEqual(['hf']);
    });

    it('preserves an unrelated secret saved while deletion is refused', async () => {
      const store = credentials();
      await store.saveSecret('hf', { HF_TOKEN: 'x' });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'dep-using-hf',
        secretNames: ['hf'],
      });

      const [deletion] = await Promise.all([
        store.deleteSecretIfNotReferenced('hf', false),
        yieldToIo().then(() => store.saveSecret('unrelated', { TOKEN: 'new' })),
      ]);

      expect(deletion).toEqual({ deleted: false, blocking: ['dep-using-hf'] });
      expect(await store.getSecretValues('unrelated')).toEqual({
        TOKEN: 'new',
      });
      expect(await store.getSecretValues('hf')).toEqual({ HF_TOKEN: 'x' });
    });

    it('force=true deletes even when non-terminal workloads reference it', async () => {
      const store = credentials();
      await store.saveSecret('hf', { HF_TOKEN: 'x' });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'dep-using-hf-force',
        secretNames: ['hf'],
      });

      const result = await store.deleteSecretIfNotReferenced('hf', true);

      expect(result.deleted).toBe(true);
      expect(result.blocking).toEqual([]);
    });

    it('lists Running Workloads that reference a Secret, and its revision', async () => {
      const store = credentials();
      await store.saveSecret('hf', { HF_TOKEN: 'x' });
      const first = await store.getSecretRevision('hf');
      await store.saveSecret('hf', { HF_TOKEN: 'x' });
      const second = await store.getRuntimeSecret('hf');
      expect(first).toMatch(/^[0-9a-f]{16}$/u);
      expect(second).toEqual({
        name: 'hf',
        revision: await store.getSecretRevision('hf'),
        values: { HF_TOKEN: 'x' },
      });
      // A fresh nonce per save: the same value gets a new revision.
      expect(second!.revision).not.toBe(first);
      expect(await store.getSecretRevision('missing')).toBeNull();

      for (const [id, state, names] of [
        ['running-hf', WorkloadState.Running, ['other', 'hf']],
        ['running-other', WorkloadState.Running, ['other']],
        ['queued-hf', WorkloadState.Queued, ['hf']],
        ['failed-hf', WorkloadState.Failed, ['hf']],
      ] as const)
        await createWorkload(
          getDB(),
          { ...baseInput, id, secretNames: [...names] },
          { initialState: state },
        );
      expect(await store.listRunningVmHostWorkloadIds('hf')).toEqual([
        'running-hf',
      ]);
    });

    it('returns deleted=false on missing secret without erroring', async () => {
      const store = credentials();
      const result = await store.deleteSecretIfNotReferenced(
        'does-not-exist',
        false,
      );
      expect(result).toEqual({ deleted: false, blocking: [] });
    });
  });

  // Regression: hash-based credential dedup means an anonymous submit (SDK inline
  // creds) and a named credential can share a row. When a concurrent test called
  // deleteNamedCredential, the shared row vanished and the in-flight workload's
  // completion monitor logged "Skipping job completion check: no credentials"
  // forever (seen on sdk-python e2e flake). The delete path now refuses
  // when an active workload references the credential; --force bypasses.
  describe('deleteNamedCredentialIfNotReferenced', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
    };

    async function seedCredential(name: string | null, plaintext: string) {
      const store = credentials();
      const hash = createHash('sha256').update(plaintext).digest('hex');
      const encrypted = `authTag:iv:${plaintext}`;
      if (name === null) {
        await upsertCredential(getDB(), hash, encrypted, CloudType.AWS);
      } else {
        await store.saveNamedCredential(name, hash, encrypted, CloudType.AWS);
      }
      return { hash, encrypted };
    }

    it('refuses and lists blocking workloads when an active workload references it', async () => {
      const store = credentials();
      const { hash, encrypted } = await seedCredential('aws-test', 'shared');

      // SDK-style anonymous submit ends up on the same row via hash dedup.
      const credId = await upsertCredential(
        getDB(),
        hash,
        encrypted,
        CloudType.AWS,
      );
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'active-dep',
        credentialId: credId,
      });
      // Queued is in ACTIVE_STATES.
      expect(ACTIVE_STATES).toContain(WorkloadState.Queued);

      const result = await store.deleteNamedCredentialIfNotReferenced(
        'aws-test',
        false,
      );
      expect(result).toEqual({ deleted: false, blocking: ['active-dep'] });

      // Row must still exist so the completion monitor can decrypt creds.
      expect(await store.getCredential(credId)).toBe(encrypted);
      // Name is preserved too — we refused the delete entirely.
      const rows = await getDB().query<{ name: string | null }>(
        `SELECT name FROM credentials WHERE id = ?`,
        [credId],
      );
      expect(rows[0]?.name).toBe('aws-test');
    });

    it('preserves an unrelated secret saved while deletion is refused', async () => {
      const store = credentials();
      const { hash, encrypted } = await seedCredential('aws-test', 'shared');
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'active-dep',
        credentialId: hash,
      });

      const [deletion] = await Promise.all([
        store.deleteNamedCredentialIfNotReferenced('aws-test', false),
        yieldToIo().then(() => store.saveSecret('unrelated', { TOKEN: 'new' })),
      ]);

      expect(deletion).toEqual({ deleted: false, blocking: ['active-dep'] });
      expect(await store.getSecretValues('unrelated')).toEqual({
        TOKEN: 'new',
      });
      expect(await store.getNamedCredential('aws-test')).toMatchObject({
        id: hash,
        encryptedData: encrypted,
      });
    });

    it('hard-deletes when no active workload references it', async () => {
      const store = credentials();
      const { hash } = await seedCredential('aws-test', 'unreferenced');
      const credId = createHash('sha256').update('unreferenced').digest('hex');
      expect(hash).toBe(credId);

      const result = await store.deleteNamedCredentialIfNotReferenced(
        'aws-test',
        false,
      );
      expect(result).toEqual({ deleted: true, blocking: [] });

      expect(await store.getCredential(credId)).toBeNull();
    });

    it('soft-unnames when only terminal workloads reference it (FK RESTRICT preserves the row)', async () => {
      const store = credentials();
      const { hash, encrypted } = await seedCredential('aws-test', 'terminal');
      const credId = await upsertCredential(
        getDB(),
        hash,
        encrypted,
        CloudType.AWS,
      );
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'terminal-dep',
        credentialId: credId,
      });
      await outcomes().requestTermination(
        'terminal-dep',
        scope(baseInput.userId),
      );

      const result = await store.deleteNamedCredentialIfNotReferenced(
        'aws-test',
        false,
      );
      // From the user's perspective the name is gone. The underlying row
      // survives so the historical FK pointer stays intact.
      expect(result).toEqual({ deleted: true, blocking: [] });

      expect(await store.getCredential(credId)).toBe(encrypted);
      const named = await getDB().query<{ name: string | null }>(
        `SELECT name FROM credentials WHERE id = ?`,
        [credId],
      );
      expect(named[0].name).toBeNull();
    });

    it('force=true deletes even when an active workload references it', async () => {
      const store = credentials();
      const { hash, encrypted } = await seedCredential('aws-test', 'forced');
      const credId = await upsertCredential(
        getDB(),
        hash,
        encrypted,
        CloudType.AWS,
      );
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'active-dep',
        credentialId: credId,
      });

      const result = await store.deleteNamedCredentialIfNotReferenced(
        'aws-test',
        true,
      );
      expect(result).toEqual({ deleted: true, blocking: [] });

      // With force, the row is dropped to NULL-name (or deleted entirely)
      // following the existing soft-unname path so the in-flight workload
      // still resolves credentials.
      expect(await store.getCredential(credId)).toBe(encrypted);
      const rows = await getDB().query<{ name: string | null }>(
        `SELECT name FROM credentials WHERE id = ?`,
        [credId],
      );
      expect(rows[0]?.name).toBeNull();
    });

    it('returns deleted:false when the name does not exist', async () => {
      const store = credentials();
      const result = await store.deleteNamedCredentialIfNotReferenced(
        'does-not-exist',
        false,
      );
      expect(result).toEqual({ deleted: false, blocking: [] });
    });

    it('deletes credentials unrelated to active credentialless compute', async () => {
      const store = credentials();
      const { hash: credId } = await seedCredential(
        'aws-test-unrelated',
        'unrelated-key',
      );

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'local-active-dep',
        credentialId: null,
        requestedComputeProvider: CloudType.Local,
      });

      const result = await store.deleteNamedCredentialIfNotReferenced(
        'aws-test-unrelated',
        false,
      );
      expect(result).toEqual({ deleted: true, blocking: [] });
      expect(await store.getCredential(credId)).toBeNull();
    });

    it('allows concurrent rotations of the same credential name', async () => {
      const store = credentials();
      await seedCredential('aws-test', 'old-key');

      const results = await Promise.allSettled([
        seedCredential('aws-test', 'first-key'),
        yieldToIo().then(() => seedCredential('aws-test', 'second-key')),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      expect(await store.getNamedCredential('aws-test')).toMatchObject({
        encryptedData: 'authTag:iv:second-key',
      });
    });

    it('credential rotation stays readable and preserves active workload references', async () => {
      const store = credentials();
      const { hash: oldHash, encrypted: oldEncrypted } = await seedCredential(
        'aws-test',
        'old-key',
      );
      const oldCredId = await upsertCredential(
        getDB(),
        oldHash,
        oldEncrypted,
        CloudType.AWS,
      );
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'active-dep',
        credentialId: oldCredId,
      });

      // Rotate to new hash under the same name.
      const newHash = createHash('sha256').update('new-key').digest('hex');
      const newEncrypted = 'authTag:iv:new-key';
      let rotated = false;
      const observations: (string | null)[] = [];
      const rotation = store
        .saveNamedCredential('aws-test', newHash, newEncrypted, CloudType.AWS, {
          overwrite: true,
        })
        .finally(() => {
          rotated = true;
        });
      const observe = async () => {
        do {
          await yieldToIo();
          observations.push(
            (await store.getNamedCredential('aws-test'))?.id ?? null,
          );
        } while (!rotated);
      };
      await Promise.all([rotation, observe()]);

      expect(observations.length).toBeGreaterThan(0);
      expect(observations).not.toContain(null);
      expect(observations.every((id) => id === oldHash || id === newHash)).toBe(
        true,
      );

      // Old row preserved (in-flight workload still resolvable).
      expect(await store.getCredential(oldCredId)).toBe(oldEncrypted);
      // New row is the named one.
      const rows = await getDB().query<{ name: string | null }>(
        `SELECT name FROM credentials WHERE id = ?`,
        [newHash],
      );
      expect(rows[0]?.name).toBe('aws-test');
    });
  });
});
