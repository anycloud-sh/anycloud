import type { SelfDeleteStatus } from '../../shared/api-contract/system-release-schemas.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { CloudSeed, SeedResource, SeedStatus } from '../seed/types.js';

/**
 * `api delete` on the seed (RFC 0049 C26, seed design). With the hosted
 * API reachable, the API deletes everything and itself last; the CLI follows
 * it, then through the cloud CLI until the stack, group or instance is gone,
 * and then removes the DNS record. With the API dead, guards decide whether
 * the seed's `deleteFallback` may run. No cloud SDK runs here.
 */
export interface DeleteFlags {
  readonly deleteVms: boolean;
  readonly deleteBuckets: boolean;
  readonly skipCloud: boolean;
  readonly checkpointBucket?: string;
}

/** One entry of the report's `deleted` or `remaining` (C26 (d)). */
export type DeleteEntry =
  | { kind: 'managementVm'; id: string; stopped?: boolean }
  | {
      kind: 'cloudResource';
      type: string;
      id: string;
      location: string | null;
      selector?: string;
      /** `harmless`: left on purpose, at no cost. */
      reason?: string;
      error?: string;
    }
  | { kind: 'dnsRecord'; name: string }
  | {
      kind: 'checkpointBucket';
      name: string;
      managed: boolean;
      /** C28: `kept` by default, `supplied` never deleted. */
      reason?: 'kept' | 'supplied';
      restoreCommand?: string;
      deleteCommand?: string;
    };

export interface DeleteReport {
  readonly outcome: 'destroyed' | 'abandoned' | 'planned';
  readonly clusterId: string;
  readonly finalBackup: SelfDeleteStatus['finalBackup'];
  readonly deleted: DeleteEntry[];
  readonly remaining: DeleteEntry[];
}

export class DeleteRefusedError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_MISMATCH'
      | 'ACCOUNT_UNCONFIRMED'
      | 'INSTALLATION_INCOMPLETE'
      | 'MANAGEMENT_VM_RUNNING'
      | 'MANAGEMENT_VM_STOPPED'
      | 'SELF_DELETE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'DeleteRefusedError';
  }
}

