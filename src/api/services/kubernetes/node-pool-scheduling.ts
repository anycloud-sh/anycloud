import { createHash } from 'node:crypto';
import type {
  V1Container,
  V1NodeSelectorRequirement,
  V1PodSpec,
  V1Taint,
  V1Toleration,
} from '@kubernetes/client-node';
import type { CloudType } from '../../../shared/cloud.js';
import {
  NVIDIA_GPU_RESOURCE,
  NVIDIA_RUNTIME_CLASS,
} from './nvidia-device-plugin.js';

/**
 * Required node pool scheduling. Every node pool Node registers these labels
 * and a node pool taint; the management Node carries the management taint. A
 * user Pod must select one node pool and tolerate only that node pool's taint,
 * so a missing or deleted node pool leaves it Pending instead of spilling onto
 * a sibling node pool or the management Node. The Node sets these labels
 * itself, so they are for display; Pods select `NODE_POOL_MEMBER_LABEL`.
 */
export const NODE_POOL_NODE_LABEL = 'anycloud.sh/node-pool';
/**
 * Pool membership the node pool controller sets once it matches a Node by
 * name to a live VM attempt of the pool. NodeRestriction refuses a kubelet
 * any `node-restriction.kubernetes.io/` label on its own Node, so a Node with
 * a rooted kubelet can't move itself into another pool.
 */
export const NODE_POOL_MEMBER_LABEL =
  'node-restriction.kubernetes.io/anycloud-node-pool';
export const CLUSTER_NODE_LABEL = 'anycloud.sh/cluster';
const PROVIDER_NODE_LABEL = 'anycloud.sh/provider';
export const ATTEMPT_NODE_LABEL = 'anycloud.sh/attempt';
/**
 * Set at join on Nodes whose VM type carries NVIDIA devices. Cluster-scoped
 * add-ons select on it, so the management Node and CPU node pools never run
 * the device plugin.
 */
export const ACCELERATOR_NODE_LABEL = 'anycloud.sh/accelerator';
/** Carried by the one Node per node pool that runs the pool's ingress. */
export const INGRESS_ENTRY_NODE_LABEL = 'anycloud.sh/ingress-entry';
/** Set on a Node a Job's log showed an unusable GPU on; the pool replaces it. */
export const UNUSABLE_GPU_NODE_LABEL = 'anycloud.sh/unusable-gpu';
export const JOIN_REVISION_NODE_LABEL = 'anycloud.sh/join-revision';
/**
 * The pool join script's revision, which each Node registers as
 * `JOIN_REVISION_NODE_LABEL`. Bump it when a change to
 * `buildNodePoolAgentStartupScript` must reach Nodes that already joined: the
 * node pool controller replaces every Node of another revision, or of none.
 * 1: the metadata block. 2: the inotify limit.
 * 3: every 0.1.71 change: unpigz and Azure's resource-disk store,
 * and the NVIDIA fabric gate. 4: the 0.1.73 changes existing Nodes
 * need: the Node cache on the scratch disk and the image pre-pull;
 * a newer handler reaches only new `--user-namespace-jobs` pools.
 * The revision only tells released versions apart, so a release bumps it at
 * most once. `node-pool-join.spec.ts` pins the script's hash with it.
 */
export const NODE_POOL_JOIN_REVISION = '4';
export const NVIDIA_ACCELERATOR_LABEL_VALUE = 'nvidia';
export const MANAGEMENT_TAINT_KEY = 'anycloud.sh/management';
const NODE_POOL_TAINT_KEY = NODE_POOL_NODE_LABEL;
const DNS_LABEL_MAX_LENGTH = 63;

export const MANAGEMENT_NODE_TAINT: Readonly<V1Taint> = Object.freeze({
  key: MANAGEMENT_TAINT_KEY,
  value: 'true',
  effect: 'NoSchedule',
});

export interface NodePoolNodeIdentity {
  clusterId: string;
  nodePoolId: string;
  cloudProvider: CloudType;
  vmRowId: number;
  /** Present when the node pool's VM type carries NVIDIA devices. */
  accelerator?: typeof NVIDIA_ACCELERATOR_LABEL_VALUE;
}

function dnsSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

/** Deterministic namespace for a node pool's native objects. */
export function nodePoolNamespace(nodePoolId: string): string {
  const prefix = 'anycloud-node-pool';
  const suffix = `-${createHash('sha256').update(nodePoolId).digest('hex').slice(0, 10)}`;
  const slugLength = DNS_LABEL_MAX_LENGTH - prefix.length - 1 - suffix.length;
  const slug =
    dnsSegment(nodePoolId).slice(0, slugLength).replace(/-+$/g, '') || 'x';
  return `${prefix}-${slug}${suffix}`;
}

