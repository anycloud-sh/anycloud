import { createHash } from 'node:crypto';
import type {
  KubernetesObject,
  V1DaemonSet,
  V1RuntimeClass,
  V1ValidatingAdmissionPolicy,
  V1ValidatingAdmissionPolicyBinding,
} from '@kubernetes/client-node';
import {
  buildDevicePluginDaemonSet,
  buildNvidiaDevicePluginDaemonSet,
  NVIDIA_DEVICE_PLUGIN_NAME,
  NVIDIA_RUNTIME_CLASS,
} from './nvidia-device-plugin.js';
import {
  POOL_INGRESS_KEEP_ALIVE_MAX_MS,
  POOL_INGRESS_ROUTE_LABEL,
  POOL_INGRESS_WORKLOAD_NAME,
  poolIngressReleaseName,
} from './node-pool-ingress.js';
import {
  TRAEFIK_CHART_REPO,
  TRAEFIK_CHART_VERSION,
  type HelmChartResource,
} from '../../../shared/api-ingress.js';
import {
  ACCELERATOR_NODE_LABEL,
  INGRESS_ENTRY_NODE_LABEL,
  NVIDIA_ACCELERATOR_LABEL_VALUE,
  NODE_POOL_MEMBER_LABEL,
  NODE_POOL_NODE_LABEL,
  CLUSTER_NODE_LABEL,
} from './node-pool-scheduling.js';
import {
  KVM_RESOURCE,
  USER_NAMESPACE_HANDLER,
  USER_NAMESPACE_NODE_LABEL,
  USER_NAMESPACE_POD_OVERHEAD_MI,
  USER_NAMESPACE_RUNTIME_CLASS,
} from './user-namespace.js';

/**
 * Cluster-scoped add-ons are cluster components a cluster installs exactly once
 * and shares across every node pool on it. Each add-on declares the objects
 * it owns, the permissions the registered identity needs to manage them and
 * which node pools need it; the reconciler in `cluster-addon-reconciler.ts`
 * converges them idempotently through the verified cluster connection.
 */
export const CLUSTER_ADDON_LABEL = 'anycloud.sh/addon';
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'anycloud';
/** sha256 of the desired object; equal means nothing to write. */
export const CLUSTER_ADDON_REVISION_ANNOTATION = 'anycloud.sh/addon-revision';

export interface ClusterAddonPermission {
  verb: string;
  group: string;
  resource: string;
  namespace?: string;
  label: string;
}

export interface ClusterAddonNeed {
  /** Physical NVIDIA devices per Node of the node pool being reconciled. */
  nvidiaGpus: number;
  /** The node pool being reconciled hosts Services and needs its ingress release. */
  ingressNodePoolId?: string;
  /** The pool admits user-namespace Jobs (RFC 0049 C32). */
  userNamespace?: boolean;
  /** ...and launches with nested virtualization, so those Jobs get `/dev/kvm`. */
  kvm?: boolean;
}

export interface ClusterAddonResource<
  T extends KubernetesObject = KubernetesObject,
> {
  apiVersion: string;
  kind: string;
  /** Plural resource name as RBAC and the permission labels spell it. */
  apiResource: string;
  name: string;
  namespace?: string;
  /** Complete desired object with ownership labels, before the revision. */
  desired: T;
  /**
   * True when every field outside `metadata` is immutable. An owned object
   * whose revision annotation matches and needs no recreate then equals the
   * desired object, so a process restart adopts it without a write.
   */
  specImmutable?: boolean;
  /**
   * True when `current` differs in a field the API server refuses to update
   * in place; the reconciler then deletes by exact UID and recreates.
   */
  requiresRecreate(current: T): boolean;
  /**
   * An object Anycloud did not create but may rely on unchanged, e.g. the
   * RuntimeClass K3s installs itself. Anything else foreign fails closed.
   */
  acceptForeign?(current: T): boolean;
}

