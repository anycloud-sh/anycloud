import { type StoredWorkload } from '../workload-record.js';
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
const refused = (status: number, clientError: string) => ({
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
