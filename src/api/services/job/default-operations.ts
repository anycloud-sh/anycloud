import { type StoredWorkload } from '../workload-record.js';
import { WorkloadType } from '../../../shared/workload.js';
import type { StoredDeployment } from '../deployment-store.js';
import { getDefaultDeploymentRuntimeResolver } from '../kubernetes/default-runtime.js';
import { createNodePoolLogs, type NodePoolLogs } from './node-pool-logs.js';
import {
  createJobOperationsRouter,
  type JobExecPreparation,
  type JobLogsPreparation,
  type JobOperations,
} from './operations.js';
import { createVmHostJobOperations } from './vm-host-operations.js';
import { createPoolJobLogs } from './pool-job-logs.js';
import { createDeploymentExec, createPoolJobExec } from './pool-exec.js';
import { getPoolJobStore } from '../persistence.js';

let defaultVmHostOperations: JobOperations | undefined;
let defaultNodePoolLogs: NodePoolLogs | undefined;

/** Concrete VM transport, shared by the Job router and non-Job workloads. */
function getDefaultVmHostJobOperations(): JobOperations {
  defaultVmHostOperations ??= createVmHostJobOperations();
  return defaultVmHostOperations;
}

function getDefaultNodePoolLogs(): NodePoolLogs {
  defaultNodePoolLogs ??= createNodePoolLogs({
    runtimes: getDefaultDeploymentRuntimeResolver(),
  });
  return defaultNodePoolLogs;
}

/**
 * Operational transport for any workload. Jobs dispatch by stored provider;
 * Services and VMs use the VM-host transport, so they never reach the Job
 * router — which fails closed on a non-Job workload. A node-pool Service runs
 * as a Kubernetes Deployment with no VM host: its logs come from its Pods, and
 * the VM-host transport refuses its exec (`refuseNodePoolService`); a pool
 * Job's logs and exec go to its replica. Routes
 * select transport through here so that rule lives in one place.
 */
export function getDefaultWorkloadOperations(
  workload: StoredWorkload,
): JobOperations {
  if (workload.workloadType === WorkloadType.Job) {
    const pool = {
      window: (id: string) => getPoolJobStore().logWindow(id),
      runtimes: getDefaultDeploymentRuntimeResolver(),
    };
    return createJobOperationsRouter({
      vmHost: getDefaultVmHostJobOperations(),
      poolJobLogs: createPoolJobLogs(pool),
      poolJobExec: createPoolJobExec(pool),
    });
  }
  const vmHost = getDefaultVmHostJobOperations();
  if (workload.nodePoolId === null) return vmHost;
  return {
    ...vmHost,
    prepareLogs: ({ follow }) =>
      getDefaultNodePoolLogs().service(workload, follow),
  };
}

/** `anycloud logs` for a Deployment record, from its replica Pods. */
export function prepareDeploymentLogs(
  deployment: StoredDeployment,
  follow: boolean,
): Promise<JobLogsPreparation> {
  return getDefaultNodePoolLogs().deployment(deployment, follow);
}

/** `anycloud exec` for a Deployment record, in one of its replica Pods. */
export function prepareDeploymentExec(
  deployment: StoredDeployment,
  command: string,
  replica: string | undefined,
): Promise<JobExecPreparation> {
  return createDeploymentExec({
    runtimes: getDefaultDeploymentRuntimeResolver(),
  })(deployment, command, replica);
}
