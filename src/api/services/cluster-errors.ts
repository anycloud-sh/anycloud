import { ClusterState } from '../../shared/clusters.js';

/** The cluster errors the API surface maps, kept free of kubernetes/. */
export class ClusterExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterExistsError';
  }
}

export class ClusterInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterInvalidError';
  }
}

export class ClusterUnavailableError extends Error {
  constructor() {
    super(
      'cluster bootstrap is not available on this API: it requires a local API with saved cloud credentials',
    );
    this.name = 'ClusterUnavailableError';
  }
}

export class ClusterNotFoundError extends Error {
  constructor(public readonly identifier: string) {
    super(`cluster "${identifier}" not found`);
    this.name = 'ClusterNotFoundError';
  }
}

export class ClusterBusyError extends Error {
  constructor(state: string) {
    super(
      `cluster ${state === ClusterState.Destroying ? 'deletion' : 'creation'} is in progress; wait for it to finish`,
    );
    this.name = 'ClusterBusyError';
  }
}

/**
 * An installation whose destruction started cannot be bootstrapped again: its
 * VM may be half released and its cluster record half deleted. Only `destroy`
 * resumes it, from the ledger.
 */
export class ClusterDestroyFailedError extends Error {
  constructor(name: string) {
    super(
      `cluster "${name}" failed while being destroyed; run anycloud api delete ${name} again to finish releasing it`,
    );
    this.name = 'ClusterDestroyFailedError';
  }
}

/** The cluster's HelmChart changed between observation and apply. */
export class ClusterReleaseConflictError extends Error {
  constructor() {
    super('cluster release changed while the intent was being applied');
    this.name = 'ClusterReleaseConflictError';
  }
}

/** What still holds a cluster: Workloads not yet ended. */
export interface ClusterDependents {
  /** VM Services and Jobs not yet ended, by ID. */
  readonly workloads: readonly string[];
}

/**
 * Why `api delete <clusterName>` is refused and what to run first, or
 * null when nothing holds it.
 */
export function dependentsRefusal(
  { workloads }: ClusterDependents,
  clusterName: string,
): string | null {
  if (workloads.length === 0) return null;
  const one = workloads.length === 1;
  return `Workload${one ? '' : 's'} ${workloads.join(', ')} still ${one ? 'runs' : 'run'}. Run anycloud terminate <id>, then anycloud api delete ${clusterName} again.`;
}
