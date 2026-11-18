import { Command, InvalidArgumentError } from 'commander';
import { parseGithubAppIds } from '../../shared/hosted-api.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { runSeedCreate, SeedCreateError } from '../seed/create.js';
import { seedFor } from '../seed/registry.js';
import {
  SEED_CLOUDS,
  SeedUnavailableError,
  seedCloudType,
  type SeedCloud,
} from '../seed/types.js';
import { getGitHubToken } from '../services/auth.js';
import { gitHubUser } from '../services/oauth.js';
import { apiClient } from '../services/auth.js';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';
import { formatColumns } from '../renderers/table.js';
import type { ClusterSummary } from '../../shared/api-contract/clusters-schemas.js';
import { WorkloadState } from '../../shared/workload.js';
import { DELETE_FAILED_PREFIX } from '../../shared/clusters.js';
import {
  SIGINT_EXIT_CODE,
  isInterrupted,
  runUntilInterrupted,
} from '../utils/interrupt.js';
import { getRegionsForVMType } from '../../shared/cloud-config.js';
import { bootstrapCatalogsWithUI } from '../utils/catalog-bootstrap.js';
import { safePrompts, shouldAllowPrompts } from '../utils/safe-prompts.js';
import { pickRegion, pickVmTypeTarget } from '../services/target-picker.js';
import {
  formatLocation,
  printError,
  printInfo,
  printSuccess,
  setJsonMode,
} from '../utils/output.js';
import {
  clusterApiVersion,
  formatClusterState,
  printClusterSummary,
} from '../utils/cluster-output.js';
import { formatAge } from '../utils/duration.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  parseWatchInterval,
  watchUntil,
} from '../utils/watch.js';
import {
  NOT_RUN_EXIT_CODE,
  LIFECYCLE_EXIT_HELP,
  UsageError,
  exitWithLifecycleError,
  withLifecycleUsageExit,
} from '../utils/lifecycle-result.js';

interface JsonOptions {
  json?: boolean;
}

interface StatusOptions extends JsonOptions {
  watch?: boolean;
  interval?: string;
}

interface CreateOptions extends JsonOptions {
  cloud?: string;
  region?: string;
  zone?: string;
  vmType?: string;
  checkpointBucket?: string;
  signInApps?: number[];
}

/** Done once creation or deletion settles: running, failed, or fully terminated. */
function clusterSettled(cluster: ClusterSummary): boolean {
  return (
    cluster.state === WorkloadState.Running ||
    cluster.state === WorkloadState.Failed ||
    (cluster.state === WorkloadState.Terminated && !cluster.releasing)
  );
}

/** Polls the cluster, printing each state change, until it settles. */
async function watchCluster(
  api: ApiClient,
  id: string,
  options: {
    intervalSeconds: number;
    timeoutSeconds?: number;
    json?: boolean;
    signal?: AbortSignal;
  },
): Promise<ClusterSummary> {
  const deadline =
    options.timeoutSeconds === undefined
      ? Infinity
      : Date.now() + options.timeoutSeconds * 1000;
  let shown: string | null = null;
  const cluster = await watchUntil(
    async () => (await api.clusters.get({ params: { id } })).cluster,
    {
      intervalSeconds: options.intervalSeconds,
      signal: options.signal,
      done: (read) => clusterSettled(read) || Date.now() > deadline,
      onRead: (read) => {
        if (options.json) {
          console.log(JSON.stringify(read));
          return;
        }
        const state = formatClusterState(read);
        if (state === shown) return;
        shown = state;
        printInfo(`[${new Date().toLocaleTimeString()}] ${state}`);
      },
    },
  );
  if (!clusterSettled(cluster)) {
    throw new Error(
      `Timed out after ${options.timeoutSeconds}s waiting for the cluster; check it with: anycloud cluster status ${id} --watch`,
    );
  }
  return cluster;
}

function printJson(value: unknown): void {
  setJsonMode(true);
  console.log(JSON.stringify(value));
}

interface ManagementVmTarget {
  vmType: string;
  region: string;
}

/** `--cloud`, or in a terminal a pick among the clouds whose CLI is signed in. */
async function resolveCloud(options: CreateOptions): Promise<SeedCloud> {
  if (options.cloud) {
    const cloud = SEED_CLOUDS.find((entry) => entry === options.cloud);
    if (!cloud) throw new UsageError('--cloud must be aws, gcp or azure');
    return cloud;
  }
  if (options.json || !shouldAllowPrompts()) {
    throw new UsageError(
      'pass --cloud aws|gcp|azure, or run in a terminal to pick it',
    );
  }
  const signedIn = (
    await Promise.all(
      // A cloud this build has no seed for counts as not signed in.
      SEED_CLOUDS.map(async (cloud) =>
        (await Promise.resolve()
          .then(() => seedFor(cloud).discoverAccount())
          .then(() => true)
          .catch(() => false))
          ? cloud
          : null,
      ),
    )
  ).filter((cloud): cloud is SeedCloud => cloud !== null);
  if (signedIn.length === 0) {
    throw new SeedUnavailableError(
      'No aws, gcloud or az on this machine is signed in; sign in to one (aws sso login, gcloud auth login, az login) and retry',
    );
  }
  if (signedIn.length === 1) return signedIn[0]!;
  const { cloud } = await safePrompts<'cloud'>({
    type: 'select',
    name: 'cloud',
    message: 'Cloud for the management VM',
    choices: signedIn.map((entry) => ({ title: entry, value: entry })),
  });
  if (!cloud) process.exit(0);
  return cloud as SeedCloud;
}

