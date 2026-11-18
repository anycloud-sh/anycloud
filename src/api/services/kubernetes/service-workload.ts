import type {
  V1Deployment as KubernetesDeployment,
  V1Namespace,
  V1Pod,
  V1Secret,
  V1Service as KubernetesService,
} from '@kubernetes/client-node';
import type { DockerOptions } from '../../../shared/runtime.js';
import { resolveServiceContainerPort } from '../network.js';
import type { ClusterKubernetesClient } from './cluster-client.js';
import {
  KUBERNETES_DEPLOYMENT_CONTAINER,
  latestPod,
  podTemplate,
  renderDeployment,
} from './pool-objects.js';
import {
  kubernetesWorkloadIdentity,
  kubernetesWorkloadResourceName,
  kubernetesWorkloadSecretName,
} from './identity.js';
import {
  deleteKubernetesResourcePlan,
  ensureKubernetesWorkloadPlan,
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
} from './managed-resources.js';
import {
  INGRESS_ENTRY_NODE_LABEL,
  NODE_POOL_NODE_LABEL,
  CLUSTER_NODE_LABEL,
  type NodePoolCapabilityConstraint,
} from './node-pool-scheduling.js';
import {
  ENTRY_HANDOFF_LABEL,
  POOL_INGRESS_ROUTE_LABEL,
} from './node-pool-ingress.js';
import { kubernetesRequestOptions } from './request-options.js';

const FIELD_MANAGER = 'anycloud-node-pool-service';
const SERVICE_PORT_NAME = 'http';
/** In-cluster port of the stable native Service; the Pod listens on `$PORT`. */
export const KUBERNETES_SERVICE_PORT = 80;
const PROBE_PERIOD_SECONDS = 5;
/** Matches the VM-host container setup allowance of ten minutes. */
const STARTUP_FAILURE_THRESHOLD = 120;
/** The VM-host Service startup dwell before a container counts as serving. */
const MIN_READY_SECONDS = 30;

/** Desired Service revision as AnyCloud stores it; native objects render from it. */
export interface NodePoolServiceSpec {
  workloadId: string;
  /** Workload owner recorded on every native object for ownership checks. */
  userId: string;
  registryUsername: string;
  clusterId: string;
  nodePoolId: string;
  /** What each node pool Node advertises; the Pod template must match it. */
  capability: NodePoolCapabilityConstraint;
  image: string;
  imageDigest: string | null;
  command: string[] | null;
  env: Record<string, string> | null;
  registryToken: string | null;
  /** `gpus`, when set, is the whole-device count admission resolved. */
  dockerOptions: DockerOptions | null;
  /** Named runtime Secrets resolved at reconcile time; user env overrides them. */
  secretsEnv: Record<string, string> | null;
}

/** Traefik's route object; the pool's Traefik watches only routes labelled for its pool. */
interface KubernetesIngressRoute {
  apiVersion: 'traefik.io/v1alpha1';
  kind: 'IngressRoute';
  metadata: V1Namespace['metadata'];
  spec: {
    entryPoints: string[];
    routes: Array<{
      kind: 'Rule';
      match: string;
      services: Array<{ name: string; port: number; nativeLB?: boolean }>;
    }>;
  };
}

/** The public hostname a Service is published under, VM-host and node pool alike. */
export function serviceHostname(workloadId: string): string {
  return `${workloadId}.anycloud.sh`;
}

export interface NodePoolServiceManifests {
  namespace: string;
  name: string;
  podSelector: string;
  containerPort: number;
  kubernetesNamespace: V1Namespace;
  secrets: V1Secret[];
  kubernetesDeployment: KubernetesDeployment;
  kubernetesService: KubernetesService;
  /** `<workload id>.anycloud.sh`, the host the route matches and DNS publishes. */
  hostname: string;
  ingressRoute: KubernetesIngressRoute;
}

/**
 * Every native object a node pool Service owns lives in its own namespace, so
 * ordinary deletion never touches a sibling Service, the node pool or the
 * cluster. The namespace carries the node pool and cluster labels so an operator
 * can attribute it; scheduling is still enforced on the Pod template.
 */
