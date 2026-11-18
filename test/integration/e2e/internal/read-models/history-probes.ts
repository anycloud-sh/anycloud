import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import {
  getCredentialSecretStore,
  getWorkloadLifecycle,
  getWorkloadQueryStore as queries,
  getWorkloadSpendStore,
} from '../../../../../src/api/services/persistence.js';
import { listVmsNeedingCost } from '../../../../../src/api/services/repositories/billing.js';
import { getDB } from '../../../../../src/api/services/repositories/db.js';
import type { OwnershipScope } from '../../../../../src/api/services/repositories/ownership-filter.js';
import { WorkloadState } from '../../../../../src/shared/workload.js';
import { assertHistoryInvariants } from './history-records.js';

/**
 * Shared body of the long-history child entries. It imports only the store
 * modules the legacy `monitor query scans` probe loaded, so an entry that
 * needs nothing heavier (`history-child.ts`) starts inside the six-second
 * probe budget regardless of how large the API's module graph grows. The
 * `recover` and `serve` entries add the monitor and the API on top.
 */

type HistoryDatabase = ReturnType<typeof getDB>;

export function parseHistoryChildOptions<const Action extends string>(
  actions: readonly [Action, ...Action[]],
): { readonly action: Action; readonly output: string } {
  return z
    .object({
      action: z.enum(actions),
      output: z.string().min(1),
    })
    .strict()
    .parse(JSON.parse(process.argv[2] ?? 'null'));
}

export async function historyDatabase(): Promise<HistoryDatabase> {
  assert.equal(process.env.IS_TEST, 'true');
  assert(
    process.env.SQLITE_PATH && process.env.ANYCLOUD_DIR,
    'History child requires its private database',
  );
  const db = getDB();
  await db.init?.();
  return db;
}

async function count(
  db: HistoryDatabase,
  sql: string,
  parameters: readonly string[] = [],
): Promise<number> {
  const rows = await db.query<{ count: number }>(sql, [...parameters]);
  return z
    .array(z.object({ count: z.number().int().nonnegative() }))
    .length(1)
    .parse(rows)[0].count;
}

export async function inspectHistory(
  db: HistoryDatabase,
): Promise<ReturnType<typeof assertHistoryInvariants>> {
  return assertHistoryInvariants({
    workloads: await count(
      db,
      "SELECT COUNT(*) AS count FROM workloads WHERE id LIKE 'nuke-db-%'",
    ),
    activeSeed: await count(
      db,
      "SELECT COUNT(*) AS count FROM workloads WHERE id LIKE 'nuke-db-%' AND state IN ('queued', 'provisioning', 'initializing', 'downloading', 'syncing', 'starting', 'running', 'retrying', 'recovering')",
    ),
    liveSeedVms: await count(
      db,
      "SELECT COUNT(*) AS count FROM vms WHERE workload_id IN (SELECT id FROM workloads WHERE id LIKE 'nuke-db-%') AND ended_at IS NULL",
    ),
    deploying: await count(
      db,
      "SELECT COUNT(*) AS count FROM workloads WHERE state IN ('provisioning', 'initializing', 'downloading', 'syncing', 'starting')",
    ),
  });
}

