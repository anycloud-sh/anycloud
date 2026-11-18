import type {
  KubernetesObject,
  KubernetesObjectApi,
} from '@kubernetes/client-node';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import type { ClusterRecordRepository } from '../cluster-store.js';
import { log } from '../logger.js';
import {
  isKubernetesConflictError,
  isKubernetesForbiddenError,
  isKubernetesNotFoundError,
} from './managed-resources.js';
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  CLUSTER_ADDON_LABEL,
  CLUSTER_ADDON_REVISION_ANNOTATION,
  CLUSTER_ADDONS,
  clusterAddonRevision,
  type ClusterAddon,
  type ClusterAddonNeed,
  type ClusterAddonResource,
} from './cluster-addons.js';
import { CLUSTER_NODE_LABEL } from './node-pool-scheduling.js';
import type { ClusterRuntime } from './cluster-runtime.js';

const FIELD_MANAGER = 'anycloud-cluster-addons';
const RECREATE_POLL_ATTEMPTS = 20;
const RECREATE_POLL_INTERVAL_MS = 250;

type ClusterAddonResourceOutcome =
  | 'created'
  | 'replaced'
  | 'recreated'
  | 'unchanged'
  | 'accepted';

export interface ClusterAddonReport {
  clusterId: string;
  resources: Array<{
    addon: string;
    kind: string;
    name: string;
    outcome: ClusterAddonResourceOutcome;
  }>;
  /** One line naming every object and its outcome, for diagnostics. */
  summary: string;
}

function objectRef(resource: Pick<ClusterAddonResource, 'namespace'>) {
  return resource.namespace ? ` -n ${resource.namespace}` : '';
}

export class ClusterAddonOwnershipError extends Error {
  constructor(
    clusterId: string,
    addon: string,
    resource: ClusterAddonResource,
    current: KubernetesObject,
  ) {
    const owner = current.metadata?.labels?.[CLUSTER_NODE_LABEL];
    const why =
      (current.metadata?.ownerReferences?.length ?? 0) > 0
        ? 'it has owner references'
        : owner === undefined
          ? 'it carries no anycloud.sh/cluster label'
          : `it is labelled anycloud.sh/cluster=${owner}, which is neither this cluster nor a destroyed cluster of this control plane`;
    super(
      `cluster ${clusterId}: ${resource.kind} ${resource.name} exists but is not owned by the ${addon} add-on of this cluster (${why}); refusing to adopt or replace a foreign object. Remove it if it is stale (kubectl delete ${resource.kind.toLowerCase()} ${resource.name}${objectRef(resource)}) and the node pool retries`,
    );
    this.name = 'ClusterAddonOwnershipError';
  }
}

export class ClusterAddonPermissionError extends Error {
  constructor(
    clusterId: string,
    resource: ClusterAddonResource,
    verb: string,
    cause: unknown,
  ) {
    super(
      `cluster ${clusterId}: the registered identity may not ${verb} ${resource.kind} ${resource.name} (${errorMessage(cause)}); grant it ${verb} on ${resource.apiResource}${
        resource.namespace ? ` in ${resource.namespace}` : ''
      } and the node pool retries`,
    );
    this.name = 'ClusterAddonPermissionError';
  }
}

export class ClusterAddonPendingError extends Error {
  constructor(clusterId: string, kind: string, name: string, why: string) {
    super(`cluster ${clusterId}: ${kind} ${name} ${why}; retrying`);
    this.name = 'ClusterAddonPendingError';
  }
}

export interface ClusterAddonController {
  /**
   * Converge every add-on the need requires on the runtime's cluster. Calls for
   * the same cluster are coalesced; the returned report describes what changed.
   */
  ensure(
    runtime: ClusterRuntime,
    need: ClusterAddonNeed,
  ): Promise<ClusterAddonReport>;
  /**
   * Remove the objects a need owns (a deleted node pool's ingress release,
   * or a pool-scoped add-on its last pool needed), in reverse order, never
   * an add-on every pool needs. Foreign or absent objects are left alone;
   * the result names each object and whether it was deleted.
   */
  remove(
    runtime: ClusterRuntime,
    need: ClusterAddonNeed,
  ): Promise<
    Array<{ name: string; outcome: 'deleted' | 'absent' | 'foreign' }>
  >;
}

