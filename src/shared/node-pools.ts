import { WorkloadState } from './workload.js';

/**
 * A node pool is one cloud-specific VM pool inside a cluster. It owns
 * its compute credential, region/zone and VM type; the cluster owns the
 * Kubernetes identity the node pool's Nodes join.
 */
export enum NodePoolState {
  Creating = 'creating',
  Ready = 'ready',
  Failed = 'failed',
  Deleting = 'deleting',
  Deleted = 'deleted',
}

/**
 * The Workload state users see for a stored state; a deleting pool is
 * terminated and still releasing its VMs.
 */
export const NODE_POOL_WORKLOAD_STATE = {
  [NodePoolState.Creating]: WorkloadState.Provisioning,
  [NodePoolState.Ready]: WorkloadState.Running,
  [NodePoolState.Failed]: WorkloadState.Failed,
  [NodePoolState.Deleting]: WorkloadState.Terminated,
  [NodePoolState.Deleted]: WorkloadState.Terminated,
} as const satisfies Record<NodePoolState, WorkloadState>;
