import { VersionApi, type KubeConfig } from '@kubernetes/client-node';
import type { ClusterConnectionRepository } from '../cluster-store.js';
import { createKubernetesClients } from './client.js';
import {
  createClusterKubernetesClient,
  type ClusterKubernetesClient,
} from './cluster-client.js';
import { kubernetesRequestOptions } from './request-options.js';
import { KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS } from './preflight.js';
import { clusterAddonPermissions } from './cluster-addons.js';
import {
  kubeConfigFromClusterConnection,
  parseClusterConnection,
  type ClusterConnectionDocument,
} from './cluster-connection.js';

export interface KubernetesServerVersion {
  major: number;
  minor: number;
  gitVersion: string;
}

export interface ClusterRuntime {
  clusterId: string;
  kubernetesIdentity: string;
  connectionRevision: number;
  connection: ClusterConnectionDocument;
  serverVersion: KubernetesServerVersion;
  /** When identity, permissions and version were last verified. */
  verifiedAt: number;
  cluster: ClusterKubernetesClient;
}

interface ClusterRuntimeResolveOptions {
  /**
   * Re-verify identity, permissions and server version when the cached
   * runtime is older than this; `0` forces a fresh read (admission).
   */
  maxAgeMs?: number;
}

/** In-place cluster upgrades and RBAC changes are noticed within this window. */
export const CLUSTER_RUNTIME_REVERIFY_MS = 60 * 60_000;

export interface ClusterRuntimeResolver {
  /**
   * Connect to the cluster and fail closed unless it still reports its bound
   * identity, the registered identity holds every permission node pools
   * need, and the server version is readable.
   */
  resolve(
    clusterId: string,
    signal?: AbortSignal,
    options?: ClusterRuntimeResolveOptions,
  ): Promise<ClusterRuntime>;
}

export class ClusterIdentityChangedError extends Error {
  constructor(clusterId: string) {
    super(
      `cluster ${clusterId} no longer reports its registered identity; refusing to operate on a foreign control plane`,
    );
    this.name = 'ClusterIdentityChangedError';
  }
}

export class ClusterPermissionError extends Error {
  constructor(
    clusterId: string,
    public readonly missing: readonly string[],
  ) {
    super(
      `cluster ${clusterId}: the registered identity lacks permissions node pools and Services need: ${missing.join(', ')}`,
    );
    this.name = 'ClusterPermissionError';
  }
}

interface RequiredRule {
  verb: string;
  /** API group; the core group is `''`. */
  group: string;
  resource: string;
  subresource?: string;
  namespace?: string;
  label: string;
}

/**
 * Every Kubernetes operation the node pool runtime performs on the cluster:
 * the join and Node lifecycle, plus whatever the cluster-scoped add-on registry
 * declares. One list, so the RBAC an operator grants is documented in code.
 */
export const NODE_POOL_CLUSTER_PERMISSIONS: readonly RequiredRule[] =
  Object.freeze([
    { verb: 'get', group: '', resource: 'namespaces', label: 'get namespaces' },
    { verb: 'list', group: '', resource: 'nodes', label: 'list nodes' },
    { verb: 'watch', group: '', resource: 'nodes', label: 'watch nodes' },
    { verb: 'patch', group: '', resource: 'nodes', label: 'patch nodes' },
    { verb: 'delete', group: '', resource: 'nodes', label: 'delete nodes' },
    // Pods bound to a removed Node, and Service replicas on a former entry.
    { verb: 'list', group: '', resource: 'pods', label: 'list pods' },
    { verb: 'delete', group: '', resource: 'pods', label: 'delete pods' },
    // Draining an outdated Node within PodDisruptionBudgets.
    {
      verb: 'create',
      group: '',
      resource: 'pods',
      subresource: 'eviction',
      label: 'create pods/eviction',
    },
    {
      verb: 'create',
      group: '',
      resource: 'secrets',
      namespace: 'kube-system',
      label: 'create secrets in kube-system',
    },
    {
      verb: 'list',
      group: '',
      resource: 'secrets',
      namespace: 'kube-system',
      label: 'list secrets in kube-system',
    },
    {
      verb: 'delete',
      group: '',
      resource: 'secrets',
      namespace: 'kube-system',
      label: 'delete secrets in kube-system',
    },
    ...clusterAddonPermissions(),
  ]);