export interface ClusterAddon {
  name: string;
  permissions: readonly ClusterAddonPermission[];
  neededBy(need: ClusterAddonNeed): boolean;
  /** Cluster-scoped objects; a pool-scoped add-on reads its pool from `need`. */
  resources(clusterId: string, need?: ClusterAddonNeed): ClusterAddonResource[];
}

function clusterAddonLabels(
  clusterId: string,
  addon: string,
  name: string,
): Record<string, string> {
  return {
    'app.kubernetes.io/name': name,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [CLUSTER_NODE_LABEL]: clusterId,
    [CLUSTER_ADDON_LABEL]: addon,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** JSON with sorted keys, so server-side key order cannot cause drift. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}

/** Deterministic fingerprint of a desired object, independent of key order. */
export function clusterAddonRevision(desired: KubernetesObject): string {
  return createHash('sha256').update(canonicalJson(desired)).digest('hex');
}

/** Every verb the reconciler uses, on one resource. */
function managePermissions(
  group: string,
  resource: string,
  namespace?: string,
): ClusterAddonPermission[] {
  return ['get', 'create', 'update', 'delete'].map((verb) => ({
    verb,
    group,
    resource,
    ...(namespace && { namespace }),
    label: `${verb} ${resource}${namespace ? ` in ${namespace}` : ''}`,
  }));
}

/** Handler, overhead and scheduling are a RuntimeClass's whole spec, all immutable. */
function runtimeClassRecreate(desired: V1RuntimeClass) {
  const spec = (runtimeClass: V1RuntimeClass) =>
    canonicalJson([
      runtimeClass.handler,
      runtimeClass.overhead ?? null,
      runtimeClass.scheduling ?? null,
    ]);
  return (current: V1RuntimeClass) => spec(current) !== spec(desired);
}

/** A DaemonSet's Pod selector is immutable. */
function selectorChanged(desired: V1DaemonSet) {
  return (current: V1DaemonSet) =>
    canonicalJson(current.spec?.selector ?? null) !==
    canonicalJson(desired.spec!.selector);
}

const NVIDIA_ADDON_NAME = 'nvidia';
const SYSTEM_NAMESPACE = 'kube-system';

// K3s applies its runtimes manifest as an addon; these annotations mark the
// RuntimeClass it owns. A valid K3s-owned `nvidia` class is used, never
// mutated, and never deleted by Anycloud.
const K3S_RUNTIMES_ADDON_ANNOTATIONS: Record<string, string> = {
  'objectset.rio.cattle.io/owner-gvk': 'k3s.cattle.io/v1, Kind=Addon',
  'objectset.rio.cattle.io/owner-name': 'runtimes',
  'objectset.rio.cattle.io/owner-namespace': SYSTEM_NAMESPACE,
};

export function buildClusterNvidiaRuntimeClass(
  clusterId: string,
): V1RuntimeClass {
  return {
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: {
      name: NVIDIA_RUNTIME_CLASS,
      labels: clusterAddonLabels(
        clusterId,
        NVIDIA_ADDON_NAME,
        'anycloud-nvidia-runtime',
      ),
    },
    handler: NVIDIA_RUNTIME_CLASS,
  };
}

export function buildClusterNvidiaDevicePlugin(clusterId: string): V1DaemonSet {
  return buildNvidiaDevicePluginDaemonSet({
    labels: clusterAddonLabels(
      clusterId,
      NVIDIA_ADDON_NAME,
      NVIDIA_DEVICE_PLUGIN_NAME,
    ),
    // Only Nodes this cluster's GPU node pools joined: the management Node and
    // CPU node pools never carry the accelerator label, and the DaemonSet
    // does not tolerate the management taint.
    nodeSelector: {
      [CLUSTER_NODE_LABEL]: clusterId,
      [ACCELERATOR_NODE_LABEL]: NVIDIA_ACCELERATOR_LABEL_VALUE,
    },
    // Every node pool taints its Nodes with the node pool label key.
    tolerations: [
      { key: NODE_POOL_NODE_LABEL, operator: 'Exists', effect: 'NoSchedule' },
    ],
  });
}

function isValidK3sNvidiaRuntimeClass(current: V1RuntimeClass): boolean {
  const annotations = current.metadata?.annotations ?? {};
  return (
    Object.entries(K3S_RUNTIMES_ADDON_ANNOTATIONS).every(
      ([key, value]) => annotations[key] === value,
    ) &&
    (current.metadata?.ownerReferences?.length ?? 0) === 0 &&
    current.handler === NVIDIA_RUNTIME_CLASS &&
    current.overhead === undefined &&
    current.scheduling === undefined
  );
}

export const NVIDIA_CLUSTER_ADDON: ClusterAddon = Object.freeze<ClusterAddon>({
  name: NVIDIA_ADDON_NAME,
  permissions: Object.freeze([
    ...managePermissions('node.k8s.io', 'runtimeclasses'),
    ...managePermissions('apps', 'daemonsets', SYSTEM_NAMESPACE),
  ]),
  neededBy: (need: ClusterAddonNeed) => need.nvidiaGpus > 0,
  resources: (clusterId: string) => [
    {
      apiVersion: 'node.k8s.io/v1',
      kind: 'RuntimeClass',
      apiResource: 'runtimeclasses',
      name: NVIDIA_RUNTIME_CLASS,
      desired: buildClusterNvidiaRuntimeClass(clusterId),
      specImmutable: true,
      requiresRecreate: runtimeClassRecreate(
        buildClusterNvidiaRuntimeClass(clusterId),
      ),
      acceptForeign: isValidK3sNvidiaRuntimeClass,
    } satisfies ClusterAddonResource<V1RuntimeClass>,
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      apiResource: 'daemonsets',
      name: NVIDIA_DEVICE_PLUGIN_NAME,
      namespace: SYSTEM_NAMESPACE,
      desired: buildClusterNvidiaDevicePlugin(clusterId),
      requiresRecreate: selectorChanged(
        buildClusterNvidiaDevicePlugin(clusterId),
      ),
    } satisfies ClusterAddonResource<V1DaemonSet>,
  ],
});

