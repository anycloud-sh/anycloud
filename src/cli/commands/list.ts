import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
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
import { SIGINT_EXIT_CODE, isInterrupted } from '../utils/interrupt.js';
import { pickFiltered, pickListView } from '../prompts/workload-list.js';
import {
  buildSummaryHeadingLines,
  buildWorkloadListOutput,
  creatorChoices,
  listViewChoices,
  sessionChoices,
  workloadsToCsv,
  type WorkloadListRenderOptions,
} from '../renderers/workload-list.js';
import {
  fetchWorkloadList,
  shouldPromptForView,
  validateListOptions,
  workloadListViews,
  workloadsForView,
  type ListOptions,
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

export function createListCommand(workloadType?: WorkloadType): Command {
  const invocation = workloadType
    ? `anycloud ${workloadType} list`
    : 'anycloud list';
  const typeExamples =
    workloadType === undefined
      ? `
  $ anycloud list --type service        # only service workloads
  $ anycloud list --type vm             # only VMs`
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
  return command
    .option(
      '-f, --filter <text>',
      'Filter by id, type, image, cloud, region, state, session, or agent',
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
  $ ${invocation} --credentials prod-aws # filter by named credentials${typeExamples}
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
        const { type } = validateListOptions(options, { workloadType });
        const machineMode = !!(options.json || options.csv || options.onlyIds);
        if (machineMode) setJsonMode(true);

        // Validate the window flags before auth so a bad value fails fast.
        const { limit, sinceMs } = resolveListWindow({
          period: options.period,
          limit: options.limit,
        });
        const effectiveCap = clampListLimit(limit, DEFAULT_LIST_LIMIT);
        const client = await apiClient();

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
