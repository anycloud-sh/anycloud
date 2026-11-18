import assert from 'node:assert/strict';
import { z } from 'zod';

import { workloadListResponseSchema } from '../../../../../src/shared/api-contract/workload-management-schemas.js';

const count = z.number().int().nonnegative();
export const historyManifestSchema = z.object({
  counts: z.object({
    workloads: z.literal(3_700),
    events: count.positive(),
    historicalVmRows: count.positive(),
    failedVmAttempts: count,
  }),
  heavyStatusWorkloadIds: z.array(z.string().startsWith('nuke-db-')).nonempty(),
  sessions: z.array(
    z.object({
      session: z.string().nullable(),
      sessionLabel: z.string().nullable(),
      agent: z.string().nullable(),
      displayForm: z.string(),
      workloadCount: count,
    }),
  ),
});

export const historyInvariantSchema = z.object({
  workloads: count,
  activeSeed: count,
  liveSeedVms: count,
  deploying: count,
});

export function assertHistoryInvariants(
  value: unknown,
): z.infer<typeof historyInvariantSchema> {
  const result = historyInvariantSchema.parse(value);
  assert.deepEqual(result, {
    workloads: 3_700,
    activeSeed: 0,
    liveSeedVms: 0,
    deploying: 0,
  });
  return result;
}

export function historySessionCases(
  manifest: z.infer<typeof historyManifestSchema>,
): readonly {
  readonly label: string;
  readonly form: string;
  readonly expected: number;
}[] {
  const labeled = manifest.sessions.find(
    (session) => session.sessionLabel !== null,
  );
  const hashed = manifest.sessions.find(
    (session) =>
      session.sessionLabel === null &&
      session.agent !== null &&
      session.session !== null &&
      session.session.length > 12,
  );
  assert(
    labeled?.sessionLabel && labeled.session,
    'History fixture lacks a labeled session',
  );
  assert(hashed?.session, 'History fixture lacks an unlabeled long-id session');
  return [
    {
      label: 'label',
      form: labeled.sessionLabel,
      expected: labeled.workloadCount,
    },
    {
      label: 'exact-id',
      form: labeled.session,
      expected: labeled.workloadCount,
    },
    {
      label: 'agent-prefix',
      form: hashed.displayForm,
      expected: hashed.workloadCount,
    },
    {
      label: 'bare-prefix',
      form: hashed.session.slice(0, 6),
      expected: hashed.workloadCount,
    },
    { label: 'no-match', form: 'zzzzzz-no-such-session', expected: 0 },
  ];
}

export function assertHistorySessionSelection(
  value: unknown,
  expected: number,
): number {
  const cliRows = z.array(z.record(z.string(), z.unknown())).parse(value);
  // The CLI omits request-relative rendering metadata. Restore a neutral value
  // only for payload validation; this assertion returns the count, not ownership.
  const rows = workloadListResponseSchema.parse(
    cliRows.map((row) => ({ isOwnedByCaller: false, ...row })),
  );
  assert.equal(
    rows.length,
    Math.min(expected, 1_000),
    'Session filter returned the wrong number of Workloads',
  );
  return rows.length;
}

export const historyReadySchema = z.object({
  pid: count.positive(),
  port: count.positive().max(65_535),
});

export function parseHistoryReady(
  value: unknown,
  childPid: number,
): z.infer<typeof historyReadySchema> {
  const ready = historyReadySchema.parse(value);
  assert.equal(
    ready.pid,
    childPid,
    'History readiness record belongs to another process',
  );
  return ready;
}
