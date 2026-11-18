import chalk from 'chalk';
import { formatColumns } from './table.js';
import { MAX_LIST_LIMIT } from '../../shared/workload-list.js';
import { workloadTypeLabel } from '../../shared/workload-behavior.js';
import { type WorkloadListRow as StoredWorkload } from '../../shared/api-contract/workload-management-schemas.js';
import {
  stateEmoji,
  WorkloadState,
  WorkloadType,
  isReleasingResources,
  isTerminalState,
} from '../../shared/workload.js';
import { DEFAULT_DISK_TIER } from '../../shared/cloud-config.js';
import { formatSessionDisplay } from '../../shared/session-display.js';
import type { NodePoolSummary } from '../../shared/api-contract/node-pools-schemas.js';
import type { DeploymentSummary } from '../../shared/api-contract/deployments-schemas.js';
import { formatAge } from '../utils/duration.js';
import { RELEASING_LABELS } from '../utils/releasing.js';
import {
  formatDeploymentJobs,
  formatDeploymentState,
} from '../utils/kubernetes-output.js';
import {
  stateCountsFor,
  type CreatorGroup,
  type ListView,
  type NodePoolDeploymentJobs,
  type SessionGroup,
  type WorkloadListViews,
} from '../use-cases/workload-list.js';

interface Choice<V = string> {
  title: string;
  value: V;
}

/**
 * Render a session for display: the human-readable session label (e.g. the
 * Claude Code session title) when present, else `<agent>:<6-char hash>` when an
 * agent is known and the session is longer than 12 chars, else the raw session
 * id. Pure display — never used as a filter key.
 */
function prettySession(workload: StoredWorkload): string {
  return formatSessionDisplay(workload) ?? '-';
}

const CSV_COLUMNS = [
  'id',
  'user',
  'state',
  'cloudProvider',
  'region',
  'vmType',
  'image',
  'spot',
  'startedAt',
  'completedAt',
  'totalCost',
  'workloadType',
] as const;

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = Array.isArray(value) ? value.join(';') : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toIso(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  return new Date(ms).toISOString();
}

