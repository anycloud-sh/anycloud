/**
 * Durable cluster records: installation intent, the management VM
 * attempt in the existing `vms` ledger, and the monotonic release intent
 * sequence. Bootstrap writes each step here before or immediately after the
 * matching cloud/Kubernetes mutation, so an interrupted run resumes from the
 * same identities instead of creating a second set.
 */

import { decryptSecret, encryptSecret } from './secret-crypto.js';
import type { DB } from './repositories/db.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import {
  resolveGatewayVM,
  type GatewayVM,
  type ProvisioningAttemptRef,
} from './entities.js';
import type { CheckpointTarget } from '../../shared/checkpoint.js';
import type { SystemReleaseClusterRecord } from '../../shared/system-release-values.js';
import type { CloudType } from '../../shared/cloud.js';
import {
  ClusterState,
  ClusterStep,
  ClusterReleaseState,
} from '../../shared/clusters.js';

export interface StoredCluster {
  id: string;
  ownerUserId: string;
  name: string;
  state: ClusterState;
  step: ClusterStep;
  computeCredentialId: string;
  cloudProvider: CloudType;
  region: string;
  zone: string | null;
  vmType: string;
  k3sVersion: string;
  k3sSha256: string;
  helmJobImage: string;
  apiVersion: string;
  apiImage: string;
  chartVersion: string;
  chartSha256: string;
  /** Checkpoint bucket holding the hosted API's database backups; null on pre-0115 installations. */
  checkpointBucket: CheckpointTarget | null;
  /** Created from the checkpoint bucket's existing hosted API backup. */
  restoreFromBackup: boolean;
  kubernetesIdentity: string | null;
  /** The record id once the connection is bound; null while creation has not reached it. */
  connectionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordClusterInput {
  id: string;
  ownerUserId: string;
  name: string;
  computeCredentialId: string;
  region: string;
  zone: string | null;
  vmType: string;
  k3sVersion: string;
  k3sSha256: string;
  helmJobImage: string;
  apiVersion: string;
  apiImage: string;
  chartVersion: string;
  chartSha256: string;
  checkpointBucket: CheckpointTarget;
  restoreFromBackup: boolean;
  serverToken: string;
  sshPublicKey: string;
  sshPrivateKey: string;
}

export type ClusterRecordResult = 'recorded' | 'installation-exists';

export interface StoredManagementVm {
  id: number;
  cloudId: string;
  ip: string | null;
  privateIp: string | null;
  region: string | null;
  availabilityZone: string | null;
  credentialId: string;
  createdAt: number;
  endedAt: number | null;
  /** Set when a restore replaced its record: the lost cluster's VM to release. */
  removalRequestedAt: number | null;
}

export interface StoredClusterRelease {
  installationId: string;
  revision: number;
  operationId: string;
  apiVersion: string;
  apiImage: string;
  chartVersion: string;
  chartSha256: string;
  valuesSha256: string;
  state: ClusterReleaseState;
  createdAt: number;
  updatedAt: number;
}

export interface SeedClusterReleaseInput {
  installationId: string;
  revision: number;
  operationId: string;
  apiVersion: string;
  apiImage: string;
  chartVersion: string;
  chartSha256: string;
  valuesSha256: string;
}

export interface ClusterInstallerRepository {
  record(input: RecordClusterInput): Promise<ClusterRecordResult>;
  getForScope(
    installationId: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null>;
  getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null>;
  listForScope(
    scope: OwnershipScope,
    options?: { includeDestroyed?: boolean },
  ): Promise<StoredCluster[]>;
  /** Decrypted bootstrap secrets; never returned through a public contract. */
  getBootstrapSecrets(installationId: string): Promise<{
    serverToken: string;
    sshPublicKey: string;
    sshPrivateKey: string;
  }>;
  /** Advance the completed step. Steps only move forward. */
  completeStep(installationId: string, step: ClusterStep): Promise<void>;
  recordKubernetesIdentity(
    installationId: string,
    kubernetesIdentity: string,
  ): Promise<void>;
  recordSelf(input: {
    id: string;
    ownerUserId: string;
    name: string;
    kubernetesIdentity: string;
    connection: string;
    /** Absent before 0.1.74's release values. */
    record?: SystemReleaseClusterRecord | null;
  }): Promise<'recorded' | 'exists' | 'identity-mismatch'>;
  /**
   * Replace a held record with a restore under the same id in one
   * transaction: its release ledger goes, its management VM rows stay for the
   * restore's bootstrap to release.
   */
  replaceForRestore(input: RecordClusterInput): Promise<ClusterRecordResult>;
  dropReleasedManagementVm(
    installationId: string,
    vmRowId: number,
  ): Promise<void>;
  adoptSelf(input: {
    id: string;
    kubernetesIdentity: string;
    connection: string;
    record: SystemReleaseClusterRecord | null;
  }): Promise<boolean>;
  /** The managed checkpoint bucket was deleted: the record names none. */
  clearCheckpointBucket(installationId: string): Promise<void>;
  setState(
    installationId: string,
    state: ClusterState,
    lastError?: string | null,
  ): Promise<void>;
  /**
   * Insert the management VM attempt before the provider call. Returns the
   * existing live attempt when one is already recorded, so a resumed bootstrap
   * adopts it instead of creating a second VM.
   */
  beginManagementVmAttempt(
    installationId: string,
    cloudId: string,
  ): Promise<ProvisioningAttemptRef>;
  completeManagementVmAttempt(
    installationId: string,
    ref: ProvisioningAttemptRef,
    vm: GatewayVM,
  ): Promise<void>;
  getManagementVm(installationId: string): Promise<StoredManagementVm | null>;
  /** True once any management VM attempt of this installation has ended. */
  hasReleasedManagementVm(installationId: string): Promise<boolean>;
  endManagementVm(installationId: string, vmRowId: number): Promise<void>;
  seedReleaseIntent(
    input: SeedClusterReleaseInput,
  ): Promise<'seeded' | 'exists'>;
  currentReleaseIntent(
    installationId: string,
  ): Promise<StoredClusterRelease | null>;
  setReleaseIntentState(
    installationId: string,
    revision: number,
    state: ClusterReleaseState,
  ): Promise<void>;
}

interface InstallationRow {
  id: string;
  owner_user_id: string;
  name: string;
  state: ClusterState;
  step: ClusterStep;
  compute_credential_id: string;
  cloud_provider: CloudType;
  region: string;
  zone: string | null;
  vm_type: string;
  k3s_version: string;
  k3s_sha256: string;
  helm_job_image: string;
  api_version: string;
  api_image: string;
  chart_version: string;
  chart_sha256: string;
  checkpoint_bucket: string | null;
  checkpoint_bucket_managed: number;
  restore_from_backup: number;
  kubernetes_identity: string | null;
  connection_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface VmRow {
  id: number;
  cloud_id: string;
  ip: string | null;
  private_ip: string | null;
  region: string | null;
  availability_zone: string | null;
  credential_id: string;
  created_at: number;
  ended_at: number | null;
  removal_requested_at: number | null;
}

interface ReleaseIntentRow {
  cluster_id: string;
  revision: number;
  operation_id: string;
  api_version: string;
  api_image: string;
  chart_version: string;
  chart_sha256: string;
  values_sha256: string;
  state: ClusterReleaseState;
  created_at: number;
  updated_at: number;
}

const INSTALLATION_COLUMNS = `i.id, i.owner_user_id, i.name, i.state, i.step,
  i.compute_credential_id, c.cloud_provider, i.region, i.zone, i.vm_type,
  i.k3s_version, i.k3s_sha256, i.helm_job_image, i.api_version, i.api_image,
  i.chart_version, i.chart_sha256, i.checkpoint_bucket,
  i.checkpoint_bucket_managed, i.restore_from_backup, i.kubernetes_identity,
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
    ownerUserId: row.owner_user_id,
    name: row.name,
    state: row.state,
    step: row.step,
    computeCredentialId: row.compute_credential_id,
    cloudProvider: row.cloud_provider,
    region: row.region,
    zone: row.zone,
    vmType: row.vm_type,
    k3sVersion: row.k3s_version,
    k3sSha256: row.k3s_sha256,
    helmJobImage: row.helm_job_image,
    apiVersion: row.api_version,
    apiImage: row.api_image,
    chartVersion: row.chart_version,
    chartSha256: row.chart_sha256,
    checkpointBucket: row.checkpoint_bucket
      ? {
          name: row.checkpoint_bucket,
          managed: row.checkpoint_bucket_managed === 1,
        }
      : null,
    restoreFromBackup: row.restore_from_backup === 1,
    kubernetesIdentity: row.kubernetes_identity,
    connectionId: row.connection_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredVm(row: VmRow): StoredManagementVm {
  return {
    id: row.id,
    cloudId: row.cloud_id,
    ip: row.ip,
    privateIp: row.private_ip,
    region: row.region,
    availabilityZone: row.availability_zone,
    credentialId: row.credential_id,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    removalRequestedAt: row.removal_requested_at,
  };
}

function toStoredIntent(row: ReleaseIntentRow): StoredClusterRelease {
  return {
    installationId: row.cluster_id,
    revision: row.revision,
    operationId: row.operation_id,
    apiVersion: row.api_version,
    apiImage: row.api_image,
    chartVersion: row.chart_version,
    chartSha256: row.chart_sha256,
    valuesSha256: row.values_sha256,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ClusterInstallerStore implements ClusterInstallerRepository {
  constructor(private readonly db: DB) {}

  async record(
    input: RecordClusterInput,
    replace = false,
  ): Promise<ClusterRecordResult> {
    const now = Date.now();
    const encryptedServerToken = await encryptSecret(
      assertNonEmpty(input.serverToken, 'cluster server token'),
    );
    // Stored byte-for-byte: OpenSSH refuses a private key whose END marker
    // is not followed by a newline ("error in libcrypto"), so trimming here
    // would make every later host connection fail.
    if (!input.sshPrivateKey.trim()) {
      throw new Error('Bootstrap SSH private key is required');
    }
    const encryptedSshPrivateKey = await encryptSecret(input.sshPrivateKey);
    const insert = `INSERT INTO clusters (
           id, owner_user_id, name, state, step, compute_credential_id, region,
           zone, vm_type, k3s_version, k3s_sha256, helm_job_image, api_version,
           api_image, chart_version, chart_sha256, checkpoint_bucket,
           checkpoint_bucket_managed, restore_from_backup, encrypted_server_token,
           ssh_public_key, encrypted_ssh_private_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
      assertNonEmpty(input.id, 'Installation id'),
      assertNonEmpty(input.ownerUserId, 'Installation owner user id'),
      assertNonEmpty(input.name, 'Installation name'),
      ClusterState.Bootstrapping,
      ClusterStep.Intent,
      assertNonEmpty(input.computeCredentialId, 'Compute credential id'),
      assertNonEmpty(input.region, 'Region'),
      input.zone?.trim() || null,
      assertNonEmpty(input.vmType, 'VM type'),
      assertNonEmpty(input.k3sVersion, 'K3s version'),
      assertNonEmpty(input.k3sSha256, 'K3s SHA-256'),
      assertNonEmpty(input.helmJobImage, 'Helm Job image'),
      assertNonEmpty(input.apiVersion, 'API version'),
      assertNonEmpty(input.apiImage, 'API image'),
      assertNonEmpty(input.chartVersion, 'Chart version'),
      assertNonEmpty(input.chartSha256, 'Chart SHA-256'),
      assertNonEmpty(input.checkpointBucket.name, 'Checkpoint bucket'),
      input.checkpointBucket.managed ? 1 : 0,
      input.restoreFromBackup ? 1 : 0,
      encryptedServerToken,
      assertNonEmpty(input.sshPublicKey, 'Bootstrap SSH public key'),
      encryptedSshPrivateKey,
      now,
      now,
    ];
    try {
      if (!replace) {
        await this.db.query(insert, params);
      } else {
        // Same id as the record it replaces: foreign keys are checked at
        // commit, so the held record's live management VM row stays attached,
        // flagged for the restore's bootstrap to release; its released
        // history goes with the record.
        await this.db.transaction((tx) => {
          tx.query('PRAGMA defer_foreign_keys = ON');
          tx.query('DELETE FROM cluster_releases WHERE cluster_id = ?', [
            input.id,
          ]);
          tx.query(
            'DELETE FROM vms WHERE cluster_id = ? AND ended_at IS NOT NULL',
            [input.id],
          );
          tx.query(
            `UPDATE vms SET removal_requested_at = COALESCE(removal_requested_at, ?)
             WHERE cluster_id = ? AND ended_at IS NULL`,
            [now, input.id],
          );
          tx.query('DELETE FROM clusters WHERE id = ?', [input.id]);
          tx.query(insert, params);
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed') &&
        error.message.includes('clusters')
      ) {
        return 'installation-exists';
      }
      throw error;
    }
    return 'recorded';
  }

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

  async listForScope(
    scope: OwnershipScope,
    options?: { includeDestroyed?: boolean },
  ): Promise<StoredCluster[]> {
    const owner = ownership(scope, 'i');
    const rows = await this.db.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} ${INSTALLATION_FROM}
       WHERE ${owner.sql} AND (? = 1 OR i.state <> ?)
       ORDER BY i.created_at, i.id`,
      [
        ...owner.params,
        options?.includeDestroyed ? 1 : 0,
        ClusterState.Destroyed,
      ],
    );
    return rows.map(toStored);
  }

  async getBootstrapSecrets(installationId: string): Promise<{
    serverToken: string;
    sshPublicKey: string;
    sshPrivateKey: string;
  }> {
    const rows = await this.db.query<{
      encrypted_server_token: string;
      ssh_public_key: string;
      encrypted_ssh_private_key: string;
    }>(
      `SELECT encrypted_server_token, ssh_public_key, encrypted_ssh_private_key
       FROM clusters
       WHERE id = ?`,
      [installationId],
    );
    if (!rows[0]) {
      throw new Error(`cluster ${installationId} is missing`);
    }
    return {
      serverToken: await decryptSecret(rows[0].encrypted_server_token),
      sshPublicKey: rows[0].ssh_public_key,
      sshPrivateKey: await decryptSecret(rows[0].encrypted_ssh_private_key),
    };
  }

  async completeStep(installationId: string, step: ClusterStep): Promise<void> {
    await this.db.query(
      `UPDATE clusters
       SET step = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
      [step, Date.now(), installationId],
    );
  }

