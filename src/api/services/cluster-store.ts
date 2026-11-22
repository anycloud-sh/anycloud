/**
 * The cluster record as the API reads it.
 *
 * The `clusters` table is written by the hosted API's self-record
 * (cluster-installer-store.ts); this store reads lifecycle. Connection material is read back only through
 * ClusterConnectionRepository.
 */

import { decryptSecret } from './secret-crypto.js';
import type { DB } from './repositories/db.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import { ClusterState } from '../../shared/clusters.js';
import type { SystemReleaseClusterRecord } from '../../shared/system-release-values.js';

export interface StoredClusterRecord {
  id: string;
  ownerUserId: string;
  name: string;
  state: ClusterState;
  /** Immutable `kube-system` namespace UID; null while bootstrap has not observed it. */
  kubernetesIdentity: string | null;
  connectionRevision: number;
  /** The creation facts the hosted API keeps (RFC 0049 C26 (a)). */
  record: SystemReleaseClusterRecord | null;
  createdAt: number;
  updatedAt: number;
}

type ClusterConnectionKind = 'installer' | 'in-cluster';

export interface ClusterConnection {
  clusterId: string;
  kubernetesIdentity: string;
  kind: ClusterConnectionKind;
  /** Serialized `ClusterConnectionDocument`. */
  connection: string;
  connectionRevision: number;
}

interface ClusterConnectionRepository {
  getConnection(clusterId: string): Promise<ClusterConnection | null>;
}

export interface ClusterRecordRepository extends ClusterConnectionRepository {
  getForScope(
    clusterId: string,
    scope: OwnershipScope,
  ): Promise<StoredClusterRecord | null>;
  getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredClusterRecord | null>;
  listForScope(scope: OwnershipScope): Promise<StoredClusterRecord[]>;
}

interface ClusterRecordRow {
  id: string;
  owner_user_id: string;
  name: string;
  state: ClusterState;
  /** Null until the control plane has answered (bootstrap in progress). */
  kubernetes_identity: string | null;
  connection_kind: ClusterConnectionKind;
  encrypted_connection: string | null;
  connection_revision: number;
  created_at: number;
  updated_at: number;
  cloud_provider: SystemReleaseClusterRecord['cloudProvider'] | null;
  cloud_account: string | null;
  region: string | null;
  zone: string | null;
  vm_type: string | null;
  management_vm_id: string | null;
  network_scope: string | null;
  k3s_version: string | null;
  k3s_sha256: string | null;
  checkpoint_bucket: string | null;
  checkpoint_bucket_managed: number;
}

/** The hosted API's record (0165); null on the installer's row and before 0.1.74. */
function toClusterRecordFacts(
  row: ClusterRecordRow,
): SystemReleaseClusterRecord | null {
  if (
    !row.cloud_provider ||
    !row.region ||
    !row.vm_type ||
    !row.management_vm_id ||
    !row.network_scope ||
    !row.k3s_version ||
    !row.k3s_sha256
  ) {
    return null;
  }
  return {
    cloudProvider: row.cloud_provider,
    cloudAccount: row.cloud_account,
    region: row.region,
    zone: row.zone,
    vmType: row.vm_type,
    managementVmId: row.management_vm_id,
    networkScope: row.network_scope,
    k3s: { version: row.k3s_version, sha256: row.k3s_sha256 },
    checkpointBucket: row.checkpoint_bucket
      ? {
          name: row.checkpoint_bucket,
          managed: row.checkpoint_bucket_managed === 1,
        }
      : null,
  };
}

function ownership(
  _scope: OwnershipScope,
  _alias: string,
): { sql: string; params: string[] } {
  return { sql: '1 = 1', params: [] };
}

function toStoredClusterRecord(row: ClusterRecordRow): StoredClusterRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    state: row.state,
    kubernetesIdentity: row.kubernetes_identity,
    connectionRevision: row.connection_revision,
    record: toClusterRecordFacts(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ClusterRecordStore implements ClusterRecordRepository {
  constructor(private readonly db: DB) {}

  async getForScope(
    clusterId: string,
    scope: OwnershipScope,
  ): Promise<StoredClusterRecord | null> {
    const owner = ownership(scope, 'r');
    const rows = await this.db.query<ClusterRecordRow>(
      `SELECT r.* FROM clusters r WHERE r.id = ? AND ${owner.sql}`,
      [clusterId, ...owner.params],
    );
    return rows[0] ? toStoredClusterRecord(rows[0]) : null;
  }

  async getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredClusterRecord | null> {
    const owner = ownership(scope, 'r');
    const rows = await this.db.query<ClusterRecordRow>(
      `SELECT r.* FROM clusters r
       WHERE r.name = ? COLLATE NOCASE AND r.state <> ? AND ${owner.sql}`,
      [name.trim(), ClusterState.Destroyed, ...owner.params],
    );
    return rows[0] ? toStoredClusterRecord(rows[0]) : null;
  }

  async listForScope(scope: OwnershipScope): Promise<StoredClusterRecord[]> {
    const owner = ownership(scope, 'r');
    const rows = await this.db.query<ClusterRecordRow>(
      `SELECT r.* FROM clusters r
       WHERE ${owner.sql} AND r.state <> ?
       ORDER BY r.created_at, r.id`,
      [...owner.params, ClusterState.Destroyed],
    );
    return rows.map(toStoredClusterRecord);
  }

  async getConnection(clusterId: string): Promise<ClusterConnection | null> {
    const rows = await this.db.query<ClusterRecordRow>(
      `SELECT * FROM clusters WHERE id = ? AND state <> ?`,
      [clusterId, ClusterState.Destroyed],
    );
    const row = rows[0];
    if (!row?.encrypted_connection || !row.kubernetes_identity) return null;
    return {
      clusterId: row.id,
      kubernetesIdentity: row.kubernetes_identity,
      kind: row.connection_kind,
      connection: await decryptSecret(row.encrypted_connection),
      connectionRevision: row.connection_revision,
    };
  }
}

/** ID first, then active name; a destroyed record answers only by ID. */
export async function resolveClusterRecordForScope(
  identifier: string,
  scope: OwnershipScope,
  records: Pick<ClusterRecordRepository, 'getForScope' | 'getByNameForScope'>,
): Promise<StoredClusterRecord | null> {
  return (
    (await records.getForScope(identifier, scope)) ??
    (await records.getByNameForScope(identifier, scope))
  );
}
