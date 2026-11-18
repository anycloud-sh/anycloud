import type { KubeConfig } from '@kubernetes/client-node';
import type { KubernetesClients } from './client.js';
import {
  createKubernetesListWatch,
  type KubernetesListWatch,
} from './list-watch.js';
import type {
  KubernetesAuthorizationPreflightApi,
  KubernetesCorePreflightApi,
} from './preflight.js';

/**
 * One connected cluster. Node pool and Deployment runtimes depend on
 * this boundary rather than discovering credentials or constructing Kubernetes
 * SDK clients.
 */
export interface ClusterKubernetesClient {
  kubeConfig: KubeConfig;
  core: KubernetesCorePreflightApi & KubernetesClients['core'];
  apps: KubernetesClients['apps'];
  objects: KubernetesClients['objects'];
  authorization: KubernetesAuthorizationPreflightApi;
  authentication: KubernetesClients['authentication'];
  exec: KubernetesClients['exec'];
  log: KubernetesClients['log'];
  listWatch: KubernetesListWatch;
}

export interface ClusterKubernetesClientDeps {
  clients: KubernetesClients;
}

export function createClusterKubernetesClient(
  deps: ClusterKubernetesClientDeps,
): ClusterKubernetesClient {
  const clients = deps.clients;
  return {
    kubeConfig: clients.kubeConfig,
    core: clients.core,
    apps: clients.apps,
    objects: clients.objects,
    authorization: clients.authorization,
    authentication: clients.authentication,
    exec: clients.exec,
    log: clients.log,
    listWatch: createKubernetesListWatch(clients.kubeConfig),
  };
}
