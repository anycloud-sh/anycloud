import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const apiProcessMemberSchema = z.enum(['api-image', 'api-startup']);
export type ApiProcessMember = z.output<typeof apiProcessMemberSchema>;
export const apiProcessModeSchema = z.enum(['normal', 'forced']);
const containerIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const containerSchema = z
  .object({
    id: containerIdSchema,
    name: z.string().min(1),
    running: z.boolean(),
  })
  .strict();
const targetSchema = z
  .object({ kind: z.enum(['name', 'id']), value: z.string().min(1) })
  .strict();
export const processReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    member: apiProcessMemberSchema,
    mode: apiProcessModeSchema,
    action: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    completed: z.boolean(),
    injectedFailure: z.boolean(),
    containers: z.array(containerSchema),
    ownedNames: z.array(z.string().min(1)).optional(),
    absence: z
      .array(
        targetSchema
          .extend({ observation: z.enum(['absent', 'present', 'unknown']) })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ProcessReceipt = z.output<typeof processReceiptSchema>;
export type ContainerAbsenceTarget = z.output<typeof targetSchema>;

export async function readProcessReceipts(
  directory: string,
): Promise<readonly ProcessReceipt[]> {
  const text = await readFile(
    path.join(directory, 'api-process-observations.jsonl'),
    'utf8',
  );
  const lines = text.trim().split('\n');
  assert.ok(lines.length > 0 && lines[0], 'Missing API process receipts');
  return lines.map((line) => processReceiptSchema.parse(JSON.parse(line)));
}

export function validateOwnedContainerNames(
  member: ApiProcessMember,
  names: readonly string[],
): void {
  assert.equal(
    new Set(names).size,
    names.length,
    'Duplicate owned container names',
  );
  const prefixes =
    member === 'api-image'
      ? [
          'api-test-',
          'api-heap-',
          'api-heap-override-',
          'api-heap-default-',
          'api-durable-',
        ]
      : ['api-startup-durable-'];
  const suffixes: string[] = [];
  for (const prefix of prefixes) {
    const matching = names.filter(
      (name) =>
        name.startsWith(prefix) &&
        /^[1-9][0-9]*$/u.test(name.slice(prefix.length)),
    );
    assert.equal(matching.length, 1, `Missing exact owned container ${prefix}`);
    suffixes.push(matching[0].slice(prefix.length));
  }
  assert.equal(
    new Set(suffixes).size,
    1,
    'Owned containers span different launcher attempts',
  );
  assert.equal(
    names.length,
    prefixes.length + (member === 'api-startup' ? 1 : 0),
  );
  if (member === 'api-startup') assert.ok(names.includes('anycloud-api'));
}

export function containerAbsenceTargets(
  records: readonly ProcessReceipt[],
  member: ApiProcessMember,
): readonly ContainerAbsenceTarget[] {
  assert.ok(records.length > 0, 'Missing process launch receipts');
  for (const record of records) {
    assert.equal(record.member, member, 'Foreign member in process receipts');
    assert.ok(
      record.completedAt >= record.startedAt,
      'Process receipt has invalid timestamps',
    );
  }
  const registrations = records.filter(
    (record) => record.action === 'register-owned',
  );
  assert.equal(
    registrations.length,
    1,
    'Expected one owned-container registration',
  );
  const registration = registrations[0];
  assert.equal(
    registration.completed,
    true,
    'Owned-container registration failed',
  );
  const names = registration.ownedNames;
  assert.ok(names);
  validateOwnedContainerNames(member, names);
  const ids = new Set<string>();
  for (const record of records)
    for (const container of record.containers) {
      assert.ok(
        names.includes(container.name),
        'Observed a container outside this launcher ownership',
      );
      ids.add(container.id);
    }
  return [
    ...names.map((value): ContainerAbsenceTarget => ({ kind: 'name', value })),
    ...[...ids].map((value): ContainerAbsenceTarget => ({ kind: 'id', value })),
  ];
}

/** The expected failed test is accepted only after independent native absence. */
export function verifyProcessReceipts(
  records: readonly ProcessReceipt[],
  member: ApiProcessMember,
  outcome: 'success' | 'failure',
  mode: 'normal' | 'forced',
) {
  const targets = containerAbsenceTargets(records, member);
  assert.ok(
    records.every((record) => record.mode === mode),
    'Process receipts do not match the declared fault mode',
  );
  const checkpoints = records.filter(
    (record) => record.action === 'after-running',
  );
  assert.equal(checkpoints.length, 1, 'Missing exact after-Running checkpoint');
  const checkpoint = checkpoints[0];
  assert.ok(
    checkpoint.containers.some((container) => container.running),
    'No running container identity was captured',
  );
  const cleanupRecords = records.filter(
    (record) => record.action === 'containers-absent',
  );
  assert.equal(
    cleanupRecords.length,
    1,
    'Missing exact native cleanup receipt',
  );
  const cleanup = cleanupRecords[0];
  assert.equal(cleanup.completed, true, 'Native cleanup did not complete');
  const completions = records.filter(
    (record) => record.action === 'launcher-finished',
  );
  assert.equal(completions.length, 1, 'Missing final launcher cleanup status');
  assert.equal(
    records.at(-1),
    completions[0],
    'Launcher cleanup must be the final observation',
  );
  assert.equal(completions[0].completed, true, 'Launcher cleanup failed');
  assert.ok(
    records.indexOf(cleanup) === records.length - 2,
    'Unexpected observation between native and launcher cleanup',
  );
  const absence = cleanup.absence;
  assert.ok(
    absence &&
      absence.every((observation) => observation.observation === 'absent'),
    'Native cleanup is unresolved',
  );
  const key = (target: ContainerAbsenceTarget): string =>
    `${target.kind}:${target.value}`;
  assert.deepEqual(
    absence.map(key).sort(),
    targets.map(key).sort(),
    'Cleanup omitted or duplicated an owned name or captured container ID',
  );
  const failures = records.filter((record) => !record.completed);
  if (mode === 'forced') {
    assert.equal(
      outcome,
      'failure',
      'Injected process failure unexpectedly succeeded',
    );
    assert.deepEqual(
      failures,
      [checkpoint],
      'Failure was not limited to the declared after-Running injection',
    );
    assert.equal(checkpoint.injectedFailure, true);
  } else {
    assert.equal(outcome, 'success', 'Normal process suite failed');
    assert.equal(
      failures.length,
      0,
      'A process assertion failed inside a successful outer step',
    );
    assert.ok(records.every((record) => !record.injectedFailure));
  }
  return {
    schemaVersion: 1,
    member,
    mode,
    outcome,
    expectedFailureObserved: mode === 'forced',
    completed: true,
    ownedContainerNames: targets
      .filter((target) => target.kind === 'name')
      .map((target) => target.value),
    capturedContainerIds: targets
      .filter((target) => target.kind === 'id')
      .map((target) => target.value),
    absence,
  };
}
