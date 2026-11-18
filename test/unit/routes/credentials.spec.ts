import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import {
  getCredentialSecretStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  encryptCredential,
  hashCredential,
  resolveCredentialByName,
} from '../../../src/api/services/cloud-config';
import { CloudType } from '../../../src/shared/cloud.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { cloudCredentialSchema } from '../../../src/shared/api-contract/credentials-schemas.js';

const AUTH_HEADER = { Authorization: 'Bearer mock-github-token' };

function credGet(path: string) {
  return callApi(`https://example.com/v1/credentials${path}`, {
    method: 'GET',
    headers: AUTH_HEADER,
  });
}

function credPut(body: Record<string, unknown>, query = '') {
  const { name, ...credential } = body;
  return callApi(
    `https://example.com/v1/credentials/${encodeURIComponent(String(name))}${query}`,
    {
      method: 'PUT',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(credential),
    },
  );
}

function credPatch(name: string, body: Record<string, unknown>) {
  return callApi(
    `https://example.com/v1/credentials/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

/** The stored material, read the way the API itself reads it. */
async function stored(name: string): Promise<Record<string, unknown>> {
  return { ...(await resolveCredentialByName(name))?.creds };
}

function credDelete(name: string, query = '') {
  return callApi(
    `https://example.com/v1/credentials/${encodeURIComponent(name)}${query}`,
    {
      method: 'DELETE',
      headers: AUTH_HEADER,
    },
  );
}

async function seedCredential(
  name: string,
  cloudProvider: CloudType,
  overrides: Record<string, unknown> = {},
) {
  const store = getCredentialSecretStore();
  const cred =
    cloudProvider === CloudType.AWS
      ? {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA1234',
          secretAccessKey: 'secret-key-aws',
          ...overrides,
        }
      : {
          cloudProvider: CloudType.GCP,
          projectId: 'proj-1',
          clientEmail: 'sa@proj-1.iam.gserviceaccount.com',
          privateKey: 'private-key-gcp',
          ...overrides,
        };
  const credHash = hashCredential(cred as any);
  const encrypted = await encryptCredential(cred as any);
  await store.saveNamedCredential(name, credHash, encrypted, cloudProvider);
}

beforeEach(() => {
  resetPersistence();
});

