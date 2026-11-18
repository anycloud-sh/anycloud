/**
 * The cluster record as the node pool side reads it, and node pool records.
 *
 * The `clusters` table is written by the installer (cluster-installer-store.ts)
 * and by the hosted API's self-record; this store binds the connection and
 * reads lifecycle and node pool ownership. Connection material is read back
 * only through ClusterConnectionRepository by the cluster runtime.
 */

import { decryptSecret, encryptSecret } from './secret-crypto.js';
import type { NodeDetached } from './node-detachment.js';
import {
  resolveGatewayVM,
  type GatewayVM,
  type ProvisioningAttemptRef,
} from './entities.js';
import type { DB } from './repositories/db.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import {
  liveNodePoolWorkloadSql,
  nodePoolDeploymentReferencesSql,
} from './repositories/node-pool-references.js';
import type {
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
} from '../../shared/cloud.js';
import {
  launchFailureDisposition,
  type LaunchFailure,
  type ProvisioningFailure,
} from './provisioning-failure.js';
import { ClusterState } from '../../shared/clusters.js';
import type { SystemReleaseClusterRecord } from '../../shared/system-release-values.js';
import { NodePoolState } from '../../shared/node-pools.js';

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

export interface StoreClusterConnectionInput {
  clusterId: string;
  kubernetesIdentity: string;
  kind: ClusterConnectionKind;
  /** Serialized `ClusterConnectionDocument`; encrypted at rest. */
  connection: string;
}

export interface ClusterConnection {
  clusterId: string;
  kubernetesIdentity: string;
  kind: ClusterConnectionKind;
  /** Serialized `ClusterConnectionDocument`. */
  connection: string;
  connectionRevision: number;
}

export interface ClusterConnectionRepository {
  getConnection(clusterId: string): Promise<ClusterConnection | null>;
}

export interface ClusterRecordRepository extends ClusterConnectionRepository {
  /**
   * Bind the cluster's control-plane identity and connection to its record.
   * The installer stores its bootstrap-time connection; the hosted API stores
   * its in-cluster kind (no credential). A different identity than the one
   * already recorded is refused.
   */
  storeConnection(
    input: StoreClusterConnectionInput,
  ): Promise<'stored' | 'identity-mismatch' | 'not-found'>;
  getForScope(
    clusterId: string,
    scope: OwnershipScope,
  ): Promise<StoredClusterRecord | null>;
  getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredClusterRecord | null>;
  listForScope(
    scope: OwnershipScope,
    options?: { includeDeleted?: boolean },
  ): Promise<StoredClusterRecord[]>;
  countActiveNodePools(clusterId: string): Promise<number>;
  /**
   * Ids of deleted cluster records that bound the same control plane, i.e. the
   * same `kube-system` namespace UID. Objects those clusterRecords installed on the
   * control plane may be adopted by the cluster that registered it again.
   */
  listDestroyedClusterIds(kubernetesIdentity: string): Promise<string[]>;
}

/** Starts the `last_error` a VM's failed release writes; matched in SQL too. */
export function vmReleaseFailurePrefix(cloudId: string): string {
  return `VM ${cloudId} termination not confirmed: `;
}
const VM_RELEASE_FAILURE_PREFIX_SQL = `'VM ' || v.cloud_id || ' termination not confirmed: '`;
/** Starts the `last_error` of a pool whose account cap holds its purchases. */
export const SCALE_OUT_CAP_BLOCK_PREFIX = 'scale-out blocked by account cap: ';
/** Starts the `last_error` of a pool whose Node remediation is paused. */
export const REMEDIATION_PAUSED_PREFIX = 'Node remediation paused: ';
/** Starts the `last_error` of a pool's notes on replacing outdated Nodes. */
export const OUTDATED_REPLACEMENT_PREFIX = 'replacing outdated Nodes';
/** Starts the `last_error` naming other pools' Nodes that claim this pool. */
export const IGNORED_CLAIM_PREFIX =
  'ignoring Nodes of other node pools that claim this one: ';
/** The `last_error`s markReady keeps until their own clearError. */
const KEPT_ERROR_PREFIXES = [
  SCALE_OUT_CAP_BLOCK_PREFIX,
  REMEDIATION_PAUSED_PREFIX,
  OUTDATED_REPLACEMENT_PREFIX,
  IGNORED_CLAIM_PREFIX,
];

