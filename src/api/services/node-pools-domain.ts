import type {
  CreateNodePoolRequest,
  CreateNodePoolResponse,
  DeleteNodePoolResponse,
  GetNodePoolResponse,
  ListNodePoolsResponse,
  NodePoolRunners,
  NodePoolSummary,
} from '../../shared/api-contract/node-pools-schemas.js';
import type { CloudType, DiskTier } from '../../shared/cloud.js';
import { ClusterState } from '../../shared/clusters.js';
import {
  NODE_POOL_WORKLOAD_STATE,
  NodePoolState,
} from '../../shared/node-pools.js';
import { supportsDiskTier } from '../../shared/cloud-config.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import {
  isComputeProvider,
  nodePoolZoneFormat,
  storageOnlyComputeMessage,
  ZoneFormat,
} from '../../shared/providers.js';
import {
  resolveClusterRecordForScope,
  type ClusterRecordRepository,
  type NodePoolRepository,
  type StoredClusterRecord,
  type StoredNodePool,
} from './cluster-store.js';
import { ClusterNotFoundError } from './cluster-errors.js';
import {
  NodePoolsUnavailableError,
  NodePoolAlreadyExistsError,
  NodePoolCredentialNotFoundError,
  NodePoolNotFoundError,
  NodePoolReferencedError,
  NodePoolZoneInvalidError,
  NodePoolClusterIncompatibleError,
  ClusterNotAcceptingError,
} from './node-pool-errors.js';
import type { User } from './entities.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import { NodePoolAgentSkewError } from './kubernetes/node-pool-join.js';
import {
  ClusterIdentityChangedError,
  ClusterPermissionError,
} from './kubernetes/cluster-runtime.js';
import type {
  NodePoolCapacityObservation,
  NodePoolIngressStatus,
} from './node-pool-controller.js';
import { redactSecrets } from './redact.js';

/** A saved credential, still encrypted, as node pool admission reads it. */
interface NamedCredential {
  id: string;
  encryptedData: string;
  cloudProvider: CloudType;
  authFailedAt: number | null;
}

const ZONE_FORMAT = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A zone is frozen for the node pool's life, so its shape is checked before
 * any durable write using the provider registry's declared zone format.
 */
export function assertNodePoolZone(
  cloudProvider: CloudType,
  region: string | undefined,
  zone: string | undefined,
): void {
  if (zone === undefined) return;
  if (region === undefined) {
    throw new NodePoolZoneInvalidError('--zone requires --region');
  }
  if (!ZONE_FORMAT.test(zone)) {
    throw new NodePoolZoneInvalidError(
      'zone must be lowercase letters, digits and hyphens (at most 63 characters)',
    );
  }
  switch (nodePoolZoneFormat(cloudProvider)) {
    case ZoneFormat.RegionSuffix:
      if (!zone.startsWith(region) || zone === region) {
        throw new NodePoolZoneInvalidError(
          `zone must be a zone of region ${region}, such as ${region}a or ${region}-a`,
        );
      }
      return;
    case ZoneFormat.Numeric:
      if (!/^[1-9]$/.test(zone)) {
        throw new NodePoolZoneInvalidError(
          'zones are a single digit such as 1, 2 or 3',
        );
      }
      return;
    case ZoneFormat.None:
      throw new NodePoolZoneInvalidError(
        `${cloudProvider} node pools do not accept a zone`,
      );
  }
}

interface NodePoolTarget {
  region: string | null;
  zone: string | null;
  vmTypes: string[];
  minVmCount: number;
  maxVmCount: number;
  osDiskSizeGb?: number;
  osDiskTier?: DiskTier;
  spot?: boolean;
}

