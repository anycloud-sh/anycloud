import type {
  KubernetesObject,
  V1DeleteOptions,
  V1Deployment as KubernetesDeployment,
  V1Pod,
} from '@kubernetes/client-node';
import { getApiIdentity } from './api-identity.js';
import type { ClusterKubernetesClient } from './kubernetes/cluster-client.js';
import {
  KUBERNETES_COMPONENT_LABEL,
  KUBERNETES_MANAGED_BY_LABEL,
  KUBERNETES_OWNER_API_ANNOTATION,
  KUBERNETES_WORKLOAD_ID_ANNOTATION,
} from './kubernetes/identity.js';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
  kubernetesDeleteOptionsForUid,
} from './kubernetes/managed-resources.js';
import { KubernetesHttpError } from './kubernetes/list-watch.js';
import {
  ANYCLOUD_POD_FINALIZER,
  releasePodFinalizer,
} from './kubernetes/pool-objects.js';
import { log } from './logger.js';
import { waitForPoll } from './request-budget.js';
import { retryAfterMs } from '../../shared/retry-after.js';
import { Scheduler } from './reconciliation/scheduler.js';

const MANAGED = `${KUBERNETES_MANAGED_BY_LABEL}=anycloud`;
const ORPHAN_UNREADY_MS = 2 * 60_000;
/**
 * One list-and-watch per kind per cluster. Pods serve the owner, fit,
 * demand and the busy-Node check; the owned kinds queue the owner's key
 * (controller-runtime's `Owns()`).
 */
const WATCHED = [
  {
    kind: 'Pod',
    apiVersion: 'v1',
    path: '/api/v1/pods',
    labelSelector: MANAGED,
  },
  {
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    path: '/apis/apps/v1/deployments',
    labelSelector: MANAGED,
  },
  {
    kind: 'Secret',
    apiVersion: 'v1',
    path: '/api/v1/secrets',
    labelSelector: MANAGED,
  },
  {
    kind: 'ServiceAccount',
    apiVersion: 'v1',
    path: '/api/v1/serviceaccounts',
    labelSelector: MANAGED,
  },
  { kind: 'Node', apiVersion: 'v1', path: '/api/v1/nodes', labelSelector: '' },
  // The node pool namespace's egress policy (K5), repaired when it drifts.
  {
    kind: 'NetworkPolicy',
    apiVersion: 'networking.k8s.io/v1',
    path: '/apis/networking.k8s.io/v1/networkpolicies',
    labelSelector: MANAGED,
  },
] as const;
type WatchedKind = (typeof WATCHED)[number]['kind'];

/** The one owner behind the loop, the Deployment owner (RFC 0044). */
export interface PoolOwner {
  /** The component label on the objects it owns. */
  readonly component: string;
  /** Every ID to reconcile, from SQLite: the level-triggered resync. */
  discover(): Promise<readonly string[]>;
  /** Writes only what differs from `view`'s cache; throws to back off. */
  reconcile(id: string, view: PoolView): Promise<void>;
  /** Hears every watch event on an object it owns, before its reconcile. */
  observed?(id: string): void;
}

interface ClusterCache {
  get<T extends KubernetesObject>(
    kind: WatchedKind,
    namespace: string,
    name: string,
  ): T | undefined;
  /** Indexed by namespace, component label and Node. */
  pods(by: { namespace?: string; component?: string; node?: string }): V1Pod[];
}

export interface PoolView {
  /** The cluster's synced cache; throws until each kind's first list lands. */
  cache(clusterId: string): ClusterCache;
}

