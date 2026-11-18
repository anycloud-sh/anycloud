import type {
  V1DeleteOptions,
  V1Deployment as KubernetesDeployment,
  V1Secret,
} from '@kubernetes/client-node';
import { PatchStrategy } from '@kubernetes/client-node';
import {
  ResourceOwnershipError,
  ResourceStateIndeterminateError,
} from '../../../shared/errors.js';
import {
  KUBERNETES_OWNER_API_ANNOTATION,
  KUBERNETES_WORKLOAD_ID_ANNOTATION,
  KUBERNETES_GENERATION_ANNOTATION,
  KUBERNETES_TEMPLATE_ANNOTATION,
  KUBERNETES_USER_ID_ANNOTATION,
  kubernetesWorkloadSecretName,
  type KubernetesSecretKind,
  type KubernetesWorkloadKind,
} from './identity.js';
import { getApiIdentity } from '../api-identity.js';
import type { ClusterKubernetesClient } from './cluster-client.js';

interface KubernetesResourceMetadata {
  metadata?: {
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
}

export interface ManagedKubernetesResource<
  T extends KubernetesResourceMetadata = KubernetesResourceMetadata,
> {
  kind: string;
  namespace: string;
  name: string;
  desired: T;
  create(): Promise<unknown>;
  apply(): Promise<unknown>;
  read(): Promise<T>;
  /** An existing object another controller holds for now; left unapplied. */
  held?(actual: KubernetesResourceMetadata): boolean;
  ownershipErrorMessage: string;
}

export interface OwnedKubernetesResource {
  kind: string;
  namespace: string;
  name: string;
  ownershipLabels?: Record<string, string>;
  read(): Promise<KubernetesResourceMetadata>;
  delete(uid: string): Promise<unknown>;
}

export interface KubernetesResourceOwner {
  workloadId: string;
  userId: string;
}

/**
 * Every delete parameter has to travel in this body. The apiserver decodes
 * delete query parameters only when the request body is empty, so sending
 * preconditions as a body would otherwise drop `propagationPolicy` and
 * `gracePeriodSeconds` and silently fall back to Background propagation.
 */
export function kubernetesDeleteOptionsForUid(
  uid: string,
  propagationPolicy: 'Foreground' | 'Background',
): V1DeleteOptions {
  return {
    apiVersion: 'v1',
    kind: 'DeleteOptions',
    gracePeriodSeconds: 0,
    propagationPolicy,
    preconditions: { uid },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasKubernetesErrorCode(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidates: unknown[] = [
    error,
    'response' in error ? error.response : undefined,
    'body' in error ? error.body : undefined,
  ];
  return candidates.some(
    (candidate) =>
      !!candidate &&
      typeof candidate === 'object' &&
      (('statusCode' in candidate && candidate.statusCode === code) ||
        ('code' in candidate && candidate.code === code)),
  );
}

export function isKubernetesNotFoundError(error: unknown): boolean {
  return hasKubernetesErrorCode(error, 404);
}

export function isKubernetesConflictError(error: unknown): boolean {
  return hasKubernetesErrorCode(error, 409);
}

export function isKubernetesForbiddenError(error: unknown): boolean {
  return hasKubernetesErrorCode(error, 403);
}

export class KubernetesResourceOwnershipError extends ResourceOwnershipError {}

function containsExpectedOwnershipMetadata(
  actual: KubernetesResourceMetadata,
  expected: KubernetesResourceMetadata,
): boolean {
  const expectedLabels = expected.metadata?.labels ?? {};
  const actualLabels = actual.metadata?.labels ?? {};
  const expectedAnnotations = expected.metadata?.annotations ?? {};
  const actualAnnotations = actual.metadata?.annotations ?? {};
  return (
    Object.entries(expectedLabels).every(
      ([key, value]) => actualLabels[key] === value,
    ) &&
    Object.entries(expectedAnnotations).every(
      ([key, value]) =>
        key === KUBERNETES_GENERATION_ANNOTATION ||
        key === KUBERNETES_TEMPLATE_ANNOTATION ||
        actualAnnotations[key] === value ||
        // Objects created before API ownership have no owner
        // annotation. The database startup binding authorizes that legacy
        // adoption path; missing markers never count as owner-marked for
        // broader reconciliation.
        (key === KUBERNETES_OWNER_API_ANNOTATION &&
          actualAnnotations[key] === undefined),
    )
  );
}

async function createOrAdoptKubernetesResource(
  resource: ManagedKubernetesResource,
): Promise<void> {
  try {
    await resource.create();
  } catch (error) {
    if (!isKubernetesConflictError(error)) throw error;
    let actual: KubernetesResourceMetadata;
    try {
      actual = await resource.read();
    } catch (readError) {
      throw new ResourceStateIndeterminateError(
        `Could not inspect ${resource.kind} ${resource.namespace}/${resource.name} after Kubernetes create conflict`,
        readError,
      );
    }
    if (!containsExpectedOwnershipMetadata(actual, resource.desired)) {
      throw new KubernetesResourceOwnershipError(
        resource.ownershipErrorMessage,
      );
    }
    if (resource.held?.(actual)) return;
    await resource.apply();
  }
}

/**
 * Create or adopt resources in deterministic order. Failures deliberately
 * leave any resources already created by this call for durable reconciliation.
 */
export async function ensureKubernetesResourcePlan(
  resources: ManagedKubernetesResource[],
): Promise<void> {
  for (const resource of resources) {
    await createOrAdoptKubernetesResource(resource);
  }
}

type KubernetesResourceOwnership = 'owned' | 'foreign' | 'missing';

interface KubernetesResourceOwnershipObservation {
  ownership: KubernetesResourceOwnership;
  uid?: string;
}

async function readResourceOwnership(
  resource: OwnedKubernetesResource,
  owner: KubernetesResourceOwner,
): Promise<KubernetesResourceOwnershipObservation> {
  try {
    const actual = await resource.read();
    const labels = actual.metadata?.labels ?? {};
    const labelsMatch = Object.entries(resource.ownershipLabels ?? {}).every(
      ([key, value]) => labels[key] === value,
    );
    const annotations = actual.metadata?.annotations ?? {};
    const observedOwnerApi = annotations[KUBERNETES_OWNER_API_ANNOTATION];
    if (
      annotations[KUBERNETES_WORKLOAD_ID_ANNOTATION] !== owner.workloadId ||
      annotations[KUBERNETES_USER_ID_ANNOTATION] !== owner.userId ||
      (observedOwnerApi !== undefined &&
        observedOwnerApi !== getApiIdentity()) ||
      !labelsMatch
    ) {
      return { ownership: 'foreign' };
    }
    const uid = actual.metadata?.uid;
    if (!uid) {
      throw new Error(
        `${resource.kind} ${resource.namespace}/${resource.name} is missing its Kubernetes UID`,
      );
    }
    return { ownership: 'owned', uid };
  } catch (error) {
    if (isKubernetesNotFoundError(error)) return { ownership: 'missing' };
    throw error;
  }
}

async function deleteOwnedKubernetesResource(
  resource: OwnedKubernetesResource,
  owner: KubernetesResourceOwner,
  deadline: number,
  intervalMs: number,
): Promise<void> {
  const initial = await readResourceOwnership(resource, owner);
  if (initial.ownership !== 'owned') return;
  const expectedUid = initial.uid!;

  try {
    await resource.delete(expectedUid);
  } catch (error) {
    if (
      !isKubernetesNotFoundError(error) &&
      !isKubernetesConflictError(error)
    ) {
      throw error;
    }
  }

  // A missing/foreign object or a same-owner replacement is not the exact
  // resource whose deletion this cleanup admitted.
  let current = await readResourceOwnership(resource, owner);
  while (current.ownership === 'owned' && current.uid === expectedUid) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out deleting ${resource.kind} ${resource.namespace}/${resource.name}`,
      );
    }
    await sleep(intervalMs);
    current = await readResourceOwnership(resource, owner);
  }
}

/**
 * Delete owned resources in order and confirm each exact UID is gone before
 * advancing. Deterministic same-name replacements are never followed.
 */
export async function deleteKubernetesResourcePlan(
  resources: OwnedKubernetesResource[],
  owner: KubernetesResourceOwner,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  for (const resource of resources) {
    await deleteOwnedKubernetesResource(resource, owner, deadline, intervalMs);
  }
}

/** The workload manifests every per-workload plan below is built from. */
interface KubernetesWorkloadManifests {
  namespace: string;
  name: string;
  secrets: V1Secret[];
  kubernetesDeployment: KubernetesDeployment;
}

export function serverSideApply(
  cluster: { objects: Pick<ClusterKubernetesClient['objects'], 'patch'> },
  fieldManager: string,
  desired: object,
): Promise<unknown> {
  return cluster.objects.patch(
    desired,
    undefined,
    undefined,
    fieldManager,
    true,
    PatchStrategy.ServerSideApply,
  );
}

export function kubernetesWorkloadOwner(
  manifests: KubernetesWorkloadManifests,
): KubernetesResourceOwner {
  const annotations =
    manifests.kubernetesDeployment.metadata?.annotations ?? {};
  return {
    workloadId: annotations[KUBERNETES_WORKLOAD_ID_ANNOTATION] ?? '',
    userId: annotations[KUBERNETES_USER_ID_ANNOTATION] ?? '',
  };
}

export function managedKubernetesSecrets(
  cluster: ClusterKubernetesClient,
  fieldManager: string,
  { namespace, secrets }: KubernetesWorkloadManifests,
): ManagedKubernetesResource[] {
  return secrets.map((secret) => {
    const name = secret.metadata?.name ?? '';
    return {
      kind: 'Secret',
      namespace,
      name,
      desired: secret,
      create: () =>
        cluster.core.createNamespacedSecret({
          namespace,
          body: secret,
          fieldManager,
        }),
      apply: () => serverSideApply(cluster, fieldManager, secret),
      read: () => cluster.core.readNamespacedSecret({ namespace, name }),
      ownershipErrorMessage: 'Kubernetes Secret is owned by another workload',
    };
  });
}

export function managedKubernetesDeployment(
  cluster: ClusterKubernetesClient,
  fieldManager: string,
  { namespace, name, kubernetesDeployment }: KubernetesWorkloadManifests,
): ManagedKubernetesResource {
  return {
    kind: 'Deployment',
    namespace,
    name,
    desired: kubernetesDeployment,
    create: () =>
      cluster.apps.createNamespacedDeployment({
        namespace,
        body: kubernetesDeployment,
        fieldManager,
      }),
    apply: () => serverSideApply(cluster, fieldManager, kubernetesDeployment),
    read: () => cluster.apps.readNamespacedDeployment({ namespace, name }),
    ownershipErrorMessage: 'Kubernetes Deployment is owned by another workload',
  };
}

/** Desired Secrets plus every Secret the workload kind may have left behind. */
export function ownedKubernetesSecrets(
  cluster: ClusterKubernetesClient,
  kind: KubernetesWorkloadKind,
  secretKinds: KubernetesSecretKind[],
  manifests: KubernetesWorkloadManifests,
): OwnedKubernetesResource[] {
  const namespace = manifests.namespace;
  const desired = new Map(
    manifests.secrets.map((secret) => [secret.metadata?.name ?? '', secret]),
  );
  const workloadId = kubernetesWorkloadOwner(manifests).workloadId;
  const names = new Set([
    ...desired.keys(),
    ...secretKinds.map((secretKind) =>
      kubernetesWorkloadSecretName(kind, workloadId, secretKind),
    ),
  ]);
  return [...names].map((name) => ({
    kind: 'Secret',
    namespace,
    name,
    ownershipLabels:
      desired.get(name)?.metadata?.labels ??
      manifests.kubernetesDeployment.metadata?.labels,
    read: () => cluster.core.readNamespacedSecret({ namespace, name }),
    delete: (uid) =>
      cluster.core.deleteNamespacedSecret({
        namespace,
        name,
        body: kubernetesDeleteOptionsForUid(uid, 'Background'),
      }),
  }));
}

export function ownedKubernetesDeployment(
  cluster: ClusterKubernetesClient,
  { namespace, name, kubernetesDeployment }: KubernetesWorkloadManifests,
): OwnedKubernetesResource {
  return {
    kind: 'Deployment',
    namespace,
    name,
    ownershipLabels: kubernetesDeployment.metadata?.labels,
    read: () => cluster.apps.readNamespacedDeployment({ namespace, name }),
    delete: (uid) =>
      cluster.apps.deleteNamespacedDeployment({
        namespace,
        name,
        body: kubernetesDeleteOptionsForUid(uid, 'Foreground'),
      }),
  };
}

/** Create or adopt the plan, then delete owned Secrets the manifests no longer render. */
export async function ensureKubernetesWorkloadPlan(
  manifests: KubernetesWorkloadManifests,
  managed: ManagedKubernetesResource[],
  owned: OwnedKubernetesResource[],
): Promise<void> {
  await ensureKubernetesResourcePlan(managed);
  const desiredSecretNames = new Set(
    manifests.secrets.map((secret) => secret.metadata?.name ?? ''),
  );
  await deleteKubernetesResourcePlan(
    owned.filter(
      (resource) =>
        resource.kind === 'Secret' && !desiredSecretNames.has(resource.name),
    ),
    kubernetesWorkloadOwner(manifests),
    { timeoutMs: 60_000 },
  );
}