  async recordKubernetesIdentity(
    installationId: string,
    kubernetesIdentity: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE clusters
       SET kubernetes_identity = ?, updated_at = ?
       WHERE id = ? AND (kubernetes_identity IS NULL OR kubernetes_identity = ?)`,
      [
        assertNonEmpty(kubernetesIdentity, 'Kubernetes identity'),
        Date.now(),
        installationId,
        kubernetesIdentity,
      ],
    );
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

  replaceForRestore(input: RecordClusterInput): Promise<ClusterRecordResult> {
    return this.record(input, true);
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

  async setState(
    installationId: string,
    state: ClusterState,
    lastError: string | null = null,
  ): Promise<void> {
    // A destroyed record keeps no connection (CHECK); the revision bump
    // invalidates any cached runtime.
    const destroyed = state === ClusterState.Destroyed;
    await this.db.query(
      `UPDATE clusters
       SET state = ?, last_error = ?, updated_at = ?,
           encrypted_connection = CASE WHEN ? THEN NULL ELSE encrypted_connection END,
           connection_revision = connection_revision + ?
       WHERE id = ?`,
      [
        state,
        lastError,
        Date.now(),
        destroyed ? 1 : 0,
        destroyed ? 1 : 0,
        installationId,
      ],
    );
  }

  async beginManagementVmAttempt(
    installationId: string,
    cloudId: string,
  ): Promise<ProvisioningAttemptRef> {
    const existing = await this.getManagementVm(installationId);
    if (existing) {
      return {
        vmRowId: existing.id,
        cloudId: existing.cloudId,
        createdAt: existing.createdAt,
      };
    }
    const createdAt = Date.now();
    const rows = await this.db.query<{
      id: number;
      cloud_id: string;
      created_at: number;
    }>(
      `INSERT INTO vms (
         cluster_id, cloud_id, created_at, region, availability_zone,
         credential_id, vm_type
       )
       SELECT i.id, ?, ?, i.region, i.zone, i.compute_credential_id, i.vm_type
       FROM clusters i
       WHERE i.id = ? AND i.state = ?
         AND NOT EXISTS (
           SELECT 1 FROM vms live
           WHERE live.cluster_id = i.id AND live.ended_at IS NULL
         )
       RETURNING id, cloud_id, created_at`,
      [
        assertNonEmpty(cloudId, 'Management VM cloud id'),
        createdAt,
        installationId,
        ClusterState.Bootstrapping,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`cluster ${installationId} cannot begin a VM attempt`);
    }
    return {
      vmRowId: row.id,
      cloudId: row.cloud_id,
      createdAt: row.created_at,
    };
  }

  async completeManagementVmAttempt(
    installationId: string,
    ref: ProvisioningAttemptRef,
    vm: GatewayVM,
  ): Promise<void> {
    const { sshHost, sshPort, sshUsername } = resolveGatewayVM(vm);
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE vms
       SET ip = ?, cloud_id = ?, private_ip = ?, base_image_id = ?,
           availability_zone = COALESCE(?, availability_zone),
           created_at = ?, ssh_host = ?, ssh_port = ?, ssh_username = ?
       WHERE id = ? AND cluster_id = ? AND ip IS NULL
         AND ended_at IS NULL`,
      [
        vm.ip,
        vm.cloudId,
        vm.privateIp ?? null,
        vm.baseImageId ?? null,
        vm.availabilityZone ?? null,
        vm.createdAt ?? ref.createdAt,
        sshHost,
        sshPort,
        sshUsername,
        ref.vmRowId,
        installationId,
      ],
    );
    if (result[0]?.rowsAffected === 1) return;
    const existing = await this.getManagementVm(installationId);
    if (existing?.id === ref.vmRowId && existing.cloudId === vm.cloudId) {
      return;
    }
    throw new Error(
      `cluster ${installationId}: VM attempt ${ref.vmRowId} is missing or already completed`,
    );
  }