export interface PoolReconciler extends PoolView {
  schedule(id: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

class PoolCacheNotSyncedError extends Error {
  constructor(clusterId: string) {
    super(`The Kubernetes cache of cluster ${clusterId} is still syncing`);
    this.name = 'PoolCacheNotSyncedError';
  }
}

interface Entry {
  dueAt: number;
  id: string;
  failures: number;
  /** Passes that found the cache still syncing; a stuck sync slows to 30 s. */
  waits?: number;
  /** Due at the server's own Retry-After, which an event doesn't shorten. */
  throttled?: boolean;
}

interface Informer {
  objects: Map<string, KubernetesObject>;
  index: Map<string, Set<string>>;
  listed: Set<WatchedKind>;
  used: boolean;
  /** Keys that read this cache; one still scheduled keeps it alive. */
  keys: Set<string>;
  controller: AbortController;
}

const objectKey = (kind: string, object: KubernetesObject) =>
  `${kind}/${object.metadata?.namespace ?? ''}/${object.metadata?.name ?? ''}`;

function podIndexKeys(pod: V1Pod): string[] {
  return [
    `namespace:${pod.metadata?.namespace ?? ''}`,
    `component:${pod.metadata?.labels?.[KUBERNETES_COMPONENT_LABEL] ?? ''}`,
    `node:${pod.spec?.nodeName ?? ''}`,
  ];
}

function throttledForMs(error: unknown): number | undefined {
  if (error instanceof KubernetesHttpError) return error.retryAfterMs;
  const { code, headers } = (error ?? {}) as {
    code?: number;
    headers?: Record<string, string>;
  };
  return code === 429
    ? retryAfterMs(headers, Date.now()) || undefined
    : undefined;
}

export function createPoolReconciler(input: {
  owner: PoolOwner;
  /** The cluster's current client, re-resolved for every watch session. */
  cluster(
    clusterId: string,
    signal: AbortSignal,
  ): Promise<ClusterKubernetesClient>;
  resyncMs?: number;
  tickMs?: number;
  /** A hung list is abandoned and retried after this long. */
  listTimeoutMs?: number;
  maxInFlight?: number;
  random?: () => number;
}): PoolReconciler {
  const { owner } = input;
  const informers = new Map<string, Informer>();
  const random = input.random ?? Math.random;
  let running = false;
  /** Set by stop(), so a reconcile still in flight can't start an informer. */
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastResync = 0;
  /** When each orphaned native Deployment was first seen with no ready replica. */
  const orphansUnready = new Map<string, number>();
  const scheduler = new Scheduler<Entry, 'pool'>({
    laneCycle: ['pool'],
    maxInFlight: input.maxInFlight ?? 8,
    key: (entry) => entry.id,
    lane: () => 'pool',
    now: Date.now,
    shouldRefill: () => running,
    run,
  });

  async function run(entry: Readonly<Entry>): Promise<void> {
    try {
      await owner.reconcile(entry.id, {
        cache: (clusterId) => cache(clusterId, entry.id),
      });
      scheduler.removeIfCurrent(entry);
    } catch (error) {
      // Exponential per key, 1 s doubling to 5 min, unless the server named
      // its own Retry-After; a cache that is still syncing is not a failure.
      const syncing = error instanceof PoolCacheNotSyncedError;
      if (!syncing) {
        log.error('Pool reconcile failed', { id: entry.id, error });
      }
      const retryAfter = throttledForMs(error);
      const delay =
        retryAfter ??
        (syncing
          ? (entry.waits ?? 0) < 10
            ? 1_000
            : 30_000
          : Math.min(1_000 * 2 ** entry.failures, 300_000));
      // An event during the pass replaced its entry: rerun now, unless the
      // server asked to wait.
      const dirty = !scheduler.isCurrent(entry) && retryAfter === undefined;
      scheduler.replace({
        ...entry,
        dueAt: Date.now() + (dirty ? 0 : delay),
        failures: syncing ? entry.failures : entry.failures + 1,
        waits: syncing ? (entry.waits ?? 0) + 1 : 0,
        throttled: retryAfter !== undefined,
      });
    }
  }

  function schedule(id: string): void {
    const existing = scheduler.get(id);
    const active = scheduler.hasInFlight(id);
    // An event cuts a backoff short, as controller-runtime's queue does, but
    // keeps its failure count; an active key reruns, because its pass may
    // have read the cache before this event.
    if (
      !existing ||
      active ||
      (!existing.throttled && existing.dueAt > Date.now())
    ) {
      scheduler.replace({
        id,
        dueAt: Date.now(),
        failures: existing?.failures ?? 0,
      });
    }
    if (running) scheduler.pump();
  }

  function changed(object: KubernetesObject, informer: Informer): void {
    if (object.kind === 'NetworkPolicy') {
      // A namespace's egress policy belongs to every Deployment in it; any
      // one Deployment's reconcile repairs it, so exactly one apply follows
      // (each live pass checks it, before any drain or rollout return).
      const prefix = `Deployment/${object.metadata?.namespace ?? ''}/`;
      for (const [key, deployment] of informer.objects) {
        if (key.startsWith(prefix)) return changed(deployment, informer);
      }
      return;
    }
    const id =
      object.metadata?.annotations?.[KUBERNETES_WORKLOAD_ID_ANNOTATION];
    if (
      object.metadata?.labels?.[KUBERNETES_COMPONENT_LABEL] !==
        owner.component ||
      !id
    )
      return;
    owner.observed?.(id);
    schedule(id);
  }

  function put(
    informer: Informer,
    kind: WatchedKind,
    object: KubernetesObject,
  ) {
    const key = objectKey(kind, object);
    remove(informer, key);
    informer.objects.set(key, object);
    if (kind !== 'Pod') return;
    for (const index of podIndexKeys(object as V1Pod)) {
      const keys = informer.index.get(index) ?? new Set();
      informer.index.set(index, keys.add(key));
    }
  }

  function remove(informer: Informer, key: string): void {
    const old = informer.objects.get(key);
    if (!old || !informer.objects.delete(key) || !key.startsWith('Pod/'))
      return;
    for (const index of podIndexKeys(old as V1Pod)) {
      informer.index.get(index)?.delete(key);
    }
  }

  /**
   * RFC 0044's startup strip: a listed Pod that still holds the anycloud
   * finalizer but whose record the owner no longer discovers would block its
   * namespace's deletion for good, so it is released.
   */
  async function releaseOrphans(
    client: ClusterKubernetesClient,
    pods: V1Pod[],
  ): Promise<void> {
    const held = pods.filter(
      (pod) =>
        pod.metadata?.labels?.[KUBERNETES_COMPONENT_LABEL] ===
          owner.component &&
        pod.metadata.finalizers?.includes(ANYCLOUD_POD_FINALIZER),
    );
    if (held.length === 0) return;
    const live = new Set(await owner.discover());
    for (const pod of held) {
      const id = pod.metadata?.annotations?.[KUBERNETES_WORKLOAD_ID_ANNOTATION];
      if (!id || !live.has(id)) await releasePodFinalizer(client.core, pod);
    }
  }

  /**
   * RFC 0049 C27: restoring a backup drops the rows of Deployments created
   * after it, and nothing else deletes their native objects. One this API
   * owns, with no row, whose replicas stayed unready for two minutes goes
   * with its ServiceAccount and Secrets, each by UID; `releaseOrphans`
   * releases its replicas' finalizers on the passes after.
   * No row is committed after its native object, so the wait spares only a
   * row being written. An object another API owns is never touched.
   */
  async function deleteOrphanedDeployments(
    client: ClusterKubernetesClient,
    informer: Informer,
  ): Promise<void> {
    const ours = (object: KubernetesObject) =>
      object.metadata?.labels?.[KUBERNETES_COMPONENT_LABEL] ===
        owner.component &&
      object.metadata.annotations?.[KUBERNETES_OWNER_API_ANNOTATION] ===
        getApiIdentity();
    const objects = [...informer.objects.values()];
    const unready = objects.filter(
      (object): object is KubernetesDeployment =>
        object.kind === 'Deployment' &&
        ours(object) &&
        !object.metadata?.deletionTimestamp &&
        !(object as KubernetesDeployment).status?.readyReplicas,
    );
    const seen = new Set(unready.map((object) => object.metadata!.uid!));
    for (const uid of orphansUnready.keys()) {
      if (!seen.has(uid)) orphansUnready.delete(uid);
    }
    if (unready.length === 0) return;
    const live = new Set(await owner.discover());
    const now = Date.now();
    for (const deployment of unready) {
      const uid = deployment.metadata!.uid!;
      const id =
        deployment.metadata!.annotations![KUBERNETES_WORKLOAD_ID_ANNOTATION];
      if (!id || live.has(id)) {
        orphansUnready.delete(uid);
        continue;
      }
      const since = orphansUnready.get(uid) ?? now;
      orphansUnready.set(uid, since);
      if (now - since < ORPHAN_UNREADY_MS) continue;
      const namespace = deployment.metadata!.namespace!;
      const owned = objects.filter(
        (object) =>
          object.metadata?.namespace === namespace &&
          object.metadata.annotations?.[KUBERNETES_WORKLOAD_ID_ANNOTATION] ===
            id &&
          ours(object),
      );
      type Remove = (name: string, body: V1DeleteOptions) => Promise<unknown>;
      const remove: Record<string, Remove> = {
        Deployment: (name, body) =>
          client.apps.deleteNamespacedDeployment({ namespace, name, body }),
        ServiceAccount: (name, body) =>
          client.core.deleteNamespacedServiceAccount({ namespace, name, body }),
        Secret: (name, body) =>
          client.core.deleteNamespacedSecret({ namespace, name, body }),
      };
      for (const object of owned) {
        const { name, uid: objectUid } = object.metadata!;
        try {
          await remove[object.kind!]?.(
            name!,
            kubernetesDeleteOptionsForUid(objectUid!, 'Background'),
          );
        } catch (error) {
          if (
            !isKubernetesNotFoundError(error) &&
            !isKubernetesConflictError(error)
          ) {
            throw error;
          }
        }
      }
      orphansUnready.delete(uid);
      log.warn('Deleted a native Deployment with no Deployment record', {
        id,
        namespace,
      });
    }
  }

  /**
   * List from the API server's watch cache (`resourceVersion: "0"`), then
   * watch in jittered multi-minute sessions resumed from the last event or
   * bookmark. Only a 410 relists; a 429 waits out its Retry-After.
   */
  async function informKind(
    clusterId: string,
    informer: Informer,
    spec: (typeof WATCHED)[number],
  ): Promise<void> {
    const { signal } = informer.controller;
    const query: Record<string, string> = spec.labelSelector
      ? { labelSelector: spec.labelSelector }
      : {};
    let resourceVersion: string | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const client = await input.cluster(clusterId, signal);
        if (!resourceVersion) {
          const listed = await client.listWatch.list(
            spec.path,
            { ...query, resourceVersion: '0' },
            // A hung list is abandoned and retried, like a watch session.
            AbortSignal.any([
              signal,
              AbortSignal.timeout(input.listTimeoutMs ?? 60_000),
            ]),
          );
          // List items carry no kind or apiVersion; watch events do.
          const { kind, apiVersion } = spec;
          const items = listed.items.map((item) => ({
            apiVersion,
            kind,
            ...item,
          }));
          const keys = new Set(items.map((item) => objectKey(spec.kind, item)));
          const gone = [...informer.objects].filter(
            ([key]) => key.startsWith(`${spec.kind}/`) && !keys.has(key),
          );
          for (const [key] of gone) remove(informer, key);
          for (const item of items) put(informer, spec.kind, item);
          resourceVersion = listed.resourceVersion;
          informer.listed.add(spec.kind);
          // Keys that waited for this sync, rather than failed, run now.
          if (informer.listed.size === WATCHED.length) {
            for (const entry of scheduler.entries()) {
              if (!entry.failures) scheduler.replace({ ...entry, dueAt: 0 });
            }
          }
          for (const object of [...items, ...gone.map(([, o]) => o)])
            changed(object, informer);
          if (spec.kind === 'Pod') {
            await releaseOrphans(client, items).catch((error: unknown) =>
              log.warn('Releasing orphaned Pod finalizers failed', {
                id: clusterId,
                error,
              }),
            );
          }
          if (running) scheduler.pump();
        }
        const seconds = 240 + Math.floor(random() * 120);
        await client.listWatch.watch(
          spec.path,
          {
            ...query,
            resourceVersion,
            allowWatchBookmarks: 'true',
            timeoutSeconds: String(seconds),
          },
          AbortSignal.any([signal, AbortSignal.timeout((seconds + 30) * 1000)]),
          ({ type, object }) => {
            resourceVersion =
              object.metadata?.resourceVersion ?? resourceVersion;
            if (type === 'BOOKMARK') return;
            if (type === 'DELETED')
              remove(informer, objectKey(spec.kind, object));
            else put(informer, spec.kind, object);
            changed(object, informer);
          },
        );
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        // 410: the resourceVersion is compacted away; relist at once, but
        // back off if the relisted version is gone too.
        const gone = error instanceof KubernetesHttpError && error.code === 410;
        if (gone) resourceVersion = undefined;
        if (gone && failures++ === 0) continue;
        // An HTTP answer, such as 403 for missing RBAC, won't fix itself.
        (error instanceof KubernetesHttpError ? log.error : log.warn).call(
          log,
          'Kubernetes list-watch failed',
          { id: clusterId, path: spec.path, error },
        );
        await waitForPoll(
          throttledForMs(error) ?? Math.min(1_000 * 2 ** failures++, 30_000),
          signal,
        ).catch(() => undefined);
      }
    }
  }

