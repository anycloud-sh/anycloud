import { isLoopbackApiUrl } from '../../shared/config.js';

/**
 * Why no replica could claim Jobs from this API, or undefined when one can.
 * Replicas claim through the workload API URL (`ANYCLOUD_API_URL`, set by
 * deployment-objects.ts); a loopback one names the Pod itself. A hosted API
 * refuses to start with one (server.ts), so this refuses only on a local API.
 */
export function unclaimableWorkloadApiUrl(
  workloadApiUrl: string,
): string | undefined {
  if (!isLoopbackApiUrl(workloadApiUrl)) return undefined;
  return `Pods can't reach this API to claim Jobs: its workload URL ${workloadApiUrl} is loopback. Run Deployments and Jobs on node pools through the cluster's API: \`anycloud api use https://<cluster-id>.anycloud.sh\`.`;
}
