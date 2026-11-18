import { isDeepStrictEqual } from 'node:util';
import type {
  CoreV1Api,
  KubernetesObject,
  V1Namespace,
  V1NetworkPolicy,
} from '@kubernetes/client-node';
import { INSTANCE_METADATA_CIDR } from '../gateways/cloud.js';
import type { ClusterKubernetesClient } from './cluster-client.js';
import {
  isKubernetesNotFoundError,
  serverSideApply,
} from './managed-resources.js';
import {
  NODE_POOL_NODE_LABEL,
  nodePoolNamespace,
  CLUSTER_NODE_LABEL,
} from './node-pool-scheduling.js';
import { releasePodFinalizer } from './pool-objects.js';
import { kubernetesRequestOptions } from './request-options.js';

/**
 * Every node pool owns one namespace on its cluster for the native objects of
 * the Deployment records that target it. The namespace is created by the
 * first Deployment reconcile, shared by every Deployment on the node pool,
 * and removed by node pool deletion once no Deployment references it.
 * Anything with the same name that does not carry the node pool's labels is
 * foreign and fails closed; Anycloud never adopts or deletes it. Every
 * ensure also applies the namespace's default egress NetworkPolicy.
 */
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';

export interface NodePoolNamespaceIdentity {
  clusterId: string;
  nodePoolId: string;
}

export class NodePoolNamespaceOwnershipError extends Error {
  constructor(nodePoolId: string, namespace: string) {
    super(
      `Node pool ${nodePoolId}: namespace ${namespace} exists but is not owned by this node pool; refusing to use a foreign namespace`,
    );
    this.name = 'NodePoolNamespaceOwnershipError';
  }
}

export class NodePoolNamespaceTerminatingError extends Error {
  constructor(nodePoolId: string, namespace: string) {
    super(
      `Node pool ${nodePoolId}: namespace ${namespace} is terminating; retrying`,
    );
    this.name = 'NodePoolNamespaceTerminatingError';
  }
}

function nodePoolNamespaceLabels(
  identity: NodePoolNamespaceIdentity,
): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: 'anycloud',
    [CLUSTER_NODE_LABEL]: identity.clusterId,
    [NODE_POOL_NODE_LABEL]: identity.nodePoolId,
  };
}

export function buildNodePoolNamespace(
  identity: NodePoolNamespaceIdentity,
): V1Namespace {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: nodePoolNamespace(identity.nodePoolId),
      labels: nodePoolNamespaceLabels(identity),
    },
  };
}

export const NODE_POOL_EGRESS_POLICY = 'anycloud-default-egress';
const EGRESS_FIELD_MANAGER = 'anycloud-node-pool-namespace';
/**
 * Every cluster is K3s with its default Pod and Service CIDRs
 * (`system-release/management-host.ts` sets neither).
 */
export const POD_CIDR = '10.42.0.0/16';
const CLUSTER_CIDRS = [POD_CIDR, '10.43.0.0/16'];

/**
 * Replicas may resolve names, reach the other Pods in their node pool, and
 * reach every other address except the cluster's own Pods and Services and
 * the cloud instance metadata. Replicas resolve through their Node
 * (`dnsPolicy: Default`). On GCP that resolver is the metadata address, so
 * its port 53 stays open; Lambda Nodes resolve through the public 1.1.1.1
 * and 8.8.8.8 (e2e-cluster-cloud run 38221310487), which the internet
 * rule allows, as it does every other cloud's resolver.
 * The workload API URL is a public address (hosted) or the host's address
 * (local), so a replica still claims its Jobs.
 */
export function buildNodePoolEgressPolicy(
  identity: NodePoolNamespaceIdentity,
): V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: NODE_POOL_EGRESS_POLICY,
      namespace: nodePoolNamespace(identity.nodePoolId),
      labels: nodePoolNamespaceLabels(identity),
    },
    spec: {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ipBlock: { cidr: INSTANCE_METADATA_CIDR } }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        { to: [{ podSelector: {} }] },
        {
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
                except: [...CLUSTER_CIDRS, INSTANCE_METADATA_CIDR],
              },
            },
          ],
        },
      ],
    },
  };
}

/**
 * Whether the cached egress policy must be (re)applied: it is missing, or a
 * field Anycloud applies differs at all. `podSelector`, `policyTypes` and
 * `egress` are atomic and compared exactly, so an edit that only widens
 * egress is caught; a field another manager added (`ingress`) is not ours to
 * remove and is ignored. Every field the server defaults is set here.
 */