/**
 * Picks whichever of the VM type and region the flags left out, offering
 * only regions that have the VM type. Without a terminal, or with --json, it
 * names the missing flags instead.
 */
async function resolveManagementVmTarget(
  options: CreateOptions,
  cloud: SeedCloud,
): Promise<ManagementVmTarget> {
  const { vmType, region } = options;
  // A picked region could not match the zone.
  if (options.zone && !region) throw new UsageError('--zone requires --region');
  if (vmType && region) return { vmType, region };
  if (options.json || !shouldAllowPrompts()) {
    const missing = [!vmType && '--vm-type', !region && '--region'].filter(
      Boolean,
    );
    throw new UsageError(
      `pass ${missing.join(', ')}, or run in a terminal to pick ${missing.length === 1 ? 'it' : 'them'}`,
    );
  }
  await bootstrapCatalogsWithUI();
  const catalog = seedCloudType(cloud);
  const pickedVmType = vmType ?? (await pickVmTypeTarget(catalog)).vmType;
  if (region) return { vmType: pickedVmType, region };
  const regions = getRegionsForVMType(pickedVmType, catalog);
  if (regions.length === 0) {
    throw new UsageError(
      `no ${cloud} region in the catalog offers ${pickedVmType}; pass --region`,
    );
  }
  return { vmType: pickedVmType, region: await pickRegion(regions) };
}

/** Create's own `--json` codes, inside the lifecycle contract (exit 1). */
function seedErrorCode(error: unknown): string | undefined {
  if (error instanceof SeedCreateError) return error.code;
  if (error instanceof SeedUnavailableError) return 'CLOUD_CLI_UNAVAILABLE';
  return undefined;
}

/** `api create`: a new hosted API on its own management VM. */
export function createApiCreateCommand(): Command {
  return withLifecycleUsageExit(new Command('create'))
    .description(
      'Create a management VM, start Kubernetes on it and install the API system release',
    )
    .argument('<name>', 'Cluster name')
    .option(
      '--cloud <cloud>',
      "aws, gcp or azure: create through that cloud's own CLI (aws, gcloud, az), signed in on this machine (picked when omitted)",
    )
    .option(
      '--region <region>',
      'Cloud region for the management VM (picked when omitted)',
    )
    .option('--zone <zone>', 'Availability zone (provider format)')
    .option(
      '--vm-type <type>',
      'VM type for the management VM (picked when omitted)',
    )
    .option(
      '--checkpoint-bucket <name>',
      "Existing bucket you own for the hosted API state (database backups), in the cloud CLI's account; without it Anycloud creates and manages one named after the cluster",
    )
    .option(
      '--sign-in-apps <ids>',
      'Comma-separated GitHub App ids whose user tokens the API exchanges for its own, like an `anycloud login` sign-in',
      (list: string) => {
        try {
          return parseGithubAppIds(list);
        } catch (error) {
          throw new InvalidArgumentError(errorMessage(error));
        }
      },
    )
    .option('--json', 'Emit the cluster, or the error, as JSON')
    .addHelpText(
      'after',
      `
Create drives the cloud's own CLI (aws, gcloud or az), signed in on this
machine, to start one management VM, which brings up Kubernetes and the API
itself. It needs no Docker and stores nothing here, and returns once the API
answers at https://<id>.anycloud.sh and its first backup has landed.
Re-running create with the same name resumes it.
${LIFECYCLE_EXIT_HELP} Create's own codes are CLOUD_CLI_UNAVAILABLE,
CLOUD_RIGHTS_MISSING, RESTORE_REFUSED, FIRST_BACKUP_FAILED and API_NOT_READY
(exit 1).

Examples:
  $ anycloud api create production
  $ anycloud api create production --cloud aws --region us-east-1 --vm-type t3.medium
  $ anycloud api create production --cloud gcp --region us-central1 --vm-type e2-standard-2 --checkpoint-bucket my-api-state
`,
    )
    .action(async (name: string, options: CreateOptions) => {
      try {
        // With --json the progress lines go to stderr from the start, so the
        // JSON document is the only thing on stdout.
        if (options.json) setJsonMode(true);
        name = name.trim();
        if (!name || name.length > 64) {
          throw new UsageError('the cluster name must be 1 to 64 characters');
        }
        const cloud = await resolveCloud(options);
        const target = await resolveManagementVmTarget(options, cloud);
        const seed = seedFor(cloud);
        const githubToken = await getGitHubToken(NOT_RUN_EXIT_CODE);
        const cluster = await runSeedCreate({
          seed,
          name,
          region: target.region,
          zone: options.zone ?? null,
          vmType: target.vmType,
          checkpointBucket: options.checkpointBucket ?? null,
          githubToken,
          owner: await gitHubUser(githubToken),
          githubAppIds: options.signInApps ?? [],
          version: packageJson.version,
          hostedApi: (apiUrl) => apiClient({ apiUrl }),
          progress: (message) =>
            printInfo(`[${new Date().toLocaleTimeString()}] ${message}`),
        });
        if (options.json) {
          printJson(cluster);
          return;
        }
        printSuccess(`Cluster ${cluster.name} is running.`);
        if (cluster.managementApiUrl) {
          printInfo(`Next: anycloud api use ${cluster.managementApiUrl}`);
        }
      } catch (error) {
        exitWithLifecycleError(
          'Failed to create cluster',
          error,
          options.json,
          seedErrorCode,
        );
      }
    });
}

