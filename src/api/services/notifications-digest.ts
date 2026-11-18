/**
 * Daily notifications digest: yesterday's per-user workload activity and
 * compute spend, posted once per UTC day to the configured channels.
 */

import { log } from './logger.js';
import {
  getWorkloadQueryStore,
  getWorkloadSpendStore,
  getDeploymentStore,
  getNotificationsStore,
} from './persistence.js';
import {
  digestUserKey,
  type WorkloadTypeStarts,
  type UserWorkloadStarts,
} from './repositories/workload-spend.js';
import type { DeploymentDigestMetadata } from './deployment-store.js';
import { sendToNotifiers } from './notify.js';
import {
  formatDigestNotification,
  typeHasActivity,
  type DigestDeploymentInventory,
  type DigestDeploymentJobSummary,
  type DigestSummary,
  type DigestTypeSummary,
} from './notifications-digest-format.js';
import { foldLocalApiOwners } from './notifications-digest-owners.js';
import { loadNotifiers } from '../../shared/notifications/index.js';
import {
  WorkloadState,
  WorkloadType,
  type WorkloadTypeValue,
} from '../../shared/workload.js';

export const NOTIFICATIONS_DIGEST_INTERVAL_MS = 15 * 60_000; // 15 min

export async function runNotificationsDigestOnce(): Promise<void> {
  const config = await getNotificationsStore().loadConfig();
  const notifiers = loadNotifiers(config);
  if (notifiers.length === 0) {
    log.debug('No notification channels configured; skipping daily digest', {
      id: 'system',
    });
    return;
  }

  const yesterday = yesterdayUtcRange();
  const saved = await readDigestSentinel();
  if (saved === null) {
    // First run after notifications are configured: mark yesterday handled
    // so history from before the channel existed is not posted. The digest
    // reads the database, so the current day is reported in full at the next
    // UTC midnight.
    await writeDigestSentinel(yesterday.label);
    return;
  }
  if (saved >= yesterday.label) {
    log.debug('Daily digest already handled; skipping', {
      id: 'system',
      handledThrough: saved,
    });
    return;
  }

  const store = getWorkloadQueryStore();
  const rows = await store.listTerminalWorkloadsByDateRange(
    yesterday.startMs,
    yesterday.endMs,
  );
  const vmSpend = await getWorkloadSpendStore().sumVmSpendInWindow(
    yesterday.startMs,
    yesterday.endMs,
  );
  const starts = await getWorkloadSpendStore().summarizeWorkloadStartsInWindow(
    yesterday.startMs,
    yesterday.endMs,
  );
  const deployments = await getDeploymentStore().listDigestMetadataInWindow(
    yesterday.startMs,
    yesterday.endMs,
  );
  const { summary, spend } = foldLocalApiOwners(
    aggregateDigest(rows, starts, deployments),
    vmSpend,
  );
  // A long-running workload may not end yesterday while still accruing
  // compute spend, while a new submission or resubmission may not have a VM or
  // an end state yet. Gate on every kind of daily activity.
  if (
    !typeHasActivity(summary.jobs, spend.jobs) &&
    !typeHasActivity(summary.services, spend.services) &&
    !typeHasActivity(summary.vms, spend.vms) &&
    !summary.users.some((user) => user.deployments.hasActivity)
  ) {
    // Still mark the day as handled so we don't re-query every 15 min.
    await writeDigestSentinel(yesterday.label);
    return;
  }

  const message = formatDigestNotification(yesterday.label, summary, spend);

  const anySent = await sendToNotifiers(notifiers, message);
  if (anySent) await writeDigestSentinel(yesterday.label);
}

interface DigestOutcome {
  workloadType: WorkloadTypeValue;
  state: WorkloadState;
  startedAt: number;
  completedAt: number | null;
  userId: string;
  ownerUserId: string | null;
  deploymentId: string | null;
  wasPreempted: boolean;
}

