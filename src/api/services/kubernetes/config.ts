export interface LocalKubernetesConfig {
  namespace: string;
}

export interface LocalKubernetesConfigOverrides {
  namespace?: string;
}

const DEFAULT_NAMESPACE = 'anycloud';

/**
 * Default workload settings. Cluster credentials and context are resolved
 * by @kubernetes/client-node using in-cluster discovery or the standard local
 * kubeconfig; they are intentionally not part of this workload configuration.
 */
export function createDefaultLocalKubernetesConfig(
  overrides: LocalKubernetesConfigOverrides = {},
): LocalKubernetesConfig {
  return {
    namespace: overrides.namespace?.trim() || DEFAULT_NAMESPACE,
  };
}
