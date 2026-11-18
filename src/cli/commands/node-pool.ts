import { runWait } from './wait.js';
import { apiClient } from '../services/auth.js';
import { Command, InvalidArgumentError, Option } from 'commander';
import { DISK_TIER_VALUES, type DiskTier } from '../../shared/cloud.js';
import { formatColumns } from '../renderers/table.js';
import type { CreateNodePoolRequest } from '../../shared/api-contract/node-pools-schemas.js';
import {
  formatLocation,
  printError,
  printInfo,
  printSuccess,
  setJsonMode,
} from '../utils/output.js';
import { printNodePoolSummary } from '../utils/kubernetes-output.js';
import { warnPrivilegedDeprecated } from './shared.js';
import { RELEASING_LABELS } from '../utils/releasing.js';
import {
  NOT_RUN_EXIT_CODE,
  LIFECYCLE_EXIT_HELP,
  exitWithLifecycleError,
  withLifecycleUsageExit,
} from '../utils/lifecycle-result.js';

interface JsonOptions {
  json?: boolean;
}

interface CreateOptions extends JsonOptions {
  cluster?: string;
  credentials: string;
  region?: string;
  zone?: string;
  vmType: string[];
  minVms: number;
  maxVms: number;
  diskSize?: number;
  diskTier?: DiskTier;
  spot?: boolean;
  allowPrivilegedJobs?: boolean;
  userNamespaceJobs?: boolean;
  requireNestedVirtualization?: boolean;
  wait?: boolean;
}

interface ListOptions extends JsonOptions {
  cluster?: string;
}

function parseVmCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('expected a non-negative integer');
  }
  return parsed;
}

function parseOsDiskSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function printJson(value: unknown): void {
  setJsonMode(true);
  console.log(JSON.stringify(value));
}

function createCreateCommand(): Command {
  return withLifecycleUsageExit(new Command('create'))
    .description('Create a cloud-specific VM node pool in the cluster')
    .argument('<name>', 'Node pool name')
    .option(
      '--cluster <id-or-name>',
      'Cluster; optional, the installation has one',
    )
    .requiredOption('--credentials <name>', 'Compute credentials name')
    .option(
      '--region <region>',
      "Pin the pool to a cloud region (default: each VM launches in a catalog region, the cluster's first)",
    )
    .option('--zone <zone>', 'Cloud zone within --region')
    .requiredOption(
      '--vm-type <type>',
      'Node pool VM type. Repeatable for an ordered fallback list; every type must share one GPU kind and count.',
      (value: string, previous: string[] | undefined) => [
        ...(previous ?? []),
        value,
      ],
    )
    .requiredOption(
      '--min-vms <count>',
      'Fewest node pool VMs, 0 or more; idle VMs above it are removed',
      parseVmCount,
    )
    .requiredOption(
      '--max-vms <count>',
      'Most node pool VMs; Pending pool Pods buy VMs up to it',
      parseVmCount,
    )
    .option(
      '--disk-size <gb>',
      "Each VM's OS disk size in GB (default: the provider's)",
      parseOsDiskSize,
    )
    .addOption(
      new Option('--disk-tier <tier>', "Each VM's OS disk tier").choices(
        DISK_TIER_VALUES,
      ),
    )
    .option(
      '--spot',
      'Launch spot VMs (default: on-demand); an evicted VM is deleted and replaced',
    )
    .option(
      '--allow-privileged-jobs',
      'Deprecated, removed in the next release: use --user-namespace-jobs. Let Jobs on this pool use --privileged and --bind. A privileged Job is root on its Node and can read the GitHub login token, which grants anycloud access, of everyone whose Job, Deployment or Service runs there; use such a pool only from one dedicated GitHub account',
    )
    .option(
      '--user-namespace-jobs',
      'Run every Job on this pool as root of its own user namespace, for container engines, image builds and nested clusters; CPU VM types only. With --require-nested-virtualization, those Jobs get /dev/kvm',
    )
    .option(
      '--require-nested-virtualization',
      "Keep only the VM types the catalog reports as supporting nested virtualization (KVM) in the pool's region, and launch them with it on",
    )
    .option('--json', 'Emit the node pool, or the error, as JSON')
    .option(
      '--wait',
      'Wait until the node pool is ready; exits like anycloud wait',
    )
    .addHelpText(
      'after',
      `
Re-running create with the same name and settings answers with that node pool;
other settings are refused with NODE_POOL_ALREADY_EXISTS. With --wait and
--json, the wait's records follow the node pool, one per line.
${LIFECYCLE_EXIT_HELP} With --wait, 4 the timeout elapsed.
`,
    )
    .action(async (name: string, options: CreateOptions) => {
      try {
        if (options.json) setJsonMode(true);
        const api = await apiClient({ missingExitCode: NOT_RUN_EXIT_CODE });
        if (options.allowPrivilegedJobs) {
          warnPrivilegedDeprecated('--allow-privileged-jobs');
        }
        const request: CreateNodePoolRequest = {
          name,
          ...(options.cluster ? { cluster: options.cluster } : {}),
          credentialName: options.credentials,
          ...(options.region ? { region: options.region } : {}),
          ...(options.zone ? { zone: options.zone } : {}),
          vmTypes: options.vmType,
          minVmCount: options.minVms,
          maxVmCount: options.maxVms,
          ...(options.diskSize !== undefined
            ? { osDiskSizeGb: options.diskSize }
            : {}),
          ...(options.diskTier ? { osDiskTier: options.diskTier } : {}),
          ...(options.spot ? { spot: true } : {}),
          ...(options.allowPrivilegedJobs ? { allowPrivilegedJobs: true } : {}),
          ...(options.userNamespaceJobs ? { userNamespaceJobs: true } : {}),
          ...(options.requireNestedVirtualization
            ? { requireNestedVirtualization: true }
            : {}),
        };
        const { nodePool } = await api.nodePools.create(request);
        if (options.json) printJson(nodePool);
        else {
          printSuccess(`Node pool ${nodePool.name} creation started.`);
          printNodePoolSummary(nodePool);
        }
        if (options.wait) {
          process.exitCode = await runWait(
            [{ kind: 'node-pool', id: nodePool.id }],
            { json: options.json },
          );
        }
      } catch (error) {
        exitWithLifecycleError(
          'Failed to create node pool',
          error,
          options.json,
        );
      }
    });
}

