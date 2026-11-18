import type {
  DeletedResource,
  RemainingResource,
} from '../../shared/api-contract/lifecycle-results-schemas.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { GithubOwner } from './api-authentication.js';
import type { CloudCredentials, CloudType } from '../../shared/cloud.js';
import type { ApiBackupManifest } from '../../shared/api-backup-manifest.js';
import type { StoredCluster } from './cluster-installer-store.js';
import { clusterHostname } from '../../shared/api-ingress.js';

/** `api delete`'s final backup (RFC 0049 C28), as its result reports it. */
export type FinalBackup =
  | { finalBackup: 'taken'; backedUpAt: string }
  | { finalBackup: 'failed'; backedUpAt: string | null; error: string }
  | { finalBackup: 'skipped'; backedUpAt: string | null };

type StorageCredential = {
  cloudProvider: CloudType;
  credentials: CloudCredentials;
};

/** The clusters domain's dependencies this report reads through. */
interface Dependencies {
  hostedPools: {
    backup(
      installation: StoredCluster,
      owner: GithubOwner,
    ): Promise<{ backedUpAt: string }>;
  };
  storageCredential(credentialId: string): Promise<StorageCredential>;
  backupManifest(
    credential: StorageCredential,
    bucket: string,
    region: string,
  ): Promise<ApiBackupManifest | 'unrestorable' | null>;
}

/** The bucket's newest backup time; null when none can be read. */
async function newestBackup(
  dependencies: Dependencies,
  installation: StoredCluster,
): Promise<string | null> {
  const bucket = installation.checkpointBucket;
  if (!bucket) return null;
  const manifest = await dependencies
    .backupManifest(
      await dependencies.storageCredential(installation.computeCredentialId),
      bucket.name,
      installation.region,
    )
    .catch(() => null);
  return manifest !== null && typeof manifest === 'object'
    ? manifest.backedUpAt
    : null;
}

/**
 * A kept bucket is only as good as its newest backup, so the hosted API takes
 * one first. A failure never blocks the delete: a user whose bucket is broken
 * must still be able to uninstall.
 */
export async function takeFinalBackup(
  dependencies: Dependencies,
  installation: StoredCluster,
  owner: GithubOwner,
  hostedApiRuns: boolean,
): Promise<FinalBackup> {
  if (!hostedApiRuns) {
    return {
      finalBackup: 'skipped',
      backedUpAt: await newestBackup(dependencies, installation),
    };
  }
  try {
    const { backedUpAt } = await dependencies.hostedPools.backup(
      installation,
      owner,
    );
    return { finalBackup: 'taken', backedUpAt };
  } catch (error) {
    return {
      finalBackup: 'failed',
      backedUpAt: await newestBackup(dependencies, installation),
      error: errorMessage(error),
    };
  }
}

/** What this delete removes and keeps; the bucket is in exactly one list. */
export function deleteReport(
  installation: StoredCluster,
  {
    managementVm,
    dnsRecord,
    bucketDeleted,
    backup,
  }: {
    managementVm: string | null;
    dnsRecord: boolean;
    bucketDeleted: boolean;
    backup: FinalBackup | null;
  },
): { deleted: DeletedResource[]; remaining: RemainingResource[] } {
  const deleted: DeletedResource[] = [
    ...(managementVm
      ? [{ kind: 'managementVm' as const, id: managementVm }]
      : []),
    ...(dnsRecord
      ? [{ kind: 'dnsRecord' as const, name: clusterHostname(installation.id) }]
      : []),
  ];
  const bucket = installation.checkpointBucket;
  if (!bucket) return { deleted, remaining: [] };
  if (bucketDeleted) {
    return {
      deleted: [...deleted, { kind: 'checkpointBucket', name: bucket.name }],
      remaining: [],
    };
  }
  const zone = installation.zone ? ` --zone ${installation.zone}` : '';
  return {
    deleted,
    remaining: [
      {
        kind: 'checkpointBucket',
        name: bucket.name,
        managed: bucket.managed,
        reason: bucket.managed ? 'kept' : 'supplied',
        ...(backup ?? { finalBackup: 'skipped', backedUpAt: null }),
        restoreCommand: `anycloud api create ${installation.name} --cloud ${installation.cloudProvider.toLowerCase()} --region ${installation.region}${zone} --vm-type ${installation.vmType} --checkpoint-bucket ${bucket.name}`,
        ...(bucket.managed
          ? {
              deleteCommand: `anycloud api delete ${installation.id} --delete-buckets`,
            }
          : {}),
      },
    ],
  };
}