const USER_NAMESPACE_ADDON_NAME = 'user-namespace';

/** The policy, its binding and the class share one name and owner. */
const userNamespaceMetadata = (clusterId: string) => ({
  name: USER_NAMESPACE_RUNTIME_CLASS,
  labels: clusterAddonLabels(
    clusterId,
    USER_NAMESPACE_ADDON_NAME,
    USER_NAMESPACE_RUNTIME_CLASS,
  ),
});

/**
 * Holds what the API's render does for every creator of a Pod on the
 * user-namespace class, including one with a stolen credential: the Pod is
 * in a user namespace, and no container in it is privileged. The API server
 * itself refuses `hostUsers: false` with the host's network, PID or IPC.
 */
function buildUserNamespacePolicy(
  clusterId: string,
): V1ValidatingAdmissionPolicy {
  const unprivileged = (list: string) =>
    `!has(object.spec.${list}) || object.spec.${list}.all(c, !has(c.securityContext) || !has(c.securityContext.privileged) || !c.securityContext.privileged)`;
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: userNamespaceMetadata(clusterId),
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: [''],
            apiVersions: ['v1'],
            operations: ['CREATE', 'UPDATE'],
            resources: ['pods', 'pods/ephemeralcontainers'],
          },
        ],
      },
      matchConditions: [
        {
          name: 'user-namespace-runtime-class',
          expression: `has(object.spec.runtimeClassName) && object.spec.runtimeClassName == '${USER_NAMESPACE_RUNTIME_CLASS}'`,
        },
      ],
      validations: [
        {
          expression:
            'has(object.spec.hostUsers) && object.spec.hostUsers == false',
          message: `A Pod on runtime class ${USER_NAMESPACE_RUNTIME_CLASS} must set hostUsers: false`,
        },
        ...['containers', 'initContainers', 'ephemeralContainers'].map(
          (list) => ({
            expression: unprivileged(list),
            message: `A Pod on runtime class ${USER_NAMESPACE_RUNTIME_CLASS} must have no privileged ${list}`,
          }),
        ),
      ],
    },
  };
}