export interface SeedDeleteDependencies {
  readonly seed: CloudSeed;
  readonly region: string;
  /** Asked before each deletion; throws when not confirmed. */
  confirm(warning: string): Promise<void>;
  /** The DNS record and origin certificate, with the user's GitHub sign-in. */
  removeDns(clusterId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
}

/** How the reachable path talks to the hosted API. */
export interface HostedSelfDelete {
  request(clusterId: string, deleteBuckets: boolean): Promise<SelfDeleteStatus>;
  /** Null once the API no longer answers: it has deleted itself. */
  status(): Promise<SelfDeleteStatus | null>;
}

const POLL_MS = 10_000;
const GONE_TIMEOUT_MS = 30 * 60_000;

function hostname(clusterId: string): string {
  return `${clusterId}.anycloud.sh`;
}

function fromSeed(
  resource: SeedResource & { selector?: string; reason?: string },
): DeleteEntry {
  return resource.kind === 'vm' && resource.id.startsWith('anycloud-cluster-')
    ? { kind: 'managementVm', id: resource.id }
    : {
        kind: 'cloudResource',
        type: resource.kind,
        id: resource.id,
        location: resource.location ?? null,
        ...(resource.selector && { selector: resource.selector }),
        ...(resource.reason && { reason: resource.reason }),
      };
}

function keptBucket(
  clusterId: string,
  name: string,
  cloud: string,
  region: string,
): DeleteEntry {
  const managed = name === clusterId;
  return {
    kind: 'checkpointBucket',
    name,
    managed,
    reason: managed ? 'kept' : 'supplied',
    restoreCommand: `anycloud api create <name> --cloud ${cloud} --region ${region} --checkpoint-bucket ${name}`,
    ...(managed && {
      deleteCommand: `anycloud api delete ${clusterId} --delete-buckets`,
    }),
  };
}

/** Wait until the cloud shows the installation gone; true when it did. */
async function untilAbsent(
  deps: SeedDeleteDependencies,
  clusterId: string,
): Promise<boolean> {
  const deadline = deps.now() + GONE_TIMEOUT_MS;
  for (;;) {
    const status: SeedStatus = await deps.seed.status(clusterId, deps.region);
    if (status.kind === 'absent') return true;
    if (status.kind === 'failed' || deps.now() >= deadline) return false;
    deps.log(
      status.kind === 'in-progress'
        ? `Waiting for the cloud to delete the installation (${status.detail})`
        : 'Waiting for the cloud to delete the installation',
    );
    await deps.sleep(POLL_MS);
  }
}

/** The DNS record and certificate, kept when the Worker refuses them. */
async function removeDnsInto(
  deps: SeedDeleteDependencies,
  clusterId: string,
  report: { deleted: DeleteEntry[]; remaining: DeleteEntry[] },
): Promise<void> {
  const dns: DeleteEntry = { kind: 'dnsRecord', name: hostname(clusterId) };
  try {
    await deps.removeDns(clusterId);
    report.deleted.push(dns);
  } catch (error) {
    // Only the GitHub account that created the cluster may remove it.
    deps.log(`The DNS record stays: ${errorMessage(error)}`);
    report.remaining.push(dns);
  }
}

/** The cleanup with the user's credentials, the DNS record last. */
async function finish(
  deps: SeedDeleteDependencies,
  clusterId: string,
  flags: DeleteFlags,
  report: { deleted: DeleteEntry[]; remaining: DeleteEntry[] },
): Promise<void> {
  // Only once the installation is absent: on AWS it deletes the role the
  // stack's own delete runs under.
  const after = await deps.seed.afterSelfDelete(clusterId, deps.region, {
    deleteBuckets: flags.deleteBuckets,
  });
  report.deleted.push(...after.deleted.map(fromSeed));
  report.remaining.push(...after.remaining.map(fromSeed));
  await removeDnsInto(deps, clusterId, report);
}

/** Reachable: the API deletes everything, itself last; the CLI follows. */
export async function deleteThroughApi(
  deps: SeedDeleteDependencies,
  api: HostedSelfDelete,
  flags: DeleteFlags,
): Promise<DeleteReport> {
  const before = await api.status();
  if (!before) {
    throw new DeleteRefusedError(
      'SELF_DELETE_FAILED',
      'The hosted API stopped answering before the delete started; run the same command again',
    );
  }
  const { clusterId, bucket } = before.installation;
  // Before anything is asked: under --json or without a terminal it needs --confirm.
  if (flags.deleteBuckets) {
    await deps.confirm(
      bucket.managed
        ? `This also deletes checkpoint bucket ${bucket.name} and every backup in it; the cluster can't be restored afterwards.`
        : `Checkpoint bucket ${bucket.name} was supplied and is never deleted; confirm the rest of the delete.`,
    );
  }
  let status: SelfDeleteStatus | null = await api.request(
    clusterId,
    flags.deleteBuckets,
  );
  const finalBackup = status.finalBackup;
  const deadline = deps.now() + GONE_TIMEOUT_MS;
  let last = status;
  while (status && status.state !== 'failed') {
    // `idle` after a request: the API restarted and lost the delete.
    if (status.state === 'idle' || deps.now() >= deadline) {
      throw new DeleteRefusedError(
        'SELF_DELETE_FAILED',
        `The hosted API's delete stopped (${status.state === 'idle' ? 'it restarted' : 'timed out'}); run anycloud api delete ${clusterId} again`,
      );
    }
    last = status;
    await deps.sleep(POLL_MS);
    status = await api.status();
  }
  if (status?.state === 'failed') {
    throw new DeleteRefusedError(
      'SELF_DELETE_FAILED',
      `The hosted API stopped its delete (${status.error ?? 'unknown error'}); left: ${status.remaining.map((entry) => `${entry.type} ${entry.id}${entry.error ? ` (${entry.error})` : ''}`).join(', ')}. Run the same command again once it can finish.`,
    );
  }
  const report = {
    deleted: last.deleted.map(
      (entry): DeleteEntry => ({ kind: 'cloudResource', ...entry }),
    ),
    remaining: last.remaining.map(
      (entry): DeleteEntry => ({ kind: 'cloudResource', ...entry }),
    ),
  };
  if (!(await untilAbsent(deps, clusterId))) {
    throw new DeleteRefusedError(
      'SELF_DELETE_FAILED',
      `The hosted API stopped answering but its installation isn't gone yet; run anycloud api delete ${clusterId} again to finish it`,
    );
  }
  await finish(deps, clusterId, flags, report);
  // The bucket is deleted only if the seed's cleanup says so.
  const bucketDeleted = report.deleted.some(
    (entry) =>
      entry.kind === 'cloudResource' &&
      entry.type === 'bucket' &&
      entry.id === bucket.name,
  );
  if (!bucketDeleted) {
    report.remaining.push(
      keptBucket(clusterId, bucket.name, deps.seed.cloud, deps.region),
    );
  }
  return { outcome: 'destroyed', clusterId, finalBackup, ...report };
}

/**
 * Guard 1: the recorded account first. `backup.json`, read with the user's
 * CLI, names the account the management VM runs in; a lookup elsewhere would
 * find nothing and pass. Without it, the account is confirmed only when the
 * cloud shows the installation; false otherwise.
 */
async function checkAccount(
  deps: SeedDeleteDependencies,
  clusterId: string,
  bucket: string,
  status: SeedStatus,
): Promise<boolean> {
  const account = await deps.seed.discoverAccount();
  const raw = await deps.seed
    .readObject(bucket, 'anycloud-api/backup.json', deps.region)
    .catch(() => null);
  const manifest = raw
    ? (JSON.parse(raw) as {
        clusterId?: string;
        cloud?: string;
        account?: string;
      })
    : null;
  if (manifest?.clusterId === clusterId && manifest.account) {
    if (
      manifest.account !== account.account ||
      (manifest.cloud && manifest.cloud.toLowerCase() !== deps.seed.cloud)
    ) {
      throw new DeleteRefusedError(
        'ACCOUNT_MISMATCH',
        `Cluster ${clusterId} runs in ${manifest.cloud ?? deps.seed.cloud} account ${manifest.account}, but this ${deps.seed.cloud} CLI is signed in to ${account.account}; sign in to that account and retry`,
      );
    }
    return true;
  }
  return status.kind !== 'absent';
}

function unconfirmed(
  deps: SeedDeleteDependencies,
  clusterId: string,
): DeleteRefusedError {
  return new DeleteRefusedError(
    'ACCOUNT_UNCONFIRMED',
    `No backup.json names cluster ${clusterId}'s account, and this ${deps.seed.cloud} account holds nothing of it in ${deps.region}; if its create failed before deploying anything, nothing is left to delete, otherwise sign in to the account that holds it or pass its --region`,
  );
}

/** Dead: the guards, then only what the flags name. */
export async function deleteWithoutApi(
  deps: SeedDeleteDependencies,
  clusterId: string,
  flags: DeleteFlags,
): Promise<DeleteReport> {
  const bucket = flags.checkpointBucket ?? clusterId;
  const status = await deps.seed.status(clusterId, deps.region);
  const confirmed = await checkAccount(deps, clusterId, bucket, status);
  // Guard 1: an installation mid-change may still be serving, and a failed
  // one may or may not hold a VM, so only --delete-vms takes either; a
  // running VM's API may be unreachable only from here.
  if (
    (status.kind === 'in-progress' || status.kind === 'failed') &&
    !flags.deleteVms
  ) {
    throw new DeleteRefusedError(
      'INSTALLATION_INCOMPLETE',
      `Cluster ${clusterId}'s installation is ${status.kind} (${status.detail}); delete it with --delete-vms once its API is gone`,
    );
  }
  if (status.kind === 'deployed' && !status.stopped) {
    throw new DeleteRefusedError(
      'MANAGEMENT_VM_RUNNING',
      `Management VM ${status.outputs.instanceId} still runs, so its hosted API may be unreachable only from this machine; check its network, or restore it, before deleting`,
    );
  }
  const vm: DeleteEntry | null =
    status.kind === 'deployed'
      ? { kind: 'managementVm', id: status.outputs.instanceId, stopped: true }
      : null;
  const kept = keptBucket(clusterId, bucket, deps.seed.cloud, deps.region);
  const report = {
    deleted: [] as DeleteEntry[],
    remaining: [] as DeleteEntry[],
  };
  // Guard 3: each deletion has its own flag; without one, a listing.
  if (!flags.deleteVms && !flags.deleteBuckets) {
    if (!confirmed) throw unconfirmed(deps, clusterId);
    if (vm) report.remaining.push(vm);
    report.remaining.push(
      {
        kind: 'cloudResource',
        type: 'vm',
        id: `tagged anycloud_cluster=${clusterId}`,
        location: deps.region,
      },
      kept,
    );
    return { outcome: 'planned', clusterId, finalBackup: null, ...report };
  }
  // Guard 2: a stopped VM still holds the API's disk; only --delete-vms takes it.
  if (vm && !flags.deleteVms) {
    throw new DeleteRefusedError(
      'MANAGEMENT_VM_STOPPED',
      `Management VM ${status.kind === 'deployed' ? status.outputs.instanceId : ''} is stopped; start it (Azure), or delete it with --delete-vms before --delete-buckets`,
    );
  }
  // A supplied bucket is never deleted, whatever the flag.
  const deletesBucket = flags.deleteBuckets && bucket === clusterId;
  await deps.confirm(
    flags.deleteVms
      ? `This deletes cluster ${clusterId}'s management VM, its network and the node pool VMs tagged anycloud_cluster=${clusterId}${deletesBucket ? ', and the managed checkpoint bucket with every backup' : ''}.`
      : deletesBucket
        ? `This deletes cluster ${clusterId}'s checkpoint bucket ${bucket} and every backup in it; it can't be restored afterwards.`
        : `Checkpoint bucket ${bucket} was supplied and is never deleted; confirm the rest of the delete.`,
  );
  // --delete-buckets alone, with the VM gone: only the bucket goes.
  const result = flags.deleteVms
    ? await deps.seed.deleteFallback(clusterId, deps.region, {
        deleteBuckets: flags.deleteBuckets,
      })
    : await deps.seed.afterSelfDelete(clusterId, deps.region, {
        deleteBuckets: true,
      });
  // A create that failed before its backup leaves no backup.json; what the
  // cluster's tags find here confirms the account. Finding nothing, the DNS
  // record may be another account's live cluster's, so it stays.
  if (!confirmed && result.deleted.length === 0)
    throw unconfirmed(deps, clusterId);
  report.deleted.push(...result.deleted.map(fromSeed));
  report.remaining.push(...result.remaining.map(fromSeed));
  // The hostname goes only once the cloud shows the VM gone.
  const gone =
    (await deps.seed.status(clusterId, deps.region)).kind === 'absent';
  // The bucket-only path already ran the seed's cleanup; only DNS is left.
  if (gone && !flags.deleteVms) await removeDnsInto(deps, clusterId, report);
  else if (gone)
    await finish(deps, clusterId, { ...flags, deleteBuckets: false }, report);
  else report.remaining.push({ kind: 'dnsRecord', name: hostname(clusterId) });
  if (!deletesBucket) report.remaining.push(kept);
  return { outcome: 'destroyed', clusterId, finalBackup: null, ...report };
}

/**
 * `--skip-cloud`: deletes nothing in the cloud. The DNS record goes only once
 * the user's CLI shows the installation gone; without a CLI, it stays.
 */
export async function abandon(
  deps: SeedDeleteDependencies | null,
  clusterId: string,
): Promise<DeleteReport> {
  const dns: DeleteEntry = { kind: 'dnsRecord', name: hostname(clusterId) };
  const report = (removed: boolean): DeleteReport => ({
    outcome: 'abandoned',
    clusterId,
    finalBackup: null,
    deleted: removed ? [dns] : [],
    remaining: removed ? [] : [dns],
  });
  if (!deps) return report(false);
  const status = await deps.seed
    .status(clusterId, deps.region)
    .catch(() => null);
  if (status?.kind === 'deployed') {
    throw new DeleteRefusedError(
      status.stopped ? 'MANAGEMENT_VM_STOPPED' : 'MANAGEMENT_VM_RUNNING',
      `The management VM of cluster ${clusterId} still exists; --skip-cloud runs only once it is gone (delete with --delete-vms)`,
    );
  }
  if (status?.kind !== 'absent') return report(false);
  const removed = await deps.removeDns(clusterId).then(
    () => true,
    () => false,
  );
  return report(removed);
}
