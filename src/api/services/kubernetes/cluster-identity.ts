import { assertRequestActive } from '../request-budget.js';
import { createKubernetesClients } from './client.js';
import { kubernetesRequestOptions } from './request-options.js';
import {
  kubeConfigFromClusterConnection,
  type ClusterConnectionDocument,
} from './cluster-connection.js';

const KUBERNETES_SYSTEM_NAMESPACE = 'kube-system';

/**
 * Observe a control plane's durable identity through an already-validated
 * connection document. The `kube-system` namespace UID is what the cluster record
 * the cluster record binds and what later connections must reproduce.
 */
export async function observeClusterIdentity(
  connection: ClusterConnectionDocument,
  signal?: AbortSignal,
): Promise<string> {
  assertRequestActive(signal);
  const clients = createKubernetesClients(
    kubeConfigFromClusterConnection(connection),
  );
  const systemNamespace = await clients.core.readNamespace(
    { name: KUBERNETES_SYSTEM_NAMESPACE },
    kubernetesRequestOptions(signal),
  );
  assertRequestActive(signal);
  const identity = systemNamespace.metadata?.uid;
  if (!identity) {
    throw new Error(
      `cluster did not report a ${KUBERNETES_SYSTEM_NAMESPACE} namespace UID`,
    );
  }
  return identity;
}
