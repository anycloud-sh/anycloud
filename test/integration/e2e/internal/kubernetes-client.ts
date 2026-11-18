import { KubeConfig } from '@kubernetes/client-node';

import type { KubernetesClients } from '../../../../src/api/services/kubernetes/client.js';
import { createKubernetesClients } from '../../../../src/api/services/kubernetes/client.js';

export function kubernetesClientsFromKubeconfig(
  serialized: string,
): KubernetesClients {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromString(serialized);
  return createKubernetesClients(kubeConfig);
}