export interface StoredNodePool {
  id: string;
  clusterId: string;
  ownerUserId: string;
  name: string;
  state: NodePoolState;
  computeCredentialId: string;
  cloudProvider: CloudType;
  /** Null when unpinned: each VM row keeps the region it launched in. */
  region: string | null;
  zone: string | null;
  /** The cluster's region when it is on the pool's cloud, tried first by an
   *  unpinned pool. */
  clusterRegion: string | null;
  /** Ordered; every type shares one accelerator capability. */
  vmTypes: string[];
  minVmCount: number;
  maxVmCount: number;
  /** Null: the provider's default. */
  osDiskSizeGb: number | null;
  osDiskTier: DiskTier | null;
  spot: boolean;
  /** Admits pool Jobs' `--privileged` and `--bind`. Deprecated. */
  allowPrivilegedJobs: boolean;
  /** Every pool Job runs in its own user namespace (RFC 0049 C32). */
  userNamespaceJobs: boolean;
  /** Launches only VM types with nested virtualization, with it on (RFC 0049 C10). */
  requireNestedVirtualization: boolean;
  lastError: string | null;
  /** Consecutive failed launches since the last success. */
  provisioningFailures: number;
  provisioningFailedAt: number | null;
  /** VM attempt whose Node is the pool's ingress entry; null until elected. */
  ingressEntryVmId: number | null;
  ingressEntryChangedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNodePoolInput {
  id: string;
  clusterId: string;
  ownerUserId: string;
  name: string;
  computeCredentialId: string;
  region: string | null;
  zone: string | null;
  vmTypes: string[];
  minVmCount: number;
  maxVmCount: number;
  osDiskSizeGb?: number;
  osDiskTier?: DiskTier;
  spot?: boolean;
  allowPrivilegedJobs?: boolean;
  userNamespaceJobs?: boolean;
  requireNestedVirtualization?: boolean;
}

export type NodePoolCreationResult = 'created' | 'cluster-not-accepting';

export type NodePoolDeletionRequestResult =
  | 'requested'
  | 'referenced'
  | 'already-deleting'
  | 'already-deleted'
  | 'not-found';

/**
 * Durable records that hold a node pool in use. Each predicate is evaluated
 * inside the deletion request itself, so an admission that commits after a
 * caller's pre-check can never strand a record on a `deleting` node pool.
 * Consumers that add a node-pool-targeted record type append a predicate
 * here rather than rewriting the request.
 */
const NODE_POOL_LIVE_REFERENCE_PREDICATES: readonly string[] = Object.freeze([
  // Deployment records (slice 4); managed ones go with their pool.
  `${nodePoolDeploymentReferencesSql('p.id')} = 0`,
  // Node pool Service Workloads until cleanup confirms removal.
  `NOT EXISTS (
       SELECT 1 FROM workloads w
       WHERE ${liveNodePoolWorkloadSql('w', 'p.id')}
     )`,
]);

export interface NodePoolRepository {
  create(input: CreateNodePoolInput): Promise<NodePoolCreationResult>;
  listForReconciliation(): Promise<StoredNodePool[]>;
  getForScope(
    nodePoolId: string,
    scope: OwnershipScope,
  ): Promise<StoredNodePool | null>;
  getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredNodePool | null>;
  listForScope(
    scope: OwnershipScope,
    options?: { clusterId?: string; includeDeleted?: boolean },
  ): Promise<StoredNodePool[]>;
  markReady(nodePoolId: string): Promise<boolean>;
  markFailed(nodePoolId: string, error: string): Promise<boolean>;
  /** Record `lastError` without changing the state. */
  recordError(nodePoolId: string, error: string): Promise<void>;
  /** Returns the new consecutive failure count. */
  recordProvisioningFailure(nodePoolId: string, at: number): Promise<number>;
  resetProvisioningFailures(nodePoolId: string): Promise<void>;
  /** Record the elected entry attempt; true when it differs from before. */
  setIngressEntry(
    nodePoolId: string,
    vmId: number | null,
    at: number,
  ): Promise<boolean>;
  requestDeletion(
    nodePoolId: string,
    scope: OwnershipScope,
  ): Promise<NodePoolDeletionRequestResult>;
  recordDeletionError(nodePoolId: string, error: string): Promise<void>;
  /** Clears `lastError` only while it still starts with `prefix`. */
  clearError(nodePoolId: string, prefix: string): Promise<void>;
  /** Terminal only once every owned VM attempt has confirmed release. */
  markDeleted(nodePoolId: string): Promise<boolean>;
}

export interface NodePoolVM {
  id: number;
  nodePoolId: string;
  cloudId: string;
  ip: string | null;
  privateIp: string | null;
  createdAt: number;
  endedAt: number | null;
  removalRequestedAt: number | null;
  region: string;
  availabilityZone: string | null;
  credentialId: string;
  pricePerHour: number | null;
  vmType: string;
}

export interface BeginNodePoolVmAttemptInput {
  cloudId: string;
  /** The picked launch target. */
  region: string;
  availabilityZone: string | null;
  /** One of the pool's VM types. */
  vmType: string;
  pricePerHour?: number;
  /** Atomic capacity fence for this admission attempt. */
  desiredVmCount: number;
}

/**
 * The node pool's worker attempts in the shared VM ledger. Every row carries
 * its launch target and the node pool's own credential and VM type at insert
 * time, so later observation and cleanup never borrow the node pool's values.
 */
export interface NodePoolVmRepository {
  listVms(nodePoolId: string): Promise<NodePoolVM[]>;
  /** Classified failed launches begun since `since`, oldest first. */
  listLaunchFailures(
    nodePoolId: string,
    since: number,
  ): Promise<
    Array<ProvisioningFailure & { createdAt: number; vmRowId: number }>
  >;
  recordLaunchFailure(
    nodePoolId: string,
    ref: ProvisioningAttemptRef,
    failure: LaunchFailure,
  ): Promise<void>;
  beginVmAttempt(
    nodePoolId: string,
    input: BeginNodePoolVmAttemptInput,
  ): Promise<ProvisioningAttemptRef | null>;
  completeVmAttempt(
    nodePoolId: string,
    ref: ProvisioningAttemptRef,
    vm: GatewayVM,
  ): Promise<ProvisioningAttemptRef>;
  /**
   * `at` is the claim time; scale-in passes its Node stamp's. `remediated`
   * stamps a replacement of an unhealthy Node, which the breaker counts.
   */
  claimVmRemoval(
    nodePoolId: string,
    vmRowId: number,
    at?: number,
    remediated?: boolean,
  ): Promise<NodePoolVM | null>;
  /** The pool's VMs replaced as unhealthy since `since`. */
  countRemediations(nodePoolId: string, since: number): Promise<number>;
  /** Give back a claim made at `claimedAt`; any other claim stays. */
  unclaimVmRemoval(
    nodePoolId: string,
    vmRowId: number,
    claimedAt: number,
  ): Promise<void>;
  endVm(
    nodePoolId: string,
    vmRowId: number,
    detached: NodeDetached,
  ): Promise<boolean>;
}

interface NodePoolVMRow {
  id: number;
  node_pool_id: string;
  cloud_id: string;
  ip: string | null;
  private_ip: string | null;
  created_at: number;
  ended_at: number | null;
  removal_requested_at: number | null;
  region: string;
  availability_zone: string | null;
  credential_id: string;
  price_per_hour: number | null;
  vm_type: string;
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

interface NodePoolRow {
  id: string;
  cluster_id: string;
  owner_user_id: string;
  name: string;
  state: NodePoolState;
  compute_credential_id: string;
  cloud_provider: CloudType;
  region: string | null;
  zone: string | null;
  cluster_region: string | null;
  vm_type: string;
  min_vm_count: number;
  max_vm_count: number;
  os_disk_size_gb: number | null;
  os_disk_tier: DiskTier | null;
  spot: number;
  allow_privileged_jobs: number;
  user_namespace_jobs: number;
  require_nested_virtualization: number;
  last_error: string | null;
  provisioning_failures: number;
  provisioning_failed_at: number | null;
  ingress_entry_vm_id: number | null;
  ingress_entry_changed_at: number | null;
  created_at: number;
  updated_at: number;
}

const NODE_POOL_ACTIVE_STATES = [
  NodePoolState.Creating,
  NodePoolState.Ready,
  NodePoolState.Failed,
] as const;

const NODE_POOL_COLUMNS = `p.id, p.cluster_id, p.owner_user_id, p.name, p.state,
  p.compute_credential_id, c.cloud_provider, p.region, p.zone,
  (SELECT k.region FROM clusters k
     JOIN credentials kc ON kc.id = k.compute_credential_id
     WHERE k.id = p.cluster_id AND kc.cloud_provider = c.cloud_provider)
    AS cluster_region,
  p.vm_type,
  p.min_vm_count, p.max_vm_count, p.os_disk_size_gb, p.os_disk_tier,
  p.spot, p.allow_privileged_jobs, p.user_namespace_jobs,
  p.require_nested_virtualization,
  p.last_error, p.provisioning_failures,
  p.provisioning_failed_at,
  p.ingress_entry_vm_id, p.ingress_entry_changed_at,
  p.created_at, p.updated_at`;
const NODE_POOL_VM_COLUMNS = `id, node_pool_id, cloud_id, ip, private_ip, created_at,
  ended_at, removal_requested_at, region, availability_zone, credential_id,
  price_per_hour, vm_type`;
const NODE_POOL_CREDENTIAL_JOIN =
  'JOIN credentials c ON c.id = p.compute_credential_id';

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
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

function toStoredNodePool(row: NodePoolRow): StoredNodePool {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    state: row.state,
    computeCredentialId: row.compute_credential_id,
    cloudProvider: row.cloud_provider,
    region: row.region,
    zone: row.zone,
    clusterRegion: row.cluster_region,
    vmTypes: JSON.parse(row.vm_type) as string[],
    minVmCount: row.min_vm_count,
    maxVmCount: row.max_vm_count,
    osDiskSizeGb: row.os_disk_size_gb,
    osDiskTier: row.os_disk_tier,
    spot: row.spot === 1,
    allowPrivilegedJobs: row.allow_privileged_jobs === 1,
    userNamespaceJobs: row.user_namespace_jobs === 1,
    requireNestedVirtualization: row.require_nested_virtualization === 1,
    lastError: row.last_error,
    provisioningFailures: row.provisioning_failures,
    provisioningFailedAt: row.provisioning_failed_at,
    ingressEntryVmId: row.ingress_entry_vm_id,
    ingressEntryChangedAt: row.ingress_entry_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNodePoolVM(row: NodePoolVMRow): NodePoolVM {
  return {
    id: row.id,
    nodePoolId: row.node_pool_id,
    cloudId: row.cloud_id,
    ip: row.ip,
    privateIp: row.private_ip,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    removalRequestedAt: row.removal_requested_at,
    region: row.region,
    availabilityZone: row.availability_zone,
    credentialId: row.credential_id,
    pricePerHour: row.price_per_hour,
    vmType: row.vm_type,
  };
}

export class ClusterRecordStore implements ClusterRecordRepository {
  constructor(private readonly db: DB) {}

  async storeConnection(
    input: StoreClusterConnectionInput,
  ): Promise<'stored' | 'identity-mismatch' | 'not-found'> {
    if (!input.connection) {
      throw new Error('cluster connection is required');
    }
    const encryptedConnection = await encryptSecret(input.connection);
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE clusters
       SET kubernetes_identity = ?, connection_kind = ?,
           encrypted_connection = ?,
           connection_revision = connection_revision + 1, updated_at = ?
       WHERE id = ? AND state <> ?
         AND (kubernetes_identity IS NULL OR kubernetes_identity = ?)`,
      [
        input.kubernetesIdentity,
        input.kind,
        encryptedConnection,
        Date.now(),
        input.clusterId,
        ClusterState.Destroyed,
        input.kubernetesIdentity,
      ],
    );
    if (result[0]?.rowsAffected === 1) return 'stored';
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM clusters WHERE id = ? AND state <> ?`,
      [input.clusterId, ClusterState.Destroyed],
    );
    return rows.length > 0 ? 'identity-mismatch' : 'not-found';
  }

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

  async listForScope(
    scope: OwnershipScope,
    options?: { includeDeleted?: boolean },
  ): Promise<StoredClusterRecord[]> {
    const owner = ownership(scope, 'r');
    const rows = await this.db.query<ClusterRecordRow>(
      `SELECT r.* FROM clusters r
       WHERE ${owner.sql} AND (? = 1 OR r.state <> ?)
       ORDER BY r.created_at, r.id`,
      [
        ...owner.params,
        options?.includeDeleted ? 1 : 0,
        ClusterState.Destroyed,
      ],
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

  async countActiveNodePools(clusterId: string): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM node_pools
       WHERE cluster_id = ? AND state <> ?`,
      [clusterId, NodePoolState.Deleted],
    );
    return rows[0]?.count ?? 0;
  }

  async listDestroyedClusterIds(kubernetesIdentity: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM clusters
       WHERE kubernetes_identity = ? AND state = ?
       ORDER BY created_at, id`,
      [kubernetesIdentity, ClusterState.Destroyed],
    );
    return rows.map((row) => row.id);
  }
}

export class NodePoolStore implements NodePoolRepository {
  constructor(private readonly db: DB) {}