/** The `cluster list` table; the e2e hosted stage reads its rows. */
export function formatClusterList(clusters: readonly ClusterSummary[]): string {
  const rows = clusters.map((cluster) => [
    cluster.name,
    cluster.id,
    cluster.cloudProvider
      ? formatLocation(cluster.cloudProvider, cluster.region)
      : '',
    cluster.vmType ?? '',
    formatAge(cluster.createdAt),
    cluster.address ?? '',
    clusterApiVersion(cluster) ?? '',
    formatClusterState(cluster, true),
  ]);
  const head = ['NAME', 'ID', 'LOCATION', 'VM TYPE', 'AGE', 'ADDRESS', 'API'];
  return formatColumns([[...head, 'STATE'], ...rows]).join('\n');
}

function createListCommand(): Command {
  return new Command('list')
    .aliases(['ls', 'get'])
    .description('List the clusters this API knows')
    .option('--json', 'Emit clusters as JSON')
    .action(async (options: JsonOptions) => {
      try {
        const api = await apiClient();
        const { clusters } = await api.clusters.list();
        if (options.json) {
          printJson(clusters);
          return;
        }
        console.log(formatClusterList(clusters));
      } catch (error) {
        printError(`Failed to list clusters: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

function createStatusCommand(): Command {
  return new Command('status')
    .alias('describe')
    .description('Show the cluster: state, release, API URL and last error')
    .argument('<id-or-name>', 'Cluster ID or name')
    .option(
      '-w, --watch',
      'Refresh until the cluster is running, failed or gone',
    )
    .option(
      '--interval <seconds>',
      `Polling interval for --watch (default ${DEFAULT_WATCH_INTERVAL_SECONDS}s)`,
    )
    .option('--json', 'Emit the cluster as JSON')
    .action(async (identifier: string, options: StatusOptions) => {
      try {
        const api = await apiClient();
        const cluster = options.watch
          ? await runUntilInterrupted('cluster status --watch', (signal) =>
              watchCluster(api, identifier, {
                intervalSeconds: parseWatchInterval(options.interval),
                json: options.json,
                signal,
              }),
            )
          : (
              await api.clusters.get({
                params: { id: identifier },
              })
            ).cluster;
        if (options.json) {
          if (!options.watch) printJson(cluster);
          return;
        }
        printClusterSummary(cluster);
        if (
          cluster.state === WorkloadState.Running &&
          cluster.managementApiUrl
        ) {
          printInfo(`Next: anycloud api use ${cluster.managementApiUrl}`);
        }
        if (cluster.state === WorkloadState.Failed && cluster.cloudProvider) {
          printInfo(
            cluster.lastError?.startsWith(DELETE_FAILED_PREFIX)
              ? `Finish it with: anycloud api delete ${cluster.name}`
              : `Resume with: anycloud api create ${cluster.name} ..., or remove it with: anycloud api delete ${cluster.name}`,
          );
        }
      } catch (error) {
        if (isInterrupted(error)) {
          process.exitCode = SIGINT_EXIT_CODE;
          return;
        }
        printError(`Failed to get cluster: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

/** The `cluster` surface: inspect hosted APIs' clusters (`api create` makes one). */
export function createClusterCommand(): Command {
  const cluster = new Command('cluster').description(
    "☸️  Inspect hosted APIs' clusters (create and delete them with anycloud api)",
  );
  cluster.addCommand(createListCommand());
  cluster.addCommand(createStatusCommand());
  return cluster;
}
