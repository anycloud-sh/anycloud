import { randomBytes } from 'node:crypto';
import type { V1Pod } from '@kubernetes/client-node';
import {
  CloudFailureDiagnosis,
  type CloudConfig,
  type CloudType,
} from '../../shared/cloud.js';
import {
  extractCredentials,
  gpuCapabilityForVMType,
  gpuRuntimeForVMType,
  nestedVirtualizationSupport,
} from '../../shared/cloud-config.js';
import { ClusterState } from '../../shared/clusters.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { NodePoolState } from '../../shared/node-pools.js';
import { decryptCredential, createComputeProvider } from './cloud-config.js';
import { createCloudResourceScope } from './cloud-resource-scope.js';
import {
  nodeDeleted,
  nodeDeletionForced,
  nodeNotObserved,
  type NodeDetached,
} from './node-detachment.js';
import type { IngressSpec, ProvisioningAttemptRef } from './entities.js';
import {
  canManageCloudResources,
  USUAL_VM_RELEASE_SECONDS,
  VMReleaseState,
  type CloudCompute,
  type CloudResourceCompute,
} from './gateways/cloud.js';
import {
  IGNORED_CLAIM_PREFIX,
  OUTDATED_REPLACEMENT_PREFIX,
  REMEDIATION_PAUSED_PREFIX,
  SCALE_OUT_CAP_BLOCK_PREFIX,
  vmReleaseFailurePrefix,
  type ClusterRecordRepository,
  type NodePoolRepository,
  type NodePoolVM,
  type NodePoolVmRepository,
  type StoredNodePool,
} from './cluster-store.js';
import {
  assertAgentVersionSkew,
  buildNodePoolAgentStartupScript,
  createNodePoolJoinCredential,
  deleteNodePoolJoinCredentials,
  NodePoolAgentSkewError,
  nodePoolPrepullImages,
} from './kubernetes/node-pool-join.js';
import type { ManagedImage } from './deployment-store.js';
import {
  NVIDIA_CAPACITY_DISK_SIZE_GB,
  nodePoolDisk,
} from './kubernetes/node-pool-disk.js';
import {
  electIngressEntry,
  entryHandoff,
  nodePoolNetwork,
  observePoolIngressRelease,
  poolIngressReleaseName,
  POOL_INGRESS_KEEP_ALIVE_MAX_MS,
  entryQuiet,
  poolIngressStopping,
  prepareEntryHandoff,
  releaseEntryHandoff,
  setIngressEntryLabel,
  type PoolIngressRelease,
} from './kubernetes/node-pool-ingress.js';
import { nodePoolServicePodSelector } from './kubernetes/identity.js';
import { deleteNodePoolNamespace } from './kubernetes/node-pool-namespace.js';
import { nodePoolNamespace } from './kubernetes/node-pool-scheduling.js';
import {
  cordonNodePoolNode,
  deleteNodePoolNode,
  drainNodePoolNode,
  evictNodePods,
  labelNodePoolNode,
  observeNodePoolNodes,
  stampNodePoolNodeScaleIn,
  type NodePoolNodeObservation,
} from './kubernetes/node-pool-nodes.js';
import {
  NODE_POOL_MEMBER_LABEL,
  NVIDIA_ACCELERATOR_LABEL_VALUE,
} from './kubernetes/node-pool-scheduling.js';
import { USER_NAMESPACE_NODE_LABEL } from './kubernetes/user-namespace.js';
import { kubernetesRequestOptions } from './kubernetes/request-options.js';
import {
  ClusterAddonOwnershipError,
  ClusterAddonPermissionError,
  createClusterAddonController,
  type ClusterAddonController,
  type ClusterAddonReport,
} from './kubernetes/cluster-addon-reconciler.js';
import type { ClusterAddonNeed } from './kubernetes/cluster-addons.js';
import {
  ClusterIdentityChangedError,
  ClusterPermissionError,
  type ClusterRuntime,
  type ClusterRuntimeResolver,
} from './kubernetes/cluster-runtime.js';
import { log } from './logger.js';
import { createSpendAdmission, formatBlockReason } from './spend-controls.js';
import { bindVmCompute, terminateVmComputes } from './vm-compute.js';
import {
  readCatalog,
  resolveWorkloadPrice,
} from '../../shared/catalog/index.js';
import { NVIDIA_GPU_RESOURCE } from './kubernetes/nvidia-device-plugin.js';
import { nodesNeeded, podRequests, type Resources } from './pool-fit.js';
import {
  busyNodeNames,
  daemonSetPod,
  estimatedPoolNodeRoom,
  pendingPoolPods,
  poolNodeRoom,
  SCALE_IN_IDLE_WINDOW_MS,
  targetVmCount,
} from './pool-scaling.js';
import {
  buildTargetCandidates,
  classifyLaunchFailure,
  markLaunchCredential,
  pickTarget,
  preflightTargetCandidates,
  withoutDeniedRegions,
  type TargetCandidate,
} from './launch-targets.js';
import {
  FailureDisposition,
  type ProvisioningFailure,
} from './provisioning-failure.js';

/**
 * Node pool VMs are outbound-only Jobs capacity (RFC 0033): no public ingress
 * and no node-to-node peer rules. The K3s agent reaches the cluster over its own
 * outbound tunnel. A pool that hosts Services additionally admits the
 * Cloudflare edge to its ingress entry (`nodePoolNetwork`).
 */
export const NODE_POOL_NETWORK: IngressSpec = Object.freeze(
  nodePoolNetwork({ hostsServices: false }),
);

/**
 * How long a VM may run with no Node before it is replaced. Kubelets register
 * only at startup and the keyless VM offers no way to restart the agent, so an
 * absent Node past the install window is permanent.
 */
const NODE_ABSENT_GRACE_MS = 10 * 60_000;
/** A registered Node that stays NotReady this long is replaced like an absent one. */
const NODE_NOT_READY_GRACE_MS = 15 * 60_000;
/**
 * How long a Ready GPU Node may advertise no devices: from its VM's creation
 * while the plugin first registers, and from the first pass that saw the
 * count drop when the plugin restarts on a Node that was already ready.
 */
const GPU_REGISTRATION_GRACE_MS = 10 * 60_000;
/**
 * How long an outdated Node's drain may wait on evictions (a
 * PodDisruptionBudget, a slow graceful exit) and its entry hand-off before
 * the Node is removed anyway: GKE's surge upgrade respects budgets as long.
 */
const NODE_DRAIN_TIMEOUT_MS = 60 * 60_000;
/**
 * After a hand-off's record publishes, the old entry serves until its
 * Traefik logs no request for this long, past the bound on an edge
 * connection's life, so Cloudflare has re-dialled to the new entry.
 */
const ENTRY_QUIET_MS = POOL_INGRESS_KEEP_ALIVE_MAX_MS + 10_000;
/**
 * The old entry serves at least this long after the publish, however quiet:
 * one earlier run saw the edge still dial the old IP 75 s after it.
 */
const ENTRY_PUBLISH_FLOOR_MS = 2 * 60_000;
/**
 * The old entry waits this long at most for quiet, then hands over anyway; a
 * Traefik from before the access log always waits it out.
 */
const ENTRY_QUIET_TIMEOUT_MS = 5 * 60_000;
const IN_PLACE_NOTE = `${OUTDATED_REPLACEMENT_PREFIX} without a spare first: `;
const DRAIN_TIMEOUT_NOTE = `${OUTDATED_REPLACEMENT_PREFIX}: a drain timed out after an hour: `;
/** Launch failures a removal frees room for, unlike a capacity shortage. */
const QUOTA_DIAGNOSES: ReadonlySet<string> = new Set([
  CloudFailureDiagnosis.QuotaExhaustedRegion,
  CloudFailureDiagnosis.QuotaExhaustedAccount,
  CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
]);
/** A pool picks launches from this much failure history (owner: 6–24 h). */
const LAUNCH_HISTORY_WINDOW_MS = 12 * 60 * 60_000;
/**
 * A condition only an operator can clear, so the pass marks the node pool
 * `failed`. Any other error (an API blip, a capacity or quota failure) is
 * recorded in `lastError` and retried without changing the pool's state.
 */
class NodePoolActionableError extends Error {}

/**
 * A hosted upgrade's RBAC arrives through the new image's own chart repair,
 * after that image already runs. While the repair is pending, a
 * missing verb is recorded and retried instead of failing the node pool.
 */
let permissionFailuresHeld = false;
export function holdPermissionFailures(held: boolean): void {
  permissionFailuresHeld = held;
}

function operatorActionable(error: unknown): boolean {
  if (error instanceof ClusterPermissionError) return !permissionFailuresHeld;
  return [
    NodePoolActionableError,
    NodePoolAgentSkewError,
    ClusterIdentityChangedError,
    ClusterPermissionError,
    ClusterAddonOwnershipError,
    ClusterAddonPermissionError,
  ].some((type) => error instanceof type);
}
/**
 * One breaker on a pool's Node remediation, after Cluster API's
 * MachineHealthCheck `maxUnhealthy`. Replacing unhealthy Nodes pauses while
 * more than max(1, 40%) of the live Nodes are absent or NotReady at once,
 * which points to a network or control-plane fault no replacement fixes, and
 * once this many were replaced as unhealthy within the window, as when each
 * replacement comes up as bad (a machine image, a driver, a join that can't
 * work), which a share of live Nodes never sees. The pool keeps its Nodes,
 * says why, and resumes as they recover or the window passes.
 */
const REMEDIATION_UNHEALTHY_SHARE = 0.4;
export const REMEDIATION_CAP = 3;
export const REMEDIATION_WINDOW_MS = 6 * 60 * 60_000;
const GPU_CHECK_FAILED = 'GPU check failed';
const PROVISIONING_BACKOFF_BASE_MS = 60_000;
const PROVISIONING_BACKOFF_MAX_MS = 30 * 60_000;

function provisioningBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(
    PROVISIONING_BACKOFF_MAX_MS,
    PROVISIONING_BACKOFF_BASE_MS * 2 ** (failures - 1),
  );
}

/**
 * E2E only: a pool's first launch fails as every provider's capacity error
 * (Azure's provisioning code, AWS's code, the GCP and Lambda messages).
 */
export function e2eCapacityFault(key: string, tried: boolean): Error | null {
  if (tried || process.env.ANYCLOUD_E2E_CAPACITY_FAULT !== key) return null;
  return Object.assign(
    new Error('E2E fault: ZONE_RESOURCE_POOL_EXHAUSTED, insufficient-capacity'),
    {
      provisioningErrorCode: 'AllocationFailed',
      code: 'InsufficientInstanceCapacity',
    },
  );
}

const JOIN_PRECONDITIONS =
  "check the cluster version, the registered identity's permissions, egress from the node pool network to the cluster endpoint and github.com, and that the VM type is x86_64";

export interface NodePoolCapacityObservation {
  readyVmCount: number;
  startingVmCount: number;
  drainingVmCount: number;
  /** Where each live VM runs, and since when a releasing one has been released. */
  locations: Array<{
    region: string;
    zone: string | null;
    vmType: string;
    releasing: { since: number; usuallyUnderSeconds: number } | null;
  }>;
  /** The last pass that scaled out, as this API process saw it. */
  lastScaleOut?: {
    at: number;
    pendingPods: number;
    lostVms: number;
    vms: number;
  };
}

/** The elected ingress entry: one live attempt and its public IP. */
interface NodePoolIngressEntry {
  vmId: number;
  ip: string;
}

