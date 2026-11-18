import type {
  ClusterResponse,
  DeleteClusterResponse,
  ClusterSummary,
  ListClustersResponse,
} from '../../shared/api-contract/clusters-schemas.js';
import * as semver from 'semver';
import {
  ClusterBusyError,
  ClusterDestroyFailedError,
  ClusterExistsError,
  ClusterInvalidError,
  ClusterNotFoundError,
  ClusterReachableError,
  ClusterReferencedError,
  dependentsRefusal,
  ClusterReleaseConflictError,
  ClusterUnavailableError,
  ClusterUnreachableError,
  ClusterVmPresentError,
  HostedApiAccessError,
} from './cluster-errors.js';
import { OWNER_API_TAG } from './api-identity.js';
import { hostedApiIdentity } from '../../shared/hosted-api-identity.js';
import {
  isComputeProvider,
  storageOnlyComputeMessage,
} from '../../shared/providers.js';
import type { CloudCredentials, CloudType } from '../../shared/cloud.js';
import type { ApiBackupManifest } from '../../shared/api-backup-manifest.js';
import { isApiBackupBucket } from './bucket-storage-operation.js';
import {
  deleteReport,
  takeFinalBackup,
  type FinalBackup,
} from './cluster-delete-report.js';
import {
  ClusterState,
  ClusterStep,
  ClusterReleaseState,
  CLUSTER_STEP_ORDER,
  DELETE_FAILED_PREFIX,
  clusterNetworkScope,
  clusterWorkloadState,
  type CreateClusterRequest,
} from '../../shared/clusters.js';
import {
  SYSTEM_RELEASE_HELM_CHART_NAME,
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
  SYSTEM_RELEASE_NAMESPACE,
  apiImageTagReference,
  pinnedApiImage,
} from '../../shared/system-release.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { User } from './entities.js';
import { githubOwner, type GithubOwner } from './api-authentication.js';
import type { CloudResourceScope, GatewayVM } from './entities.js';
import { VMReleaseState, type VMReleaseObservation } from './gateways/cloud.js';
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
import {
  parseClusterConnection,
  serializeClusterConnection,
  type ClusterConnectionDocument,
} from './kubernetes/cluster-connection.js';
import {
  clusterApiUrl,
  clusterHostname,
  apiIngressHelmChart,
  API_INGRESS_CRD,
  API_INGRESS_RELEASE,
} from '../../shared/api-ingress.js';
import {
  apiTlsKeyAndCsr,
  apiTlsObjects,
  apiTlsProbeCommand,
  samePem,
} from './system-release/api-tls.js';
import {
  buildSystemReleaseHelmChart,
  compareReleaseIntent,
  systemReleaseValues,
  valuesSha256,
  type SystemReleaseBackupValues,
  type SystemReleaseClusterValues,
  type HelmChartObject,
} from '../../shared/system-release-values.js';
import type { ReleaseReadiness } from './system-release/release-readiness.js';
import {
  parseInstallerAccessMaterial,
  managementHostStartupScript,
  installerConnectionDocument,
  managementKubernetesConfig,
  INSTALLER_ACCESS_READ_COMMAND,
  MANAGEMENT_K3S_CONFIG_STAGING_PATH,
  MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND,
  MANAGEMENT_KUBERNETES_READY_COMMAND,
  MANAGEMENT_LABEL_COMMAND,
} from './system-release/management-host.js';

export function hostedVersionFix(
  url: string,
  cli: string,
  hosted: string | null,
): string {
  const upgradeHosted = `anycloud api use ${url}, anycloud api upgrade, then anycloud api use local`;
  if (hosted && semver.valid(hosted) && semver.valid(cli)) {
    if (semver.gt(hosted, cli)) {
      return `this CLI (${cli}) is older than the hosted API (${hosted}); run anycloud update`;
    }
    if (semver.lt(hosted, cli)) {
      return `the hosted API (${hosted}) is older than this CLI (${cli}); upgrade it (${upgradeHosted}) or install anycloud ${hosted} (curl -fsSL https://get.anycloud.sh | sh -s -- --version ${hosted})`;
    }
  }
  return `run anycloud update if this CLI (${cli}) is the older side, or upgrade the hosted API (${upgradeHosted}) if the hosted API is older`;
}

/** What the hosted API still manages, asked with the bootstrapping account. */
export type HostedNodePoolInventory =
  | {
      kind: 'pools';
      pools: Array<{ id: string; name: string; liveReferences: number }>;
    }
  | { kind: 'unreachable'; reason: string };

/**
 * Seam for B1: the installer asks the hosted API (`GET /v1/node-pools` at the
 * installation's hostname with the actor's bearer) which pools exist and which
 * carry live Deployments or Services. Until B1 lands, the default adapter
 * answers from the installer's own node-pool records.
 */
export interface HostedNodePoolInventorySource {
  inventory(
    installation: StoredCluster,
    owner: GithubOwner,
  ): Promise<HostedNodePoolInventory>;
  /** C28: the hosted API backs its database up now; rejects with the reason. */
  backup(
    installation: StoredCluster,
    owner: GithubOwner,
  ): Promise<{ backedUpAt: string }>;
}

/**
 * The public DNS record the API answers on and its origin TLS, through
 * the DNS Worker with the actor's token.
 */
interface ClusterDns {
  publish(subdomain: string, ip: string, token: string): Promise<void>;
  /** Whether a public resolver answers an A record for the hostname. */
  publicARecordExists(hostname: string, signal?: AbortSignal): Promise<boolean>;
  remove(subdomain: string, token: string): Promise<void>;
  issueCertificate(
    subdomain: string,
    csr: string,
    token: string,
  ): Promise<{ certificate: string; originPullCa: string | null }>;
  activateTls(subdomain: string, token: string): Promise<void>;
  removeTls(subdomain: string, token: string): Promise<void>;
}

/** A stale or foreign release intent must never be applied to the cluster. */
class ClusterReleaseRefusedError extends Error {
  constructor(reason: string) {
    super(`Refusing to install the API on this cluster: ${reason}`);
    this.name = 'ClusterReleaseRefusedError';
  }
}

export interface NamedCredential {
  id: string;
  encryptedData: string;
  cloudProvider: CloudType;
  authFailedAt: number | null;
}

export interface ClusterTarget {
  region: string;
  zone: string | null;
  vmType: string;
}

interface ManagementVmIdentity {
  cloudId: string;
  provider: CloudType;
  credentialId: string;
  region: string;
  availabilityZone: string | null;
  /** The recorded instance type; the gateway resolves it as a plain VM type, never as a GPU alias. */
  vmType: string;
}

/**
 * Cloud operations for the management VM, routed through the existing
 * provider gateways and the exact VM handle. Production binds these in the
 * installation runtime; tests supply fakes.
 */
export interface ClusterInfrastructure {
  /** Adopt the recorded attempt if the provider already has it; create it otherwise. */
  provisionManagementVm(input: {
    credential: NamedCredential;
    target: ClusterTarget;
    scope: CloudResourceScope;
    cloudId: string;
    startupScript: string;
    version: string;
  }): Promise<GatewayVM>;
  /**
   * Re-apply the management VM's firewall to the current rule set, so a VM
   * provisioned before a rule existed (443 for origin TLS) gains it.
   */
  ensureManagementIngress(input: {
    credential: NamedCredential;
    target: ClusterTarget;
    scope: CloudResourceScope;
  }): Promise<void>;
  /** Confirm the VM is gone; returns false while the provider still reports it. */
  releaseManagementVm(input: {
    credential: NamedCredential;
    identity: ManagementVmIdentity;
    scope: CloudResourceScope;
  }): Promise<boolean>;
  /** Management VMs the cloud still holds under a cluster scope, stopped included. */
  findManagementVms(input: {
    credential: NamedCredential;
    target: ClusterTarget;
    scope: CloudResourceScope;
  }): Promise<string[]>;
  /** One provider read of a recorded management VM, changing nothing. */
  observeManagementVm(input: {
    credential: NamedCredential;
    identity: ManagementVmIdentity;
  }): Promise<VMReleaseObservation>;
  /** Managed checkpoint bucket: create if missing and keep object versions (idempotent). */
  ensureCheckpointBucket(input: {
    credential: NamedCredential;
    region: string;
    bucket: string;
    installationId: string;
    ownerUserId: string;
  }): Promise<void>;
  /** Managed checkpoint bucket only: delete it with every object version (idempotent). */
  deleteCheckpointBucket(input: {
    credential: NamedCredential;
    region: string;
    bucket: string;
  }): Promise<void>;
}

interface ManagementHostTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

/**
 * A command that ran on the host reports its exit code, including non-zero
 * ones the bootstrap protocol relies on; a transport failure (sshd not up
 * yet, connection lost) is reported separately so polling can continue.
 */
export type ManagementHostExecOutcome =
  | { kind: 'exited'; code: number; stdout: string; stderr: string }
  | { kind: 'unreachable'; error: string };