export function buildNodePoolServiceManifests(
  spec: NodePoolServiceSpec,
): NodePoolServiceManifests {
  const identity = kubernetesWorkloadIdentity({
    kind: 'serve',
    workloadId: spec.workloadId,
    userId: spec.userId,
  });
  const namespace = kubernetesWorkloadResourceName('serve', spec.workloadId);
  const name = identity.name;
  const containerPort = resolveServiceContainerPort(spec.env);
  // User environment and named Secret values travel in one Secret rather than
  // in the Pod template. Explicit user values override named Secret values,
  // matching the VM-host precedence.
  const applicationEnv = { ...(spec.secretsEnv ?? {}), ...(spec.env ?? {}) };
  const { template, secrets } = podTemplate({
    namespace,
    identity,
    workloadName: 'Service',
    request: {
      workloadId: spec.workloadId,
      image: spec.image,
      imageDigest: spec.imageDigest,
      env: null,
      githubToken: spec.registryToken,
      gpuCount: Number(spec.dockerOptions?.gpus ?? 0),
      dockerOptions: spec.dockerOptions,
    },
    command: spec.command,
    extraEnv: { PORT: String(containerPort) },
    clusterId: spec.clusterId,
    nodePoolId: spec.nodePoolId,
    capability: spec.capability,
    container: {
      ports: [{ name: SERVICE_PORT_NAME, containerPort }],
      startupProbe: {
        tcpSocket: { port: containerPort },
        periodSeconds: PROBE_PERIOD_SECONDS,
        failureThreshold: STARTUP_FAILURE_THRESHOLD,
      },
      readinessProbe: {
        tcpSocket: { port: containerPort },
        periodSeconds: PROBE_PERIOD_SECONDS,
      },
    },
    envSecret:
      Object.keys(applicationEnv).length > 0
        ? {
            name: kubernetesWorkloadSecretName(
              'serve',
              spec.workloadId,
              'application-env',
            ),
            values: applicationEnv,
          }
        : undefined,
    // Pool VMs have no node-to-node network (RFC 0033), so the replica runs
    // on the Node whose Traefik serves it: the pool's ingress entry. The pool
    // controller moves the label on re-election and evicts the replica from
    // the former entry; the Deployment recreates it on the new one.
    nodeSelector: { [INGRESS_ENTRY_NODE_LABEL]: spec.nodePoolId },
  });

  const namespaceLabels = {
    ...identity.labels,
    [NODE_POOL_NODE_LABEL]: spec.nodePoolId,
    [CLUSTER_NODE_LABEL]: spec.clusterId,
  };
  const hostname = serviceHostname(spec.workloadId);
  return {
    namespace,
    name,
    podSelector: identity.podSelector,
    containerPort,
    hostname,
    kubernetesNamespace: {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: namespaceLabels,
        annotations: identity.annotations,
      },
    },
    secrets,
    kubernetesDeployment: renderDeployment({
      name,
      namespace,
      identity,
      template,
      minReadySeconds: MIN_READY_SECONDS,
    }),
    kubernetesService: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace,
        labels: identity.labels,
        annotations: identity.annotations,
      },
      spec: {
        type: 'ClusterIP',
        selector: identity.labels,
        // Node-local only: a replica on another Node is unreachable anyway,
        // and a REJECT beats a 30 s dial timeout while it moves.
        internalTrafficPolicy: 'Local',
        ports: [
          {
            name: SERVICE_PORT_NAME,
            port: KUBERNETES_SERVICE_PORT,
            targetPort: containerPort,
          },
        ],
      },
    },
    // Host rule on the pool Traefik's plain-HTTP entrypoint (Cloudflare
    // terminates TLS) to the stable native Service; same namespace, so no
    // cross-namespace allowance is needed.
    ingressRoute: {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: {
        name,
        namespace,
        labels: {
          ...identity.labels,
          [POOL_INGRESS_ROUTE_LABEL]: spec.nodePoolId,
        },
        annotations: identity.annotations,
      },
      spec: {
        entryPoints: ['web'],
        routes: [
          {
            kind: 'Rule',
            match: `Host(\`${hostname}\`)`,
            // Through the ClusterIP so kube-proxy applies the Local policy.
            services: [{ name, port: KUBERNETES_SERVICE_PORT, nativeLB: true }],
          },
        ],
      },
    },
  };
}

