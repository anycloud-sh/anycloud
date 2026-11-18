import type { ApiClient } from '../../shared/services/api-client/rpc.js';
import type { SessionScope } from '../session/detect.js';
import { type WorkloadListRow as StoredWorkload } from '../../shared/api-contract/workload-management-schemas.js';
import { WorkloadState, WorkloadType } from '../../shared/workload.js';
import { formatSessionDisplay } from '../../shared/session-display.js';

export interface WorkloadListClient {
  workloads: Pick<ApiClient['workloads'], 'list'>;
}

export interface ListOptions {
  filter?: string;
  status?: string;
  type?: string;
  credentials?: string;
  user?: string;
  session?: string;
  agent?: string;
  period?: string;
  limit?: string;
  json?: boolean;
  csv?: boolean;
  onlyIds?: boolean;
}

/** A distinct agent session present in a workload set, for the picker. */
export interface SessionGroup {
  session: string;
  displayForm: string;
  count: number;
  latest: number;
}

/**
 * Distinct agent sessions in a workload set (rows with no session skipped),
 * each with its display label and count, most-recently-active first. Powers the
 * interactive "by session" picker.
 */
export function distinctSessions(workloads: StoredWorkload[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const d of workloads) {
    if (!d.session) continue;
    const existing = groups.get(d.session);
    if (existing) {
      existing.count++;
      if (d.startedAt > existing.latest) existing.latest = d.startedAt;
    } else {
      groups.set(d.session, {
        session: d.session,
        displayForm: formatSessionDisplay(d) ?? d.session,
        count: 1,
        latest: d.startedAt,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

/** A distinct creator present in a workload set, for the picker. */
export interface CreatorGroup {
  username: string;
  count: number;
  latest: number;
}

/**
 * Distinct creators in a workload set, most-recently-active first. Only
 * populated on a shared API; a solo API collapses to one entry and the picker
 * skips the view entirely.
 */
export function distinctCreators(workloads: StoredWorkload[]): CreatorGroup[] {
  const groups = new Map<string, CreatorGroup>();
  for (const d of workloads) {
    if (!d.userId) continue;
    const existing = groups.get(d.userId);
    if (existing) {
      existing.count++;
      if (d.startedAt > existing.latest) existing.latest = d.startedAt;
    } else {
      groups.set(d.userId, {
        username: d.userId,
        count: 1,
        latest: d.startedAt,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

export type ListView = '__all__' | '__sessions__' | '__users__' | WorkloadState;
/** What the picked view shows: everything, one state, one creator, or one session. */
export type WorkloadListSelection =
  | '__all__'
  | WorkloadState
  | { userId: string }
  | { session: string };

/** The views the interactive list offers for a fetched workload set. */
export interface WorkloadListViews {
  /** Offered as "by user" only when the listing spans two or more creators. */
  creators: CreatorGroup[];
  /** Offered as "by session" only when the listing spans two or more sessions. */
  sessions: SessionGroup[];
  stateCounts: Map<string, number>;
  total: number;
}

export function workloadListViews(
  workloads: StoredWorkload[],
): WorkloadListViews {
  const creators = distinctCreators(workloads);
  const sessions = distinctSessions(workloads);
  return {
    creators: creators.length >= 2 ? creators : [],
    sessions: sessions.length >= 2 ? sessions : [],
    stateCounts: stateCountsFor(workloads),
    total: workloads.length,
  };
}

type WorkloadTypeFilter = WorkloadType | 'job' | 'service' | 'vm';

function normalizeWorkloadTypeFilter(
  value: string | undefined,
): 'job' | 'service' | 'vm' | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'job' || normalized === 'service' || normalized === 'vm') {
    return normalized;
  }
  throw new Error('--type must be job, service, or vm');
}

export function stateCountsFor(
  workloads: StoredWorkload[],
): Map<string, number> {
  const stateCounts = new Map<string, number>();
  for (const d of workloads) {
    stateCounts.set(d.state, (stateCounts.get(d.state) || 0) + 1);
  }
  return stateCounts;
}

export function workloadsForView<T extends StoredWorkload>(
  workloads: T[],
  view: WorkloadListSelection,
): T[] {
  if (view === '__all__') return workloads;
  if (typeof view === 'object') {
    return 'userId' in view
      ? workloads.filter((d) => d.userId === view.userId)
      : workloads.filter((d) => d.session === view.session);
  }
  return workloads.filter((d) => d.state === view);
}

/**
 * Validate the list flags and resolve the workload type filter. Throws the
 * message the command reports.
 */
export function validateListOptions(
  options: ListOptions,
  context: { workloadType?: WorkloadType },
): { type: WorkloadTypeFilter | undefined } {
  const type =
    context.workloadType ?? normalizeWorkloadTypeFilter(options.type);
  return { type };
}

/** A bare, human, unscoped list opens the view picker instead of a table. */
export function shouldPromptForView(
  options: ListOptions,
  context: {
    workloadType?: WorkloadType;
    interactive: boolean;
    machineMode: boolean;
    autoScoped: boolean;
  },
): boolean {
  return (
    context.interactive &&
    !context.machineMode &&
    !context.autoScoped &&
    options.period === undefined &&
    options.limit === undefined &&
    options.filter === undefined &&
    options.status === undefined &&
    options.type === undefined &&
    context.workloadType === undefined &&
    options.credentials === undefined &&
    options.user === undefined &&
    options.session === undefined &&
    options.agent === undefined
  );
}

export function fetchWorkloadList(
  client: WorkloadListClient,
  input: {
    options: ListOptions;
    type: WorkloadTypeFilter | undefined;
    limit: number | undefined;
    sinceMs: number | undefined;
    scope: SessionScope;
  },
): Promise<StoredWorkload[]> {
  const { options, type, limit, sinceMs, scope } = input;
  return client.workloads.list({
    query: {
      limit: limit === undefined ? undefined : String(limit),
      sinceMs: sinceMs === undefined ? undefined : String(sinceMs),
      session: scope.session,
      // Auto-derived session is exact; typed --session remains fuzzy.
      sessionExact: scope.autoScoped ? ('true' as const) : undefined,
      agent: scope.agent,
      status: options.status,
      workloadType: type,
      credentialName: options.credentials,
      filter: options.filter,
      user: options.user,
    },
  });
}
