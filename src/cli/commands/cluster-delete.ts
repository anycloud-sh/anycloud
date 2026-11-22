import { Command } from 'commander';
import { ORPCError } from '@orpc/client';
import { apiClient, getGitHubToken } from '../services/auth.js';
import {
  deleteDNSRecordBySubdomain,
  removeApiTls,
} from '../../shared/dns-worker.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { networkErrorCode } from '../../shared/services/api-client/rpc.js';
import { sleep } from '../../shared/utils.js';
import { seedFor } from '../seed/registry.js';
import { SEED_CLOUDS, type SeedCloud } from '../seed/types.js';
import {
  abandon,
  deleteThroughApi,
  deleteWithoutApi,
  DeleteRefusedError,
  type DeleteEntry,
  type DeleteReport,
  type SeedDeleteDependencies,
} from '../services/seed-delete.js';
import {
  printError,
  printInfo,
  printSuccess,
  printWarning,
  setJsonMode,
} from '../utils/output.js';
import { safePrompts, shouldAllowPrompts } from '../utils/safe-prompts.js';

interface DeleteOptions {
  json?: boolean;
  cloud?: string;
  region?: string;
  checkpointBucket?: string;
  deleteVms?: boolean;
  deleteBuckets?: boolean;
  skipCloud?: boolean;
  confirm?: string;
}

/** A refusal or failure with a stable code; `--json` prints it as the document. */
class DeleteFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeleteFailedError';
  }
}

/** Cloudflare's answer with no origin behind it (520 to 530), or another proxy 5xx. */
function edgeError(error: unknown): boolean {
  return error instanceof ORPCError && !error.defined && error.status >= 500;
}

/** Node's and Bun's codes for a refused, reset or unresolved connection, or a failed TLS handshake. */
const NO_CONNECTION =
  /^(ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_\w+|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_\w+|Connection\w+|FailedToOpenSocket|ERR_TLS_\w+|ERR_SSL_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;

/**
 * No answer from the API: the edge's 5xx, a refused or reset connection, a
 * DNS or TLS failure, or a timeout (Bun says `Unable to connect`). A
 * declared refusal, or any other answer, means the API is there.
 */
export function unreachable(error: unknown): boolean {
  if (error instanceof ORPCError) return edgeError(error);
  if (!(error instanceof Error)) return false;
  const code = networkErrorCode(error);
  return (
    error.name === 'TimeoutError' ||
    error.message.includes('fetch failed') ||
    error.message.includes('Unable to connect') ||
    (code !== undefined && NO_CONNECTION.test(code))
  );
}

const RETRY_BUDGET_MS = 30_000;

/**
 * A call through Cloudflare, retried with backoff on the edge's 5xx (520 to
 * 524 while the origin blinks) for about 30 s before it counts as unreachable.
 * A failed connection isn't retried: with no DNS record or no origin, waiting
 * only delays the fallback.
 */
export async function answering<T>(
  call: () => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let spent = 0;
  for (let delay = 1_000; ; delay = Math.min(delay * 2, 8_000)) {
    try {
      return await call();
    } catch (error) {
      if (!edgeError(error) || spent >= RETRY_BUDGET_MS) throw error;
      await wait(delay);
      spent += delay;
    }
  }
}

/** The cluster's own hostname answering `ok`; a gone origin's proxy 5xx doesn't count. */
async function hostedApiAnswers(clusterId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${clusterId}.anycloud.sh/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok && (await response.text()).trim() === 'ok';
  } catch {
    return false;
  }
}

/** Typed cluster ID in a terminal, or `--confirm` without one; `--yes` never confirms. */
function confirmer(clusterId: string, options: DeleteOptions) {
  return async (warning: string) => {
    const matches = (value: unknown) =>
      typeof value === 'string' && value.trim() === clusterId;
    if (matches(options.confirm)) return;
    if (
      options.confirm !== undefined ||
      options.json ||
      !shouldAllowPrompts()
    ) {
      throw new DeleteFailedError(
        'CONFIRMATION_REQUIRED',
        options.confirm === undefined
          ? `${warning} Pass --confirm ${clusterId} to confirm without a terminal.`
          : `--confirm ${options.confirm} does not match cluster ${clusterId}`,
      );
    }
    printWarning(warning);
    const { typed } = await safePrompts({
      type: 'text',
      name: 'typed',
      message: 'Type the cluster ID to confirm',
    });
    if (!matches(typed)) {
      throw new DeleteFailedError(
        'CONFIRMATION_REQUIRED',
        `The typed value does not match cluster ${clusterId}; nothing was deleted.`,
      );
    }
  };
}

