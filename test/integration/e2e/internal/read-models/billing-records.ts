import assert from 'node:assert/strict';
import { z } from 'zod';

const count = z.number().int().nonnegative();
const correctness = z.object({
  settledRows: count,
  settledGroups: count,
});

export const billingSeedSchema = z.object({
  databasePath: z.string().min(1),
  fixture: z
    .object({
      rows: count.positive(),
      groups: count.positive(),
      logicalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .passthrough(),
});

export const billingCrashSchema = z.object({
  databasePath: z.string().min(1),
  exitCode: z.literal(86),
});

export const billingAuditSchema = z.object({
  databasePath: z.string().min(1),
  settlement: z.object({
    atomic: z.boolean(),
    settledRows: count,
    partialGroups: z.array(
      z.object({
        resourceId: z.string().min(1),
        credentialId: z.string().min(1),
        settled: count,
        members: count.positive(),
      }),
    ),
  }),
});

export const billingSettlementSchema = z.object({
  databasePath: z.string().min(1),
  correctness,
  billing: z.object({ calls: count }).passthrough(),
});

const healthSchema = z
  .object({
    offered: count,
    completed: count,
    deadlineMs: count.positive(),
    deadlineMisses: count,
    otherFailures: count,
    responsive: z.boolean().nullable(),
  })
  .passthrough();

export const billingMeasurementSchema = billingSettlementSchema.extend({
  health: healthSchema,
  healthCoarse: healthSchema,
});

export const slowSettlementSchema = billingMeasurementSchema.extend({
  injectedSettlementDelay: z.object({ transactions: count }).passthrough(),
});

export function assertBillingInterruption(value: unknown): {
  readonly vmCostWrites: 5;
  readonly inTransaction: true;
} {
  return z
    .object({ vmCostWrites: z.literal(5), inTransaction: z.literal(true) })
    .parse(value);
}

export function assertAtomicSettlement(
  audit: z.infer<typeof billingAuditSchema>,
): void {
  assert.equal(
    audit.settlement.atomic,
    true,
    'Partial group costs survived interruption',
  );
  assert.deepEqual(audit.settlement.partialGroups, []);
}

export function assertSettledFixture(
  seed: z.infer<typeof billingSeedSchema>,
  result: z.infer<typeof billingSettlementSchema>,
): void {
  assert.deepEqual(result.correctness, {
    settledRows: seed.fixture.rows,
    settledGroups: seed.fixture.groups,
  });
}

export function assertIdempotentReplay(
  resumed: z.infer<typeof billingSettlementSchema>,
  repeated: z.infer<typeof billingSettlementSchema>,
): void {
  assert.equal(repeated.billing.calls, 0, 'Committed groups were billed again');
  assert.deepEqual(repeated.correctness, resumed.correctness);
}

export function assertResponsiveBilling(
  result: z.infer<typeof billingMeasurementSchema>,
  minimumOffers: number,
): void {
  assert(
    result.health.offered >= minimumOffers,
    'Insufficient health overlap with billing',
  );
  assert.equal(result.healthCoarse.offered, result.health.offered);
  assert.equal(result.healthCoarse.completed, result.healthCoarse.offered);
  assert.equal(result.healthCoarse.deadlineMisses, 0);
  assert.equal(result.healthCoarse.otherFailures, 0);
  assert.equal(
    result.healthCoarse.responsive,
    true,
    'Billing exceeded the six-second integration health timeout',
  );
  assert.equal(result.healthCoarse.deadlineMs, 6_000);
}

export function assertSlowSettlement(
  seed: z.infer<typeof billingSeedSchema>,
  resumed: z.infer<typeof billingSettlementSchema>,
  slow: z.infer<typeof slowSettlementSchema>,
): void {
  assert.equal(slow.injectedSettlementDelay.transactions, seed.fixture.groups);
  assert.deepEqual(slow.correctness, resumed.correctness);
  assertResponsiveBilling(slow, 1);
}