interface ManagementHostExecOptions {
  signal?: AbortSignal;
  /** Per-command deadline; the adapter's default suits long host preparation. */
  timeoutMs?: number;
}

/** SSH command surface for the management host; every command is idempotent. */
export interface ManagementHostAccess {
  exec(
    target: ManagementHostTarget,
    command: string,
    options?: ManagementHostExecOptions,
  ): Promise<ManagementHostExecOutcome>;
  /** Kernel-level TCP probe of the SSH port; costs the booting host nothing. */
  reachable(target: ManagementHostTarget): Promise<boolean>;
  /**
   * Write bytes over the transport's stdin channel: the content never
   * appears in a remote command line. Throws on transport failure.
   */
  writeFile(
    target: ManagementHostTarget,
    path: string,
    content: string,
    mode: number,
  ): Promise<void>;
}

/** Kubernetes operations on the cluster through the installer's stored connection. */
export interface ClusterReleaseClient {
  /** Create the release namespace; an existing one is fine. */
  ensureNamespace(
    connection: ClusterConnectionDocument,
    namespace: string,
  ): Promise<void>;
  /**
   * Whether a CustomResourceDefinition exists and is Established; null when
   * the API server has no such CRD yet.
   */
  readCustomResourceDefinition(
    connection: ClusterConnectionDocument,
    name: string,
  ): Promise<{ established: boolean } | null>;
  /** Delete a namespaced object; an absent one is fine. */
  deleteObject(
    connection: ClusterConnectionDocument,
    object: {
      apiVersion: string;
      kind: string;
      metadata: { name: string; namespace: string };
    },
  ): Promise<void>;
  /** Create or merge-patch a namespaced object (Traefik's HelmChart, the API's TLS Secret). */
  applyObject(
    connection: ClusterConnectionDocument,
    object: {
      apiVersion: string;
      kind: string;
      metadata: { name: string; namespace: string };
      spec?: unknown;
      type?: string;
      stringData?: Record<string, string>;
    },
  ): Promise<void>;
  getHelmChart(
    connection: ClusterConnectionDocument,
    name: string,
    namespace: string,
  ): Promise<HelmChartObject | null>;
  /**
   * Create when `expectedResourceVersion` is null, otherwise patch with that
   * resourceVersion as a precondition; throws ClusterReleaseConflictError when
   * the object moved since it was observed.
   */
  applyHelmChart(
    connection: ClusterConnectionDocument,
    chart: HelmChartObject,
    expectedResourceVersion: string | null,
  ): Promise<void>;
  observeRelease(
    connection: ClusterConnectionDocument,
    expected: {
      revision: number;
      operationId: string;
      image: string;
      version: string;
      namespace: string;
      /** Real endpoint completion is measured through. */
      apiUrl: string;
    },
  ): Promise<ReleaseReadiness>;
  /** One line of what the cluster says about a release that missed its target. */
  describeRelease(
    connection: ClusterConnectionDocument,
    namespace: string,
  ): Promise<string>;
}

/** The saved compute credentials a Cluster is created with and bootstrapped from. */
interface ClusterCredentials {
  getNamedCredential(name: string): Promise<NamedCredential | null>;
  getCredentialWithCloudProvider(
    credentialId: string,
  ): Promise<{ encryptedData: string; cloudProvider: CloudType } | null>;
}

export interface ClusterDomainDependencies {
  installations: ClusterInstallerRepository;
  clusterRecords: Pick<
    ClusterRecordRepository,
    | 'getConnection'
    | 'countActiveNodePools'
    | 'storeConnection'
    | 'listForScope'
    | 'getForScope'
    | 'getByNameForScope'
  >;
  credentials: ClusterCredentials;
  /** Decrypted material of the installation's compute credential, for the hosted API's backups. */
  storageCredential(credentialId: string): Promise<{
    cloudProvider: CloudType;
    credentials: CloudCredentials;
  }>;
  /**
   * The account the compute credential reaches: the AWS account STS reports,
   * the GCP project or the Azure subscription; null on Lambda.
   */
  cloudAccount(credentials: CloudCredentials): Promise<string | null>;
  /** Existence and region of a checkpoint bucket under that credential. */
  checkpointBucket(
    credential: { cloudProvider: CloudType; credentials: CloudCredentials },
    bucket: string,
    region: string,
  ): Promise<{ exists: boolean; region: string }>;
  /** The bucket's hosted API backup manifest; null when it holds none. */
  backupManifest(
    credential: { cloudProvider: CloudType; credentials: CloudCredentials },
    bucket: string,
    region: string,
  ): Promise<ApiBackupManifest | 'unrestorable' | null>;
  validateTarget(
    input: CreateClusterRequest,
    credential: NamedCredential,
  ): Promise<ClusterTarget>;
  /** Null when this API cannot bootstrap (a hosted API has no installer role). */
  infrastructure: ClusterInfrastructure | null;
  host: ManagementHostAccess;
  releases: ClusterReleaseClient;
  dns: ClusterDns;
  hostedPools: HostedNodePoolInventorySource;
  /**
   * An API image (the bootstrapping API's tag, or the recorded pinned image)
   * → its immutable digest and the digest-pinned chart it was built with.
   */
  resolveApiImage(
    reference: string,
  ): Promise<{ digest: string; chart: string }>;
  observeKubernetesIdentity(
    connection: ClusterConnectionDocument,
    signal?: AbortSignal,
  ): Promise<string>;
  generateId(name: string): string;
  generateOperationId(): string;
  generateServerToken(): string;
  generateSshKeypair(): Promise<{ publicKey: string; privateKey: string }>;
  resolveScope(actor: User): Promise<OwnershipScope>;
  apiVersion: string;
  /** The digest-pinned image this API runs, when Helm-managed; null otherwise. */
  ownApiImage: string | null;
  /** Run the remaining bootstrap steps after the request has returned. */
  schedule(task: () => Promise<void>): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  log: {
    info(message: string, metadata: Record<string, unknown>): void;
    warn(message: string, metadata: Record<string, unknown>): void;
  };
}

