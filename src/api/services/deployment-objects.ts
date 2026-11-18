import { createHash } from 'node:crypto';
import packageJson from '../../../package.json' with { type: 'json' };
import { apiImageTagReference } from '../../shared/system-release.js';
import type {
  KubernetesObject,
  V1Pod,
  V1Deployment as KubernetesDeployment,
  V1Secret,
  V1ServiceAccount,
} from '@kubernetes/client-node';
import { type StoredDeployment } from './deployment-store.js';
import type { DeploymentRuntimeObservation } from './deployment-status.js';
import type { ClusterKubernetesClient } from './kubernetes/cluster-client.js';
import {
  KUBERNETES_GENERATION_ANNOTATION,
  KUBERNETES_OWNER_API_ANNOTATION,
  KUBERNETES_TEMPLATE_ANNOTATION,
  KUBERNETES_USER_ID_ANNOTATION,
  KUBERNETES_WORKLOAD_ID_ANNOTATION,
  kubernetesWorkloadIdentity,
  kubernetesWorkloadSecretName,
} from './kubernetes/identity.js';
import type { NodePoolRuntimeIdentity } from './kubernetes/deployment-runtime.js';
import { ensureNodePoolNamespace } from './kubernetes/node-pool-namespace.js';
import {
  ensureKubernetesResourcePlan,
  isKubernetesConflictError,
  isKubernetesNotFoundError,
  kubernetesDeleteOptionsForUid,
  kubernetesWorkloadOwner,
  managedKubernetesDeployment,
  managedKubernetesSecrets,
  ownedKubernetesDeployment,
  ownedKubernetesSecrets,
  serverSideApply,
  type ManagedKubernetesResource,
  type OwnedKubernetesResource,
} from './kubernetes/managed-resources.js';
import {
  ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
  KUBERNETES_DEPLOYMENT_CONTAINER,
  latestPod,
  podPendingReason,
  podTemplate,
  renderDeployment,
  type PodTemplateSpec,
} from './kubernetes/pool-objects.js';
import {
  normalizeKubernetesCpus,
  normalizeKubernetesMemory,
  replicaSize,
} from './kubernetes/pod-options.js';
import { kubernetesRequestOptions } from './kubernetes/request-options.js';
import {
  KVM_RESOURCE,
  USER_NAMESPACE_POD_OVERHEAD_MI,
} from './kubernetes/user-namespace.js';
import {
  USER_NAMESPACE_RUNNER_EXIT_CODE,
  type DockerOptions,
} from '../../shared/runtime.js';
import { quantity } from './pool-fit.js';
import { assertRequestActive } from './request-budget.js';

const FIELD_MANAGER = 'anycloud-cluster-deployment';
/** 'runtime-auth' only cleans up Secrets from before G2 dropped the login token. */
const SECRET_KINDS = [
  'runtime-auth',
  'registry-auth',
  'application-env',
] as const;

/**
 * K9's requests and memory limit for a replica, from `replicaSize`; a
 * user-namespace replica's leave room for its class's Pod overhead and, on
 * a pool with nested virtualization, take `/dev/kvm` (RFC 0049 C32).
 */
function replicaRequests(
  pool: NodePoolRuntimeIdentity,
  gpus: number,
  dockerOptions: DockerOptions | null,
): NonNullable<PodTemplateSpec['hardening']> {
  const userNamespace = dockerOptions?.userNamespace === true;
  const size = replicaSize(
    pool.nodeSize,
    pool.nvidiaGpusPerNode,
    gpus,
    dockerOptions?.cpus,
    userNamespace ? USER_NAMESPACE_POD_OVERHEAD_MI : 0,
  );
  const requests = {
    cpu: normalizeKubernetesCpus(size.cpus)!,
    memory: normalizeKubernetesMemory(size.memory)!,
  };
  const limits = {
    ...(size.memoryLimit && {
      memory: normalizeKubernetesMemory(size.memoryLimit)!,
    }),
    ...(userNamespace && pool.kvm && { [KVM_RESOURCE]: '1' }),
  };
  return Object.keys(limits).length > 0 ? { requests, limits } : { requests };
}

/**
 * RFC 0043 D-disk: a managed replica requests, and is limited to, its GPU
 * fraction of the Node's allocatable `ephemeral-storage` on a GPU pool and
 * its CPU fraction on a CPU pool, so its writable layer and the three paths
 * never crowd a neighbour. A pool of unknown disk size sets none.
 */