/** What status reports about a pool's ingress; `release` is null for Jobs-only pools. */
export interface NodePoolIngressStatus {
  entryIp: string | null;
  release: PoolIngressRelease | null;
}

export interface NodePoolControllerDeps {
  nodePools: NodePoolRepository;
  vms: NodePoolVmRepository;
  clusterRecords: Pick<
    ClusterRecordRepository,
    'getForScope' | 'listDestroyedClusterIds'
  >;
  /**
   * Durable records that still target a node pool: Deployment records and
   * node pool Service Workloads whose cleanup has not confirmed removal.
   */
  references: {
    countLiveForNodePool(nodePoolId: string): Promise<number>;
    /** Service Workloads on the node pool whose cleanup has not confirmed removal. */
    countServicesForNodePool(nodePoolId: string): Promise<number>;
    /** C11: the node pool's live managed Deployments' images, latest Job first. */
    listManagedImages(nodePoolId: string): Promise<ManagedImage[]>;
  };
  /**
   * Told when the pool's ingress entry changes (or is lost), so Service
   * records can be re-pointed at the new entry's public IP.
   */
  ingress?: {
    entryChanged(nodePoolId: string, entry: NodePoolIngressEntry | null): void;
    /** Whether every published Service record on the pool points at `ip`. */
    publishedAt(nodePoolId: string, ip: string): Promise<boolean>;
  };
  clusterRuntime: ClusterRuntimeResolver;
  /**
   * The anycloud Pods in the pool loop's watch cache of a cluster, read once
   * at the start of a pass; throws while the cache syncs.
   */
  pods(clusterId: string): readonly V1Pod[];
  /** Told each pass which Pending Pods no empty Node of the pool holds. */
  unfit(nodePoolId: string, reason: string, podUids: ReadonlySet<string>): void;
  /**
   * What `api upgrade`'s drain uses, here holding an outdated Node's pool
   * Jobs: closing a replica to claims, and the pool Jobs in flight.
   */
  poolJobs: {
    closeReplica(podUid: string): void;
    inFlight(): Promise<Array<{ podUid: string }>>;
  };
  /** Cluster-scoped add-ons; one instance per process so passes coalesce. */
  clusterAddons?: ClusterAddonController;
  credentials: {
    getCredentialWithCloudProvider(
      credentialId: string,
    ): Promise<{ encryptedData: string; cloudProvider: CloudType } | null>;
    isCredentialAuthFailed(credentialId: string): Promise<boolean>;
  };
  createCompute?: (
    config: CloudConfig,
    purpose?: 'provisioning' | 'observed-vm',
  ) => CloudCompute;
  version: string;
  now?: () => number;
}

class NodePoolCapacityUnavailableError extends Error {
  constructor(nodePoolId: string, cause: unknown) {
    super(
      `Node pool ${nodePoolId}: ready capacity could not be observed on its cluster: ${errorMessage(cause)}`,
    );
    this.name = 'NodePoolCapacityUnavailableError';
  }
}

