import {
  decodeContainerSpec,
  encodeContainerSpec,
  insertContainerSpec,
  type ContainerSpec,
  type EncodedContainerSpec,
} from './container-spec.js';
import type { DB, DBTransaction } from './repositories/db.js';
import { createJobChanges, type JobChanges } from './job-changes.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import {
  nodePoolDeploymentReferencesSql,
  nodePoolGpuReservationSql,
} from './repositories/node-pool-references.js';
import { NodePoolState } from '../../shared/node-pools.js';
import {
  DEPLOYMENT_GRACE_PERIOD_SECONDS,
  deploymentReadinessProbeSchema,
  type DeploymentReadinessProbe,
} from '../../shared/api-contract/deployments-schemas.js';

/** A managed Deployment's image, and whether it holds a pull token. */
export interface ManagedImage {
  image: string;
  imageDigest: string | null;
  registryToken: boolean;
}

export interface StoredDeployment {
  id: string;
  ownerUserId: string;
  name: string;
  /** The node pool the record targets; immutable for the record's life. */
  nodePoolId: string;
  config: ContainerSpec;
  readinessProbe: DeploymentReadinessProbe | null;
  /** The replica Pod's `terminationGracePeriodSeconds`. */
  gracePeriodSeconds: number;
  /** Named Secrets whose values reconcile projects into the replicas. */
  secretNames: string[];
  gpuCount: number;
  maxConcurrentJobsPerReplica: number;
  /**
   * Replica Pods, each holding `gpuCount` GPUs, between these
   * bounds on queued plus held Jobs (RA); `--replicas N` sets both.
   */
  minReplicas: number;
  maxReplicas: number;
  /** An anycloud-managed Deployment that runs pool Jobs (RT8). */
  managed: boolean;
  /**
   * The release whose runner a managed Deployment's replicas run (RFC 0049
   * C27); null on a user Deployment, or one no release was recorded for.
   */
  runnerRelease: string | null;
  generation: number;
  deletionRequestedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Identity and lifecycle facts needed by admission and workload authentication. */
export type DeploymentMetadata = Pick<
  StoredDeployment,
  'id' | 'nodePoolId' | 'managed' | 'deletionRequestedAt' | 'deletedAt'
>;

/**
 * Where a Deployment record runs. Node pools are the only target; the
 * discriminator stays on the wire so the shape can grow without breaking.
 */
export type DeploymentTarget = { kind: 'nodePool'; nodePoolId: string };

export function deploymentTarget(
  deployment: Pick<DeploymentMetadata, 'id' | 'nodePoolId'>,
): DeploymentTarget {
  if (!deployment.nodePoolId) {
    throw new Error(`Deployment ${deployment.id} has no node pool target`);
  }
  return { kind: 'nodePool', nodePoolId: deployment.nodePoolId };
}

/** Historical inventory for the daily digest, without container configuration. */
export interface DeploymentDigestMetadata {
  id: string;
  name: string;
  nodePoolName: string;
  ownerUserId: string;
  ownerUsername: string | null;
  presentAtEnd: boolean;
  createdInWindow: boolean;
  deletedInWindow: boolean;
  hasVmUsage: boolean;
}

interface NodePoolReservation {
  /**
   * Upper bound on live GPU reservations on the node pool, including this
   * one, from the ready Nodes observed at admission. Re-checked inside the
   * insert transaction so two admissions cannot both fit the same devices.
   */
  maxGpus: number;
}

export interface CreateDeploymentInput {
  id: string;
  ownerUserId: string;
  name: string;
  nodePoolId: string;
  reservation?: NodePoolReservation;
  config: ContainerSpec;
  readinessProbe?: DeploymentReadinessProbe | null;
  /** `DEPLOYMENT_GRACE_PERIOD_SECONDS` when omitted. */
  gracePeriodSeconds?: number;
  secretNames?: string[];
  gpuCount: number;
  maxConcurrentJobsPerReplica: number;
  /** One each when omitted. */
  minReplicas?: number;
  maxReplicas?: number;
}

export interface UpdateDeploymentInput {
  id: string;
  expectedGeneration: number;
  config: ContainerSpec;
  readinessProbe?: DeploymentReadinessProbe | null;
  /** Unchanged when omitted. */
  gracePeriodSeconds?: number;
  secretNames: string[];
  gpuCount: number;
  maxConcurrentJobsPerReplica: number;
  /** Unchanged when omitted. */
  minReplicas?: number;
  maxReplicas?: number;
  /** Set when the update raises the GPUs it reserves; judged as at create. */
  reservation?: NodePoolReservation;
}

export type DeploymentDeletionRequest =
  | 'requested'
  | 'already-requested'
  | 'already-deleted'
  | 'not-found';

export type DeploymentListFilter = { nodePoolId: string } | undefined;

/** Replica time from `pool_occupancy`; busy is covered by an attempt. */
export interface DeploymentUsage {
  replicaHours: number;
  busyHours: number;
  costUsd: number;
  busyCostUsd: number;
}

/** A replica holding its share of a node pool Node (SPEND). */
export interface HeldReplica {
  podUid: string;
  /** The Node's `vms` row. */
  vmId: number;
  share: number;
  gpus: number;
}

export interface DeploymentRepository {
  /**
   * Insert against a Ready target the scope may use. `false` when the target
   * is missing, not Ready, foreign to the scope, or (node pools) when the GPU
   * reservation no longer fits.
   */
  create(input: CreateDeploymentInput, scope: OwnershipScope): Promise<boolean>;
  getForScope(
    identifier: string,
    scope: OwnershipScope,
    options?: { includeDeleted?: boolean },
  ): Promise<StoredDeployment | null>;
  getById(id: string): Promise<StoredDeployment | null>;
  getMetadataForScope(
    identifier: string,
    scope: OwnershipScope,
  ): Promise<DeploymentMetadata | null>;
  getMetadataById(id: string): Promise<DeploymentMetadata | null>;
  listForScope(
    scope: OwnershipScope,
    filter?: DeploymentListFilter,
  ): Promise<StoredDeployment[]>;
  listForReconciliation(): Promise<string[]>;
  /** Deployments that still reference the node pool (not yet `deletedAt`). */
  countLiveForNodePool(nodePoolId: string): Promise<number>;
  /** What holds the node pool against `node-pool delete`. */
  countHoldingNodePool(nodePoolId: string): Promise<number>;
  /** The pool's managed Deployments its deletion request marked. */
  listDeletingManaged(nodePoolId: string): Promise<string[]>;
  /** Mark a managed Deployment with no Job since `before` for deletion. */
  requestIdleDeletion(id: string, before: number): Promise<boolean>;
  /**
   * RFC 0049 C11: the pool's live managed Deployments' images, latest Job
   * first; a Deployment with no Job yet ranks by its creation.
   */
  listLiveManagedImages(nodePoolId: string): Promise<ManagedImage[]>;
  listDigestMetadataInWindow(
    startMs: number,
    endMs: number,
  ): Promise<DeploymentDigestMetadata[]>;
  /**
   * The new generation; `null` when the generation, scope or deletion state
   * changed, or `'gpu-reserved'` when a raised GPU count no longer fits.
   */
  update(
    input: UpdateDeploymentInput,
    scope: OwnershipScope,
  ): Promise<number | null | 'gpu-reserved'>;
  requestDeletion(
    id: string,
    scope: OwnershipScope,
  ): Promise<DeploymentDeletionRequest>;
  markDeleted(id: string): Promise<boolean>;
  /**
   * Roll a Pod template the API now renders differently out as the next
   * generation, unless the record moved on. Whether it advanced.
   */
  advanceGeneration(id: string, expectedGeneration: number): Promise<boolean>;
  /** Record the release whose runner the applied native Deployment renders. */
  recordRunnerRelease(id: string, release: string): Promise<void>;
  /**
   * Open a `pool_occupancy` row, priced from the Node's VM, for each replica
   * in `held` without one, and end every open row whose Pod isn't `live`.
   */
  recordOccupancy(
    deploymentId: string,
    held: readonly HeldReplica[],
    live: readonly string[],
    now?: number,
  ): Promise<void>;
  getUsage(deploymentId: string, now?: number): Promise<DeploymentUsage>;
}

interface DeploymentRow extends EncodedContainerSpec {
  id: string;
  owner_user_id: string;
  name: string;
  node_pool_id: string;
  container_spec_owner_id: string | null;
  gpu_count: number;
  readiness_probe: string | null;
  grace_period_seconds: number;
  secret_names: string | null;
  max_concurrent_jobs_per_replica: number;
  min_replicas: number;
  max_replicas: number;
  managed: number;
  runner_release: string | null;
  generation: number;
  deletion_requested_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

const DEPLOYMENT_SPEC_COLUMNS = `w.*, s.deployment_id AS container_spec_owner_id,
  s.image, s.image_digest, s.command, s.docker_options, s.env,
  s.registry_username, s.registry_token, s.entrypoint`;
const DEPLOYMENT_SPEC_JOIN =
  'LEFT JOIN container_specs s ON s.deployment_id = w.id';
const DEPLOYMENT_METADATA_COLUMNS = `w.id, w.node_pool_id, w.managed,
  w.deletion_requested_at, w.deleted_at, s.deployment_id AS container_spec_owner_id`;

function ownerPredicate(
  _scope: OwnershipScope,
  _alias: string,
): { sql: string; params: string[] } {
  return { sql: '1 = 1', params: [] };
}

function scopedDeploymentLookup(
  identifier: string,
  scope: OwnershipScope,
  includeDeleted = false,
): { sql: string; params: unknown[] } {
  const owner = ownerPredicate(scope, 'w');
  return {
    sql: `WHERE (
        (w.id = ? AND (? = 1 OR w.deleted_at IS NULL))
        OR (w.name = ? COLLATE NOCASE AND w.deleted_at IS NULL)
      ) AND ${owner.sql}
      ORDER BY CASE WHEN w.id = ? THEN 0 ELSE 1 END LIMIT 1`,
    params: [
      identifier,
      includeDeleted ? 1 : 0,
      identifier.trim(),
      ...owner.params,
      identifier,
    ],
  };
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function secretNamesColumn(names: string[] | undefined): string | null {
  return names?.length ? JSON.stringify(names) : null;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assertNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value;
}

function toMetadata(
  row: Pick<
    DeploymentRow,
    | 'id'
    | 'node_pool_id'
    | 'managed'
    | 'deletion_requested_at'
    | 'deleted_at'
    | 'container_spec_owner_id'
  >,
): DeploymentMetadata {
  if (!row.container_spec_owner_id) {
    throw new Error(`Deployment ${row.id}: missing container spec`);
  }
  const metadata: DeploymentMetadata = {
    id: row.id,
    nodePoolId: row.node_pool_id,
    managed: row.managed === 1,
    deletionRequestedAt: row.deletion_requested_at,
    deletedAt: row.deleted_at,
  };
  deploymentTarget(metadata);
  return metadata;
}

async function toStored(row: DeploymentRow): Promise<StoredDeployment> {
  const metadata = toMetadata(row);
  const config = await decodeContainerSpec(row, `Deployment ${row.id}`);
  assertNonnegativeInteger(row.gpu_count, `Deployment ${row.id} gpuCount`);
  return {
    ...metadata,
    ownerUserId: row.owner_user_id,
    name: row.name,
    config,
    readinessProbe:
      row.readiness_probe === null
        ? null
        : deploymentReadinessProbeSchema.parse(JSON.parse(row.readiness_probe)),
    gracePeriodSeconds: row.grace_period_seconds,
    secretNames: row.secret_names
      ? (JSON.parse(row.secret_names) as string[])
      : [],
    gpuCount: row.gpu_count,
    maxConcurrentJobsPerReplica: row.max_concurrent_jobs_per_replica,
    minReplicas: row.min_replicas,
    maxReplicas: row.max_replicas,
    runnerRelease: row.runner_release,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert a Deployment and its container spec in `tx` if its node pool is
 * Ready and in `scope`. A managed Deployment (`managedKey`, RFC 0044 decision
 * 26) runs pool Jobs and reserves no GPUs at admission.
 */
export function insertDeployment(
  tx: DBTransaction,
  input: Omit<CreateDeploymentInput, 'config'> & {
    managedKey?: string;
    runnerRelease?: string;
  },
  config: EncodedContainerSpec,
  scope: OwnershipScope,
): boolean {
  const now = Date.now();
  assertNonnegativeInteger(input.gpuCount, `Deployment ${input.id} gpuCount`);
  const { minReplicas = 1, maxReplicas = 1 } = input;
  // The reservation is judged in the same statement that inserts, so two
  // concurrent admissions cannot both fit the last free devices.
  const nodePool = ownerPredicate(scope, 'p');
  const reservation = input.reservation;
  if (input.gpuCount > 0 && !reservation && !input.managedKey) {
    throw new Error(
      `Deployment ${input.id}: GPU node pool admission requires a reservation bound`,
    );
  }
  const result = tx.query<{ rowsAffected: number }>(
    `INSERT INTO deployments (
       id, owner_user_id, name, node_pool_id, gpu_count,
       max_concurrent_jobs_per_replica, min_replicas, max_replicas,
       readiness_probe, grace_period_seconds, secret_names, managed,
       managed_key, runner_release, generation, created_at, updated_at
     )
     SELECT ?, ?, ?, p.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
     FROM node_pools p
     WHERE p.id = ? AND p.state = ? AND ${nodePool.sql}
       AND (? IS NULL OR ? >= ? + ${nodePoolGpuReservationSql('p.id')})`,
    [
      required(input.id, 'Deployment id'),
      required(input.ownerUserId, 'Deployment owner'),
      required(input.name, 'Deployment name'),
      input.gpuCount,
      assertPositiveInteger(
        input.maxConcurrentJobsPerReplica,
        'maxConcurrentJobsPerReplica',
      ),
      minReplicas,
      maxReplicas,
      input.readinessProbe == null
        ? null
        : JSON.stringify(
            deploymentReadinessProbeSchema.parse(input.readinessProbe),
          ),
      input.gracePeriodSeconds ?? DEPLOYMENT_GRACE_PERIOD_SECONDS,
      secretNamesColumn(input.secretNames),
      input.managedKey ? 1 : 0,
      input.managedKey ?? null,
      input.runnerRelease ?? null,
      now,
      now,
      required(input.nodePoolId, 'Node pool id'),
      NodePoolState.Ready,
      ...nodePool.params,
      reservation
        ? assertNonnegativeInteger(
            reservation.maxGpus,
            'Node pool GPU reservation bound',
          )
        : null,
      reservation ? reservation.maxGpus : null,
      input.gpuCount * maxReplicas,
    ],
  );
  if (result[0]?.rowsAffected !== 1) return false;
  insertContainerSpec(tx, { deploymentId: input.id }, config);
  return true;
}

/** A managed Deployment's newest pool Job renews its replicas' pull token. */
export function renewRegistryToken(
  tx: DBTransaction,
  deploymentId: string,
  encryptedToken: string,
): void {
  tx.query(
    'UPDATE container_specs SET registry_token = ? WHERE deployment_id = ?',
    [encryptedToken, deploymentId],
  );
}

export class DeploymentStore implements DeploymentRepository {
  constructor(
    private readonly db: DB,
    private readonly jobChanges: JobChanges = createJobChanges(),
  ) {}

  async create(
    input: CreateDeploymentInput,
    scope: OwnershipScope,
  ): Promise<boolean> {
    const config = await encodeContainerSpec(
      input.config,
      `Deployment ${input.id}`,
    );
    const created = await this.db.transaction((tx) =>
      insertDeployment(tx, input, config, scope),
    );
    if (created) this.jobChanges.notifyDeployment(input.id);
    return created;
  }

  async getForScope(
    identifier: string,
    scope: OwnershipScope,
    options?: { includeDeleted?: boolean },
  ): Promise<StoredDeployment | null> {
    const lookup = scopedDeploymentLookup(
      identifier,
      scope,
      options?.includeDeleted,
    );
    const rows = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_SPEC_COLUMNS} FROM deployments w ${DEPLOYMENT_SPEC_JOIN}
       ${lookup.sql}`,
      lookup.params,
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  async getById(id: string): Promise<StoredDeployment | null> {
    const rows = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_SPEC_COLUMNS} FROM deployments w ${DEPLOYMENT_SPEC_JOIN}
       WHERE w.id = ?`,
      [id],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  async getMetadataForScope(
    identifier: string,
    scope: OwnershipScope,
  ): Promise<DeploymentMetadata | null> {
    const lookup = scopedDeploymentLookup(identifier, scope);
    const rows = await this.db.query<Parameters<typeof toMetadata>[0]>(
      `SELECT ${DEPLOYMENT_METADATA_COLUMNS} FROM deployments w ${DEPLOYMENT_SPEC_JOIN}
       ${lookup.sql}`,
      lookup.params,
    );
    return rows[0] ? toMetadata(rows[0]) : null;
  }

  async getMetadataById(id: string): Promise<DeploymentMetadata | null> {
    const rows = await this.db.query<Parameters<typeof toMetadata>[0]>(
      `SELECT ${DEPLOYMENT_METADATA_COLUMNS} FROM deployments w ${DEPLOYMENT_SPEC_JOIN}
       WHERE w.id = ?`,
      [id],
    );
    return rows[0] ? toMetadata(rows[0]) : null;
  }

  async listForScope(
    scope: OwnershipScope,
    filter?: DeploymentListFilter,
  ): Promise<StoredDeployment[]> {
    const owner = ownerPredicate(scope, 'w');
    const target =
      filter === undefined
        ? { sql: '', params: [] as string[] }
        : { sql: ' AND w.node_pool_id = ?', params: [filter.nodePoolId] };
    const rows = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_SPEC_COLUMNS} FROM deployments w ${DEPLOYMENT_SPEC_JOIN}
       WHERE ${owner.sql} AND w.deleted_at IS NULL${target.sql}
       ORDER BY w.created_at, w.id`,
      [...owner.params, ...target.params],
    );
    return Promise.all(rows.map(toStored));
  }

  async countLiveForNodePool(nodePoolId: string): Promise<number> {
    const rows = await this.db.query<{ live: number }>(
      `SELECT COUNT(*) AS live FROM deployments
       WHERE node_pool_id = ? AND deleted_at IS NULL`,
      [nodePoolId],
    );
    return rows[0]?.live ?? 0;
  }

  async countHoldingNodePool(nodePoolId: string): Promise<number> {
    const rows = await this.db.query<{ live: number }>(
      `SELECT ${nodePoolDeploymentReferencesSql('?')} AS live`,
      [nodePoolId, nodePoolId],
    );
    return rows[0]?.live ?? 0;
  }

  async listDeletingManaged(nodePoolId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM deployments WHERE node_pool_id = ? AND managed = 1
         AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL`,
      [nodePoolId],
    );
    return rows.map((row) => row.id);
  }

  async listLiveManagedImages(nodePoolId: string): Promise<ManagedImage[]> {
    const rows = await this.db.query<{
      image: string;
      image_digest: string | null;
      registry_token: number;
    }>(
      `SELECT s.image, s.image_digest,
         s.registry_token IS NOT NULL AS registry_token
       FROM deployments w JOIN container_specs s ON s.deployment_id = w.id
       WHERE w.node_pool_id = ? AND w.managed = 1
         AND w.deletion_requested_at IS NULL AND w.deleted_at IS NULL
       ORDER BY COALESCE((SELECT MAX(j.submitted_at) FROM workloads j
           WHERE j.deployment_id = w.id), w.created_at) DESC, w.id`,
      [nodePoolId],
    );
    return rows.map((row) => ({
      image: row.image,
      imageDigest: row.image_digest,
      registryToken: row.registry_token === 1,
    }));
  }

  async listForReconciliation(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM deployments WHERE deleted_at IS NULL ORDER BY created_at, id`,
    );
    return rows.map((row) => row.id);
  }

  async listDigestMetadataInWindow(
    startMs: number,
    endMs: number,
  ): Promise<DeploymentDigestMetadata[]> {
    const rows = await this.db.query<
      Omit<
        DeploymentDigestMetadata,
        'presentAtEnd' | 'createdInWindow' | 'deletedInWindow' | 'hasVmUsage'
      > & {
        presentAtEnd: number;
        createdInWindow: number;
        deletedInWindow: number;
        hasVmUsage: number;
      }
    >(
      `WITH digest_window AS (SELECT ? AS start_ms, ? AS end_ms)
       SELECT d.id, d.name, p2.name AS nodePoolName,
              d.owner_user_id AS ownerUserId,
              COALESCE(p.owner_user, u.username) AS ownerUsername,
              (d.deleted_at IS NULL OR d.deleted_at >= w.end_ms) AS presentAtEnd,
              (d.created_at >= w.start_ms) AS createdInWindow,
              (d.deleted_at IS NOT NULL AND d.deleted_at < w.end_ms) AS deletedInWindow,
              EXISTS (
                SELECT 1 FROM vms v
                WHERE v.node_pool_id = d.node_pool_id
                  AND v.ip IS NOT NULL
                  AND MAX(v.created_at, d.created_at, w.start_ms)
                    < MIN(COALESCE(v.ended_at, w.end_ms),
                          COALESCE(d.deleted_at, w.end_ms), w.end_ms)
              ) AS hasVmUsage
       FROM deployments d
       LEFT JOIN node_pools p2 ON p2.id = d.node_pool_id
       CROSS JOIN digest_window w
       LEFT JOIN api_access_policy p ON p.owner_user_id = d.owner_user_id
       LEFT JOIN api_access_users u ON u.user_id = d.owner_user_id
       WHERE d.created_at < w.end_ms
         AND (d.deleted_at IS NULL OR d.deleted_at >= w.start_ms)
       ORDER BY d.owner_user_id, d.name, d.id`,
      [startMs, endMs],
    );
    return rows.map((row) => ({
      ...row,
      presentAtEnd: row.presentAtEnd === 1,
      createdInWindow: row.createdInWindow === 1,
      deletedInWindow: row.deletedInWindow === 1,
      hasVmUsage: row.hasVmUsage === 1,
    }));
  }

  async update(
    input: UpdateDeploymentInput,
    scope: OwnershipScope,
  ): Promise<number | null | 'gpu-reserved'> {
    assertNonnegativeInteger(input.gpuCount, `Deployment ${input.id} gpuCount`);
    const config = await encodeContainerSpec(
      input.config,
      `Deployment ${input.id}`,
    );
    const owner = ownerPredicate(scope, 'deployments');
    const updatedGeneration = await this.db.transaction((tx) => {
      if (input.reservation) {
        const [row] = tx.query<{ others: number; replicas: number }>(
          `SELECT ${nodePoolGpuReservationSql('r.node_pool_id')} - r.gpu_count * r.max_replicas AS others,
                  r.max_replicas AS replicas
           FROM deployments r WHERE r.id = ? AND r.generation = ?`,
          [input.id, input.expectedGeneration],
        );
        if (
          row &&
          row.others + input.gpuCount * (input.maxReplicas ?? row.replicas) >
            input.reservation.maxGpus
        ) {
          return 'gpu-reserved' as const;
        }
      }
      const rows = tx.query<{ generation: number }>(
        `UPDATE deployments
       SET gpu_count = ?, max_concurrent_jobs_per_replica = ?,
           min_replicas = COALESCE(?, min_replicas),
           max_replicas = COALESCE(?, max_replicas),
           readiness_probe = CASE WHEN ? THEN ? ELSE readiness_probe END,
           grace_period_seconds = COALESCE(?, grace_period_seconds),
           secret_names = ?,
           generation = generation + 1, updated_at = ?
       WHERE id = ? AND generation = ? AND ${owner.sql}
         AND deletion_requested_at IS NULL AND deleted_at IS NULL
       RETURNING generation`,
        [
          input.gpuCount,
          assertPositiveInteger(
            input.maxConcurrentJobsPerReplica,
            'maxConcurrentJobsPerReplica',
          ),
          input.minReplicas ?? null,
          input.maxReplicas ?? null,
          input.readinessProbe === undefined ? 0 : 1,
          input.readinessProbe == null
            ? null
            : JSON.stringify(
                deploymentReadinessProbeSchema.parse(input.readinessProbe),
              ),
          input.gracePeriodSeconds ?? null,
          secretNamesColumn(input.secretNames),
          Date.now(),
          input.id,
          input.expectedGeneration,
          ...owner.params,
        ],
      );
      const generation = rows[0]?.generation;
      if (generation === undefined) return null;
      const changed = tx.query<{ rowsAffected: number }>(
        `UPDATE container_specs
         SET image = ?, image_digest = ?, command = ?, docker_options = ?,
             env = ?, registry_username = ?, registry_token = ?
         WHERE deployment_id = ?`,
        [
          config.image,
          config.image_digest,
          config.command,
          config.docker_options,
          config.env,
          config.registry_username,
          config.registry_token,
          input.id,
        ],
      );
      if (changed[0]?.rowsAffected !== 1) {
        throw new Error(
          `Deployment ${input.id}: expected exactly one container spec update`,
        );
      }
      return generation;
    });
    if (typeof updatedGeneration === 'number') {
      this.jobChanges.notifyDeployment(input.id);
    }
    return updatedGeneration;
  }

  async requestDeletion(
    id: string,
    scope: OwnershipScope,
  ): Promise<DeploymentDeletionRequest> {
    const owner = ownerPredicate(scope, 'deployments');
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE deployments
       SET deletion_requested_at = ?, updated_at = ?
       WHERE id = ? AND ${owner.sql}
         AND deletion_requested_at IS NULL AND deleted_at IS NULL`,
      [Date.now(), Date.now(), id, ...owner.params],
    );
    if (result[0]?.rowsAffected === 1) {
      this.jobChanges.notifyDeployment(id);
      return 'requested';
    }
    const current = await this.getForScope(id, scope, { includeDeleted: true });
    if (!current) return 'not-found';
    if (current.deletedAt !== null) return 'already-deleted';
    return 'already-requested';
  }

  async requestIdleDeletion(id: string, before: number): Promise<boolean> {
    // One statement, so a Job admitted meanwhile either commits first and
    // keeps the Deployment, or finds it draining and creates a new one.
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE deployments SET deletion_requested_at = ?, updated_at = ?
       WHERE id = ? AND managed = 1 AND created_at <= ?
         AND deletion_requested_at IS NULL AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workloads w
           WHERE w.deployment_id = deployments.id
             AND (w.completed_at IS NULL OR w.completed_at > ?
               OR (w.cleaned_at IS NULL AND w.current_execution_id IS NOT NULL)))`,
      [Date.now(), Date.now(), id, before, before],
    );
    return result[0]?.rowsAffected === 1;
  }

  async advanceGeneration(
    id: string,
    expectedGeneration: number,
  ): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE deployments SET generation = generation + 1, updated_at = ?
       WHERE id = ? AND generation = ?
         AND deletion_requested_at IS NULL AND deleted_at IS NULL
       RETURNING id`,
      [Date.now(), id, expectedGeneration],
    );
    if (rows.length > 0) this.jobChanges.notifyDeployment(id);
    return rows.length > 0;
  }