export function aggregateDigest(
  rows: DigestOutcome[],
  starts: {
    jobs: WorkloadTypeStarts;
    services: WorkloadTypeStarts;
    vms: WorkloadTypeStarts;
    users: UserWorkloadStarts[];
  },
  deployments: DeploymentDigestMetadata[] = [],
): DigestSummary {
  const rowsByUser = new Map<string, typeof rows>();
  for (const row of rows) {
    const userKey = digestUserKey(row.ownerUserId, row.userId);
    const userRows = rowsByUser.get(userKey) ?? [];
    userRows.push(row);
    rowsByUser.set(userKey, userRows);
  }
  const startsByUser = new Map(
    starts.users.map((user) => [
      digestUserKey(user.ownerUserId, user.userId),
      user,
    ]),
  );
  const activeDeploymentIds = new Set<string>();
  for (const row of rows) {
    if (row.deploymentId !== null) activeDeploymentIds.add(row.deploymentId);
  }
  for (const user of starts.users) {
    for (const target of user.deploymentJobs) {
      activeDeploymentIds.add(target.deploymentId);
    }
  }
  const inventoryByUser = aggregateDeploymentInventory(
    deployments,
    activeDeploymentIds,
  );
  const deploymentsById = new Map(deployments.map((row) => [row.id, row]));
  const userIds = new Set([
    ...rowsByUser.keys(),
    ...startsByUser.keys(),
    ...inventoryByUser.keys(),
  ]);
  return {
    jobs: aggregateDigestType(
      rows.filter((r) => r.workloadType === WorkloadType.Job),
      starts.jobs,
    ),
    services: aggregateDigestType(
      rows.filter((r) => r.workloadType === WorkloadType.Service),
      starts.services,
    ),
    vms: aggregateDigestType(
      rows.filter((r) => r.workloadType === WorkloadType.Vm),
      starts.vms,
    ),
    users: [...userIds]
      .map((userKey) => {
        const userRows = rowsByUser.get(userKey) ?? [];
        const userStarts = startsByUser.get(userKey);
        const owner = inventoryByUser.get(userKey);
        return {
          userId:
            owner?.username ??
            userStarts?.userId ??
            userRows[0]?.userId ??
            `GitHub user ${userKey}`,
          ownerUserId:
            userStarts?.ownerUserId ??
            userRows[0]?.ownerUserId ??
            (owner ? userKey : null),
          jobs: aggregateDigestType(
            userRows.filter((row) => row.workloadType === WorkloadType.Job),
            userStarts?.jobs ?? emptyWorkloadTypeStarts(),
          ),
          services: aggregateDigestType(
            userRows.filter((row) => row.workloadType === WorkloadType.Service),
            userStarts?.services ?? emptyWorkloadTypeStarts(),
          ),
          vms: aggregateDigestType(
            userRows.filter((row) => row.workloadType === WorkloadType.Vm),
            userStarts?.vms ?? emptyWorkloadTypeStarts(),
          ),
          deployments: owner?.inventory ?? emptyDigestDeploymentInventory(),
          deploymentJobs: aggregateDeploymentJobs(
            userRows,
            userStarts?.deploymentJobs ?? [],
            deploymentsById,
          ),
        };
      })
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  };
}

function aggregateDeploymentInventory(
  deployments: DeploymentDigestMetadata[],
  activeDeploymentIds: Set<string>,
): Map<
  string,
  { username: string | null; inventory: DigestDeploymentInventory }
> {
  const owners = new Map<
    string,
    { username: string | null; inventory: DigestDeploymentInventory }
  >();
  for (const deployment of deployments) {
    let owner = owners.get(deployment.ownerUserId);
    if (!owner) {
      owner = {
        username: deployment.ownerUsername,
        inventory: emptyDigestDeploymentInventory(),
      };
      owners.set(deployment.ownerUserId, owner);
    }
    owner.inventory.presentAtEnd += Number(deployment.presentAtEnd);
    owner.inventory.created += Number(deployment.createdInWindow);
    owner.inventory.deleted += Number(deployment.deletedInWindow);
    owner.inventory.hasActivity ||=
      deployment.createdInWindow ||
      deployment.deletedInWindow ||
      deployment.hasVmUsage ||
      activeDeploymentIds.has(deployment.id);
  }
  return owners;
}

