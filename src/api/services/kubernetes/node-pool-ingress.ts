import { createHash } from 'node:crypto';
import {
  setHeaderOptions,
  type AppsV1Api,
  type CoreV1Api,
  type CoreV1Event,
  type KubernetesObjectApi,
  type V1Job,
  type V1Pod,
} from '@kubernetes/client-node';
import { CLOUDFLARE_IP_RANGES } from '../../../shared/cloudflare-ips.js';
import type { IngressSpec } from '../entities.js';
import type { NodePoolVM } from '../cluster-store.js';
import { SERVICE_PUBLIC_PORT } from '../network.js';
import { helmJobName } from '../../../shared/api-ingress.js';
import type { ClusterKubernetesClient } from './cluster-client.js';
import { nodePoolServicePodSelector } from './identity.js';
import type { NodePoolNodeObservation } from './node-pool-nodes.js';
import { INGRESS_ENTRY_NODE_LABEL } from './node-pool-scheduling.js';
import { DELETION_COST, DRAINING_COST, isPodReady } from './pool-objects.js';
import { kubernetesRequestOptions } from './request-options.js';

/**
 * Every node pool that hosts a Service has one ingress entry: a pool Node that
 * runs the pool's Traefik on host ports and whose public IP the Service's DNS
 * record points at. The entry also runs ordinary workloads; it is a role on
 * an existing VM, not a dedicated one. Election is durable on the node pool
 * row so a restart keeps the same entry.
 */
/** IngressRoutes carry this label with the node pool id whose Traefik serves them. */
export const POOL_INGRESS_ROUTE_LABEL = 'anycloud.sh/ingress-pool';
/** A NotReady entry keeps its role this long before another Node takes over. */
export const INGRESS_ENTRY_NOT_READY_GRACE_MS = 2 * 60_000;

/**
 * Pool VMs stay outbound-only until the pool hosts a Service; then the pool
 * network admits HTTP from Cloudflare's edge only — the same rule VM-host
 * Services carry. The rule applies to the pool's network as a whole (only the
 * entry Node runs anything on the port; per-VM groups would need a provider
 * capability the gateways do not expose) and is never removed. 443 follows
 * when origin TLS is decided and something listens on it.
 */
export function nodePoolNetwork(options: {
  hostsServices: boolean;
}): IngressSpec {
  return {
    ingress: options.hostsServices
      ? [
          {
            protocol: 'tcp',
            port: SERVICE_PUBLIC_PORT,
            sourceRanges: [...CLOUDFLARE_IP_RANGES],
            description: 'Cloudflare edge to the node pool ingress entry',
          },
        ]
      : [],
    denyPublicIngress: true,
  };
}

export interface IngressEntryElection {
  /** VM attempt whose Node should be the entry, or null when none is Ready. */
  vmId: number | null;
  changed: boolean;
}

/**
 * Keep the current entry while its Node is Ready or only briefly NotReady;
 * otherwise elect the live attempt with the lowest id whose Node is Ready.
 * Deterministic, so every pass and every process agrees without a lock.
 */
export function electIngressEntry(input: {
  currentVmId: number | null;
  live: readonly Pick<NodePoolVM, 'id' | 'ip'>[];
  nodeByVm: ReadonlyMap<number, NodePoolNodeObservation>;
  now: number;
}): IngressEntryElection {
  const current =
    input.currentVmId === null
      ? undefined
      : input.live.find((vm) => vm.id === input.currentVmId);
  if (current && current.ip !== null) {
    const node = input.nodeByVm.get(current.id);
    if (node?.ready) return { vmId: current.id, changed: false };
    if (
      node &&
      node.readyTransitionAt !== null &&
      input.now - node.readyTransitionAt < INGRESS_ENTRY_NOT_READY_GRACE_MS
    ) {
      return { vmId: current.id, changed: false };
    }
  }
  const candidate = [...input.live]
    .filter(
      (vm) =>
        vm.ip !== null &&
        vm.id !== current?.id &&
        input.nodeByVm.get(vm.id)?.ready,
    )
    .sort((left, right) => left.id - right.id)[0];
  // With no Ready replacement the current live entry stays: a NotReady Node
  // may return, and blanking the record would only add churn. Its attempt
  // ending (VM replacement) is what finally removes it.
  const vmId =
    candidate?.id ?? (current && current.ip !== null ? current.id : null);
  return { vmId, changed: vmId !== input.currentVmId };
}

type NodeApi = Pick<CoreV1Api, 'patchNode'>;