  function cache(clusterId: string, key?: string): ClusterCache {
    let informer = informers.get(clusterId);
    if (!informer && stopped) throw new PoolCacheNotSyncedError(clusterId);
    if (!informer) {
      informer = {
        objects: new Map(),
        index: new Map(),
        listed: new Set(),
        used: true,
        keys: new Set(),
        controller: new AbortController(),
      };
      informers.set(clusterId, informer);
      for (const spec of WATCHED) void informKind(clusterId, informer, spec);
    }
    informer.used = true;
    if (key) informer.keys.add(key);
    if (informer.listed.size < WATCHED.length)
      throw new PoolCacheNotSyncedError(clusterId);
    const synced = informer;
    return {
      get: (kind, namespace, name) =>
        synced.objects.get(`${kind}/${namespace}/${name}`) as never,
      pods(by) {
        const sets = Object.entries(by)
          .filter(([, value]) => value !== undefined)
          .map(
            ([dimension, value]) =>
              synced.index.get(`${dimension}:${value}`) ?? new Set<string>(),
          );
        const [first, ...rest] = sets.sort((a, b) => a.size - b.size);
        const keys = first
          ? [...first].filter((key) => rest.every((set) => set.has(key)))
          : [...synced.objects.keys()].filter((key) => key.startsWith('Pod/'));
        return keys.map((key) => synced.objects.get(key) as V1Pod);
      },
    };
  }
  const view: PoolView = { cache: (clusterId) => cache(clusterId) };