  async create(input: CreateNodePoolInput): Promise<NodePoolCreationResult> {
    if (
      !Number.isSafeInteger(input.minVmCount) ||
      !Number.isSafeInteger(input.maxVmCount)
    ) {
      throw new Error('Node pool VM counts must be safe integers');
    }
    const now = Date.now();
    const result = await this.db.query<{ rowsAffected: number }>(
      `INSERT INTO node_pools (
         id, cluster_id, owner_user_id, name, state, compute_credential_id,
         region, zone, vm_type, min_vm_count, max_vm_count,
         os_disk_size_gb, os_disk_tier, spot, allow_privileged_jobs,
         user_namespace_jobs, require_nested_virtualization, created_at,
         updated_at
       )
       SELECT ?, r.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM clusters r
       WHERE r.id = ? AND r.state = ?`,
      [
        assertNonEmpty(input.id, 'Node pool id'),
        assertNonEmpty(input.ownerUserId, 'Node pool owner user id'),
        assertNonEmpty(input.name, 'Node pool name'),
        NodePoolState.Creating,
        assertNonEmpty(input.computeCredentialId, 'Node pool credential id'),
        input.region?.trim() || null,
        input.zone?.trim() || null,
        JSON.stringify(
          input.vmTypes.map((vmType) =>
            assertNonEmpty(vmType, 'Node pool VM type'),
          ),
        ),
        input.minVmCount,
        input.maxVmCount,
        input.osDiskSizeGb ?? null,
        input.osDiskTier ?? null,
        input.spot ? 1 : 0,
        input.allowPrivilegedJobs ? 1 : 0,
        input.userNamespaceJobs ? 1 : 0,
        input.requireNestedVirtualization ? 1 : 0,
        now,
        now,
        assertNonEmpty(input.clusterId, 'Node pool cluster id'),
        ClusterState.Ready,
      ],
    );
    return result[0]?.rowsAffected === 1 ? 'created' : 'cluster-not-accepting';
  }

