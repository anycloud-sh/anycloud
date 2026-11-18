import { describe, expect, test } from 'vitest';

import {
  assertAtomicSettlement,
  assertBillingInterruption,
  assertIdempotentReplay,
  assertResponsiveBilling,
  assertSettledFixture,
  assertSlowSettlement,
  billingAuditSchema,
  billingMeasurementSchema,
  billingSeedSchema,
  billingSettlementSchema,
  slowSettlementSchema,
} from '../integration/e2e/internal/read-models/billing-records.js';
import {
  assertHistoryInvariants,
  assertHistorySessionSelection,
  historyManifestSchema,
  historySessionCases,
  parseHistoryReady,
} from '../integration/e2e/internal/read-models/history-records.js';
import { makeWorkloadListRow } from './helpers/fixtures.js';

const seed = billingSeedSchema.parse({
  databasePath: '/private/seed/api.db',
  fixture: { rows: 1_119, groups: 45, logicalSha256: 'a'.repeat(64) },
});
const resumed = billingSettlementSchema.parse({
  databasePath: '/private/resume/api.db',
  correctness: { settledRows: 1_119, settledGroups: 45 },
  billing: { calls: 45 },
});
const repeated = { ...resumed, billing: { calls: 0 } };
const health = {
  offered: 20,
  completed: 20,
  deadlineMs: 6_000,
  deadlineMisses: 0,
  otherFailures: 0,
  responsive: true,
};
const measured = billingMeasurementSchema.parse({
  ...resumed,
  health: { ...health, deadlineMs: 1_000 },
  healthCoarse: health,
});

