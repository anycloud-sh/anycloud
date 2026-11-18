import { ApiException, KubeConfig } from '@kubernetes/client-node';

import type { KubernetesClients } from '../../../../src/api/services/kubernetes/client.js';
import { createKubernetesClients } from '../../../../src/api/services/kubernetes/client.js';

import { isRecord } from './types.js';

export function kubernetesClientsFromKubeconfig(
  serialized: string,
): KubernetesClients {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromString(serialized);
  return createKubernetesClients(kubeConfig);
}

export function kubernetesStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  // The SDK's HTTP status is authoritative. A quoted body status must not
  // turn authorization or unavailable transport into resource absence.
  const status = error instanceof ApiException ? error.code : error.statusCode;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}