  /** Re-run the owner's discover from SQLite; the cache makes no API call. */
  async function resync(): Promise<void> {
    lastResync = Date.now();
    for (const [clusterId, informer] of informers) {
      for (const key of informer.keys) {
        if (!scheduler.get(key)) informer.keys.delete(key);
      }
      if (!informer.used && informer.keys.size === 0) {
        informer.controller.abort();
        informers.delete(clusterId);
      }
      informer.used = false;
    }
    for (const id of await owner.discover()) {
      if (!scheduler.get(id)) {
        scheduler.replace({ id, dueAt: Date.now(), failures: 0 });
      }
    }
    scheduler.pump();
    for (const [clusterId, informer] of informers) {
      if (informer.listed.size < WATCHED.length) continue;
      try {
        const client = await input.cluster(
          clusterId,
          informer.controller.signal,
        );
        await deleteOrphanedDeployments(client, informer);
        // A replica a deletion above, or one since the last list, left
        // Terminating behind the finalizer.
        await releaseOrphans(
          client,
          [...informer.objects.values()].filter(
            (object): object is V1Pod => object.kind === 'Pod',
          ),
        );
      } catch (error) {
        log.warn('Deleting orphaned native Deployments failed', {
          id: clusterId,
          error,
        });
      }
    }
  }

  return {
    ...view,
    schedule,
    async start() {
      if (running) return;
      running = true;
      stopped = false;
      await resync();
      timer = setInterval(() => {
        if (Date.now() - lastResync < (input.resyncMs ?? 60_000)) {
          scheduler.pump();
          return;
        }
        void resync().catch((error: unknown) =>
          log.error('Pool discovery failed', { id: 'system', error }),
        );
      }, input.tickMs ?? 1_000);
      timer.unref?.();
    },
    async stop() {
      running = false;
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      for (const informer of informers.values()) informer.controller.abort();
      informers.clear();
      await scheduler.waitForInFlight();
    },
  };
}
