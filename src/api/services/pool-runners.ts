import type { NodePoolRunners } from '../../shared/api-contract/node-pools-schemas.js';
import type { DeploymentRuntimeResolver } from './kubernetes/deployment-runtime.js';
import { kubernetesWorkloadPodSelector } from './kubernetes/identity.js';
import { isPodReady, podPendingReason } from './kubernetes/pool-objects.js';
import { kubernetesRequestOptions } from './kubernetes/request-options.js';

/**
 * `node-pool status`'s runners (decision 29): its managed Deployments'
 * replicas, busy with a pool Job, idle, or Pending with why, as a spend cap
 * or the pool's capacity holds an unbound one.
 */
export async function observePoolRunners(
  deps: {
    rows(nodePoolId: string): Promise<{ id: string; podUid: string | null }[]>;
    runtimes: Pick<DeploymentRuntimeResolver, 'resolve'>;
    capBlock(): Promise<string | null>;
  },
  nodePoolId: string,
): Promise<NodePoolRunners> {
  const rows = await deps.rows(nodePoolId);
  const runners: NodePoolRunners = {
    busy: 0,
    idle: 0,
    pending: 0,
    reasons: [],
  };
  if (rows.length === 0) return runners;
  const selectors = new Set(
    rows.map((row) => kubernetesWorkloadPodSelector(row.id)),
  );
  const held = new Set(rows.map((row) => row.podUid));
  const runtime = await deps.runtimes.resolve({ kind: 'nodePool', nodePoolId });
  const { items } = await runtime.cluster.core.listNamespacedPod(
    { namespace: runtime.config.namespace },
    kubernetesRequestOptions(AbortSignal.timeout(5_000)),
  );
  const reasons = new Set<string>();
  let cap: Promise<string | null> | undefined;
  for (const pod of items) {
    const labels = pod.metadata?.labels ?? {};
    const managed = Object.entries(labels).some(([key, value]) =>
      selectors.has(`${key}=${value}`),
    );
    if (
      !managed ||
      pod.metadata?.deletionTimestamp ||
      ['Succeeded', 'Failed'].includes(pod.status?.phase ?? '')
    ) {
      continue;
    }
    if (held.has(pod.metadata?.uid ?? null)) runners.busy += 1;
    else if (isPodReady(pod)) runners.idle += 1;
    else {
      runners.pending += 1;
      const reason =
        (!pod.spec?.nodeName && (await (cap ??= deps.capBlock()))) ||
        podPendingReason(pod);
      if (reason) reasons.add(reason);
    }
  }
  return { ...runners, reasons: [...reasons] };
}
