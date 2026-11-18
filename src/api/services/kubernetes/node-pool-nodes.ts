import {
  setHeaderOptions,
  type CoreV1Api,
  type V1Node,
} from '@kubernetes/client-node';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
} from './managed-resources.js';
import { NVIDIA_GPU_RESOURCE } from './nvidia-device-plugin.js';
import { nodeResources, type Resources } from '../pool-fit.js';
import {
  ACCELERATOR_NODE_LABEL,
  ATTEMPT_NODE_LABEL,
  INGRESS_ENTRY_NODE_LABEL,
  isNodePoolAttemptId,
  JOIN_REVISION_NODE_LABEL,
  NODE_POOL_JOIN_REVISION,
  NODE_POOL_MEMBER_LABEL,
  NODE_POOL_NODE_LABEL,
  nodePoolNodeName,
  nodePoolNodeNamePrefix,
  CLUSTER_NODE_LABEL,
  UNUSABLE_GPU_NODE_LABEL,
} from './node-pool-scheduling.js';
import { kubernetesRequestOptions } from './request-options.js';

export interface NodePoolNodeObservation {
  name: string;
  vmRowId: number;
  ready: boolean;
  /** When the Ready condition last changed; `null` when Kubernetes omits it. */
  readyTransitionAt: number | null;
  /**
   * `status.allocatable[nvidia.com/gpu]`: the total the device plugin
   * advertises, including devices held by running Pods. Free devices are a
   * scheduler concern; readiness only asks whether registration is complete.
   */
  allocatableGpus: number;
  /** `status.allocatable`, which the scaling policy packs Pending Pods into. */
  allocatable: Resources;
  /** Kubernetes' `node.kubernetes.io/not-ready` taint, which repels new Pods. */
  notReadyTaint: boolean;
  /** The `anycloud.sh/accelerator` label, which cluster add-ons select on. */
  accelerator: string | null;
  /** Whether the controller already set this pool's `NODE_POOL_MEMBER_LABEL`. */
  member: boolean;
  /** Whether the Node carries this pool's `anycloud.sh/ingress-entry` label. */
  ingressEntry: boolean;
  /** Whether it joined with another join script than this API's, or none. */
  outdated: boolean;
  /** Whether a Job's log showed an unusable GPU on it. */
  unusableGpu: boolean;
  /** Scale-in's claim time, written before its claim (RFC 0048 § Scale-in). */
  scaleInStamp: number | null;
  uid: string;
}

/** The time of scale-in's claim on the Node's VM, in epoch milliseconds. */
const SCALE_IN_NODE_ANNOTATION = 'anycloud.sh/scale-in';

export interface NodePoolNodeObservations {
  /** Nodes that belong to a live attempt of this node pool. */
  nodes: NodePoolNodeObservation[];
  /**
   * Nodes whose bootstrap identity maps to an attempt this node pool already
   * ended. They are removed by exact UID and never counted.
   */
  stale: Array<Pick<NodePoolNodeObservation, 'name' | 'uid'>>;
  /**
   * Nodes that claim this node pool — by label or by the deterministic
   * bootstrap Node name — without the exact identity a VM the node pool
   * provisioned would have. They are never counted and fail the node pool.
   */
  foreign: string[];
  /**
   * Nodes that claim this node pool by label alone while another node pool
   * made them members or named them. Pods select the protected
   * membership label, so the claim attracts none of them; it is reported,
   * never counted, and never fails the node pool.
   */
  ignored: string[];
}

export interface NodePoolAttemptIdentities {
  clusterId: string;
  nodePoolId: string;
  liveVmRowIds: ReadonlySet<number>;
  endedVmRowIds: ReadonlySet<number>;
}

type NodeApi = Pick<
  CoreV1Api,
  | 'listNode'
  | 'patchNode'
  | 'deleteNode'
  | 'listPodForAllNamespaces'
  | 'deleteNamespacedPod'
>;

