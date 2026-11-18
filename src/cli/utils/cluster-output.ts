import type { ClusterSummary } from '../../shared/api-contract/clusters-schemas.js';
import { formatAge } from './duration.js';
import { RELEASING_LABELS } from './releasing.js';
import { formatLocation, printFields, printStateHeader } from './output.js';

/** The state with the Workload "releasing" label while the VM is released. */
export function formatClusterState(
  cluster: ClusterSummary,
  compact = false,
): string {
  if (!cluster.releasing) return cluster.state;
  return `${cluster.state}${compact ? RELEASING_LABELS.stateCompact : RELEASING_LABELS.state}`;
}

/**
 * The installed API version. The hosted API's own record reports its pinned
 * image and release when Helm-managed, and its own version otherwise; an
 * installer cluster's apiVersion is only planned until its release.
 */
export function clusterApiVersion(cluster: ClusterSummary): string | null {
  return (
    cluster.release?.apiVersion ??
    (cluster.apiImage ? null : cluster.apiVersion)
  );
}

export function printClusterSummary(cluster: ClusterSummary): void {
  printStateHeader(cluster.state, cluster.releasing);
  const lines: Array<[string, string]> = [
    ['Name', cluster.name],
    ['ID', cluster.id],
  ];
  // A hosted API's record from before 0.1.74 carries no creation facts.
  if (cluster.cloudProvider) {
    lines.push([
      'Cloud',
      formatLocation(cluster.cloudProvider, cluster.region, cluster.zone),
    ]);
    if (cluster.cloudAccount) lines.push(['Account', cluster.cloudAccount]);
    lines.push(['VM', cluster.vmType ?? '']);
  }
  if (cluster.address) lines.push(['Address', cluster.address]);
  if (cluster.k3sVersion)
    lines.push(['Kubernetes', `K3s ${cluster.k3sVersion}`]);
  const apiVersion = clusterApiVersion(cluster);
  if (apiVersion) lines.push(['API', apiVersion]);
  if (cluster.managementApiUrl) lines.push(['URL', cluster.managementApiUrl]);
  lines.push(['Age', formatAge(cluster.createdAt)]);
  if (cluster.lastError) lines.push(['Last error', cluster.lastError]);
  printFields(lines);
}
