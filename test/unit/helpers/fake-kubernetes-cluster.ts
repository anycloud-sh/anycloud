import type {
  KubernetesObject,
  V1Deployment,
  V1DeploymentSpec,
  V1Namespace,
  V1Pod,
  V1PodList,
  V1PodSpec,
  V1Secret,
  V1Service,
  V1ServiceAccount,
  V1Status,
} from '@kubernetes/client-node';
import type { ClusterKubernetesClient } from '../../../src/api/services/kubernetes/cluster-client.js';
import {
  KubernetesHttpError,
  type KubernetesListWatch,
} from '../../../src/api/services/kubernetes/list-watch.js';
import { makeClusterKubernetesClientFixture } from './fixtures.js';

interface StoredObject {
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
    finalizers?: string[];
    deletionTimestamp?: Date;
    creationTimestamp?: Date;
  };
  [key: string]: unknown;
}

export interface FakeKubernetesCall {
  op:
    | 'create'
    | 'apply'
    | 'patch'
    | 'log'
    | 'delete'
    | 'read'
    | 'list'
    | 'watch';
  kind: string;
  namespace: string;
  name: string;
  uidPrecondition?: string;
  propagationPolicy?: string;
  gracePeriodSeconds?: number;
  previous?: boolean;
}

interface DeleteOptions {
  preconditions?: { uid?: string };
  propagationPolicy?: string;
  gracePeriodSeconds?: number;
}

function statusError(code: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: code, code });
}

const KIND_BY_PATH: Record<string, string> = {
  '/api/v1/pods': 'Pod',
  '/apis/apps/v1/deployments': 'Deployment',
  '/api/v1/secrets': 'Secret',
  '/api/v1/serviceaccounts': 'ServiceAccount',
  '/api/v1/nodes': 'Node',
  '/apis/networking.k8s.io/v1/networkpolicies': 'NetworkPolicy',
};

function selects(selector: string | undefined, object: StoredObject): boolean {
  const [key, value] = (selector ?? '').split('=');
  return !key || object.metadata?.labels?.[key] === value;
}

type KubernetesWatchEvent = Parameters<
  Parameters<KubernetesListWatch['watch']>[3]
>[0];
/**
 * What a real API server stores for each CPU and memory quantity the specs
 * render, written out by hand from Kubernetes' canonical quantity rules (the
 * largest exact suffix, keeping decimal or binary format) rather than
 * computed by the production normalizers. A raw form that a regression could
 * render maps to its canonical form, so the diff-only apply would see the
 * difference; a quantity missing here fails the spec.
 */
const STORED_QUANTITIES: Record<string, string> = {
  '100m': '100m',
  '128Mi': '128Mi',
  '1': '1',
  '1Gi': '1Gi',
  '0.29': '290m',
  '290m': '290m',
  '64000000': '64M',
  '64M': '64M',
};

function storedQuantity(quantity: string): string {
  const stored = STORED_QUANTITIES[quantity];
  if (stored === undefined) {
    throw new Error(`Add the stored form of ${quantity} to STORED_QUANTITIES`);
  }
  return stored;
}

/**
 * What the API server stores for a Pod spec: an empty env value is dropped
 * (omitempty) and CPU quantities are canonical.
 */
function storedPodSpec(spec: V1PodSpec | undefined): V1PodSpec | undefined {
  if (!spec) return spec;
  return {
    ...spec,
    containers: spec.containers.map((container) => ({
      ...container,
      env: container.env?.map(({ value, ...env }) =>
        value === '' || value === undefined ? env : { ...env, value },
      ),
      resources: container.resources && {
        ...container.resources,
        ...Object.fromEntries(
          (['requests', 'limits'] as const).map((side) => {
            const values = container.resources?.[side];
            return [
              side,
              values && {
                ...values,
                ...(values.cpu ? { cpu: storedQuantity(values.cpu) } : {}),
                ...(values.memory
                  ? { memory: storedQuantity(values.memory) }
                  : {}),
              },
            ];
          }),
        ),
      },
    })),
  };
}

type WatchType = Exclude<KubernetesWatchEvent['type'], 'BOOKMARK'>;
interface Watcher {
  deliver(type: WatchType, object: StoredObject): void;
  bookmark(): void;
  end(): void;
}

/**
 * In-memory Kubernetes API for the object kinds a node pool Service owns.
 * Deletes remove objects immediately unless the test holds a kind back with
 * `holdDeletion`, which mimics a terminating namespace. Stored objects are
 * returned as the SDK type the caller asked for; the fake models the calls
 * the runtime makes, not the SDK's full request shapes.
 */
