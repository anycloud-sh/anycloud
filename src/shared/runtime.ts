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
  /** `name:/path` Node cache volumes; a pool Job's replica only (RFC 0049 C12). */
  caches?: string[];
  /**
   * A pool Job's replica runs as root of its own user namespace (RFC 0049
   * C32); set by admission, never on the wire.
   */
  userNamespace?: boolean;
}

/**
 * A user-namespace replica's runner exits with this, distinct from its own 1
 * and 143 and tini's 126 and 127, when it can't delegate the replica's
 * cgroup (RFC 0049 C32); its termination message says why.
 */
export const USER_NAMESPACE_RUNNER_EXIT_CODE = 78;

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
