import { describe, expect, it, vi } from 'vitest';
import {
  credentialAccount,
  readApiBackupInventory,
} from '../../../src/api/services/api-backup-inventory.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import {
  getCredentialSecretStore,
  getPersistence,
} from '../../../src/api/services/persistence.js';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const creds = (fields: Record<string, string>) =>
  fields as unknown as CloudCredentials;

describe('credentialAccount', () => {
  const sts = vi.fn(async () => '111122223333');

  it('names the account each cloud acts in, and none for Lambda', async () => {
    const cases: Array<[Record<string, string>, string | null]> = [
      [
        {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA',
          secretAccessKey: 's',
        },
        '111122223333',
      ],
      [
        {
          cloudProvider: CloudType.AWS,
          kind: 'role',
          roleArn: 'arn:aws:iam::444455556666:role/anycloud',
        },
        '444455556666',
      ],
      [
        { cloudProvider: CloudType.GCP, projectId: 'prod-project' },
        'prod-project',
      ],
      [
        {
          cloudProvider: CloudType.GCP,
          kind: 'role',
          serviceAccountEmail: 'anycloud@role-project.iam.gserviceaccount.com',
        },
        'role-project',
      ],
      [{ cloudProvider: CloudType.Azure, subscriptionId: 'sub-1' }, 'sub-1'],
      [{ cloudProvider: CloudType.Lambda, apiKey: 'secret' }, null],
    ];
    for (const [fields, account] of cases) {
      await expect(credentialAccount(creds(fields), sts)).resolves.toBe(
        account,
      );
    }
    // Only the key asks STS; a role ARN already names its account.
    expect(sts).toHaveBeenCalledOnce();
  });
});

describe('readApiBackupInventory', () => {
  it('lists named credentials with accounts and live pools with their pinned location, and nothing secret', async () => {
    await seedReadyNodePool({ nodePoolId: 'pool-a', name: 'gpu' });
    await seedReadyNodePool({ nodePoolId: 'pool-b', name: 'gone' });
    const db = getDB();
    await db.query(
      `UPDATE credentials SET name = 'aws-prod', encrypted_data = 'sealed-aws' WHERE id = 'cred-a'`,
    );
    await db.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name) VALUES ('cred-l', 'sealed-lambda', 'Lambda', 'lambda'), ('cred-x', 'unreadable', 'Azure', 'broken')`,
    );
    await db.query(
      `UPDATE node_pools SET state = 'deleted' WHERE id = 'pool-b'`,
    );
    const decrypt = vi.fn(async (sealed: string) => {
      if (sealed === 'unreadable') throw new Error('bad seal');
      return creds(
        sealed === 'sealed-aws'
          ? {
              cloudProvider: CloudType.AWS,
              accessKeyId: 'AKIA',
              secretAccessKey: 's',
            }
          : { cloudProvider: CloudType.Lambda, apiKey: 'secret' },
      );
    });

    const inventory = await readApiBackupInventory({
      credentials: getCredentialSecretStore(),
      nodePools: getPersistence().nodePools,
      decrypt,
      awsAccount: async () => '111122223333',
    });

    expect(inventory).toEqual({
      credentials: [
        { name: 'aws-prod', cloud: 'AWS', account: '111122223333' },
        // One unreadable credential leaves only its own account unknown.
        { name: 'broken', cloud: 'Azure', account: null },
        { name: 'lambda', cloud: 'Lambda', account: null },
      ],
      pools: [
        {
          id: 'pool-a',
          name: 'gpu',
          cloud: 'AWS',
          credential: 'aws-prod',
          account: '111122223333',
          region: 'us-east-1',
          zone: null,
        },
      ],
    });
    expect(JSON.stringify(inventory)).not.toMatch(/secret|sealed|AKIA/);
  });
});
