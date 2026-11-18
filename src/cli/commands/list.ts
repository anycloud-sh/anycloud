import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import chalk from 'chalk';
import { resolveSessionScope } from '../session/detect.js';
import {
  printInfo,
  printError,
  createSpinner,
  setJsonMode,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';
import { resolveListWindow } from '../utils/list-window.js';
import {
  clampListLimit,
  DEFAULT_LIST_LIMIT,
} from '../../shared/workload-list.js';
import { type WorkloadListRow as StoredWorkload } from '../../shared/api-contract/workload-management-schemas.js';
import { WorkloadType } from '../../shared/workload.js';
import type { NodePoolSummary } from '../../shared/api-contract/node-pools-schemas.js';
import type { DeploymentSummary } from '../../shared/api-contract/deployments-schemas.js';
import {
  printDeploymentSummary,
  printNodePoolSummary,
} from '../utils/kubernetes-output.js';
import {
  SIGINT_EXIT_CODE,
  isInterrupted,
  runUntilInterrupted,
} from '../utils/interrupt.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  parseWatchInterval,
} from '../utils/watch.js';
import { pickFiltered, pickListView } from '../prompts/workload-list.js';
import {
  buildNodePoolDeploymentWatchLines,
  buildSummaryHeadingLines,
  buildWorkloadListOutput,
  creatorChoices,
  deploymentChoices,
  listViewChoices,
  nodePoolChoices,
  sessionChoices,
  workloadsToCsv,
  type WorkloadListRenderOptions,
} from '../renderers/workload-list.js';
import {
  LIST_WATCH_LABEL,
  fetchNodePoolDeploymentJobs,
  fetchWorkloadList,
  shouldPromptForView,
  validateListOptions,
  watchNodePoolDeploymentJobs,
  workloadListViews,
  workloadsForView,
  type ListOptions,
  type NodePoolDeploymentJobs,
  type NodePoolDeploymentSelection,
  type WorkloadListClient,
  type WorkloadListSelection,
} from '../use-cases/workload-list.js';

function printLines(lines: string[]): void {
  for (const line of lines) console.log(line);
}

function printWorkloadList(
  workloads: StoredWorkload[],
  options: WorkloadListRenderOptions,
): void {
  const { lines, notes } = buildWorkloadListOutput(workloads, options);
  printLines(lines);
  for (const note of notes) printInfo(note);
}

async function selectNodePoolAndDeployment(
  client: WorkloadListClient,
): Promise<NodePoolDeploymentSelection | undefined> {
  const spinner = createSpinner('Loading node pools...').start();
  let nodePools: NodePoolSummary[];
  try {
    ({ nodePools } = await client.nodePools.list());
  } finally {
    spinner.stop();
  }
  if (nodePools.length === 0) {
    printInfo('No node pools found.');
    return undefined;
  }
  const nodePoolId = await pickFiltered(
    'nodePool',
    'Select node pool',
    nodePoolChoices(nodePools),
  );
  const nodePool = nodePools.find((candidate) => candidate.id === nodePoolId);
  if (!nodePool) return undefined;

  const deploymentsSpinner = createSpinner('Loading Deployments...').start();
  let candidates: DeploymentSummary[];
  try {
    ({ deployments: candidates } = await client.deployments.list({
      query: { nodePool: nodePool.id },
    }));
  } finally {
    deploymentsSpinner.stop();
  }
  if (candidates.length === 0) {
    printInfo(`No Deployments found on node pool ${nodePool.name}.`);
    return undefined;
  }
  const deploymentId = await pickFiltered(
    'deployment',
    'Select Deployment',
    deploymentChoices(candidates),
  );
  const deployment = candidates.find(
    (candidate) => candidate.id === deploymentId,
  );
  if (!deployment) return undefined;
  return { nodePool, deployment };
}

function printNodePoolDeploymentJobs(view: NodePoolDeploymentJobs): void {
  console.log('');
  console.log(chalk.bold(`Node pool ${view.nodePool.name}`));
  printNodePoolSummary(view.nodePool);
  console.log('');
  console.log(chalk.bold(`Deployment ${view.deployment.name}`));
  printDeploymentSummary(view.deployment);
  if (view.workloads.length === 0) {
    console.log('');
    printInfo(`No Jobs found for Deployment ${view.deployment.name}.`);
    return;
  }
  printWorkloadList(view.workloads, {
    effectiveCap: DEFAULT_LIST_LIMIT,
    heading: 'Jobs',
    showStateCounts: true,
    deploymentId: view.deployment.id,
  });
}