const ingressRouteHeader = (manifests: NodePoolServiceManifests) => ({
  apiVersion: manifests.ingressRoute.apiVersion,
  kind: manifests.ingressRoute.kind,
  metadata: { name: manifests.name, namespace: manifests.namespace },
});

/**
 * The preflight-facing core client type widens `readNamespace` to `unknown`;
 * the SDK method returns the namespace object.
 */
async function readNamespace(
  cluster: ClusterKubernetesClient,
  name: string,
): Promise<V1Namespace> {
  return (await cluster.core.readNamespace({ name })) as V1Namespace;
}

function managedResources(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
): ManagedKubernetesResource[] {
  const namespace = manifests.namespace;
  return [
    {
      kind: 'Namespace',
      namespace: '',
      name: namespace,
      desired: manifests.kubernetesNamespace,
      create: () =>
        cluster.core.createNamespace({
          body: manifests.kubernetesNamespace,
          fieldManager: FIELD_MANAGER,
        }),
      apply: () =>
        serverSideApply(cluster, FIELD_MANAGER, manifests.kubernetesNamespace),
      read: () => readNamespace(cluster, namespace),
      ownershipErrorMessage:
        'Kubernetes Namespace is owned by another workload',
    },
    ...managedKubernetesSecrets(cluster, FIELD_MANAGER, manifests),
    {
      ...managedKubernetesDeployment(cluster, FIELD_MANAGER, manifests),
      // An entry hand-off's second replica, which `replicas: 1` would drop.
      held: (actual) => !!actual.metadata?.labels?.[ENTRY_HANDOFF_LABEL],
    },
    {
      kind: 'Service',
      namespace,
      name: manifests.name,
      desired: manifests.kubernetesService,
      create: () =>
        cluster.core.createNamespacedService({
          namespace,
          body: manifests.kubernetesService,
          fieldManager: FIELD_MANAGER,
        }),
      apply: () =>
        serverSideApply(cluster, FIELD_MANAGER, manifests.kubernetesService),
      read: () =>
        cluster.core.readNamespacedService({
          namespace,
          name: manifests.name,
        }),
      ownershipErrorMessage: 'Kubernetes Service is owned by another workload',
    },
    {
      kind: 'IngressRoute',
      namespace,
      name: manifests.name,
      desired: manifests.ingressRoute,
      create: () =>
        cluster.objects.create(
          manifests.ingressRoute,
          undefined,
          undefined,
          FIELD_MANAGER,
        ),
      apply: () =>
        serverSideApply(cluster, FIELD_MANAGER, manifests.ingressRoute),
      read: () =>
        cluster.objects.read<KubernetesIngressRoute>(
          ingressRouteHeader(manifests),
        ),
      ownershipErrorMessage:
        'Traefik IngressRoute is owned by another workload',
    },
  ];
}

/**
 * Deletion order: the native Deployment first (Foreground, so its Pod is gone
 * before the next step — the seam where checkpoint finalization will run),
 * then the stable Service and Secrets, then the namespace. Every step checks
 * exact ownership and UID; a same-name object owned by anyone else is left
 * alone and reported.
 */
