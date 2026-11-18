import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudType, type CloudCredentials } from '../../shared/cloud.js';
import { createAwsStsClient } from './provider-clients/aws.js';
import { gcpProjectId } from './provider-clients/gcp.js';
import type { NodePoolRepository } from './cluster-store.js';
import type { ApiBackupInventory } from '../../shared/api-backup-manifest.js';

/** The account a credential acts in; null when it records none. */
export async function credentialAccount(
  credential: CloudCredentials,
  awsAccount: (credential: CloudCredentials) => Promise<string>,
): Promise<string | null> {
  // cloudtype-boundary-ok: each credential shape names its account its own way.
  switch (credential.cloudProvider) {
    case CloudType.AWS:
      return 'kind' in credential
        ? (credential.roleArn.split(':')[4] ?? null)
        : awsAccount(credential);
    case CloudType.GCP:
      return gcpProjectId(credential);
    case CloudType.Azure:
      return credential.subscriptionId;
    case CloudType.Lambda:
    case CloudType.Cloudflare: // cloudtype-boundary-ok: names no account
      return null;
  }
}

/** STS reports a key's account; a key's ID never changes, so cache by it. */
const awsAccounts = new Map<string, Promise<string>>();
function stsAccount(credential: CloudCredentials): Promise<string> {
  const { accessKeyId, secretAccessKey, sessionToken } =
    credential as unknown as Record<string, string>;
  const key = `${accessKeyId}\0${sessionToken ?? ''}`;
  let account = awsAccounts.get(key);
  if (!account) {
    account = createAwsStsClient(
      {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        ...(sessionToken && { sessionToken }),
      },
      { region: 'us-east-1' },
    )
      .send(new GetCallerIdentityCommand({}))
      .then(({ Account }) => {
        if (!Account) throw new Error('STS returned no account');
        return Account;
      });
    account.catch(() => awsAccounts.delete(key));
    awsAccounts.set(key, account);
  }
  return account;
}

export async function readApiBackupInventory(deps: {
  credentials: {
    listNamedCredentials(): Promise<
      Array<{
        id: string;
        name: string;
        cloudProvider: string;
        encryptedData: string;
      }>
    >;
  };
  nodePools: Pick<NodePoolRepository, 'listForReconciliation'>;
  decrypt(encrypted: string): Promise<CloudCredentials>;
  awsAccount?(credential: CloudCredentials): Promise<string>;
}): Promise<ApiBackupInventory> {
  const rows = (await deps.credentials.listNamedCredentials()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const credentials = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      cloud: row.cloudProvider,
      // One unreadable account leaves that credential's unknown, not the rest.
      account: await deps
        .decrypt(row.encryptedData)
        .then((credential) =>
          credentialAccount(credential, deps.awsAccount ?? stsAccount),
        )
        .catch(() => null),
    })),
  );
  const byId = new Map(credentials.map((entry) => [entry.id, entry]));
  const pools = (await deps.nodePools.listForReconciliation()).map((pool) => ({
    id: pool.id,
    name: pool.name,
    cloud: pool.cloudProvider,
    credential: byId.get(pool.computeCredentialId)?.name ?? null,
    account: byId.get(pool.computeCredentialId)?.account ?? null,
    region: pool.region,
    zone: pool.zone,
  }));
  return {
    credentials: credentials.map(({ id: _id, ...entry }) => entry),
    pools,
  };
}