export interface ClustersDomain {
  create(
    actor: User,
    input: CreateClusterRequest,
    signal?: AbortSignal,
  ): Promise<ClusterResponse>;
  list(actor: User, signal?: AbortSignal): Promise<ListClustersResponse>;
  get(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<ClusterResponse>;
  destroy(
    actor: User,
    identifier: string,
    options: { deleteBuckets: boolean },
    signal?: AbortSignal,
  ): Promise<DeleteClusterResponse>;
  /**
   * Delete the installer's record of a cluster whose hosted API is
   * unreachable and whose management VM the cloud shows gone, and its DNS
   * record. The cloud and the checkpoint bucket are untouched; the answer
   * names what is left to delete by hand.
   */
  forget(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; name: string; leftovers: string[] }>;
}

/** Clusters bind their hosted API to a GitHub account and publish its DNS record. */
const CLUSTERS_NEED = 'Clusters need';

const SSH_READY_TIMEOUT_MS = 10 * 60_000;
// One probe must not hang past the overall wait; host-startup.ts uses the same.
const SSH_PROBE_TIMEOUT_MS = 30_000;
const SSH_READY_INITIAL_BACKOFF_MS = 5_000;
const SSH_READY_MAX_BACKOFF_MS = 30_000;
const KUBERNETES_READY_TIMEOUT_MS = 10 * 60_000;
const KUBERNETES_READY_POLL_MS = 5_000;
const RELEASE_APPLY_ATTEMPTS = 3;
const RELEASE_READY_TIMEOUT_MS = 15 * 60_000;
const RELEASE_READY_POLL_MS = 5_000;
/** Traefik's IngressRoute CRD must exist before the API chart renders one. */
const INGRESS_CRD_TIMEOUT_MS = 3 * 60_000;
const INGRESS_CRD_POLL_MS = 5_000;
const API_TLS_PROBE_TIMEOUT_MS = 3 * 60_000;
const API_TLS_PROBE_POLL_MS = 5_000;
// Cloudflare's nameservers serve a new record within seconds; a first query
// before then leaves 1.1.1.1 answering NXDOMAIN for the zone's 1800 s negative
// TTL, so the deadline outlasts it.
const PUBLIC_RECORD_FIRST_QUERY_MS = 10_000;
const PUBLIC_RECORD_POLL_MS = 5_000;
const PUBLIC_RECORD_TIMEOUT_MS = 35 * 60_000;
// Two failed requests in a row may be a blip; three, at most 25 s with each
// request's 5 s timeout, mean this network can't reach 1.1.1.1, and waiting
// out the deadline would not help.
const PUBLIC_RESOLVER_ATTEMPTS = 3;
const VM_RELEASE_TIMEOUT_MS = 10 * 60_000;
const VM_RELEASE_POLL_MS = 5_000;

/** The hex digest of a pinned chart reference, as the installation records it. */
function chartDigest(chart: string): string {
  return chart.slice(chart.lastIndexOf('@sha256:') + '@sha256:'.length);
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

/** The recorded management VM as the cloud gateway addresses it. */
function managementVmIdentity(
  installation: StoredCluster,
  vm: StoredManagementVm,
): ManagementVmIdentity {
  return {
    cloudId: vm.cloudId,
    provider: installation.cloudProvider,
    credentialId: vm.credentialId,
    region: vm.region ?? installation.region,
    availabilityZone: vm.availabilityZone,
    vmType: installation.vmType,
  };
}

function clusterScope(
  installation: Pick<StoredCluster, 'id'>,
): CloudResourceScope {
  return Object.freeze({
    id: clusterNetworkScope(installation.id),
    tags: Object.freeze({ anycloud_cluster: installation.id }),
  });
}

/**
 * The management VM's provider name (the AWS client token). A restore keeps
 * the lost cluster's id, so its VM gets its own suffix: reusing the lost VM's
 * token would adopt or collide with that VM.
 */
export function managementVmCloudId(
  installation: Pick<StoredCluster, 'id' | 'restoreFromBackup' | 'createdAt'>,
): string {
  const suffix = installation.restoreFromBackup
    ? `-r${installation.createdAt.toString(36)}`
    : '';
  return (
    `anycloud-cluster-${installation.id}`.slice(0, 63 - suffix.length) + suffix
  );
}

/**
 * The hosted API's own record: the creation facts bootstrap handed it (none
 * before 0.1.74), an in-cluster connection. What the API knows of itself
 * stands in for the address, version, pinned image and release, and URL.
 */
function summarizeRecord(
  record: StoredClusterRecord,
  activeNodePoolCount: number,
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
    activeNodePoolCount,
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
  record: Pick<ClusterSummary, 'connectionRevision' | 'activeNodePoolCount'>,
): ClusterSummary {
  const address = vm?.ip ?? null;
  return {
    id: installation.id,
    name: installation.name,
    state: clusterWorkloadState(installation.state, installation.step),
    releasing: installation.state === ClusterState.Destroying,
    cloudProvider: installation.cloudProvider,
    // The installer asks the cloud only when it writes the release values.
    cloudAccount: null,
    region: installation.region,
    zone: installation.zone,
    vmType: installation.vmType,
    k3sVersion: installation.k3sVersion,
    managementVmId: vm?.endedAt === null ? vm.cloudId : null,
    networkScope: clusterScope(installation).id,
    checkpointBucket: installation.checkpointBucket,
    apiVersion: installation.apiVersion,
    apiImage: installation.apiImage,
    chartVersion: installation.chartVersion,
    connected: installation.connectionId !== null,
    kubernetesIdentity: installation.kubernetesIdentity,
    connectionRevision: record.connectionRevision,
    activeNodePoolCount: record.activeNodePoolCount,
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
  // Installations claimed for a task in this process, by the lane of that
  // task. After an API restart the map is empty, so a replayed
  // bootstrap/destroy resumes a row whose durable state still says it is in
  // progress instead of leaving it stranded.
  type Lane = ClusterState.Bootstrapping | ClusterState.Destroying;
  const active = new Map<string, Lane>();

  /**
   * Claims the installation synchronously, before any await, so a concurrent
   * create and destroy cannot both pass their checks and one silently skip
   * its task. A claim held by another task refuses with that task's lane; a
   * throw from `prepare` releases the claim, and otherwise the task keeps it
   * until it ends.
   */
  async function start(
    installationId: string,
    lane: Lane,
    prepare: () => Promise<StoredCluster>,
    task: (installation: StoredCluster) => Promise<void>,
  ): Promise<StoredCluster> {
    const holder = active.get(installationId);
    if (holder) throw new ClusterBusyError(holder);
    active.set(installationId, lane);
    let installation: StoredCluster;
    try {
      installation = await prepare();
    } catch (error) {
      active.delete(installationId);
      throw error;
    }
    dependencies.schedule(async () => {
      try {
        await task(installation);
      } finally {
        active.delete(installationId);
      }
    });
    return installation;
  }

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
        {
          connectionRevision: record?.connectionRevision ?? 1,
          activeNodePoolCount:
            await dependencies.clusterRecords.countActiveNodePools(
              installation.id,
            ),
        },
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
      cluster: summarizeRecord(
        record,
        await dependencies.clusterRecords.countActiveNodePools(record.id),
        {
          // An IPv6 host keeps its URL brackets; the installer's address has none.
          address: server
            ? new URL(server).hostname.replace(/^\[|\]$/g, '')
            : null,
          apiVersion: dependencies.apiVersion,
          apiImage: dependencies.ownApiImage,
          managementApiUrl: stored ? clusterApiUrl(record.id) : null,
        },
      ),
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

  /** The credential recorded at intent time; bootstrap never switches it. */
  async function recordedCredential(
    installation: StoredCluster,
  ): Promise<NamedCredential> {
    const credential =
      await dependencies.credentials.getCredentialWithCloudProvider(
        installation.computeCredentialId,
      );
    if (!credential) {
      throw new Error(
        `Compute credential for installation ${installation.id} is no longer saved`,
      );
    }
    if (credential.cloudProvider !== installation.cloudProvider) {
      throw new Error(
        `Compute credential provider changed for installation ${installation.id}`,
      );
    }
    return {
      id: installation.computeCredentialId,
      authFailedAt: null,
      ...credential,
    };
  }

  async function hostTarget(
    installation: StoredCluster,
    vm: StoredManagementVm,
  ): Promise<ManagementHostTarget> {
    if (!vm.ip) {
      throw new Error('Management VM has no public address yet');
    }
    const secrets = await installations.getBootstrapSecrets(installation.id);
    return {
      host: vm.ip,
      port: 22,
      username: 'root',
      privateKey: secrets.sshPrivateKey,
    };
  }

  async function connectionFor(
    installation: StoredCluster,
  ): Promise<ClusterConnectionDocument> {
    if (!installation.connectionId) {
      throw new Error('cluster is not registered yet');
    }
    const stored = await dependencies.clusterRecords.getConnection(
      installation.connectionId,
    );
    if (!stored) throw new Error('cluster connection is unavailable');
    if (
      installation.kubernetesIdentity &&
      stored.kubernetesIdentity !== installation.kubernetesIdentity
    ) {
      throw new Error(
        `Recorded cluster identity ${stored.kubernetesIdentity} differs from this installation's ${installation.kubernetesIdentity}`,
      );
    }
    return parseClusterConnection(stored.connection);
  }

  // ---------------------------------------------------------------- steps

  async function stepManagementVm(
    installation: StoredCluster,
    credential: NamedCredential,
    signal?: AbortSignal,
  ): Promise<StoredManagementVm> {
    const infrastructure = dependencies.infrastructure;
    if (!infrastructure) throw new ClusterUnavailableError();
    const existing = await installations.getManagementVm(installation.id);
    if (existing?.ip) return existing;
    // The ledger is reconciled before any provider call: an installation that
    // has already released a management VM belongs to the destroy lane and is
    // never given a second one.
    if (
      !existing &&
      (await installations.hasReleasedManagementVm(installation.id))
    ) {
      throw new ClusterDestroyFailedError(installation.name);
    }
    // Durable attempt first: the provider call may succeed after the process
    // dies, and a resume must adopt that exact VM rather than start another.
    const ref = await installations.beginManagementVmAttempt(
      installation.id,
      managementVmCloudId(installation),
    );
    signal?.throwIfAborted();
    const secrets = await installations.getBootstrapSecrets(installation.id);
    const vm = await infrastructure.provisionManagementVm({
      credential,
      target: {
        region: installation.region,
        zone: installation.zone,
        vmType: installation.vmType,
      },
      scope: clusterScope(installation),
      cloudId: ref.cloudId,
      startupScript: managementHostStartupScript({
        sshPublicKey: secrets.sshPublicKey,
        k3sVersion: installation.k3sVersion,
        k3sSha256: installation.k3sSha256,
      }),
      version: dependencies.apiVersion,
    });
    await installations.completeManagementVmAttempt(installation.id, ref, vm);
    const recorded = await installations.getManagementVm(installation.id);
    if (!recorded?.ip)
      throw new Error('Management VM attempt was not recorded');
    return recorded;
  }

  async function stepKubernetes(
    installation: StoredCluster,
    vm: StoredManagementVm,
    signal?: AbortSignal,
  ): Promise<void> {
    await waitForHost(await hostTarget(installation, vm), signal);
    await configureKubernetes(installation, vm, signal);
  }

  /**
   * Stage the K3s server configuration, activate it and wait for the API
   * server and the management Node to be ready, each command bounded by the
   * deadline.
   */
  async function configureKubernetes(
    installation: StoredCluster,
    vm: StoredManagementVm,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = await hostTarget(installation, vm);
    const secrets = await installations.getBootstrapSecrets(installation.id);
    const deadline = dependencies.now() + KUBERNETES_READY_TIMEOUT_MS;
    const config = managementKubernetesConfig({
      serverToken: secrets.serverToken,
      publicIp: vm.ip!,
      issuerUrl: clusterApiUrl(installation.id),
    });
    let configured = false;
    let staged = false;
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      const options = {
        signal,
        timeoutMs: Math.max(1_000, deadline - dependencies.now()),
      };
      if (!configured) {
        // The configuration (with the server token) travels over the stdin
        // channel once; the command that activates it carries no secret. A
        // transport failure while writing (sshd restarting) is polled like a
        // lost exec, and exit 66 (staged file missing) re-stages.
        if (!staged) {
          try {
            await dependencies.host.writeFile(
              target,
              MANAGEMENT_K3S_CONFIG_STAGING_PATH,
              config,
              0o600,
            );
            staged = true;
          } catch (error) {
            dependencies.log.warn(
              'Management configuration write did not reach the host yet',
              {
                id: installation.id,
                error: errorMessage(error),
              },
            );
            await dependencies.sleep(KUBERNETES_READY_POLL_MS, signal);
            continue;
          }
        }
        const result = await dependencies.host.exec(
          target,
          MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND,
          options,
        );
        // Exit 64: the boot-time preparation has not finished yet. A lost
        // connection is the startup script restarting sshd; both are polled.
        if (result.kind === 'exited' && result.code === 0) configured = true;
        else if (result.kind === 'exited' && result.code === 66) staged = false;
        else if (result.kind === 'exited' && result.code !== 64) {
          throw new Error(
            `Management Kubernetes configuration failed (${result.code}): ${result.stderr.trim()}`,
          );
        }
      } else {
        const ready = await dependencies.host.exec(
          target,
          MANAGEMENT_KUBERNETES_READY_COMMAND,
          options,
        );
        if (
          ready.kind === 'exited' &&
          ready.code === 0 &&
          ready.stdout.trim() === 'True'
        ) {
          return;
        }
      }
      await dependencies.sleep(KUBERNETES_READY_POLL_MS, signal);
    }
    throw new Error('Management Kubernetes did not become ready in time');
  }

  /**
   * Wait for sshd on the new host: a TCP probe first (free for a booting VM),
   * then one authenticated command, with bounded backoff until the deadline.
   */
  async function waitForHost(
    target: ManagementHostTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = dependencies.now() + SSH_READY_TIMEOUT_MS;
    let backoff = SSH_READY_INITIAL_BACKOFF_MS;
    let lastFailure = 'not probed';
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      if (await dependencies.host.reachable(target)) {
        const probe = await dependencies.host.exec(target, 'echo ready', {
          signal,
          timeoutMs: SSH_PROBE_TIMEOUT_MS,
        });
        if (probe.kind === 'exited' && probe.code === 0) return;
        lastFailure =
          probe.kind === 'exited'
            ? `command exited with ${probe.code}`
            : probe.error;
      } else {
        lastFailure = 'SSH port not reachable';
      }
      await dependencies.sleep(backoff, signal);
      backoff = Math.min(backoff * 2, SSH_READY_MAX_BACKOFF_MS);
    }
    throw new Error(
      `Management host SSH did not become ready in time: ${lastFailure}`,
    );
  }

  async function stepKubeconfig(
    installation: StoredCluster,
    vm: StoredManagementVm,
    signal?: AbortSignal,
  ): Promise<ClusterConnectionDocument> {
    const target = await hostTarget(installation, vm);
    const result = await dependencies.host.exec(
      target,
      INSTALLER_ACCESS_READ_COMMAND,
      { signal },
    );
    if (result.kind === 'unreachable') {
      throw new Error(
        `Reading installer access material failed: ${result.error}`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `Reading installer access material failed (${result.code}): ${result.stderr.trim()}`,
      );
    }
    const connection = installerConnectionDocument({
      publicIp: vm.ip!,
      material: parseInstallerAccessMaterial(result.stdout),
    });
    const identity = await dependencies.observeKubernetesIdentity(
      connection,
      signal,
    );
    if (
      installation.kubernetesIdentity &&
      installation.kubernetesIdentity !== identity
    ) {
      throw new Error(
        `Cluster reports Kubernetes identity ${identity}, but this installation recorded ${installation.kubernetesIdentity}`,
      );
    }
    await installations.recordKubernetesIdentity(installation.id, identity);
    return connection;
  }

  /** Bind the observed identity and the installer connection to the one record. */
  async function bindConnection(
    installation: StoredCluster,
    connection: ClusterConnectionDocument,
  ): Promise<void> {
    if (installation.connectionId) return;
    if (!installation.kubernetesIdentity) {
      throw new Error('Kubernetes identity was not observed before binding');
    }
    const result = await dependencies.clusterRecords.storeConnection({
      clusterId: installation.id,
      kubernetesIdentity: installation.kubernetesIdentity,
      kind: 'installer',
      connection: serializeClusterConnection(connection),
    });
    if (result !== 'stored') {
      throw new Error(`Cluster connection could not be stored: ${result}`);
    }
  }

  /**
   * The hosted API's checkpoint bucket with the installation's compute
   * credential. The material travels in the release values (a chart Secret
   * on the cluster), the way the VM-hosted API's checkpoint credential lived in
   * its container. Null for installations recorded before backups.
   */
  async function backupValues(
    installation: StoredCluster,
  ): Promise<SystemReleaseBackupValues | null> {
    if (!installation.checkpointBucket) return null;
    const credential = await dependencies.storageCredential(
      installation.computeCredentialId,
    );
    const bucket = await dependencies.checkpointBucket(
      credential,
      installation.checkpointBucket.name,
      installation.region,
    );
    return {
      bucket: installation.checkpointBucket.name,
      region: bucket.region,
      cloudProvider: credential.cloudProvider,
      credentials: credential.credentials,
    };
  }

  /** A managed bucket is Anycloud's: created before the release names it, deleted with the installation. */
  async function ensureManagedCheckpointBucket(
    installation: StoredCluster,
    credential: NamedCredential,
  ): Promise<void> {
    if (!installation.checkpointBucket?.managed) return;
    await dependencies.infrastructure!.ensureCheckpointBucket({
      credential,
      region: installation.region,
      bucket: installation.checkpointBucket.name,
      installationId: installation.id,
      ownerUserId: installation.ownerUserId,
    });
  }

  /** What the hosted API records about the cluster it runs in (chart values). */
  async function clusterValues(
    installation: StoredCluster,
    vm: StoredManagementVm,
  ): Promise<SystemReleaseClusterValues> {
    const connection = await connectionFor(installation);
    if (!installation.kubernetesIdentity) {
      throw new Error(
        'Kubernetes identity was not observed before the release',
      );
    }
    return {
      name: installation.name,
      kubernetesIdentity: installation.kubernetesIdentity,
      joinEndpoint: connection.server,
      certificateAuthorityData: connection.certificateAuthorityData,
      record: {
        cloudProvider: installation.cloudProvider,
        cloudAccount: await dependencies.cloudAccount(
          (
            await dependencies.storageCredential(
              installation.computeCredentialId,
            )
          ).credentials,
        ),
        region: installation.region,
        zone: installation.zone,
        vmType: installation.vmType,
        managementVmId: vm.cloudId,
        networkScope: clusterScope(installation).id,
        k3s: {
          version: installation.k3sVersion,
          sha256: installation.k3sSha256,
        },
        checkpointBucket: installation.checkpointBucket,
      },
    };
  }

  /** The chart the pinned API image names; it must be the recorded one. */
  async function recordedChart(
    apiImage: string,
    chartSha256: string,
  ): Promise<string> {
    const { chart } = await dependencies.resolveApiImage(apiImage);
    if (chartDigest(chart) !== chartSha256) {
      throw new Error(
        `API image ${apiImage} names chart ${chart}, not the recorded sha256:${chartSha256}`,
      );
    }
    return chart;
  }

  async function stepReleaseIntent(
    owner: GithubOwner,
    installation: StoredCluster,
    vm: StoredManagementVm,
  ): Promise<StoredClusterRelease> {
    const current = await installations.currentReleaseIntent(installation.id);
    if (current) return current;
    const chart = await recordedChart(
      installation.apiImage,
      installation.chartSha256,
    );
    const operationId = dependencies.generateOperationId();
    const values = systemReleaseValues({
      installationId: installation.id,
      cluster: await clusterValues(installation, vm),
      revision: 1,
      operationId,
      apiImage: installation.apiImage,
      apiVersion: installation.apiVersion,
      ownerUsername: owner.username,
      ownerUserId: owner.id,
      apiUrl: clusterApiUrl(installation.id),
      chart,
      helmJobImage: installation.helmJobImage,
      backup: await backupValues(installation),
      restoreFromBackup: installation.restoreFromBackup,
    });
    await installations.seedReleaseIntent({
      installationId: installation.id,
      revision: 1,
      operationId,
      apiVersion: installation.apiVersion,
      apiImage: installation.apiImage,
      chartVersion: installation.chartVersion,
      chartSha256: installation.chartSha256,
      valuesSha256: valuesSha256(values),
    });
    const seeded = await installations.currentReleaseIntent(installation.id);
    if (!seeded) throw new Error('Release intent was not recorded');
    return seeded;
  }

  async function waitForIngressCrd(
    connection: ClusterConnectionDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = dependencies.now() + INGRESS_CRD_TIMEOUT_MS;
    let observed = 'absent';
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      const crd = await dependencies.releases.readCustomResourceDefinition(
        connection,
        API_INGRESS_CRD,
      );
      if (crd?.established) return;
      observed = crd ? 'present but not Established' : 'absent';
      await dependencies.sleep(INGRESS_CRD_POLL_MS, signal);
    }
    throw new Error(
      `Traefik did not publish the ${API_INGRESS_CRD} CustomResourceDefinition within ${INGRESS_CRD_TIMEOUT_MS / 60_000} minutes (${observed}); the ${API_INGRESS_RELEASE} HelmChart in kube-system has not installed, so the API chart's IngressRoute cannot be applied`,
    );
  }

