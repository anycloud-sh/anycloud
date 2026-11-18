import chalk from 'chalk';
import { MAX_LIST_LIMIT } from '../../shared/workload-list.js';
import { workloadTypeLabel } from '../../shared/workload-behavior.js';
import { type WorkloadListRow as StoredWorkload } from '../../shared/api-contract/workload-management-schemas.js';
import {
  stateEmoji,
  WorkloadState,
  WorkloadType,
  isReleasingResources,
} from '../../shared/workload.js';
import { DEFAULT_DISK_TIER } from '../../shared/cloud-config.js';
import { formatSessionDisplay } from '../../shared/session-display.js';
import { formatAge } from '../utils/duration.js';
import { RELEASING_LABELS } from '../utils/releasing.js';
import {
  stateCountsFor,
  type CreatorGroup,
  type ListView,
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

export interface WorkloadListRenderOptions {
  effectiveCap: number;
  fetchedCount?: number;
  heading?: string;
  layoutWorkloads?: StoredWorkload[];
  showHeading?: boolean;
  showStateCounts?: boolean;
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
    let name = workload.image ?? '';
    if (name.includes('/')) name = name.split('/').pop() || name;
    return name;
  };
  const getLocation = (workload: StoredWorkload) =>
    workload.cloudProvider || '-';
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
        'IMAGE'.length,
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
      `${'ID'.padEnd(cols.id)}${'TYPE'.padEnd(cols.type)}${'IMAGE'.padEnd(cols.image)}${'LOCATION'.padEnd(cols.location)}${'VM TYPE'.padEnd(cols.vmType)}${'AGE'.padEnd(cols.age)}${'VM'.padEnd(cols.vm)}${diskTierHeader}${creatorHeader}${sessionHeader}STATE`,
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
