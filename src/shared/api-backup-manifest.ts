/**
 * `backup.json`, the hosted API's backup manifest: the API writes it last,
 * after the database, and `cluster create --checkpoint-bucket` reads it to
 * restore (RFC 0049 C26 (e)). Shared so the CLI parses it without `src/api`.
 */

/** Written last: a restore trusts only a database that matches it. */
export const API_BACKUP_MANIFEST_KEY = 'anycloud-api/backup.json';

/**
 * What `backup.json` records about where an installation's resources live,
 * so `cluster delete` on another machine can sweep each account (RFC 0049
 * C26 (c)). The management VM's cloud and account and the backup trust are
 * recorded beside these in `backup.json` (C26 (e)). Names and accounts only:
 * no secret.
 */
export interface ApiBackupInventory {
  readonly credentials: ReadonlyArray<{
    name: string;
    cloud: string;
    /** GCP project, Azure subscription or AWS account; Lambda keys name none. */
    account: string | null;
  }>;
}

/**
 * What `api-database-backup.ts` writes last, after the database. A backup
 * from before RFC 0049 C26 (c), or one whose inventory read failed, has no
 * inventory fields.
 */
export interface ApiBackupManifest extends Partial<ApiBackupInventory> {
  version: 1;
  clusterId: string;
  backedUpAt: string;
  schemaAppVersion: string | null;
  databaseSha256: string;
  /**
   * Where the cluster ran and what it was (RFC 0049 C26 (e)): its cloud and
   * AWS account, GCP project or Azure subscription, which restore's guard
   * checks, and its name, region and management VM type, which a restore
   * command names when the hosted API is gone. Absent before 0.1.74.
   */
  cloud?: string;
  account?: string;
  name?: string;
  region?: string;
  vmType?: string;
}

export function parseApiBackupManifest(raw: string): ApiBackupManifest {
  let value: Partial<ApiBackupManifest>;
  try {
    value = JSON.parse(raw) as Partial<ApiBackupManifest>;
  } catch {
    throw new Error(`${API_BACKUP_MANIFEST_KEY} is malformed`);
  }
  if (
    value.version !== 1 ||
    typeof value.clusterId !== 'string' ||
    !value.clusterId ||
    typeof value.backedUpAt !== 'string' ||
    (value.schemaAppVersion !== null &&
      typeof value.schemaAppVersion !== 'string') ||
    typeof value.databaseSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.databaseSha256) ||
    (value.credentials !== undefined && !Array.isArray(value.credentials)) ||
    (['cloud', 'account', 'name', 'region', 'vmType'] as const).some(
      (field) => value[field] !== undefined && typeof value[field] !== 'string',
    )
  ) {
    throw new Error(`${API_BACKUP_MANIFEST_KEY} is malformed`);
  }
  return value as ApiBackupManifest;
}

/**
 * Restore's account guard: two APIs must never write one bucket, and the
 * old management VM is looked up in the account `backup.json` records. A
 * lookup in another account finds nothing and would pass, so the session
 * must be in that account.
 */
export function checkRestoreAccount(
  manifest: Pick<ApiBackupManifest, 'clusterId' | 'cloud' | 'account'>,
  session: { cloud: string; account: string },
): void {
  const { clusterId, cloud, account } = manifest;
  if (!cloud || !account) {
    const field = cloud ? 'account' : 'cloud';
    throw new Error(
      `The backup of cluster ${clusterId} records no ${field} (backup.json's "${field}"), so the cloud can't show whether its management VM still runs; backups from before anycloud 0.1.74 lack it. Restore it with the anycloud version that wrote it`,
    );
  }
  if (cloud !== session.cloud || account !== session.account) {
    throw new Error(
      `The backup of cluster ${clusterId} was written in ${cloud} account ${account}, but this ${session.cloud} session is for ${session.account}; sign in to ${account} and retry the restore`,
    );
  }
}