  async listForReconciliation(): Promise<StoredNodePool[]> {
    const rows = await this.db.query<NodePoolRow>(
      `SELECT ${NODE_POOL_COLUMNS} FROM node_pools p ${NODE_POOL_CREDENTIAL_JOIN}
       WHERE p.state <> ?
       ORDER BY p.created_at, p.id`,
      [NodePoolState.Deleted],
    );
    return rows.map(toStoredNodePool);
  }

  async getForScope(
    nodePoolId: string,
    scope: OwnershipScope,
  ): Promise<StoredNodePool | null> {
    const owner = ownership(scope, 'p');
    const rows = await this.db.query<NodePoolRow>(
      `SELECT ${NODE_POOL_COLUMNS} FROM node_pools p ${NODE_POOL_CREDENTIAL_JOIN}
       WHERE p.id = ? AND ${owner.sql}`,
      [nodePoolId, ...owner.params],
    );
    return rows[0] ? toStoredNodePool(rows[0]) : null;
  }

  async getByNameForScope(
    name: string,
    scope: OwnershipScope,
  ): Promise<StoredNodePool | null> {
    const owner = ownership(scope, 'p');
    const rows = await this.db.query<NodePoolRow>(
      `SELECT ${NODE_POOL_COLUMNS} FROM node_pools p ${NODE_POOL_CREDENTIAL_JOIN}
       WHERE p.name = ? COLLATE NOCASE AND p.state <> ? AND ${owner.sql}`,
      [name.trim(), NodePoolState.Deleted, ...owner.params],
    );
    return rows[0] ? toStoredNodePool(rows[0]) : null;
  }

