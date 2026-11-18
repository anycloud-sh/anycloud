import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { runChild } from '../../../../helpers/api-responsiveness/run-child.mjs';
import {
  assertAtomicSettlement,
  assertBillingInterruption,
  assertIdempotentReplay,
  assertResponsiveBilling,
  assertSettledFixture,
  assertSlowSettlement,
  billingAuditSchema,
  billingCrashSchema,
  billingMeasurementSchema,
  billingSeedSchema,
  billingSettlementSchema,
  slowSettlementSchema,
} from './billing-records.js';

const options = z
  .object({
    kind: z.enum(['settlement', 'responsiveness']),
    buildDir: z.string().min(1),
    output: z.string().min(1),
    seedDatabase: z.string().min(1).optional(),
  })
  .strict()
  .parse(JSON.parse(process.argv[2] ?? 'null'));

await mkdir(options.output);
const report: Record<string, unknown> = {
  schemaVersion: 1,
  kind: options.kind,
  status: 'running',
  resourceMode: 'no-provision',
  cleanup: 'Not applicable',
};
const common = { buildDir: options.buildDir };
try {
  const seed = billingSeedSchema.parse(
    await runChild({
      ...common,
      action: 'seed',
      profile: 'smoke',
      runDir: path.join(options.output, 'seed'),
      copyFrom: options.seedDatabase,
    }),
  );
  report.fixture = {
    rows: seed.fixture.rows,
    groups: seed.fixture.groups,
    logicalSha256: seed.fixture.logicalSha256,
  };
  if (options.kind === 'responsiveness') {
    const result = billingMeasurementSchema.parse(
      await runChild({
        ...common,
        action: 'measure',
        fixture: seed.fixture,
        response: 'settled',
        boundary: 'yield',
        delayMs: 500,
        healthTimeoutMs: 6_000,
        runDir: path.join(options.output, 'billing'),
        copyFrom: seed.databasePath,
      }),
    );
    report.measurement = result;
    assertResponsiveBilling(result, 10);
    assertSettledFixture(seed, result);
  } else {
    const faultEvidencePath = path.join(
      options.output,
      'crash',
      'interruption.json',
    );
    const crashed = billingCrashSchema.parse(
      await runChild({
        ...common,
        action: 'measure',
        fixture: seed.fixture,
        response: 'settled',
        boundary: 'yield',
        faultAfterWrites: 5,
        faultEvidencePath,
        expectedExitCode: 86,
        runDir: path.join(options.output, 'crash'),
        copyFrom: seed.databasePath,
      }),
    );
    report.interruption = assertBillingInterruption(
      JSON.parse(await readFile(faultEvidencePath, 'utf8')),
    );
    // Preserve hot journals and WAL/SHM through the existing process harness.
    report.recoveryFiles = ['-journal', '-wal', '-shm'].filter((suffix) =>
      existsSync(crashed.databasePath + suffix),
    );
    const reopened = billingAuditSchema.parse(
      await runChild({
        ...common,
        action: 'audit',
        fixture: seed.fixture,
        runDir: path.join(options.output, 'reopen'),
        copyFrom: crashed.databasePath,
      }),
    );
    report.settlement = reopened.settlement;
    assertAtomicSettlement(reopened);
    const resumed = billingSettlementSchema.parse(
      await runChild({
        ...common,
        action: 'resume',
        fixture: seed.fixture,
        response: 'settled',
        boundary: 'yield',
        runDir: path.join(options.output, 'resume'),
        copyFrom: reopened.databasePath,
      }),
    );
    report.retry = resumed.correctness;
    assertSettledFixture(seed, resumed);
    const repeated = billingSettlementSchema.parse(
      await runChild({
        ...common,
        action: 'resume',
        fixture: seed.fixture,
        response: 'settled',
        boundary: 'yield',
        runDir: path.join(options.output, 'repeat'),
        copyFrom: resumed.databasePath,
      }),
    );
    report.repeat = repeated;
    assertIdempotentReplay(resumed, repeated);
    const slow = slowSettlementSchema.parse(
      await runChild({
        ...common,
        action: 'measure',
        fixture: seed.fixture,
        response: 'settled',
        boundary: 'immediate',
        synchronousSettlementDelayMs: 75,
        healthTimeoutMs: 6_000,
        runDir: path.join(options.output, 'slow-settlement'),
        copyFrom: seed.databasePath,
      }),
    );
    report.slowSettlement = slow;
    assertSlowSettlement(seed, resumed, slow);
  }
  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(options.output, 'result.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
}