function managedReplicaRequests(
  deployment: StoredDeployment,
  pool: NodePoolRuntimeIdentity,
): NonNullable<PodTemplateSpec['hardening']> {
  const hardening = replicaRequests(
    pool,
    deployment.gpuCount,
    deployment.config.dockerOptions,
  );
  const node = pool.ephemeralStorage;
  const gpuPool = pool.nvidiaGpusPerNode > 0;
  if (!deployment.managed || !node || (!gpuPool && !node.vCPUs)) {
    return hardening;
  }
  const fraction = gpuPool
    ? deployment.gpuCount / pool.nvidiaGpusPerNode
    : quantity(hardening.requests.cpu, 1000) / 1000 / node.vCPUs;
  const storage = `${Math.floor(node.allocatableGi * Math.min(fraction, 1) * 1024)}Mi`;
  return {
    requests: { ...hardening.requests, 'ephemeral-storage': storage },
    limits: { ...hardening.limits, 'ephemeral-storage': storage },
  };
}

/** A Deployment record's native objects, rendered from the record alone. */
export interface DeploymentObjects {
  namespace: string;
  name: string;
  podSelector: string;
  kubernetesDeployment: KubernetesDeployment;
  serviceAccount: V1ServiceAccount;
  secrets: V1Secret[];
}

/**
 * The Deployment owner's render: a thin wrapper over `podTemplate()` and
 * `renderDeployment`. Env and named Secrets travel in one owned Secret, with
 * env overriding a named value; the template depends only on whether there
 * is any, so a rotated value changes the Secret and restarts nothing.
 * `secretsEnv` is the record's named Secrets resolved for an apply; reads
 * and deletion only need the names.
 */
export function renderDeploymentObjects(
  deployment: StoredDeployment,
  namespace: string,
  workloadApiUrl: string,
  nodePool: NodePoolRuntimeIdentity,
  secretsEnv: Record<string, string> = {},
): DeploymentObjects {
  const identity = kubernetesWorkloadIdentity({
    kind: 'deployment',
    workloadId: deployment.id,
    userId: deployment.ownerUserId,
  });
  identity.annotations[KUBERNETES_GENERATION_ANNOTATION] = String(
    deployment.generation,
  );
  const { name } = identity;
  const env = deployment.config.env ?? {};
  const { template, secrets } = podTemplate({
    namespace,
    identity,
    workloadName: 'Kubernetes Deployment',
    request: {
      workloadId: deployment.id,
      image: deployment.config.image,
      imageDigest: deployment.config.imageDigest,
      env: null,
      githubToken: deployment.config.registryToken,
      gpuCount: deployment.gpuCount,
      dockerOptions: deployment.config.dockerOptions,
    },
    command: deployment.config.command,
    // A managed Deployment's replicas run pool Jobs through the runner, which
    // `runner-install` copies from the API's own release image (RFC 0044).
    ...(deployment.managed && {
      runner: {
        installImage: apiImageTagReference(packageJson.version),
        entrypoint: deployment.config.entrypoint ?? [],
        cmd: deployment.config.command ?? [],
      },
    }),
    extraEnv: {
      ANYCLOUD_API_URL: workloadApiUrl,
      ANYCLOUD_DEPLOYMENT_ID: deployment.id,
    },
    clusterId: nodePool.clusterId,
    nodePoolId: nodePool.nodePoolId,
    capability: { nvidiaGpus: nodePool.nvidiaGpusPerNode },
    container: { readinessProbe: deployment.readinessProbe ?? undefined },
    gracePeriodSeconds: deployment.gracePeriodSeconds,
    envSecret:
      Object.keys(env).length > 0 || deployment.secretNames.length > 0
        ? {
            name: kubernetesWorkloadSecretName(
              'deployment',
              deployment.id,
              'application-env',
            ),
            values: { ...secretsEnv, ...env },
          }
        : undefined,
    runtimeIdentity: {
      serviceAccountName: name,
      audience: ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
      // Registering or removing the name rolls the replicas by the hash.
      ...(deployment.apiIdentity && { apiToken: true }),
    },
    finalizer: true,
    hardening: managedReplicaRequests(deployment, nodePool),
  });
  const kubernetesDeployment = renderDeployment({
    name,
    namespace,
    identity,
    template,
    replicas: deployment.minReplicas,
  });
  kubernetesDeployment.metadata!.annotations = {
    ...identity.annotations,
    [KUBERNETES_TEMPLATE_ANNOTATION]: createHash('sha256')
      .update(JSON.stringify(template))
      .digest('hex')
      .slice(0, 16),
  };
  return {
    namespace,
    name,
    podSelector: identity.podSelector,
    kubernetesDeployment,
    serviceAccount: {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name,
        namespace,
        labels: identity.labels,
        annotations: identity.annotations,
      },
      automountServiceAccountToken: false,
    },
    secrets,
  };
}