export function egressPolicyDiffers(
  cached: KubernetesObject | undefined,
  identity: NodePoolNamespaceIdentity,
): boolean {
  const desired = buildNodePoolEgressPolicy(identity);
  const current = (cached as V1NetworkPolicy | undefined)?.spec;
  const labels = cached?.metadata?.labels ?? {};
  return (
    !current ||
    (['podSelector', 'policyTypes', 'egress'] as const).some(
      (field) => !isDeepStrictEqual(current[field], desired.spec![field]),
    ) ||
    Object.entries(desired.metadata!.labels!).some(
      ([key, value]) => labels[key] !== value,
    )
  );
}

type NamespaceApi = Pick<
  CoreV1Api,
  'readNamespace' | 'createNamespace' | 'deleteNamespace'
>;

function ownedBy(
  current: V1Namespace,
  identity: NodePoolNamespaceIdentity,
): boolean {
  const labels = current.metadata?.labels ?? {};
  return Object.entries(nodePoolNamespaceLabels(identity)).every(
    ([key, value]) => labels[key] === value,
  );
}

async function read(
  core: Pick<NamespaceApi, 'readNamespace'>,
  name: string,
  signal?: AbortSignal,
): Promise<V1Namespace | null> {
  try {
    return await core.readNamespace({ name }, kubernetesRequestOptions(signal));
  } catch (error) {
    if (isKubernetesNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Create the node pool's namespace or verify the existing one is owned, then
 * apply its default egress policy.
 */
export async function ensureNodePoolNamespace(
  cluster: {
    core: NamespaceApi;
    objects: Pick<ClusterKubernetesClient['objects'], 'patch'>;
  },
  identity: NodePoolNamespaceIdentity,
  signal?: AbortSignal,
): Promise<string> {
  const name = await ensureOwnedNamespace(cluster.core, identity, signal);
  await serverSideApply(
    cluster,
    EGRESS_FIELD_MANAGER,
    buildNodePoolEgressPolicy(identity),
  );
  return name;
}

async function ensureOwnedNamespace(
  core: NamespaceApi,
  identity: NodePoolNamespaceIdentity,
  signal?: AbortSignal,
): Promise<string> {
  const desired = buildNodePoolNamespace(identity);
  const name = desired.metadata!.name!;
  let current = await read(core, name, signal);
  if (!current) {
    try {
      await core.createNamespace(
        { body: desired },
        kubernetesRequestOptions(signal),
      );
      return name;
    } catch (error) {
      current = await read(core, name, signal);
      if (!current) throw error;
    }
  }
  if (!ownedBy(current, identity)) {
    throw new NodePoolNamespaceOwnershipError(identity.nodePoolId, name);
  }
  if (current.metadata?.deletionTimestamp) {
    throw new NodePoolNamespaceTerminatingError(identity.nodePoolId, name);
  }
  return name;
}

export type NodePoolNamespaceRemoval = 'deleted' | 'absent' | 'foreign';

/**
 * Delete the node pool's namespace by exact UID when Anycloud owns it. A
 * foreign namespace of the same name is left alone and reported so the
 * caller can record it without blocking the node pool's own teardown.
 */
export async function deleteNodePoolNamespace(
  core: NamespaceApi &
    Pick<CoreV1Api, 'listNamespacedPod' | 'patchNamespacedPod'>,
  identity: NodePoolNamespaceIdentity,
  signal?: AbortSignal,
): Promise<NodePoolNamespaceRemoval> {
  const name = nodePoolNamespace(identity.nodePoolId);
  const current = await read(core, name, signal);
  if (!current) return 'absent';
  if (!ownedBy(current, identity) || !current.metadata?.uid) return 'foreign';
  // No record references the pool any more, so no Pod's outcome is still
  // owed; a finalizer left behind would hold the namespace terminating.
  const pods = await core.listNamespacedPod(
    { namespace: name },
    kubernetesRequestOptions(signal),
  );
  for (const pod of pods.items) await releasePodFinalizer(core, pod);
  try {
    await core.deleteNamespace(
      { name, body: { preconditions: { uid: current.metadata.uid } } },
      kubernetesRequestOptions(signal),
    );
  } catch (error) {
    if (!isKubernetesNotFoundError(error)) throw error;
  }
  return 'deleted';
}
