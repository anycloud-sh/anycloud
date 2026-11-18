#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const E2E_RUN_RECORD_FILE = 'e2e-run.json';

const e2eLogFileSchema = z
  .string()
  .min(1)
  .refine((value) => basename(value) === value, {
    message: 'logFile must be a basename within the results directory',
  })
  .refine((value) => value.endsWith('.log'), {
    message: 'logFile must end in .log',
  });

export const E2ERunRecordSchema = z.strictObject({
  version: z.literal(1),
  testName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  implementation: z.enum(['bash', 'vitest']),
  command: z.string().min(1),
  logFile: e2eLogFileSchema,
  exitCode: z.number().int(),
  durationSeconds: z.number().finite().nonnegative(),
});

export type E2ERunRecord = z.infer<typeof E2ERunRecordSchema>;

export function writeE2ERunRecord(outDir: string, record: E2ERunRecord): void {
  const validated = E2ERunRecordSchema.parse(record);
  writeFileSync(
    join(outDir, E2E_RUN_RECORD_FILE),
    `${JSON.stringify(validated, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}

export function readE2ERunRecord(outDir: string): E2ERunRecord {
  const raw: unknown = JSON.parse(
    readFileSync(join(outDir, E2E_RUN_RECORD_FILE), 'utf8'),
  );
  return E2ERunRecordSchema.parse(raw);
}

function numericArgument(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be numeric`);
  }
  return parsed;
}

function main(): void {
  const [
    outDir,
    testName,
    implementation,
    logFile,
    exitCode,
    durationSeconds,
    command,
  ] = process.argv.slice(2);
  if (
    !outDir ||
    !testName ||
    !implementation ||
    !logFile ||
    exitCode === undefined ||
    durationSeconds === undefined ||
    !command
  ) {
    console.error(
      'usage: e2e-run-record.ts <output-dir> <test-name> <bash|vitest> <log-file> <exit-code> <duration-seconds> <command>',
    );
    process.exit(2);
  }

  writeE2ERunRecord(
    outDir,
    E2ERunRecordSchema.parse({
      version: 1,
      testName,
      implementation,
      command,
      logFile,
      exitCode: numericArgument('exitCode', exitCode),
      durationSeconds: numericArgument('durationSeconds', durationSeconds),
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      '[e2e-run-record] failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
