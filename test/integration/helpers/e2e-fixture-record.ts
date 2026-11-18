/**
 * Fixture -> triage evidence protocol.
 *
 * The constrained Vitest fixture captures its failure diagnostics into files
 * instead of stdout, so — unlike Bash, whose diagnostics land in the declared
 * test log — nothing reaches triage unless triage reads them deliberately. Each
 * fixture lifecycle therefore writes one strict, versioned record next to the
 * artifacts it produced, and triage consumes it by this schema.
 *
 * The record is written on every finalized lifecycle, not only on failure, so
 * its absence is itself evidence: a failed Vitest run with no record failed
 * before any fixture initialized. A directory holding artifacts but no record
 * belongs to a lifecycle that never finalized, usually a killed run.
 *
 * A malformed or unknown-version record is a triage failure, not grounds for
 * inference or silent omission.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

// Must match E2E_ARTIFACT_DIR in test/integration/e2e.sh and
// test/integration/run-constrained-vitest.sh.
export const E2E_FIXTURE_ARTIFACT_DIRECTORY = 'vitest-fixture';
export const E2E_FIXTURE_RECORD_ARTIFACT = 'fixture-record';
export const E2E_FIXTURE_RECORD_FILE = `${E2E_FIXTURE_RECORD_ARTIFACT}.json`;

const fixtureArtifactSchema = z
  .string()
  .min(1)
  .refine((value) => basename(value) === value, {
    message: 'artifact must be a basename within the fixture directory',
  });

export const E2EFixtureRecordSchema = z.strictObject({
  version: z.literal(1),
  testName: z.string().min(1),
  runId: z.string().regex(/^[A-Za-z0-9]+$/u),
  outcome: z.enum(['passed', 'failed']),
  failures: z.array(z.string()),
  workloads: z.array(
    z.strictObject({
      id: z.string().min(1),
      status: z.enum(['found', 'absent', 'error']),
      artifacts: z.array(fixtureArtifactSchema),
    }),
  ),
  diagnosticErrors: z.array(
    z.strictObject({
      workloadId: z.string().min(1),
      operation: z.string().min(1),
      error: z.string(),
    }),
  ),
});

export type E2EFixtureRecord = z.infer<typeof E2EFixtureRecordSchema>;

export interface E2EFixtureRecordEntry {
  /** Fixture artifact directory, relative to the results directory. */
  readonly directory: string;
  readonly record: E2EFixtureRecord;
}

export interface E2EFixtureEvidence {
  readonly entries: readonly E2EFixtureRecordEntry[];
  /** Fixture directories whose lifecycle never wrote its record. */
  readonly incompleteDirectories: readonly string[];
}

export function parseE2EFixtureRecord(raw: unknown): E2EFixtureRecord {
  return E2EFixtureRecordSchema.parse(raw);
}

export function readE2EFixtureEvidence(outDir: string): E2EFixtureEvidence {
  const root = join(outDir, E2E_FIXTURE_ARTIFACT_DIRECTORY);
  if (!existsSync(root)) return { entries: [], incompleteDirectories: [] };

  const entries: E2EFixtureRecordEntry[] = [];
  const incompleteDirectories: string[] = [];
  const children = readdirSync(root, { withFileTypes: true })
    .filter((child) => child.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const directory = `${E2E_FIXTURE_ARTIFACT_DIRECTORY}/${child.name}`;
    const file = join(root, child.name, E2E_FIXTURE_RECORD_FILE);
    if (!existsSync(file)) {
      incompleteDirectories.push(directory);
      continue;
    }
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    entries.push({ directory, record: parseE2EFixtureRecord(raw) });
  }

  return { entries, incompleteDirectories };
}
