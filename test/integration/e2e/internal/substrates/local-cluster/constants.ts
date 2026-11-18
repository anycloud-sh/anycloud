export const clusterLocalCredentialName = 'e2e-cluster-local';
export const clusterLocalCredentialId = 'e2e-cluster-local-compute-credential';
export const clusterLocalRegion = 'local';
// A catalogued CPU type keeps Deployment defaults on the production validation path.
export const localClusterVmType = 't3.small';
/**
 * S12: at least $6.67/h over 32 vCPUs, so a tenth of a Node costs over half
 * of a whole-dollar session throttle, and a replica's CPU share of the disk
 * stays about a t3.small's.
 */
export const localClusterPricedVmType = 'x2iedn.8xlarge';
/** A node pool of this type joins KWOK Nodes, which run no containers (S12). */
export const localClusterKwokVmType = 'c7i.24xlarge';
/**
 * A scaling pool's type: catalogued larger than any runner, so the shape FIT
 * packs Pending Pods into is the agent's real allocatable (RFC 0048 § Scale-out).
 */
export const localScalingVmType = 'm5.24xlarge';
/**
 * A scaling pool's agent joins with this taint, and the environment lifts it
 * once the images earlier Nodes received are imported: no registry serves them.
 */
export const clusterLocalBootImagesTaint = 'e2e.anycloud.sh/images';
export const clusterLocalClusterName = 'e2e-cluster-local';
export const clusterLocalClusterId = 'e2e-cluster-local-cluster';
/** One pinned K3s image serves the management server and every node pool agent. */
export const clusterLocalK3sImage =
  'mirror.gcr.io/rancher/k3s:v1.35.5-k3s1@sha256:2074403abe1bded11ef3dde09d457e13be8e0b64c218b1c4f8269b4565cfbc65';
export const clusterLocalDockerLabel = 'com.anycloud.e2e-cluster-local';

/** The K3s server container: the management node. */
export function localClusterServerContainer(runId: string): string {
  return `anycloud-cluster-${runId}`;
}