function buildUserNamespacePolicyBinding(
  clusterId: string,
): V1ValidatingAdmissionPolicyBinding {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: userNamespaceMetadata(clusterId),
    spec: {
      policyName: USER_NAMESPACE_RUNTIME_CLASS,
      validationActions: ['Deny'],
    },
  };
}

/**
 * A Pod naming the class schedules only on Nodes with its handler, and its
 * cgroup gets the overhead above the container's limit.
 */
function buildUserNamespaceRuntimeClass(clusterId: string): V1RuntimeClass {
  return {
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: userNamespaceMetadata(clusterId),
    handler: USER_NAMESPACE_HANDLER,
    overhead: { podFixed: { memory: `${USER_NAMESPACE_POD_OVERHEAD_MI}Mi` } },
    scheduling: { nodeSelector: { [USER_NAMESPACE_NODE_LABEL]: 'true' } },
  };
}

/**
 * The policy and its binding come before the class and go after it (the
 * reconciler removes in reverse), so no Pod can name the class while the
 * policy is absent.
 */
export const USER_NAMESPACE_CLUSTER_ADDON: ClusterAddon =
  Object.freeze<ClusterAddon>({
    name: USER_NAMESPACE_ADDON_NAME,
    permissions: Object.freeze([
      ...managePermissions(
        'admissionregistration.k8s.io',
        'validatingadmissionpolicies',
      ),
      ...managePermissions(
        'admissionregistration.k8s.io',
        'validatingadmissionpolicybindings',
      ),
      ...managePermissions('node.k8s.io', 'runtimeclasses'),
    ]),
    neededBy: (need) => need.userNamespace === true,
    resources: (clusterId) => {
      const runtimeClass = buildUserNamespaceRuntimeClass(clusterId);
      return [
        {
          apiVersion: 'admissionregistration.k8s.io/v1',
          kind: 'ValidatingAdmissionPolicy',
          apiResource: 'validatingadmissionpolicies',
          name: USER_NAMESPACE_RUNTIME_CLASS,
          desired: buildUserNamespacePolicy(clusterId),
          requiresRecreate: () => false,
        },
        {
          apiVersion: 'admissionregistration.k8s.io/v1',
          kind: 'ValidatingAdmissionPolicyBinding',
          apiResource: 'validatingadmissionpolicybindings',
          name: USER_NAMESPACE_RUNTIME_CLASS,
          desired: buildUserNamespacePolicyBinding(clusterId),
          requiresRecreate: () => false,
        },
        {
          apiVersion: 'node.k8s.io/v1',
          kind: 'RuntimeClass',
          apiResource: 'runtimeclasses',
          name: USER_NAMESPACE_RUNTIME_CLASS,
          desired: runtimeClass,
          specImmutable: true,
          requiresRecreate: runtimeClassRecreate(runtimeClass),
        } satisfies ClusterAddonResource<V1RuntimeClass>,
      ];
    },
  });

const KVM_ADDON_NAME = 'kvm';
const KVM_DEVICE_PLUGIN_NAME = 'anycloud-kvm-device-plugin';
// squat/generic-device-plugin, the multi-arch index of 2026-11-05 that
// an earlier spike ran.
const KVM_DEVICE_PLUGIN_IMAGE =
  'ghcr.io/squat/generic-device-plugin@sha256:8dc84958301f054bf72d9753a7a2c9af3d6642a9844b34d1171b3f2cdb4a15f6';
/** The kubelet's Pod limit: the device is shared, so every Pod may have it. */
const KVM_DEVICES_PER_NODE = 110;

/**
 * Advertises `/dev/kvm` as `KVM_RESOURCE` on user-namespace Nodes, tolerating
 * pool taints as the NVIDIA plugin does. A Pod given one gets the device node
 * and its device-cgroup rule; other Pods don't see it.
 */