function parseServerVersion(info: {
  major?: string;
  minor?: string;
  gitVersion?: string;
}): KubernetesServerVersion {
  const major = Number.parseInt(info.major ?? '', 10);
  const minor = Number.parseInt((info.minor ?? '').replace(/\D.*$/, ''), 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error(
      `cluster reported an unreadable version ${info.gitVersion ?? ''}`,
    );
  }
  return { major, minor, gitVersion: info.gitVersion ?? `${major}.${minor}` };
}

function namespacedServiceRules(resource: string, group = ''): RequiredRule[] {
  const qualified = group ? `${resource}.${group}` : resource;
  return ['create', 'get', 'patch', 'delete'].map((verb) => ({
    verb,
    group,
    resource,
    label: `${verb} ${qualified} in Service namespaces`,
  }));
}

/**
 * Every Kubernetes operation the node pool Service runtime performs on the
 * cluster. Each Service owns its own namespace, so these are checked without a
 * namespace and the registered identity needs them cluster-wide (a
 * ClusterRole binding), not per namespace.
 */
export const SERVICE_CLUSTER_PERMISSIONS: readonly RequiredRule[] =
  Object.freeze([
    {
      verb: 'create',
      group: '',
      resource: 'namespaces',
      label: 'create namespaces',
    },
    // Every pass after the first re-applies the namespace (create → 409 →
    // server-side apply), so patch is a steady-state permission, not a setup one.
    {
      verb: 'patch',
      group: '',
      resource: 'namespaces',
      label: 'patch namespaces',
    },
    {
      verb: 'delete',
      group: '',
      resource: 'namespaces',
      label: 'delete namespaces',
    },
    ...namespacedServiceRules('secrets'),
    ...namespacedServiceRules('services'),
    ...namespacedServiceRules('deployments', 'apps'),
    // The Service's public route, watched by its node pool's Traefik release;
    // listed cluster-wide to fence a hostname another route already serves.
    ...namespacedServiceRules('ingressroutes', 'traefik.io'),
    {
      verb: 'list',
      group: 'traefik.io',
      resource: 'ingressroutes',
      label: 'list ingressroutes.traefik.io',
    },
    {
      verb: 'list',
      group: '',
      resource: 'pods',
      label: 'list pods in Service namespaces',
    },
  ]);

/**
 * Every Kubernetes operation the Deployment-record runtime performs on a
 * node pool's namespace: the access the namespaced preflight demands
 * (`KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS`), checked cluster-wide because
 * node pool namespaces are created lazily, plus the namespace lifecycle the
 * node pool owns. Admission re-checks the namespaced form per target.
 */
export const DEPLOYMENT_CLUSTER_PERMISSIONS: readonly RequiredRule[] =
  Object.freeze([
    {
      verb: 'create',
      group: '',
      resource: 'namespaces',
      label: 'create namespaces',
    },
    {
      verb: 'delete',
      group: '',
      resource: 'namespaces',
      label: 'delete namespaces',
    },
    ...KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS.map((access) => ({
      verb: access.verb,
      group: access.group ?? '',
      resource: access.resource,
      subresource: access.subresource,
      label: `${access.verb} ${access.resource}${access.subresource ? `/${access.subresource}` : ''}${access.group ? `.${access.group}` : ''}${access.clusterScoped ? '' : ' in node pool namespaces'}`,
    })),
  ]);