describe('billing read-model evidence', () => {
  test('requires five real writes inside the interrupted transaction', () => {
    expect(
      assertBillingInterruption({ vmCostWrites: 5, inTransaction: true }),
    ).toEqual({ vmCostWrites: 5, inTransaction: true });
    for (const value of [
      { vmCostWrites: 4, inTransaction: true },
      { vmCostWrites: 5, inTransaction: false },
      { vmCostWrites: '5', inTransaction: true },
      {},
    ]) {
      expect(() => assertBillingInterruption(value)).toThrow();
    }
  });

  test('rejects partial durable costs even if a summary claims atomic recovery', () => {
    const clean = billingAuditSchema.parse({
      databasePath: '/private/reopen/api.db',
      settlement: { atomic: true, settledRows: 0, partialGroups: [] },
    });
    expect(() => assertAtomicSettlement(clean)).not.toThrow();
    expect(() =>
      assertAtomicSettlement({
        ...clean,
        settlement: {
          atomic: true,
          settledRows: 5,
          partialGroups: [
            {
              resourceId: 'cluster',
              credentialId: 'synthetic',
              settled: 5,
              members: 327,
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      assertAtomicSettlement({
        ...clean,
        settlement: { ...clean.settlement, atomic: false },
      }),
    ).toThrow();
  });

  test('rejects replay billing, omitted rows and changed group accounting', () => {
    expect(() => assertSettledFixture(seed, resumed)).not.toThrow();
    expect(() => assertIdempotentReplay(resumed, repeated)).not.toThrow();
    expect(() =>
      assertIdempotentReplay(resumed, { ...repeated, billing: { calls: 1 } }),
    ).toThrow();
    expect(() =>
      assertSettledFixture(seed, {
        ...resumed,
        correctness: { settledRows: 1_118, settledGroups: 45 },
      }),
    ).toThrow();
    expect(() =>
      assertIdempotentReplay(resumed, {
        ...repeated,
        correctness: { settledRows: 1_119, settledGroups: 44 },
      }),
    ).toThrow();
  });

  test('does not accept missing, incomplete or late independent health observations', () => {
    expect(() => assertResponsiveBilling(measured, 10)).not.toThrow();
    for (const invalid of [
      { ...measured, health: { ...health, offered: 0 } },
      { ...measured, healthCoarse: { ...health, responsive: null } },
      { ...measured, healthCoarse: { ...health, completed: 19 } },
      { ...measured, healthCoarse: { ...health, deadlineMisses: 1 } },
      { ...measured, healthCoarse: { ...health, otherFailures: 1 } },
      { ...measured, healthCoarse: { ...health, deadlineMs: 10_000 } },
    ])
      expect(() => assertResponsiveBilling(invalid, 10)).toThrow();
  });

  test('requires slow-settlement pressure on every fixture group', () => {
    const slow = slowSettlementSchema.parse({
      ...measured,
      injectedSettlementDelay: { transactions: 45 },
    });
    expect(() => assertSlowSettlement(seed, resumed, slow)).not.toThrow();
    expect(() =>
      assertSlowSettlement(seed, resumed, {
        ...slow,
        injectedSettlementDelay: { transactions: 44 },
      }),
    ).toThrow();
  });
});

describe('long-history read-model evidence', () => {
  test('requires all 3,700 rows and rejects active historical resources', () => {
    const clean = {
      workloads: 3_700,
      activeSeed: 0,
      liveSeedVms: 0,
      deploying: 0,
    };
    expect(assertHistoryInvariants(clean)).toEqual(clean);
    for (const key of ['activeSeed', 'liveSeedVms', 'deploying'])
      expect(() => assertHistoryInvariants({ ...clean, [key]: 1 })).toThrow();
    expect(() =>
      assertHistoryInvariants({ ...clean, workloads: 3_699 }),
    ).toThrow();
    expect(() => assertHistoryInvariants({ workloads: 3_700 })).toThrow();
  });

  test('retains every visible session spelling and rejects missing representative sessions', () => {
    const manifest = historyManifestSchema.parse({
      counts: {
        workloads: 3_700,
        events: 529_000,
        historicalVmRows: 3_200,
        failedVmAttempts: 296,
      },
      heavyStatusWorkloadIds: ['nuke-db-heavy'],
      sessions: [
        {
          session: '11111111-1111-4111-8111-111111111111',
          sessionLabel: 'training run',
          agent: 'claude',
          displayForm: 'training run',
          workloadCount: 888,
        },
        {
          session: '22222222-2222-4222-8222-222222222222',
          sessionLabel: null,
          agent: 'claude',
          displayForm: 'claude:222222',
          workloadCount: 900,
        },
      ],
    });
    expect(historySessionCases(manifest)).toEqual([
      { label: 'label', form: 'training run', expected: 888 },
      {
        label: 'exact-id',
        form: '11111111-1111-4111-8111-111111111111',
        expected: 888,
      },
      { label: 'agent-prefix', form: 'claude:222222', expected: 900 },
      { label: 'bare-prefix', form: '222222', expected: 900 },
      { label: 'no-match', form: 'zzzzzz-no-such-session', expected: 0 },
    ]);
    expect(() =>
      historySessionCases({
        ...manifest,
        sessions: manifest.sessions.slice(0, 1),
      }),
    ).toThrow();
  });

  test('accepts nonempty CLI session rows without API ownership metadata', () => {
    const { isOwnedByCaller: _isOwnedByCaller, ...cliRow } =
      makeWorkloadListRow();
    const cliOutput: unknown = JSON.parse(JSON.stringify([cliRow]));
    expect(assertHistorySessionSelection(cliOutput, 1)).toBe(1);
    expect(() => assertHistorySessionSelection(cliOutput, 2)).toThrow(
      'Session filter returned the wrong number of Workloads',
    );
  });

  test('retains complete row validation for CLI session results', () => {
    const { isOwnedByCaller: _isOwnedByCaller, ...cliRow } =
      makeWorkloadListRow();
    for (const invalid of [
      { ...cliRow, userId: 123 },
      { ...cliRow, state: 'unknown' },
      { ...cliRow, image: null },
      {
        ...cliRow,
        deploymentId: 'deployment-with-container-config',
        dockerOptions: { cpus: '2' },
      },
      { ...cliRow, unexpected: true },
    ])
      expect(() => assertHistorySessionSelection([invalid], 1)).toThrow();
  });

  test('rejects malformed list responses instead of trusting array length alone', () => {
    expect(assertHistorySessionSelection([], 0)).toBe(0);
    expect(() => assertHistorySessionSelection([{}], 1)).toThrow();
    expect(() => assertHistorySessionSelection([], 1)).toThrow();
    expect(() => assertHistorySessionSelection({ length: 0 }, 0)).toThrow();
  });

  test('binds API readiness to its owned process and a valid loopback port', () => {
    expect(parseHistoryReady({ pid: 123, port: 18787 }, 123)).toEqual({
      pid: 123,
      port: 18787,
    });
    expect(() => parseHistoryReady({ pid: 124, port: 18787 }, 123)).toThrow();
    expect(() => parseHistoryReady({ pid: 123, port: 0 }, 123)).toThrow();
  });
});