export interface NodePoolController {
  reconcile(nodePoolId: string): Promise<void>;
  /**
   * Ready/starting/draining counts from durable rows plus a Node observation.
   * By default a cluster that cannot be reached degrades to rows only (status);
   * `requireObservation` fails closed instead (admission).
   */
  observeCapacity(
    nodePoolId: string,
    options?: { requireObservation?: boolean },
  ): Promise<NodePoolCapacityObservation>;
  /**
   * Admission-time check that the cluster can take node pools: identity still
   * bound, registered permissions present, agent version skew supported.
   */
  assertClusterCompatible(
    clusterId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** The durable entry plus the cluster's view of the pool's Traefik release. */
  ingress(nodePoolId: string): Promise<NodePoolIngressStatus>;
}

function activeVms(vms: NodePoolVM[]): NodePoolVM[] {
  return vms.filter((vm) => vm.endedAt === null);
}

/**
 * Live, unclaimed VMs whose Node joined with an older join script; one that
 * failed the GPU check is replaced on its own.
 */
function outdatedVms(
  vms: NodePoolVM[],
  nodeByVm: Map<number, NodePoolNodeObservation>,
): NodePoolVM[] {
  return activeVms(vms).filter((vm) => {
    const node = nodeByVm.get(vm.id);
    return (
      vm.removalRequestedAt === null && node?.outdated && !node.unusableGpu
    );
  });
}

function nodesByVmRowId(
  nodes: NodePoolNodeObservation[],
): Map<number, NodePoolNodeObservation> {
  return new Map(nodes.map((node) => [node.vmRowId, node] as const));
}

/** The cluster add-ons a user-namespace pool needs (RFC 0049 C32). */
function userNamespaceNeed(
  nodePool: StoredNodePool,
): Pick<ClusterAddonNeed, 'userNamespace' | 'kvm'> {
  return {
    userNamespace: nodePool.userNamespaceJobs,
    kvm: nodePool.userNamespaceJobs && nodePool.requireNestedVirtualization,
  };
}

function expectedNvidiaGpus(nodePool: StoredNodePool): number | null {
  const capability = gpuCapabilityForVMType(
    nodePool.cloudProvider,
    nodePool.vmTypes[0]!,
  );
  if (capability.kind === 'cpu') return 0;
  if (capability.kind === 'nvidia') return capability.count ?? null;
  return null;
}

/**
 * A GPU Node counts only once the device plugin advertises exactly the
 * catalog's physical device count as allocatable. Allocatable is the Node's
 * advertised total, not what is free: Nodes whose devices are all held by
 * running Jobs remain ready capacity.
 */
function nodeCapabilityReady(
  node: NodePoolNodeObservation | undefined,
  expectedGpus: number | null,
): boolean {
  // Unknown NVIDIA supply cannot establish readiness, even for a Ready Node.
  return (
    expectedGpus !== null &&
    node?.ready === true &&
    (expectedGpus === 0 || node.allocatableGpus === expectedGpus)
  );
}

/**
 * RFC 0048's usable Node: launched, capability-ready and free of the
 * not-ready taint, so a Pending Pod can schedule onto it.
 */
function usable(
  vm: NodePoolVM,
  node: NodePoolNodeObservation | undefined,
  expectedGpus: number,
): boolean {
  return (
    vm.ip !== null &&
    nodeCapabilityReady(node, expectedGpus) &&
    !node!.notReadyTaint
  );
}

/**
 * RFC 0048's busy Node: it runs a busy Pod, one being deleted included, or
 * the pool's ingress.
 */
function nodeBusy(
  node: NodePoolNodeObservation,
  pods: readonly V1Pod[],
): boolean {
  return (
    node.ingressEntry ||
    busyNodeNames(pods, { ignoreDeleting: false }).has(node.name)
  );
}

/**
 * The device plugin has registered, but not the number of devices the
 * catalog attributes to the VM type. Counting such a Node would schedule
 * against capacity that does not exist, so the node pool fails closed.
 */
class NodePoolGpuCapacityMismatchError extends NodePoolActionableError {
  constructor(
    nodePoolId: string,
    vmType: string,
    expected: number,
    nodes: ReadonlyArray<
      Pick<NodePoolNodeObservation, 'name' | 'allocatableGpus'>
    >,
  ) {
    super(
      `Node pool ${nodePoolId}: NVIDIA device count mismatch; the catalog attributes ${expected} nvidia.com/gpu to ${vmType} but ${nodes
        .map((node) => `Node ${node.name} advertises ${node.allocatableGpus}`)
        .join(
          ', ',
        )}. Refresh the catalog or choose a VM type whose physical device count matches`,
    );
    this.name = 'NodePoolGpuCapacityMismatchError';
  }
}

/** Advertised devices that disagree with the catalog, never 0 (unregistered). */
function gpuMismatch(
  node: NodePoolNodeObservation | undefined,
  expectedGpus: number,
): boolean {
  return (
    expectedGpus > 0 &&
    node?.ready === true &&
    node.allocatableGpus > 0 &&
    node.allocatableGpus !== expectedGpus
  );
}

export function summarizeNodePoolCapacity(
  vms: NodePoolVM[],
  nodes: NodePoolNodeObservation[],
  expectedGpus: number | null,
  cloudProvider: CloudType,
): NodePoolCapacityObservation {
  const nodeByVm = nodesByVmRowId(nodes);
  const observation: NodePoolCapacityObservation = {
    readyVmCount: 0,
    startingVmCount: 0,
    drainingVmCount: 0,
    locations: [],
  };
  for (const vm of activeVms(vms)) {
    observation.locations.push({
      region: vm.region,
      zone: vm.availabilityZone,
      vmType: vm.vmType,
      releasing:
        vm.removalRequestedAt === null
          ? null
          : {
              since: vm.removalRequestedAt,
              usuallyUnderSeconds: USUAL_VM_RELEASE_SECONDS[cloudProvider],
            },
    });
    const node = nodeByVm.get(vm.id);
    if (vm.removalRequestedAt !== null) observation.drainingVmCount += 1;
    else if (vm.ip !== null && nodeCapabilityReady(node, expectedGpus)) {
      observation.readyVmCount += 1;
    } else observation.startingVmCount += 1;
  }
  return observation;
}

type Placement = Pick<NodePoolVM, 'region' | 'availabilityZone'> &
  Partial<Pick<NodePoolVM, 'credentialId' | 'vmType'>>;
/** A launch attempt's placement, with the one VM type it launches. */
type LaunchPlace = Placement & Pick<NodePoolVM, 'vmType'>;

const FAILED_UNTIL_RECREATED =
  'the pool stays failed until it is deleted and recreated';

/** A terminal outcome other than a bad credential, which only pauses. */
function failsPool(
  failure: Pick<ProvisioningFailure, 'diagnosis' | 'disposition'>,
): boolean {
  return (
    failure.diagnosis !== CloudFailureDiagnosis.BadCredential &&
    (failure.disposition === FailureDisposition.TerminalInvalid ||
      failure.disposition === FailureDisposition.TerminalFailed)
  );
}

type NetworkPrep = (
  region: string,
) => ReturnType<CloudResourceCompute['prepareResourceNetwork']>;

type PassFailure = Pick<
  ProvisioningFailure,
  'diagnosis' | 'disposition' | 'vmType' | 'region' | 'availabilityZone'
>;

/**
 * Whether `latest` ends a failed pass: a retry-same-target failure or a bad
 * credential, or every candidate failed in this pass. Regional quota covers
 * every zone of its region, as in pickTarget.
 */
function endsPass(
  candidates: readonly TargetCandidate[],
  pass: readonly PassFailure[],
  latest: PassFailure,
): boolean {
  if (
    latest.diagnosis === CloudFailureDiagnosis.BadCredential ||
    latest.disposition === FailureDisposition.RetrySameTarget
  ) {
    return true;
  }
  return candidates.every((candidate) =>
    [...pass, latest].some((failure) => failedAt(candidate, failure)),
  );
}

/** The failures since `lastLaunch` of the pass in progress; a pass ends as in `endsPass`. */
function currentPass(
  candidates: readonly TargetCandidate[],
  history: ReadonlyArray<PassFailure & { vmRowId: number }>,
  lastLaunch: number,
): PassFailure[] {
  let current: PassFailure[] = [];
  for (const failure of history) {
    if (failure.vmRowId <= lastLaunch) continue;
    current = endsPass(candidates, current, failure)
      ? []
      : [...current, failure];
  }
  return current;
}

/** Whether `failure` was a launch at `candidate`; regional quota covers every zone. */
function failedAt(candidate: TargetCandidate, failure: PassFailure): boolean {
  return (
    failure.vmType === candidate.vmType &&
    failure.region === candidate.region &&
    (!candidate.availabilityZone ||
      failure.diagnosis === CloudFailureDiagnosis.QuotaExhaustedRegion ||
      failure.availabilityZone === candidate.availabilityZone)
  );
}

function newNodePoolVmCloudId(nodePoolId: string): string {
  return `${nodePoolId}-vm-${randomBytes(4).toString('hex')}`;
}

export function createNodePoolController(
  deps: NodePoolControllerDeps,
): NodePoolController {
  const now = deps.now ?? Date.now;
  const createCompute = deps.createCompute ?? createComputeProvider;
  const clusterAddons =
    deps.clusterAddons ??
    createClusterAddonController({ clusterRecords: deps.clusterRecords });
  // When this process first saw a Ready GPU Node without its devices, per
  // node pool and Node UID. A restart forgets it and grants a fresh grace.
  const gpusMissingSince = new Map<string, number>();
  // When this process last saw each usable Node busy, or first saw it
  // usable, per node pool and Node UID; a restart restarts every window.
  const idleSince = new Map<string, number>();
  // Each outdated Node's drain from its cordon, per node pool and VM
  // row; a restart restarts both clocks.
  const drains = new Map<
    string,
    { since: number | null; publishedAt: number | null }
  >();
  const lastScaleOut = new Map<
    string,
    NonNullable<NodePoolCapacityObservation['lastScaleOut']>
  >();
  // C22: per node pool, the Pending Pods a usable Node judged unfit, so a
  // pool at zero Nodes never buys for them again; pruned with the Pod.
  const judgedUnfit = new Map<string, Set<string>>();

  /** Compute at a placement: an observed VM row, or a launch target. */
  async function loadCompute(
    nodePool: StoredNodePool,
    place: Placement,
    purpose: 'provisioning' | 'observed-vm' = 'observed-vm',
  ): Promise<CloudCompute & CloudResourceCompute> {
    const credential = await deps.credentials.getCredentialWithCloudProvider(
      place.credentialId ?? nodePool.computeCredentialId,
    );
    if (!credential) {
      throw new Error(
        `Node pool ${nodePool.id}: compute credential is unavailable`,
      );
    }
    if (credential.cloudProvider !== nodePool.cloudProvider) {
      throw new Error(
        `Node pool ${nodePool.id}: compute credential provider changed`,
      );
    }
    const decrypted = await decryptCredential(credential.encryptedData);
    const disk = nodePoolDisk(nodePool);
    const config: CloudConfig = {
      cloudProvider: credential.cloudProvider,
      credentials: extractCredentials(decrypted),
      region: place.region,
      availabilityZone: place.availabilityZone ?? undefined,
      vmType: place.vmType ?? nodePool.vmTypes[0],
      spot: nodePool.spot,
      diskSizeGb:
        nodePool.osDiskSizeGb ??
        (gpuRuntimeForVMType(nodePool.cloudProvider, nodePool.vmTypes[0]!) ===
        'cuda'
          ? NVIDIA_CAPACITY_DISK_SIZE_GB
          : undefined),
      ...(!disk.nvme && { minimumDiskSizeGb: disk.minimumDiskGb }),
      diskTier: nodePool.osDiskTier ?? undefined,
      nestedVirtualization: nodePool.requireNestedVirtualization,
    };
    const compute = createCompute(config, purpose);
    if (!canManageCloudResources(compute)) {
      throw new Error(
        `${nodePool.cloudProvider} does not support isolated cloud resource scopes`,
      );
    }
    return compute;
  }

  function bindNodePoolVmCompute(
    compute: CloudCompute,
    nodePool: StoredNodePool,
    vm: NodePoolVM,
  ) {
    return bindVmCompute(compute, {
      cloudId: vm.cloudId,
      provider: nodePool.cloudProvider,
      credential: { source: 'attempt', credentialId: vm.credentialId },
      region: vm.region,
      availabilityZone: vm.availabilityZone,
    });
  }

  function scopeFor(nodePool: StoredNodePool) {
    return createCloudResourceScope(nodePool.id, {
      anycloud_user: nodePool.ownerUserId,
      anycloud_cluster: nodePool.clusterId,
    });
  }

  function attemptIdentities(nodePool: StoredNodePool, vms: NodePoolVM[]) {
    return {
      clusterId: nodePool.clusterId,
      nodePoolId: nodePool.id,
      liveVmRowIds: new Set(activeVms(vms).map((vm) => vm.id)),
      endedVmRowIds: new Set(
        vms.filter((vm) => vm.endedAt !== null).map((vm) => vm.id),
      ),
    };
  }

  /**
   * Observe the node pool's Nodes. Stale Nodes left by ended attempts are
   * removed by exact UID. Owned Nodes lose their join token and get the
   * pool's protected membership label, which pool Pods select. Then
   * a Node claiming the node pool without an owned identity fails the node
   * pool closed before any provider mutation. Another pool's Node claiming
   * it by label alone is only reported, so one pool's Node can't stop
   * another pool.
   */
  async function observeNodes(
    nodePool: StoredNodePool,
    runtime: ClusterRuntime,
    vms: NodePoolVM[],
  ): Promise<NodePoolNodeObservation[]> {
    const observed = await observeNodePoolNodes(
      runtime.cluster.core,
      attemptIdentities(nodePool, vms),
    );
    for (const stale of observed.stale) {
      log.info('Removing Node left by an ended node pool attempt', {
        id: nodePool.id,
        node: stale.name,
      });
      await deleteNodePoolNode(runtime.cluster.core, stale);
    }
    for (const node of observed.nodes) {
      if (node.member) continue;
      // Once the Node object exists, its kubelet certificates authenticate
      // every agent restart. The bootstrap token goes before the Node can
      // take Pods, so no Pod can read it from instance metadata and join.
      await deleteNodePoolJoinCredentials(runtime.cluster.core, {
        nodePoolId: nodePool.id,
        vmRowId: node.vmRowId,
      });
      log.info('Making node pool Node a member', {
        id: nodePool.id,
        node: node.name,
      });
      await labelNodePoolNode(runtime.cluster.core, node, {
        [NODE_POOL_MEMBER_LABEL]: nodePool.id,
        ...(nodePool.userNamespaceJobs && {
          [USER_NAMESPACE_NODE_LABEL]: 'true',
        }),
      });
      node.member = true;
    }
    if (observed.ignored.length > 0) {
      await deps.nodePools.recordError(
        nodePool.id,
        `${IGNORED_CLAIM_PREFIX}${observed.ignored.join(', ')}`,
      );
    } else {
      await deps.nodePools.clearError(nodePool.id, IGNORED_CLAIM_PREFIX);
    }
    // Owned Nodes are labelled first, so a foreign one can't stop this pool's
    // new Nodes from taking Pods.
    if (observed.foreign.length > 0) {
      throw new NodePoolActionableError(
        `Node pool ${nodePool.id}: Nodes ${observed.foreign.join(', ')} claim this node pool but are not attempts it provisioned; refusing to count foreign capacity`,
      );
    }
    return observed.nodes;
  }

  /**
   * Ready GPU Nodes advertising fewer devices than expected, past the grace.
   * The grace runs from the VM's creation or from the first pass that saw the
   * devices missing, whichever is later, so a device-plugin restart on a
   * ready Node does not fail the node pool before the plugin re-registers.
   */
  function gpuRegistrationOverdue(
    nodePool: StoredNodePool,
    live: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
    expectedGpus: number,
  ): NodePoolVM[] {
    const prefix = `${nodePool.id}\u0000`;
    const seen = new Set<string>();
    const overdue: NodePoolVM[] = [];
    for (const vm of live) {
      const node = nodeByVm.get(vm.id);
      if (!node?.ready || nodeCapabilityReady(node, expectedGpus)) continue;
      const key = `${prefix}${node.uid}`;
      seen.add(key);
      const since = gpusMissingSince.get(key) ?? now();
      gpusMissingSince.set(key, since);
      if (now() - Math.max(vm.createdAt, since) >= GPU_REGISTRATION_GRACE_MS) {
        overdue.push(vm);
      }
    }
    for (const key of gpusMissingSince.keys()) {
      if (key.startsWith(prefix) && !seen.has(key))
        gpusMissingSince.delete(key);
    }
    return overdue;
  }

  /**
   * Classify a failed provider call, record it on the attempt row and give
   * the row up, so the next pass picks again. A terminal outcome fails the
   * pool. A failed pass, meaning a retry-same-target failure or every
   * candidate failed since the last launch, backs off; other failures move
   * straight on to the next candidate.
   */
  async function launchFailed(input: {
    nodePool: StoredNodePool;
    compute: CloudCompute;
    ref: ProvisioningAttemptRef;
    place: LaunchPlace;
    pass: LaunchPass;
    error: unknown;
  }): Promise<never> {
    const { nodePool, compute, ref, place, pass, error } = input;
    const failure = classifyLaunchFailure(
      compute,
      { cloudProvider: nodePool.cloudProvider, region: place.region },
      error,
      {
        region: nodePool.region,
        availabilityZone: nodePool.zone,
        otherVmTypes: nodePool.vmTypes.length > 1,
      },
    );
    await deps.vms.recordLaunchFailure(nodePool.id, ref, failure);
    await deps.vms.claimVmRemoval(nodePool.id, ref.vmRowId);
    const prefix = `Node pool ${nodePool.id}: launching VM ${ref.vmRowId} in ${place.region}${place.availabilityZone ? `/${place.availabilityZone}` : ''} failed (${failure.diagnosis})`;
    const badCredential =
      failure.diagnosis === CloudFailureDiagnosis.BadCredential;
    // A terminal auth failure marks the credential, which pauses launches.
    if (badCredential) {
      await markLaunchCredential(
        compute,
        nodePool.cloudProvider,
        nodePool.computeCredentialId,
        error,
      );
    } else if (failsPool(failure)) {
      throw new NodePoolActionableError(
        `${prefix}; ${FAILED_UNTIL_RECREATED}: ${errorMessage(error)}`,
      );
    }
    if (!endsPass(pass.candidates, pass.current, { ...place, ...failure })) {
      throw new Error(`${prefix}: ${errorMessage(error)}`);
    }
    const passes = await deps.nodePools.recordProvisioningFailure(
      nodePool.id,
      now(),
    );
    throw new Error(
      `${prefix}; next launch in ${provisioningBackoffMs(passes) / 1000} s: ${errorMessage(error)}`,
    );
  }

  async function provisionAttempt(input: {
    nodePool: StoredNodePool;
    runtime: ClusterRuntime;
    place: LaunchPlace;
    ref: ProvisioningAttemptRef;
    pass: LaunchPass;
    /** The region's network, prepared once per pass. */
    network: NetworkPrep;
    expectedGpus: number;
  }): Promise<void> {
    const { nodePool, runtime, place, ref, pass, network, expectedGpus } =
      input;
    const compute = await loadCompute(nodePool, place, 'provisioning');
    const scope = scopeFor(nodePool);
    // Only provider calls are classified; a cluster API failure is not one.
    const provider = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        return launchFailed({ nodePool, compute, ref, place, pass, error });
      }
    };
    let vm = await provider(
      async () =>
        (await compute.adoptResourceProvisioningAttempt?.({
          scope,
          vmId: ref.cloudId,
        })) ?? null,
    );
    if (!vm) {
      const prepared = await provider(() => network(place.region));
      // One outstanding token per attempt: a retried attempt replaces the
      // token it minted last time instead of accumulating Secrets.
      await deleteNodePoolJoinCredentials(runtime.cluster.core, {
        nodePoolId: nodePool.id,
        vmRowId: ref.vmRowId,
      });
      const credential = await createNodePoolJoinCredential(
        runtime.cluster.core,
        {
          nodePoolId: nodePool.id,
          vmRowId: ref.vmRowId,
          certificateAuthorityData: runtime.connection.certificateAuthorityData,
        },
        now(),
      );
      const prepullImages = nodePoolPrepullImages(
        deps.version,
        await deps.references.listManagedImages(nodePool.id),
      );
      vm = await provider(async () => {
        const fault = e2eCapacityFault(nodePool.name, pass.history.length > 0);
        if (fault) throw fault;
        return compute.newResourceVM({
          scope,
          vmId: ref.cloudId,
          ipWhitelist: [],
          startupScript: buildNodePoolAgentStartupScript(
            {
              clusterId: nodePool.clusterId,
              nodePoolId: nodePool.id,
              cloudProvider: nodePool.cloudProvider,
              vmRowId: ref.vmRowId,
              ...(expectedGpus > 0
                ? { accelerator: NVIDIA_ACCELERATOR_LABEL_VALUE }
                : {}),
              joinEndpoint: runtime.connection.server,
              certificateAuthorityData:
                runtime.connection.certificateAuthorityData,
              disk: nodePoolDisk(nodePool),
              boot: compute.nodePoolBoot,
              prepullImages,
              ...(nodePool.userNamespaceJobs && {
                userNamespace: {
                  nestedVirtualization: nodePool.requireNestedVirtualization,
                },
              }),
            },
            credential,
          ),
          gpuRuntime: gpuRuntimeForVMType(compute.type, compute.vmType),
          version: deps.version,
          adoptExistingAttempt: true,
          network: prepared,
          ingressSpec: NODE_POOL_NETWORK,
        });
      });
    }
    await deps.vms.completeVmAttempt(nodePool.id, ref, vm);
    await deps.nodePools.resetProvisioningFailures(nodePool.id);
  }

  async function finalizeReleasedVm(input: {
    nodePool: StoredNodePool;
    compute: CloudResourceCompute;
    runtime: ClusterRuntime | null;
    vm: NodePoolVM;
    node?: NodePoolNodeObservation;
    force: boolean;
  }): Promise<void> {
    const { nodePool, compute, runtime, vm, node, force } = input;
    // A VM gone outside terminateVM (spot eviction, a native delete) can
    // leave volumes or networking behind; the row stays open until they're
    // deleted. Pool deletion records the failure instead, and its scope sweep
    // retries.
    try {
      await compute.terminateResourceVMLeftovers?.(vm.cloudId);
    } catch (error) {
      if (!force) throw error;
      await deps.nodePools.recordDeletionError(
        nodePool.id,
        errorMessage(error),
      );
    }
    let detached: NodeDetached;
    if (!node || !runtime) {
      detached = nodeNotObserved();
    } else {
      try {
        await deleteNodePoolNode(runtime.cluster.core, node);
        detached = nodeDeleted();
      } catch (error) {
        if (!force) throw error;
        const recorded = errorMessage(error);
        await deps.nodePools.recordDeletionError(nodePool.id, recorded);
        detached = nodeDeletionForced(recorded);
      }
    }
    if (runtime) {
      try {
        await deleteNodePoolJoinCredentials(runtime.cluster.core, {
          nodePoolId: nodePool.id,
          vmRowId: vm.id,
        });
      } catch (error) {
        if (!force) throw error;
        await deps.nodePools.recordDeletionError(
          nodePool.id,
          errorMessage(error),
        );
      }
    }
    await deps.vms.endVm(nodePool.id, vm.id, detached);
  }

  /**
   * Drive one claimed removal to confirmed release. An unconfirmed or unknown
   * provider observation keeps the row open; only `released` ends it.
   */
  async function reconcileClaimedRemoval(input: {
    nodePool: StoredNodePool;
    runtime: ClusterRuntime | null;
    vm: NodePoolVM;
    node?: NodePoolNodeObservation;
    force: boolean;
    /**
     * Scale-in's own claim: once cordoned, a Node that turned busy is kept,
     * uncordoned and unclaimed instead of deleted.
     */
    recheck?: boolean;
  }): Promise<void> {
    const { nodePool, runtime, node, force } = input;
    let exactVm = input.vm;
    let compute = await loadCompute(nodePool, exactVm);
    if (exactVm.ip === null && compute.adoptResourceProvisioningAttempt) {
      const adopted = await compute.adoptResourceProvisioningAttempt({
        scope: scopeFor(nodePool),
        vmId: exactVm.cloudId,
      });
      if (adopted) {
        await deps.vms.completeVmAttempt(
          nodePool.id,
          {
            vmRowId: exactVm.id,
            cloudId: exactVm.cloudId,
            createdAt: exactVm.createdAt,
          },
          adopted,
        );
        exactVm = {
          ...exactVm,
          cloudId: adopted.cloudId,
          availabilityZone:
            adopted.availabilityZone ?? exactVm.availabilityZone,
        };
        compute = await loadCompute(nodePool, exactVm);
      }
    }
    const vmCompute = bindNodePoolVmCompute(compute, nodePool, exactVm);
    // Written when the provider fails this VM's release, cleared once it
    // confirms; both paths of the release show it in status.
    const failurePrefix = vmReleaseFailurePrefix(exactVm.cloudId);
    const finalize = async () => {
      await finalizeReleasedVm({
        nodePool,
        compute,
        runtime,
        vm: input.vm,
        node,
        force,
      });
      await deps.nodePools.clearError(nodePool.id, failurePrefix);
    };
    const status = await vmCompute.confirmRelease();
    if (status.state === VMReleaseState.Released) {
      await finalize();
      return;
    }
    if (node && runtime) {
      try {
        await cordonNodePoolNode(runtime.cluster.core, node.name);
      } catch (error) {
        if (!force) throw error;
        await deps.nodePools.recordDeletionError(
          nodePool.id,
          errorMessage(error),
        );
      }
    }
    // A LIST, not the watch cache: a Pod bound just before the cordon can be
    // missing from the cache (RFC 0048 question 2).
    if (input.recheck && node && runtime) {
      const { items } = await runtime.cluster.core.listPodForAllNamespaces(
        { fieldSelector: `spec.nodeName=${node.name}` },
        kubernetesRequestOptions(),
      );
      if (nodeBusy(node, items)) {
        // Each step leaves a crash safe: the claim and its stamp make the
        // next pass re-check, and a cleared claim ignores a stale stamp.
        await cordonNodePoolNode(runtime.cluster.core, node.name, false);
        await deps.vms.unclaimVmRemoval(
          nodePool.id,
          input.vm.id,
          input.vm.removalRequestedAt!,
        );
        await stampNodePoolNodeScaleIn(runtime.cluster.core, node, null);
        log.info('Keeping a node pool Node that turned busy during scale-in', {
          id: nodePool.id,
          node: node.name,
        });
        return;
      }
    }
    let failure: { error: unknown } | undefined;
    const terminated = await terminateVmComputes([vmCompute], (_, error) => {
      failure = { error };
    });
    if (terminated.includes(vmCompute)) {
      await finalize();
    } else if (failure) {
      const message = `${failurePrefix}${errorMessage(failure.error)}; retrying`;
      await (force
        ? deps.nodePools.recordDeletionError(nodePool.id, message)
        : deps.nodePools.recordError(nodePool.id, message));
    }
  }

  /** Why outdated Nodes go without a spare first, else null. */
  async function outdatedInPlace(
    nodePool: StoredNodePool,
    vms: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
  ): Promise<string | null> {
    if (!outdatedVms(vms, nodeByVm).length) {
      await deps.nodePools.clearError(nodePool.id, IN_PLACE_NOTE);
      return null;
    }
    const error = nodePool.lastError ?? '';
    if (error.startsWith(IN_PLACE_NOTE))
      return error.slice(IN_PLACE_NOTE.length);
    if (error.startsWith(SCALE_OUT_CAP_BLOCK_PREFIX)) return error;
    if (nodePool.provisioningFailures === 0) return null;
    const latest = (await deps.vms.listLaunchFailures(nodePool.id, 0)).at(-1);
    return latest?.diagnosis && QUOTA_DIAGNOSES.has(latest.diagnosis)
      ? `the spare VM's launch failed (${latest.diagnosis})`
      : null;
  }

  /**
   * Once every Service record publishes `to` and the old entry has
   * gone quiet (or the wait timed out), unlabel it, so its Traefik stops
   * while its replicas still serve what reaches it.
   */
  async function handOffEntry(
    nodePool: StoredNodePool,
    runtime: ClusterRuntime,
    live: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
    handoff: { from: number; to: number },
    drain: { publishedAt: number | null },
  ): Promise<void> {
    const from = nodeByVm.get(handoff.from)!;
    const to = live.find((vm) => vm.id === handoff.to)!;
    const ready = await prepareEntryHandoff(runtime.cluster, {
      nodePoolId: nodePool.id,
      from,
      to: nodeByVm.get(to.id)!,
    });
    if (!ready) return;
    if (nodePool.ingressEntryVmId !== to.id) {
      await recordIngressEntry(nodePool, live, to.id);
      return;
    }
    if (
      deps.ingress &&
      !(await deps.ingress.publishedAt(nodePool.id, to.ip!))
    ) {
      return;
    }
    drain.publishedAt ??= now();
    const waited = now() - drain.publishedAt;
    if (waited < ENTRY_PUBLISH_FLOOR_MS) return;
    const quiet =
      waited >= ENTRY_QUIET_TIMEOUT_MS ||
      (await entryQuiet(runtime.cluster.core, {
        nodePoolId: nodePool.id,
        nodeName: from.name,
        windowMs: ENTRY_QUIET_MS,
      }));
    if (!quiet) return;
    await setIngressEntryLabel(runtime.cluster.core, from, null);
    log.info('Handed the node pool ingress entry to a current Node', {
      id: nodePool.id,
      from: from.name,
      to: nodeByVm.get(to.id)!.name,
      waitedMs: waited,
    });
  }

  /**
   * Replace a Node that joined with another join script, so a fix in
   * the script (its metadata block) reaches Nodes that joined before it,
   * and, first, one that failed the GPU check. One per pool at a
   * time, only while the pool is at its desired count and every live VM is
   * Ready, so a replacement that failed to launch stops the next. Its Pods
   * are closed to pool Job claims, and it waits for those they hold. While
   * remediation is `paused`, a failed Node stays cordoned instead.
   */
  async function replaceOutdatedNode(
    nodePool: StoredNodePool,
    runtime: ClusterRuntime,
    vms: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
    expectedGpus: number,
    inPlace: string | null,
    desiredVmCount: number,
    paused: boolean,
  ): Promise<void> {
    // The entry goes last, so its Services move once.
    const live = activeVms(vms).sort(
      (left, right) =>
        Number(!!nodeByVm.get(left.id)?.ingressEntry) -
        Number(!!nodeByVm.get(right.id)?.ingressEntry),
    );
    if (
      live.length < desiredVmCount ||
      live.some(
        (vm) => vm.removalRequestedAt !== null || !nodeByVm.get(vm.id)?.ready,
      )
    ) {
      return;
    }
    const vm =
      (paused
        ? undefined
        : live.find((entry) => nodeByVm.get(entry.id)!.unusableGpu)) ??
      live.find((entry) => {
        const node = nodeByVm.get(entry.id)!;
        return node.outdated && !node.unusableGpu;
      });
    if (!vm) return;
    const node = nodeByVm.get(vm.id)!;
    // A Node that failed the GPU check goes without a spare or drain.
    const outdated = node.outdated && !node.unusableGpu;
    // Surge first, as a GKE surge upgrade (maxSurge 1,
    // maxUnavailable 0) does: the old Node waits for its spare, then is
    // cordoned and drained through the Eviction API, the entry handing its
    // Services over first. An hour bounds the drain.
    const key = `${nodePool.id}\u0000${vm.id}`;
    let drain = drains.get(key);
    if (outdated && inPlace === null) {
      if (live.length <= desiredVmCount || desiredVmCount === 0) {
        // The spare is gone, or the pool empties and the Node idles out:
        // reopen it until another one joins.
        if (drain) {
          await cordonNodePoolNode(runtime.cluster.core, node.name, false);
          await releaseEntryHandoff(runtime.cluster.apps, nodePool.id);
          drains.delete(key);
        }
        return;
      }
      if (
        live.some(
          (other) =>
            other !== vm &&
            !nodeCapabilityReady(nodeByVm.get(other.id), expectedGpus),
        )
      ) {
        return;
      }
    }
    if (outdated && !drain) {
      if (inPlace !== null) {
        await deps.nodePools.recordError(nodePool.id, IN_PLACE_NOTE + inPlace);
        log.warn('Replacing an outdated node pool Node without a spare', {
          id: nodePool.id,
          node: node.name,
          reason: inPlace,
        });
      }
      await cordonNodePoolNode(runtime.cluster.core, node.name);
      drain = { since: null, publishedAt: null };
      drains.set(key, drain);
    }
    const { items } = await runtime.cluster.core.listPodForAllNamespaces(
      { fieldSelector: `spec.nodeName=${node.name}` },
      kubernetesRequestOptions(),
    );
    const pods = new Set(items.flatMap((pod) => pod.metadata?.uid ?? []));
    for (const uid of pods) deps.poolJobs.closeReplica(uid);
    if ((await deps.poolJobs.inFlight()).some((job) => pods.has(job.podUid))) {
      return;
    }
    if (drain) {
      drain.since ??= now();
      const expired = now() - drain.since >= NODE_DRAIN_TIMEOUT_MS;
      const handoff =
        inPlace === null && !expired ? entryHandoff({ live, nodeByVm }) : null;
      if (handoff?.from === vm.id) {
        await handOffEntry(nodePool, runtime, live, nodeByVm, handoff, drain);
        return;
      }
      // A Traefik on a Node that has left the entry is stopping, and
      // the old replicas serve what reaches it until it has gone.
      if (
        !expired &&
        !node.ingressEntry &&
        items.some(
          (pod) =>
            pod.metadata?.namespace === poolIngressReleaseName(nodePool.id),
        )
      ) {
        return;
      }
      await releaseEntryHandoff(runtime.cluster.apps, nodePool.id);
      if (expired) {
        // Sticky until a later outdated Node drains in time.
        await deps.nodePools.recordError(
          nodePool.id,
          `${DRAIN_TIMEOUT_NOTE}Node ${node.name} was removed before its Pods moved`,
        );
        log.warn('Removing an outdated node pool Node whose drain timed out', {
          id: nodePool.id,
          node: node.name,
        });
      } else if (
        (await drainNodePoolNode(runtime.cluster.core, node.name)) > 0
      ) {
        return;
      } else {
        await deps.nodePools.clearError(nodePool.id, DRAIN_TIMEOUT_NOTE);
      }
      drains.delete(key);
    }
    const claimed = await deps.vms.claimVmRemoval(
      nodePool.id,
      vm.id,
      now(),
      node.unusableGpu,
    );
    if (!claimed) return;
    log.info(
      node.unusableGpu
        ? 'Replacing a node pool Node with an unusable GPU'
        : 'Replacing a node pool Node that joined with an older script',
      { id: nodePool.id, node: node.name },
    );
    await reconcileClaimedRemoval({
      nodePool,
      runtime,
      vm: claimed,
      node,
      force: false,
    });
  }

  /**
   * A live VM's Node that has stayed unusable past its grace, which the
   * breaker counts and remediation replaces: absent since the VM's creation,
   * NotReady since its last transition, or failed the GPU check.
   */
  function unhealthy(
    vm: NodePoolVM,
    node: NodePoolNodeObservation | undefined,
  ): string | null {
    if (!node) {
      return now() - vm.createdAt >= NODE_ABSENT_GRACE_MS
        ? 'node absent'
        : null;
    }
    if (
      !node.ready &&
      node.readyTransitionAt !== null &&
      now() - node.readyTransitionAt >= NODE_NOT_READY_GRACE_MS
    ) {
      return 'node not ready';
    }
    return node.unusableGpu ? GPU_CHECK_FAILED : null;
  }

  /** The breaker's verdict for this pass, kept in `lastError` while it holds. */
  async function remediationPause(
    nodePool: StoredNodePool,
    vms: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
  ): Promise<boolean> {
    const live = activeVms(vms).filter(
      (vm) => vm.ip !== null && vm.removalRequestedAt === null,
    );
    const reasons = live.flatMap(
      (vm) => unhealthy(vm, nodeByVm.get(vm.id)) ?? [],
    );
    // A failed GPU check isn't a reachability fault, and only a replacement
    // clears its label, so only churn bounds it.
    const unreachable = reasons.filter((r) => r !== GPU_CHECK_FAILED).length;
    const replaced = await deps.vms.countRemediations(
      nodePool.id,
      now() - REMEDIATION_WINDOW_MS,
    );
    const reason =
      unreachable >
      Math.max(1, Math.floor(live.length * REMEDIATION_UNHEALTHY_SHARE))
        ? `${unreachable} of ${live.length} Nodes are absent or NotReady at once, which replacing them won't fix; check the pool network's path to the cluster`
        : reasons.length > 0 && replaced >= REMEDIATION_CAP
          ? `${replaced} unhealthy Nodes were replaced within ${REMEDIATION_WINDOW_MS / 3_600_000} h, so replacements come up the same; check the VM type's machine image and GPU driver, and ${JOIN_PRECONDITIONS}`
          : null;
    if (reason) {
      await deps.nodePools.recordError(
        nodePool.id,
        REMEDIATION_PAUSED_PREFIX + reason,
      );
    } else {
      await deps.nodePools.clearError(nodePool.id, REMEDIATION_PAUSED_PREFIX);
    }
    return reason !== null;
  }

  type LaunchPass = Awaited<ReturnType<typeof launchPass>>;

  function inProvisioningBackoff(nodePool: StoredNodePool): boolean {
    return (
      nodePool.provisioningFailedAt !== null &&
      now() <
        nodePool.provisioningFailedAt +
          provisioningBackoffMs(nodePool.provisioningFailures)
    );
  }

  /**
   * What this pass launches from: the pool's pins over the catalog, the
   * cluster's region first when unpinned and without regions that denied
   * the credential, and its launch history. A terminal failure on record
   * keeps the pool failed until it is deleted and recreated.
   */
  async function launchPass(nodePool: StoredNodePool, vms: NodePoolVM[]) {
    const failures = await deps.vms.listLaunchFailures(nodePool.id, 0);
    const terminal = failures.find(failsPool);
    if (terminal) {
      throw new NodePoolActionableError(
        `Node pool ${nodePool.id}: launching in ${terminal.region} failed (${terminal.diagnosis}); ${FAILED_UNTIL_RECREATED}`,
      );
    }
    const history = failures.filter(
      (failure) => failure.createdAt >= now() - LAUNCH_HISTORY_WINDOW_MS,
    );
    const inClusterRegion = (candidate: TargetCandidate) =>
      !nodePool.region && candidate.region === nodePool.clusterRegion;
    const usable = withoutDeniedRegions(
      buildTargetCandidates(
        nodePool.cloudProvider,
        nodePool.vmTypes,
        nodePool.spot,
        {
          region: nodePool.region,
          availabilityZone: nodePool.zone,
        },
      )
        // Unknown support counts as none, so an unpinned pool never launches
        // where the catalog doesn't report it.
        .filter(
          (candidate) =>
            !nodePool.requireNestedVirtualization ||
            nestedVirtualizationSupport(
              nodePool.cloudProvider,
              candidate.vmType,
              candidate.region,
              candidate.availabilityZone,
            ) === true,
        )
        .sort(
          (a, b) => Number(inClusterRegion(b)) - Number(inClusterRegion(a)),
        ),
      history,
      nodePool.region !== null,
      nodePool.cloudProvider,
    );
    if ('invalid' in usable) {
      throw new NodePoolActionableError(
        `Node pool ${nodePool.id}: ${usable.invalid}`,
      );
    }
    if (usable.candidates.length === 0) {
      throw new NodePoolActionableError(
        `Node pool ${nodePool.id}: the catalog offers ${nodePool.vmTypes.join(', ')}${nodePool.requireNestedVirtualization ? ' with nested virtualization' : ''} at none of the pool's targets`,
      );
    }
    // Row ids order attempts as the API began them; a launched row's
    // created_at is the provider's clock.
    const lastLaunch = Math.max(
      0,
      ...vms.filter((vm) => vm.ip !== null).map((vm) => vm.id),
    );
    return {
      candidates: usable.candidates,
      verifiedKeys: undefined as ReadonlySet<string> | undefined,
      history,
      lastLaunch,
      current: currentPass(usable.candidates, history, lastLaunch),
    };
  }

  /**
   * Rank candidates by the provider's capacity signal before buying, as for
   * VM Jobs, leaving out each one already tried in this pass.
   */
  async function rankPass(
    nodePool: StoredNodePool,
    pass: LaunchPass,
  ): Promise<LaunchPass> {
    // The preflight reads only the credential, so one compute serves.
    const probeCompute = await loadCompute(
      nodePool,
      { region: pass.candidates[0]!.region, availabilityZone: null },
      'provisioning',
    );
    const preflight = await preflightTargetCandidates(
      pass.candidates,
      () => probeCompute,
      {
        id: nodePool.id,
        cloud: nodePool.cloudProvider,
        spot: nodePool.spot,
        vmLabel: nodePool.vmTypes.join(', '),
      },
      {},
    );
    if ('invalid' in preflight) {
      const passes = await deps.nodePools.recordProvisioningFailure(
        nodePool.id,
        now(),
      );
      throw new Error(
        `Node pool ${nodePool.id}: no target with quota or region access for the credential; next launch in ${provisioningBackoffMs(passes) / 1000} s: ${preflight.invalid}`,
      );
    }
    const current = currentPass(
      preflight.candidates,
      pass.history,
      pass.lastLaunch,
    );
    const untried = preflight.candidates.filter(
      (candidate) => !current.some((failure) => failedAt(candidate, failure)),
    );
    return {
      ...pass,
      candidates: untried.length > 0 ? untried : preflight.candidates,
      current,
      verifiedKeys: preflight.verifiedKeys,
    };
  }

  /**
   * Replace a live VM that will never contribute: its Node has not appeared
   * within the install window, or has stayed NotReady past the grace. Each
   * replacement counts toward the breaker.
   */
  async function replaceNeverJoinedVm(input: {
    nodePool: StoredNodePool;
    runtime: ClusterRuntime;
    vm: NodePoolVM;
    node?: NodePoolNodeObservation;
    reason: string;
  }): Promise<void> {
    const { nodePool, runtime, vm, node, reason } = input;
    const claimed = await deps.vms.claimVmRemoval(
      nodePool.id,
      vm.id,
      now(),
      true,
    );
    if (!claimed) return;
    log.info('Replacing node pool VM that never joined the cluster', {
      id: nodePool.id,
      vmRowId: vm.id,
      reason,
    });
    await reconcileClaimedRemoval({
      nodePool,
      runtime,
      vm: claimed,
      node,
      force: false,
    });
  }

  /** A VM type's catalog shape; a value the catalog lacks stays unset. */
  function catalogShape(
    nodePool: StoredNodePool,
    vmType: string,
    expectedGpus: number,
  ): Partial<Resources> {
    const catalog = readCatalog(nodePool.cloudProvider);
    const vCPUs = catalog?.vCPUsPerType[vmType.toLowerCase()];
    const memoryGiB = catalog?.memoryPerType[vmType.toLowerCase()];
    return {
      ...(vCPUs ? { cpu: vCPUs * 1000 } : {}),
      ...(memoryGiB ? { memory: memoryGiB * 1024 ** 3 } : {}),
      [NVIDIA_GPU_RESOURCE]: expectedGpus,
    };
  }

  /**
   * RFC 0048's idle VMs, longest idle first: usable Nodes, not busy
   * in the pass-start snapshot, that the live cache has shown idle for one
   * continuous window. Without a Pod cache nothing is idle.
   */
  function idleVms(input: {
    nodePool: StoredNodePool;
    live: NodePoolVM[];
    nodeByVm: Map<number, NodePoolNodeObservation>;
    pods: readonly V1Pod[] | null;
    expectedGpus: number;
  }): NodePoolVM[] {
    const { nodePool, live, nodeByVm, pods, expectedGpus } = input;
    let current: readonly V1Pod[] | null = null;
    try {
      current = deps.pods(nodePool.clusterId);
    } catch {
      // The cache is syncing; every window restarts below.
    }
    const busyAtStart = busyNodeNames(pods ?? [], { ignoreDeleting: false });
    const busyNow = busyNodeNames(current ?? [], { ignoreDeleting: false });
    const prefix = `${nodePool.id}\u0000`;
    const seen = new Set<string>();
    const idle: Array<{ vm: NodePoolVM; since: number }> = [];
    for (const vm of live) {
      const node = nodeByVm.get(vm.id);
      if (!node || !usable(vm, node, expectedGpus)) continue;
      const key = `${prefix}${node.uid}`;
      seen.add(key);
      if (
        !pods ||
        !current ||
        node.ingressEntry ||
        busyAtStart.has(node.name) ||
        busyNow.has(node.name)
      ) {
        idleSince.set(key, now());
        continue;
      }
      const since = idleSince.get(key) ?? now();
      idleSince.set(key, since);
      if (now() - since >= SCALE_IN_IDLE_WINDOW_MS) {
        idle.push({ vm, since });
      }
    }
    for (const key of idleSince.keys()) {
      if (key.startsWith(prefix) && !seen.has(key)) idleSince.delete(key);
    }
    return idle
      .sort((left, right) => left.since - right.since)
      .map((entry) => entry.vm);
  }

  /**
   * Scale-in (RFC 0048 § Scale-in, step 4): stamp the Node with the claim
   * time, claim its VM at that time, then cordon, re-check and delete. A
   * failed stamp skips the VM for this pass.
   */
  async function scaleIn(input: {
    nodePool: StoredNodePool;
    runtime: ClusterRuntime;
    vm: NodePoolVM;
    node: NodePoolNodeObservation;
  }): Promise<void> {
    const { nodePool, runtime, vm, node } = input;
    const at = now();
    try {
      await stampNodePoolNodeScaleIn(runtime.cluster.core, node, at);
    } catch (error) {
      log.info('Scale-in skips a Node it could not stamp', {
        id: nodePool.id,
        node: node.name,
        error,
      });
      return;
    }
    const claimed = await deps.vms.claimVmRemoval(nodePool.id, vm.id, at);
    if (claimed?.removalRequestedAt !== at) return;
    log.info('Scaling in an idle node pool Node', {
      id: nodePool.id,
      node: node.name,
    });
    await reconcileClaimedRemoval({
      nodePool,
      runtime,
      vm: claimed,
      node,
      force: false,
      recheck: true,
    });
  }

  /**
   * RFC 0048's policy: the live VMs, plus the Nodes FIT packs the Pending
   * Pods into and the busy VMs lost in this pass, less the VMs whose Nodes
   * aren't usable yet or are usable and empty, and the idle ones, clamped
   * to the bounds. An empty usable Node holds any Pod of the shape, and its
   * replica may still be Unschedulable in the snapshot, so while Pending
   * Pods count against it nothing is idle. Pending Pods buy only once the
   * pool is ready; with no usable Node to read `reserved` from, at zero
   * Nodes (C22), they pack onto the catalog's estimate. The estimate can
   * err near the reserve, so there a Pod it rejects still buys one Node,
   * unless a usable Node already judged that Pod unfit.
   */
  async function scalingTarget(input: {
    nodePool: StoredNodePool;
    runtime: ClusterRuntime;
    live: NodePoolVM[];
    nodeByVm: Map<number, NodePoolNodeObservation>;
    pods: readonly V1Pod[] | null;
    busy: ReadonlySet<string>;
    lost: number;
    idle: number;
    idleOutdated: number;
    expectedGpus: number;
  }): Promise<number> {
    const { nodePool, runtime, live, nodeByVm, expectedGpus } = input;
    const inFlight = live.filter((vm) => {
      const node = nodeByVm.get(vm.id);
      return !usable(vm, node, expectedGpus) || !input.busy.has(node!.name);
    }).length;
    const pending =
      nodePool.state === NodePoolState.Ready
        ? pendingPoolPods(input.pods ?? [], nodePool.id)
        : [];
    const uid = (pod: V1Pod) => pod.metadata?.uid ?? '';
    let judged = judgedUnfit.get(nodePool.id) ?? new Set<string>();
    if (input.pods) {
      const present = new Set(input.pods.map(uid));
      judged = new Set([...judged].filter((entry) => present.has(entry)));
    }
    const reference = live.find((vm) =>
      usable(vm, nodeByVm.get(vm.id), expectedGpus),
    );
    let needed = 0;
    const unfit = new Set<string>();
    if (pending.length > 0) {
      const types = nodePool.vmTypes.map((vmType) =>
        catalogShape(nodePool, vmType, expectedGpus),
      );
      let room: { shape: Resources; reserved: Resources };
      if (reference) {
        const node = nodeByVm.get(reference.id)!;
        const { items } = await runtime.cluster.core.listPodForAllNamespaces(
          { fieldSelector: `spec.nodeName=${node.name}` },
          kubernetesRequestOptions(),
        );
        room = poolNodeRoom(types, {
          catalog: catalogShape(nodePool, reference.vmType, expectedGpus),
          allocatable: node.allocatable,
          daemonSets: items.filter(daemonSetPod).map(podRequests),
        });
      } else {
        const storageGi = nodePoolDisk(nodePool).allocatableGi;
        room = estimatedPoolNodeRoom(
          types.map((type) => ({
            ...type,
            ...(storageGi !== undefined && {
              'ephemeral-storage': storageGi * 1024 ** 3,
            }),
          })),
        );
      }
      const { shape, reserved } = room;
      const candidates = pending.filter((pod) => !judged.has(uid(pod)));
      needed = nodesNeeded(shape, reserved, candidates.map(podRequests));
      let rejected = false;
      for (const pod of candidates) {
        if (nodesNeeded(shape, reserved, [podRequests(pod)]) > 0) continue;
        if (reference) judged.add(uid(pod));
        else rejected = true;
      }
      if (rejected) needed = Math.max(needed, 1);
      for (const pod of pending) {
        if (judged.has(uid(pod))) unfit.add(uid(pod));
      }
    }
    if (judged.size > 0) judgedUnfit.set(nodePool.id, judged);
    else judgedUnfit.delete(nodePool.id);
    deps.unfit(nodePool.id, `fits no Node of pool ${nodePool.name}`, unfit);
    const target = (idle: number) =>
      targetVmCount({
        live: live.length,
        needed,
        lost: input.lost,
        inFlight,
        idle: needed + input.lost > 0 ? 0 : idle,
        min: nodePool.minVmCount,
        max: nodePool.maxVmCount,
      });
    // An outdated Node is replaced, unless the pool empties.
    const desired =
      target(input.idle + input.idleOutdated) === 0 ? 0 : target(input.idle);
    if (desired > live.length && needed + input.lost > 0) {
      log.info('Node pool scaling out', {
        id: nodePool.id,
        pending: pending.length,
        needed,
        lost: input.lost,
        inFlight,
        live: live.length,
        desired,
      });
      lastScaleOut.set(nodePool.id, {
        at: now(),
        pendingPods: pending.length,
        lostVms: input.lost,
        vms: desired - live.length,
      });
    }
    return desired;
  }

  /** Converge the node pool's owned VMs to the scaling policy's count. */
  async function reconcileCapacity(
    nodePool: StoredNodePool,
    runtime: ClusterRuntime,
  ): Promise<void> {
    assertAgentVersionSkew(runtime.serverVersion);
    // The Node status policy first, so a pool that stops below on
    // credentials, backoff or a foreign Node still installs it. A failure
    // here is only logged: the pass must still observe and release its VMs,
    // and the ensure before any launch below throws it.
    await clusterAddons.ensure(runtime, { nvidiaGpus: 0 }).catch((error) =>
      log.warn('Cluster add-ons not yet converged', {
        id: nodePool.id,
        error: errorMessage(error),
      }),
    );
    const expectedGpus = expectedNvidiaGpus(nodePool);
    if (expectedGpus === null) {
      throw new NodePoolActionableError(
        `Node pool ${nodePool.id}: cannot verify CPU or NVIDIA GPU capacity for ${nodePool.vmTypes.join(', ')}. Refresh the catalog or choose a supported VM type with a positive physical GPU count.`,
      );
    }
    let spendAdmissionPromise: ReturnType<typeof createSpendAdmission> | null =
      null;
    const admitVmSpend = async (pricePerHour: number | undefined) => {
      spendAdmissionPromise ??= createSpendAdmission();
      return (await spendAdmissionPromise)({
        session: null,
        hourlyUsd: pricePerHour,
      });
    };
    const hostsServices =
      (await deps.references.countServicesForNodePool(nodePool.id)) > 0;
    const network = nodePoolNetwork({ hostsServices });
    // Each region the pool launches in gets its own network, once per pass.
    const networks = new Map<string, ReturnType<NetworkPrep>>();
    const prepareNetwork = (region: string) => {
      if (!networks.has(region)) {
        networks.set(
          region,
          loadCompute(
            nodePool,
            { region, availabilityZone: null },
            'provisioning',
          ).then((compute) =>
            compute.prepareResourceNetwork(
              network,
              scopeFor(nodePool),
              deps.version,
            ),
          ),
        );
      }
      return networks.get(region)!;
    };

    const removeVm = async (vm: NodePoolVM, node?: NodePoolNodeObservation) => {
      const claimed = await deps.vms.claimVmRemoval(nodePool.id, vm.id);
      if (claimed) {
        await reconcileClaimedRemoval({
          nodePool,
          runtime,
          vm: claimed,
          node,
          force: false,
        });
      }
      return claimed !== null;
    };

    let vms = await deps.vms.listVms(nodePool.id);
    let nodes = await observeNodes(nodePool, runtime, vms);
    let nodeByVm = nodesByVmRowId(nodes);
    // The policy reads Pods as they were with `nodeByVm`: replicas that the
    // loss handling below recreates count from the next pass, not twice.
    let pods: readonly V1Pod[] | null = null;
    try {
      pods = [...deps.pods(nodePool.clusterId)];
    } catch (error) {
      log.info('Node pool scaling waits for the Pod cache', {
        id: nodePool.id,
        error,
      });
    }
    const busy = busyNodeNames(pods ?? [], { ignoreDeleting: true });
    let lost = 0;
    const paused = await remediationPause(nodePool, vms, nodeByVm);

    for (const vm of activeVms(vms)) {
      if (vm.ip === null || vm.removalRequestedAt !== null) continue;
      const node = nodeByVm.get(vm.id);
      if (node?.ready) continue;
      const compute = await loadCompute(nodePool, vm);
      const vmCompute = bindNodePoolVmCompute(compute, nodePool, vm);
      const released =
        (await vmCompute.confirmRelease()).state === VMReleaseState.Released;
      if (released) {
        const claimed = await deps.vms.claimVmRemoval(nodePool.id, vm.id);
        if (claimed) {
          await finalizeReleasedVm({
            nodePool,
            compute,
            runtime,
            vm: claimed,
            node,
            force: false,
          });
        }
        continue;
      }
      // A stopped VM (a stop-on-evict Spot eviction or a native stop) never
      // becomes Ready by itself. Delete it rather than restart it, so its Pods
      // resolve only once it is gone, and its replacement launches this pass.
      if (await vmCompute.observeStopped?.()) {
        log.info('Replacing stopped node pool VM', {
          id: nodePool.id,
          vmRowId: vm.id,
        });
        // A busy lost VM is one Node of demand in this pass only (RFC 0048
        // question 4); an idle one above the floor isn't replaced.
        if ((await removeVm(vm, node)) && node && busy.has(node.name)) {
          lost += 1;
        }
        continue;
      }
      const reason = unhealthy(vm, node);
      if (!reason || paused) continue;
      await replaceNeverJoinedVm({ nodePool, runtime, vm, node, reason });
    }

    vms = await deps.vms.listVms(nodePool.id);
    for (const vm of activeVms(vms).filter(
      (entry) => entry.removalRequestedAt !== null,
    )) {
      const node = nodeByVm.get(vm.id);
      // Only scale-in's own claim is re-checked; every other path's ends in
      // deletion even if its Node recovered.
      await reconcileClaimedRemoval({
        nodePool,
        runtime,
        vm,
        node,
        force: false,
        recheck:
          usable(vm, node, expectedGpus) &&
          node!.scaleInStamp === vm.removalRequestedAt,
      });
    }

    vms = await deps.vms.listVms(nodePool.id);
    const contributing = activeVms(vms).filter(
      (vm) => vm.removalRequestedAt === null,
    );
    const idleAll = idleVms({
      nodePool,
      live: contributing,
      nodeByVm,
      pods,
      expectedGpus,
    });
    const idle = idleAll.filter((vm) => !nodeByVm.get(vm.id)!.outdated);
    // An outdated Node waits for no idle window to count against emptying:
    // an upgrade restarts every window, and its spare would come first.
    const quietOutdated = outdatedVms(contributing, nodeByVm).filter((vm) => {
      const node = nodeByVm.get(vm.id);
      return pods && usable(vm, node, expectedGpus) && !nodeBusy(node!, pods);
    });
    const desiredVmCount = await scalingTarget({
      nodePool,
      runtime,
      live: contributing,
      nodeByVm,
      pods,
      busy,
      lost,
      idle: idle.length,
      idleOutdated: quietOutdated.length,
      expectedGpus,
    });
    // Only idle Nodes go, so a pass may remove fewer than the count asks; an
    // outdated Node's spare is not excess. A pool that empties needs
    // no spare and removes its outdated Nodes as they idle out.
    const spare =
      desiredVmCount > 0 && outdatedVms(contributing, nodeByVm).length > 0;
    const excess = Math.max(
      0,
      contributing.length - desiredVmCount - Number(spare),
    );
    for (const vm of (desiredVmCount > 0 ? idle : idleAll).slice(0, excess)) {
      await scaleIn({ nodePool, runtime, vm, node: nodeByVm.get(vm.id)! });
    }

    // Launches pause while the credential is marked invalid.
    if (
      await deps.credentials.isCredentialAuthFailed(
        nodePool.computeCredentialId,
      )
    ) {
      return;
    }
    let pass = await launchPass(nodePool, vms);
    if (inProvisioningBackoff(nodePool)) {
      log.info('Node pool provisioning is backing off after a failure', {
        id: nodePool.id,
        failures: nodePool.provisioningFailures,
      });
      return;
    }
    // After the checks above, so the launch below can follow the removal.
    const inPlace = await outdatedInPlace(nodePool, vms, nodeByVm);
    await replaceOutdatedNode(
      nodePool,
      runtime,
      await deps.vms.listVms(nodePool.id),
      nodeByVm,
      expectedGpus,
      inPlace,
      desiredVmCount,
      paused,
    );

    // Cluster-scoped add-ons converge after existing VMs were observed and
    // released, so an add-on failure never strands bought capacity, and
    // before any VM is bought, so a joining Node finds the device plugin
    // waiting and the Node status policy holds.
    const addons: ClusterAddonReport = await clusterAddons.ensure(runtime, {
      nvidiaGpus: expectedGpus,
      ...(hostsServices ? { ingressNodePoolId: nodePool.id } : {}),
      ...userNamespaceNeed(nodePool),
    });
    // The first Service on the pool opens the edge rule on the network of
    // every region with a live VM; gateways add rules idempotently and never
    // remove them.
    if (hostsServices) {
      for (const region of new Set(activeVms(vms).map((vm) => vm.region))) {
        await prepareNetwork(region);
      }
    }

    vms = await deps.vms.listVms(nodePool.id);
    for (const vm of activeVms(vms).filter(
      (entry) => entry.removalRequestedAt === null && entry.ip === null,
    )) {
      await provisionAttempt({
        nodePool,
        runtime,
        place: vm,
        ref: { vmRowId: vm.id, cloudId: vm.cloudId, createdAt: vm.createdAt },
        pass,
        network: prepareNetwork,
        expectedGpus,
      });
    }

    vms = await deps.vms.listVms(nodePool.id);
    let available = activeVms(vms).filter(
      (vm) => vm.removalRequestedAt === null,
    ).length;
    // One spare while an outdated Node waits for it.
    const launchTarget =
      desiredVmCount +
      Number(
        desiredVmCount > 0 &&
          inPlace === null &&
          outdatedVms(vms, nodeByVm).length > 0,
      );
    if (available < launchTarget) pass = await rankPass(nodePool, pass);
    let capBlock: string | null = null;
    while (available < launchTarget) {
      const target = pickTarget(
        pass.candidates,
        pass.history,
        nodePool.cloudProvider,
        nodePool.spot,
        pass.verifiedKeys,
      );
      // Providers without zone targets still honor a pinned zone.
      const place = {
        region: target.region,
        availabilityZone: target.availabilityZone ?? nodePool.zone,
        vmType: target.vmType,
      };
      const pricePerHour = resolveWorkloadPrice(
        nodePool.cloudProvider,
        target.vmType,
        target.region,
        nodePool.spot,
      );
      // A cap block is soft (RFC 0044 decision 22): nothing is bought, and
      // the pool keeps its state and backoff with the reason.
      const spendBlock = await admitVmSpend(pricePerHour);
      if (spendBlock) {
        capBlock = SCALE_OUT_CAP_BLOCK_PREFIX + formatBlockReason(spendBlock);
        break;
      }
      const ref = await deps.vms.beginVmAttempt(nodePool.id, {
        cloudId: newNodePoolVmCloudId(nodePool.id),
        ...place,
        pricePerHour,
        desiredVmCount: launchTarget,
      });
      // The SQL count fence makes a concurrent admission ordinary contention.
      if (!ref) break;
      await provisionAttempt({
        nodePool,
        runtime,
        place,
        ref,
        pass,
        network: prepareNetwork,
        expectedGpus,
      });
      available += 1;
    }
    if (capBlock) await deps.nodePools.recordError(nodePool.id, capBlock);
    else
      await deps.nodePools.clearError(nodePool.id, SCALE_OUT_CAP_BLOCK_PREFIX);

    vms = await deps.vms.listVms(nodePool.id);
    nodes = await observeNodes(nodePool, runtime, vms);
    nodeByVm = nodesByVmRowId(nodes);
    const live = activeVms(vms).filter((vm) => vm.removalRequestedAt === null);
    // The entry election runs before the GPU verdicts below so a device-plugin
    // hiccup on a GPU pool never leaves its Services without a reachable entry.
    if (hostsServices) {
      await reconcileIngressEntry(nodePool, runtime, live, nodeByVm);
    } else {
      await releaseIngressEntry(nodePool, runtime, live, nodeByVm);
    }
    const mismatched = live
      .map((vm) => nodeByVm.get(vm.id))
      .filter(
        (node): node is NodePoolNodeObservation =>
          node !== undefined && gpuMismatch(node, expectedGpus),
      );
    if (mismatched.length > 0) {
      throw new NodePoolGpuCapacityMismatchError(
        nodePool.id,
        nodePool.vmTypes.join(', '),
        expectedGpus,
        mismatched,
      );
    }
    const missingGpuNodes = gpuRegistrationOverdue(
      nodePool,
      live,
      nodeByVm,
      expectedGpus,
    );
    if (missingGpuNodes.length > 0) {
      throw new NodePoolActionableError(
        `Node pool ${nodePool.id}: NVIDIA GPU registration incomplete; expected ${expectedGpus} allocatable nvidia.com/gpu per Node (${missingGpuNodes
          .map(
            (vm) =>
              `${nodeByVm.get(vm.id)!.name}: ${nodeByVm.get(vm.id)!.allocatableGpus}`,
          )
          .join(
            ', ',
          )}). The cluster-scoped NVIDIA add-on has not registered these devices (${addons.resources
          .filter((entry) => entry.addon === 'nvidia')
          .map((entry) => `${entry.kind} ${entry.name} ${entry.outcome}`)
          .join(
            ', ',
          )}); check that the device plugin Pod runs on each Node and that the VM image provides the NVIDIA driver and container runtime`,
      );
    }
    // Ready once the minimum's Nodes are, and it stays ready while it scales.
    const ready =
      live.filter(
        (vm) =>
          vm.ip !== null &&
          nodeCapabilityReady(nodeByVm.get(vm.id), expectedGpus),
      ).length >= nodePool.minVmCount;
    if (ready) await deps.nodePools.markReady(nodePool.id);
  }

  /**
   * Keep exactly one Ready Node labelled as the pool's ingress entry. The
   * election is deterministic and durable; a change re-labels the Nodes and
   * tells Service consumers so their records follow the new public IP.
   */
  async function reconcileIngressEntry(
    nodePool: StoredNodePool,
    runtime: ClusterRuntime,
    live: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
  ): Promise<void> {
    const election = electIngressEntry({
      currentVmId: nodePool.ingressEntryVmId,
      live,
      nodeByVm,
      now: now(),
    });
    // Both ends of a hand-off keep the label until it ends; with
    // none under way and no former entry's Traefik stopping, no Service
    // holds a second replica.
    const handoff = entryHandoff({ live, nodeByVm });
    const entries = new Set(
      [...nodeByVm.values()].flatMap((node) =>
        node.ingressEntry ? [node.name] : [],
      ),
    );
    if (
      !handoff &&
      !(await poolIngressStopping(runtime.cluster.core, nodePool.id, entries))
    ) {
      await releaseEntryHandoff(runtime.cluster.apps, nodePool.id);
    }
    for (const vm of live) {
      const node = nodeByVm.get(vm.id);
      if (!node) continue;
      const shouldLabel =
        vm.id === election.vmId ||
        (node.ingressEntry &&
          (vm.id === handoff?.from || vm.id === handoff?.to));
      if (node.ingressEntry !== shouldLabel) {
        await setIngressEntryLabel(
          runtime.cluster.core,
          node,
          shouldLabel ? nodePool.id : null,
        );
        // Service replicas run on the entry (no node-to-node network); a
        // former entry that is still alive gives its replicas up so their
        // Deployments recreate them where Traefik now serves.
        if (!shouldLabel) {
          const evicted = await evictNodePods(runtime.cluster.core, node.name, {
            labelSelector: nodePoolServicePodSelector(),
          });
          if (evicted.length > 0) {
            log.info('Evicted Service replicas from the former ingress entry', {
              id: nodePool.id,
              node: node.name,
              pods: evicted,
            });
          }
        }
      }
    }
    if (election.changed) {
      await recordIngressEntry(nodePool, live, election.vmId);
    }
  }

  /**
   * A pool that hosts no Services keeps no entry, so the former entry Node
   * can go idle (C22). A Service created since the pass began keeps it.
   */
  async function releaseIngressEntry(
    nodePool: StoredNodePool,
    runtime: ClusterRuntime,
    live: NodePoolVM[],
    nodeByVm: Map<number, NodePoolNodeObservation>,
  ): Promise<void> {
    const labelled = [...nodeByVm.values()].filter((node) => node.ingressEntry);
    if (labelled.length === 0 && nodePool.ingressEntryVmId === null) return;
    if ((await deps.references.countServicesForNodePool(nodePool.id)) > 0) {
      return;
    }
    for (const node of labelled) {
      await setIngressEntryLabel(runtime.cluster.core, node, null);
    }
    if (nodePool.ingressEntryVmId !== null) {
      await recordIngressEntry(nodePool, live, null);
    }
  }

  /** Record the pool's entry and tell Service consumers the new public IP. */
  async function recordIngressEntry(
    nodePool: StoredNodePool,
    live: NodePoolVM[],
    vmId: number | null,
  ): Promise<void> {
    const recorded = await deps.nodePools.setIngressEntry(
      nodePool.id,
      vmId,
      now(),
    );
    if (!recorded) return;
    const entry = live.find((vm) => vm.id === vmId);
    log.info('Node pool ingress entry changed', {
      id: nodePool.id,
      vmId,
      ip: entry?.ip ?? null,
    });
    deps.ingress?.entryChanged(
      nodePool.id,
      entry && entry.ip !== null ? { vmId: entry.id, ip: entry.ip } : null,
    );
  }

  async function reconcileDeletion(nodePool: StoredNodePool): Promise<void> {
    let runtime: ClusterRuntime | null = null;
    let nodes: NodePoolNodeObservation[] = [];
    const allVms = await deps.vms.listVms(nodePool.id);
    const vms = activeVms(allVms);
    try {
      runtime = await deps.clusterRuntime.resolve(nodePool.clusterId);
      const observed = await observeNodePoolNodes(
        runtime.cluster.core,
        attemptIdentities(nodePool, allVms),
      );
      nodes = observed.nodes;
      for (const stale of observed.stale) {
        await deleteNodePoolNode(runtime.cluster.core, stale);
      }
    } catch (error) {
      // A cluster that is gone cannot block releasing the node pool's own VMs.
      await deps.nodePools.recordDeletionError(
        nodePool.id,
        errorMessage(error),
      );
    }
    const nodeByVm = nodesByVmRowId(nodes);
    for (const vm of vms) {
      const claimed = await deps.vms.claimVmRemoval(nodePool.id, vm.id);
      if (!claimed) continue;
      await reconcileClaimedRemoval({
        nodePool,
        runtime,
        vm: claimed,
        node: nodeByVm.get(vm.id),
        force: true,
      });
    }
    if (activeVms(await deps.vms.listVms(nodePool.id)).length > 0) return;
    // The deletion request refused live references in its own transaction;
    // this re-check guards the namespace against anything that appeared
    // since (an admission racing an older request, or a record added by a
    // consumer that has not yet joined the request's predicate list).
    const liveReferences = await deps.references.countLiveForNodePool(
      nodePool.id,
    );
    if (liveReferences > 0) {
      await deps.nodePools.recordDeletionError(
        nodePool.id,
        `Node pool ${nodePool.id}: ${liveReferences} Deployment or Service record(s) still reference it; the namespace is kept until they are gone`,
      );
      return;
    }
    if (runtime) {
      // A foreign namespace of the same name is left alone and recorded,
      // never deleted.
      const removal = await deleteNodePoolNamespace(runtime.cluster.core, {
        clusterId: nodePool.clusterId,
        nodePoolId: nodePool.id,
      });
      if (removal === 'foreign') {
        await deps.nodePools.recordDeletionError(
          nodePool.id,
          `Node pool ${nodePool.id}: namespace ${nodePoolNamespace(nodePool.id)} is not owned by this node pool and was left in place`,
        );
      }
      // The pool's ingress release goes with the pool; helm-controller
      // uninstalls it once the HelmChart object is gone. A user-namespace
      // add-on goes with the cluster's last pool that needs it; a pool
      // created meanwhile restores it on its next pass.
      const others = (await deps.nodePools.listForReconciliation()).filter(
        (other) =>
          other.clusterId === nodePool.clusterId && other.id !== nodePool.id,
      );
      const own = userNamespaceNeed(nodePool);
      await clusterAddons.remove(runtime, {
        nvidiaGpus: 0,
        ingressNodePoolId: nodePool.id,
        userNamespace:
          own.userNamespace &&
          !others.some((other) => userNamespaceNeed(other).userNamespace),
        kvm: own.kvm && !others.some((other) => userNamespaceNeed(other).kvm),
      });
    }
    // Every region a row launched in may hold the pool's network, including
    // regions where every launch failed.
    for (const region of new Set(allVms.map((vm) => vm.region))) {
      const compute = await loadCompute(
        nodePool,
        { region, availabilityZone: null },
        'provisioning',
      );
      await compute.terminateResourceNetwork(scopeFor(nodePool));
    }
    await deps.nodePools.markDeleted(nodePool.id);
  }

  async function reconcile(nodePoolId: string): Promise<void> {
    const nodePool = await deps.nodePools.getForScope(nodePoolId, {
      kind: 'api',
    });
    if (!nodePool || nodePool.state === NodePoolState.Deleted) return;
    try {
      if (nodePool.state === NodePoolState.Deleting) {
        await reconcileDeletion(nodePool);
        return;
      }
      if (
        nodePool.maxVmCount < 1 ||
        nodePool.minVmCount > nodePool.maxVmCount
      ) {
        throw new NodePoolActionableError(
          `Node pool ${nodePool.id}: VM bounds must satisfy min ≤ max and 1 ≤ max`,
        );
      }
      const record = await deps.clusterRecords.getForScope(nodePool.clusterId, {
        kind: 'api',
      });
      if (!record || record.state !== ClusterState.Ready) {
        throw new NodePoolActionableError(
          `Node pool ${nodePool.id}: cluster ${nodePool.clusterId} is not ready`,
        );
      }
      const runtime = await deps.clusterRuntime.resolve(record.id);
      await reconcileCapacity(nodePool, runtime);
    } catch (error) {
      const message = errorMessage(error);
      if (nodePool.state === NodePoolState.Deleting) {
        await deps.nodePools.recordDeletionError(nodePool.id, message);
      } else if (operatorActionable(error)) {
        await deps.nodePools.markFailed(nodePool.id, message);
      } else {
        await deps.nodePools.recordError(nodePool.id, message);
      }
      throw error;
    }
  }

  async function observeCapacity(
    nodePoolId: string,
    options?: { requireObservation?: boolean },
  ): Promise<NodePoolCapacityObservation> {
    const nodePool = await deps.nodePools.getForScope(nodePoolId, {
      kind: 'api',
    });
    // VM rows reference their node pool, so a missing pool has none.
    if (!nodePool) {
      return {
        readyVmCount: 0,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      };
    }
    const vms = await deps.vms.listVms(nodePoolId);
    let nodes: NodePoolNodeObservation[] = [];
    try {
      const runtime = await deps.clusterRuntime.resolve(nodePool.clusterId);
      nodes = (
        await observeNodePoolNodes(
          runtime.cluster.core,
          attemptIdentities(nodePool, vms),
        )
      ).nodes;
    } catch (error) {
      // Durable VM rows still provide a useful degraded status response, but
      // admission must not read "unobservable" as "no ready Nodes".
      if (options?.requireObservation) {
        throw new NodePoolCapacityUnavailableError(nodePoolId, error);
      }
    }
    const scaledOut = lastScaleOut.get(nodePoolId);
    return {
      ...summarizeNodePoolCapacity(
        vms,
        nodes,
        expectedNvidiaGpus(nodePool),
        nodePool.cloudProvider,
      ),
      ...(scaledOut && { lastScaleOut: scaledOut }),
    };
  }

  async function assertClusterCompatible(
    clusterId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Admission is rare and must see the cluster as it is now, not as cached.
    const runtime = await deps.clusterRuntime.resolve(clusterId, signal, {
      maxAgeMs: 0,
    });
    assertAgentVersionSkew(runtime.serverVersion);
  }

  async function ingressEntry(
    nodePoolId: string,
  ): Promise<NodePoolIngressEntry | null> {
    const nodePool = await deps.nodePools.getForScope(nodePoolId, {
      kind: 'api',
    });
    if (!nodePool || nodePool.ingressEntryVmId === null) return null;
    const vm = (await deps.vms.listVms(nodePoolId)).find(
      (entry) =>
        entry.id === nodePool.ingressEntryVmId &&
        entry.endedAt === null &&
        entry.ip !== null,
    );
    return vm ? { vmId: vm.id, ip: vm.ip! } : null;
  }

  /**
   * Status view of the pool's ingress: the elected entry and what the cluster
   * reports about the pool's Traefik release. An unreachable cluster degrades
   * to the durable entry with the failure as the release's last event.
   */
  async function ingress(nodePoolId: string): Promise<NodePoolIngressStatus> {
    const nodePool = await deps.nodePools.getForScope(nodePoolId, {
      kind: 'api',
    });
    const entry = await ingressEntry(nodePoolId);
    if (!nodePool || (!entry && nodePool.ingressEntryVmId === null)) {
      return { entryIp: null, release: null };
    }
    const entryIp = entry?.ip ?? null;
    try {
      const runtime = await deps.clusterRuntime.resolve(nodePool.clusterId);
      const { nodes } = await observeNodePoolNodes(
        runtime.cluster.core,
        attemptIdentities(nodePool, await deps.vms.listVms(nodePoolId)),
      );
      const entryNode = nodes.find((node) => node.vmRowId === entry?.vmId);
      const release = await observePoolIngressRelease(runtime.cluster, {
        name: poolIngressReleaseName(nodePoolId),
        nodePoolId,
        entryNodeReady: !!entryNode?.ready && entryNode.ingressEntry,
      });
      return { entryIp, release };
    } catch (error) {
      const lastEvent = `cluster unavailable: ${errorMessage(error)}`;
      return {
        entryIp,
        release: {
          state: 'absent',
          helmJob: null,
          daemonSet: null,
          lastEvent,
          routes: 0,
        },
      };
    }
  }

  return { reconcile, observeCapacity, assertClusterCompatible, ingress };
}