function dedupeRules(rules: readonly RequiredRule[]): RequiredRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.verb} ${rule.group} ${rule.resource}/${rule.subresource ?? ''} ${rule.namespace ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Node pool, Service and Deployment permissions: what one cluster must grant. */
export const CLUSTER_PERMISSIONS: readonly RequiredRule[] = Object.freeze(
  dedupeRules([
    ...NODE_POOL_CLUSTER_PERMISSIONS,
    ...SERVICE_CLUSTER_PERMISSIONS,
    ...DEPLOYMENT_CLUSTER_PERMISSIONS,
  ]),
);

async function preflightPermissions(
  clusterId: string,
  cluster: ClusterKubernetesClient,
): Promise<void> {
  const missing: string[] = [];
  for (const rule of CLUSTER_PERMISSIONS) {
    const review = await cluster.authorization.createSelfSubjectAccessReview({
      body: {
        spec: {
          resourceAttributes: {
            verb: rule.verb,
            group: rule.group,
            resource: rule.resource,
            subresource: rule.subresource,
            ...(rule.namespace ? { namespace: rule.namespace } : {}),
          },
        },
      },
    });
    if (review.status?.allowed !== true) missing.push(rule.label);
  }
  if (missing.length > 0) throw new ClusterPermissionError(clusterId, missing);
}

/**
 * The stored document is re-parsed through the same allow-list that admitted
 * it, so a tampered or downgraded row can never reintroduce exec plugins,
 * file paths or TLS bypass. Verified runtimes are cached per connection
 * revision; a rotation or deletion invalidates the cache.
 */
export function createClusterRuntimeResolver(deps: {
  connections: ClusterConnectionRepository;
  createClusterClient?: (kubeConfig: KubeConfig) => ClusterKubernetesClient;
  readServerVersion?: (
    kubeConfig: KubeConfig,
    signal?: AbortSignal,
  ) => Promise<KubernetesServerVersion>;
  now?: () => number;
}): ClusterRuntimeResolver {
  const cache = new Map<string, ClusterRuntime>();
  const now = deps.now ?? Date.now;
  const createClusterClient =
    deps.createClusterClient ??
    ((kubeConfig: KubeConfig) =>
      createClusterKubernetesClient({
        clients: createKubernetesClients(kubeConfig),
      }));
  const readServerVersion =
    deps.readServerVersion ??
    (async (kubeConfig: KubeConfig, signal?: AbortSignal) =>
      parseServerVersion(
        await kubeConfig
          .makeApiClient(VersionApi)
          .getCode(kubernetesRequestOptions(signal)),
      ));

  return {
    async resolve(clusterId, signal, options) {
      const stored = await deps.connections.getConnection(clusterId);
      if (!stored) {
        cache.delete(clusterId);
        throw new Error(`cluster ${clusterId} has no usable connection`);
      }
      const maxAgeMs = options?.maxAgeMs ?? CLUSTER_RUNTIME_REVERIFY_MS;
      const cached = cache.get(clusterId);
      if (
        cached &&
        cached.connectionRevision === stored.connectionRevision &&
        now() - cached.verifiedAt < maxAgeMs
      ) {
        return cached;
      }
      const connection = parseClusterConnection(stored.connection);
      const kubeConfig = kubeConfigFromClusterConnection(connection);
      const cluster = createClusterClient(kubeConfig);
      const systemNamespace = await cluster.core.readNamespace(
        { name: 'kube-system' },
        kubernetesRequestOptions(signal),
      );
      if (systemNamespace.metadata?.uid !== stored.kubernetesIdentity) {
        cache.delete(clusterId);
        throw new ClusterIdentityChangedError(clusterId);
      }
      await preflightPermissions(clusterId, cluster);
      const serverVersion = await readServerVersion(kubeConfig, signal);
      const runtime: ClusterRuntime = {
        clusterId,
        kubernetesIdentity: stored.kubernetesIdentity,
        connectionRevision: stored.connectionRevision,
        connection,
        serverVersion,
        verifiedAt: now(),
        cluster,
      };
      cache.set(clusterId, runtime);
      return runtime;
    },
  };
}