  async getManagementVm(
    installationId: string,
  ): Promise<StoredManagementVm | null> {
    const rows = await this.db.query<VmRow>(
      `SELECT id, cloud_id, ip, private_ip, region, availability_zone,
              credential_id, created_at, ended_at, removal_requested_at
       FROM vms
       WHERE cluster_id = ? AND ended_at IS NULL
       ORDER BY created_at, id
       LIMIT 1`,
      [installationId],
    );
    return rows[0] ? toStoredVm(rows[0]) : null;
  }

  async hasReleasedManagementVm(installationId: string): Promise<boolean> {
    const rows = await this.db.query<{ one: number }>(
      `SELECT 1 AS one FROM vms
       WHERE cluster_id = ? AND ended_at IS NOT NULL
       LIMIT 1`,
      [installationId],
    );
    return rows.length > 0;
  }

  /** A replaced record's VM, released for a restore: no history is kept. */
  async dropReleasedManagementVm(
    installationId: string,
    vmRowId: number,
  ): Promise<void> {
    await this.db.query('DELETE FROM vms WHERE id = ? AND cluster_id = ?', [
      vmRowId,
      installationId,
    ]);
  }

  async clearCheckpointBucket(installationId: string): Promise<void> {
    await this.db.query(
      `UPDATE clusters SET checkpoint_bucket = NULL, checkpoint_bucket_managed = 0,
              updated_at = ? WHERE id = ?`,
      [Date.now(), installationId],
    );
  }

