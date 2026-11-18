import type { ClusterKubernetesClient } from './cluster-client.js';
import { kubernetesRequestOptions } from './request-options.js';

/** Who a projected ServiceAccount token names, and the Pod it is bound to. */
export interface PodTokenReview {
  /** `system:serviceaccount:<namespace>:<name>`. */
  username: string;
  /** Empty when the token is bound to no Pod (`kubectl create token`). */
  podUid: string;
  podName: string;
}

/**
 * Ask the cluster whether it issued `token` for `audience`. Null when it
 * didn't; a failed request throws.
 */
export async function reviewServiceAccountToken(
  cluster: Pick<ClusterKubernetesClient, 'authentication'>,
  token: string,
  audience: string,
  signal?: AbortSignal,
): Promise<PodTokenReview | null> {
  const { status } = await cluster.authentication.createTokenReview(
    {
      body: {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token, audiences: [audience] },
      },
    },
    kubernetesRequestOptions(signal),
  );
  if (
    status?.authenticated !== true ||
    !status.audiences?.includes(audience) ||
    !status.user?.username
  ) {
    return null;
  }
  const extra = status.user.extra;
  return {
    username: status.user.username,
    podUid: extra?.['authentication.kubernetes.io/pod-uid']?.[0] ?? '',
    podName: extra?.['authentication.kubernetes.io/pod-name']?.[0] ?? '',
  };
}
