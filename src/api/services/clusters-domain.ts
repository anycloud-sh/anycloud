import type {
  ClusterResponse,
  ClusterSummary,
  ListClustersResponse,
} from '../../shared/api-contract/clusters-schemas.js';
import { ClusterNotFoundError } from './cluster-errors.js';
import {
  ClusterState,
  ClusterStep,
  CLUSTER_STEP_ORDER,
  DELETE_FAILED_PREFIX,
  clusterNetworkScope,
  clusterWorkloadState,
} from '../../shared/clusters.js';
import type { User } from './entities.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import type {
  ClusterInstallerRepository,
  StoredCluster,
  StoredClusterRelease,
  StoredManagementVm,
} from './cluster-installer-store.js';
import {
  resolveClusterRecordForScope,
  type ClusterRecordRepository,
  type StoredClusterRecord,
} from './cluster-store.js';
import { parseClusterConnection } from './kubernetes/cluster-connection.js';
import { clusterApiUrl } from '../../shared/api-ingress.js';

export interface ClusterDomainDependencies {
  installations: Pick<
    ClusterInstallerRepository,
    | 'listForScope'
    | 'getForScope'
    | 'getByNameForScope'
    | 'getManagementVm'
    | 'currentReleaseIntent'
  >;
  clusterRecords: Pick<
    ClusterRecordRepository,
    'getConnection' | 'listForScope' | 'getForScope' | 'getByNameForScope'
  >;
  resolveScope(actor: User): Promise<OwnershipScope>;
  apiVersion: string;
  /** The digest-pinned image this API runs, when Helm-managed; null otherwise. */
  ownApiImage: string | null;
}