function readyCondition(node: V1Node) {
  return node.status?.conditions?.find(
    (condition) => condition.type === 'Ready',
  );
}

function allocatableGpus(node: V1Node, name: string): number {
  const raw = node.status?.allocatable?.[NVIDIA_GPU_RESOURCE] ?? '0';
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    throw new Error(
      `Node ${name} reported invalid ${NVIDIA_GPU_RESOURCE} allocatable capacity`,
    );
  }
  return parsed;
}

function claimsByName(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length));
}

/** Any node pool's bootstrap Node name, as `nodePoolNodeName` forms it. */
const BOOTSTRAP_NODE_NAME = /^anycloud-[a-z0-9-]+-\d+$/;

function attemptFromName(name: string, prefix: string): number | null {
  if (!claimsByName(name, prefix)) return null;
  const suffix = name.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  const attempt = Number(suffix);
  return isNodePoolAttemptId(attempt) ? attempt : null;
}

/**
 * Observe every Node and classify the ones that claim this node pool. A Node
 * counts only when its labels and name agree with one live attempt; a Node
 * matching an ended attempt is stale-owned; anything else claiming the
 * node pool, including an unlabelled Node registered under a bootstrap name
 * this node pool issued, is foreign and fails closed, unless only its label
 * claims the node pool and it belongs to another one.
 */
export async function observeNodePoolNodes(
  core: Pick<NodeApi, 'listNode'>,
  input: NodePoolAttemptIdentities,
  signal?: AbortSignal,
): Promise<NodePoolNodeObservations> {
  const list = await core.listNode({}, kubernetesRequestOptions(signal));
  const prefix = nodePoolNodeNamePrefix(input.nodePoolId);
  const nodes: NodePoolNodeObservation[] = [];
  const stale: NodePoolNodeObservations['stale'] = [];
  const foreign: string[] = [];
  const ignored: string[] = [];
  for (const node of list.items) {
    const name = node.metadata?.name ?? '<unnamed>';
    const labels = node.metadata?.labels ?? {};
    const claimsNodePool =
      labels[NODE_POOL_NODE_LABEL] === input.nodePoolId ||
      claimsByName(name, prefix);
    if (!claimsNodePool) continue;
    if (
      !claimsByName(name, prefix) &&
      (BOOTSTRAP_NODE_NAME.test(name) ||
        (labels[NODE_POOL_MEMBER_LABEL] ?? input.nodePoolId) !==
          input.nodePoolId)
    ) {
      ignored.push(name);
      continue;
    }

    // A label outside the attempt-id range is a foreign claim, never a
    // thrown error, so the diagnostic can still name the Node.
    const labelledAttempt = Number(labels[ATTEMPT_NODE_LABEL]);
    const namedAttempt = attemptFromName(name, prefix);
    const identity =
      isNodePoolAttemptId(labelledAttempt) &&
      labels[NODE_POOL_NODE_LABEL] === input.nodePoolId &&
      labels[CLUSTER_NODE_LABEL] === input.clusterId &&
      name === nodePoolNodeName(input.nodePoolId, labelledAttempt) &&
      node.metadata?.uid
        ? labelledAttempt
        : null;

    if (identity !== null && input.liveVmRowIds.has(identity)) {
      const ready = readyCondition(node);
      const transition = ready?.lastTransitionTime;
      nodes.push({
        name,
        vmRowId: identity,
        ready: ready?.status === 'True',
        readyTransitionAt:
          transition instanceof Date
            ? transition.getTime()
            : typeof transition === 'string'
              ? new Date(transition).getTime()
              : null,
        allocatableGpus: allocatableGpus(node, name),
        allocatable: nodeResources(node.status?.allocatable),
        notReadyTaint: (node.spec?.taints ?? []).some(
          (taint) => taint.key === 'node.kubernetes.io/not-ready',
        ),
        accelerator: labels[ACCELERATOR_NODE_LABEL] ?? null,
        member: labels[NODE_POOL_MEMBER_LABEL] === input.nodePoolId,
        ingressEntry: labels[INGRESS_ENTRY_NODE_LABEL] === input.nodePoolId,
        outdated: labels[JOIN_REVISION_NODE_LABEL] !== NODE_POOL_JOIN_REVISION,
        unusableGpu: labels[UNUSABLE_GPU_NODE_LABEL] === 'true',
        scaleInStamp:
          Number(node.metadata?.annotations?.[SCALE_IN_NODE_ANNOTATION]) ||
          null,
        uid: node.metadata!.uid!,
      });
      continue;
    }
    const staleAttempt = identity ?? namedAttempt;
    if (
      staleAttempt !== null &&
      input.endedVmRowIds.has(staleAttempt) &&
      !input.liveVmRowIds.has(staleAttempt) &&
      node.metadata?.uid
    ) {
      stale.push({ name, uid: node.metadata.uid });
      continue;
    }
    foreign.push(name);
  }
  return { nodes, stale, foreign, ignored };
}