function seedCloud(value: string | undefined): SeedCloud | null {
  if (value === undefined) return null;
  const cloud = SEED_CLOUDS.find((entry) => entry === value.toLowerCase());
  if (!cloud) {
    throw new DeleteFailedError(
      'INVALID_ARGUMENT',
      `--cloud must be one of ${SEED_CLOUDS.join(', ')}`,
    );
  }
  return cloud;
}

function dependencies(
  cloud: SeedCloud,
  region: string,
  clusterId: string,
  options: DeleteOptions,
  githubToken: string,
): SeedDeleteDependencies {
  const seed = seedFor(cloud);
  return {
    seed,
    region,
    confirm: confirmer(clusterId, options),
    removeDns: async (id) => {
      await removeApiTls(id, githubToken);
      await deleteDNSRecordBySubdomain(id, githubToken);
    },
    sleep,
    now: () => Date.now(),
    log: (message) => printInfo(message),
  };
}

function line(entry: DeleteEntry): string {
  switch (entry.kind) {
    case 'managementVm':
      return `management VM ${entry.id}${entry.stopped ? ' (stopped)' : ''}`;
    case 'cloudResource':
      return `${entry.type} ${entry.id}${entry.location ? ` (${entry.location})` : ''}${entry.selector ? `: search for ${entry.selector}` : ''}${entry.reason ? ` (${entry.reason})` : ''}${entry.error ? `: ${entry.error}` : ''}`;
    case 'dnsRecord':
      return `DNS record and certificate ${entry.name}`;
    case 'checkpointBucket':
      return `checkpoint bucket ${entry.name}${entry.managed ? '' : ' (supplied, never deleted)'}`;
  }
}

function print(report: DeleteReport): void {
  const { clusterId, outcome } = report;
  if (outcome === 'abandoned') {
    printSuccess(
      `Cluster ${clusterId} abandoned: no cloud resources were deleted.`,
    );
  } else if (outcome === 'planned') {
    printInfo(
      `The hosted API of cluster ${clusterId} is unreachable; nothing was deleted.`,
    );
  } else {
    printSuccess(`Cluster ${clusterId} deleted.`);
  }
  if (report.finalBackup === 'failed') {
    printWarning(
      'Its final backup failed; the kept bucket holds the newest earlier one.',
    );
  }
  for (const entry of report.deleted) printInfo(`Deleted ${line(entry)}`);
  for (const entry of report.remaining) printInfo(`Remaining ${line(entry)}`);
  const stopped = report.remaining.some(
    (entry) => entry.kind === 'managementVm' && entry.stopped,
  );
  for (const entry of report.remaining) {
    if (entry.kind !== 'checkpointBucket' || stopped) continue;
    if (entry.restoreCommand)
      printInfo(`Restore with: ${entry.restoreCommand}`);
    if (entry.deleteCommand)
      printInfo(`Delete it with: ${entry.deleteCommand}`);
  }
  if (outcome === 'planned') {
    printInfo(
      stopped
        ? 'Its management VM is stopped: start it to bring the API back (Azure), or delete with --delete-vms.'
        : 'Delete with --delete-vms and --delete-buckets, or forget the cluster with --skip-cloud.',
    );
  }
}

