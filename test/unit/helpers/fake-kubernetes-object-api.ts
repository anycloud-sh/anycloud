import type {
  KubernetesObject,
  KubernetesObjectApi,
  V1DeleteOptions,
} from '@kubernetes/client-node';
import { vi } from 'vitest';

type Header = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
};

export interface FakeKubernetesObjectApi {
  api: Pick<
    KubernetesObjectApi,
    'read' | 'create' | 'replace' | 'delete' | 'list'
  >;
  /** Every stored object, keyed `kind/namespace/name`. */
  objects: Map<string, KubernetesObject>;
  /** Verb log in call order. */
  calls: Array<{ verb: 'read' | 'create' | 'replace' | 'delete'; key: string }>;
  /** Insert an object as if another writer created it. */
  seed<T extends KubernetesObject>(object: T): T;
  /** Edit an object in place as another writer would (bumps generation). */
  drift(key: string, edit: (object: KubernetesObject) => void): void;
  /** Deletes set `deletionTimestamp` instead of removing until released. */
  holdDeletes: boolean;
  releaseHeldDeletes(): void;
}

function keyOf(header: Header): string {
  return `${header.kind}/${header.metadata?.namespace ?? ''}/${header.metadata?.name}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function status(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function specOf(object: KubernetesObject): string {
  const {
    metadata: _metadata,
    status: _status,
    ...rest
  } = object as Record<string, unknown>;
  return canonicalJson(rest);
}

export function createFakeKubernetesObjectApi(): FakeKubernetesObjectApi {
  const objects = new Map<string, KubernetesObject>();
  const calls: FakeKubernetesObjectApi['calls'] = [];
  let sequence = 0;
  const state = { holdDeletes: false };

  const read = vi.fn(async (header: Header) => {
    const key = keyOf(header);
    calls.push({ verb: 'read', key });
    const current = objects.get(key);
    if (!current) throw status(404, `${key} not found`);
    return clone(current);
  });
  const create = vi.fn(async (body: KubernetesObject) => {
    const key = keyOf(body);
    calls.push({ verb: 'create', key });
    if (objects.has(key)) throw status(409, `${key} already exists`);
    sequence += 1;
    const stored = clone({
      ...body,
      metadata: {
        ...body.metadata,
        uid: `uid-${sequence}`,
        resourceVersion: '1',
        generation: 1,
      },
    });
    objects.set(key, stored);
    return clone(stored);
  });
  const replace = vi.fn(async (body: KubernetesObject) => {
    const key = keyOf(body);
    calls.push({ verb: 'replace', key });
    const current = objects.get(key);
    if (!current) throw status(404, `${key} not found`);
    if (body.metadata?.uid && body.metadata.uid !== current.metadata?.uid) {
      throw status(409, `${key}: UID precondition failed`);
    }
    if (
      body.metadata?.resourceVersion !== undefined &&
      body.metadata.resourceVersion !== current.metadata?.resourceVersion
    ) {
      throw status(409, `${key}: resourceVersion conflict`);
    }
    const stored = clone({
      ...body,
      metadata: {
        ...body.metadata,
        uid: current.metadata?.uid,
        resourceVersion: String(Number(current.metadata?.resourceVersion) + 1),
        generation:
          specOf(body) === specOf(current)
            ? current.metadata?.generation
            : (current.metadata?.generation ?? 0) + 1,
      },
    });
    objects.set(key, stored);
    return clone(stored);
  });
  const del = vi.fn(
    async (
      header: Header,
      _pretty?: string,
      _dryRun?: string,
      _grace?: number,
      _orphan?: boolean,
      _propagation?: string,
      body?: V1DeleteOptions,
    ) => {
      const key = keyOf(header);
      calls.push({ verb: 'delete', key });
      const current = objects.get(key);
      if (!current) throw status(404, `${key} not found`);
      const preconditions = body?.preconditions;
      if (
        (preconditions?.uid && preconditions.uid !== current.metadata?.uid) ||
        (preconditions?.resourceVersion &&
          preconditions.resourceVersion !== current.metadata?.resourceVersion)
      ) {
        throw status(409, `${key}: delete precondition failed`);
      }
      if (state.holdDeletes) {
        current.metadata = {
          ...current.metadata,
          deletionTimestamp: new Date('2026-09-25T00:00:00Z'),
        };
      } else {
        objects.delete(key);
      }
      return {};
    },
  );

  // Kind-wide list with an optional `key[=value]` label selector; not logged
  // (status reads are not part of the reconcile verb sequences tests assert).
  const list = (
    _apiVersion: string,
    kind: string,
    namespace?: string,
    _pretty?: string,
    _exact?: boolean,
    _exportt?: boolean,
    _fieldSelector?: string,
    labelSelector?: string,
  ) => {
    const [key, value] = labelSelector?.split('=') ?? [];
    return Promise.resolve({
      items: [...objects.values()].filter(
        (object) =>
          object.kind === kind &&
          (!namespace || object.metadata?.namespace === namespace) &&
          (!key ||
            (object.metadata?.labels?.[key] !== undefined &&
              (value === undefined || object.metadata.labels[key] === value))),
      ),
    });
  };

  return {
    api: {
      read: read as unknown as KubernetesObjectApi['read'],
      create: create as unknown as KubernetesObjectApi['create'],
      replace: replace as unknown as KubernetesObjectApi['replace'],
      delete: del as unknown as KubernetesObjectApi['delete'],
      list: list as unknown as KubernetesObjectApi['list'],
    },
    objects,
    calls,
    seed<T extends KubernetesObject>(object: T): T {
      sequence += 1;
      const stored = clone({
        ...object,
        metadata: {
          uid: `uid-${sequence}`,
          resourceVersion: '1',
          generation: 1,
          ...object.metadata,
        },
      });
      objects.set(keyOf(stored), stored);
      return stored;
    },
    drift(key, edit) {
      const current = objects.get(key);
      if (!current) throw new Error(`${key} not stored`);
      edit(current);
      current.metadata = {
        ...current.metadata,
        resourceVersion: String(Number(current.metadata?.resourceVersion) + 1),
        generation: (current.metadata?.generation ?? 0) + 1,
      };
    },
    get holdDeletes() {
      return state.holdDeletes;
    },
    set holdDeletes(value: boolean) {
      state.holdDeletes = value;
    },
    releaseHeldDeletes() {
      for (const [key, object] of objects) {
        if (object.metadata?.deletionTimestamp) objects.delete(key);
      }
    },
  };
}