/**
 * Cordon a Node a Job found an unusable GPU on and label it, so the node pool
 * controller replaces it.
 */
export async function markNodePoolNodeGpuUnusable(
  core: Pick<NodeApi, 'patchNode'>,
  nodeName: string,
): Promise<void> {
  await core.patchNode(
    {
      name: nodeName,
      body: {
        metadata: { labels: { [UNUSABLE_GPU_NODE_LABEL]: 'true' } },
        spec: { unschedulable: true },
      },
    },
    setHeaderOptions(
      'Content-Type',
      'application/merge-patch+json',
      kubernetesRequestOptions(),
    ),
  );
}

/**
 * Stop new Pods landing on a Node that is about to be released, or, with
 * `cordoned` false, let them land again on one that scale-in keeps.
 */
export async function cordonNodePoolNode(
  core: Pick<NodeApi, 'patchNode'>,
  nodeName: string,
  cordoned = true,
  signal?: AbortSignal,
): Promise<void> {
  await core.patchNode(
    { name: nodeName, body: { spec: { unschedulable: cordoned } } },
    setHeaderOptions(
      'Content-Type',
      'application/merge-patch+json',
      kubernetesRequestOptions(signal),
    ),
  );
}

/**
 * Write scale-in's claim time on the Node, or remove it with `null`; the UID
 * in the patch body fences a same-name successor.
 */
export async function stampNodePoolNodeScaleIn(
  core: Pick<NodeApi, 'patchNode'>,
  node: Pick<NodePoolNodeObservation, 'name' | 'uid'>,
  at: number | null,
  signal?: AbortSignal,
): Promise<void> {
  await core.patchNode(
    {
      name: node.name,
      body: {
        metadata: {
          uid: node.uid,
          annotations: {
            [SCALE_IN_NODE_ANNOTATION]: at === null ? null : String(at),
          },
        },
      },
    },
    setHeaderOptions(
      'Content-Type',
      'application/merge-patch+json',
      kubernetesRequestOptions(signal),
    ),
  );
}

/**
 * Add labels to an owned Node; the UID in the patch body fences a same-name
 * successor.
 */
export async function labelNodePoolNode(
  core: Pick<NodeApi, 'patchNode'>,
  node: Pick<NodePoolNodeObservation, 'name' | 'uid'>,
  labels: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  await core.patchNode(
    { name: node.name, body: { metadata: { uid: node.uid, labels } } },
    setHeaderOptions(
      'Content-Type',
      'application/merge-patch+json',
      kubernetesRequestOptions(signal),
    ),
  );
}

/**
 * Delete the Pods bound to a Node — every one when the Node goes (its VM is
 * gone, so grace 0: nothing is left to shut down, and a Deployment with
 * `Recreate` would otherwise wait for the orphan until the Pod garbage
 * collector notices), or those matching `labelSelector` gracefully when the
 * Node stays but should no longer run them. Returns the Pods it deleted.
 */