type ObjectApi = Pick<
  KubernetesObjectApi,
  'read' | 'create' | 'replace' | 'delete'
>;

interface AppliedIdentity {
  uid: string;
  generation: number;
}

function withRevision<T extends KubernetesObject>(desired: T): T {
  return {
    ...desired,
    metadata: {
      ...desired.metadata,
      annotations: {
        ...desired.metadata?.annotations,
        [CLUSTER_ADDON_REVISION_ANNOTATION]: clusterAddonRevision(desired),
      },
    },
  };
}

/**
 * Owned means labelled for this add-on by this cluster or by a destroyed cluster that
 * bound the same control plane, with no owner references. The runtime's
 * identity is the verified `kube-system` UID, so predecessor ids fence the
 * adoption to objects this installation itself put on this control plane.
 */
function ownedByAddon(
  current: KubernetesObject,
  clusterId: string,
  predecessorClusterIds: ReadonlySet<string>,
  addon: string,
): 'own' | 'predecessor' | null {
  const labels = current.metadata?.labels ?? {};
  if (
    labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE ||
    labels[CLUSTER_ADDON_LABEL] !== addon ||
    (current.metadata?.ownerReferences?.length ?? 0) > 0
  ) {
    return null;
  }
  const owner = labels[CLUSTER_NODE_LABEL];
  if (owner === clusterId) return 'own';
  if (owner !== undefined && predecessorClusterIds.has(owner)) {
    return 'predecessor';
  }
  return null;
}

async function writeOrExplain<T>(
  clusterId: string,
  resource: ClusterAddonResource,
  verb: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isKubernetesForbiddenError(error)) {
      throw new ClusterAddonPermissionError(clusterId, resource, verb, error);
    }
    throw error;
  }
}

function identityOf(object: KubernetesObject): AppliedIdentity | null {
  const uid = object.metadata?.uid;
  if (!uid) return null;
  return { uid, generation: object.metadata?.generation ?? 0 };
}

function header(resource: ClusterAddonResource) {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.name,
      ...(resource.namespace ? { namespace: resource.namespace } : {}),
    },
  };
}

async function readCurrent(
  objects: ObjectApi,
  resource: ClusterAddonResource,
): Promise<KubernetesObject | null> {
  try {
    return await objects.read(header(resource));
  } catch (error) {
    if (isKubernetesNotFoundError(error)) return null;
    throw error;
  }
}

