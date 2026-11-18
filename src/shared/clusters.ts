import { WorkloadState } from './workload.js';

/**
 * The installation's one Kubernetes cluster: the management VM in the VM
 * ledger, the K3s server on it, the control plane's verified identity and
 * connection, and the API system release intent. It is recorded before any
 * cloud mutation, so an interrupted creation resumes from the same record and
 * independent maintenance/deletion never needs the hosted API.
 */
export enum ClusterState {
  Bootstrapping = 'bootstrapping',
  Ready = 'ready',
  Failed = 'failed',
  Destroying = 'destroying',
  /** Destruction started and did not finish; only `destroy` may resume it. */
  DestroyFailed = 'destroy-failed',
  Destroyed = 'destroyed',
}

/**
 * The last durably completed creation step. Creation resumes at the step
 * after this one; every step is idempotent against the recorded identities.
 */
export enum ClusterStep {
  Intent = 'intent',
  ManagementVm = 'management-vm',
  Kubernetes = 'kubernetes',
  Kubeconfig = 'kubeconfig',
  Connection = 'connection',
  ReleaseIntent = 'release-intent',
  Release = 'release',
}

export const CLUSTER_STEP_ORDER: readonly ClusterStep[] = [
  ClusterStep.Intent,
  ClusterStep.ManagementVm,
  ClusterStep.Kubernetes,
  ClusterStep.Kubeconfig,
  ClusterStep.Connection,
  ClusterStep.ReleaseIntent,
  ClusterStep.Release,
];

/**
 * What users see: a Workload state. The stored state and step stay internal;
 * the step only says how far a creation got, which reads as provisioning the
 * management VM, initializing Kubernetes or starting the API.
 */
export const CLUSTER_WORKLOAD_STATES = [
  WorkloadState.Provisioning,
  WorkloadState.Initializing,
  WorkloadState.Starting,
  WorkloadState.Running,
  WorkloadState.Failed,
  WorkloadState.Terminated,
] as const;

export type ClusterWorkloadState = (typeof CLUSTER_WORKLOAD_STATES)[number];

const CREATION_PHASE: Record<ClusterStep, ClusterWorkloadState> = {
  [ClusterStep.Intent]: WorkloadState.Provisioning,
  [ClusterStep.ManagementVm]: WorkloadState.Initializing,
  [ClusterStep.Kubernetes]: WorkloadState.Initializing,
  [ClusterStep.Kubeconfig]: WorkloadState.Initializing,
  [ClusterStep.Connection]: WorkloadState.Starting,
  [ClusterStep.ReleaseIntent]: WorkloadState.Starting,
  [ClusterStep.Release]: WorkloadState.Starting,
};

/**
 * Starts a failed delete's last error, so `status` says which operation
 * failed: a failed create and a failed delete are both `failed`.
 */
export const DELETE_FAILED_PREFIX = 'Delete failed: ';

export function clusterWorkloadState(
  state: ClusterState,
  step: ClusterStep,
): ClusterWorkloadState {
  switch (state) {
    case ClusterState.Bootstrapping:
      return CREATION_PHASE[step];
    case ClusterState.Ready:
      return WorkloadState.Running;
    case ClusterState.Failed:
    case ClusterState.DestroyFailed:
      return WorkloadState.Failed;
    case ClusterState.Destroying:
    case ClusterState.Destroyed:
      return WorkloadState.Terminated;
  }
}

export enum ClusterReleaseState {
  Seeded = 'seeded',
  Applied = 'applied',
  Completed = 'completed',
  Failed = 'failed',
}

/**
 * The local API installer's create request: no route takes it since create
 * runs through the user's own cloud CLI; the installer's domain still
 * implements it until lane S6 removes it with the local destroy.
 */
export interface CreateClusterRequest {
  name: string;
  credentialName: string;
  region: string;
  zone?: string;
  vmType: string;
  /** Retained, user-owned bucket for the hosted API's backups; without it a managed one. */
  checkpointBucket?: string;
}

/** The name and tag of a cluster's network resources: `anycloud-cluster-<id>`, at most 63 characters. */
export function clusterNetworkScope(clusterId: string): string {
  return `anycloud-cluster-${clusterId}`.slice(0, 63);
}