/** The record generation a native Kubernetes Deployment was applied at. */
export function appliedGenerationOf(
  current: KubernetesDeployment | null | undefined,
): number | null {
  if (!current) return null;
  const generation = Number(
    current.metadata?.annotations?.[KUBERNETES_GENERATION_ANNOTATION],
  );
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

/** Every field `desired` sets, `actual` has: server defaults don't count. */
function contains(actual: unknown, desired: unknown): boolean {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((value, index) => contains(actual[index], value))
    );
  }
  if (desired && typeof desired === 'object') {
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(desired).every(([key, value]) =>
        contains((actual as Record<string, unknown>)[key], value),
      )
    );
  }
  // Quantities and counts may come back as numbers or strings.
  return String(actual) === String(desired as string | number | boolean);
}

/** A Secret as the API server stores it: base64 `data`, no `stringData`. */
function storedSecret(secret: V1Secret): V1Secret {
  const data = { ...secret.data };
  for (const [key, value] of Object.entries(secret.stringData ?? {})) {
    data[key] = Buffer.from(value).toString('base64');
  }
  return { ...secret, stringData: undefined, data };
}

export function ownedResources(
  cluster: ClusterKubernetesClient,
  objects: DeploymentObjects,
): OwnedKubernetesResource[] {
  const { namespace, name } = objects;
  return [
    ownedKubernetesDeployment(cluster, objects),
    ...ownedKubernetesSecrets(
      cluster,
      'deployment',
      [...SECRET_KINDS],
      objects,
    ),
    {
      kind: 'ServiceAccount',
      namespace,
      name,
      ownershipLabels: objects.serviceAccount.metadata?.labels,
      read: () =>
        cluster.core.readNamespacedServiceAccount({ namespace, name }),
      delete: (uid) =>
        cluster.core.deleteNamespacedServiceAccount({
          namespace,
          name,
          body: kubernetesDeleteOptionsForUid(uid, 'Background'),
        }),
    },
  ];
}

/**
 * Whether a cached object is this record's, as the delete plan's live read
 * checks: an object from before API ownership has no owner annotation.
 */
export function ownedHere(
  object: KubernetesObject | undefined,
  objects: DeploymentObjects,
): object is KubernetesObject {
  const want = objects.serviceAccount.metadata!.annotations!;
  const have = object?.metadata?.annotations ?? {};
  return (
    !!object &&
    have[KUBERNETES_WORKLOAD_ID_ANNOTATION] ===
      want[KUBERNETES_WORKLOAD_ID_ANNOTATION] &&
    have[KUBERNETES_USER_ID_ANNOTATION] ===
      want[KUBERNETES_USER_ID_ANNOTATION] &&
    (have[KUBERNETES_OWNER_API_ANNOTATION] ??
      want[KUBERNETES_OWNER_API_ANNOTATION]) ===
      want[KUBERNETES_OWNER_API_ANNOTATION]
  );
}