function aggregateDeploymentJobs(
  rows: DigestOutcome[],
  starts: UserWorkloadStarts['deploymentJobs'],
  deployments: Map<string, DeploymentDigestMetadata>,
): DigestDeploymentJobSummary[] {
  const rowsByDeployment = new Map<string, DigestOutcome[]>();
  for (const row of rows) {
    if (row.deploymentId === null) continue;
    const targetRows = rowsByDeployment.get(row.deploymentId) ?? [];
    targetRows.push(row);
    rowsByDeployment.set(row.deploymentId, targetRows);
  }
  const startsByDeployment = new Map(
    starts.map((target) => [target.deploymentId, target]),
  );
  const ids = new Set([
    ...rowsByDeployment.keys(),
    ...startsByDeployment.keys(),
  ]);
  return [...ids].map((deploymentId) => {
    const deployment = deployments.get(deploymentId);
    const targetStarts = startsByDeployment.get(deploymentId);
    return {
      ...aggregateDigestType(
        rowsByDeployment.get(deploymentId) ?? [],
        targetStarts ?? emptyWorkloadTypeStarts(),
      ),
      deploymentId,
      name: deployment?.name ?? deploymentId,
      nodePoolName: deployment?.nodePoolName ?? null,
    };
  });
}

function emptyWorkloadTypeStarts(): WorkloadTypeStarts {
  return { initialSubmissions: 0, resubmissions: 0 };
}

function aggregateDigestType(
  rows: Array<{
    state: WorkloadState;
    startedAt: number;
    completedAt: number | null;
    wasPreempted: boolean;
  }>,
  starts: WorkloadTypeStarts,
): DigestTypeSummary {
  const runtimes: number[] = [];
  let completed = 0,
    failed = 0,
    errored = 0,
    terminated = 0,
    invalid = 0,
    preempted = 0;
  for (const r of rows) {
    if (r.wasPreempted) preempted += 1;
    if (r.completedAt !== null) runtimes.push(r.completedAt - r.startedAt);
    if (r.state === WorkloadState.Completed) completed += 1;
    else if (r.state === WorkloadState.Failed) failed += 1;
    else if (r.state === WorkloadState.Errored) errored += 1;
    else if (r.state === WorkloadState.Terminated) terminated += 1;
    else if (r.state === WorkloadState.Invalid) invalid += 1;
  }
  return {
    ...starts,
    total: rows.length,
    completed,
    failed,
    errored,
    terminated,
    invalid,
    preempted,
    p50RuntimeMs: runtimes.length > 0 ? median(runtimes) : null,
  };
}

function emptyDigestDeploymentInventory(): DigestDeploymentInventory {
  return { presentAtEnd: 0, created: 0, deleted: 0, hasActivity: false };
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function yesterdayUtcRange(): {
  startMs: number;
  endMs: number;
  label: string;
} {
  const now = new Date();
  const endMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const startMs = endMs - 24 * 60 * 60 * 1000;
  const label = new Date(startMs).toISOString().slice(0, 10);
  return { startMs, endMs, label };
}

async function readDigestSentinel(): Promise<string | null> {
  try {
    return await getNotificationsStore().readReceipt('digest');
  } catch {
    return null;
  }
}

async function writeDigestSentinel(dateLabel: string): Promise<void> {
  try {
    await getNotificationsStore().writeReceipt('digest', dateLabel);
  } catch (e) {
    log.warn('Failed to write notifications digest sentinel', {
      id: 'system',
      error: e,
    });
  }
}