async function printNodePoolDeploymentSnapshot(
  client: WorkloadListClient,
  selection: NodePoolDeploymentSelection,
): Promise<void> {
  const spinner = createSpinner(
    'Loading node pool, Deployment, and Jobs...',
  ).start();
  let view: NodePoolDeploymentJobs;
  try {
    view = await fetchNodePoolDeploymentJobs(client, selection);
  } finally {
    spinner.stop();
  }
  printNodePoolDeploymentJobs(view);
}

export function createListCommand(workloadType?: WorkloadType): Command {
  const invocation = workloadType
    ? `anycloud ${workloadType} list`
    : 'anycloud list';
  const supportsDeployments =
    workloadType === undefined || workloadType === WorkloadType.Job;
  const typeExamples =
    workloadType === undefined
      ? `
  $ anycloud list --type service        # only service workloads
  $ anycloud list --type vm             # only VMs`
      : '';
  const deploymentExamples = supportsDeployments
    ? `
  $ ${invocation} --deployment deployment-id -n 400 # Jobs for one Deployment
  $ ${invocation} --watch               # pick a node pool and Deployment, then refresh Jobs`
    : '';
  const command = new Command('list')
    .alias('ls')
    .description(
      workloadType
        ? `List ${workloadType === WorkloadType.Vm ? 'VMs' : `${workloadType}s`}`
        : '📋 List all workloads',
    );
  if (workloadType === undefined) {
    command.option(
      '--type <type>',
      'Only workloads of this type (job, service, or vm)',
    );
  }
  if (supportsDeployments) {
    command
      .option('--deployment <id>', 'Only Jobs targeting this Deployment ID')
      .option(
        '-w, --watch',
        'Pick a node pool and Deployment, then refresh its Jobs until interrupted',
      )
      .option(
        '--interval <seconds>',
        `Polling interval for --watch (default ${DEFAULT_WATCH_INTERVAL_SECONDS}s)`,
      );
  }
  return command
    .option(
      '-f, --filter <text>',
      'Filter by id, type, image, Deployment, cloud, region, state, session, or agent',
    )
    .option('--status <state>', 'Only workloads with this state (exact match)')
    .option('--credentials <name>', 'Only workloads using these credentials')
    .option(
      '--user <github-user>',
      'Only workloads created by this GitHub username or account ID',
    )
    .option(
      '--session <id>',
      'Match a session: exact id, id prefix, label, or the displayed agent:hash',
    )
    .option(
      '--agent <name>',
      'Only workloads from this agent (claude, codex, cursor, aider, …)',
    )
    .option(
      '-p, --period <window>',
      'Only workloads started within this window (e.g. 24h, 7d, 30d)',
    )
    .option('-n, --limit <count>', 'Max workloads to show, newest first')
    .option('--json', 'Emit workloads array as compact JSON')
    .option('--csv', 'Emit workloads as CSV (header + one row per workload)')
    .option('--only-ids', 'Emit just workload IDs, one per line')
    .addHelpText(
      'after',
      `
Examples:
  $ ${invocation}                       # most recent workloads
  $ ${invocation} -p 7d                 # only the last 7 days
  $ ${invocation} -n 500                # newest 500
  $ ${invocation} -f nginx              # substring filter (id/type/image/cloud/region/state)
  $ ${invocation} --status running      # exact state match
  $ ${invocation} --credentials prod-aws # filter by named credentials${typeExamples}${deploymentExamples}
  $ ${invocation} --json                # compact JSON for agents
  $ ${invocation} --csv                 # CSV for piping into spreadsheets / awk
  $ ${invocation} --only-ids            # one ID per line
`,
    )
    .action(async (options: ListOptions) => {
      try {
        const parent = command.parent;
        if (workloadType && parent) {
          const misplaced = parent.options.filter(
            (option) =>
              parent.getOptionValueSource(option.attributeName()) === 'cli',
          );
          if (misplaced.length > 0) {
            throw new Error(
              `Options before list apply to launching a workload: ${misplaced.map((option) => option.long ?? option.short).join(', ')}. Put listing options after '${invocation}'. See '${invocation} --help'.`,
            );
          }
        }
        const interactive =
          shouldAllowPrompts() && process.stdout.isTTY === true;
        const { type } = validateListOptions(options, {
          workloadType,
          interactive,
        });
        const intervalSeconds = parseWatchInterval(options.interval);
        const machineMode = !!(options.json || options.csv || options.onlyIds);
        if (machineMode) setJsonMode(true);

        // Validate the window flags before auth so a bad value fails fast.
        const { limit, sinceMs } = resolveListWindow({
          period: options.period,
          limit: options.limit,
        });
        const effectiveCap = clampListLimit(limit, DEFAULT_LIST_LIMIT);
        const client = await apiClient();

        if (options.watch) {
          const selection = await selectNodePoolAndDeployment(client);
          if (!selection) return;
          await runUntilInterrupted(LIST_WATCH_LABEL, (signal) =>
            watchNodePoolDeploymentJobs(client, selection, {
              intervalSeconds,
              signal,
              onView: (view) => {
                process.stdout.write('\x1b[2J\x1b[H');
                console.log(
                  buildNodePoolDeploymentWatchLines(view, {
                    rows: process.stdout.rows,
                    columns: process.stdout.columns,
                  }).join('\n'),
                );
              },
            }),
          );
          return;
        }

        // Pin non-interactive agent invocations to their own session unless an
        // explicit attribution filter was provided.
        const scope = resolveSessionScope({
          session: options.session,
          agent: options.agent,
        });
        const promptForView = shouldPromptForView(options, {
          workloadType,
          interactive,
          machineMode,
          autoScoped: scope.autoScoped,
        });

        const spinner = createSpinner('Loading workloads...').start();
        let workloads: StoredWorkload[];
        try {
          workloads = await fetchWorkloadList(client, {
            options,
            type,
            limit,
            sinceMs,
            scope,
          });
        } finally {
          spinner.stop();
        }

        if (scope.autoScoped && !machineMode) {
          printInfo('Scoped to your session.');
        }
        if (options.filter && workloads.length === 0 && !machineMode) {
          printInfo(`No workloads matching "${options.filter}".`);
          return;
        }
        if (options.onlyIds) {
          for (const workload of workloads) console.log(workload.id);
          return;
        }
        if (options.csv) {
          console.log(workloadsToCsv(workloads));
          return;
        }
        if (options.json) {
          // Ownership is request-relative rendering metadata, not durable
          // workload output. Keep the established JSON array shape clean.
          console.log(
            JSON.stringify(
              workloads.map(
                ({ isOwnedByCaller: _isOwnedByCaller, ...workload }) =>
                  workload,
              ),
            ),
          );
          return;
        }
        if (workloads.length === 0 && !promptForView) {
          printInfo('No workloads found.');
          return;
        }
        if (promptForView && workloads.length > 0) {
          printLines(buildSummaryHeadingLines(workloads));
        }
        let displayedWorkloads = workloads;
        if (promptForView) {
          const views = workloadListViews(workloads);
          console.log('');
          const view = await pickListView(listViewChoices(views));
          if (view === undefined) return;
          if (view === '__node_pools__') {
            const selected = await selectNodePoolAndDeployment(client);
            if (!selected) return;
            await printNodePoolDeploymentSnapshot(client, selected);
            return;
          }
          let selection: WorkloadListSelection;
          if (view === '__users__') {
            const userId = await pickFiltered(
              'creator',
              'Select user',
              creatorChoices(views.creators),
            );
            if (userId === undefined) return;
            selection = { userId };
          } else if (view === '__sessions__') {
            const session = await pickFiltered(
              'session',
              'Select session',
              sessionChoices(views.sessions),
            );
            if (session === undefined) return;
            selection = { session };
          } else {
            selection = view;
          }
          displayedWorkloads = workloadsForView(workloads, selection);
        }

        if (displayedWorkloads.length === 0) {
          printInfo('No workloads found.');
          return;
        }
        printWorkloadList(displayedWorkloads, {
          effectiveCap,
          fetchedCount: workloads.length,
          layoutWorkloads: workloads,
          showHeading: !promptForView,
          showStateCounts: !promptForView,
        });
      } catch (error) {
        if (isInterrupted(error)) {
          process.exitCode = SIGINT_EXIT_CODE;
          return;
        }
        printError(`Failed to list workloads: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