/** Node pool VM provisioning and observation, owned by the node pool controller. */
export interface NodePoolRuntime {
  schedule(nodePoolId: string): Promise<void>;
  observeCapacity(nodePoolId: string): Promise<NodePoolCapacityObservation>;
  assertClusterCompatible(
    clusterId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  ingress(nodePoolId: string): Promise<NodePoolIngressStatus>;
  /** Its managed Deployments' replicas; null when the cluster can't be read. */
  runners(nodePoolId: string): Promise<NodePoolRunners | null>;
}

/**
 * Live references that must be released before a node pool can start
 * deletion: Deployment records, Service Workloads and unended node pool VM attempts
 * once those consumers target node pools.
 */
interface NodePoolReferences {
  hasLiveReferences(nodePoolId: string): Promise<boolean>;
  /** Live Workloads + Deployments referencing the pool (what the summary reports). */
  countLiveReferences(nodePoolId: string): Promise<number>;
}

export interface NodePoolDomainDependencies {
  /** Back the database up now, so `backup.json` lists the new pool. */
  requestBackup?(reason: string): void;
  nodePools: NodePoolRepository;
  clusterRecords: Pick<
    ClusterRecordRepository,
    'getForScope' | 'getByNameForScope' | 'listForScope'
  >;
  credentials: {
    getNamedCredential(name: string): Promise<NamedCredential | null>;
  };
  references: NodePoolReferences;
  generateId(name: string): string;
  resolveScope(actor: User): Promise<OwnershipScope>;
  runtime: NodePoolRuntime;
  validateTarget(
    input: CreateNodePoolRequest,
    credential: NamedCredential,
  ): Promise<NodePoolTarget>;
}

export interface NodePoolsDomain {
  create(
    actor: User,
    input: CreateNodePoolRequest,
    signal?: AbortSignal,
  ): Promise<CreateNodePoolResponse>;
  list(
    actor: User,
    cluster: string | undefined,
    signal?: AbortSignal,
  ): Promise<ListNodePoolsResponse>;
  get(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<GetNodePoolResponse>;
  delete(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<DeleteNodePoolResponse>;
}

/** Whether a stored pool is what a create with these settings would record. */
function sameNodePoolSpec(
  pool: StoredNodePool,
  spec: NodePoolTarget & {
    clusterId: string;
    computeCredentialId: string;
    allowPrivilegedJobs?: boolean;
    userNamespaceJobs?: boolean;
    requireNestedVirtualization?: boolean;
  },
): boolean {
  return (
    pool.clusterId === spec.clusterId &&
    pool.computeCredentialId === spec.computeCredentialId &&
    pool.region === spec.region &&
    pool.zone === spec.zone &&
    pool.vmTypes.join('\n') === spec.vmTypes.join('\n') &&
    pool.minVmCount === spec.minVmCount &&
    pool.maxVmCount === spec.maxVmCount &&
    pool.osDiskSizeGb === (spec.osDiskSizeGb ?? null) &&
    pool.osDiskTier === (spec.osDiskTier ?? null) &&
    pool.spot === (spec.spot ?? false) &&
    pool.allowPrivilegedJobs === (spec.allowPrivilegedJobs ?? false) &&
    pool.userNamespaceJobs === (spec.userNamespaceJobs ?? false) &&
    pool.requireNestedVirtualization ===
      (spec.requireNestedVirtualization ?? false)
  );
}

async function resolveNodePoolForScope(
  identifier: string,
  scope: OwnershipScope,
  nodePools: NodePoolRepository,
): Promise<StoredNodePool | null> {
  return (
    (await nodePools.getForScope(identifier, scope)) ??
    (await nodePools.getByNameForScope(identifier, scope))
  );
}

/**
 * The installation has at most one active cluster, so an omitted selector means
 * that cluster. An explicit selector still has to resolve, so a stale ID or name
 * fails instead of silently landing in whichever cluster exists.
 */
async function selectCluster(
  identifier: string | undefined,
  scope: OwnershipScope,
  clusterRecords: NodePoolDomainDependencies['clusterRecords'],
): Promise<StoredClusterRecord> {
  if (identifier !== undefined) {
    const selected = await resolveClusterRecordForScope(
      identifier,
      scope,
      clusterRecords,
    );
    if (!selected) throw new ClusterNotFoundError(identifier);
    return selected;
  }
  const [cluster] = await clusterRecords.listForScope(scope);
  if (!cluster) throw new NodePoolsUnavailableError();
  return cluster;
}

async function toSummary(
  nodePool: StoredNodePool,
  runtime: NodePoolRuntime,
  references: NodePoolReferences,
): Promise<NodePoolSummary> {
  const ingress = await runtime.ingress(nodePool.id);
  return {
    id: nodePool.id,
    name: nodePool.name,
    clusterId: nodePool.clusterId,
    state: NODE_POOL_WORKLOAD_STATE[nodePool.state],
    releasing: nodePool.state === NodePoolState.Deleting,
    cloudProvider: nodePool.cloudProvider,
    region: nodePool.region,
    zone: nodePool.zone,
    vmTypes: nodePool.vmTypes,
    minVmCount: nodePool.minVmCount,
    maxVmCount: nodePool.maxVmCount,
    osDiskSizeGb: nodePool.osDiskSizeGb,
    osDiskTier: nodePool.osDiskTier,
    spot: nodePool.spot,
    allowPrivilegedJobs: nodePool.allowPrivilegedJobs,
    userNamespaceJobs: nodePool.userNamespaceJobs,
    requireNestedVirtualization: nodePool.requireNestedVirtualization,
    capacity: await runtime.observeCapacity(nodePool.id),
    liveReferences: await references.countLiveReferences(nodePool.id),
    ingressEntryIp: ingress.entryIp,
    ingress,
    lastError: nodePool.lastError ? redactSecrets(nodePool.lastError) : null,
    createdAt: nodePool.createdAt,
    updatedAt: nodePool.updatedAt,
  };
}

export function createNodePoolsDomain(
  dependencies: NodePoolDomainDependencies,
): NodePoolsDomain {
  return {
    async create(actor, input, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const existing = await resolveNodePoolForScope(
        input.name,
        scope,
        dependencies.nodePools,
      );
      // A re-run of the same create answers with the pool it made (below);
      // a failed pool never comes up, so it is not an answer.
      if (existing?.state === NodePoolState.Deleting) {
        throw new NodePoolAlreadyExistsError(
          input.name,
          'is being deleted; create it again once it is gone',
        );
      }
      if (existing?.state === NodePoolState.Failed) {
        throw new NodePoolAlreadyExistsError(
          input.name,
          'failed; delete it, then create it again',
        );
      }

      const cluster = await selectCluster(
        input.cluster,
        scope,
        dependencies.clusterRecords,
      );
      if (cluster.state === ClusterState.Destroying) {
        throw new ClusterNotAcceptingError(cluster.id);
      }
      if (cluster.state !== ClusterState.Ready) {
        throw new NodePoolsUnavailableError();
      }
      try {
        await dependencies.runtime.assertClusterCompatible(cluster.id, signal);
      } catch (error) {
        signal?.throwIfAborted();
        // Named diagnostics carry no upstream material; anything else is
        // reduced to a fixed message so provider or parser output never
        // reaches the caller.
        throw new NodePoolClusterIncompatibleError(
          error instanceof NodePoolAgentSkewError ||
          error instanceof ClusterPermissionError ||
          error instanceof ClusterIdentityChangedError
            ? error.message
            : 'cluster could not be verified for node pool admission',
        );
      }

      const credential = await dependencies.credentials.getNamedCredential(
        input.credentialName,
      );
      if (!credential) {
        throw new NodePoolCredentialNotFoundError(input.credentialName);
      }
      if (!isComputeProvider(credential.cloudProvider)) {
        throw new InvalidAnycloudConfigError(
          storageOnlyComputeMessage(credential.cloudProvider),
        );
      }
      assertNodePoolZone(credential.cloudProvider, input.region, input.zone);
      if (
        (input.osDiskSizeGb !== undefined || input.osDiskTier !== undefined) &&
        !supportsDiskTier(credential.cloudProvider)
      ) {
        throw new InvalidAnycloudConfigError(
          `${credential.cloudProvider} node pools boot with a fixed OS disk; omit --disk-size and --disk-tier`,
        );
      }
      const target = await dependencies.validateTarget(input, credential);
      signal?.throwIfAborted();
      if (existing) {
        if (
          existing.name.toLowerCase() !== input.name.toLowerCase() ||
          !sameNodePoolSpec(existing, {
            ...target,
            clusterId: cluster.id,
            computeCredentialId: credential.id,
            allowPrivilegedJobs: input.allowPrivilegedJobs,
            userNamespaceJobs: input.userNamespaceJobs,
            requireNestedVirtualization: input.requireNestedVirtualization,
          })
        ) {
          throw new NodePoolAlreadyExistsError(
            input.name,
            'already exists with other settings; delete it first or create it with its own',
          );
        }
        return {
          nodePool: await toSummary(
            existing,
            dependencies.runtime,
            dependencies.references,
          ),
        };
      }

      const nodePoolId = dependencies.generateId(input.name);
      let result: Awaited<ReturnType<NodePoolRepository['create']>>;
      try {
        result = await dependencies.nodePools.create({
          id: nodePoolId,
          clusterId: cluster.id,
          ownerUserId: actor.id,
          name: input.name,
          computeCredentialId: credential.id,
          region: target.region,
          zone: target.zone,
          vmTypes: target.vmTypes,
          minVmCount: target.minVmCount,
          maxVmCount: target.maxVmCount,
          osDiskSizeGb: target.osDiskSizeGb,
          osDiskTier: target.osDiskTier,
          spot: target.spot,
          allowPrivilegedJobs: input.allowPrivilegedJobs,
          userNamespaceJobs: input.userNamespaceJobs,
          requireNestedVirtualization: input.requireNestedVirtualization,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed')
        ) {
          throw new NodePoolAlreadyExistsError(input.name);
        }
        throw error;
      }
      if (result === 'cluster-not-accepting') {
        throw new ClusterNotAcceptingError(cluster.id);
      }

      void dependencies.runtime.schedule(nodePoolId);
      dependencies.requestBackup?.(`node pool ${nodePoolId} created`);
      const nodePool = await dependencies.nodePools.getForScope(
        nodePoolId,
        scope,
      );
      if (!nodePool) {
        throw new Error(`Created node pool ${nodePoolId} is missing`);
      }
      return {
        nodePool: await toSummary(
          nodePool,
          dependencies.runtime,
          dependencies.references,
        ),
      };
    },

    async list(actor, cluster, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      let clusterId: string | undefined;
      if (cluster !== undefined) {
        const selected = await resolveClusterRecordForScope(
          cluster,
          scope,
          dependencies.clusterRecords,
        );
        if (!selected) throw new ClusterNotFoundError(cluster);
        clusterId = selected.id;
      }
      const nodePools = await dependencies.nodePools.listForScope(scope, {
        clusterId,
      });
      const summaries = await Promise.all(
        nodePools.map((nodePool) =>
          toSummary(nodePool, dependencies.runtime, dependencies.references),
        ),
      );
      signal?.throwIfAborted();
      return { nodePools: summaries };
    },

    async get(actor, identifier, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const nodePool = await resolveNodePoolForScope(
        identifier,
        scope,
        dependencies.nodePools,
      );
      if (!nodePool) throw new NodePoolNotFoundError(identifier);
      const [summary, runners] = await Promise.all([
        toSummary(nodePool, dependencies.runtime, dependencies.references),
        dependencies.runtime.runners(nodePool.id),
      ]);
      return { nodePool: { ...summary, runners } };
    },

    async delete(actor, identifier, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const nodePool = await resolveNodePoolForScope(
        identifier,
        scope,
        dependencies.nodePools,
      );
      if (!nodePool) {
        // A re-run by name after the pool is gone answers with that pool.
        const deleted = (
          await dependencies.nodePools.listForScope(scope, {
            includeDeleted: true,
          })
        )
          .filter(
            (pool) =>
              pool.state === NodePoolState.Deleted &&
              pool.name.toLowerCase() === identifier.trim().toLowerCase(),
          )
          .at(-1);
        if (!deleted) throw new NodePoolNotFoundError(identifier);
        return {
          nodePool: await toSummary(
            deleted,
            dependencies.runtime,
            dependencies.references,
          ),
        };
      }

      // Early diagnostic only; the request itself re-evaluates references in
      // its own transaction so a concurrent admission cannot slip between.
      if (await dependencies.references.hasLiveReferences(nodePool.id)) {
        throw new NodePoolReferencedError();
      }
      let result: Awaited<ReturnType<NodePoolRepository['requestDeletion']>>;
      try {
        result = await dependencies.nodePools.requestDeletion(
          nodePool.id,
          scope,
        );
      } catch (error) {
        // A Service admitted between the reference check and this write is
        // refused by the store's trigger; report it as the same conflict.
        if (
          error instanceof Error &&
          error.message.includes('node pool still has Services')
        ) {
          throw new NodePoolReferencedError();
        }
        throw error;
      }
      if (result === 'not-found') throw new NodePoolNotFoundError(identifier);
      if (result === 'referenced') throw new NodePoolReferencedError();

      if (result !== 'already-deleted') {
        void dependencies.runtime.schedule(nodePool.id);
      }
      const updated = await dependencies.nodePools.getForScope(
        nodePool.id,
        scope,
      );
      if (!updated) throw new Error(`Node pool ${nodePool.id} is missing`);
      return {
        nodePool: await toSummary(
          updated,
          dependencies.runtime,
          dependencies.references,
        ),
      };
    },
  };
}
