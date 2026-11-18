import type { V1Pod } from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KubernetesHttpError } from '../../../src/api/services/kubernetes/list-watch.js';
import {
  createPoolReconciler,
  type PoolOwner,
  type PoolReconciler,
} from '../../../src/api/services/pool-reconciler.js';
import { ANYCLOUD_POD_FINALIZER } from '../../../src/api/services/kubernetes/pool-objects.js';
import { FakeKubernetesCluster } from '../helpers/fake-kubernetes-cluster.js';
import { log } from '../../../src/api/services/logger.js';
import { getApiIdentity } from '../../../src/api/services/api-identity.js';

const CLUSTER = 'cluster-a';
const loops: PoolReconciler[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(loops.splice(0).map((loop) => loop.stop()));
});

function owned(id: string) {
  return {
    namespace: 'pool-ns',
    labels: {
      'app.kubernetes.io/managed-by': 'anycloud',
      'app.kubernetes.io/component': 'kubernetes-deployment',
    },
    annotations: { 'anycloud.sh/deployment-id': id },
  };
}

function pod(name: string, id: string, node?: string): V1Pod {
  return {
    kind: 'Pod',
    metadata: { name, uid: name, ...owned(id) },
    spec: { nodeName: node, containers: [] },
    status: { phase: node ? 'Running' : 'Pending' },
  };
}

function owner(
  reconcile: PoolOwner['reconcile'] = async () => {},
): PoolOwner & { reconcile: ReturnType<typeof vi.fn> } {
  return {
    component: 'kubernetes-deployment',
    discover: vi.fn(async () => []),
    reconcile: vi.fn(reconcile),
    observed: vi.fn(),
  };
}

function fixture(
  owner: PoolOwner,
  options: {
    maxInFlight?: number;
    resyncMs?: number;
    listTimeoutMs?: number;
  } = {},
) {
  const cluster = new FakeKubernetesCluster();
  const client = cluster.client();
  const list = vi.spyOn(client.listWatch, 'list');
  const watch = vi.spyOn(client.listWatch, 'watch');
  const loop = createPoolReconciler({
    owner,
    cluster: async () => client,
    tickMs: 5,
    resyncMs: options.resyncMs ?? 60_000,
    maxInFlight: options.maxInFlight,
    listTimeoutMs: options.listTimeoutMs,
    random: () => 0,
  });
  loops.push(loop);
  const synced = () => vi.waitFor(() => loop.cache(CLUSTER));
  const reads = () =>
    cluster.calls.filter((call) => call.op === 'list' || call.op === 'read');
  return { cluster, client, loop, list, watch, synced, reads };
}