  async endManagementVm(
    installationId: string,
    vmRowId: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE vms SET ended_at = ?
       WHERE id = ? AND cluster_id = ? AND ended_at IS NULL`,
      [Date.now(), vmRowId, installationId],
    );
  }

  async seedReleaseIntent(
    input: SeedClusterReleaseInput,
  ): Promise<'seeded' | 'exists'> {
    const now = Date.now();
    try {
      await this.db.query(
        `INSERT INTO cluster_releases (
           cluster_id, revision, operation_id, api_version, api_image,
           chart_version, chart_sha256, values_sha256, state, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.installationId,
          input.revision,
          assertNonEmpty(input.operationId, 'Release operation id'),
          input.apiVersion,
          input.apiImage,
          input.chartVersion,
          input.chartSha256,
          input.valuesSha256,
          ClusterReleaseState.Seeded,
          now,
          now,
        ],
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('UNIQUE constraint failed') ||
          error.message.includes('release revision must increase'))
      ) {
        return 'exists';
      }
      throw error;
    }
    return 'seeded';
  }

  async currentReleaseIntent(
    installationId: string,
  ): Promise<StoredClusterRelease | null> {
    const rows = await this.db.query<ReleaseIntentRow>(
      `SELECT * FROM cluster_releases
       WHERE cluster_id = ?
       ORDER BY revision DESC
       LIMIT 1`,
      [installationId],
    );
    return rows[0] ? toStoredIntent(rows[0]) : null;
  }

  async setReleaseIntentState(
    installationId: string,
    revision: number,
    state: ClusterReleaseState,
  ): Promise<void> {
    await this.db.query(
      `UPDATE cluster_releases
       SET state = ?, updated_at = ?
       WHERE cluster_id = ? AND revision = ?`,
      [state, Date.now(), installationId, revision],
    );
  }
}
