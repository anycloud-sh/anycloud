import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import chalk from 'chalk';
import { resolveSessionScope } from '../session/detect.js';
import {
  printError,
  printInfo,
  createSpinner,
  formatImageName,
  formatCurrency,
  setJsonMode,
} from '../utils/output.js';
import { formatDurationCompact } from '../utils/duration.js';
import { awaitingReleaseSuffix } from '../utils/releasing.js';
import {
  type WorkloadCostReport as CostReport,
  type WorkloadCostRow as CostRow,
} from '../../shared/api-contract/workload-management-schemas.js';
import {
  MAX_COST_REPORT_PERIOD_DAYS,
  MIN_COST_REPORT_PERIOD_DAYS,
} from '../../shared/workload-list.js';
import { workloadTypeLabel } from '../../shared/workload-behavior.js';

interface WorkloadTypeCounts {
  jobs: number;
  services: number;
  vms: number;
}

function formatWorkloadCounts({
  jobs,
  services,
  vms,
}: WorkloadTypeCounts): string {
  const parts: string[] = [];
  if (jobs > 0) {
    parts.push(`${formatNumber(jobs)} ${jobs === 1 ? 'job' : 'jobs'}`);
  }
  if (services > 0) {
    parts.push(
      `${formatNumber(services)} ${services === 1 ? 'service' : 'services'}`,
    );
  }
  if (vms > 0) {
    parts.push(`${formatNumber(vms)} ${vms === 1 ? 'VM' : 'VMs'}`);
  }
  return parts.length > 0 ? parts.join(', ') : '0 workloads';
}

/**
 * Parse a period string like "7d", "30d", "90d" into milliseconds. Throws on
 * anything else — there is no all-time period; pick an explicit day window.
 */