function ownedResources(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
): OwnedKubernetesResource[] {
  const namespace = manifests.namespace;
  return [
    {
      // First: the public host must stop routing before anything else goes.
      kind: 'IngressRoute',
      namespace,
      name: manifests.name,
      ownershipLabels: manifests.ingressRoute.metadata?.labels,
      read: () =>
        cluster.objects.read<KubernetesIngressRoute>(
          ingressRouteHeader(manifests),
        ),
      delete: (uid) =>
        cluster.objects.delete(
          ingressRouteHeader(manifests),
          undefined,
          undefined,
          undefined,
          undefined,
          'Background',
          kubernetesDeleteOptionsForUid(uid, 'Background'),
        ),
    },
    ownedKubernetesDeployment(cluster, manifests),
    {
      kind: 'Service',
      namespace,
      name: manifests.name,
      ownershipLabels: manifests.kubernetesService.metadata?.labels,
      read: () =>
        cluster.core.readNamespacedService({
          namespace,
          name: manifests.name,
        }),
      delete: (uid) =>
        cluster.core.deleteNamespacedService({
          namespace,
          name: manifests.name,
          body: kubernetesDeleteOptionsForUid(uid, 'Background'),
        }),
    },
    ...ownedKubernetesSecrets(
      cluster,
      'serve',
      // 'runtime-auth' only cleans up Secrets created before workloads
      // stopped receiving the login token (G2).
      ['runtime-auth', 'registry-auth', 'application-env'],
      manifests,
    ),
    {
      kind: 'Namespace',
      namespace: '',
      name: namespace,
      ownershipLabels: manifests.kubernetesNamespace.metadata?.labels,
      read: () => readNamespace(cluster, namespace),
      delete: (uid) =>
        cluster.core.deleteNamespace({
          name: namespace,
          body: kubernetesDeleteOptionsForUid(uid, 'Background'),
        }),
    },
  ];
}

/** Another workload's route already serves this Service's hostname. */
export class ServiceHostnameTakenError extends Error {
  constructor(hostname: string, holder: string) {
    super(`hostname ${hostname} is already served by IngressRoute ${holder}`);
    this.name = 'ServiceHostnameTakenError';
  }
}

/**
 * Ids are unique per installer database, but a hosted API and an installer
 * can both target one cluster, so the hostname is fenced where it is actually
 * claimed: among every pool-labelled route on the cluster, before this
 * Service's own route is created. A same-name route in this Service's own
 * namespace is its own (ownership is checked when it is applied).
 */
export async function assertServiceHostnameFree(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
): Promise<void> {
  const match = manifests.ingressRoute.spec.routes[0].match;
  let routes: { items: KubernetesIngressRoute[] };
  try {
    routes = await cluster.objects.list<KubernetesIngressRoute>(
      manifests.ingressRoute.apiVersion,
      manifests.ingressRoute.kind,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      POOL_INGRESS_ROUTE_LABEL,
    );
  } catch (error) {
    // No CRD yet means no route can be serving the hostname.
    if ((error as { code?: number }).code === 404) return;
    throw error;
  }
  const holder = routes.items.find(
    (route) =>
      route.spec?.routes?.some((rule) => rule.match === match) &&
      !(
        route.metadata?.namespace === manifests.namespace &&
        route.metadata?.name === manifests.name
      ),
  );
  if (holder) {
    throw new ServiceHostnameTakenError(
      manifests.hostname,
      `${holder.metadata?.namespace}/${holder.metadata?.name}`,
    );
  }
}

export async function ensureNodePoolService(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
): Promise<void> {
  await ensureKubernetesWorkloadPlan(
    manifests,
    managedResources(cluster, manifests),
    ownedResources(cluster, manifests),
  );
}

export async function deleteNodePoolService(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await deleteKubernetesResourcePlan(
    ownedResources(cluster, manifests),
    kubernetesWorkloadOwner(manifests),
    { timeoutMs: options.timeoutMs ?? 60_000 },
  );
}

/** Stop the application Pod while keeping identity, Service and Secrets. */
export async function stopNodePoolService(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
): Promise<void> {
  const kubernetesDeployment = ownedResources(cluster, manifests).find(
    (resource) => resource.kind === 'Deployment',
  )!;
  await deleteKubernetesResourcePlan(
    [kubernetesDeployment],
    kubernetesWorkloadOwner(manifests),
    { timeoutMs: 60_000 },
  );
}

type NodePoolServicePhase =
  | 'absent'
  | 'scheduling'
  | 'starting'
  | 'serving'
  | 'crashed';