  async listForScope(
    scope: OwnershipScope,
    options?: { clusterId?: string; includeDeleted?: boolean },
  ): Promise<StoredNodePool[]> {
    const owner = ownership(scope, 'p');
    const rows = await this.db.query<NodePoolRow>(
      `SELECT ${NODE_POOL_COLUMNS} FROM node_pools p ${NODE_POOL_CREDENTIAL_JOIN}
       WHERE ${owner.sql}
         AND (? IS NULL OR p.cluster_id = ?)
         AND (? = 1 OR p.state <> ?)
       ORDER BY p.created_at, p.id`,
      [
        ...owner.params,
        options?.clusterId ?? null,
        options?.clusterId ?? null,
        options?.includeDeleted ? 1 : 0,
        NodePoolState.Deleted,
      ],
    );
    return rows.map(toStoredNodePool);
  }

  async markReady(nodePoolId: string): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      // A VM still being released keeps its own release error, and a cap
      // block, a remediation pause or an outdated Node replacement its note,
      // until clearError; any other error clears.
      `UPDATE node_pools AS p
       SET state = ?, updated_at = ?,
           last_error = CASE WHEN EXISTS (
             SELECT 1 FROM vms v WHERE v.node_pool_id = p.id
               AND v.ended_at IS NULL AND v.removal_requested_at IS NOT NULL
               AND substr(p.last_error, 1, length(${VM_RELEASE_FAILURE_PREFIX_SQL}))
                 = ${VM_RELEASE_FAILURE_PREFIX_SQL}
           ) OR ${KEPT_ERROR_PREFIXES.map(() => 'substr(p.last_error, 1, length(?)) = ?').join(' OR ')}
           THEN last_error ELSE NULL END
       WHERE p.id = ? AND p.state IN (${placeholders(NODE_POOL_ACTIVE_STATES)})`,
      [
        NodePoolState.Ready,
        Date.now(),
        ...KEPT_ERROR_PREFIXES.flatMap((prefix) => [prefix, prefix]),
        nodePoolId,
        ...NODE_POOL_ACTIVE_STATES,
      ],
    );
    return result[0]?.rowsAffected === 1;
  }