export function buildKvmDevicePlugin(clusterId: string): V1DaemonSet {
  const [domain, name] = KVM_RESOURCE.split('/') as [string, string];
  return buildDevicePluginDaemonSet({
    name: KVM_DEVICE_PLUGIN_NAME,
    labels: clusterAddonLabels(
      clusterId,
      KVM_ADDON_NAME,
      KVM_DEVICE_PLUGIN_NAME,
    ),
    nodeSelector: {
      [CLUSTER_NODE_LABEL]: clusterId,
      [USER_NAMESPACE_NODE_LABEL]: 'true',
    },
    tolerations: [
      { key: NODE_POOL_NODE_LABEL, operator: 'Exists', effect: 'NoSchedule' },
    ],
    container: {
      name: 'kvm-device-plugin',
      image: KVM_DEVICE_PLUGIN_IMAGE,
      args: [
        '--domain',
        domain,
        '--device',
        JSON.stringify({
          name,
          groups: [
            { count: KVM_DEVICES_PER_NODE, paths: [{ path: '/dev/kvm' }] },
          ],
        }),
      ],
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
        seccompProfile: { type: 'RuntimeDefault' },
      },
      volumeMounts: [{ name: 'dev', mountPath: '/dev' }],
    },
    volumes: [{ name: 'dev', hostPath: { path: '/dev' } }],
  });
}

export const KVM_CLUSTER_ADDON: ClusterAddon = Object.freeze<ClusterAddon>({
  name: KVM_ADDON_NAME,
  permissions: Object.freeze(
    managePermissions('apps', 'daemonsets', SYSTEM_NAMESPACE),
  ),
  neededBy: (need) => need.kvm === true,
  resources: (clusterId) => [
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      apiResource: 'daemonsets',
      name: KVM_DEVICE_PLUGIN_NAME,
      namespace: SYSTEM_NAMESPACE,
      desired: buildKvmDevicePlugin(clusterId),
      requiresRecreate: selectorChanged(buildKvmDevicePlugin(clusterId)),
    } satisfies ClusterAddonResource<V1DaemonSet>,
  ],
});

const POOL_INGRESS_ADDON_NAME = 'pool-ingress';

/**
 * Traefik values for one node pool's ingress release: a DaemonSet that lands
 * only on that pool's ingress entry Node, among the Nodes the API made its
 * members, tolerating only that pool's taint —
 * never the management or control-plane taint, so it can never run on the
 * management VM — and watching only IngressRoutes labelled for that pool, so
 * a request to this pool's entry is never served by another pool's Service.
 * Host port 80 mirrors the VM-host origin; 443 waits for origin TLS.
 */
export function poolIngressTraefikValues(nodePoolId: string): string {
  return [
    // The release name is already a DNS label; the chart's default appends
    // "-traefik" and truncates. Name the workload objects plainly instead.
    `fullnameOverride: ${POOL_INGRESS_WORKLOAD_NAME}`,
    'deployment: { kind: DaemonSet }',
    `nodeSelector: { ${INGRESS_ENTRY_NODE_LABEL}: ${nodePoolId}, ${NODE_POOL_MEMBER_LABEL}: ${nodePoolId} }`,
    'tolerations:',
    `  - { key: ${NODE_POOL_NODE_LABEL}, operator: Equal, value: ${nodePoolId}, effect: NoSchedule }`,
    'ports:',
    // Traefik closes each edge connection after a bounded time, so
    // Cloudflare re-dials and follows a hand-off's record; the access log is
    // how the controller sees the old entry go quiet, and the accept grace
    // still serves a late dial once a hand-off stops it.
    `  web: { port: 8000, hostPort: 80, expose: { default: true }, transport: { keepAliveMaxTime: ${POOL_INGRESS_KEEP_ALIVE_MAX_MS / 1000}s, lifeCycle: { requestAcceptGraceTimeout: 10s } } }`,
    '  websecure: { expose: { default: false } }',
    '  traefik: { expose: { default: false } }',
    'service: { type: ClusterIP }',
    'ingressClass: { enabled: false }',
    'ingressRoute: { dashboard: { enabled: false } }',
    'providers:',
    `  kubernetesCRD: { enabled: true, labelSelector: ${POOL_INGRESS_ROUTE_LABEL}=${nodePoolId} }`,
    '  kubernetesIngress: { enabled: false }',
    'globalArguments: []',
    'logs: { access: { enabled: true } }',
    '',
  ].join('\n');
}

