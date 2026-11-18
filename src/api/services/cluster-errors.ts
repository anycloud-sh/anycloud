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

export class ClusterReferencedError extends Error {
  constructor(
    message = 'cluster still has active node pools; delete them first',
  ) {
    super(message);
    this.name = 'ClusterReferencedError';
  }
}

/** The API's own reason, such as the token exchange refusing a sign-in. */
function refusalOf(body: string): string {
  try {
    const { message } = JSON.parse(body) as { message?: unknown };
    return typeof message === 'string' && message ? `: ${message}` : '';
  } catch {
    return '';
  }
}

/** The hosted API answered but refused this account, CLI version or request. */
export class HostedApiAccessError extends Error {
  constructor(
    url: string,
    readonly status: number,
    body = '',
    /** For a version refusal: which side is behind and how to bring it level. */
    readonly versionFix?: string,
  ) {
    super(
      versionFix
        ? `The hosted API at ${url} refused this CLI's version: ${versionFix}, then run anycloud cluster delete again`
        : status === 400
          ? `The hosted API at ${url} rejected the node pool check (HTTP 400${body.trim() ? `: ${body.trim().slice(0, 200)}` : ''})`
          : `The hosted API at ${url} refused this account (HTTP ${status}); the node pools it manages can only be checked by the account that bootstrapped it — sign in as that account (anycloud api use ${url} shows what it admits)${refusalOf(body)}`,
    );
    this.name = 'HostedApiAccessError';
  }
}

/** Delete needs the hosted API; the message says how to restore or clean up. */
export class ClusterUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterUnreachableError';
  }
}

/** Forget is only for a cluster whose hosted API no longer answers. */
export class ClusterReachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterReachableError';
  }
}

/** Forget is only for a cluster whose management VM the cloud shows gone. */
export class ClusterVmPresentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterVmPresentError';
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
      `cluster "${name}" failed while being destroyed; run anycloud cluster delete ${name} again to finish releasing it`,
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

/** What still holds a cluster: an older hosted API's node pools, and Workloads. */
export interface ClusterDependents {
  /** An older hosted API's node pools; this release runs none. */
  readonly pools?: ReadonlyArray<{ name: string; liveReferences: number }>;
  /** VM Services and Jobs not yet ended, by ID. */
  readonly workloads: readonly string[];
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/**
 * Why `cluster delete <clusterName>` is refused and what to run first, or
 * null when nothing holds it. `apiUrl` names the hosted API the commands
 * run against when the refusal comes from elsewhere.
 */
export function dependentsRefusal(
  { pools = [], workloads }: ClusterDependents,
  clusterName: string,
  apiUrl?: string,
): string | null {
  // Only an older release still runs node pools, so its own CLI removes them.
  const cli = pools.length > 0 ? ' with the CLI of its release' : '';
  const run = apiUrl
    ? ` Against the hosted API (${apiUrl})${cli}: run`
    : pools.length > 0
      ? ` With the CLI of the hosted API's release, run`
      : ' Run';
  const again = `then anycloud cluster delete ${clusterName} again.`;
  const names = (list: ReadonlyArray<{ name: string }>) =>
    list.map((pool) => pool.name).join(', ');
  const referenced = pools.filter((pool) => pool.liveReferences > 0);
  const idle = pools.filter((pool) => pool.liveReferences === 0);
  if (referenced.length > 0 || workloads.length > 0) {
    const held = [
      referenced.length > 0 &&
        `Node pool${plural(referenced.length, '', 's')} ${names(referenced)} still ${plural(referenced.length, 'has', 'have')} Deployments or Services.`,
      workloads.length > 0 &&
        `Workload${plural(workloads.length, '', 's')} ${workloads.join(', ')} still ${plural(workloads.length, 'runs', 'run')}.`,
      idle.length > 0 &&
        `Node pool${plural(idle.length, '', 's')} ${names(idle)} also exist${plural(idle.length, 's', '')}.`,
    ].filter(Boolean);
    const release =
      referenced.length > 0
        ? 'anycloud deployment delete <id> / anycloud terminate <id>'
        : 'anycloud terminate <id>';
    return `${held.join(' ')}${run} ${release}, ${pools.length > 0 ? 'then anycloud node-pool delete <name>, ' : ''}${again}`;
  }
  if (pools.length > 0) {
    return `Node pool${plural(pools.length, '', 's')} ${names(pools)} still exist${plural(pools.length, 's', '')}.${run} anycloud node-pool delete <name>, ${again}`;
  }
  return null;
}