  async recordRunnerRelease(id: string, release: string): Promise<void> {
    await this.db.query(
      `UPDATE deployments SET runner_release = ? WHERE id = ? AND managed = 1`,
      [release, id],
    );
  }

  async markDeleted(id: string): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE deployments
       SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND deletion_requested_at IS NOT NULL
         AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM workloads d
           WHERE d.deployment_id = deployments.id
             AND (
               d.state NOT IN ('completed', 'errored', 'failed', 'invalid', 'terminated')
               OR d.cleaned_at IS NULL
             )
         )`,
      [Date.now(), Date.now(), id],
    );
    const deleted = result[0]?.rowsAffected === 1;
    if (deleted) this.jobChanges.notifyDeployment(id);
    return deleted;
  }

  async recordOccupancy(
    deploymentId: string,
    held: readonly HeldReplica[],
    live: readonly string[],
    now = Date.now(),
  ): Promise<void> {
    const open = new Set(
      (
        await this.db.query<{ pod_uid: string }>(
          'SELECT pod_uid FROM pool_occupancy WHERE deployment_id = ? AND ended_at IS NULL',
          [deploymentId],
        )
      ).map((row) => row.pod_uid),
    );
    const opening = held.filter((replica) => !open.has(replica.podUid));
    const uids = new Set(live);
    if (opening.length === 0 && [...open].every((uid) => uids.has(uid))) {
      return;
    }
    await this.db.transaction((tx) => {
      for (const replica of opening) {
        tx.query(
          `INSERT INTO pool_occupancy (deployment_id, pod_uid, vm_id,
             node_pool_id, share, gpus, hourly_usd, opened_at)
           SELECT ?, ?, id, node_pool_id, ?, ?, ? * price_per_hour, ?
           FROM vms WHERE id = ? AND node_pool_id IS NOT NULL
           ON CONFLICT (deployment_id, pod_uid) DO NOTHING`,
          [
            deploymentId,
            replica.podUid,
            replica.share,
            replica.gpus,
            replica.share,
            now,
            replica.vmId,
          ],
        );
      }
      tx.query(
        `UPDATE pool_occupancy SET ended_at = ?
         WHERE deployment_id = ? AND ended_at IS NULL
           AND pod_uid NOT IN (SELECT value FROM json_each(?))`,
        [now, deploymentId, JSON.stringify([...uids])],
      );
    });
    // A replica's bind makes it claimable, so wake its waiting discovery.
    if (opening.length > 0) this.jobChanges.notifyDeployment(deploymentId);
  }

  getUsage(deploymentId: string, now = Date.now()): Promise<DeploymentUsage> {
    type Interval = { pod_uid: string; opened_at: number; ended_at: number };
    return this.db.read((reader) => {
      const replicas = reader.query<Interval & { hourly_usd: number }>(
        `SELECT pod_uid, opened_at, COALESCE(ended_at, ?) AS ended_at,
           COALESCE(hourly_usd, 0) AS hourly_usd
         FROM pool_occupancy WHERE deployment_id = ?`,
        [now, deploymentId],
      );
      const attempts = reader.query<Interval>(
        `SELECT p.pod_uid, a.opened_at, COALESCE(a.ended_at, ?) AS ended_at
         FROM pool_occupancy o
         JOIN pod_attempts p ON p.pod_uid = o.pod_uid
         JOIN workload_attempts a ON a.id = p.attempt_id
         WHERE o.deployment_id = ? ORDER BY a.opened_at`,
        [now, deploymentId],
      );
      const usage = {
        replicaHours: 0,
        busyHours: 0,
        costUsd: 0,
        busyCostUsd: 0,
      };
      // Busy is the union of a replica's attempts, which can overlap when it
      // runs several Jobs at once; `reach` is how far its union has got.
      const reach = new Map(replicas.map((r) => [r.pod_uid, r.opened_at]));
      const byUid = new Map(replicas.map((r) => [r.pod_uid, r]));
      for (const r of replicas) {
        const hours = (r.ended_at - r.opened_at) / 3_600_000;
        usage.replicaHours += hours;
        usage.costUsd += hours * r.hourly_usd;
      }
      for (const a of attempts) {
        const r = byUid.get(a.pod_uid)!;
        const end = Math.min(a.ended_at, r.ended_at);
        const from = Math.max(a.opened_at, reach.get(a.pod_uid)!);
        const hours = Math.max(0, end - from) / 3_600_000;
        reach.set(a.pod_uid, Math.max(end, reach.get(a.pod_uid)!));
        usage.busyHours += hours;
        usage.busyCostUsd += hours * r.hourly_usd;
      }
      return usage;
    });
  }
}