export class FakeKubernetesCluster {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: FakeKubernetesCall[] = [];
  private nextUid = 1;
  private readonly heldDeletions = new Set<string>();
  /** Every change, as a watch replays it from a resourceVersion. */
  private readonly events: {
    resourceVersion: number;
    type: WatchType;
    object: StoredObject;
  }[] = [];
  private readonly watchers = new Set<Watcher>();
  private readonly failures: Error[] = [];
  resourceVersion = 0;
  /** Each container's log by `pod/container`, and `pod/container/previous`. */
  readonly logs = new Map<string, string>();
  /** A watch from a resourceVersion below this one answers 410 Gone. */
  compactedBelow = 0;

  get pods(): V1Pod[] {
    return [...this.objects.values()].filter(
      (object) => object.kind === 'Pod',
    ) as V1Pod[];
  }

  /** Replace every Pod, as kubelet and the controllers would. */
  set pods(pods: V1Pod[]) {
    const keep = new Set(
      pods.map((pod) =>
        this.key(
          'Pod',
          pod.metadata?.namespace ?? '',
          pod.metadata?.name ?? '',
        ),
      ),
    );
    for (const [key, object] of this.objects) {
      if (object.kind === 'Pod' && !keep.has(key)) {
        this.objects.delete(key);
        this.record('DELETED', object);
      }
    }
    for (const pod of pods) {
      const object: StoredObject = { ...pod, kind: 'Pod' };
      this.store(object);
    }
  }

  /** The next list or watch requests fail with these, in order. */
  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  /** The API server ends every open watch session, as at its timeout. */
  endWatches(): void {
    for (const watcher of [...this.watchers]) watcher.end();
  }

  bookmark(): void {
    for (const watcher of this.watchers) watcher.bookmark();
  }

  private store(object: StoredObject): StoredObject {
    const key = this.key(
      object.kind ?? '',
      object.kind === 'Namespace' ? '' : (object.metadata?.namespace ?? ''),
      object.metadata?.name ?? '',
    );
    const existed = this.objects.has(key);
    // The API server keeps a Secret's stringData as base64 data.
    const { stringData, ...rest } = object as StoredObject & {
      stringData?: Record<string, string>;
      data?: Record<string, string>;
    };
    if (stringData) {
      rest.data = { ...rest.data };
      for (const [name, value] of Object.entries(stringData))
        rest.data[name] = Buffer.from(value).toString('base64');
    }
    if (rest.kind === 'Pod') {
      rest.spec = storedPodSpec(rest.spec as V1PodSpec | undefined);
    }
    const template = (rest.spec as V1DeploymentSpec | undefined)?.template;
    if (rest.kind === 'Deployment' && template) {
      rest.spec = {
        ...(rest.spec as V1DeploymentSpec),
        template: { ...template, spec: storedPodSpec(template.spec) },
      };
    }
    const stored = {
      ...rest,
      metadata: {
        ...rest.metadata,
        resourceVersion: String(++this.resourceVersion),
      },
    };
    this.objects.set(key, stored);
    this.record(existed ? 'MODIFIED' : 'ADDED', stored, false);
    return stored;
  }

  private record(type: WatchType, object: StoredObject, bump = true): void {
    if (bump) this.resourceVersion++;
    const copy = structuredClone(object);
    copy.metadata = {
      ...copy.metadata,
      resourceVersion: String(this.resourceVersion),
    };
    this.events.push({
      resourceVersion: this.resourceVersion,
      type,
      object: copy,
    });
    for (const watcher of this.watchers) watcher.deliver(type, copy);
  }

