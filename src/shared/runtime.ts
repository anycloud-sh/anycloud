export enum ServiceState {
  Running = 'running',
  Stopped = 'stopped',
  Starting = 'starting',
  Stopping = 'stopping',
  Fatal = 'fatal',
  Unknown = 'unknown',
}

export interface ServiceStatus {
  status: ServiceState;
  logs?: string;
}

/** Docker runtime options accepted by workload requests. */
export interface DockerOptions {
  /** Deprecated; removed in the next release (RFC 0049 C32). */
  privileged?: boolean;
  shmSize?: string;
  gpus?: string;
  ipc?: string;
  ulimits?: string[];
  memory?: string;
  cpus?: string;
  runtime?: string;
  binds?: string[];
  network?: string;
}

/** Docker container states from `docker inspect .State.Status`. */
export enum ContainerState {
  Created = 'created',
  Running = 'running',
  Paused = 'paused',
  Restarting = 'restarting',
  Exited = 'exited',
  Dead = 'dead',
  NotFound = 'not found',
}

export interface ContainerStatus {
  state: ContainerState;
  exitCode?: number;
  oomKilled?: boolean;
  logs?: string;
  uptime?: string;
}

export function isContainerHealthy(status: ContainerStatus): boolean {
  return status.state === ContainerState.Running;
}

export enum WorkloadHealthStatus {
  Up = 'up',
  Down = 'down',
  Unknown = '-',
}
