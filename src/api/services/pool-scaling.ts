import type { V1Pod } from '@kubernetes/client-node';
import { KUBERNETES_MANAGED_BY_LABEL } from './kubernetes/identity.js';
import { NODE_POOL_MEMBER_LABEL } from './kubernetes/node-pool-scheduling.js';
import { ANYCLOUD_POD_FINALIZER } from './kubernetes/pool-objects.js';
import { NVIDIA_GPU_RESOURCE } from './kubernetes/nvidia-device-plugin.js';
import {
  KERNEL_MEMORY_MI,
  NODE_EVICTION_MEMORY_MI,
} from './kubernetes/pod-options.js';
import type { Resources } from './pool-fit.js';

const MI = 2 ** 20;

/** How long a Node stays idle before scale-in removes it (RFC 0048 question 1). */
export const SCALE_IN_IDLE_WINDOW_MS = 10 * 60_000;

/**
 * RFC 0048's demand: anycloud Pods that select this pool's Nodes and that
 * kube-scheduler marked Unschedulable. Pods of other pools, foreign Pods
 * and Pods with any other selector, such as Service replicas pinned to the
 * ingress entry, which a new Node may not satisfy, never buy this pool a
 * Node.
 */
export function pendingPoolPods(
  pods: readonly V1Pod[],
  nodePoolId: string,
): V1Pod[] {
  return pods.filter(
    (pod) =>
      pod.metadata?.labels?.[KUBERNETES_MANAGED_BY_LABEL] === 'anycloud' &&
      pod.spec?.nodeSelector?.[NODE_POOL_MEMBER_LABEL] === nodePoolId &&
      Object.keys(pod.spec.nodeSelector).length === 1 &&
      !pod.spec.nodeName &&
      !pod.metadata.deletionTimestamp &&
      pod.status?.conditions?.some(
        (condition) =>
          condition.type === 'PodScheduled' &&
          condition.reason === 'Unschedulable',
      ),
  );
}

export function daemonSetPod(pod: V1Pod): boolean {
  return (
    pod.metadata?.ownerReferences?.some(
      (owner) => owner.kind === 'DaemonSet',
    ) ?? false
  );
}

/**
 * RFC 0048's busy Pod: an anycloud Pod other than a DaemonSet's (a replica,
 * managed or not, or a pool Service replica), or any Pod that still carries
 * the anycloud finalizer.
 */
function keepsNodeBusy(pod: V1Pod): boolean {
  return (
    (pod.metadata?.labels?.[KUBERNETES_MANAGED_BY_LABEL] === 'anycloud' &&
      !daemonSetPod(pod)) ||
    (pod.metadata?.finalizers?.includes(ANYCLOUD_POD_FINALIZER) ?? false)
  );
}

/**
 * The Nodes that run a busy Pod. `lost` ignores Pods being deleted: Pods
 * Kubernetes already evicted count only through their recreated replicas
 * (RFC 0048 § One seam, one signal). Scale-in counts them.
 */
export function busyNodeNames(
  pods: readonly V1Pod[],
  options: { ignoreDeleting: boolean },
): Set<string> {
  return new Set(
    pods.flatMap((pod) =>
      pod.spec?.nodeName &&
      keepsNodeBusy(pod) &&
      !(options.ignoreDeleting && pod.metadata?.deletionTimestamp)
        ? [pod.spec.nodeName]
        : [],
    ),
  );
}

/**
 * The Node shape Pending Pods are packed onto (question 3): for each
 * resource, the smallest catalog value among the pool's VM types, so it fits
 * whichever type launches. `reserved` is what a usable Node of the pool
 * keeps back: its catalog value less its allocatable, plus its DaemonSet
 * Pods' requests. A value the catalog lacks (ephemeral storage always) is
 * the reference Node's allocatable.
 */
export function poolNodeRoom(
  types: ReadonlyArray<Partial<Resources>>,
  reference: {
    catalog: Partial<Resources>;
    allocatable: Resources;
    daemonSets: readonly Resources[];
  },
): { shape: Resources; reserved: Resources } {
  const names = Object.keys(reference.allocatable) as Array<keyof Resources>;
  const value = (catalog: Partial<Resources>, name: keyof Resources) =>
    catalog[name] ?? reference.allocatable[name];
  const vector = (of: (name: keyof Resources) => number) =>
    Object.fromEntries(names.map((name) => [name, of(name)])) as Resources;
  return {
    shape: vector((name) =>
      Math.min(...types.map((catalog) => value(catalog, name))),
    ),
    reserved: vector(
      (name) =>
        Math.max(
          0,
          value(reference.catalog, name) - reference.allocatable[name],
        ) + reference.daemonSets.reduce((sum, pod) => sum + pod[name], 0),
    ),
  };
}

/**
 * RFC 0049 C22: the room of a pool with no usable Node to read `reserved`
 * from, from the catalog alone. Memory keeps back the larger of 3% of the
 * smallest type (kernel and firmware; inference, the margin backmesh uses)
 * and `KERNEL_MEMORY_MI`, plus the eviction threshold. Nodes reserve no CPU,
 * and no DaemonSet of the pool requests any (the NVIDIA device plugin sets
 * none; Traefik runs only on a Services pool's entry, which keeps a Node).
 * An unknown value is unbounded, so the pass buys one Node and the next
 * reads the rest from it.
 */
export function estimatedPoolNodeRoom(
  types: ReadonlyArray<Partial<Resources>>,
): { shape: Resources; reserved: Resources } {
  const smallest = (name: keyof Resources) =>
    Math.min(...types.map((catalog) => catalog[name] ?? Infinity));
  const memory = smallest('memory');
  return {
    shape: {
      cpu: smallest('cpu'),
      memory,
      [NVIDIA_GPU_RESOURCE]: smallest(NVIDIA_GPU_RESOURCE),
      'ephemeral-storage': smallest('ephemeral-storage'),
    },
    reserved: {
      cpu: 0,
      memory: Number.isFinite(memory)
        ? Math.max(Math.ceil(memory * 0.03), KERNEL_MEMORY_MI * MI) +
          NODE_EVICTION_MEMORY_MI * MI
        : 0,
      [NVIDIA_GPU_RESOURCE]: 0,
      'ephemeral-storage': 0,
    },
  };
}

/**
 * `live + max(0, nodesNeeded + |lost| − inFlight) − |idle|`, clamped to the
 * bounds. In-flight VMs offset demand until their Nodes are usable, so
 * neither a repeated pass nor a restart buys twice for the same Pending Pods.
 */
export function targetVmCount(input: {
  live: number;
  needed: number;
  lost: number;
  inFlight: number;
  idle: number;
  min: number;
  max: number;
}): number {
  const want =
    input.live +
    Math.max(0, input.needed + input.lost - input.inFlight) -
    input.idle;
  return Math.min(input.max, Math.max(input.min, want));
}