export async function queryHistory(
  db: HistoryDatabase,
): Promise<Readonly<Record<string, number>>> {
  const now = Date.now();
  const rows = await db.query<{ userId: string }>(
    "SELECT user_id AS userId FROM workloads WHERE id LIKE 'nuke-db-%' LIMIT 1",
  );
  const [{ userId }] = z
    .array(z.object({ userId: z.string().min(1) }))
    .length(1)
    .parse(rows);
  const scope: OwnershipScope = { kind: 'api' } as const;
  const timed = async <Value>(
    name: string,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    console.error(
      JSON.stringify({ event: 'monitor-query-start', query: name }),
    );
    const startedAt = performance.now();
    const value = await operation();
    console.error(
      JSON.stringify({
        event: 'monitor-query-finish',
        query: name,
        elapsedMs: performance.now() - startedAt,
        count: Array.isArray(value) ? value.length : value,
      }),
    );
    return value;
  };
  const candidates = await timed('listWorkloadReconcileCandidates', () =>
    queries().listWorkloadReconcileCandidates(),
  );
  const retryIds = candidates
    .filter((candidate) => ['retrying', 'recovering'].includes(candidate.state))
    .map((candidate) => candidate.id);
  const retryCandidates = await timed('getRetryCandidatesByIds', () =>
    getWorkloadLifecycle().getRetryCandidatesByIds(retryIds),
  );
  const pendingCleanupCount = await timed('countPendingCleanup', () =>
    count(
      db,
      "SELECT COUNT(*) AS count FROM workloads WHERE user_id = ? AND state IN ('completed', 'errored', 'failed', 'invalid', 'terminated') AND completed_at IS NOT NULL AND cleaned_at IS NULL",
      [userId],
    ),
  );
  const terminalStates = new Set([
    'completed',
    'errored',
    'failed',
    'invalid',
    'terminated',
  ]);
  const pendingCleanupCandidates = candidates.filter((candidate) =>
    terminalStates.has(candidate.state),
  );
  assert.equal(
    pendingCleanupCandidates.length,
    pendingCleanupCount,
    'Cleanup discovery omitted historical rows',
  );
  const terminatable = await timed('listTerminatable', () =>
    queries().listWorkloads(scope, 1_000, {
      stateClass: 'terminatable',
      limitExplicit: true,
    }),
  );
  assert.equal(
    terminatable.length,
    Math.min(pendingCleanupCount, 1_000),
    'Terminate picker omitted pending cleanup',
  );
  await probeTerminatePickerBoundary(db, scope, userId, timed);
  const costReport = await timed('getCostReportInWindow(agent)', () =>
    getWorkloadSpendStore().getCostReportInWindow(
      scope,
      now - 60 * 60 * 1_000,
      now + 1,
      {
        agent: 'aider',
      },
    ),
  );
  assert.deepEqual(
    Object.keys(costReport.byAgent).filter((agent) => agent !== 'aider'),
    [],
    'Cost attribution leaked another agent',
  );
  const pipelineStates = new Set([
    'provisioning',
    'initializing',
    'downloading',
    'syncing',
    'starting',
  ]);
  return {
    reconcileCandidates: candidates.length,
    pendingCleanup: pendingCleanupCandidates.length,
    activeSpot: candidates.filter(
      (candidate) =>
        candidate.spot && candidate.state === WorkloadState.Running,
    ).length,
    runningJobs: candidates.filter(
      (candidate) =>
        candidate.workloadType === 'job' &&
        candidate.state === WorkloadState.Running,
    ).length,
    terminalByDateRange: (
      await timed('listTerminalWorkloadsByDateRange', () =>
        queries().listTerminalWorkloadsByDateRange(0, now + 1),
      )
    ).length,
    retrying: retryCandidates.length,
    queued: (await timed('listQueued', () => queries().listQueued(10_000)))
      .length,
    deploying: await timed('countDeploying', () => queries().countDeploying()),
    stuckActive: candidates.filter((candidate) =>
      pipelineStates.has(candidate.state),
    ).length,
    vmsNeedingCost: (
      await timed('listVmsNeedingCost', () =>
        listVmsNeedingCost(getDB(), Date.now()),
      )
    ).length,
    namedCredentials: (
      await timed('listNamedCredentials', () =>
        getCredentialSecretStore().listNamedCredentials(),
      )
    ).length,
    terminatable: terminatable.length,
    selectiveCostWorkloads:
      costReport.totalJobs +
      costReport.totalServices +
      costReport.totalVms +
      costReport.workloadsWithoutPrice,
  };
}

const TERMINATE_PICKER_LIMIT = 1_000;
const TERMINAL_STATES_SQL =
  "('completed', 'errored', 'failed', 'invalid', 'terminated')";

/**
 * The seeded history is cleaned history, so the picker's page limit is never
 * reached by the fixture itself (the mutation sample showed a picker short by
 * one row passing). Lend the store limit + 1 pending-cleanup rows for the
 * duration of one probe, require the page to be exactly full, and restore the
 * rows' cleanup timestamps afterwards so the history stays as seeded.
 */
async function probeTerminatePickerBoundary(
  db: HistoryDatabase,
  scope: OwnershipScope,
  userId: string,
  timed: <Value>(
    name: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>,
): Promise<void> {
  await db.query(
    `CREATE TEMP TABLE picker_boundary AS
       SELECT id, cleaned_at FROM workloads
        WHERE user_id = ? AND state IN ${TERMINAL_STATES_SQL} AND cleaned_at IS NOT NULL
        ORDER BY id LIMIT ?`,
    [userId, TERMINATE_PICKER_LIMIT + 1],
  );
  try {
    const lent = await count(
      db,
      'SELECT COUNT(*) AS count FROM picker_boundary',
    );
    assert.equal(
      lent,
      TERMINATE_PICKER_LIMIT + 1,
      'History fixture holds too few cleaned terminal rows for the picker boundary',
    );
    await db.query(
      'UPDATE workloads SET cleaned_at = NULL WHERE id IN (SELECT id FROM picker_boundary)',
    );
    const pending = await count(
      db,
      `SELECT COUNT(*) AS count FROM workloads WHERE user_id = ? AND state IN ${TERMINAL_STATES_SQL} AND completed_at IS NOT NULL AND cleaned_at IS NULL`,
      [userId],
    );
    assert.ok(
      pending > TERMINATE_PICKER_LIMIT,
      'Pending cleanup must exceed the picker limit',
    );
    const page = await timed('listTerminatable(boundary)', () =>
      queries().listWorkloads(scope, TERMINATE_PICKER_LIMIT, {
        stateClass: 'terminatable',
        limitExplicit: true,
      }),
    );
    assert.equal(
      page.length,
      TERMINATE_PICKER_LIMIT,
      'Terminate picker did not fill its page at the limit',
    );
  } finally {
    await db.query(
      `UPDATE workloads
          SET cleaned_at = (SELECT cleaned_at FROM picker_boundary WHERE picker_boundary.id = workloads.id)
        WHERE id IN (SELECT id FROM picker_boundary)`,
    );
    await db.query('DROP TABLE picker_boundary');
  }
}

/** The parent reads a result only after the child exits, so a plain write suffices. */
export async function writeHistoryResult(
  output: string,
  result: unknown,
): Promise<void> {
  await writeFile(output, JSON.stringify(result));
}

/** Publish the record atomically so a probe never reads a partially written file. */
export async function writeReadyRecord(
  output: string,
  body: string,
): Promise<void> {
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, body);
  await rename(temporary, output);
}
