import type { V1Container, V1Node, V1Pod } from '@kubernetes/client-node';
import { NVIDIA_GPU_RESOURCE } from './kubernetes/nvidia-device-plugin.js';

const RESOURCES = [
  'cpu',
  'memory',
  NVIDIA_GPU_RESOURCE,
  'ephemeral-storage',
] as const;

/** Millicores, bytes, whole GPUs and bytes, keyed by Kubernetes name. */
export type Resources = Record<(typeof RESOURCES)[number], number>;

const SUFFIXES: Record<string, number> = { '': 1, n: 1e-9, u: 1e-6, m: 1e-3 };
for (const [power, prefix] of ['K', 'M', 'G', 'T', 'P', 'E'].entries()) {
  SUFFIXES[prefix === 'K' ? 'k' : prefix] = 1000 ** (power + 1);
  SUFFIXES[`${prefix}i`] = 1024 ** (power + 1);
}

/** A Kubernetes quantity, rounded up to whole units of `1 / scale`. */
export function quantity(raw: string, scale = 1): number {
  const [, number, suffix] =
    /^([\d.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(raw) ?? [];
  const multiplier = suffix === undefined ? undefined : SUFFIXES[suffix];
  if (multiplier === undefined) {
    throw new Error(`Unknown Kubernetes quantity ${raw}`);
  }
  return Math.ceil(Number((Number(number) * multiplier * scale).toFixed(6)));
}

function request(container: V1Container, name: keyof Resources): number {
  const raw = container.resources?.requests?.[name];
  return raw === undefined ? 0 : quantity(raw, name === 'cpu' ? 1000 : 1);
}

/** A Node's `capacity` or `allocatable` map as a vector; absent is 0. */
export function nodeResources(
  quantities: Record<string, string> | undefined,
): Resources {
  return Object.fromEntries(
    RESOURCES.map((name) => [
      name,
      quantity(quantities?.[name] ?? '0', name === 'cpu' ? 1000 : 1),
    ]),
  ) as Resources;
}

/** A Pod's request vector: the sum of its containers' requests. */
export function podRequests(pod: V1Pod): Resources {
  const containers = pod.spec?.containers ?? [];
  return Object.fromEntries(
    RESOURCES.map((name) => [
      name,
      containers.reduce((sum, c) => sum + request(c, name), 0),
    ]),
  ) as Resources;
}

/** A request's largest share of a Node's `room`, over every resource. */
export function share(request: Resources, room: Resources): number {
  return Math.max(
    ...RESOURCES.map((name) => request[name] / (room[name] || 1)),
  );
}

function fits(request: Resources, free: Resources): boolean {
  return RESOURCES.every((name) => request[name] <= free[name]);
}

/**
 * The Nodes of one shape that hold every request: first-fit decreasing by
 * each request's largest share of a Node, after the DaemonSet and system
 * `reserved` resources. A request no empty Node holds adds no Node, since
 * another Node of the shape can't place it either.
 */
export function nodesNeeded(
  shape: Resources,
  reserved: Resources,
  requests: readonly Resources[],
): number {
  const room = Object.fromEntries(
    RESOURCES.map((name) => [name, shape[name] - reserved[name]]),
  ) as Resources;
  const nodes: Resources[] = [];
  for (const r of requests
    .filter((r) => fits(r, room))
    .sort((a, b) => share(b, room) - share(a, room))) {
    let node = nodes.find((free) => fits(r, free));
    if (!node) nodes.push((node = { ...room }));
    for (const name of RESOURCES) node[name] -= r[name];
  }
  return nodes.length;
}

/**
 * RFC 0044's share: the largest fraction of its Node's allocatable CPU,
 * memory or GPUs that a Pod's container requests take.
 */
export function podShare(
  pod: V1Pod,
  node: V1Node,
): { share: number; gpus: number } {
  const allocatable = (name: string, scale = 1) =>
    quantity(node.status?.allocatable?.[name] ?? '0', scale);
  const requests = podRequests(pod);
  return {
    share: share(
      { ...requests, 'ephemeral-storage': 0 },
      {
        cpu: allocatable('cpu', 1000),
        memory: allocatable('memory'),
        [NVIDIA_GPU_RESOURCE]: allocatable(NVIDIA_GPU_RESOURCE),
        'ephemeral-storage': 0,
      },
    ),
    gpus: requests[NVIDIA_GPU_RESOURCE],
  };
}