export function buildPoolIngressHelmChart(
  clusterId: string,
  nodePoolId: string,
): HelmChartResource {
  const name = poolIngressReleaseName(nodePoolId);
  return {
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChart',
    metadata: {
      name,
      namespace: 'kube-system',
      labels: {
        'app.kubernetes.io/name': name,
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [CLUSTER_NODE_LABEL]: clusterId,
        [CLUSTER_ADDON_LABEL]: POOL_INGRESS_ADDON_NAME,
        [NODE_POOL_NODE_LABEL]: nodePoolId,
      },
    },
    spec: {
      repo: TRAEFIK_CHART_REPO,
      chart: 'traefik',
      version: TRAEFIK_CHART_VERSION,
      targetNamespace: name,
      createNamespace: true,
      bootstrap: true,
      valuesContent: poolIngressTraefikValues(nodePoolId),
    },
  };
}

/**
 * One Traefik release per node pool that hosts Services, so DNS and routing
 * agree on which pool serves a request. Traefik's cluster-scoped CRDs come
 * from whichever release installs first (Helm skips existing CRDs on later
 * installs and never removes them); helm-controller (bundled with K3s)
 * installs, upgrades and — when the pool is deleted — uninstalls the release.
 */
export const POOL_INGRESS_CLUSTER_ADDON: ClusterAddon =
  Object.freeze<ClusterAddon>({
    name: POOL_INGRESS_ADDON_NAME,
    permissions: Object.freeze(
      managePermissions('helm.cattle.io', 'helmcharts', SYSTEM_NAMESPACE),
    ),
    neededBy: (need) => need.ingressNodePoolId !== undefined,
    resources: (clusterId, need) => {
      if (need?.ingressNodePoolId === undefined) {
        throw new Error(
          'The pool ingress add-on needs the node pool it serves',
        );
      }
      return [
        {
          apiVersion: 'helm.cattle.io/v1',
          kind: 'HelmChart',
          apiResource: 'helmcharts',
          name: poolIngressReleaseName(need.ingressNodePoolId),
          namespace: 'kube-system',
          desired: buildPoolIngressHelmChart(clusterId, need.ingressNodePoolId),
          requiresRecreate: () => false,
        },
      ];
    },
  });

const NODE_STATUS_ADDON_NAME = 'node-status';
export const NODE_STATUS_POLICY_NAME = 'anycloud-k3s-controller-node-status';
/** The user of the client certificate every K3s agent shares. */
export const K3S_CONTROLLER_USER = 'system:k3s-controller';
/** All K3s v1.35's agents write with that identity: flannel's subnet lease. */
export const FLANNEL_ANNOTATION_PREFIX = 'flannel.alpha.coreos.com/';

/**
 * K3s's `system:k3s-controller` ClusterRole may patch every Node's
 * status, and a status update keeps metadata, so a root process on any pool
 * Node could rewrite another Node's labels, including the protected
 * membership label, or its conditions and addresses. NodeRestriction only
 * covers kubelets. This lets that identity change flannel's annotations and
 * nothing else.
 */
