export const clusterLocalClusterName = 'e2e-cluster-local';
export const clusterLocalClusterId = 'e2e-cluster-local-cluster';
/** The pinned K3s image of the management server. */
export const clusterLocalK3sImage =
  'mirror.gcr.io/rancher/k3s:v1.35.5-k3s1@sha256:2074403abe1bded11ef3dde09d457e13be8e0b64c218b1c4f8269b4565cfbc65';
export const clusterLocalDockerLabel = 'com.anycloud.e2e-cluster-local';

/** The K3s server container: the management node. */
export function localClusterServerContainer(runId: string): string {
  return `anycloud-cluster-${runId}`;
}