async function run(
  identifier: string,
  options: DeleteOptions,
): Promise<DeleteReport> {
  if (options.skipCloud && (options.deleteVms || options.deleteBuckets)) {
    throw new DeleteFailedError(
      'INVALID_ARGUMENT',
      '--skip-cloud deletes nothing in the cloud; it cannot be combined with --delete-vms or --delete-buckets',
    );
  }
  const flags = {
    deleteVms: options.deleteVms === true,
    deleteBuckets: options.deleteBuckets === true,
    skipCloud: options.skipCloud === true,
    checkpointBucket: options.checkpointBucket,
  };
  const githubToken = await getGitHubToken();
  // A hosted API that never came up fails already in its token exchange.
  const reached = await answering(async () => {
    const api = await apiClient();
    const { cluster } = await api.clusters.get({ params: { id: identifier } });
    return { api, record: cluster };
  }).catch((error: unknown) => {
    if (unreachable(error)) return null;
    if (error instanceof ORPCError && error.code === 'CLUSTER_NOT_FOUND')
      return null;
    throw error;
  });

  if (reached) {
    const { api, record } = reached;
    if (flags.deleteVms || flags.skipCloud) {
      throw new DeleteFailedError(
        'API_REACHABLE',
        `The hosted API of cluster ${record.name} answers, so delete it normally: --delete-vms and --skip-cloud apply only once it is gone`,
      );
    }
    // Where it runs and its bucket, from the API itself.
    const { installation } = await answering(() =>
      api.systemRelease.selfDeleteStatus(),
    );
    if (installation.clusterId !== record.id) {
      throw new DeleteFailedError(
        'INVALID_ARGUMENT',
        `The active API runs cluster ${installation.clusterId}, not ${record.id}; select ${record.id}'s API with anycloud api use https://${record.id}.anycloud.sh`,
      );
    }
    return deleteThroughApi(
      dependencies(
        installation.cloud,
        installation.region,
        record.id,
        options,
        githubToken,
      ),
      {
        request: (clusterId, deleteBuckets) =>
          answering(() =>
            api.systemRelease.selfDelete({ clusterId, deleteBuckets }),
          ),
        status: () =>
          answering(() => api.systemRelease.selfDeleteStatus()).catch(
            (error: unknown) => {
              if (unreachable(error)) return null;
              throw error;
            },
          ),
      },
      flags,
    );
  }

  // With the hosted API gone, the cluster is found by its ID alone.
  if (!/-\d{13}-[a-z0-9]+$/.test(identifier)) {
    throw new DeleteFailedError(
      'INVALID_ARGUMENT',
      `No hosted API answers for ${identifier}; with it gone, delete takes the cluster ID (create printed it)`,
    );
  }
  if (await hostedApiAnswers(identifier)) {
    throw new DeleteFailedError(
      'API_REACHABLE',
      `The hosted API at https://${identifier}.anycloud.sh answers; select it with anycloud api use https://${identifier}.anycloud.sh and delete normally`,
    );
  }
  const cloud = seedCloud(options.cloud);
  if (flags.skipCloud) {
    await confirmer(
      identifier,
      options,
    )(
      `--skip-cloud forgets cluster ${identifier} without deleting its cloud resources.`,
    );
    return abandon(
      cloud && options.region
        ? dependencies(cloud, options.region, identifier, options, githubToken)
        : null,
      identifier,
    );
  }
  if (!cloud || !options.region) {
    throw new DeleteFailedError(
      'INVALID_ARGUMENT',
      'With the hosted API gone, pass --cloud and --region of the management VM',
    );
  }
  return deleteWithoutApi(
    dependencies(cloud, options.region, identifier, options, githubToken),
    identifier,
    flags,
  );
}

export function createApiDeleteCommand(): Command {
  return new Command('delete')
    .aliases(['terminate', 'rm'])
    .description(
      'Delete the installation through its hosted API, which deletes itself last; refused while running workloads remain',
    )
    .argument(
      '<id-or-name>',
      'Cluster ID or name (the ID when the hosted API is gone)',
    )
    .option('--json', 'Emit what was deleted and what remains as JSON')
    .option(
      '--delete-buckets',
      'Also delete the managed checkpoint bucket with every backup; ends any restore',
    )
    .option('--cloud <cloud>', 'With the hosted API gone: aws, gcp or azure')
    .option(
      '--region <region>',
      'With the hosted API gone: the management VM region',
    )
    .option(
      '--checkpoint-bucket <name>',
      'With the hosted API gone: a bucket you supplied at create',
    )
    .option(
      '--delete-vms',
      'With the hosted API gone: delete the stopped management VM, its network and the pool VMs',
    )
    .option(
      '--skip-cloud',
      'Forget a cluster whose cloud account is gone; deletes nothing in the cloud',
    )
    .option(
      '--confirm <cluster-id>',
      'Confirm a deletion without a terminal; --yes never confirms it',
    )
    .action(async (identifier: string, options: DeleteOptions) => {
      if (options.json) setJsonMode(true);
      try {
        const report = await run(identifier, options);
        if (options.json) console.log(JSON.stringify(report));
        else print(report);
      } catch (error) {
        const code =
          error instanceof DeleteFailedError ||
          error instanceof DeleteRefusedError ||
          (error instanceof ORPCError && error.defined)
            ? (error as { code: string }).code
            : 'UNEXPECTED';
        if (options.json) {
          console.log(
            JSON.stringify({ error: { code, message: errorMessage(error) } }),
          );
        } else {
          printError(`Failed to delete cluster: ${errorMessage(error)}`);
        }
        process.exit(code === 'INVALID_ARGUMENT' ? 2 : 1);
      }
    });
}