/** Label (or, with `null`, unlabel) a Node as the pool's ingress entry. */
export async function setIngressEntryLabel(
  core: NodeApi,
  node: Pick<NodePoolNodeObservation, 'name' | 'uid'>,
  nodePoolId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  await core.patchNode(
    {
      name: node.name,
      body: {
        metadata: {
          uid: node.uid,
          labels: { [INGRESS_ENTRY_NODE_LABEL]: nodePoolId },
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
 * On a Service's Kubernetes Deployment while an entry hand-off holds a second
 * replica of it; the value is the node pool id. Applying the Service leaves a
 * held Deployment alone, so `replicas: 1` doesn't drop the second replica.
 */
export const ENTRY_HANDOFF_LABEL = 'anycloud.sh/entry-handoff';

/**
 * The Nodes an entry hand-off moves the pool's Services between: the
 * outdated entry, and a current Ready Node, one already labelled first, else
 * the newest, the entry's spare, which no drained Pods fill.
 */
export function entryHandoff(input: {
  live: readonly Pick<NodePoolVM, 'id' | 'ip'>[];
  nodeByVm: ReadonlyMap<number, NodePoolNodeObservation>;
}): { from: number; to: number } | null {
  const node = (vm: Pick<NodePoolVM, 'id'>) => input.nodeByVm.get(vm.id);
  const from = input.live.find(
    (vm) => node(vm)?.ingressEntry && node(vm)!.outdated,
  );
  const to = input.live
    .filter((vm) => vm.ip !== null && node(vm)?.ready && !node(vm)!.outdated)
    .sort(
      (left, right) =>
        Number(node(right)!.ingressEntry) - Number(node(left)!.ingressEntry) ||
        right.id - left.id,
    )[0];
  return from && to ? { from: from.id, to: to.id } : null;
}

const mergePatch = (signal?: AbortSignal) =>
  setHeaderOptions(
    'Content-Type',
    'application/merge-patch+json',
    kubernetesRequestOptions(signal),
  );

/**
 * Bring the pool's Services up on `to` beside `from`, the cordoned outdated
 * entry: label `to` as a second entry so Traefik runs there, and give each
 * Service serving on `from` a second replica, which only `to` can take. The
 * replica on `from` gets the lowest deletion cost first, so any scale-down
 * removes it. True once Traefik and each Service have a Ready Pod on `to`.
 */
export async function prepareEntryHandoff(
  { core, apps }: Pick<ClusterKubernetesClient, 'core' | 'apps'>,
  input: {
    nodePoolId: string;
    from: Pick<NodePoolNodeObservation, 'name'>;
    to: Pick<NodePoolNodeObservation, 'name' | 'uid' | 'ingressEntry'>;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  const { nodePoolId, from, to } = input;
  if (!to.ingressEntry) {
    await setIngressEntryLabel(core, to, nodePoolId, signal);
  }
  const podsOn = async (nodeName: string) =>
    (
      await core.listPodForAllNamespaces(
        { fieldSelector: `spec.nodeName=${nodeName}` },
        kubernetesRequestOptions(signal),
      )
    ).items;
  const onFrom = await podsOn(from.name);
  const onTo = await podsOn(to.name);
  let ready = onTo.some(
    (pod) =>
      pod.metadata?.namespace === poolIngressReleaseName(nodePoolId) &&
      isPodReady(pod),
  );
  const { items } = await apps.listDeploymentForAllNamespaces(
    { labelSelector: nodePoolServicePodSelector() },
    kubernetesRequestOptions(signal),
  );
  for (const deployment of items) {
    const { namespace = '', name = '' } = deployment.metadata ?? {};
    const selects = (pod: V1Pod) =>
      pod.metadata?.namespace === namespace &&
      Object.entries(deployment.spec?.selector.matchLabels ?? {}).every(
        ([key, value]) => pod.metadata?.labels?.[key] === value,
      ) &&
      isPodReady(pod);
    if (
      deployment.spec?.template.spec?.nodeSelector?.[
        INGRESS_ENTRY_NODE_LABEL
      ] !== nodePoolId ||
      !onFrom.some(selects) ||
      onTo.some(selects)
    ) {
      continue;
    }
    ready = false;
    if (deployment.spec.replicas === 1) {
      for (const pod of onFrom.filter(selects)) {
        await core.patchNamespacedPod(
          {
            name: pod.metadata!.name!,
            namespace,
            body: {
              metadata: { annotations: { [DELETION_COST]: DRAINING_COST } },
            },
          },
          mergePatch(signal),
        );
      }
      await apps.patchNamespacedDeployment(
        {
          name,
          namespace,
          body: {
            metadata: { labels: { [ENTRY_HANDOFF_LABEL]: nodePoolId } },
            spec: { replicas: 2 },
          },
        },
        mergePatch(signal),
      );
    }
  }
  return ready;
}

/** End the pool's hand-off: each held Deployment returns to one replica. */
export async function releaseEntryHandoff(
  apps: ClusterKubernetesClient['apps'],
  nodePoolId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { items } = await apps.listDeploymentForAllNamespaces(
    { labelSelector: `${ENTRY_HANDOFF_LABEL}=${nodePoolId}` },
    kubernetesRequestOptions(signal),
  );
  for (const deployment of items) {
    await apps.patchNamespacedDeployment(
      {
        name: deployment.metadata!.name!,
        namespace: deployment.metadata!.namespace!,
        body: {
          metadata: { labels: { [ENTRY_HANDOFF_LABEL]: null } },
          spec: { replicas: 1 },
        },
      },
      mergePatch(signal),
    );
  }
}

/** The pool's Traefik closes an edge connection this long after it opened. */
export const POOL_INGRESS_KEEP_ALIVE_MAX_MS = 10_000;

/** A line of Traefik's access log (common format): one request served. */
const ACCESS_LOG_LINE = /"[A-Z]+ \S* HTTP\/[\d.]+" \d{3} /;

/** The pool's Traefik Pods bound to `nodeName`, terminating ones included. */
async function poolIngressPodsOn(
  core: Pick<CoreV1Api, 'listPodForAllNamespaces'>,
  nodePoolId: string,
  nodeName: string,
  signal?: AbortSignal,
): Promise<V1Pod[]> {
  const { items } = await core.listPodForAllNamespaces(
    { fieldSelector: `spec.nodeName=${nodeName}` },
    kubernetesRequestOptions(signal),
  );
  return items.filter(
    (pod) => pod.metadata?.namespace === poolIngressReleaseName(nodePoolId),
  );
}

/**
 * True when the pool's Traefik on `nodeName` served no request in the
 * last `windowMs`, read from its access log. A Traefik without the access log
 * (from an older build) or whose log can't be read is never quiet, so the
 * hand-off waits out its bound.
 */
export async function entryQuiet(
  core: Pick<CoreV1Api, 'listPodForAllNamespaces' | 'readNamespacedPodLog'>,
  input: { nodePoolId: string; nodeName: string; windowMs: number },
  signal?: AbortSignal,
): Promise<boolean> {
  const pods = await poolIngressPodsOn(
    core,
    input.nodePoolId,
    input.nodeName,
    signal,
  );
  for (const pod of pods.filter(isPodReady)) {
    if (
      !pod.spec?.containers.some((c) => c.args?.includes('--accesslog=true'))
    ) {
      return false;
    }
    const log = await core
      .readNamespacedPodLog(
        {
          name: pod.metadata!.name!,
          namespace: pod.metadata!.namespace!,
          sinceSeconds: Math.ceil(input.windowMs / 1000),
        },
        kubernetesRequestOptions(signal),
      )
      .catch(() => null);
    if (
      log === null ||
      log.split('\n').some((line) => ACCESS_LOG_LINE.test(line))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * True while the pool's Traefik runs on a Node outside `entries`: a
 * former entry's Traefik, stopping after its hand-off.
 */
export async function poolIngressStopping(
  core: Pick<CoreV1Api, 'listNamespacedPod'>,
  nodePoolId: string,
  entries: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<boolean> {
  const { items } = await core.listNamespacedPod(
    { namespace: poolIngressReleaseName(nodePoolId) },
    kubernetesRequestOptions(signal),
  );
  return items.some(
    (pod) => pod.spec?.nodeName && !entries.has(pod.spec.nodeName),
  );
}

export interface PoolIngressRelease {
  state: 'absent' | 'installing' | 'installed' | 'failed';
  /** helm-controller's install Job, once the HelmChart exists. */
  helmJob: { phase: string; message: string | null } | null;
  /** Traefik's DaemonSet in the release namespace, once Helm created it. */
  daemonSet: { desired: number; ready: number; entryNodeReady: boolean } | null;
  /** Newest event on the install Job, its Pods or the release namespace. */
  lastEvent: string | null;
  /** IngressRoutes labelled for this pool: the Services its Traefik serves. */
  routes: number;
}

/** The object name Traefik's chart gives its DaemonSet (`fullnameOverride`). */
export const POOL_INGRESS_WORKLOAD_NAME = 'pool-ingress';

/**
 * Name of the pool's Traefik HelmChart, of the Helm release and of the
 * namespace it installs into. Deliberately short: helm-controller derives the
 * install Job (`helm-install-<name>`), its `job-name` label value and further
 * objects from it, each capped at 63 bytes — a name carrying the pool id
 * overflowed that cap and the Job could never be created. The pool id stays
 * on the HelmChart as the `anycloud.sh/node-pool` label for humans.
 */
export function poolIngressReleaseName(nodePoolId: string): string {
  const hash = createHash('sha256').update(nodePoolId).digest('hex');
  return `${POOL_INGRESS_WORKLOAD_NAME}-${hash.slice(0, 12)}`;
}

type ReleaseApis = {
  objects: Pick<KubernetesObjectApi, 'read' | 'list'>;
  apps: Pick<AppsV1Api, 'readNamespacedDaemonSet'>;
  core: Pick<CoreV1Api, 'listNamespacedPod' | 'listNamespacedEvent'>;
};

const clip = (value?: string) =>
  (value ?? '').replace(/\s+/g, ' ').slice(0, 240);

const absent = <T>(read: Promise<T>) =>
  read.catch((error: unknown) => {
    if ((error as { code?: number }).code === 404) return null;
    throw error;
  });

/**
 * What the cluster says about one pool's ingress release, read through the
 * connection the controller holds: the HelmChart, helm-controller's
 * `helm-install-<chart>` Job and its Pod in `kube-system`, Traefik's
 * DaemonSet in the release namespace and the newest related event.
 */
export async function observePoolIngressRelease(
  { objects, apps, core }: ReleaseApis,
  release: { name: string; nodePoolId: string; entryNodeReady: boolean },
): Promise<PoolIngressRelease> {
  const system = 'kube-system';
  const read = (apiVersion: string, kind: string, name: string) =>
    absent(
      objects.read({ apiVersion, kind, metadata: { name, namespace: system } }),
    );
  const routes = await countPoolRoutes(objects, release.nodePoolId);
  if (!(await read('helm.cattle.io/v1', 'HelmChart', release.name))) {
    return {
      state: 'absent',
      helmJob: null,
      daemonSet: null,
      lastEvent: null,
      routes,
    };
  }
  const jobName = helmJobName(release.name);
  const job = (await read('batch/v1', 'Job', jobName)) as V1Job | null;
  const { succeeded = 0, failed = 0, active = 0 } = job?.status ?? {};
  const phase = succeeded
    ? 'succeeded'
    : failed
      ? 'failed'
      : active
        ? 'running'
        : 'pending';
  // The install container's exit carries Helm's error when the Job failed.
  const [pod] = (
    await core.listNamespacedPod({
      namespace: system,
      labelSelector: `job-name=${jobName}`,
    })
  ).items;
  const exit = pod?.status?.containerStatuses
    ?.map((c) => c.state?.terminated ?? c.lastState?.terminated)
    .find((t) => t && t.exitCode !== 0);
  const daemonSet = await absent(
    apps.readNamespacedDaemonSet({
      name: POOL_INGRESS_WORKLOAD_NAME,
      namespace: release.name,
    }),
  );
  const lastEvent = await newestEvent(
    core,
    release.name,
    daemonSet ? null : jobName,
  );
  return {
    state:
      phase === 'failed'
        ? 'failed'
        : phase === 'succeeded'
          ? 'installed'
          : 'installing',
    helmJob: {
      phase,
      message: exit
        ? `exit ${exit.exitCode}: ${clip(exit.message ?? exit.reason)}`
        : null,
    },
    daemonSet: daemonSet
      ? {
          desired: daemonSet.status?.desiredNumberScheduled ?? 0,
          ready: daemonSet.status?.numberReady ?? 0,
          entryNodeReady: release.entryNodeReady,
        }
      : null,
    lastEvent,
    routes,
  };
}

/** Routes the pool's Traefik selects; none while the CRD is not installed. */
async function countPoolRoutes(
  objects: ReleaseApis['objects'],
  nodePoolId: string,
): Promise<number> {
  const list = await absent(
    objects.list(
      'traefik.io/v1alpha1',
      'IngressRoute',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      `${POOL_INGRESS_ROUTE_LABEL}=${nodePoolId}`,
    ),
  );
  return list?.items.length ?? 0;
}

/** Event timestamps arrive as `Date` or ISO strings depending on the client path. */
function eventTime(event: CoreV1Event): number {
  const raw =
    event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp;
  const time =
    raw === undefined ? NaN : new Date(raw as Date | string).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Newest event in the release namespace or, before Traefik's DaemonSet exists,
 * on the install Job and its Pods in `kube-system`. Events only explain the
 * other readings, so any surprise here degrades to null rather than failing them.
 */
async function newestEvent(
  core: ReleaseApis['core'],
  releaseName: string,
  jobName: string | null,
): Promise<string | null> {
  try {
    const { items } = await core.listNamespacedEvent({
      namespace: jobName ? 'kube-system' : releaseName,
    });
    const [last] = items
      .filter(
        (e) => !jobName || (e.involvedObject.name ?? '').startsWith(jobName),
      )
      .sort((a, b) => eventTime(b) - eventTime(a));
    return last ? `${last.reason ?? ''}: ${clip(last.message)}` : null;
  } catch {
    return null;
  }
}
