import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../shared/api-version.js';
import { MAX_LIST_LIMIT } from '../../shared/workload-list.js';

/** One node pool, Kubernetes Deployment or node pool Service still live. */
export interface RemovedWorkload {
  kind: 'node pool' | 'Deployment' | 'node pool Service';
  id: string;
  name: string;
}

export class RemovedWorkloadsError extends Error {
  readonly code = 'REMOVED_WORKLOADS_REMAIN';
}

/**
 * Reads the served API's node pools, Kubernetes Deployments and node pool
 * Services through the routes it still serves, which this release removes;
 * an API without a route has none of that kind. A served API accepts only
 * its own release's clients, so the reads name its version.
 */
export async function remainingRemovedWorkloads(
  apiUrl: string,
  servedVersion: string,
  bearer: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<RemovedWorkload[]> {
  const read = async <T>(path: string): Promise<T | null> => {
    const response = await fetchImpl(`${apiUrl}/v1${path}`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        [ANYCLOUD_CLIENT_VERSION_HEADER]: servedVersion,
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Could not list ${path.slice(1).split('?')[0]} on ${apiUrl} (HTTP ${response.status}).`,
      );
    }
    return (await response.json()) as T;
  };
  const [pools, deployments, services] = await Promise.all([
    read<{
      nodePools: {
        id: string;
        name: string;
        state: string;
        releasing: boolean;
      }[];
    }>('/node-pools'),
    read<{
      deployments: {
        id: string;
        name: string;
        managed: boolean;
        deletedAt: number | null;
      }[];
    }>('/deployments'),
    read<{ id: string; nodePoolId?: string | null }[]>(
      `/workloads?workloadType=service&stateClass=terminatable&limit=${MAX_LIST_LIMIT}`,
    ),
  ]);
  return [
    ...(services ?? [])
      .filter((service) => service.nodePoolId)
      .map((service) => ({
        kind: 'node pool Service' as const,
        id: service.id,
        name: service.id,
      })),
    // A managed Deployment (pool Jobs) goes with its node pool.
    ...(deployments?.deployments ?? [])
      .filter(
        (deployment) => !deployment.managed && deployment.deletedAt === null,
      )
      .map(({ id, name }) => ({ kind: 'Deployment' as const, id, name })),
    // A deleted pool is listed while its VMs are still released.
    ...(pools?.nodePools ?? [])
      .filter((pool) => pool.state !== 'terminated' || pool.releasing)
      .map(({ id, name }) => ({ kind: 'node pool' as const, id, name })),
  ];
}

/** The refusal naming what to remove, in the order removal is accepted. */
export function removedWorkloadsRefusal(
  remaining: readonly RemovedWorkload[],
): RemovedWorkloadsError {
  return new RemovedWorkloadsError(
    [
      'This release removes node pools, Kubernetes Deployments and node pool Services, and these remain:',
      ...remaining.map(
        ({ kind, name, id }) =>
          `  ${kind} ${name}${name === id ? '' : ` (${id})`}`,
      ),
      'Remove them on the current release first: "anycloud terminate <id>" for each Service, "anycloud deployment delete <name>", then "anycloud node-pool delete <name>". Run Jobs as VM Jobs ("anycloud job"), and long-running processes on a VM ("anycloud vm") or as a VM Service ("anycloud service").',
    ].join('\n'),
  );
}