  async markFailed(nodePoolId: string, error: string): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE node_pools
       SET state = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND state IN (${placeholders(NODE_POOL_ACTIVE_STATES)})`,
      [
        NodePoolState.Failed,
        error,
        Date.now(),
        nodePoolId,
        ...NODE_POOL_ACTIVE_STATES,
      ],
    );
    return result[0]?.rowsAffected === 1;
  }

  async recordError(nodePoolId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE node_pools SET last_error = ?, updated_at = ?
       WHERE id = ? AND state IN (${placeholders(NODE_POOL_ACTIVE_STATES)})`,
      [error, Date.now(), nodePoolId, ...NODE_POOL_ACTIVE_STATES],
    );
  }

  async recordProvisioningFailure(
    nodePoolId: string,
    at: number,
  ): Promise<number> {
    const rows = await this.db.query<{ provisioning_failures: number }>(
      `UPDATE node_pools
       SET provisioning_failures = provisioning_failures + 1,
           provisioning_failed_at = ?, updated_at = ?
       WHERE id = ?
       RETURNING provisioning_failures`,
      [at, at, nodePoolId],
    );
    return rows[0]?.provisioning_failures ?? 0;
  }

  async resetProvisioningFailures(nodePoolId: string): Promise<void> {
    await this.db.query(
      `UPDATE node_pools
       SET provisioning_failures = 0, provisioning_failed_at = NULL, updated_at = ?,
           last_error = CASE WHEN state = ? OR substr(last_error, 1, length(?)) = ?
             THEN last_error ELSE NULL END
       WHERE id = ? AND provisioning_failures > 0`,
      [
        Date.now(),
        NodePoolState.Failed,
        OUTDATED_REPLACEMENT_PREFIX,
        OUTDATED_REPLACEMENT_PREFIX,
        nodePoolId,
      ],
    );
  }

  async setIngressEntry(
    nodePoolId: string,
    vmId: number | null,
    at: number,
  ): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE node_pools
       SET ingress_entry_vm_id = ?, ingress_entry_changed_at = ?, updated_at = ?
       WHERE id = ? AND ingress_entry_vm_id IS NOT ?`,
      [vmId, at, at, nodePoolId, vmId],
    );
    return result[0]?.rowsAffected === 1;
  }

  async requestDeletion(
    nodePoolId: string,
    scope: OwnershipScope,
  ): Promise<NodePoolDeletionRequestResult> {
    const owner = ownership(scope, 'p');
    return this.db.transaction((tx) => {
      const result = tx.query<{ rowsAffected: number }>(
        `UPDATE node_pools AS p
         SET state = ?, last_error = NULL, updated_at = ?
         WHERE p.id = ?
           AND ${owner.sql}
           AND p.state IN (${placeholders(NODE_POOL_ACTIVE_STATES)})
           AND ${NODE_POOL_LIVE_REFERENCE_PREDICATES.join('\n           AND ')}`,
        [
          NodePoolState.Deleting,
          Date.now(),
          nodePoolId,
          ...owner.params,
          ...NODE_POOL_ACTIVE_STATES,
        ],
      );
      if (result[0]?.rowsAffected === 1) {
        tx.query(
          `UPDATE deployments SET deletion_requested_at = ?, updated_at = ?
           WHERE node_pool_id = ? AND managed = 1 AND deletion_requested_at IS NULL`,
          [Date.now(), Date.now(), nodePoolId],
        );
        return 'requested';
      }

      const rows = tx.query<{ state: NodePoolState }>(
        `SELECT p.state FROM node_pools p WHERE p.id = ? AND ${owner.sql}`,
        [nodePoolId, ...owner.params],
      );
      const state = rows[0]?.state;
      if (state === undefined) return 'not-found';
      if (state === NodePoolState.Deleting) return 'already-deleting';
      if (state === NodePoolState.Deleted) return 'already-deleted';
      // Active, owned, and yet not requested: a live reference fenced it.
      return 'referenced';
    });
  }

  async recordDeletionError(nodePoolId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE node_pools SET last_error = ?, updated_at = ?
       WHERE id = ? AND state = ?`,
      [error, Date.now(), nodePoolId, NodePoolState.Deleting],
    );
  }

  async clearError(nodePoolId: string, prefix: string): Promise<void> {
    await this.db.query(
      `UPDATE node_pools SET last_error = NULL, updated_at = ?
       WHERE id = ? AND substr(last_error, 1, length(?)) = ?`,
      [Date.now(), nodePoolId, prefix, prefix],
    );
  }

  async markDeleted(nodePoolId: string): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE node_pools AS p SET state = ?, last_error = NULL, updated_at = ?
       WHERE p.id = ? AND p.state = ?
         AND NOT EXISTS (
           SELECT 1 FROM vms v WHERE v.node_pool_id = p.id AND v.ended_at IS NULL
         )`,
      [NodePoolState.Deleted, Date.now(), nodePoolId, NodePoolState.Deleting],
    );
    return result[0]?.rowsAffected === 1;
  }
}

export class NodePoolVmStore implements NodePoolVmRepository {
  constructor(private readonly db: DB) {}

  async listVms(nodePoolId: string): Promise<NodePoolVM[]> {
    const rows = await this.db.query<NodePoolVMRow>(
      `SELECT ${NODE_POOL_VM_COLUMNS} FROM vms
       WHERE node_pool_id = ?
       ORDER BY created_at, id`,
      [nodePoolId],
    );
    return rows.map(toNodePoolVM);
  }

  async listLaunchFailures(
    nodePoolId: string,
    since: number,
  ): Promise<
    Array<ProvisioningFailure & { createdAt: number; vmRowId: number }>
  > {
    const rows = await this.db.query<
      Omit<ProvisioningFailure, 'disposition' | 'spot'> & {
        diagnosis: CloudFailureDiagnosis;
        createdAt: number;
        vmRowId: number;
        cloud_provider: CloudType;
        pool_region: string | null;
        pool_zone: string | null;
        multi_type: number;
        pool_spot: number;
      }
    >(
      `SELECT c.cloud_provider, p.region AS pool_region, p.zone AS pool_zone,
              p.spot AS pool_spot,
              json_array_length(p.vm_type) > 1 AS multi_type,
              v.credential_id AS credentialId, v.vm_type AS vmType,
              v.region, v.availability_zone AS availabilityZone,
              v.launch_diagnosis AS diagnosis,
              v.launch_region_denied AS regionDenied, v.created_at AS createdAt,
              v.id AS vmRowId
       FROM vms v
       JOIN node_pools p ON p.id = v.node_pool_id
       ${NODE_POOL_CREDENTIAL_JOIN}
       WHERE v.node_pool_id = ? AND v.launch_diagnosis IS NOT NULL
         AND v.created_at >= ?
       ORDER BY v.created_at, v.id`,
      [nodePoolId, since],
    );
    return rows.map(
      ({
        cloud_provider,
        pool_region,
        pool_zone,
        multi_type,
        pool_spot,
        ...row
      }) => ({
        ...row,
        disposition: launchFailureDisposition(
          row.diagnosis,
          cloud_provider,
          pool_region,
          pool_zone,
          multi_type === 1 && !row.regionDenied,
          row.regionDenied !== null,
        ),
        spot: pool_spot === 1,
      }),
    );
  }

  async recordLaunchFailure(
    nodePoolId: string,
    ref: ProvisioningAttemptRef,
    failure: LaunchFailure,
  ): Promise<void> {
    await this.db.query(
      `UPDATE vms SET launch_diagnosis = ?, launch_region_denied = ?
       WHERE id = ? AND node_pool_id = ?`,
      [failure.diagnosis, failure.regionDenied, ref.vmRowId, nodePoolId],
    );
  }

  /**
   * Insert the durable attempt before the first provider mutation, with its
   * launch target and the node pool's own credential and VM type. The
   * live-count fence keeps concurrent reconcilers from over-provisioning.
   */
  async beginVmAttempt(
    nodePoolId: string,
    input: BeginNodePoolVmAttemptInput,
  ): Promise<ProvisioningAttemptRef | null> {
    if (
      !Number.isSafeInteger(input.desiredVmCount) ||
      input.desiredVmCount < 0
    ) {
      throw new Error(
        'Desired node pool VM count must be a non-negative integer',
      );
    }
    const createdAt = Date.now();
    const rows = await this.db.query<{
      id: number;
      cloud_id: string;
      created_at: number;
    }>(
      `INSERT INTO vms (
         node_pool_id, cloud_id, created_at, region, availability_zone,
         credential_id, price_per_hour, vm_type
       )
       SELECT p.id, ?, ?, ?, ?, p.compute_credential_id, ?, ?
       FROM node_pools p
       WHERE p.id = ? AND p.state IN (${placeholders(NODE_POOL_ACTIVE_STATES)})
         AND (
           SELECT COUNT(*)
           FROM vms live
           WHERE live.node_pool_id = p.id
             AND live.ended_at IS NULL
             AND live.removal_requested_at IS NULL
         ) < ?
       RETURNING id, cloud_id, created_at`,
      [
        assertNonEmpty(input.cloudId, 'Node pool VM cloud id'),
        createdAt,
        assertNonEmpty(input.region, 'Node pool VM region'),
        input.availabilityZone,
        input.pricePerHour ?? null,
        input.vmType,
        nodePoolId,
        ...NODE_POOL_ACTIVE_STATES,
        input.desiredVmCount,
      ],
    );
    const row = rows[0];
    return row
      ? { vmRowId: row.id, cloudId: row.cloud_id, createdAt: row.created_at }
      : null;
  }

  async completeVmAttempt(
    nodePoolId: string,
    ref: ProvisioningAttemptRef,
    vm: GatewayVM,
  ): Promise<ProvisioningAttemptRef> {
    const { sshHost, sshPort, sshUsername } = resolveGatewayVM(vm);
    const createdAt = vm.createdAt ?? ref.createdAt;
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE vms
       SET ip = ?, cloud_id = ?, private_ip = ?, base_image_id = ?,
           availability_zone = COALESCE(?, availability_zone), created_at = ?,
           ssh_host = ?, ssh_port = ?, ssh_username = ?
       WHERE id = ? AND node_pool_id = ? AND ip IS NULL AND ended_at IS NULL`,
      [
        vm.ip,
        vm.cloudId,
        vm.privateIp ?? null,
        vm.baseImageId ?? null,
        vm.availabilityZone ?? null,
        createdAt,
        sshHost,
        sshPort,
        sshUsername,
        ref.vmRowId,
        nodePoolId,
      ],
    );
    if (result[0]?.rowsAffected !== 1) {
      const existing = await this.db.query<{
        cloud_id: string;
        created_at: number;
      }>(
        `SELECT cloud_id, created_at FROM vms
         WHERE id = ? AND node_pool_id = ? AND ip IS NOT NULL AND ended_at IS NULL`,
        [ref.vmRowId, nodePoolId],
      );
      if (existing[0]?.cloud_id === vm.cloudId) {
        return {
          vmRowId: ref.vmRowId,
          cloudId: existing[0].cloud_id,
          createdAt: existing[0].created_at,
        };
      }
      throw new Error(
        `Node pool ${nodePoolId}: VM attempt ${ref.vmRowId} is missing or already completed`,
      );
    }
    return { vmRowId: ref.vmRowId, cloudId: vm.cloudId, createdAt };
  }

  async claimVmRemoval(
    nodePoolId: string,
    vmRowId: number,
    at = Date.now(),
    remediated = false,
  ): Promise<NodePoolVM | null> {
    await this.db.query(
      `UPDATE vms SET removal_requested_at = COALESCE(removal_requested_at, ?),
         remediated_at = CASE WHEN ? THEN COALESCE(remediated_at, ?) ELSE remediated_at END
       WHERE id = ? AND node_pool_id = ? AND ended_at IS NULL`,
      [at, remediated ? 1 : 0, at, vmRowId, nodePoolId],
    );
    const rows = await this.db.query<NodePoolVMRow>(
      `SELECT ${NODE_POOL_VM_COLUMNS} FROM vms
       WHERE id = ? AND node_pool_id = ? AND ended_at IS NULL`,
      [vmRowId, nodePoolId],
    );
    return rows[0] ? toNodePoolVM(rows[0]) : null;
  }

  async countRemediations(nodePoolId: string, since: number): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM vms
       WHERE node_pool_id = ? AND remediated_at >= ?`,
      [nodePoolId, since],
    );
    return rows[0]?.count ?? 0;
  }

  async unclaimVmRemoval(
    nodePoolId: string,
    vmRowId: number,
    claimedAt: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE vms SET removal_requested_at = NULL, remediated_at = NULL
       WHERE id = ? AND node_pool_id = ? AND ended_at IS NULL
         AND removal_requested_at = ?`,
      [vmRowId, nodePoolId, claimedAt],
    );
  }

  async endVm(
    nodePoolId: string,
    vmRowId: number,
    // Compile-time evidence that the Node was handled before the row closes.
    _detached: NodeDetached,
  ): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE vms SET ended_at = ?
       WHERE id = ? AND node_pool_id = ? AND ended_at IS NULL`,
      [Date.now(), vmRowId, nodePoolId],
    );
    return result[0]?.rowsAffected === 1;
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
