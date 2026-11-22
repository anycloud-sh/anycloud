/**
 * Cluster rows: the hosted API's own record, which it writes when it starts,
 * and installations an earlier API created, read with their management VM in
 * the `vms` ledger and their latest release intent.
 */

import { encryptSecret } from './secret-crypto.js';
import type { DB } from './repositories/db.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import type { CheckpointTarget } from '../../shared/checkpoint.js';
import type { SystemReleaseClusterRecord } from '../../shared/system-release-values.js';
import type { CloudType } from '../../shared/cloud.js';
import { ClusterState, ClusterStep } from '../../shared/clusters.js';

export interface StoredCluster {
  id: string;
  name: string;
  state: ClusterState;
  step: ClusterStep;
  cloudProvider: CloudType;
  region: string;
  zone: string | null;
  vmType: string;
  k3sVersion: string;
  apiVersion: string;
  apiImage: string;
  chartVersion: string;
  /** Checkpoint bucket holding the hosted API's database backups; null on pre-0115 installations. */
  checkpointBucket: CheckpointTarget | null;
  kubernetesIdentity: string | null;
  /** The record id once the connection is bound; null while creation has not reached it. */
  connectionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The live management VM of an installation. */
export interface StoredManagementVm {
  cloudId: string;
  ip: string | null;
}

export interface StoredClusterRelease {
  apiVersion: string;
  apiImage: string;
  chartVersion: string;
}

export interface ClusterInstallerRepository {
  getForScope(
    installationId: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null>;
  getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null>;
  listForScope(scope: OwnershipScope): Promise<StoredCluster[]>;
  recordSelf(input: {
    id: string;
    ownerUserId: string;
    name: string;
    kubernetesIdentity: string;
    connection: string;
    /** Absent before 0.1.74's release values. */
    record?: SystemReleaseClusterRecord | null;
  }): Promise<'recorded' | 'exists' | 'identity-mismatch'>;
  adoptSelf(input: {
    id: string;
    kubernetesIdentity: string;
    connection: string;
    record: SystemReleaseClusterRecord | null;
  }): Promise<boolean>;
  getManagementVm(installationId: string): Promise<StoredManagementVm | null>;
  currentReleaseIntent(
    installationId: string,
  ): Promise<StoredClusterRelease | null>;
}

interface InstallationRow {
  id: string;
  name: string;
  state: ClusterState;
  step: ClusterStep;
  cloud_provider: CloudType;
  region: string;
  zone: string | null;
  vm_type: string;
  k3s_version: string;
  api_version: string;
  api_image: string;
  chart_version: string;
  checkpoint_bucket: string | null;
  checkpoint_bucket_managed: number;
  kubernetes_identity: string | null;
  connection_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const INSTALLATION_COLUMNS = `i.id, i.name, i.state, i.step, c.cloud_provider,
  i.region, i.zone, i.vm_type, i.k3s_version, i.api_version, i.api_image,
  i.chart_version, i.checkpoint_bucket, i.checkpoint_bucket_managed,
  i.kubernetes_identity,
  CASE WHEN i.encrypted_connection IS NULL THEN NULL ELSE i.id END AS connection_id,
  i.last_error, i.created_at, i.updated_at`;
const INSTALLATION_FROM = `FROM clusters i
  JOIN credentials c ON c.id = i.compute_credential_id`;

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

/** The hosted API's own record of the cluster (RFC 0049 C26 (a), migration 0165). */
const RECORD_COLUMNS = `cloud_provider, cloud_account, region, zone, vm_type,
  management_vm_id, network_scope, k3s_version, k3s_sha256, checkpoint_bucket,
  checkpoint_bucket_managed`;

function recordParams(
  record: SystemReleaseClusterRecord | null,
): Array<string | number | null> {
  return [
    record?.cloudProvider ?? null,
    record?.cloudAccount ?? null,
    record?.region ?? null,
    record?.zone ?? null,
    record?.vmType ?? null,
    record?.managementVmId ?? null,
    record?.networkScope ?? null,
    record?.k3s.version ?? null,
    record?.k3s.sha256 ?? null,
    record?.checkpointBucket?.name ?? null,
    record?.checkpointBucket?.managed ? 1 : 0,
  ];
}

function ownership(
  _scope: OwnershipScope,
  _alias: string,
): { sql: string; params: string[] } {
  return { sql: '1 = 1', params: [] };
}

function toStored(row: InstallationRow): StoredCluster {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    step: row.step,
    cloudProvider: row.cloud_provider,
    region: row.region,
    zone: row.zone,
    vmType: row.vm_type,
    k3sVersion: row.k3s_version,
    apiVersion: row.api_version,
    apiImage: row.api_image,
    chartVersion: row.chart_version,
    checkpointBucket: row.checkpoint_bucket
      ? {
          name: row.checkpoint_bucket,
          managed: row.checkpoint_bucket_managed === 1,
        }
      : null,
    kubernetesIdentity: row.kubernetes_identity,
    connectionId: row.connection_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ClusterInstallerStore implements ClusterInstallerRepository {
  constructor(private readonly db: DB) {}

  async getForScope(
    installationId: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null> {
    const owner = ownership(scope, 'i');
    const rows = await this.db.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} ${INSTALLATION_FROM}
       WHERE i.id = ? AND ${owner.sql}`,
      [installationId, ...owner.params],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  async getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null> {
    const owner = ownership(scope, 'i');
    const rows = await this.db.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} ${INSTALLATION_FROM}
       WHERE i.name = ? COLLATE NOCASE AND i.state <> ? AND ${owner.sql}`,
      [name.trim(), ClusterState.Destroyed, ...owner.params],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  async listForScope(scope: OwnershipScope): Promise<StoredCluster[]> {
    const owner = ownership(scope, 'i');
    const rows = await this.db.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} ${INSTALLATION_FROM}
       WHERE ${owner.sql} AND i.state <> ?
       ORDER BY i.created_at, i.id`,
      [...owner.params, ClusterState.Destroyed],
    );
    return rows.map(toStored);
  }

  /**
   * The hosted API's own record: complete from the start, bound to the
   * cluster it runs in with its in-cluster ServiceAccount. Idempotent for the
   * same identity; a different identity is refused by the identity trigger.
   */
  async recordSelf(input: {
    id: string;
    ownerUserId: string;
    name: string;
    kubernetesIdentity: string;
    connection: string;
    /** Absent before 0.1.74's release values. */
    record?: SystemReleaseClusterRecord | null;
  }): Promise<'recorded' | 'exists' | 'identity-mismatch'> {
    const existing = await this.db.query<{ kubernetes_identity: string }>(
      `SELECT kubernetes_identity FROM clusters WHERE id = ?`,
      [input.id],
    );
    if (existing[0]) {
      return existing[0].kubernetes_identity === input.kubernetesIdentity
        ? 'exists'
        : 'identity-mismatch';
    }
    const now = Date.now();
    await this.db.query(
      `INSERT INTO clusters (
         id, owner_user_id, name, state, step, kubernetes_identity,
         connection_kind, encrypted_connection, created_at, updated_at,
         ${RECORD_COLUMNS}
       ) VALUES (?, ?, ?, ?, ?, ?, 'in-cluster', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assertNonEmpty(input.id, 'Cluster id'),
        assertNonEmpty(input.ownerUserId, 'Cluster owner user id'),
        assertNonEmpty(input.name, 'Cluster name'),
        ClusterState.Ready,
        ClusterStep.Release,
        assertNonEmpty(input.kubernetesIdentity, 'Kubernetes identity'),
        await encryptSecret(input.connection),
        now,
        now,
        ...recordParams(input.record ?? null),
      ],
    );
    return 'recorded';
  }

  /**
   * A database restored into a new cluster takes it over: the record moves to
   * the new identity and connection (migration 0132 allows exactly this).
   */
  async adoptSelf(input: {
    id: string;
    kubernetesIdentity: string;
    connection: string;
    record: SystemReleaseClusterRecord | null;
  }): Promise<boolean> {
    const encrypted = await encryptSecret(input.connection);
    const now = Date.now();
    return this.db.transaction((tx) => {
      const updated = tx.query<{ rowsAffected: number }>(
        `UPDATE clusters
         SET kubernetes_identity = ?, encrypted_connection = ?,
             connection_revision = connection_revision + 1,
             identity_generation = identity_generation + 1, updated_at = ?,
             ${RECORD_COLUMNS.split(',')
               .map((column) => `${column.trim()} = ?`)
               .join(', ')}
         WHERE id = ? AND kubernetes_identity IS NOT ?`,
        [
          assertNonEmpty(input.kubernetesIdentity, 'Kubernetes identity'),
          encrypted,
          now,
          ...recordParams(input.record),
          input.id,
          input.kubernetesIdentity,
        ],
      );
      return updated[0]?.rowsAffected === 1;
    });
  }

  async getManagementVm(
    installationId: string,
  ): Promise<StoredManagementVm | null> {
    const rows = await this.db.query<{ cloud_id: string; ip: string | null }>(
      `SELECT cloud_id, ip
       FROM vms
       WHERE cluster_id = ? AND ended_at IS NULL
       ORDER BY created_at, id
       LIMIT 1`,
      [installationId],
    );
    return rows[0] ? { cloudId: rows[0].cloud_id, ip: rows[0].ip } : null;
  }

  async currentReleaseIntent(
    installationId: string,
  ): Promise<StoredClusterRelease | null> {
    const rows = await this.db.query<{
      api_version: string;
      api_image: string;
      chart_version: string;
    }>(
      `SELECT api_version, api_image, chart_version FROM cluster_releases
       WHERE cluster_id = ?
       ORDER BY revision DESC
       LIMIT 1`,
      [installationId],
    );
    return rows[0]
      ? {
          apiVersion: rows[0].api_version,
          apiImage: rows[0].api_image,
          chartVersion: rows[0].chart_version,
        }
      : null;
  }
}