export async function evictNodePods(
  core: Pick<NodeApi, 'listPodForAllNamespaces' | 'deleteNamespacedPod'>,
  nodeName: string,
  options: { labelSelector?: string; gracePeriodSeconds?: number },
  signal?: AbortSignal,
): Promise<string[]> {
  const { items } = await core.listPodForAllNamespaces(
    {
      fieldSelector: `spec.nodeName=${nodeName}`,
      labelSelector: options.labelSelector,
    },
    kubernetesRequestOptions(signal),
  );
  const evicted: string[] = [];
  for (const pod of items) {
    const namespace = pod.metadata?.namespace ?? '';
    const name = pod.metadata?.name ?? '';
    try {
      await core.deleteNamespacedPod(
        {
          name,
          namespace,
          gracePeriodSeconds: options.gracePeriodSeconds,
          body: { preconditions: { uid: pod.metadata?.uid } },
        },
        kubernetesRequestOptions(signal),
      );
      evicted.push(`${namespace}/${name}`);
    } catch (error) {
      if (!isKubernetesNotFoundError(error)) throw error;
    }
  }
  return evicted;
}

/**
 * One step of `kubectl drain --ignore-daemonsets` on a cordoned Node through
 * the Eviction API, which respects PodDisruptionBudgets. Returns how many
 * Pods remain: refused (429) or terminating.
 */
export async function drainNodePoolNode(
  core: Pick<
    CoreV1Api,
    'listPodForAllNamespaces' | 'createNamespacedPodEviction'
  >,
  nodeName: string,
  signal?: AbortSignal,
): Promise<number> {
  const { items } = await core.listPodForAllNamespaces(
    { fieldSelector: `spec.nodeName=${nodeName}` },
    kubernetesRequestOptions(signal),
  );
  let remaining = 0;
  for (const pod of items) {
    if (
      pod.metadata?.ownerReferences?.some((ref) => ref.kind === 'DaemonSet') ||
      pod.metadata?.annotations?.['kubernetes.io/config.mirror'] ||
      pod.status?.phase === 'Succeeded' ||
      pod.status?.phase === 'Failed'
    ) {
      continue;
    }
    remaining += 1;
    if (pod.metadata?.deletionTimestamp) continue;
    const name = pod.metadata?.name ?? '';
    const namespace = pod.metadata?.namespace ?? '';
    try {
      await core.createNamespacedPodEviction(
        {
          name,
          namespace,
          body: {
            apiVersion: 'policy/v1',
            kind: 'Eviction',
            metadata: { name, namespace },
            deleteOptions: { preconditions: { uid: pod.metadata?.uid } },
          },
        },
        kubernetesRequestOptions(signal),
      );
    } catch (error) {
      // 429: a PodDisruptionBudget refuses for now; 409: the UID moved on.
      if (isKubernetesNotFoundError(error)) remaining -= 1;
      else if (
        !isKubernetesConflictError(error) &&
        (error as { code?: number }).code !== 429
      ) {
        throw error;
      }
    }
  }
  return remaining;
}

/**
 * Remove the Node object by exact UID so a same-name successor survives —
 * after force-deleting the Pods still bound to it, so their controllers
 * replace them at once instead of waiting for the Pod garbage collector.
 */
export async function deleteNodePoolNode(
  core: Pick<
    NodeApi,
    'deleteNode' | 'listPodForAllNamespaces' | 'deleteNamespacedPod'
  >,
  node: Pick<NodePoolNodeObservation, 'name' | 'uid'>,
  signal?: AbortSignal,
): Promise<void> {
  await evictNodePods(core, node.name, { gracePeriodSeconds: 0 }, signal);
  try {
    await core.deleteNode(
      { name: node.name, body: { preconditions: { uid: node.uid } } },
      kubernetesRequestOptions(signal),
    );
  } catch (error) {
    if (!isKubernetesNotFoundError(error)) throw error;
  }
}