/** Delete one cached object by its exact UID; one already gone or replaced is left. */
export async function deleteCached(
  remove: (
    body: ReturnType<typeof kubernetesDeleteOptionsForUid>,
  ) => Promise<unknown>,
  object: KubernetesObject,
  propagation: 'Foreground' | 'Background',
): Promise<void> {
  try {
    await remove(
      kubernetesDeleteOptionsForUid(object.metadata!.uid!, propagation),
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

/**
 * Kubernetes's own "rollout complete": the controller has seen the current
 * spec and made its ReplicaSet available. A later readiness loss leaves it set.
 */
function rolledOut(current: KubernetesDeployment | null): boolean {
  return (
    !!current?.status &&
    current.status.observedGeneration === current.metadata?.generation &&
    !!current.status.conditions?.some(
      (condition) =>
        condition.type === 'Progressing' &&
        condition.reason === 'NewReplicaSetAvailable',
    )
  );
}

/**
 * Waiting reasons that don't resolve on their own: kubelet's settled
 * back-offs, and a malformed image name (image inspection accepts one it
 * can't parse, and kubelet never retries it). ErrImagePull and the config
 * errors also fire on a registry rate limit or a Secret that arrives later.
 */
const CONTAINER_FAILURE_REASONS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'InvalidImageName',
]);

/** Restarts with the same exec failure before the runner counts as unable to run. */
const RUNNER_EXEC_RESTARTS = 3;

/**
 * Why no replica of a managed Deployment can run a Job (RFC 0044 § Waiting
 * for capacity), or null: a pull the registry refuses (not found or
 * unauthorized), a runner that can't execute in the image (exit 126 or
 * 127, as tini reports a missing loader) across several restarts, or, at
 * its first restart, a user-namespace runner that can't delegate its
 * cgroup, which fails the same way every time (RFC 0049 C32). A runner
 * that claimed never exits so: it reports its Job's exit instead.
 */
export function replicaCannotRun(
  pod: V1Pod,
): { message: string; pull: boolean } | null {
  const container = pod.status?.containerStatuses?.find(
    (status) => status.name === KUBERNETES_DEPLOYMENT_CONTAINER,
  );
  const waiting = container?.state?.waiting;
  if (
    (waiting?.reason === 'ErrImagePull' ||
      waiting?.reason === 'ImagePullBackOff') &&
    /not found|manifest unknown|unauthorized|denied|forbidden/iu.test(
      waiting.message ?? '',
    )
  ) {
    return {
      message: `The image can't be pulled: ${waiting.message}`,
      pull: true,
    };
  }
  const exit = container?.lastState?.terminated?.exitCode;
  if (exit === USER_NAMESPACE_RUNNER_EXIT_CODE) {
    return {
      message:
        container?.lastState?.terminated?.message ??
        `The runner exited ${exit}: see anycloud deployment logs`,
      pull: false,
    };
  }
  if (
    (exit === 126 || exit === 127) &&
    (container?.restartCount ?? 0) >= RUNNER_EXEC_RESTARTS
  ) {
    return {
      message: `The runner can't execute in the image (exit ${exit}): ${container?.lastState?.terminated?.message ?? 'see anycloud deployment logs'}`,
      pull: false,
    };
  }
  return null;
}

export async function observeDeployment(
  cluster: ClusterKubernetesClient,
  objects: DeploymentObjects,
  signal?: AbortSignal,
  /** Why spend caps or the pool's Node shape hold an unbound replica. */
  capBlock: (pod: V1Pod) => Promise<string | null> = async () => null,
): Promise<DeploymentRuntimeObservation> {
  assertRequestActive(signal);
  const { namespace, name } = objects;
  const [pods, current] = await Promise.all([
    cluster.core.listNamespacedPod(
      { namespace, labelSelector: objects.podSelector, limit: 100 },
      kubernetesRequestOptions(signal),
    ),
    cluster.apps
      .readNamespacedDeployment(
        { namespace, name },
        kubernetesRequestOptions(signal),
      )
      .catch((error: unknown) => {
        assertRequestActive(signal);
        if (isKubernetesNotFoundError(error)) return null;
        throw error;
      }),
  ]);
  assertRequestActive(signal);
  let page = pods;
  let pod = latestPod(page.items);
  // Keep only one page and its newest Pod. The caller's observation deadline
  // bounds pagination as well as the first request.
  while (page.metadata?._continue) {
    page = await cluster.core.listNamespacedPod(
      {
        namespace,
        labelSelector: objects.podSelector,
        limit: 100,
        _continue: page.metadata._continue,
      },
      kubernetesRequestOptions(signal),
    );
    assertRequestActive(signal);
    pod = latestPod(pod ? [pod, ...page.items] : page.items);
  }
  const container = pod?.status?.containerStatuses?.find(
    (status) => status.name === KUBERNETES_DEPLOYMENT_CONTAINER,
  );
  const specification = pod?.spec?.containers.find(
    (value) => value.name === KUBERNETES_DEPLOYMENT_CONTAINER,
  );
  const generation = Number(
    pod?.metadata?.annotations?.[KUBERNETES_GENERATION_ANNOTATION],
  );
  const blocked = pod && !pod.spec?.nodeName ? await capBlock(pod) : null;
  assertRequestActive(signal);
  const podTerminating = !!pod?.metadata?.deletionTimestamp;
  const containerRunning =
    !!container?.state?.running &&
    pod?.status?.phase === 'Running' &&
    !podTerminating;
  return {
    workload: {
      observedGeneration:
        Number.isSafeInteger(generation) && generation > 0 ? generation : null,
      podName: pod?.metadata?.name ?? null,
      podUid: pod?.metadata?.uid ?? null,
      containerId: container?.containerID ?? null,
      containerReady: container?.ready === true,
      pendingReason: blocked ?? podPendingReason(pod),
    },
    appliedGeneration: appliedGenerationOf(current),
    rolledOut: rolledOut(current),
    containerReady: container ? containerRunning && container.ready : null,
    readyReplicas: current?.status?.readyReplicas ?? 0,
    containerRunning,
    containerFailed: CONTAINER_FAILURE_REASONS.has(
      container?.state?.waiting?.reason ?? '',
    ),
    podTerminating,
    probeConfigured: specification ? !!specification.readinessProbe : null,
    observedAt: Date.now(),
  };
}

/**
 * Apply each owned object that is missing from the cache or differs from
 * it, and delete owned Secrets no longer rendered. A Secret's keys must
 * match exactly: one that lost a key is replaced, because its create, not
 * the later apply, owns the keys. `rollout` gates the native Deployment.
 */
export async function applyDiffering(
  cluster: ClusterKubernetesClient,
  desired: DeploymentObjects,
  cached: (kind: string, name: string) => KubernetesObject | undefined,
  pool: NodePoolRuntimeIdentity,
  rollout: boolean,
  /** This pass already ensured the namespace (and its egress policy). */
  ensured = false,
): Promise<void> {
  const { namespace } = desired;
  const plan: ManagedKubernetesResource[] = [];
  if (
    !contains(cached('ServiceAccount', desired.name), desired.serviceAccount)
  ) {
    plan.push({
      kind: 'ServiceAccount',
      namespace,
      name: desired.name,
      desired: desired.serviceAccount,
      create: () =>
        cluster.core.createNamespacedServiceAccount({
          namespace,
          body: desired.serviceAccount,
          fieldManager: FIELD_MANAGER,
        }),
      apply: () =>
        serverSideApply(cluster, FIELD_MANAGER, desired.serviceAccount),
      read: () =>
        cluster.core.readNamespacedServiceAccount({
          namespace,
          name: desired.name,
        }),
      ownershipErrorMessage:
        'Kubernetes ServiceAccount is owned by another workload',
    });
  }
  for (const secret of managedKubernetesSecrets(
    cluster,
    FIELD_MANAGER,
    desired,
  )) {
    const current = cached('Secret', secret.name) as V1Secret | undefined;
    const want = storedSecret(secret.desired as V1Secret);
    const shrunk =
      ownedHere(current, desired) &&
      Object.keys(current.data ?? {}).some((key) => !(key in want.data!));
    if (shrunk) {
      await deleteCached(
        (body) =>
          cluster.core.deleteNamespacedSecret({
            namespace,
            name: secret.name,
            body,
          }),
        current!,
        'Background',
      );
    }
    if (shrunk || !contains(current, want)) plan.push(secret);
  }
  if (
    rollout &&
    !contains(cached('Deployment', desired.name), desired.kubernetesDeployment)
  ) {
    plan.push(managedKubernetesDeployment(cluster, FIELD_MANAGER, desired));
  }
  if (plan.length > 0 && !ensured) {
    // The node pool namespace is shared by every Deployment on the node
    // pool and owned by the node pool; a foreign namespace of that name
    // fails closed here before any object is written into it.
    await ensureNodePoolNamespace(cluster, pool);
  }
  await ensureKubernetesResourcePlan(plan);
  const rendered = new Set(
    desired.secrets.map((secret) => secret.metadata?.name),
  );
  const { workloadId } = kubernetesWorkloadOwner(desired);
  for (const kind of SECRET_KINDS) {
    const name = kubernetesWorkloadSecretName('deployment', workloadId, kind);
    const stale = cached('Secret', name);
    if (rendered.has(name) || !ownedHere(stale, desired)) continue;
    await deleteCached(
      (body) => cluster.core.deleteNamespacedSecret({ namespace, name, body }),
      stale,
      'Background',
    );
  }
}