describe('pool reconciler', () => {
  it('0044/I7 lists each kind once from the watch cache and resyncs from SQLite and the cache alone', async () => {
    const deployment = owner(async (_id, view) => {
      view.cache(CLUSTER);
    });
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment, { resyncMs: 20 });
    f.cluster.pods = [pod('replica', 'deployment-a', 'node-a')];
    await f.loop.start();
    await f.synced();
    expect(f.list.mock.calls.map(([path, query]) => [path, query])).toEqual([
      [
        '/api/v1/pods',
        {
          labelSelector: 'app.kubernetes.io/managed-by=anycloud',
          resourceVersion: '0',
        },
      ],
      [
        '/apis/apps/v1/deployments',
        {
          labelSelector: 'app.kubernetes.io/managed-by=anycloud',
          resourceVersion: '0',
        },
      ],
      [
        '/api/v1/secrets',
        {
          labelSelector: 'app.kubernetes.io/managed-by=anycloud',
          resourceVersion: '0',
        },
      ],
      [
        '/api/v1/serviceaccounts',
        {
          labelSelector: 'app.kubernetes.io/managed-by=anycloud',
          resourceVersion: '0',
        },
      ],
      ['/api/v1/nodes', { resourceVersion: '0' }],
      [
        '/apis/networking.k8s.io/v1/networkpolicies',
        {
          labelSelector: 'app.kubernetes.io/managed-by=anycloud',
          resourceVersion: '0',
        },
      ],
    ]);
    expect(f.watch.mock.calls[0]![1]).toMatchObject({
      allowWatchBookmarks: 'true',
      timeoutSeconds: '240',
    });
    // Several 60 s resyncs (20 ms here) re-run discover and every reconcile,
    // with no API read beyond the six lists.
    await vi.waitFor(() =>
      expect(vi.mocked(deployment.discover).mock.calls.length).toBeGreaterThan(
        3,
      ),
    );
    await vi.waitFor(() =>
      expect(deployment.reconcile.mock.calls.length).toBeGreaterThan(3),
    );
    expect(f.reads()).toHaveLength(6);
  });

  it('resumes each watch from its last bookmark, also after a failure, and relists only on 410, once', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const deployment = owner();
    const f = fixture(deployment);
    f.cluster.pods = [pod('replica', 'deployment-a', 'node-a')];
    await f.loop.start();
    await f.synced();
    await vi.waitFor(() =>
      expect(deployment.reconcile).toHaveBeenCalledWith(
        'deployment-a',
        expect.anything(),
      ),
    );
    f.cluster.pods = [
      ...f.cluster.pods,
      pod('second', 'deployment-b', 'node-b'),
    ];
    f.cluster.bookmark();
    const bookmark = String(f.cluster.resourceVersion);
    f.watch.mockClear();
    // One session fails on reconnect: it resumes after a backoff, too.
    f.cluster.failNext(new Error('connection reset'));
    f.cluster.endWatches();
    await vi.waitFor(() => expect(f.watch).toHaveBeenCalledTimes(7), {
      timeout: 3_000,
    });
    for (const [, query] of f.watch.mock.calls) {
      expect(query.resourceVersion).toBe(bookmark);
    }
    expect(f.list).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledWith(
      'Kubernetes list-watch failed',
      expect.objectContaining({ path: expect.stringMatching(/^\/api/) }),
    );

    // A Pod deleted while every watch is away and history compacted: the
    // 410 relists, and the relist drops it and queues its owner's key.
    f.cluster.endWatches();
    f.cluster.pods = [pod('second', 'deployment-b', 'node-b')];
    // Every history compacted away: one relist per kind, then a backoff.
    f.cluster.compactedBelow = Number.MAX_SAFE_INTEGER;
    deployment.reconcile.mockClear();
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(12));
    await vi.waitFor(() =>
      expect(f.loop.cache(CLUSTER).pods({})).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(deployment.reconcile).toHaveBeenCalledWith(
        'deployment-a',
        expect.anything(),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.list).toHaveBeenCalledTimes(12);
  });

  it("waits out a list's 429 Retry-After before listing again", async () => {
    const f = fixture(owner());
    f.cluster.failNext(new KubernetesHttpError(429, 300));
    const started = Date.now();
    await f.synced();
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(f.list).toHaveBeenCalledTimes(7);
  });

  it('abandons a hung list at its bound and lists again', async () => {
    const f = fixture(owner(), { listTimeoutMs: 20 });
    // The first Pod list never answers; only its signal ends it.
    f.list.mockImplementationOnce(
      (_path, _query, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(signal.reason as Error),
          ),
        ),
    );
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(() => f.loop.cache(CLUSTER)).toThrow(/still syncing/);
    // Retried after the list-watch's 1 s backoff.
    await vi.waitFor(() => f.loop.cache(CLUSTER), { timeout: 3_000 });
    expect(
      f.list.mock.calls.filter(([path]) => path === '/api/v1/pods'),
    ).toHaveLength(2);
  });

  it('0044 releases the finalizer of a listed Pod whose record its owner no longer discovers', async () => {
    const deployment = owner();
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment);
    const held = (name: string, id: string): V1Pod => {
      const value = pod(name, id, 'node-a');
      value.metadata!.namespace = 'pool-ns';
      value.metadata!.finalizers = [ANYCLOUD_POD_FINALIZER];
      return value;
    };
    // Only an owner's own held Pods count: another component's is left
    // alone, and an owner whose Pods hold no finalizer isn't asked.
    const foreign = held('foreign', 'gone');
    foreign.metadata!.labels = {
      ...foreign.metadata!.labels,
      'app.kubernetes.io/component': 'kubernetes-serve',
    };
    const free = pod('free', 'gone', 'node-a');
    free.metadata!.namespace = 'pool-ns';
    f.cluster.pods = [
      held('live', 'deployment-a'),
      held('orphan', 'gone'),
      foreign,
      free,
    ];
    await f.synced();
    await vi.waitFor(() =>
      expect(f.cluster.calls.filter((call) => call.op === 'patch')).toEqual([
        expect.objectContaining({ kind: 'Pod', name: 'orphan' }),
      ]),
    );
    expect(
      f.cluster.get('Pod', 'pool-ns', 'orphan')?.metadata?.finalizers,
    ).toEqual([]);
    expect(
      f.cluster.get('Pod', 'pool-ns', 'live')?.metadata?.finalizers,
    ).toEqual([ANYCLOUD_POD_FINALIZER]);
  });

  it('RFC 0049 C27 deletes a native Deployment this API owns with no record once its replicas stayed unready for two minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The live record's reconcile keeps the cluster's cache in use.
    const deployment = owner(async (_id, view) => {
      view.cache(CLUSTER);
    });
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment, { resyncMs: 5 });
    const objects = (name: string, id: string, ownerApi = getApiIdentity()) => {
      const metadata = () => {
        const base = owned(id);
        return {
          ...base,
          annotations: {
            ...base.annotations,
            'anycloud.sh/owner-api': ownerApi,
          },
        };
      };
      f.cluster.seed({
        kind: 'Deployment',
        metadata: { name, uid: `${name}-deployment`, ...metadata() },
        spec: { selector: {}, template: {} },
        status: { readyReplicas: 0 },
      });
      f.cluster.seed({
        kind: 'ServiceAccount',
        metadata: { name, uid: `${name}-account`, ...metadata() },
      });
      f.cluster.seed({
        kind: 'Secret',
        metadata: { name: `${name}-env`, uid: `${name}-secret`, ...metadata() },
      });
    };
    objects('live', 'deployment-a');
    objects('orphan', 'gone');
    objects('foreign', 'gone-too', 'another-api');
    await f.loop.start();
    await f.synced();
    const deletes = () =>
      f.cluster.calls
        .filter((call) => call.op === 'delete')
        .map((call) => `${call.kind} ${call.name}`);
    // Seen unready, but not yet for two minutes.
    const passes = vi.mocked(deployment.discover).mock.calls.length;
    await vi.waitFor(() =>
      expect(vi.mocked(deployment.discover).mock.calls.length).toBeGreaterThan(
        passes + 3,
      ),
    );
    expect(deletes()).toEqual([]);
    vi.setSystemTime(Date.now() + 120_000);
    await vi.waitFor(() =>
      expect(deletes().sort()).toEqual([
        'Deployment orphan',
        'Secret orphan-env',
        'ServiceAccount orphan',
      ]),
    );
    expect(f.cluster.get('Deployment', 'pool-ns', 'live')).toBeDefined();
    expect(f.cluster.get('Deployment', 'pool-ns', 'foreign')).toBeDefined();
  });

  it('RFC 0049 C27 releases an orphaned replica held after the first list on a later pass', async () => {
    const deployment = owner(async (_id, view) => {
      view.cache(CLUSTER);
    });
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment, { resyncMs: 5 });
    await f.loop.start();
    await f.synced();
    // Seen only through the watch, after the startup list's release.
    const late = pod('late', 'gone', 'node-a');
    late.metadata!.finalizers = [ANYCLOUD_POD_FINALIZER];
    late.metadata!.deletionTimestamp = new Date();
    f.cluster.pods = [late];
    await vi.waitFor(() =>
      expect(
        f.cluster.get('Pod', 'pool-ns', 'late')?.metadata?.finalizers ?? [],
      ).toEqual([]),
    );
  });

  it('0044 asks no owner for its records when none of its listed Pods holds the finalizer', async () => {
    const deployment = owner();
    const f = fixture(deployment);
    const free = pod('free', 'gone', 'node-a');
    free.metadata!.namespace = 'pool-ns';
    f.cluster.pods = [free];
    await f.synced();
    expect(deployment.discover).not.toHaveBeenCalled();
    expect(f.cluster.calls.filter((call) => call.op === 'patch')).toEqual([]);
  });

  it('keeps the cache of a key that is backing off across resyncs, and logs a refused watch with its path', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const deployment = owner(async (_id, view) => {
      view.cache(CLUSTER);
      throw new Error('apply failed');
    });
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment, { resyncMs: 20 });
    f.cluster.failNext(new KubernetesHttpError(403));
    await f.loop.start();
    // The refused kind retries after 1 s.
    await vi.waitFor(() => f.loop.cache(CLUSTER), { timeout: 3_000 });
    await vi.waitFor(() =>
      expect(vi.mocked(deployment.discover).mock.calls.length).toBeGreaterThan(
        3,
      ),
    );
    // One refused list plus one per kind: never pruned and relisted.
    expect(f.list).toHaveBeenCalledTimes(7);
    expect(error).toHaveBeenCalledWith(
      'Kubernetes list-watch failed',
      expect.objectContaining({ path: expect.stringMatching(/^\/api/) }),
    );
  });

  it('does not cut a backing-off key short on resync', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const deployment = owner(async () => {
      throw new Error('apply failed');
    });
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment, { resyncMs: 20 });
    await f.loop.start();
    await vi.waitFor(() =>
      expect(vi.mocked(deployment.discover).mock.calls.length).toBeGreaterThan(
        5,
      ),
    );
    expect(deployment.reconcile).toHaveBeenCalledTimes(1);
  });

  it('stops watching a cluster no key read in a resync window, and everything on stop', async () => {
    const deployment = owner(async (_id, view) => {
      view.cache(CLUSTER);
    });
    const f = fixture(deployment, { resyncMs: 20 });
    await f.loop.start();
    f.loop.schedule('deployment-a');
    await vi.waitFor(() =>
      expect(deployment.reconcile).toHaveBeenCalledTimes(2),
    );
    const sessions = () => f.watch.mock.calls.map(([, , signal]) => signal);
    await vi.waitFor(() =>
      expect(sessions().every((signal) => signal.aborted)).toBe(true),
    );
    expect(sessions()).toHaveLength(6);

    // stop() ends the resync timer and every watch.
    await f.loop.stop();
    const discovered = vi.mocked(deployment.discover).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deployment.discover).toHaveBeenCalledTimes(discovered);
    const g = fixture(owner());
    await g.loop.start();
    await g.synced();
    await g.loop.stop();
    const watches = g.watch.mock.calls.map(([, , signal]) => signal);
    expect(watches).toHaveLength(6);
    expect(watches.every((signal) => signal.aborted)).toBe(true);
  });

  it('backs a failing key off exponentially, honours a 429 Retry-After and resets on success', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const failures: unknown[] = [
      new Error('apply failed'),
      new Error('apply failed'),
      Object.assign(new Error('throttled'), {
        code: 429,
        headers: { 'retry-after': '7' },
      }),
    ];
    const deployment = owner(async () => {
      at.push(Date.now());
      const failure = failures.shift();
      if (failure) throw failure;
    });
    const f = fixture(deployment);
    await f.loop.start();
    const start = Date.now();
    f.loop.schedule('deployment-a');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(at.map((time) => time - start)).toEqual([0, 1_000, 3_000, 10_000]);
    // Success cleared the failures: the next event runs at once.
    f.loop.schedule('deployment-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(5);
  });

  it('runs a backing-off key on an event and keeps its failures, but waits out a Retry-After', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const failures: unknown[] = [
      new Error('apply failed'),
      new Error('apply failed'),
      Object.assign(new Error('throttled'), {
        code: 429,
        headers: { 'retry-after': '60' },
      }),
    ];
    const deployment = owner(async () => {
      at.push(Date.now());
      const failure = failures.shift();
      if (failure) throw failure;
    });
    const f = fixture(deployment);
    await f.loop.start();
    const start = Date.now();
    f.loop.schedule('deployment-a');
    await vi.advanceTimersByTimeAsync(500);
    // Backing off for 1 s: an event runs it now, and the next backoff is 2 s.
    f.loop.schedule('deployment-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(at.map((time) => time - start)).toEqual([0, 500]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(at.map((time) => time - start)).toEqual([0, 500, 2_500]);
    // A 429's Retry-After holds against events.
    f.loop.schedule('deployment-a');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(at).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(at.map((time) => time - start)).toEqual([0, 500, 2_500, 62_500]);
  });

  it('reruns a failing pass at once when an event arrived during it, unless it got a Retry-After', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const failures: unknown[] = [
      new Error('apply failed'),
      Object.assign(new Error('throttled'), {
        code: 429,
        headers: { 'retry-after': '60' },
      }),
    ];
    let event = () => {};
    const deployment = owner(async () => {
      at.push(Date.now());
      const failure = failures.shift();
      if (!failure) return;
      await Promise.resolve(); // the event arrives mid-pass
      event();
      throw failure;
    });
    const f = fixture(deployment);
    event = () => f.loop.schedule('deployment-a');
    await f.loop.start();
    const start = Date.now();
    f.loop.schedule('deployment-a');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(at.map((time) => time - start)).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(at.map((time) => time - start)).toEqual([0, 0, 60_000]);
  });

  it('starts no watch for a reconcile still in flight when it stops', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deployment = owner(async (_id, view) => {
      await blocked;
      view.cache(CLUSTER);
    });
    const f = fixture(deployment);
    await f.loop.start();
    f.loop.schedule('deployment-a');
    await vi.waitFor(() => expect(deployment.reconcile).toHaveBeenCalled());
    const stopped = f.loop.stop();
    release();
    await stopped;
    expect(f.list).not.toHaveBeenCalled();
    expect(f.watch).not.toHaveBeenCalled();
  });

  it("0044/S16 queues a Deployment's key when its owned Secret or ServiceAccount changes", async () => {
    const deployment = owner();
    const f = fixture(deployment);
    f.cluster.seed({
      kind: 'Secret',
      metadata: { name: 'env', ...owned('deployment-a') },
    });
    f.cluster.seed({
      kind: 'ServiceAccount',
      metadata: { name: 'sa', ...owned('deployment-b') },
    });
    await f.loop.start();
    await f.synced();
    deployment.reconcile.mockClear();
    await f.client.core.deleteNamespacedSecret({
      namespace: 'pool-ns',
      name: 'env',
    });
    await f.client.core.deleteNamespacedServiceAccount({
      namespace: 'pool-ns',
      name: 'sa',
    });
    await vi.waitFor(() =>
      expect(deployment.reconcile.mock.calls.map(([id]) => id).sort()).toEqual([
        'deployment-a',
        'deployment-b',
      ]),
    );
    expect(deployment.observed).toHaveBeenCalledWith('deployment-a');
    expect(
      f.loop.cache(CLUSTER).get('Secret', 'pool-ns', 'env'),
    ).toBeUndefined();
  });

  it('indexes Pods by namespace, component and Node, and keeps a finalizer-held Pod until released', async () => {
    const deployment = owner();
    vi.mocked(deployment.discover).mockResolvedValue(['deployment-a']);
    const f = fixture(deployment);
    const held = pod('held', 'deployment-a', 'node-a');
    held.metadata!.finalizers = [ANYCLOUD_POD_FINALIZER];
    const pending = pod('pending', 'deployment-b');
    pending.status!.conditions = [
      { type: 'Initialized', status: 'True' },
      { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
    ];
    const gated = pod('gated', 'deployment-d');
    gated.status!.conditions = [
      { type: 'PodScheduled', status: 'False', reason: 'SchedulingGated' },
    ];
    const foreign = pod('foreign', 'deployment-e', 'node-a');
    foreign.metadata!.namespace = 'other-ns';
    foreign.status!.conditions = pending.status!.conditions;
    f.cluster.pods = [
      held,
      pending,
      gated,
      foreign,
      pod('other', 'deployment-c', 'node-b'),
    ];
    f.cluster.seed({
      kind: 'Secret',
      metadata: { name: 'env', ...owned('a') },
    });
    const cache = await f.synced();
    const names = (pods: V1Pod[]) => pods.map((p) => p.metadata?.name).sort();
    expect(names(cache.pods({ node: 'node-a' }))).toEqual(['foreign', 'held']);
    expect(names(cache.pods({ namespace: 'pool-ns', node: 'node-a' }))).toEqual(
      ['held'],
    );
    expect(
      cache.pods({ namespace: 'pool-ns', component: 'kubernetes-deployment' }),
    ).toHaveLength(4);
    expect(cache.pods({ namespace: 'pool-ns', node: undefined })).toHaveLength(
      4,
    );
    expect(cache.pods({})).toHaveLength(5);
    expect(cache.pods({ namespace: 'elsewhere' })).toEqual([]);

    // A Pod bound to another Node leaves its old Node's index.
    await f.client.objects.patch({
      ...f.cluster.get('Pod', 'pool-ns', 'other'),
      spec: { nodeName: 'node-c', containers: [] },
    });
    await vi.waitFor(() =>
      expect(names(f.loop.cache(CLUSTER).pods({ node: 'node-c' }))).toEqual([
        'other',
      ]),
    );
    expect(f.loop.cache(CLUSTER).pods({ node: 'node-b' })).toEqual([]);

    await f.client.core.deleteNamespacedPod({
      namespace: 'pool-ns',
      name: 'held',
    });
    await vi.waitFor(() =>
      expect(
        f.loop.cache(CLUSTER).get<V1Pod>('Pod', 'pool-ns', 'held')?.metadata
          ?.deletionTimestamp,
      ).toBeInstanceOf(Date),
    );
    await f.client.objects.patch({
      ...f.cluster.get('Pod', 'pool-ns', 'held'),
      metadata: { name: 'held', namespace: 'pool-ns', finalizers: [] },
    });
    await vi.waitFor(() =>
      expect(
        f.loop.cache(CLUSTER).pods({ namespace: 'pool-ns', node: 'node-a' }),
      ).toEqual([]),
    );
  });
});