// Attempt ids are the ledger's INTEGER PRIMARY KEY; reserving this many digits
// keeps the prefix stable for every attempt of a node pool.
const NODE_NAME_ATTEMPT_DIGITS = 12;

/**
 * Deterministic Node-name prefix for a node pool. Every attempt's Node is
 * `<prefix><vmRowId>`, so an unlabelled Node registered with a token this
 * node pool issued is still recognisable as claiming the node pool.
 */
export function nodePoolNodeNamePrefix(nodePoolId: string): string {
  const prefix = 'anycloud-';
  const slugLength =
    DNS_LABEL_MAX_LENGTH - prefix.length - 1 - NODE_NAME_ATTEMPT_DIGITS;
  return `${prefix}${dnsSegment(nodePoolId).slice(0, slugLength).replace(/-+$/g, '')}-`;
}

/** Whether a value can be a ledger attempt id carried in a Node name. */
export function isNodePoolAttemptId(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    String(value).length <= NODE_NAME_ATTEMPT_DIGITS
  );
}

/** Deterministic Node name for one VM attempt. */
export function nodePoolNodeName(nodePoolId: string, vmRowId: number): string {
  if (!isNodePoolAttemptId(vmRowId)) {
    throw new Error('Node pool VM row id must be a positive integer');
  }
  return `${nodePoolNodeNamePrefix(nodePoolId)}${vmRowId}`;
}

export function nodePoolNodeLabels(
  identity: NodePoolNodeIdentity,
): Record<string, string> {
  return {
    [CLUSTER_NODE_LABEL]: identity.clusterId,
    [NODE_POOL_NODE_LABEL]: identity.nodePoolId,
    [PROVIDER_NODE_LABEL]: identity.cloudProvider.toLowerCase(),
    [ATTEMPT_NODE_LABEL]: String(identity.vmRowId),
    [JOIN_REVISION_NODE_LABEL]: NODE_POOL_JOIN_REVISION,
    ...(identity.accelerator
      ? { [ACCELERATOR_NODE_LABEL]: identity.accelerator }
      : {}),
  };
}

export function nodePoolNodeTaints(nodePoolId: string): V1Taint[] {
  return [
    { key: NODE_POOL_TAINT_KEY, value: nodePoolId, effect: 'NoSchedule' },
  ];
}

export interface NodePoolPodScheduling {
  nodeSelector: Record<string, string>;
  affinity: NonNullable<V1PodSpec['affinity']>;
  tolerations: V1Toleration[];
}

/** Scheduling every user Pod on a node pool must carry. */
export function nodePoolPodScheduling(
  clusterId: string,
  nodePoolId: string,
): NodePoolPodScheduling {
  const requirements: V1NodeSelectorRequirement[] = [
    { key: NODE_POOL_MEMBER_LABEL, operator: 'In', values: [nodePoolId] },
    { key: CLUSTER_NODE_LABEL, operator: 'In', values: [clusterId] },
  ];
  return {
    nodeSelector: { [NODE_POOL_MEMBER_LABEL]: nodePoolId },
    affinity: {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [{ matchExpressions: requirements }],
        },
      },
    },
    tolerations: [
      {
        key: NODE_POOL_TAINT_KEY,
        operator: 'Equal',
        value: nodePoolId,
        effect: 'NoSchedule',
      },
    ],
  };
}

/**
 * Return a Pod spec constrained to one node pool. Existing selectors and
 * affinity are replaced; existing tolerations are kept only when they cannot
 * admit the Pod onto management or sibling-node-pool capacity.
 */
export function applyNodePoolScheduling(
  spec: V1PodSpec,
  clusterId: string,
  nodePoolId: string,
): V1PodSpec {
  const scheduling = nodePoolPodScheduling(clusterId, nodePoolId);
  const retained = (spec.tolerations ?? []).filter(
    (toleration) => !toleratesForeignCapacity(toleration, nodePoolId),
  );
  return {
    ...spec,
    nodeSelector: scheduling.nodeSelector,
    affinity: scheduling.affinity,
    tolerations: [...retained, ...scheduling.tolerations],
  };
}

function toleratesForeignCapacity(
  toleration: V1Toleration,
  nodePoolId: string,
): boolean {
  if (!toleration.key) return true; // wildcard tolerates every taint
  if (toleration.key === MANAGEMENT_TAINT_KEY) return true;
  if (toleration.key === NODE_POOL_TAINT_KEY) {
    return toleration.operator === 'Exists' || toleration.value !== nodePoolId;
  }
  return false;
}

export interface NodePoolCapabilityConstraint {
  /** Physical NVIDIA devices each Node of the node pool advertises; 0 for CPU. */
  nvidiaGpus: number;
}