export function buildNodeStatusPolicy(clusterId: string) {
  const metadata = {
    name: NODE_STATUS_POLICY_NAME,
    labels: clusterAddonLabels(
      clusterId,
      NODE_STATUS_ADDON_NAME,
      NODE_STATUS_POLICY_NAME,
    ),
  };
  const field = (object: string, path: string, empty: string) =>
    `${object}${path}.orValue(${empty})`;
  const unchanged = (path: string, empty: string) =>
    `${field('object', path, empty)} == ${field('oldObject', path, empty)}`;
  const [before, after] = ['oldObject', 'object'].map((object) =>
    field(object, '.metadata.?annotations', '{}'),
  );
  const flannel = `k.startsWith('${FLANNEL_ANNOTATION_PREFIX}')`;
  const apiVersion = 'admissionregistration.k8s.io/v1';
  return {
    policy: {
      apiVersion,
      kind: 'ValidatingAdmissionPolicy',
      metadata,
      spec: {
        failurePolicy: 'Fail',
        matchConstraints: {
          resourceRules: [
            {
              apiGroups: [''],
              apiVersions: ['v1'],
              operations: ['UPDATE'],
              resources: ['nodes/status'],
            },
          ],
        },
        matchConditions: [
          {
            name: 'k3s-controller',
            expression: `request.userInfo.username == '${K3S_CONTROLLER_USER}'`,
          },
        ],
        validations: [
          {
            expression: [
              unchanged('.?status', '{}'),
              unchanged('.metadata.?labels', '{}'),
              unchanged('.metadata.?finalizers', '[]'),
              unchanged('.metadata.?ownerReferences', '[]'),
              `${after}.all(k, ${flannel} || (k in ${before} && ${before}[k] == ${after}[k]))`,
              `${before}.all(k, ${flannel} || k in ${after})`,
            ].join(' && '),
            message: `${K3S_CONTROLLER_USER} may change only ${FLANNEL_ANNOTATION_PREFIX} annotations on a Node (anycloud)`,
            // A denial, answered 403 like RBAC's, not an invalid object (422).
            reason: 'Forbidden',
          },
        ],
      },
    },
    binding: {
      apiVersion,
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata,
      spec: {
        policyName: NODE_STATUS_POLICY_NAME,
        validationActions: ['Deny'],
      },
    },
  };
}

/** Every pool needs it, so it is in place before any pool Node joins. */
export const NODE_STATUS_CLUSTER_ADDON: ClusterAddon =
  Object.freeze<ClusterAddon>({
    name: NODE_STATUS_ADDON_NAME,
    permissions: Object.freeze(
      [
        'validatingadmissionpolicies',
        'validatingadmissionpolicybindings',
      ].flatMap((resource) =>
        ['get', 'create', 'update', 'delete'].map((verb) => ({
          verb,
          group: 'admissionregistration.k8s.io',
          resource,
          label: `${verb} ${resource}`,
        })),
      ),
    ),
    neededBy: () => true,
    resources: (clusterId) => {
      const { policy, binding } = buildNodeStatusPolicy(clusterId);
      return (
        [
          [policy, 'validatingadmissionpolicies'],
          [binding, 'validatingadmissionpolicybindings'],
        ] as const
      ).map(([desired, apiResource]) => ({
        apiVersion: desired.apiVersion,
        kind: desired.kind,
        apiResource,
        name: NODE_STATUS_POLICY_NAME,
        desired,
        requiresRecreate: () => false,
      }));
    },
  });

/** Every cluster-scoped add-on; the seam for future entries. */
export const CLUSTER_ADDONS: readonly ClusterAddon[] = Object.freeze([
  NVIDIA_CLUSTER_ADDON,
  USER_NAMESPACE_CLUSTER_ADDON,
  KVM_CLUSTER_ADDON,
  POOL_INGRESS_CLUSTER_ADDON,
  NODE_STATUS_CLUSTER_ADDON,
]);

/** Permissions the registered identity needs for every add-on, deduplicated. */
export function clusterAddonPermissions(): ClusterAddonPermission[] {
  const seen = new Set<string>();
  const out: ClusterAddonPermission[] = [];
  for (const addon of CLUSTER_ADDONS) {
    for (const permission of addon.permissions) {
      const key = `${permission.verb} ${permission.group} ${permission.resource} ${permission.namespace ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(permission);
    }
  }
  return out;
}
