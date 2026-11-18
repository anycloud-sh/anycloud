/** The cluster errors the API surface maps, kept free of kubernetes/. */
export class ClusterNotFoundError extends Error {
  constructor(public readonly identifier: string) {
    super(`cluster "${identifier}" not found`);
    this.name = 'ClusterNotFoundError';
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