export function workloadsToCsv(workloads: StoredWorkload[]): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const d of workloads) {
    lines.push(
      [
        csvField(d.id),
        csvField(d.userId),
        csvField(d.state),
        csvField(d.cloudProvider),
        csvField(d.region),
        csvField(d.vmType),
        csvField(d.image),
        csvField(d.spot),
        csvField(toIso(d.startedAt)),
        csvField(toIso(d.completedAt)),
        csvField(d.totalCost),
        csvField(d.workloadType),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function workloadTypeSummary(workloads: StoredWorkload[]): string {
  const jobCount = workloads.filter(
    (d) => d.workloadType === WorkloadType.Job,
  ).length;
  const serviceCount = workloads.filter(
    (d) => d.workloadType === WorkloadType.Service,
  ).length;
  const vmCount = workloads.filter(
    (d) => d.workloadType === WorkloadType.Vm,
  ).length;
  const parts: string[] = [];
  if (jobCount > 0) parts.push(pluralize(jobCount, 'job'));
  if (serviceCount > 0) parts.push(pluralize(serviceCount, 'service'));
  if (vmCount > 0) parts.push(pluralize(vmCount, 'VM'));
  return parts.length > 0
    ? parts.join(', ')
    : pluralize(workloads.length, 'workload');
}

export function buildSummaryHeadingLines(
  workloads: StoredWorkload[],
  heading = 'Summary',
): string[] {
  return ['', chalk.bold(`${heading} (${workloadTypeSummary(workloads)})`)];
}

export function listViewChoices(views: WorkloadListViews): Choice<ListView>[] {
  const choices: Choice<ListView>[] = [];
  if (views.creators.length > 0) {
    choices.push({
      title: `👤 by user (${views.creators.length})`,
      value: '__users__',
    });
  }
  if (views.sessions.length > 0) {
    choices.push({
      title: `🤖 by session (${views.sessions.length})`,
      value: '__sessions__',
    });
  }
  choices.push({ title: '☸️ by node pool', value: '__node_pools__' });

  for (const [state, count] of Array.from(views.stateCounts.entries())) {
    const emoji = stateEmoji[state as keyof typeof stateEmoji] || '❓';
    choices.push({
      title: `${emoji} ${state} (${count})`,
      value: state as WorkloadState,
    });
  }

  choices.push({
    title: `📋 all (${views.total})`,
    value: '__all__',
  });
  return choices;
}

export function creatorChoices(creators: CreatorGroup[]): Choice[] {
  const widest = Math.max(
    ...creators.map((creator) => creator.username.length),
    7,
  );
  return creators.map((creator) => ({
    title: `${creator.username.padEnd(widest)}  (${creator.count})`,
    value: creator.username,
  }));
}

export function sessionChoices(sessions: SessionGroup[]): Choice[] {
  const widest = Math.max(
    ...sessions.map((session) => session.displayForm.length),
    7,
  );
  return sessions.map((session) => ({
    title: `${session.displayForm.padEnd(widest)}  (${session.count})`,
    value: session.session,
  }));
}

function formatNodePoolState(nodePool: NodePoolSummary): string {
  return `${nodePool.state}${nodePool.releasing ? RELEASING_LABELS.stateCompact : ''}`;
}

function formatNodePoolCapacity(nodePool: NodePoolSummary): string {
  return `${nodePool.capacity.readyVmCount}/${nodePool.maxVmCount} ready`;
}

export function nodePoolChoices(nodePools: NodePoolSummary[]): Choice[] {
  const nameWidth = Math.max(
    ...nodePools.map((nodePool) => nodePool.name.length),
  );
  const idWidth = Math.max(...nodePools.map((nodePool) => nodePool.id.length));
  return nodePools.map((nodePool) => ({
    title: `${nodePool.name.padEnd(nameWidth)}  ${nodePool.id.padEnd(idWidth)}  ${formatNodePoolState(nodePool)}  ${formatNodePoolCapacity(nodePool)}`,
    value: nodePool.id,
  }));
}

export function deploymentChoices(candidates: DeploymentSummary[]): Choice[] {
  const nameWidth = Math.max(
    ...candidates.map((deployment) => deployment.name.length),
  );
  const idWidth = Math.max(
    ...candidates.map((deployment) => deployment.id.length),
  );
  return candidates.map((deployment) => ({
    title:
      `${deployment.name.padEnd(nameWidth)}  ${deployment.id.padEnd(idWidth)}  ` +
      `${deployment.image}  Jobs: ${formatDeploymentJobs(deployment)}, ${deployment.jobs.queued} queued`,
    value: deployment.id,
  }));
}

export interface WorkloadListRenderOptions {
  effectiveCap: number;
  fetchedCount?: number;
  heading?: string;
  layoutWorkloads?: StoredWorkload[];
  showHeading?: boolean;
  showStateCounts?: boolean;
  deploymentId?: string;
}

/**
 * The workload table: `lines` for stdout, then `notes` for the command's info
 * channel (the count and any truncation hint).
 */
export function buildWorkloadListOutput(
  workloads: StoredWorkload[],
  options: WorkloadListRenderOptions,
): { lines: string[]; notes: string[] } {
  const lines: string[] = [];
  const notes: string[] = [];
  const layoutWorkloads = options.layoutWorkloads ?? workloads;
  const getTarget = (workload: StoredWorkload) => {
    if (workload.deploymentId !== null)
      return `Deployment ${workload.deploymentId}`;
    let name = workload.image ?? '';
    if (name.includes('/')) name = name.split('/').pop() || name;
    return name;
  };
  const getLocation = (workload: StoredWorkload) =>
    workload.nodePoolId
      ? `${workload.cloudProvider ?? '-'} / ${workload.nodePoolName ?? workload.nodePoolId}`
      : workload.cloudProvider || '-';
  const renderType = (workload: StoredWorkload): string => {
    const raw = workload.gpuType || workload.vmType || '-';
    return Array.isArray(raw) ? raw.join(', ') : raw;
  };
  const renderDiskTier = (workload: StoredWorkload) =>
    workload.diskTier && workload.diskTier !== DEFAULT_DISK_TIER
      ? workload.diskTier
      : '-';
  const renderCreator = (workload: StoredWorkload) => workload.userId || '-';

  const showSession = layoutWorkloads.some((workload) => workload.session);
  const targetHeader = layoutWorkloads.some(
    (workload) => workload.deploymentId !== null,
  )
    ? 'IMAGE / DEPLOYMENT'
    : 'IMAGE';
  const showDiskTier = layoutWorkloads.some(
    (workload) => renderDiskTier(workload) !== '-',
  );
  // Name creators whenever this exact page includes someone else's work,
  // even if that teammate is the page's only creator.
  const showCreator =
    layoutWorkloads.some((workload) => workload.isOwnedByCaller === false) ||
    new Set(layoutWorkloads.map(renderCreator)).size > 1;
  const cols = {
    id:
      Math.max(...layoutWorkloads.map((workload) => workload.id.length), 2) + 2,
    type:
      Math.max(
        ...layoutWorkloads.map(
          (workload) => workloadTypeLabel(workload.workloadType).length,
        ),
        4,
      ) + 2,
    image:
      Math.max(
        ...layoutWorkloads.map((workload) => getTarget(workload).length),
        targetHeader.length,
      ) + 2,
    location:
      Math.max(
        ...layoutWorkloads.map((workload) => getLocation(workload).length),
        8,
      ) + 2,
    vmType:
      Math.max(
        ...layoutWorkloads.map((workload) => renderType(workload).length),
        7,
      ) + 2,
    age: 6,
    vm: 4,
    diskTier: showDiskTier
      ? Math.max(
          ...layoutWorkloads.map((workload) => renderDiskTier(workload).length),
          4,
        ) + 2
      : 0,
    session: showSession
      ? Math.max(
          ...layoutWorkloads.map((workload) => prettySession(workload).length),
          7,
        ) + 2
      : 0,
    creator: showCreator
      ? Math.max(
          ...layoutWorkloads.map((workload) => renderCreator(workload).length),
          4,
        ) + 2
      : 0,
  };

  if (options.showHeading !== false) {
    lines.push(...buildSummaryHeadingLines(workloads, options.heading));
  }
  if (options.showStateCounts) {
    for (const [state, count] of stateCountsFor(workloads)) {
      const emoji = stateEmoji[state as keyof typeof stateEmoji] || '❓';
      lines.push(`  ${emoji} ${state} (${count})`);
    }
  }

  const sessionHeader = showSession ? 'SESSION'.padEnd(cols.session) : '';
  const diskTierHeader = showDiskTier ? 'DISK'.padEnd(cols.diskTier) : '';
  const creatorHeader = showCreator ? 'USER'.padEnd(cols.creator) : '';
  lines.push('');
  lines.push(
    chalk.cyan(
      `${'ID'.padEnd(cols.id)}${'TYPE'.padEnd(cols.type)}${targetHeader.padEnd(cols.image)}${'LOCATION'.padEnd(cols.location)}${'VM TYPE'.padEnd(cols.vmType)}${'AGE'.padEnd(cols.age)}${'VM'.padEnd(cols.vm)}${diskTierHeader}${creatorHeader}${sessionHeader}STATE`,
    ),
  );
  for (const workload of workloads) {
    const emoji = stateEmoji[workload.state] || '❓';
    const blockSuffix =
      (workload.state === WorkloadState.Queued ||
        workload.state === WorkloadState.Retrying) &&
      workload.latestMessage
        ? chalk.dim(` — ${workload.latestMessage}`)
        : isReleasingResources(workload)
          ? chalk.yellow(RELEASING_LABELS.stateCompact)
          : '';
    lines.push(
      `${workload.id.padEnd(cols.id)}` +
        `${workloadTypeLabel(workload.workloadType).padEnd(cols.type)}` +
        `${getTarget(workload).padEnd(cols.image)}` +
        `${getLocation(workload).padEnd(cols.location)}` +
        `${renderType(workload).padEnd(cols.vmType)}` +
        `${formatAge(workload.startedAt).padEnd(cols.age)}` +
        `${String(workload.vmCount ?? '?').padEnd(cols.vm)}` +
        `${showDiskTier ? renderDiskTier(workload).padEnd(cols.diskTier) : ''}` +
        `${showCreator ? renderCreator(workload).padEnd(cols.creator) : ''}` +
        `${showSession ? prettySession(workload).padEnd(cols.session) : ''}` +
        `${workload.state} ${emoji}${blockSuffix}`,
    );
  }
  lines.push('');
  notes.push(`${workloads.length} workload(s)`);

  const fetchedCount = options.fetchedCount ?? workloads.length;
  if (fetchedCount === options.effectiveCap) {
    if (options.deploymentId) {
      const command = `anycloud job list --deployment ${options.deploymentId}`;
      const next =
        options.effectiveCap < MAX_LIST_LIMIT
          ? `${command} -n ${Math.min(options.effectiveCap * 2, MAX_LIST_LIMIT)}`
          : `${command} -p 7d`;
      notes.push(
        `Showing the newest ${options.effectiveCap} Jobs. ${options.effectiveCap < MAX_LIST_LIMIT ? 'List more' : 'Narrow the history'} with: ${next}`,
      );
      return { lines, notes };
    }
    const raise =
      options.effectiveCap < MAX_LIST_LIMIT
        ? ` or raise with -n (max ${MAX_LIST_LIMIT})`
        : '';
    notes.push(
      `Showing the newest ${options.effectiveCap} — narrow with -p / --status / -f${raise}.`,
    );
  }
  return { lines, notes };
}

/** One watch frame sized to the terminal; the command passes stdout's size. */
export function buildNodePoolDeploymentWatchLines(
  view: NodePoolDeploymentJobs,
  size: { rows?: number; columns?: number },
): string[] {
  // Leave room for the final newline and avoid the terminal's right margin.
  const height = Math.max(1, (size.rows || 24) - 1);
  const width = Math.max(1, (size.columns || 80) - 1);
  const { nodePool, deployment, workloads } = view;
  if (height < 8 || width < 40) {
    return formatColumns(
      [['Enlarge the terminal to view Jobs.'], ['Ctrl-C to stop']],
      [width],
    ).slice(0, height);
  }

  const summary = [
    `Node pool: ${formatNodePoolState(nodePool)}, ${formatNodePoolCapacity(nodePool)} | ${nodePool.name}`,
    `Deployment: ${formatDeploymentState(deployment) || 'unknown'}, Jobs ${formatDeploymentJobs(deployment)} | ${deployment.name}`,
    `Jobs: ${deployment.jobs.running} running, ${deployment.jobs.queued} queued, ${deployment.jobs.retrying} retrying, ${deployment.jobs.terminal} terminal`,
  ];
  if (nodePool.lastError) {
    summary.push(`Node pool error: ${nodePool.lastError}`);
  }
  if (deployment.workload?.pendingReason)
    summary.push(`Pending: ${deployment.workload.pendingReason}`);

  const active = workloads.filter(
    (workload) => !isTerminalState(workload.state),
  );
  const terminal = workloads.filter((workload) =>
    isTerminalState(workload.state),
  );
  const visible = [...active, ...terminal].slice(
    0,
    height - summary.length - 3,
  );
  const hiddenActive = Math.max(0, active.length - visible.length);
  const hiddenTerminal =
    terminal.length - Math.max(0, visible.length - active.length);
  const showCreator =
    workloads.some((workload) => workload.isOwnedByCaller === false) ||
    new Set(workloads.map((workload) => workload.userId)).size > 1;
  const creatorWidth = showCreator ? Math.min(18, Math.floor(width / 4)) : 0;
  const tableRows = [
    ['ID', 'STATE', 'AGE', ...(showCreator ? ['USER'] : [])],
    ...visible.map((workload) => [
      workload.id,
      workload.state,
      formatAge(workload.startedAt),
      ...(showCreator ? [workload.userId || '-'] : []),
    ]),
  ];
  return [
    ...formatColumns(
      summary.map((line) => [line]),
      [width],
    ),
    ...formatColumns(tableRows, [
      width - 20 - creatorWidth,
      13,
      7,
      ...(showCreator ? [creatorWidth] : []),
    ]),
    ...formatColumns(
      [
        [
          `Showing ${visible.length}/${workloads.length} fetched Jobs; Ctrl-C to stop`,
        ],
        [`Hidden: ${hiddenActive} active, ${hiddenTerminal} terminal`],
      ],
      [width],
    ),
  ];
}
