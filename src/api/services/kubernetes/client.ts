import {
  AppsV1Api,
  AuthorizationV1Api,
  AuthenticationV1Api,
  CoreV1Api,
  Exec,
  KubernetesObjectApi,
  Log,
  type KubeConfig,
} from '@kubernetes/client-node';

export interface KubernetesClients {
  kubeConfig: KubeConfig;
  core: CoreV1Api;
  apps: AppsV1Api;
  objects: KubernetesObjectApi;
  authorization: AuthorizationV1Api;
  authentication: AuthenticationV1Api;
  exec: Exec;
  log: Log;
}

function validateKubeConfig(kubeConfig: KubeConfig): KubeConfig {
  if (!kubeConfig.getCurrentCluster()) {
    throw new Error('Kubernetes config has no current cluster');
  }
  return kubeConfig;
}

/** Construct SDK clients from one already-resolved cluster connection. */
export function createKubernetesClients(
  kubeConfig: KubeConfig,
): KubernetesClients {
  validateKubeConfig(kubeConfig);
  return {
    kubeConfig,
    core: kubeConfig.makeApiClient(CoreV1Api),
    apps: kubeConfig.makeApiClient(AppsV1Api),
    objects: KubernetesObjectApi.makeApiClient(kubeConfig),
    authorization: kubeConfig.makeApiClient(AuthorizationV1Api),
    authentication: kubeConfig.makeApiClient(AuthenticationV1Api),
    exec: new Exec(kubeConfig),
    log: new Log(kubeConfig),
  };
}
