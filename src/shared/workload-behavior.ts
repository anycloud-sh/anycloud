import { assertNever } from './assert-never.js';
import { type WorkloadTypeValue } from './workload.js';

/**
 * Whether a workload is only healthy while its workload container remains
 * running. Finite Jobs are allowed to exit; Services and VMs are
 * long-running workloads.
 */
export function workloadRequiresRunningContainer(
  workloadType: WorkloadTypeValue,
): boolean {
  switch (workloadType) {
    case 'job':
      return false;
    case 'service':
    case 'vm':
      return true;
    default:
      return assertNever(workloadType);
  }
}

/** Whether the workload type inherently requests managed HTTP ingress. */
export function workloadRequestsManagedHttpIngress(
  workloadType: WorkloadTypeValue,
): boolean {
  switch (workloadType) {
    case 'job':
    case 'vm':
      return false;
    case 'service':
      return true;
    default:
      return assertNever(workloadType);
  }
}

/** Public label for a persisted workload type. */
export function workloadTypeLabel(workloadType: WorkloadTypeValue): string {
  switch (workloadType) {
    case 'job':
      return 'job';
    case 'service':
      return 'service';
    case 'vm':
      return 'vm';
    default:
      return assertNever(workloadType);
  }
}

export type WorkloadTypeBucket = 'jobs' | 'services' | 'vms';

/** Stable exhaustive bucket name for user-visible aggregates. */
export function workloadTypeBucket(
  workloadType: WorkloadTypeValue,
): WorkloadTypeBucket {
  switch (workloadType) {
    case 'job':
      return 'jobs';
    case 'service':
      return 'services';
    case 'vm':
      return 'vms';
    default:
      return assertNever(workloadType);
  }
}