describe('Credentials API routes', () => {
  // ---- Auth ----
  it('returns 401 without auth', async () => {
    const res = await callApi('https://example.com/v1/credentials', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  // ---- GET /credentials ----
  describe('GET /credentials', () => {
    it('returns empty list when no credentials', async () => {
      const res = await credGet('');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual([]);
    });

    it('returns redacted credentials list with identity fields', async () => {
      await seedCredential('my-aws', CloudType.AWS);
      await seedCredential('my-gcp', CloudType.GCP);

      const res = await credGet('');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);

      const aws = body.find((c: any) => c.name === 'my-aws');
      expect(aws.cloudProvider).toBe('AWS');
      expect(aws.accessKeyId).toBe('AKIA1234');
      expect(aws).not.toHaveProperty('secretAccessKey');

      const gcp = body.find((c: any) => c.name === 'my-gcp');
      expect(gcp.cloudProvider).toBe('GCP');
      expect(gcp).toHaveProperty('projectId');
      expect(gcp).toHaveProperty('clientEmail');
      expect(gcp).not.toHaveProperty('privateKey');
    });
  });

  // ---- GET /credentials/:name ----
  describe('GET /credentials/:name', () => {
    it('returns a single redacted credential', async () => {
      await seedCredential('my-aws', CloudType.AWS);

      const res = await credGet('/my-aws');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('my-aws');
      expect(body.accessKeyId).toBe('AKIA1234');
      expect(body).not.toHaveProperty('secretAccessKey');
    });

    it('returns 404 for missing credential', async () => {
      const res = await credGet('/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ---- GET /credentials/:name/material ----
  describe('GET /credentials/:name/material', () => {
    it('does not export decrypted credential material', async () => {
      await seedCredential('my-aws', CloudType.AWS);

      const res = await credGet('/my-aws/material');
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('secret-key-aws');
    });
  });

  // ---- PUT /credentials/:name ----
  describe('PUT /credentials/:name', () => {
    it('saves an AWS credential', async () => {
      const res = await credPut({
        name: 'new-aws',
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA5678',
        secretAccessKey: 'new-secret',
      });
      expect(res.status).toBe(204);

      expect(await stored('new-aws')).toEqual({
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA5678',
        secretAccessKey: 'new-secret',
      });
    });

    it('0047/S10 rejects AWS session credentials, which expire, and stores nothing', async () => {
      const res = await credPut({
        name: 'new-aws-session',
        cloudProvider: 'AWS',
        accessKeyId: 'ASIA5678',
        secretAccessKey: 'temporary-secret',
        sessionToken: 'temporary-session-token',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(
        'session credentials cannot be saved',
      );
      expect((await credGet('/new-aws-session')).status).toBe(404);
    });

    it('0047/S15 refuses a role connection on a local API and stores nothing', async () => {
      const res = await credPut({
        name: 'aws-role',
        cloudProvider: 'AWS',
        kind: 'role',
        roleArn: 'arn:aws:iam::123456789012:role/anycloud',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'ROLE_CONNECTION_REFUSED',
        data: { name: 'aws-role' },
      });
      expect((await credGet('/aws-role')).status).toBe(404);
    });

    it('rejects a role connection that names no role', async () => {
      const res = await credPut({
        name: 'aws-role',
        cloudProvider: 'AWS',
        kind: 'role',
        roleArn: 'anycloud',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).not.toMatchObject({
        code: 'ROLE_CONNECTION_REFUSED',
      });
    });

    it('lets workloads use a saved AWS role connection, never inline', async () => {
      const role = {
        cloudProvider: CloudType.AWS,
        kind: 'role',
        roleArn: 'arn:aws:iam::123456789012:role/anycloud',
        issuer: 'https://issuer.example.com',
        audience: 'sts.amazonaws.com',
        subject: 'system:serviceaccount:anycloud-system:anycloud-api',
      } as const;
      await getCredentialSecretStore().saveNamedCredential(
        'aws-role',
        hashCredential(role),
        await encryptCredential(role),
        CloudType.AWS,
      );

      expect((await (await credGet('/aws-role')).json()).roleArn).toBe(
        role.roleArn,
      );
      expect((await resolveCredentialByName('aws-role'))?.creds).toEqual(role);
      // A workload cannot name one inline as a storage credential.
      expect(cloudCredentialSchema.safeParse(role).success).toBe(false);
    });

    it('lets workloads use a saved GCP role connection', async () => {
      const role = {
        cloudProvider: CloudType.GCP,
        kind: 'role',
        workloadIdentityProvider:
          'projects/1/locations/global/workloadIdentityPools/a/providers/b',
        serviceAccountEmail: 'anycloud@my-project.iam.gserviceaccount.com',
        issuer: 'https://issuer.example.com',
        audience:
          'https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/a/providers/b',
        subject: 'system:serviceaccount:anycloud-system:anycloud-api',
      } as const;
      await getCredentialSecretStore().saveNamedCredential(
        'gcp-role',
        hashCredential(role),
        await encryptCredential(role),
        CloudType.GCP,
      );

      expect((await resolveCredentialByName('gcp-role'))?.creds).toEqual(role);
    });

    it('saves a Cloudflare credential and lists it without the token', async () => {
      const res = await credPut({
        name: 'r2',
        cloudProvider: 'Cloudflare',
        accountId: 'cf-account',
        apiToken: 'cf-token-secret',
        jurisdiction: 'eu',
      });
      expect(res.status).toBe(204);

      const listed = (await (await credGet('')).json()).find(
        (c: any) => c.name === 'r2',
      );
      expect(listed).toEqual({
        name: 'r2',
        cloudProvider: 'Cloudflare',
        accountId: 'cf-account',
        jurisdiction: 'eu',
      });
      expect(JSON.stringify(await (await credGet('/r2')).json())).not.toContain(
        'cf-token-secret',
      );
      expect((await stored('r2')).apiToken).toBe('cf-token-secret');
    });

    it('rejects an unknown Cloudflare jurisdiction', async () => {
      const res = await credPut({
        name: 'r2-bad',
        cloudProvider: 'Cloudflare',
        accountId: 'cf-account',
        apiToken: 'cf-token-secret',
        jurisdiction: 'apac',
      });
      expect(res.status).toBe(400);
      expect((await credGet('/r2-bad')).status).toBe(404);
    });

    it('round-trips a GCP billing export dataset', async () => {
      const res = await credPut({
        name: 'gcp-with-billing',
        cloudProvider: 'GCP',
        projectId: 'compute-project',
        clientEmail: 'sa@compute-project.iam.gserviceaccount.com',
        privateKey: 'private-key-gcp',
        billingExportDataset: 'billing-project.billing_export',
      });
      expect(res.status).toBe(204);

      expect((await stored('gcp-with-billing')).billingExportDataset).toBe(
        'billing-project.billing_export',
      );
    });

    it('atomically refuses to replace a name when overwrite=false', async () => {
      await seedCredential('protected-name', CloudType.AWS);

      const res = await credPut(
        {
          name: 'protected-name',
          cloudProvider: 'AWS',
          accessKeyId: 'AKIARACER',
          secretAccessKey: 'racing-secret',
        },
        '?overwrite=false',
      );

      expect(res.status).toBe(409);
      expect(await res.text()).toMatch(/already exist/i);
      expect((await stored('protected-name')).accessKeyId).toBe('AKIA1234');
    });

    it('treats an exact create-only replay as idempotent', async () => {
      const request = {
        name: 'replayed-name',
        cloudProvider: 'GCP',
        projectId: 'replayed-project',
        clientEmail: 'replayed@replayed-project.iam.gserviceaccount.com',
        privateKey: 'replayed-private-key',
      };

      const first = await credPut(request, '?overwrite=false');
      const replay = await credPut(request, '?overwrite=false');

      expect(first.status).toBe(204);
      expect(replay.status).toBe(204);
      const { name: _name, ...credential } = request;
      expect(await stored('replayed-name')).toEqual(credential);
    });

    it.each(['?overwrite=false', '?overwrite=true', ''])(
      'refuses the same material under a second name (%s) and keeps the first',
      async (query) => {
        await seedCredential('first-name', CloudType.AWS);

        const res = await credPut(
          {
            name: 'second-name',
            cloudProvider: 'AWS',
            accessKeyId: 'AKIA1234',
            secretAccessKey: 'secret-key-aws',
          },
          query,
        );

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
          code: 'CREDENTIALS_EXIST',
          data: { name: 'second-name', existingName: 'first-name' },
        });
        expect((await stored('first-name')).accessKeyId).toBe('AKIA1234');
        expect((await credGet('/second-name')).status).toBe(404);
      },
    );

    it.each(['?overwrite=true', ''])(
      'saves the same material again under its own name (%s)',
      async (query) => {
        await seedCredential('same-name', CloudType.AWS);

        const res = await credPut(
          {
            name: 'same-name',
            cloudProvider: 'AWS',
            accessKeyId: 'AKIA1234',
            secretAccessKey: 'secret-key-aws',
          },
          query,
        );

        expect(res.status).toBe(204);
        expect((await stored('same-name')).accessKeyId).toBe('AKIA1234');
      },
    );

    it('allows only one concurrent create-only request to claim a name', async () => {
      const [first, second] = await Promise.all([
        credPut(
          {
            name: 'raced-name',
            cloudProvider: 'AWS',
            accessKeyId: 'AKIARACEONE',
            secretAccessKey: 'race-one-secret',
          },
          '?overwrite=false',
        ),
        credPut(
          {
            name: 'raced-name',
            cloudProvider: 'AWS',
            accessKeyId: 'AKIARACETWO',
            secretAccessKey: 'race-two-secret',
          },
          '?overwrite=false',
        ),
      ]);

      expect([first.status, second.status].sort()).toEqual([204, 409]);
      expect(['AKIARACEONE', 'AKIARACETWO']).toContain(
        (await stored('raced-name')).accessKeyId,
      );
    });

    it('keeps the existing update contract when overwrite is omitted', async () => {
      await seedCredential('replace-me', CloudType.AWS);

      const res = await credPut({
        name: 'replace-me',
        cloudProvider: 'AWS',
        accessKeyId: 'AKIAREPLACED',
        secretAccessKey: 'replacement-secret',
      });

      expect(res.status).toBe(204);
      expect((await stored('replace-me')).accessKeyId).toBe('AKIAREPLACED');
    });

    it('returns 400 for an empty path name', async () => {
      const res = await credPut({
        name: ' ',
        cloudProvider: 'AWS',
        accessKeyId: 'x',
        secretAccessKey: 'y',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid cloudProvider', async () => {
      const res = await credPut({ name: 'x', cloudProvider: 'INVALID' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing AWS fields', async () => {
      const res = await credPut({
        name: 'x',
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing GCP fields', async () => {
      const res = await credPut({
        name: 'x',
        cloudProvider: 'GCP',
        projectId: 'p',
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- PATCH /credentials/:name ----
  describe('PATCH /credentials/:name', () => {
    it('merges a partial edit into the stored credential', async () => {
      await seedCredential('my-gcp', CloudType.GCP, {
        billingExportDataset: 'billing-project.billing_export',
      });

      const res = await credPatch('my-gcp', { privateKey: 'new-private-key' });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(await stored('my-gcp')).toEqual({
        cloudProvider: 'GCP',
        projectId: 'proj-1',
        clientEmail: 'sa@proj-1.iam.gserviceaccount.com',
        privateKey: 'new-private-key',
        billingExportDataset: 'billing-project.billing_export',
      });
    });

    it('rejects a field of another provider and keeps the stored credential', async () => {
      await seedCredential('my-aws', CloudType.AWS);

      const res = await credPatch('my-aws', { apiKey: 'lambda-key' });

      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('apiKey');
      expect(body).not.toContain('secret-key-aws');
      expect(await stored('my-aws')).toEqual({
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA1234',
        secretAccessKey: 'secret-key-aws',
      });
    });

    it('rejects a provider change', async () => {
      await seedCredential('my-aws', CloudType.AWS);

      const res = await credPatch('my-aws', { cloudProvider: 'GCP' });

      expect(res.status).toBe(400);
      expect((await stored('my-aws')).cloudProvider).toBe('AWS');
    });

    it('returns 409 when another edit changes the credential first', async () => {
      await seedCredential('my-aws', CloudType.AWS);
      const store = getCredentialSecretStore();
      const save = store.saveNamedCredential.bind(store);
      vi.spyOn(store, 'saveNamedCredential').mockImplementationOnce(
        async (...args) => {
          await seedCredential('my-aws', CloudType.AWS, {
            secretAccessKey: 'concurrent-secret',
          });
          return save(...args);
        },
      );

      const res = await credPatch('my-aws', { accessKeyId: 'AKIALATE' });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'CREDENTIAL_CHANGED' });
      expect(await stored('my-aws')).toEqual({
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA1234',
        secretAccessKey: 'concurrent-secret',
      });
    });

    it("refuses an edit that makes it another credential's material", async () => {
      await seedCredential('kept-name', CloudType.AWS);
      await seedCredential('edited-name', CloudType.AWS, {
        secretAccessKey: 'other-secret',
      });

      const res = await credPatch('edited-name', {
        secretAccessKey: 'secret-key-aws',
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'CREDENTIALS_EXIST',
        data: { name: 'edited-name', existingName: 'kept-name' },
      });
      expect((await stored('kept-name')).secretAccessKey).toBe(
        'secret-key-aws',
      );
      expect((await stored('edited-name')).secretAccessKey).toBe(
        'other-secret',
      );
    });

    it('returns 404 when the credential is deleted during the edit', async () => {
      await seedCredential('my-aws', CloudType.AWS);
      const store = getCredentialSecretStore();
      const save = store.saveNamedCredential.bind(store);
      vi.spyOn(store, 'saveNamedCredential').mockImplementationOnce(
        async (...args) => {
          await store.deleteNamedCredentialIfNotReferenced('my-aws', true);
          return save(...args);
        },
      );

      const res = await credPatch('my-aws', { accessKeyId: 'AKIALATE' });

      expect(res.status).toBe(404);
      expect((await credGet('/my-aws')).status).toBe(404);
    });

    it('sets an optional Cloudflare jurisdiction', async () => {
      await credPut({
        name: 'r2',
        cloudProvider: 'Cloudflare',
        accountId: 'cf-account',
        apiToken: 'cf-token-secret',
      });

      const res = await credPatch('r2', { jurisdiction: 'eu' });

      expect(res.status).toBe(204);
      expect(await stored('r2')).toMatchObject({
        accountId: 'cf-account',
        apiToken: 'cf-token-secret',
        jurisdiction: 'eu',
      });
    });

    it('returns 404 for a missing credential', async () => {
      const res = await credPatch('nonexistent', { apiKey: 'lambda-key' });
      expect(res.status).toBe(404);
    });
  });

  // ---- DELETE /credentials/:name ----
  describe('DELETE /credentials/:name', () => {
    it('deletes a credential', async () => {
      await seedCredential('my-aws', CloudType.AWS);

      const res = await credDelete('my-aws');
      expect(res.status).toBe(204);

      // Verify it was deleted
      const getRes = await credGet('/my-aws');
      expect(getRes.status).toBe(404);
    });

    it.each(['', '?overwrite=false'])(
      'names material that a forced delete left nameless (%s)',
      async (query) => {
        await seedCredential('in-use', CloudType.AWS);
        await createWorkload(getDB(), {
          id: 'uses-in-use',
          userId: 'test-user',
          workloadType: 'job',
          image: 'alpine:latest',
          dockerCommand: 'docker run alpine',
          sshPrivateKey: 'ssh-ed25519-test-private-key',
          credentialId: (await resolveCredentialByName('in-use'))!.id,
        });
        expect((await credDelete('in-use', '?force=true')).status).toBe(204);

        const res = await credPut(
          {
            name: 'renamed',
            cloudProvider: 'AWS',
            accessKeyId: 'AKIA1234',
            secretAccessKey: 'secret-key-aws',
          },
          query,
        );

        expect(res.status).toBe(204);
        expect((await stored('renamed')).accessKeyId).toBe('AKIA1234');
      },
    );

    it('treats a missing credential as already deleted', async () => {
      const res = await credDelete('missing');
      expect(res.status).toBe(204);
    });
  });
});