export interface NodePoolServiceObservation {
  phase: NodePoolServicePhase;
  /** Why the Pod is not serving yet, when Kubernetes reports one. */
  reason: string | null;
  podName: string | null;
  podUid: string | null;
  /** Container restarts since the Pod started; repeated crashes surface here. */
  restartCount: number;
  observedAt: number;
}

function describePod(pod: V1Pod): {
  phase: NodePoolServicePhase;
  reason: string | null;
} {
  const scheduled = pod.status?.conditions?.find(
    (condition) => condition.type === 'PodScheduled',
  );
  if (!scheduled || scheduled.status !== 'True') {
    return {
      phase: 'scheduling',
      reason: scheduled?.message ?? scheduled?.reason ?? null,
    };
  }
  const container = pod.status?.containerStatuses?.find(
    (status) => status.name === KUBERNETES_DEPLOYMENT_CONTAINER,
  );
  const waiting = container?.state?.waiting;
  const exited =
    container?.state?.terminated ?? container?.lastState?.terminated;
  if (
    waiting?.reason === 'CrashLoopBackOff' ||
    (exited && !container?.state?.running)
  ) {
    const exit = exited
      ? `container exited with code ${exited.exitCode}${exited.reason ? ` (${exited.reason})` : ''}`
      : waiting?.reason;
    return { phase: 'crashed', reason: exit ?? null };
  }
  if (waiting) {
    return {
      phase: 'starting',
      reason: waiting.message
        ? `${waiting.reason}: ${waiting.message}`
        : (waiting.reason ?? null),
    };
  }
  const ready = pod.status?.conditions?.find(
    (condition) => condition.type === 'Ready',
  );
  if (ready?.status === 'True' && !pod.metadata?.deletionTimestamp) {
    return { phase: 'serving', reason: null };
  }
  return {
    phase: 'starting',
    reason: ready?.message ?? ready?.reason ?? 'waiting for readiness',
  };
}

/**
 * The native Deployment is the rollout authority: the Service is serving only
 * when it reports an available replica (readiness held for the dwell) and the
 * newest Pod is Ready. Pod status supplies the block reason otherwise.
 */
export async function observeNodePoolService(
  cluster: ClusterKubernetesClient,
  manifests: NodePoolServiceManifests,
  signal?: AbortSignal,
): Promise<NodePoolServiceObservation> {
  const observedAt = Date.now();
  let kubernetesDeployment: KubernetesDeployment;
  try {
    kubernetesDeployment = await cluster.apps.readNamespacedDeployment(
      { namespace: manifests.namespace, name: manifests.name },
      kubernetesRequestOptions(signal),
    );
  } catch (error) {
    if (!isKubernetesNotFoundError(error)) throw error;
    return {
      phase: 'absent',
      reason: null,
      podName: null,
      podUid: null,
      restartCount: 0,
      observedAt,
    };
  }
  const pods = await cluster.core.listNamespacedPod(
    {
      namespace: manifests.namespace,
      labelSelector: manifests.podSelector,
      limit: 100,
    },
    kubernetesRequestOptions(signal),
  );
  if (pods.metadata?._continue || pods.items.length > 100) {
    throw new Error('Service Pod observation exceeded its 100-object bound');
  }
  const pod = latestPod(pods.items);
  if (!pod) {
    return {
      phase: 'scheduling',
      reason: 'no Pod has been created yet',
      podName: null,
      podUid: null,
      restartCount: 0,
      observedAt,
    };
  }
  const described = describePod(pod);
  const available = (kubernetesDeployment.status?.availableReplicas ?? 0) >= 1;
  const container = pod.status?.containerStatuses?.find(
    (status) => status.name === KUBERNETES_DEPLOYMENT_CONTAINER,
  );
  return {
    phase:
      described.phase === 'serving' && !available
        ? 'starting'
        : described.phase,
    reason:
      described.phase === 'serving' && !available
        ? 'waiting for the readiness dwell'
        : described.reason,
    podName: pod.metadata?.name ?? null,
    podUid: pod.metadata?.uid ?? null,
    restartCount: container?.restartCount ?? 0,
    observedAt,
  };
}