export interface ClustersDomain {
  list(actor: User, signal?: AbortSignal): Promise<ListClustersResponse>;
  get(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<ClusterResponse>;
}

function stepIndex(step: ClusterStep): number {
  return CLUSTER_STEP_ORDER.indexOf(step);
}

function stepCompleted(
  installation: StoredCluster,
  step: ClusterStep,
): boolean {
  return stepIndex(installation.step) >= stepIndex(step);
}

/**
 * The hosted API's own record: the creation facts bootstrap handed it (none
 * before 0.1.74), an in-cluster connection. What the API knows of itself
 * stands in for the address, version, pinned image and release, and URL.
 */
function summarizeRecord(
  record: StoredClusterRecord,
  self: Pick<
    ClusterSummary,
    'address' | 'apiVersion' | 'apiImage' | 'managementApiUrl'
  >,
): ClusterSummary {
  const facts = record.record;
  return {
    id: record.id,
    name: record.name,
    state: clusterWorkloadState(record.state, ClusterStep.Release),
    releasing: record.state === ClusterState.Destroying,
    cloudProvider: facts?.cloudProvider ?? null,
    cloudAccount: facts?.cloudAccount ?? null,
    region: facts?.region ?? null,
    zone: facts?.zone ?? null,
    vmType: facts?.vmType ?? null,
    k3sVersion: facts?.k3s.version ?? null,
    managementVmId: facts?.managementVmId ?? null,
    networkScope: facts?.networkScope ?? null,
    checkpointBucket: facts?.checkpointBucket ?? null,
    apiVersion: self.apiVersion,
    // The chart ships with the image, so its version is the API's.
    apiImage: self.apiImage,
    chartVersion: self.apiImage ? self.apiVersion : null,
    connected: record.state !== ClusterState.Destroyed,
    kubernetesIdentity: record.kubernetesIdentity,
    connectionRevision: record.connectionRevision,
    address: self.address,
    managementApiUrl: self.managementApiUrl,
    release:
      self.apiImage && self.apiVersion
        ? {
            apiVersion: self.apiVersion,
            apiImage: self.apiImage,
            chartVersion: self.apiVersion,
          }
        : null,
    lastError: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function summarize(
  installation: StoredCluster,
  vm: StoredManagementVm | null,
  release: StoredClusterRelease | null,
  record: Pick<ClusterSummary, 'connectionRevision'>,
): ClusterSummary {
  const address = vm?.ip ?? null;
  return {
    id: installation.id,
    name: installation.name,
    state: clusterWorkloadState(installation.state, installation.step),
    releasing: installation.state === ClusterState.Destroying,
    cloudProvider: installation.cloudProvider,
    // An installer's row records no cloud account.
    cloudAccount: null,
    region: installation.region,
    zone: installation.zone,
    vmType: installation.vmType,
    k3sVersion: installation.k3sVersion,
    managementVmId: vm?.cloudId ?? null,
    networkScope: clusterNetworkScope(installation.id),
    checkpointBucket: installation.checkpointBucket,
    apiVersion: installation.apiVersion,
    apiImage: installation.apiImage,
    chartVersion: installation.chartVersion,
    connected: installation.connectionId !== null,
    kubernetesIdentity: installation.kubernetesIdentity,
    connectionRevision: record.connectionRevision,
    address,
    // The API's public URL once its release is complete: the installation's
    // hostname, answered through Cloudflare.
    managementApiUrl: stepCompleted(installation, ClusterStep.Release)
      ? clusterApiUrl(installation.id)
      : null,
    release: release
      ? {
          apiVersion: release.apiVersion,
          apiImage: release.apiImage,
          chartVersion: release.chartVersion,
        }
      : null,
    lastError:
      installation.state === ClusterState.DestroyFailed &&
      installation.lastError
        ? `${DELETE_FAILED_PREFIX}${installation.lastError}`
        : installation.lastError,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

export function createClustersDomain(
  dependencies: ClusterDomainDependencies,
): ClustersDomain {
  const { installations } = dependencies;

  async function summary(
    installation: StoredCluster,
  ): Promise<ClusterResponse> {
    const record = await dependencies.clusterRecords.getForScope(
      installation.id,
      {
        kind: 'api',
      },
    );
    return {
      cluster: summarize(
        installation,
        await installations.getManagementVm(installation.id),
        await installations.currentReleaseIntent(installation.id),
        { connectionRevision: record?.connectionRevision ?? 1 },
      ),
    };
  }

  /** A record without creation facts: the hosted API's own. */
  async function recordSummary(
    record: StoredClusterRecord,
  ): Promise<ClusterResponse> {
    // The in-cluster connection's server is the management VM's public
    // control-plane endpoint, https://<address>:6443.
    const stored = await dependencies.clusterRecords.getConnection(record.id);
    const server = stored
      ? parseClusterConnection(stored.connection).server
      : null;
    return {
      cluster: summarizeRecord(record, {
        // An IPv6 host keeps its URL brackets; the installer's address has none.
        address: server
          ? new URL(server).hostname.replace(/^\[|\]$/g, '')
          : null,
        apiVersion: dependencies.apiVersion,
        apiImage: dependencies.ownApiImage,
        managementApiUrl: stored ? clusterApiUrl(record.id) : null,
      }),
    };
  }

  async function resolveForScope(
    identifier: string,
    scope: OwnershipScope,
  ): Promise<StoredCluster | null> {
    return (
      (await installations.getForScope(identifier, scope)) ??
      (await installations.getByNameForScope(identifier, scope))
    );
  }

  return {
    async list(actor, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const rows = await installations.listForScope(scope);
      const summaries = await Promise.all(
        rows.map(async (row) => (await summary(row)).cluster),
      );
      // Records the installer never created (the hosted API's own) list too.
      const created = new Set(rows.map((row) => row.id));
      for (const record of await dependencies.clusterRecords.listForScope(
        scope,
      )) {
        if (created.has(record.id)) continue;
        summaries.push((await recordSummary(record)).cluster);
      }
      return { clusters: summaries };
    },

    async get(actor, identifier, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const installation = await resolveForScope(identifier, scope);
      if (installation) return summary(installation);
      const record = await resolveClusterRecordForScope(
        identifier,
        scope,
        dependencies.clusterRecords,
      );
      if (!record) throw new ClusterNotFoundError(identifier);
      return recordSummary(record);
    },
  };
}
