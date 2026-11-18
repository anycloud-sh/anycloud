import { type StoredWorkload } from '../workload-record.js';
import { WorkloadType } from '../../../shared/workload.js';
import {
  WorkloadHealthStatus,
  type ContainerStatus,
  type ServiceStatus,
} from '../../../shared/runtime.js';
import type { GpuHealth } from '../../../shared/api-contract/workload-management-schemas.js';
import type { DbVM } from '../entities.js';

export interface JobOperationStream {
  signal: AbortSignal;
  onStdout(chunk: Buffer): void | Promise<void>;
  onStderr(chunk: Buffer): void | Promise<void>;
}

export interface JobVmHealth {
  ip: string;
  container: ContainerStatus;
  rclone: {
    output?: ServiceStatus;
    checkpoint?: ServiceStatus;
  };
  /** NVIDIA GPU VMs only. */
  gpu?: GpuHealth;
}

export interface JobHealthObservation {
  status: WorkloadHealthStatus;
  vmHealth?: JobVmHealth[];
}

interface JobOperationRequest {
  workload: StoredWorkload;
  allVms: DbVM[];
}

interface JobHealthRequest extends JobOperationRequest {
  verbose: boolean;
}

interface JobExecRequest extends JobOperationRequest {
  command: string;
}

interface JobLogsRequest extends JobOperationRequest {
  follow: boolean;
}

interface JobOperationRejection {
  ok: false;
  status: number;
  /** API error code; defaults to WORKLOAD_OPERATION_FAILED. */
  code?: string;
  clientError: string;
  telemetryError: string;
}

/** A refusal whose telemetry is its client error. */
export const refused = (status: number, clientError: string) => ({
  ok: false as const,
  status,
  clientError,
  telemetryError: clientError,
});

interface PreparedJobExec {
  ok: true;
  run(stream: JobOperationStream): Promise<number>;
}

export type JobExecPreparation = PreparedJobExec | JobOperationRejection;

interface JobLogsTelemetry {
  probeCount: number;
  targetContainerStatus?: string;
}

interface PreparedJobLogs extends JobLogsTelemetry {
  ok: true;
  run(stream: JobOperationStream): Promise<number>;
}

interface RejectedJobLogs extends JobOperationRejection, JobLogsTelemetry {}

export type JobLogsPreparation = PreparedJobLogs | RejectedJobLogs;

/**
 * Provider dispatch and transport preparation for Job operational routes.
 * Lifecycle state transitions remain on JobRuntime and concrete scheduler
 * behavior remains on the provider runtime.
 */
export interface JobOperations {
  observeHealth(request: JobHealthRequest): Promise<JobHealthObservation>;
  prepareExec(request: JobExecRequest): Promise<JobExecPreparation>;
  prepareLogs(request: JobLogsRequest): Promise<JobLogsPreparation>;
}

export interface JobOperationsRouterDeps {
  vmHost: JobOperations;
  /** A pool Job's logs; null for a Job on a user Deployment. */
  poolJobLogs(
    jobId: string,
    follow: boolean,
  ): Promise<JobLogsPreparation | null>;
  /** A pool Job's exec; null for a Job on a user Deployment. */
  poolJobExec(
    jobId: string,
    command: string,
  ): Promise<JobExecPreparation | null>;
}

function assertJob(workload: StoredWorkload): void {
  if (workload.workloadType !== WorkloadType.Job) {
    throw new Error(
      `Job operations cannot manage ${workload.workloadType} workload ${workload.id}`,
    );
  }
}

function targetedOperationMessage(workload: StoredWorkload): string {
  return `Per-Job health, exec, and logs are unavailable for Deployment-targeted Job ${workload.id}`;
}

/**
 * Selects operational transport at the Job composition boundary.
 * Deployment-targeted Jobs have no per-Job transport.
 * cloudtype-boundary-ok: this is the composition root that selects the
 * provider-specific Job operations implementation.
 */
export function createJobOperationsRouter({
  vmHost,
  poolJobLogs,
  poolJobExec,
}: JobOperationsRouterDeps): JobOperations {
  const forWorkload = async (
    workload: StoredWorkload,
  ): Promise<JobOperations | null> => {
    assertJob(workload);
    if (workload.deploymentId) return null;
    return vmHost;
  };

  return {
    async observeHealth(request): Promise<JobHealthObservation> {
      const operations = await forWorkload(request.workload);
      return operations
        ? operations.observeHealth(request)
        : { status: WorkloadHealthStatus.Unknown };
    },

    async prepareExec(request): Promise<JobExecPreparation> {
      const operations = await forWorkload(request.workload);
      if (operations) return operations.prepareExec(request);
      return (
        (await poolJobExec(request.workload.id, request.command)) ?? {
          ok: false,
          status: 400,
          clientError: targetedOperationMessage(request.workload),
          telemetryError: 'Deployment-targeted Job exec unsupported',
        }
      );
    },

    async prepareLogs(request): Promise<JobLogsPreparation> {
      const operations = await forWorkload(request.workload);
      if (operations) return operations.prepareLogs(request);
      return (
        (await poolJobLogs(request.workload.id, request.follow)) ?? {
          ok: false,
          status: 400,
          clientError: targetedOperationMessage(request.workload),
          telemetryError: 'Deployment-targeted Job logs unsupported',
          probeCount: 0,
        }
      );
    },
  };
}