  private injected(): void {
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  /** Cluster-wide list-and-watch, counted in `calls` like every other read. */
  private listWatch(): KubernetesListWatch {
    return {
      list: (path, query) => {
        const kind = KIND_BY_PATH[path] ?? path;
        this.calls.push({ op: 'list', kind, namespace: '', name: '' });
        this.injected();
        return Promise.resolve({
          // A real list's items carry no kind or apiVersion.
          items: structuredClone(
            [...this.objects.values()]
              .filter(
                (object) =>
                  object.kind === kind && selects(query.labelSelector, object),
              )
              .map(({ kind: _kind, apiVersion: _apiVersion, ...item }) => item),
          ) as KubernetesObject[],
          resourceVersion: String(this.resourceVersion),
        });
      },
      watch: async (path, query, signal, onEvent) => {
        const kind = KIND_BY_PATH[path] ?? path;
        this.calls.push({ op: 'watch', kind, namespace: '', name: '' });
        this.injected();
        const from = Number(query.resourceVersion);
        if (from < this.compactedBelow) throw new KubernetesHttpError(410);
        const matches = (object: StoredObject) =>
          object.kind === kind && selects(query.labelSelector, object);
        for (const event of this.events) {
          if (event.resourceVersion > from && matches(event.object))
            onEvent({ type: event.type, object: event.object });
        }
        await new Promise<void>((resolve, reject) => {
          const watcher: Watcher = {
            deliver: (type, object) => {
              if (matches(object)) onEvent({ type, object });
            },
            bookmark: () =>
              onEvent({
                type: 'BOOKMARK',
                object: {
                  metadata: { resourceVersion: String(this.resourceVersion) },
                },
              }),
            end: () => {
              this.watchers.delete(watcher);
              resolve();
            },
          };
          this.watchers.add(watcher);
          signal.addEventListener(
            'abort',
            () => {
              this.watchers.delete(watcher);
              reject(signal.reason as Error);
            },
            { once: true },
          );
        });
      },
    };
  }

  key(kind: string, namespace: string, name: string): string {
    return `${kind}/${namespace}/${name}`;
  }

  /** Seed an object as another owner would have created it. */
  seed(object: StoredObject & { kind: string }): StoredObject {
    return this.store({
      ...object,
      metadata: {
        creationTimestamp: new Date(),
        ...object.metadata,
        uid: object.metadata?.uid ?? `uid-${this.nextUid++}`,
      },
    });
  }

  get(kind: string, namespace: string, name: string): StoredObject | undefined {
    return this.objects.get(this.key(kind, namespace, name));
  }

  holdDeletion(kind: string, namespace: string, name: string): void {
    this.heldDeletions.add(this.key(kind, namespace, name));
  }

  releaseDeletion(kind: string, namespace: string, name: string): void {
    const key = this.key(kind, namespace, name);
    this.heldDeletions.delete(key);
    const object = this.objects.get(key);
    if (object && this.objects.delete(key)) this.record('DELETED', object);
  }

  private create<T>(
    kind: string,
    namespace: string,
    body: StoredObject,
  ): Promise<T> {
    const name = body.metadata?.name ?? '';
    this.calls.push({ op: 'create', kind, namespace, name });
    const key = this.key(kind, namespace, name);
    if (this.objects.has(key)) {
      throw statusError(409, `${kind} ${namespace}/${name} already exists`);
    }
    const stored = this.store({
      ...body,
      kind,
      metadata: {
        ...body.metadata,
        namespace,
        uid: `uid-${this.nextUid++}`,
        creationTimestamp: new Date(),
      },
    });
    return Promise.resolve(stored as T);
  }

  private read<T>(kind: string, namespace: string, name: string): Promise<T> {
    this.calls.push({ op: 'read', kind, namespace, name });
    const found = this.objects.get(this.key(kind, namespace, name));
    if (!found) {
      throw statusError(404, `${kind} ${namespace}/${name} not found`);
    }
    return Promise.resolve(found as T);
  }

  private apply<T extends KubernetesObject>(body: T): Promise<T> {
    return this.applyStored(body) as Promise<T>;
  }

  private applyStored(body: KubernetesObject): Promise<KubernetesObject> {
    const kind = body.kind ?? '';
    const namespace =
      kind === 'Namespace' ? '' : (body.metadata?.namespace ?? '');
    const name = body.metadata?.name ?? '';
    this.calls.push({ op: 'apply', kind, namespace, name });
    const key = this.key(kind, namespace, name);
    const existing = this.objects.get(key);
    const stored = this.store({
      ...existing,
      ...body,
      kind,
      metadata: {
        ...existing?.metadata,
        ...body.metadata,
        uid: existing?.metadata?.uid ?? `uid-${this.nextUid++}`,
      },
    });
    // The last finalizer's removal completes a held delete.
    if (
      stored.metadata?.deletionTimestamp &&
      !stored.metadata.finalizers?.length
    ) {
      this.objects.delete(key);
      this.record('DELETED', stored);
    }
    return Promise.resolve(stored as KubernetesObject);
  }

  private delete<T>(
    kind: string,
    namespace: string,
    name: string,
    body: DeleteOptions | undefined,
  ): Promise<T> {
    this.calls.push({
      op: 'delete',
      kind,
      namespace,
      name,
      uidPrecondition: body?.preconditions?.uid,
      propagationPolicy: body?.propagationPolicy,
      gracePeriodSeconds: body?.gracePeriodSeconds,
    });
    const key = this.key(kind, namespace, name);
    const found = this.objects.get(key);
    if (!found) {
      throw statusError(404, `${kind} ${namespace}/${name} not found`);
    }
    if (
      body?.preconditions?.uid !== undefined &&
      body.preconditions.uid !== found.metadata?.uid
    ) {
      throw statusError(409, `${kind} ${namespace}/${name} UID mismatch`);
    }
    if (found.metadata?.finalizers?.length) {
      // Finalizers hold the object, marked terminating, until removed.
      this.store({
        ...found,
        metadata: {
          ...found.metadata,
          deletionTimestamp: found.metadata.deletionTimestamp ?? new Date(),
        },
      });
    } else if (!this.heldDeletions.has(key)) {
      this.objects.delete(key);
      this.record('DELETED', found);
    }
    const status: V1Status = {};
    return Promise.resolve(status as T);
  }

  /** A JSON patch of a Pod's finalizers, guarded by its `test` operations. */
  private patchPod(
    namespace: string,
    name: string,
    operations: { op: string; path: string; value?: unknown }[],
  ): Promise<V1Pod> {
    this.calls.push({ op: 'patch', kind: 'Pod', namespace, name });
    const found = this.objects.get(this.key('Pod', namespace, name));
    if (!found) throw statusError(404, `Pod ${namespace}/${name} not found`);
    const patched = structuredClone(found);
    for (const { op, path, value } of operations) {
      const [, , field, index] = path.split('/');
      const metadata = patched.metadata as Record<string, unknown>;
      const current =
        index === undefined
          ? metadata[field!]
          : (metadata[field!] as unknown[] | undefined)?.[Number(index)];
      if (op === 'test' && current !== value) {
        throw statusError(422, `test of ${path} failed`);
      }
      if (op === 'remove') {
        (metadata[field!] as unknown[]).splice(Number(index), 1);
      }
    }
    const stored = this.applyStored(patched);
    this.calls.pop(); // The patch, not an apply.
    return stored.then(() => patched as V1Pod);
  }

  /** A JSON patch of a Deployment's replica count, guarded by its UID. */
  private patchDeploymentReplicas(
    namespace: string,
    name: string,
    operations: { op: string; path: string; value?: unknown }[],
  ): Promise<V1Deployment> {
    this.calls.push({ op: 'patch', kind: 'Deployment', namespace, name });
    const found = this.objects.get(this.key('Deployment', namespace, name));
    if (!found) {
      throw statusError(404, `Deployment ${namespace}/${name} not found`);
    }
    const patched = structuredClone(found) as V1Deployment;
    for (const { op, path, value } of operations) {
      if (op === 'test' && path === '/metadata/uid') {
        if (patched.metadata?.uid !== value) {
          throw statusError(422, `test of ${path} failed`);
        }
      } else if (op === 'replace' && path === '/spec/replicas') {
        patched.spec!.replicas = value as number;
      } else {
        throw new Error(`unsupported Deployment patch ${op} ${path}`);
      }
    }
    const stored = this.applyStored(patched as StoredObject);
    this.calls.pop(); // The patch, not an apply.
    return stored.then(() => patched);
  }

  client(): ClusterKubernetesClient {
    const namespaced =
      <T>(kind: string) =>
      ({ namespace, body }: { namespace: string; body: StoredObject }) =>
        this.create<T>(kind, namespace, body);
    const reader =
      <T>(kind: string) =>
      ({ namespace, name }: { namespace: string; name: string }) =>
        this.read<T>(kind, namespace, name);
    const deleter =
      <T>(kind: string) =>
      ({
        namespace,
        name,
        body,
      }: {
        namespace: string;
        name: string;
        body?: DeleteOptions;
      }) =>
        this.delete<T>(kind, namespace, name, body);
    const listNamespacedPod = ({
      namespace,
    }: {
      namespace: string;
    }): Promise<V1PodList> => {
      this.calls.push({ op: 'list', kind: 'Pod', namespace, name: '' });
      return Promise.resolve({ items: this.pods });
    };
    return makeClusterKubernetesClientFixture({
      listWatch: this.listWatch(),
      core: {
        createNamespace: ({ body }: { body: StoredObject }) =>
          this.create<V1Namespace>('Namespace', '', body),
        readNamespace: ({ name }: { name: string }) =>
          this.read<V1Namespace>('Namespace', '', name),
        deleteNamespace: ({
          name,
          body,
        }: {
          name: string;
          body?: DeleteOptions;
        }) => this.delete<V1Status>('Namespace', '', name, body),
        createNamespacedSecret: namespaced<V1Secret>('Secret'),
        readNamespacedSecret: reader<V1Secret>('Secret'),
        deleteNamespacedSecret: deleter<V1Status>('Secret'),
        createNamespacedService: namespaced<V1Service>('Service'),
        readNamespacedService: reader<V1Service>('Service'),
        deleteNamespacedService: deleter<V1Service>('Service'),
        createNamespacedServiceAccount:
          namespaced<V1ServiceAccount>('ServiceAccount'),
        readNamespacedServiceAccount:
          reader<V1ServiceAccount>('ServiceAccount'),
        deleteNamespacedServiceAccount: deleter<V1Status>('ServiceAccount'),
        listNamespacedPod,
        readNamespacedPod: reader<V1Pod>('Pod'),
        deleteNamespacedPod: deleter<V1Pod>('Pod'),
        patchNamespacedPod: ({
          namespace,
          name,
          body,
        }: {
          namespace: string;
          name: string;
          body: { op: string; path: string; value?: unknown }[];
        }) => this.patchPod(namespace, name, body),
      },
      log: {
        log: async (
          namespace: string,
          pod: string,
          container: string,
          sink: NodeJS.WritableStream,
          options?: unknown,
        ) => {
          const previous =
            (options as { previous?: boolean } | undefined)?.previous === true;
          this.calls.push({
            op: 'log',
            kind: 'Pod',
            namespace,
            name: pod,
            previous,
          });
          const log = this.logs.get(
            `${pod}/${container}${previous ? '/previous' : ''}`,
          );
          if (log === undefined) {
            throw statusError(400, 'previous terminated container not found');
          }
          sink.end(Buffer.from(log));
          return new AbortController();
        },
      },
      apps: {
        createNamespacedDeployment: namespaced<V1Deployment>('Deployment'),
        readNamespacedDeployment: reader<V1Deployment>('Deployment'),
        deleteNamespacedDeployment: deleter<V1Status>('Deployment'),
        patchNamespacedDeployment: ({
          namespace,
          name,
          body,
        }: {
          namespace: string;
          name: string;
          body: { op: string; path: string; value?: unknown }[];
        }) => this.patchDeploymentReplicas(namespace, name, body),
      },
      objects: {
        patch: <T extends KubernetesObject>(body: T) => this.apply(body),
        // Generic object access, as the IngressRoute (a CRD) uses it.
        create: <T extends KubernetesObject>(body: T) =>
          this.create<T>(
            body.kind ?? '',
            body.metadata?.namespace ?? '',
            body as unknown as StoredObject,
          ),
        read: <T extends KubernetesObject>(header: KubernetesObject) =>
          this.read<T>(
            header.kind ?? '',
            header.metadata?.namespace ?? '',
            header.metadata?.name ?? '',
          ),
        list: <T extends KubernetesObject>(
          _apiVersion: string,
          kind: string,
          namespace?: string,
          _pretty?: string,
          _exact?: boolean,
          _exportt?: boolean,
          _fieldSelector?: string,
          labelSelector?: string,
        ) => {
          this.calls.push({
            op: 'list',
            kind,
            namespace: namespace ?? '',
            name: '',
          });
          const key = labelSelector?.split('=')[0];
          const value = labelSelector?.split('=')[1];
          return Promise.resolve({
            items: [...this.objects.values()].filter(
              (object) =>
                object.kind === kind &&
                (!namespace || object.metadata?.namespace === namespace) &&
                (!key ||
                  (object.metadata?.labels?.[key] !== undefined &&
                    (value === undefined ||
                      object.metadata.labels[key] === value))),
            ) as unknown as T[],
          });
        },
        delete: (
          header: KubernetesObject,
          _pretty?: string,
          _dryRun?: string,
          _grace?: number,
          _orphan?: boolean,
          _propagation?: string,
          body?: DeleteOptions,
        ) =>
          this.delete<V1Status>(
            header.kind ?? '',
            header.metadata?.namespace ?? '',
            header.metadata?.name ?? '',
            body,
          ),
      },
    });
  }
}