function createListCommand(): Command {
  return new Command('list')
    .aliases(['ls', 'get'])
    .description('List node pools')
    .option('--cluster <id-or-name>', 'Only node pools in this cluster')
    .option('--json', 'Emit node pools as JSON')
    .action(async (options: ListOptions) => {
      try {
        const api = await apiClient();
        const { nodePools } = await api.nodePools.list(
          options.cluster ? { query: { cluster: options.cluster } } : undefined,
        );
        if (options.json) {
          printJson(nodePools);
          return;
        }
        const rows = nodePools.map((nodePool) => [
          nodePool.name,
          nodePool.id,
          nodePool.clusterId,
          formatLocation(
            nodePool.cloudProvider,
            nodePool.region ?? 'any region',
          ),
          nodePool.vmTypes.join(', '),
          `${nodePool.capacity.readyVmCount}/${nodePool.maxVmCount}`,
          `${nodePool.state}${nodePool.releasing ? RELEASING_LABELS.stateCompact : ''}`,
        ]);
        const head = ['NAME', 'ID', 'CLUSTER', 'LOCATION', 'VM TYPES', 'READY'];
        console.log(formatColumns([[...head, 'STATE'], ...rows]).join('\n'));
      } catch (error) {
        printError(`Failed to list node pools: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

function createStatusCommand(): Command {
  return new Command('status')
    .alias('describe')
    .description('Show node pool status')
    .argument('<id-or-name>', 'Node pool ID or name')
    .option('--json', 'Emit the node pool as JSON')
    .action(async (identifier: string, options: JsonOptions) => {
      try {
        const api = await apiClient();
        const { nodePool } = await api.nodePools.get({
          params: { id: identifier },
        });
        if (options.json) {
          printJson(nodePool);
          return;
        }
        printNodePoolSummary(nodePool);
      } catch (error) {
        printError(`Failed to get node pool: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

function createDeleteCommand(): Command {
  return withLifecycleUsageExit(new Command('delete'))
    .aliases(['terminate', 'rm'])
    .description(
      'Delete a node pool after the Deployments and Workloads targeting it are gone',
    )
    .argument('<id-or-name>', 'Node pool ID or name')
    .option('--json', 'Emit the node pool, or the error, as JSON')
    .addHelpText(
      'after',
      `
Delete returns once deletion is recorded; the node pool reports releasing until
its VMs are gone. Re-running it, by ID or name, answers with the same node
pool, terminated once it is gone.
${LIFECYCLE_EXIT_HELP}
`,
    )
    .action(async (identifier: string, options: JsonOptions) => {
      try {
        if (options.json) setJsonMode(true);
        const { nodePool } = await (
          await apiClient({ missingExitCode: NOT_RUN_EXIT_CODE })
        ).nodePools.delete({ params: { id: identifier } });
        if (options.json) {
          printJson(nodePool);
          return;
        }
        if (!nodePool.releasing) {
          printSuccess(`Node pool ${nodePool.name} is terminated.`);
        } else {
          printSuccess(`Node pool ${nodePool.name} deletion started.`);
        }
        printInfo(`ID: ${nodePool.id}`);
      } catch (error) {
        exitWithLifecycleError(
          'Failed to delete node pool',
          error,
          options.json,
        );
      }
    });
}

export function createNodePoolCommand(): Command {
  const nodePool = new Command('node-pool').description(
    '📍 Create and manage VM node pools across clouds',
  );
  nodePool.addCommand(createCreateCommand());
  nodePool.addCommand(createListCommand());
  nodePool.addCommand(createStatusCommand());
  nodePool.addCommand(createDeleteCommand());
  return nodePool;
}