function containerNvidiaGpus(container: V1Container): number {
  const raw =
    container.resources?.limits?.[NVIDIA_GPU_RESOURCE] ??
    container.resources?.requests?.[NVIDIA_GPU_RESOURCE];
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Container ${container.name} requests ${NVIDIA_GPU_RESOURCE}=${raw}; whole devices only`,
    );
  }
  return Number(raw);
}

/**
 * The Pod's effective request as the scheduler computes it: init containers
 * run one at a time before the regular containers, so the Pod needs the
 * larger of the biggest init request and the regular containers' sum.
 */
export function requestedNvidiaGpus(spec: V1PodSpec): number {
  const init = Math.max(
    0,
    ...(spec.initContainers ?? []).map(containerNvidiaGpus),
  );
  const main = spec.containers.reduce(
    (total, container) => total + containerNvidiaGpus(container),
    0,
  );
  return Math.max(init, main);
}

/**
 * GPU node pools only give devices to Pods that ask for them through the
 * device plugin and run under the NVIDIA runtime; CPU node pools can never
 * satisfy a GPU request, so such a Pod would stay Pending forever.
 */
export function assertNodePoolCapability(
  spec: V1PodSpec,
  constraint: NodePoolCapabilityConstraint,
): void {
  const requested = requestedNvidiaGpus(spec);
  if (constraint.nvidiaGpus === 0) {
    if (requested > 0) {
      throw new Error(
        `Pod spec requests ${requested} ${NVIDIA_GPU_RESOURCE} but the node pool has CPU capacity only`,
      );
    }
    if (spec.runtimeClassName === NVIDIA_RUNTIME_CLASS) {
      throw new Error(
        `Pod spec selects the ${NVIDIA_RUNTIME_CLASS} runtime on a CPU node pool`,
      );
    }
    return;
  }
  if (requested === 0) {
    throw new Error(
      `Pod spec requests no ${NVIDIA_GPU_RESOURCE}; Pods on a GPU node pool must request whole devices`,
    );
  }
  if (requested > constraint.nvidiaGpus) {
    throw new Error(
      `Pod spec requests ${requested} ${NVIDIA_GPU_RESOURCE} but each node pool Node advertises ${constraint.nvidiaGpus}`,
    );
  }
  if (spec.runtimeClassName !== NVIDIA_RUNTIME_CLASS) {
    throw new Error(
      `Pod spec must run under the ${NVIDIA_RUNTIME_CLASS} runtime class to receive ${NVIDIA_GPU_RESOURCE} devices`,
    );
  }
}

/** Throw when a Pod spec could schedule outside the selected node pool. */
export function assertNodePoolScheduling(
  spec: V1PodSpec,
  clusterId: string,
  nodePoolId: string,
  capability?: NodePoolCapabilityConstraint,
): void {
  if (capability) assertNodePoolCapability(spec, capability);
  if (spec.nodeName) {
    throw new Error(
      `Pod spec names Node ${spec.nodeName} directly and would bypass node pool scheduling`,
    );
  }
  if (spec.schedulerName && spec.schedulerName !== 'default-scheduler') {
    throw new Error(
      `Pod spec selects scheduler ${spec.schedulerName}; node pool constraints require the default scheduler`,
    );
  }
  const expected = nodePoolPodScheduling(clusterId, nodePoolId);
  if (spec.nodeSelector?.[NODE_POOL_MEMBER_LABEL] !== nodePoolId) {
    throw new Error(`Pod spec does not select node pool ${nodePoolId}`);
  }
  const terms =
    spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution
      ?.nodeSelectorTerms ?? [];
  const requiresNodePool =
    terms.length > 0 &&
    terms.every((term) =>
      expected.affinity.nodeAffinity!.requiredDuringSchedulingIgnoredDuringExecution!.nodeSelectorTerms[0].matchExpressions!.every(
        (required) =>
          term.matchExpressions?.some(
            (expression) =>
              expression.key === required.key &&
              expression.operator === 'In' &&
              expression.values?.length === 1 &&
              expression.values[0] === required.values![0],
          ),
      ),
    );
  if (!requiresNodePool) {
    throw new Error(
      `Pod spec does not require node pool ${nodePoolId} in cluster ${clusterId}`,
    );
  }
  const foreign = (spec.tolerations ?? []).find((toleration) =>
    toleratesForeignCapacity(toleration, nodePoolId),
  );
  if (foreign) {
    throw new Error(
      `Pod spec tolerates capacity outside node pool ${nodePoolId} (${foreign.key ?? 'wildcard'})`,
    );
  }
  if (
    !(spec.tolerations ?? []).some(
      (toleration) =>
        toleration.key === NODE_POOL_TAINT_KEY &&
        toleration.operator === 'Equal' &&
        toleration.value === nodePoolId &&
        toleration.effect === 'NoSchedule',
    )
  ) {
    throw new Error(`Pod spec does not tolerate node pool ${nodePoolId}`);
  }
}