export function createClusterAddonController(deps: {
  addons?: readonly ClusterAddon[];
  /** Deleted clusterRecords of the same control plane, whose objects may be adopted. */
  clusterRecords?: Pick<ClusterRecordRepository, 'listDestroyedClusterIds'>;
  sleep?: (ms: number) => Promise<void>;
}): ClusterAddonController {
  const addons = deps.addons ?? CLUSTER_ADDONS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // What this process last wrote, per cluster and object. A restart forgets it
  // and the next pass issues one idempotent replace (or adopts an immutable
  // object whose revision matches); drift by another writer moves the
  // generation and is re-converged on the next pass.
  const applied = new Map<string, AppliedIdentity>();
  const inFlight = new Map<string, Promise<ClusterAddonReport>>();

  function appliedKey(
    clusterId: string,
    resource: ClusterAddonResource,
  ): string {
    return `${clusterId}\u0000${resource.kind}\u0000${resource.namespace ?? ''}\u0000${resource.name}`;
  }

  async function create(
    objects: ObjectApi,
    clusterId: string,
    resource: ClusterAddonResource,
    key: string,
    desired: KubernetesObject,
  ): Promise<void> {
    const created = await writeOrExplain(clusterId, resource, 'create', () =>
      objects.create(desired, undefined, undefined, FIELD_MANAGER),
    );
    const identity = identityOf(created);
    if (identity) applied.set(key, identity);
    else applied.delete(key);
  }

  async function reconcileResource(
    objects: ObjectApi,
    clusterId: string,
    predecessorClusterIds: ReadonlySet<string>,
    addon: ClusterAddon,
    resource: ClusterAddonResource,
  ): Promise<ClusterAddonResourceOutcome> {
    const key = appliedKey(clusterId, resource);
    const desired = withRevision(resource.desired);
    const desiredRevision =
      desired.metadata!.annotations![CLUSTER_ADDON_REVISION_ANNOTATION];

    let current = await readCurrent(objects, resource);
    if (!current) {
      try {
        await create(objects, clusterId, resource, key, desired);
        return 'created';
      } catch (error) {
        if (!isKubernetesConflictError(error)) throw error;
        // Lost a create race; validate the winner like any existing object.
        current = await readCurrent(objects, resource);
        if (!current) {
          throw new ClusterAddonPendingError(
            clusterId,
            resource.kind,
            resource.name,
            'was created and removed during reconciliation',
          );
        }
      }
    }

    if (current.metadata?.deletionTimestamp) {
      applied.delete(key);
      throw new ClusterAddonPendingError(
        clusterId,
        resource.kind,
        resource.name,
        'is being deleted',
      );
    }
    const ownership = ownedByAddon(
      current,
      clusterId,
      predecessorClusterIds,
      addon.name,
    );
    if (ownership === null) {
      applied.delete(key);
      if (resource.acceptForeign?.(current)) return 'accepted';
      throw new ClusterAddonOwnershipError(
        clusterId,
        addon.name,
        resource,
        current,
      );
    }
    if (ownership === 'predecessor') {
      // The old cluster's labels differ from the desired ones, so the normal
      // replace or recreate below converges the object onto this cluster.
      log.info('Adopting add-on object installed by a destroyed cluster', {
        clusterId,
        previousClusterId: current.metadata?.labels?.[CLUSTER_NODE_LABEL],
        kind: resource.kind,
        name: resource.name,
      });
    }
    const identity = identityOf(current);
    const resourceVersion = current.metadata?.resourceVersion;
    if (!identity || !resourceVersion) {
      throw new Error(
        `cluster ${clusterId}: ${resource.kind} ${resource.name} omitted its resource identity`,
      );
    }
    const revisionMatches =
      current.metadata?.annotations?.[CLUSTER_ADDON_REVISION_ANNOTATION] ===
      desiredRevision;
    const last = applied.get(key);
    if (
      revisionMatches &&
      last?.uid === identity.uid &&
      last.generation === identity.generation
    ) {
      return 'unchanged';
    }

    if (resource.requiresRecreate(current)) {
      // Delete only the observed object; a same-name successor is left alone
      // and judged on the next pass.
      await writeOrExplain(clusterId, resource, 'delete', () =>
        objects.delete(
          header(resource),
          undefined,
          undefined,
          0,
          undefined,
          'Foreground',
          {
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: {
              uid: identity.uid,
              resourceVersion,
            },
          },
        ),
      );
      applied.delete(key);
      for (let attempt = 0; attempt < RECREATE_POLL_ATTEMPTS; attempt += 1) {
        const remaining = await readCurrent(objects, resource);
        if (!remaining) {
          await create(objects, clusterId, resource, key, desired);
          return 'recreated';
        }
        if (remaining.metadata?.uid !== identity.uid) {
          throw new ClusterAddonPendingError(
            clusterId,
            resource.kind,
            resource.name,
            'was replaced by another writer while being recreated',
          );
        }
        await sleep(RECREATE_POLL_INTERVAL_MS);
      }
      throw new ClusterAddonPendingError(
        clusterId,
        resource.kind,
        resource.name,
        'is still terminating',
      );
    }

    if (revisionMatches && resource.specImmutable) {
      // Nothing outside metadata can differ from what the revision names, so
      // the object is adopted as written without a no-op PUT.
      applied.set(key, identity);
      return 'unchanged';
    }

    // The complete desired object replaces the current one, so fields added
    // by another writer do not survive. UID and resourceVersion fence the
    // write against a concurrent replacement or edit.
    const replaced = await writeOrExplain(clusterId, resource, 'update', () =>
      objects.replace(
        {
          ...desired,
          metadata: {
            ...desired.metadata,
            uid: identity.uid,
            resourceVersion,
          },
        },
        undefined,
        undefined,
        FIELD_MANAGER,
      ),
    );
    const after = identityOf(replaced);
    if (after) applied.set(key, after);
    else applied.delete(key);
    return 'replaced';
  }

  async function ensureNow(
    runtime: ClusterRuntime,
    need: ClusterAddonNeed,
  ): Promise<ClusterAddonReport> {
    const resources: ClusterAddonReport['resources'] = [];
    const needed = addons.filter((addon) => addon.neededBy(need));
    const predecessorClusterIds = new Set(
      needed.length > 0 && deps.clusterRecords
        ? (
            await deps.clusterRecords.listDestroyedClusterIds(
              runtime.kubernetesIdentity,
            )
          ).filter((id) => id !== runtime.clusterId)
        : [],
    );
    for (const addon of needed) {
      for (const resource of addon.resources(runtime.clusterId, need)) {
        const outcome = await reconcileResource(
          runtime.cluster.objects,
          runtime.clusterId,
          predecessorClusterIds,
          addon,
          resource,
        );
        resources.push({
          addon: addon.name,
          kind: resource.kind,
          name: resource.namespace
            ? `${resource.namespace}/${resource.name}`
            : resource.name,
          outcome,
        });
      }
    }
    return {
      clusterId: runtime.clusterId,
      resources,
      summary:
        resources
          .map((entry) => `${entry.kind} ${entry.name} ${entry.outcome}`)
          .join(', ') || 'no add-ons required',
    };
  }

  async function removeNow(
    runtime: ClusterRuntime,
    need: ClusterAddonNeed,
  ): ReturnType<ClusterAddonController['remove']> {
    const removed: Awaited<ReturnType<ClusterAddonController['remove']>> = [];
    // An add-on every pool needs, like the Node status policy, outlives any
    // one pool's removal. In reverse of creation, so an add-on's guard
    // outlives what it guards.
    const poolScoped = addons.filter(
      (entry) => entry.neededBy(need) && !entry.neededBy({ nvidiaGpus: 0 }),
    );
    for (const addon of poolScoped.reverse()) {
      for (const resource of addon
        .resources(runtime.clusterId, need)
        .reverse()) {
        const current = await readCurrent(runtime.cluster.objects, resource);
        const name = resource.namespace
          ? `${resource.namespace}/${resource.name}`
          : resource.name;
        if (!current) {
          removed.push({ name, outcome: 'absent' });
          continue;
        }
        const labels = current.metadata?.labels ?? {};
        if (
          labels[CLUSTER_ADDON_LABEL] !== addon.name ||
          labels[CLUSTER_NODE_LABEL] !== runtime.clusterId
        ) {
          removed.push({ name, outcome: 'foreign' });
          continue;
        }
        await runtime.cluster.objects.delete(
          header(resource),
          undefined,
          undefined,
          0,
          undefined,
          'Foreground',
          {
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: current.metadata?.uid },
          },
        );
        applied.delete(appliedKey(runtime.clusterId, resource));
        removed.push({ name, outcome: 'deleted' });
      }
    }
    return removed;
  }

  return {
    remove: removeNow,
    ensure(runtime, need) {
      // Coalesce concurrent callers for one cluster; a superset need is served
      // by the in-flight pass only when it covers the same add-ons.
      const key = `${runtime.clusterId}\u0000${need.ingressNodePoolId ?? ''}\u0000${addons
        .filter((addon) => addon.neededBy(need))
        .map((addon) => addon.name)
        .join(',')}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pass = ensureNow(runtime, need).finally(() => {
        if (inFlight.get(key) === pass) inFlight.delete(key);
      });
      inFlight.set(key, pass);
      return pass;
    },
  };
}