export function parsePeriod(period: string): number {
  const match = period.match(/^(\d+)d$/);
  const days = match ? Number(match[1]) : NaN;
  if (
    !Number.isSafeInteger(days) ||
    days < MIN_COST_REPORT_PERIOD_DAYS ||
    days > MAX_COST_REPORT_PERIOD_DAYS
  ) {
    throw new Error(
      `Invalid period "${period}". Use a whole number of days from ${MIN_COST_REPORT_PERIOD_DAYS}d to ${MAX_COST_REPORT_PERIOD_DAYS}d.`,
    );
  }
  return days * 24 * 60 * 60 * 1000;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function printSingleWorkload(workload: CostRow): void {
  const imageName =
    workload.image === null
      ? 'Deployment Job'
      : formatImageName(workload.image);
  console.log('');
  console.log(chalk.bold(`${workload.id} — ${imageName}`));
  console.log('');

  const lines: Array<[string, string]> = [];

  lines.push(['Type', workloadTypeLabel(workload.workloadType)]);

  let cloudLine: string = workload.cloudProvider || '-';
  if (workload.region) cloudLine += ` / ${workload.region}`;
  lines.push(['Cloud', cloudLine]);

  const vmLabel = Array.isArray(workload.vmType)
    ? workload.vmType.join(', ')
    : workload.vmType;
  let vmLine: string = vmLabel || '-';
  if (workload.spot) vmLine += ' (spot)';
  lines.push(['VM Type', vmLine]);

  const totalCost = workload.totalCost ?? 0;
  const durationMs = workload.vmDurationMs ?? 0;
  if (totalCost > 0 && durationMs > 0) {
    const durationHours = durationMs / (1000 * 60 * 60);
    const effectiveRate = totalCost / durationHours;
    const totalLabel = formatCurrency(totalCost);
    const estMarker =
      workload.costSource === 'estimated' ? chalk.dim(' (est.)') : '';
    lines.push(['Rate', `${formatCurrency(effectiveRate)}/hr`]);
    lines.push([
      'Duration',
      `${formatDurationCompact(durationMs)}${awaitingReleaseSuffix(
        workload.awaitingReleaseMs,
      )}`,
    ]);
    lines.push(['Total', `${chalk.bold(totalLabel)}${estMarker}`]);
  } else {
    lines.push(['Rate', chalk.dim('rate unavailable')]);
  }

  const maxLabelLen = Math.max(...lines.map(([label]) => label.length));
  lines.forEach(([label, value]) => {
    console.log(`  ${chalk.dim(label.padEnd(maxLabelLen))}  ${value}`);
  });

  console.log('');
  if (workload.spot) {
    printInfo('Spot cost estimated from catalog price at deploy time');
  }
}

function printAggregate(report: CostReport): void {
  const {
    periodMs,
    totalCost,
    totalDurationMs,
    totalJobs,
    totalServices,
    totalVms,
    workloadsWithoutPrice: withoutPrice,
    byProvider,
    byAgent,
    byUser,
    includesOtherUsers,
  } = report;

  console.log('');

  const periodLabel = periodMs
    ? `last ${formatPeriodLabel(periodMs)}`
    : 'all time';

  console.log(
    chalk.bold(
      `Estimated compute cost (${periodLabel}): ${formatCurrency(totalCost)}`,
    ),
  );
  console.log(
    chalk.dim(
      `  ${formatWorkloadCounts({ jobs: totalJobs, services: totalServices, vms: totalVms })}, ${formatDurationCompact(totalDurationMs)} total compute`,
    ),
  );
  console.log('');

  // Provider breakdown table
  const providers = Object.entries(byProvider).sort(
    ([, a], [, b]) => b.cost - a.cost,
  );

  if (providers.length > 0) {
    const costWidth = Math.max(
      ...providers.map(([, p]) => formatCurrency(p.cost).length),
      4,
    );

    console.log(
      chalk.cyan(
        `${'PROVIDER'.padEnd(12)}${'JOBS'.padEnd(8)}${'SERVICES'.padEnd(10)}${'VMS'.padEnd(8)}${'COMPUTE'.padEnd(12)}COST`,
      ),
    );

    for (const [provider, data] of providers) {
      const name = provider.padEnd(12);
      const jobs = formatNumber(data.jobs).padEnd(8);
      const services = formatNumber(data.services).padEnd(10);
      const vms = formatNumber(data.vms).padEnd(8);
      const duration = formatDurationCompact(data.durationMs).padEnd(12);
      const cost = formatCurrency(data.cost).padStart(costWidth);
      console.log(`${name}${jobs}${services}${vms}${duration}${cost}`);
    }
  }

  const agents = Object.entries(byAgent).sort(
    ([, a], [, b]) => b.cost - a.cost,
  );
  if (agents.length > 0) {
    const agentCostWidth = Math.max(
      ...agents.map(([, a]) => formatCurrency(a.cost).length),
      4,
    );
    console.log('');
    console.log(
      chalk.cyan(
        `${'AGENT'.padEnd(12)}${'JOBS'.padEnd(8)}${'SERVICES'.padEnd(10)}${'VMS'.padEnd(8)}${'COMPUTE'.padEnd(12)}COST`,
      ),
    );
    for (const [agent, data] of agents) {
      const name = agent.padEnd(12);
      const jobs = formatNumber(data.jobs).padEnd(8);
      const services = formatNumber(data.services).padEnd(10);
      const vms = formatNumber(data.vms).padEnd(8);
      const duration = formatDurationCompact(data.durationMs).padEnd(12);
      const cost = formatCurrency(data.cost).padStart(agentCostWidth);
      console.log(`${name}${jobs}${services}${vms}${duration}${cost}`);
    }
  }

  // A one-row table is still essential when that one row belongs to someone
  // else; without it a shared total looks like the caller's own spend.
  const users = Object.entries(byUser).sort(([, a], [, b]) => b.cost - a.cost);
  if (includesOtherUsers || users.length > 1) {
    const userNameWidth =
      Math.max(...users.map(([name]) => name.length), 8) + 2;
    const userCostWidth = Math.max(
      ...users.map(([, u]) => formatCurrency(u.cost).length),
      4,
    );
    console.log('');
    console.log(
      chalk.cyan(
        `${'USER'.padEnd(userNameWidth)}${'JOBS'.padEnd(8)}${'SERVICES'.padEnd(10)}${'VMS'.padEnd(8)}${'COMPUTE'.padEnd(12)}COST`,
      ),
    );
    for (const [user, data] of users) {
      const name = user.padEnd(userNameWidth);
      const jobs = formatNumber(data.jobs).padEnd(8);
      const services = formatNumber(data.services).padEnd(10);
      const vms = formatNumber(data.vms).padEnd(8);
      const duration = formatDurationCompact(data.durationMs).padEnd(12);
      const cost = formatCurrency(data.cost).padStart(userCostWidth);
      console.log(`${name}${jobs}${services}${vms}${duration}${cost}`);
    }
  }

  console.log('');
  if (Object.values(byProvider).some((p) => p.hasSpot)) {
    printInfo('Spot costs estimated from catalog price at deploy time');
  }
  if (withoutPrice > 0) {
    printInfo(
      `${formatNumber(withoutPrice)} workload(s) excluded (rate unavailable)`,
    );
  }
}

function formatPeriodLabel(ms: number): string {
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  return `${days} days`;
}

function singleWorkloadReport(workload: CostRow) {
  const totalCost = workload.totalCost ?? 0;
  const durationMs = workload.vmDurationMs ?? 0;
  const ratePerHour =
    totalCost > 0 && durationMs > 0
      ? totalCost / (durationMs / (1000 * 60 * 60))
      : null;
  return {
    id: workload.id,
    workloadType: workload.workloadType,
    image: workload.image,
    cloudProvider: workload.cloudProvider ?? null,
    region: workload.region ?? null,
    vmType: workload.vmType ?? null,
    spot: !!workload.spot,
    totalCost,
    costSource: workload.costSource ?? null,
    durationMs,
    awaitingReleaseMs: workload.awaitingReleaseMs ?? 0,
    ratePerHour,
  };
}

export function createCostCommand(): Command {
  return new Command('cost')
    .description('💰 Estimated compute costs')
    .argument('[id]', 'Show cost for a specific workload')
    .option('-p, --period <period>', 'Time period: 1d to 90d', '30d')
    .option(
      '--session <id>',
      'Match a session: exact id, id prefix, label, or the displayed agent:hash',
    )
    .option(
      '--agent <name>',
      'Only workloads from this agent (claude, codex, cursor, aider, …)',
    )
    .option(
      '--user <github-user>',
      'Only workloads created by this GitHub username or account ID',
    )
    .option('--json', 'Emit cost report as compact JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud cost                 # costs for last 30 days
  $ anycloud cost --period 7d    # costs for last 7 days
  $ anycloud cost <id>           # cost for a specific workload
  $ anycloud cost --agent claude # costs for claude's submits only
  $ anycloud cost --json         # machine-readable aggregate report
`,
    )
    .action(
      async (
        id?: string,
        options?: {
          period?: string;
          session?: string;
          agent?: string;
          user?: string;
          json?: boolean;
        },
      ) => {
        try {
          if (options?.json) setJsonMode(true);

          // Pin to the caller's own session when an agent invokes this
          // non-interactively (unless an explicit --session/--agent is passed),
          // so parallel agents don't see each other's workloads.
          const scope = resolveSessionScope({
            session: options?.session,
            agent: options?.agent,
          });

          // Aggregate requests tell the dedicated cost endpoint the real
          // reporting window. Exact-ID requests omit it and receive all-time
          // workload totals.
          const now = Date.now();
          const periodMs = id
            ? undefined
            : parsePeriod(options?.period ?? '30d');

          const api = await apiClient();
          const spinner = createSpinner('Loading workloads...').start();
          const commonQuery = {
            session: scope.session,
            // Auto-derived session is matched exactly; only a typed --session is fuzzy.
            sessionExact: scope.autoScoped ? ('true' as const) : undefined,
            agent: scope.agent,
            user: options?.user,
          };
          const hasId = id !== undefined;
          const client = api;
          const workloads = hasId
            ? await client.workloads.cost({
                params: { id },
                query: commonQuery,
              })
            : undefined;
          const aggregate = hasId
            ? undefined
            : await client.workloads.costReport({
                query: {
                  ...commonQuery,
                  sinceMs: String(now - (periodMs as number)),
                },
              });
          spinner.stop();

          if (scope.autoScoped && !options?.json) {
            printInfo(`Scoped to your session.`);
          }

          if (hasId) {
            if (options?.period && options.period !== '30d' && !options?.json) {
              printInfo('--period is ignored when viewing a single workload');
            }
            const workload = workloads?.find((d) => d.id === id);
            if (!workload) {
              printError(`Workload "${id}" not found.`);
              process.exit(1);
            }
            if (options?.json) {
              console.log(JSON.stringify(singleWorkloadReport(workload)));
            } else {
              printSingleWorkload(workload);
            }
          } else {
            // Preserve the CLI's exact requested duration in JSON; the API's
            // normalized window can differ by transport latency in milliseconds.
            const report: CostReport = {
              ...aggregate!,
              periodMs: periodMs as number,
            };
            if (options?.json) {
              const {
                includesOtherUsers: _includesOtherUsers,
                ...publicReport
              } = report;
              console.log(JSON.stringify(publicReport));
            } else {
              printAggregate(report);
            }
          }

          process.exit(0);
        } catch (error) {
          printError(`Failed to get costs: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
