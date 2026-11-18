import { type WorkloadTypeValue } from '../../shared/workload.js';
import {
  ContainerState,
  type ContainerStatus,
  isContainerHealthy,
} from '../../shared/runtime.js';
import { ContainerExitError } from './task.js';
import { assertNever } from '../../shared/assert-never.js';
import { workloadRequiresRunningContainer } from '../../shared/workload-behavior.js';

export type RuntimeContainerStatus = ContainerStatus & {
  startedAt?: string;
};

export type StartupReadiness = 'ready' | 'pending';

const SERVICE_STARTUP_HEALTH_DWELL_MS = 30_000;

export function toPublicContainerStatus(
  status: RuntimeContainerStatus,
): ContainerStatus {
  const publicStatus: ContainerStatus = { state: status.state };

  if (status.exitCode !== undefined) publicStatus.exitCode = status.exitCode;
  if (status.oomKilled !== undefined) publicStatus.oomKilled = status.oomKilled;
  if (status.logs !== undefined) publicStatus.logs = status.logs;
  if (status.uptime !== undefined) publicStatus.uptime = status.uptime;

  return publicStatus;
}

/**
 * Classify normalized runtime status for anycloud startup semantics.
 *
 * The status may come from Docker inspect, provider-specific sentinel files,
 * or a scheduler-native observation; this layer owns what those facts mean for
 * each workload type's startup.
 */
export function classifyStartupReadiness(
  status: RuntimeContainerStatus,
  workloadType: WorkloadTypeValue,
): StartupReadiness {
  if (
    status.state === ContainerState.Exited ||
    status.state === ContainerState.Dead ||
    (workloadRequiresRunningContainer(workloadType) &&
      status.state === ContainerState.Restarting)
  ) {
    switch (workloadType) {
      case 'service':
        // A Service must stay up. Any exit or restart during startup, even code 0,
        // means publishing the endpoint would mark a non-serving workload Running.
        throw new ContainerExitError(
          status.state === ContainerState.Restarting
            ? 'Service container restarting during startup'
            : 'Service container exited during startup',
          status,
        );
      case 'vm':
        throw new ContainerExitError(
          status.state === ContainerState.Restarting
            ? 'VM container restarting during startup'
            : 'VM container exited during startup',
          status,
        );
      case 'job':
        // Jobs may finish fast; a clean exit is healthy and the monitor will
        // detect Completed. A non-zero exit is a startup failure.
        if (status.exitCode !== 0) {
          throw new ContainerExitError(
            'Container exited during startup',
            status,
          );
        }
        return 'ready';
      default:
        return assertNever(workloadType);
    }
  }

  return isContainerHealthy(status) ? 'ready' : 'pending';
}

export function hasSatisfiedServiceStartupDwell(
  status: RuntimeContainerStatus,
  dwellMs = SERVICE_STARTUP_HEALTH_DWELL_MS,
): boolean {
  if (status.state !== ContainerState.Running) return false;
  if (!status.startedAt) return false;
  const startedAt = Date.parse(status.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt >= dwellMs;
}