  /**
   * Full (strict) only once the VM's 443 serves the issued certificate:
   * Cloudflare would otherwise answer 526 for the API.
   */
  async function activateApiTls(
    installation: StoredCluster,
    vm: StoredManagementVm,
    certificate: string,
    owner: GithubOwner,
    signal?: AbortSignal,
  ): Promise<void> {
    // The probe runs on the VM, so it cannot see the cloud firewall: open 443
    // to Cloudflare first, which a resumed or restored installation's VM may
    // lack.
    const infrastructure = dependencies.infrastructure;
    if (!infrastructure) throw new ClusterUnavailableError();
    await infrastructure.ensureManagementIngress({
      credential: await recordedCredential(installation),
      target: {
        region: installation.region,
        zone: installation.zone,
        vmType: installation.vmType,
      },
      scope: clusterScope(installation),
    });
    const target = await hostTarget(installation, vm);
    const command = apiTlsProbeCommand(clusterHostname(installation.id));
    const deadline = dependencies.now() + API_TLS_PROBE_TIMEOUT_MS;
    let observed = 'nothing';
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      const probe = await dependencies.host.exec(target, command, { signal });
      if (probe.kind === 'exited' && samePem(probe.stdout, certificate)) {
        await dependencies.dns.activateTls(installation.id, owner.token);
        return;
      }
      observed =
        probe.kind === 'unreachable'
          ? `SSH unreachable (${probe.error})`
          : probe.stdout.trim()
            ? 'another certificate'
            : 'no certificate';
      await dependencies.sleep(API_TLS_PROBE_POLL_MS, signal);
    }
    throw new Error(
      `Traefik did not serve the API's origin certificate on port 443 within ${API_TLS_PROBE_TIMEOUT_MS / 60_000} minutes (it served ${observed})`,
    );
  }

  /**
   * This machine's first lookup of a fresh hostname must not land before
   * Cloudflare's nameservers serve it: its resolver would cache the NXDOMAIN
   * for the zone's 1800 s negative TTL and, given the AAAA records alone,
   * every fetch on an IPv4-only network fails.
   */
  async function waitForPublicRecord(
    hostname: string,
    publishedAt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await dependencies.sleep(
      Math.max(
        0,
        publishedAt + PUBLIC_RECORD_FIRST_QUERY_MS - dependencies.now(),
      ),
      signal,
    );
    const deadline = publishedAt + PUBLIC_RECORD_TIMEOUT_MS;
    let failures = 0;
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      try {
        if (await dependencies.dns.publicARecordExists(hostname, signal))
          return;
        failures = 0;
      } catch (error) {
        signal?.throwIfAborted();
        if (++failures === PUBLIC_RESOLVER_ATTEMPTS) {
          throw new Error(
            `1.1.1.1 didn't answer the DNS over HTTPS query for ${hostname} (${errorMessage(error)}); this network may block it`,
          );
        }
      }
      await dependencies.sleep(PUBLIC_RECORD_POLL_MS, signal);
    }
    throw new Error(
      `${hostname} did not resolve at 1.1.1.1 within ${PUBLIC_RECORD_TIMEOUT_MS / 60_000} minutes of its DNS record being published`,
    );
  }

  async function stepRelease(
    owner: GithubOwner,
    installation: StoredCluster,
    vm: StoredManagementVm,
    intent: StoredClusterRelease,
    signal?: AbortSignal,
  ): Promise<void> {
    const connection = await connectionFor(installation);
    const chart = await recordedChart(intent.apiImage, intent.chartSha256);
    const desired = buildSystemReleaseHelmChart({
      installationId: installation.id,
      cluster: await clusterValues(installation, vm),
      revision: intent.revision,
      operationId: intent.operationId,
      apiImage: intent.apiImage,
      apiVersion: intent.apiVersion,
      ownerUsername: owner.username,
      ownerUserId: owner.id,
      apiUrl: clusterApiUrl(installation.id),
      chart,
      helmJobImage: installation.helmJobImage,
      backup: await backupValues(installation),
      restoreFromBackup: installation.restoreFromBackup,
    });
    // A fresh cluster has no release namespace, and the HelmChart object itself
    // lives there (the controller's createNamespace covers only the release's
    // target). Idempotent, so a resumed pass is fine.
    await dependencies.releases.ensureNamespace(
      connection,
      SYSTEM_RELEASE_NAMESPACE,
    );
    // The API's ingress: its own Traefik release on the management Node (K3s's
    // packaged one is disabled — its non-bootstrap Job never schedules onto
    // the tainted Node), and the hostname record pointing at the VM's stable
    // public address. Both are idempotent, so a resumed pass re-applies them.
    // Published with the actor's token, as a VM-hosted API's record is. A
    // create resumed past the ready step labels the Node here.
    const label = await dependencies.host.exec(
      await hostTarget(installation, vm),
      MANAGEMENT_LABEL_COMMAND,
      { signal },
    );
    if (label.kind === 'unreachable' || label.code !== 0) {
      throw new Error(
        `Labelling the management Node failed: ${label.kind === 'unreachable' ? label.error : `(${label.code}) ${label.stderr.trim()}`}`,
      );
    }
    await dependencies.releases.applyObject(connection, apiIngressHelmChart());
    // The API chart renders an IngressRoute. helm-controller installs Traefik
    // and the API chart concurrently; when the API Job runs before Traefik's
    // CRDs exist, Helm fails with "no matches for kind IngressRoute" and the
    // Job exhausts its backoff before the controller's own retry can help
    // (F run 12). Wait for the CRD here, before the HelmChart is applied.
    await waitForIngressCrd(connection, signal);
    // The Worker takes the bare subdomain (the id); it owns the zone.
    await dependencies.dns.publish(installation.id, vm.ip!, owner.token);
    const publishedAt = dependencies.now();
    // Each pass issues a fresh key and certificate (the Worker revokes the
    // previous ones), so a restore or resume never serves a stale key.
    const { key, csr } = apiTlsKeyAndCsr(clusterHostname(installation.id));
    const issued = await dependencies.dns.issueCertificate(
      installation.id,
      csr,
      owner.token,
    );
    const tls = apiTlsObjects({ key, ...issued });
    for (const object of tls.apply) {
      await dependencies.releases.applyObject(connection, object);
    }
    for (const object of tls.remove) {
      await dependencies.releases.deleteObject(connection, object);
    }
    signal?.throwIfAborted();
    // The comparison and the write are bound to one observation: the patch
    // carries the observed resourceVersion as a precondition, and a conflict
    // re-observes and re-compares rather than overwriting a newer release.
    for (let attempt = 1; ; attempt += 1) {
      const observed = await dependencies.releases.getHelmChart(
        connection,
        SYSTEM_RELEASE_HELM_CHART_NAME,
        SYSTEM_RELEASE_NAMESPACE,
      );
      const comparison = compareReleaseIntent(observed, desired);
      if (comparison.action === 'refuse') {
        throw new ClusterReleaseRefusedError(comparison.reason);
      }
      if (comparison.action === 'current') break;
      try {
        await dependencies.releases.applyHelmChart(
          connection,
          desired,
          observed?.metadata.resourceVersion ?? null,
        );
      } catch (error) {
        if (
          error instanceof ClusterReleaseConflictError &&
          attempt < RELEASE_APPLY_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
      await installations.setReleaseIntentState(
        installation.id,
        intent.revision,
        ClusterReleaseState.Applied,
      );
      break;
    }
    // Nothing above resolves the hostname; the readiness loop is its first
    // lookup on this machine.
    await waitForPublicRecord(
      clusterHostname(installation.id),
      publishedAt,
      signal,
    );
    const deadline = dependencies.now() + RELEASE_READY_TIMEOUT_MS;
    let lastReason = 'not observed';
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      const readiness = await dependencies.releases.observeRelease(connection, {
        revision: intent.revision,
        operationId: intent.operationId,
        image: intent.apiImage,
        version: intent.apiVersion,
        namespace: SYSTEM_RELEASE_NAMESPACE,
        apiUrl: clusterApiUrl(installation.id),
      });
      if (readiness.ready) {
        await installations.setReleaseIntentState(
          installation.id,
          intent.revision,
          ClusterReleaseState.Completed,
        );
        await activateApiTls(
          installation,
          vm,
          issued.certificate,
          owner,
          signal,
        );
        return;
      }
      lastReason = readiness.reason;
      await dependencies.sleep(RELEASE_READY_POLL_MS, signal);
    }
    await installations.setReleaseIntentState(
      installation.id,
      intent.revision,
      ClusterReleaseState.Failed,
    );
    // The readiness verdict names no cause; ask the cluster what it sees so
    // `lastError` (and the CLI's progress output) carry it.
    const state = await dependencies.releases
      .describeRelease(connection, SYSTEM_RELEASE_NAMESPACE)
      .catch((error: unknown) => `unavailable: ${errorMessage(error)}`);
    throw new Error(
      `API system release did not reach its requested target: ${lastReason}. Cluster reports: ${state}`,
    );
  }

  /**
   * Run every step after the last completed one. Each step re-reads durable
   * state, so a crash between a mutation and its record is reconciled by
   * adoption rather than repetition.
   */
  async function runBootstrap(
    owner: GithubOwner,
    installationId: string,
    scope: OwnershipScope,
    signal?: AbortSignal,
  ): Promise<void> {
    const load = async () => {
      const current = await installations.getForScope(installationId, scope);
      if (!current) throw new Error(`Installation ${installationId} vanished`);
      return current;
    };
    let installation = await load();
    try {
      // A restore that replaced a held record first releases the lost
      // cluster's management VM; its row survives until that is confirmed.
      const lost = await installations.getManagementVm(installation.id);
      if (lost?.removalRequestedAt != null) {
        await releaseManagementVmOf(installation, lost, signal);
        await installations.dropReleasedManagementVm(installation.id, lost.id);
      }
      const credential = await recordedCredential(installation);
      const vm = await stepManagementVm(installation, credential, signal);
      if (!stepCompleted(installation, ClusterStep.ManagementVm)) {
        await installations.completeStep(
          installation.id,
          ClusterStep.ManagementVm,
        );
        installation = await load();
      }
      if (!stepCompleted(installation, ClusterStep.Kubernetes)) {
        await stepKubernetes(installation, vm, signal);
        await installations.completeStep(
          installation.id,
          ClusterStep.Kubernetes,
        );
        installation = await load();
      }
      if (!stepCompleted(installation, ClusterStep.Connection)) {
        // The connection is regenerated on every pass rather than stored
        // before the identity is bound, so the Kubeconfig step is only
        // durable once the record holds it.
        const connection = await stepKubeconfig(installation, vm, signal);
        installation = await load();
        await installations.completeStep(
          installation.id,
          ClusterStep.Kubeconfig,
        );
        installation = await load();
        await bindConnection(installation, connection);
        await installations.completeStep(
          installation.id,
          ClusterStep.Connection,
        );
        installation = await load();
      }
      await ensureManagedCheckpointBucket(installation, credential);
      const intent = await stepReleaseIntent(owner, installation, vm);
      if (!stepCompleted(installation, ClusterStep.ReleaseIntent)) {
        await installations.completeStep(
          installation.id,
          ClusterStep.ReleaseIntent,
        );
        installation = await load();
      }
      if (!stepCompleted(installation, ClusterStep.Release)) {
        await stepRelease(owner, installation, vm, intent, signal);
        await installations.completeStep(installation.id, ClusterStep.Release);
      }
      await installations.setState(installation.id, ClusterState.Ready);
      dependencies.log.info('cluster is ready', {
        id: installation.id,
      });
    } catch (error) {
      const message = errorMessage(error);
      await installations.setState(
        installation.id,
        ClusterState.Failed,
        message,
      );
      dependencies.log.warn('cluster bootstrap failed', {
        id: installation.id,
        step: installation.step,
        error: message,
      });
    }
  }

  /**
   * A supplied bucket must exist; one holding a backup makes create a restore
   * (the new API starts from that database under the backup's installation
   * id, its URL and identity stamp), which this CLI's API must be able to open.
   */
  async function restoreSource(
    input: CreateClusterRequest & { checkpointBucket: string },
    credentialId: string,
  ): Promise<ApiBackupManifest | null> {
    const storage = await dependencies.storageCredential(credentialId);
    // Restoring from it would clone this API, and the new API's backups would
    // overwrite this one's.
    if (isApiBackupBucket(input.checkpointBucket, storage.cloudProvider)) {
      throw new ClusterInvalidError(
        `Checkpoint bucket "${input.checkpointBucket}" is this API's own backup bucket; use another bucket`,
      );
    }
    const bucket = await dependencies.checkpointBucket(
      storage,
      input.checkpointBucket,
      input.region,
    );
    if (!bucket.exists) {
      throw new ClusterInvalidError(
        `Checkpoint bucket "${input.checkpointBucket}" was not found under credential "${input.credentialName}"`,
      );
    }
    const found = await dependencies.backupManifest(
      storage,
      input.checkpointBucket,
      bucket.region,
    );
    if (found === 'unrestorable') {
      throw new ClusterInvalidError(
        `Checkpoint bucket "${input.checkpointBucket}" holds a database with no restorable backup; use another bucket`,
      );
    }
    const backup = found;
    if (backup?.schemaAppVersion && !semver.valid(backup.schemaAppVersion)) {
      throw new ClusterInvalidError(
        `The backup in "${input.checkpointBucket}" records an invalid schema version "${backup.schemaAppVersion}"`,
      );
    }
    if (
      backup?.schemaAppVersion &&
      semver.gt(backup.schemaAppVersion, dependencies.apiVersion)
    ) {
      throw new ClusterInvalidError(
        `The backup in "${input.checkpointBucket}" was written by anycloud API ${backup.schemaAppVersion}; this CLI deploys ${dependencies.apiVersion}. Run anycloud update and retry`,
      );
    }
    return backup;
  }

  /**
   * Release a recorded management VM, retrying until the cloud confirms it;
   * the caller then ends or drops its ledger row.
   */
  async function releaseManagementVmOf(
    installation: StoredCluster,
    vm: StoredManagementVm,
    signal?: AbortSignal,
  ): Promise<void> {
    const infrastructure = dependencies.infrastructure;
    if (!infrastructure) throw new ClusterUnavailableError();
    const credential = await recordedCredential(installation);
    const deadline = dependencies.now() + VM_RELEASE_TIMEOUT_MS;
    let released = false;
    while (dependencies.now() < deadline) {
      signal?.throwIfAborted();
      released = await infrastructure.releaseManagementVm({
        credential,
        identity: managementVmIdentity(installation, vm),
        scope: clusterScope(installation),
      });
      if (released) break;
      await dependencies.sleep(VM_RELEASE_POLL_MS, signal);
    }
    if (!released) {
      throw new Error('Management VM release was not confirmed in time');
    }
  }

  /**
   * Only the lost cluster's record is replaced by a restore: a destroyed
   * one, or a ready or failed one whose management VM is gone. This
   * restore's own record, recorded after the backup it restores, is resumed
   * like any create. One still being created or destroyed is refused.
   */
  async function replaceableForRestore(
    installation: StoredCluster,
    backup: ApiBackupManifest,
    name: string,
  ): Promise<boolean> {
    if (
      installation.state !== ClusterState.Destroyed &&
      installation.restoreFromBackup &&
      installation.createdAt >= Date.parse(backup.backedUpAt)
    )
      return false;
    switch (installation.state) {
      case ClusterState.Destroyed:
        return true;
      case ClusterState.Ready:
      case ClusterState.Failed:
      case ClusterState.DestroyFailed:
        return requireManagementVmGone(installation, name);
      case ClusterState.Bootstrapping:
      case ClusterState.Destroying:
        throw new ClusterBusyError(installation.state);
    }
  }

  /**
   * One provider read of the recorded management VM; null when it is gone
   * (no live row, or the cloud shows it released), else why it may be alive.
   */
  async function liveManagementVm(
    installation: StoredCluster,
  ): Promise<{ cloudId: string; error: string | null } | null> {
    const vm = await installations.getManagementVm(installation.id);
    if (!vm) return null;
    const infrastructure = dependencies.infrastructure;
    if (!infrastructure) throw new ClusterUnavailableError();
    const observed = await infrastructure
      .observeManagementVm({
        credential: await recordedCredential(installation),
        identity: managementVmIdentity(installation, vm),
      })
      .catch((error: unknown) => ({
        state: VMReleaseState.Unknown,
        error: errorMessage(error),
      }));
    if (observed.state === VMReleaseState.Candidate) return null;
    return {
      cloudId: vm.cloudId,
      error: observed.state === VMReleaseState.Present ? null : observed.error,
    };
  }

  /**
   * Proof the held cluster is dead: its recorded management VM is gone. A
   * live VM under the requested name is a replay of that cluster's create
   * (false: resume it instead); under another name it is refused.
   */
  async function requireManagementVmGone(
    installation: StoredCluster,
    name: string,
  ): Promise<boolean> {
    const live = await liveManagementVm(installation);
    if (!live) return true;
    if (live.error === null && installation.name === name) return false;
    throw new ClusterExistsError(
      live.error === null
        ? `Management VM ${live.cloudId} of cluster "${installation.name}" still exists. If the cluster is healthy, nothing needs restoring: use it as is. Terminate that VM only if it is truly broken, then retry the restore`
        : `Could not check management VM ${live.cloudId} of cluster "${installation.name}" (${live.error}); retry the restore once it can be read`,
    );
  }

  /** What stays in the cloud account once the installer forgets a cluster. */
  function leftoverResources(installation: StoredCluster): string[] {
    const bucket = installation.checkpointBucket;
    // A destroyed cluster's network went with its VM; a delete without
    // --delete-buckets kept its managed bucket, and the record names it.
    const destroyed = installation.state === ClusterState.Destroyed;
    return [
      ...(destroyed
        ? []
        : [
            `the management VM's network resources named ${clusterScope(installation).id} (its security group, firewall or network)`,
          ]),
      `node pool VMs, networks and disks tagged ${OWNER_API_TAG}=${hostedApiIdentity(installation.id)}`,
      ...(bucket?.managed
        ? [
            `checkpoint bucket ${bucket.name}, kept on purpose with its backups; delete it only if you no longer need them`,
          ]
        : []),
    ];
  }

  /** Destroy without the hosted API: restore it first when the bucket can. */
  async function unreachableGuidance(
    installation: StoredCluster,
    apiUrl: string,
    reason: string,
  ): Promise<string> {
    const { name } = installation;
    const bucket = installation.checkpointBucket?.name;
    const backup = bucket
      ? await dependencies
          .backupManifest(
            await dependencies.storageCredential(
              installation.computeCredentialId,
            ),
            bucket,
            installation.region,
          )
          .catch((error: unknown) => errorMessage(error))
      : null;
    const vm = await installations.getManagementVm(installation.id);
    if (backup !== null && typeof backup === 'object') {
      const zone = installation.zone ? ` --zone ${installation.zone}` : '';
      const terminate = vm
        ? ` (if its management VM ${vm.cloudId} still runs but the cluster is broken, terminate that VM first)`
        : '';
      return `The hosted API at ${apiUrl} is unreachable (${reason}). Restore it with anycloud cluster create ${name} --cloud ${(backup.cloud ?? installation.cloudProvider).toLowerCase()} --region ${backup.region ?? installation.region}${zone} --vm-type ${backup.vmType ?? installation.vmType} --checkpoint-bucket ${bucket}${terminate}, then run anycloud cluster delete ${name}.`;
    }
    const why =
      backup === 'unrestorable' || (bucket && backup === null)
        ? 'its bucket holds no restorable backup'
        : backup
          ? `its backup could not be read (${backup})`
          : 'it has no checkpoint bucket';
    const vms = [
      ...(vm ? [`management VM ${vm.cloudId}`] : []),
      `node pool VMs tagged ${OWNER_API_TAG}=${hostedApiIdentity(installation.id)}`,
    ];
    return `The hosted API at ${apiUrl} is unreachable (${reason}) and ${why}. Terminate ${vms.join(' and ')}, then run anycloud cluster forget ${name}; it names what else is left.`;
  }

  /** A destroyed record's kept managed bucket, under the installation's claim. */
  async function deleteKeptBucket(installation: StoredCluster): Promise<void> {
    const bucket = installation.checkpointBucket!;
    const holder = active.get(installation.id);
    if (holder) throw new ClusterBusyError(holder);
    active.set(installation.id, ClusterState.Destroying);
    try {
      await dependencies.infrastructure!.deleteCheckpointBucket({
        credential: await recordedCredential(installation),
        region: installation.region,
        bucket: bucket.name,
      });
      await installations.clearCheckpointBucket(installation.id);
    } finally {
      active.delete(installation.id);
    }
  }

  /**
   * The management VM, then the DNS record; the managed checkpoint bucket
   * only with `deleteBuckets` (RFC 0049 C28), last, so a failure before it
   * leaves the restore point.
   */
  async function runDestroy(
    owner: GithubOwner,
    installation: StoredCluster,
    scope: OwnershipScope,
    deleteBuckets: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const infrastructure = dependencies.infrastructure;
      if (!infrastructure) throw new ClusterUnavailableError();
      const vm = await installations.getManagementVm(installation.id);
      if (vm) {
        await releaseManagementVmOf(installation, vm, signal);
        await installations.endManagementVm(installation.id, vm.id);
      }
      await dependencies.dns.removeTls(installation.id, owner.token);
      await dependencies.dns.remove(installation.id, owner.token);
      if (deleteBuckets && installation.checkpointBucket?.managed) {
        await infrastructure.deleteCheckpointBucket({
          credential: await recordedCredential(installation),
          region: installation.region,
          bucket: installation.checkpointBucket.name,
        });
        await installations.clearCheckpointBucket(installation.id);
      }
      await installations.setState(installation.id, ClusterState.Destroyed);
    } catch (error) {
      const message = errorMessage(error);
      // Stays in the destroy lane: only another destroy may resume it, from
      // whatever the ledger still records.
      await installations.setState(
        installation.id,
        ClusterState.DestroyFailed,
        message,
      );
      dependencies.log.warn('cluster destruction failed', {
        id: installation.id,
        error: message,
      });
    }
  }

  return {
    async create(actor, input, signal) {
      signal?.throwIfAborted();
      if (!dependencies.infrastructure) {
        throw new ClusterUnavailableError();
      }
      const owner = await githubOwner(actor, CLUSTERS_NEED, signal);
      const scope = await dependencies.resolveScope(actor);
      const credential = await dependencies.credentials.getNamedCredential(
        input.credentialName,
      );
      if (!credential) {
        throw new ClusterInvalidError(
          `Credential "${input.credentialName}" not found`,
        );
      }
      if (!isComputeProvider(credential.cloudProvider)) {
        throw new ClusterInvalidError(
          storageOnlyComputeMessage(credential.cloudProvider),
        );
      }

      const backup = input.checkpointBucket
        ? await restoreSource(
            { ...input, checkpointBucket: input.checkpointBucket },
            credential.id,
          )
        : null;
      // Restoring over a record this installer still holds (its management
      // VM was lost): the restore replaces that record under the same id.
      const held = backup
        ? await installations.getForScope(backup.clusterId, scope)
        : null;
      const replacing =
        backup &&
        held &&
        (await replaceableForRestore(held, backup, input.name))
          ? held
          : null;
      const existing = replacing
        ? null
        : await installations.getByNameForScope(input.name, scope);
      if (existing) {
        // A resume continues the recorded intent; a request for a different
        // credential or target is a new installation and is refused while
        // this one exists.
        if (existing.computeCredentialId !== credential.id) {
          throw new ClusterExistsError(
            `Cluster "${existing.name}" exists with different credentials; delete it (anycloud cluster delete ${existing.name}) before creating it again`,
          );
        }
        if (
          existing.region !== input.region ||
          existing.zone !== (input.zone ?? null) ||
          existing.vmType !== input.vmType
        ) {
          throw new ClusterExistsError(
            `Cluster "${existing.name}" exists in ${existing.region}${existing.zone ? `/${existing.zone}` : ''} on ${existing.vmType}; run anycloud cluster create again with that region, zone and VM type, or delete it first`,
          );
        }
        // A replayed request re-returns a ready installation or one whose
        // creation is running here; a failed one, or one left `bootstrapping`
        // by an API restart, is resumed. Anything in the destroy lane stays
        // there, including one a delete running here has claimed.
        const holder = active.get(existing.id);
        if (holder === ClusterState.Destroying) {
          throw new ClusterBusyError(holder);
        }
        if (
          existing.state === ClusterState.Ready ||
          (existing.state === ClusterState.Bootstrapping && holder)
        ) {
          return summary(existing);
        }
        if (existing.state === ClusterState.DestroyFailed) {
          throw new ClusterDestroyFailedError(existing.name);
        }
        if (existing.state === ClusterState.Destroying) {
          await start(
            existing.id,
            ClusterState.Destroying,
            async () => existing,
            (row) => runDestroy(owner, row, scope, false),
          );
          throw new ClusterBusyError(existing.state);
        }
        const resumed = await start(
          existing.id,
          ClusterState.Bootstrapping,
          async () => {
            await installations.setState(
              existing.id,
              ClusterState.Bootstrapping,
            );
            return (await installations.getForScope(existing.id, scope))!;
          },
          (row) => runBootstrap(owner, row.id, scope),
        );
        return summary(resumed);
      }
      const others = (await installations.listForScope(scope)).filter(
        (other) => other.id !== replacing?.id,
      );
      if (others.length > 0) {
        throw new ClusterExistsError(
          `Cluster "${others[0].name}" already exists; one cluster per API`,
        );
      }

      // Everything below is recorded before any cloud mutation: exact target,
      // pinned toolchain, digest-pinned image, chart identity, the checkpoint
      // bucket (a user-supplied one must exist under the compute credential;
      // its versioning is checked by the hosted API when it starts its backup
      // timer) and the secrets the host will be configured with.
      const target = await dependencies.validateTarget(input, credential);
      signal?.throwIfAborted();
      // A restore that records or replaces the cluster asks the cloud for its
      // management VMs by the cluster's tag. A held record's own VM is already
      // confirmed gone, so any VM found is the lost cluster's or another
      // installer's restore: two APIs must never write the same bucket.
      if (backup && (!held || replacing)) {
        const infrastructure = dependencies.infrastructure;
        if (!infrastructure) throw new ClusterUnavailableError();
        const live = await infrastructure
          .findManagementVms({
            credential,
            target,
            scope: clusterScope({ id: backup.clusterId }),
          })
          .catch((error: unknown) => {
            throw new ClusterExistsError(
              `Could not check for the management VM of cluster ${backup.clusterId} (${errorMessage(error)}); retry the restore once it can be read`,
            );
          });
        if (live.length > 0) {
          throw new ClusterExistsError(
            `Management VM ${live.join(', ')} of cluster ${backup.clusterId} still exists. If the cluster is healthy, nothing needs restoring: use it as is. Terminate that VM only if it is truly broken, then retry the restore`,
          );
        }
      }
      signal?.throwIfAborted();
      const { digest, chart } = await dependencies.resolveApiImage(
        apiImageTagReference(dependencies.apiVersion),
      );
      signal?.throwIfAborted();
      const keys = await dependencies.generateSshKeypair();
      const id = backup?.clusterId ?? dependencies.generateId(input.name);
      const recordInput = {
        id,
        ownerUserId: owner.id,
        name: input.name,
        computeCredentialId: credential.id,
        region: target.region,
        zone: target.zone,
        vmType: target.vmType,
        k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
        k3sSha256: SYSTEM_RELEASE_K3S_SHA256,
        helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
        apiVersion: dependencies.apiVersion,
        apiImage: pinnedApiImage(dependencies.apiVersion, digest),
        // Published with the image, at its version.
        chartVersion: dependencies.apiVersion,
        chartSha256: chartDigest(chart),
        // The VM-hosted API's rule: a supplied bucket is retained and never
        // deleted; otherwise Anycloud manages one named after the installation.
        // A restore from a kept managed bucket (named for the backup's
        // cluster, which the restore reuses) keeps it managed.
        checkpointBucket: input.checkpointBucket
          ? {
              name: input.checkpointBucket,
              managed: input.checkpointBucket === backup?.clusterId,
            }
          : { name: id, managed: true },
        restoreFromBackup: backup !== null,
        serverToken: dependencies.generateServerToken(),
        sshPublicKey: keys.publicKey,
        sshPrivateKey: keys.privateKey,
      };
      const result = replacing
        ? await installations.replaceForRestore(recordInput)
        : await installations.record(recordInput);
      if (result === 'installation-exists') {
        throw new ClusterExistsError('A cluster already exists');
      }
      const recorded = await installations.getForScope(id, scope);
      if (!recorded) throw new Error(`Installation ${id} is missing`);
      await start(
        recorded.id,
        ClusterState.Bootstrapping,
        async () => recorded,
        (row) => runBootstrap(owner, row.id, scope),
      );
      return summary(recorded);
    },

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

    async destroy(actor, identifier, { deleteBuckets }, signal) {
      signal?.throwIfAborted();
      if (!dependencies.infrastructure) {
        throw new ClusterUnavailableError();
      }
      const owner = await githubOwner(actor, CLUSTERS_NEED, signal);
      const scope = await dependencies.resolveScope(actor);
      const installation = await resolveForScope(identifier, scope);
      if (!installation) {
        throw new ClusterNotFoundError(identifier);
      }
      const deletesBucket =
        deleteBuckets && installation.checkpointBucket?.managed === true;
      const vm = await installations.getManagementVm(installation.id);
      // A destroyed record still naming its kept managed bucket: with
      // --delete-buckets only that bucket goes, here, since a destroyed
      // record never changes state again (RFC 0049 C28).
      if (installation.state === ClusterState.Destroyed) {
        if (deletesBucket) await deleteKeptBucket(installation);
        return {
          ...(await summary(
            (await installations.getForScope(installation.id, scope))!,
          )),
          ...deleteReport(installation, {
            managementVm: null,
            dnsRecord: false,
            bucketDeleted: deletesBucket,
            backup: deletesBucket
              ? null
              : await takeFinalBackup(dependencies, installation, owner, false),
          }),
        };
      }
      const taken: { backup?: FinalBackup } = {};
      // A task running in this process owns the installation, and the claim
      // refuses delete. Without one, an API restart interrupted it: destroy
      // resumes an interrupted destruction and takes over an interrupted
      // creation.
      const destroying = await start(
        installation.id,
        ClusterState.Destroying,
        async () => {
          if (installation.state === ClusterState.Destroying) {
            return installation;
          }
          // Node pools live in the hosted API. Referenced pools are never
          // destroyed from here: the operator removes their Deployments and
          // Services, then the pools. An unreachable hosted API is restored first
          // (or, with no restorable backup, cleaned up by hand and forgotten). An
          // installation whose release never completed, or whose management VM
          // a failed delete already released, has no hosted API to ask:
          // destroy proceeds directly.
          const hostedApiRuns =
            stepCompleted(installation, ClusterStep.Release) && vm !== null;
          const inventory: HostedNodePoolInventory = hostedApiRuns
            ? await dependencies.hostedPools.inventory(installation, owner)
            : { kind: 'pools', pools: [] };
          const apiUrl = clusterApiUrl(installation.id);
          if (inventory.kind === 'unreachable') {
            throw new ClusterUnreachableError(
              await unreachableGuidance(installation, apiUrl, inventory.reason),
            );
          }
          const refusal = dependentsRefusal(
            { pools: inventory.pools, workloads: [] },
            installation.name,
            apiUrl,
          );
          if (refusal) throw new ClusterReferencedError(refusal);
          // A kept bucket's newest backup is the restore point: take one now.
          if (!deletesBucket && installation.checkpointBucket) {
            taken.backup = await takeFinalBackup(
              dependencies,
              installation,
              owner,
              hostedApiRuns,
            );
          }
          await installations.setState(
            installation.id,
            ClusterState.Destroying,
          );
          return (await installations.getForScope(installation.id, scope))!;
        },
        (row) => runDestroy(owner, row, scope, deletesBucket),
      );
      return {
        ...(await summary(destroying)),
        ...deleteReport(installation, {
          managementVm: vm?.cloudId ?? null,
          dnsRecord: true,
          bucketDeleted: deletesBucket,
          backup:
            taken.backup ??
            (deletesBucket
              ? null
              : await takeFinalBackup(
                  dependencies,
                  installation,
                  owner,
                  false,
                )),
        }),
      };
    },

    async forget(actor, identifier, signal) {
      signal?.throwIfAborted();
      const owner = await githubOwner(actor, CLUSTERS_NEED, signal);
      const scope = await dependencies.resolveScope(actor);
      const installation = await resolveForScope(identifier, scope);
      if (!installation) throw new ClusterNotFoundError(identifier);
      if (active.has(installation.id)) {
        throw new ClusterBusyError(installation.state);
      }
      const { name } = installation;
      const apiUrl = clusterApiUrl(installation.id);
      // As in delete, an installation whose release never completed has no
      // hosted API to ask. Resolving its hostname before the record is
      // published would cache NXDOMAIN for the next create's lookups.
      if (stepCompleted(installation, ClusterStep.Release)) {
        const inventory = await dependencies.hostedPools
          .inventory(installation, owner)
          .catch((error: unknown) => {
            if (!(error instanceof HostedApiAccessError)) throw error;
            throw new ClusterReachableError(
              error.versionFix
                ? `The hosted API at ${apiUrl} answered but refused this CLI's version, so it is reachable: ${error.versionFix}, then run anycloud cluster delete ${name}.`
                : error.status === 400
                  ? `${error.message}, so it is reachable; run anycloud cluster delete ${name} instead.`
                  : `The hosted API at ${apiUrl} answered but refused this account (HTTP ${error.status}), so it is reachable. Sign in as the account that bootstrapped it, then run anycloud cluster delete ${name}.`,
            );
          });
        if (inventory.kind !== 'unreachable') {
          throw new ClusterReachableError(
            `The hosted API at ${apiUrl} is reachable; run anycloud cluster delete ${name} instead.`,
          );
        }
      }
      const live =
        installation.state === ClusterState.Destroyed
          ? null
          : await liveManagementVm(installation);
      if (live) {
        throw new ClusterVmPresentError(
          live.error === null
            ? `Management VM ${live.cloudId} of cluster "${name}" still exists. Terminate it, then run anycloud cluster forget ${name} again.`
            : `Could not check management VM ${live.cloudId} of cluster "${name}" (${live.error}); retry once it can be read.`,
        );
      }
      const leftovers = leftoverResources(installation);
      await dependencies.dns.removeTls(installation.id, owner.token);
      await dependencies.dns.remove(installation.id, owner.token);
      await installations.forget(installation.id);
      return { id: installation.id, name: installation.name, leftovers };
    },
  };
}
