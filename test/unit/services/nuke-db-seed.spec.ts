import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NUKE_DB_SHAPE,
  createNukeDbSeedPlan,
  deriveNukeDbCounts,
  seedNukeDb,
} from '../../../ci/seed/nuke-db.js';
import {
  ACTIVE_STATES,
  WorkloadState,
  TERMINAL_STATES,
} from '../../../src/shared/workload.js';
import { formatSessionDisplay } from '../../../src/shared/session-display.js';

describe('seed nuke-db', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seeds terminal history as already cleaned, leaving no cleanup backlog', async () => {
    // The cleanup lane admits any terminal workload whose cleaned_at is null.
    // Seeding thousands of those made every run measure a control plane stuck
    // in permanent teardown — a shape no live API has — instead of the long
    // history the seed exists to provide.
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-nuke-db-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'cleaned.db');
    await seedNukeDb({
      dbPath,
      workloads: 60,
      seed: 'cleaned-history',
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS count FROM workloads
           WHERE state IN (${TERMINAL_STATES.map(() => '?').join(', ')})
             AND completed_at IS NOT NULL
             AND cleaned_at IS NULL`,
        )
        .get(...TERMINAL_STATES) as { count: number };
      expect(pending.count).toBe(0);

      const ordering = db
        .prepare(
          `SELECT COUNT(*) AS count FROM workloads
           WHERE cleaned_at IS NOT NULL AND cleaned_at < completed_at`,
        )
        .get() as { count: number };
      expect(ordering.count).toBe(0);

      const active = db
        .prepare(
          `SELECT COUNT(*) AS count FROM workloads
           WHERE completed_at IS NULL AND cleaned_at IS NOT NULL`,
        )
        .get() as { count: number };
      expect(active.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('derives event and historical VM row counts from workload count constants', () => {
    expect(deriveNukeDbCounts(NUKE_DB_SHAPE.baselineWorkloads)).toMatchObject({
      workloads: 3700,
      events: 529000,
      historicalVmRows: 3200,
    });
    expect(deriveNukeDbCounts(500)).toMatchObject({
      workloads: 500,
      events: Math.round((500 * 529000) / 3700),
      historicalVmRows: Math.round((500 * 3200) / 3700),
    });
  });

  it('creates deterministic plans for a fixed workload count and seed', () => {
    const first = createNukeDbSeedPlan({
      workloads: 25,
      seed: 'deterministic-unit-seed',
      now: 1_700_000_000_000,
    });
    const second = createNukeDbSeedPlan({
      workloads: 25,
      seed: 'deterministic-unit-seed',
      now: 1_700_000_000_000,
    });

    expect(second).toEqual(first);
    expect(first.eventCounts.reduce((sum, count) => sum + count, 0)).toBe(
      first.counts.events,
    );
    expect(first.historicalVmWorkloadIndexes).toHaveLength(
      first.counts.historicalVmRows,
    );
    expect(first.heavyStatusWorkloadIds.length).toBeGreaterThan(0);
  });

  it('creates a heavy status probe target for tiny seed sizes', () => {
    const plan = createNukeDbSeedPlan({
      workloads: 1,
      seed: 'tiny-seed',
      now: 1_700_000_000_000,
    });

    expect(plan.heavyStatusWorkloadIds).toEqual([plan.workloadIds[0]]);
    expect(plan.historicalVmWorkloadIndexes).toHaveLength(
      plan.counts.historicalVmRows,
    );
  });

  it('only creates terminal current workload states', () => {
    const plan = createNukeDbSeedPlan({
      workloads: NUKE_DB_SHAPE.baselineWorkloads,
      seed: 'terminal-only-seed',
      now: 1_700_000_000_000,
    });

    expect(plan.states.every((state) => TERMINAL_STATES.includes(state))).toBe(
      true,
    );
    expect(countStates(plan.states, ACTIVE_STATES)).toBe(0);
    expect(countStates(plan.states, [WorkloadState.Queued])).toBe(0);
    for (const id of plan.heavyStatusWorkloadIds) {
      const index = plan.workloadIds.indexOf(id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(TERMINAL_STATES).toContain(plan.states[index]);
    }
  });

  it('seeds a SQLite DB with exact manifest counts and valid foreign keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-nuke-db-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'api.db');

    const manifest = await seedNukeDb({
      dbPath,
      workloads: 12,
      seed: 'unit-db-seed',
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(count(db, 'workloads')).toBe(manifest.counts.workloads);
      expect(count(db, 'container_specs')).toBe(manifest.counts.workloads);
      expect(count(db, 'workload_events')).toBe(manifest.counts.events);
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM vms WHERE ip IS NOT NULL')
          .get(),
      ).toEqual({ count: manifest.counts.historicalVmRows });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM vms WHERE ip IS NULL').get(),
      ).toEqual({ count: manifest.counts.failedVmAttempts });
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM vms WHERE ended_at IS NULL')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM workloads
             WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')})`,
          )
          .get(...TERMINAL_STATES),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM workloads
             WHERE submitted_at IS NULL OR submitted_at != started_at`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('replaces previous synthetic seed rows on repeated runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-nuke-db-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'api.db');

    await seedNukeDb({
      dbPath,
      workloads: 8,
      seed: 'replace-seed',
    });
    const manifest = await seedNukeDb({
      dbPath,
      workloads: 9,
      seed: 'replace-seed',
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(count(db, 'workloads')).toBe(manifest.counts.workloads);
      expect(count(db, 'workload_events')).toBe(manifest.counts.events);
      expect(count(db, 'vms')).toBe(
        manifest.counts.historicalVmRows + manifest.counts.failedVmAttempts,
      );
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('assigns varied, deterministic session attribution across the pool', () => {
    const first = createNukeDbSeedPlan({
      workloads: 200,
      seed: 'attribution-seed',
      now: 1_700_000_000_000,
    });
    const second = createNukeDbSeedPlan({
      workloads: 200,
      seed: 'attribution-seed',
      now: 1_700_000_000_000,
    });

    expect(second.sessions).toEqual(first.sessions);
    expect(first.sessions).toHaveLength(first.counts.workloads);
    // More than one agent is represented, and a human/untagged (null) bucket exists.
    expect(new Set(first.sessions.map((s) => s.agent)).size).toBeGreaterThan(1);
    expect(
      first.sessions.some((s) => s.session === null && s.agent === null),
    ).toBe(true);
  });

  it('records a session breakdown whose counts sum to the workload total', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-nuke-db-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'api.db');

    const manifest = await seedNukeDb({
      dbPath,
      workloads: 240,
      seed: 'attribution-db-seed',
    });

    const total = manifest.sessions.reduce(
      (sum, s) => sum + s.workloadCount,
      0,
    );
    expect(total).toBe(manifest.counts.workloads);

    // displayForm mirrors the SESSION column: label, else agent:<6char> for long
    // ids, else '-' for the null (human/untagged) bucket.
    const labeled = manifest.sessions.find((s) => s.sessionLabel);
    expect(labeled?.displayForm).toBe(labeled?.sessionLabel);
    const unlabeledLongId = manifest.sessions.find(
      (s) => s.agent && !s.sessionLabel && (s.session?.length ?? 0) > 12,
    );
    expect(unlabeledLongId?.displayForm).toBe(
      `${unlabeledLongId?.agent}:${unlabeledLongId?.session?.slice(0, 6)}`,
    );
    const nullBucket = manifest.sessions.find((s) => s.session === null);
    expect(nullBucket?.displayForm).toBe('-');
    expect(nullBucket?.workloadCount ?? 0).toBeGreaterThan(0);
  });

  it('uses the shared session formatter for manifest display forms', async () => {
    const manifest = await seedNukeDb({
      dbPath: ':memory:',
      dryRun: true,
      workloads: 60,
      seed: 'displayform-seed',
    });

    for (const s of manifest.sessions) {
      const expected =
        formatSessionDisplay({
          session: s.session,
          agent: s.agent,
          sessionLabel: s.sessionLabel,
        }) ?? '-';
      expect(s.displayForm).toBe(expected);
    }
  });

  it('persists the assigned attribution on seeded rows (id-prefixed for cleanup)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-nuke-db-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'api.db');

    const manifest = await seedNukeDb({
      dbPath,
      workloads: 240,
      seed: 'attribution-rows-seed',
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      // Every seeded row is id-prefixed (the cleanup sentinel after Step 0).
      expect(count(db, 'workloads', "id NOT LIKE 'nuke-db-%'")).toBe(0);
      // Per-session DB counts match the manifest breakdown.
      for (const s of manifest.sessions) {
        const where = s.session === null ? 'session IS NULL' : 'session = ?';
        const params = s.session === null ? [] : [s.session];
        expect(count(db, 'workloads', where, params)).toBe(s.workloadCount);
      }
    } finally {
      db.close();
    }
  });

  it('uses synthetic, PII-scrubbed row values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-nuke-db-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'api.db');

    await seedNukeDb({
      dbPath,
      workloads: 8,
      seed: 'pii-scrub-seed',
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      const workloadText = JSON.stringify(
        db
          .prepare(
            `SELECT d.id, d.user_id, s.image, d.docker_command, d.output_bucket,
                    d.credential_id, d.session, d.agent, d.session_label
             FROM workloads d JOIN container_specs s ON s.workload_id = d.id`,
          )
          .all(),
      );
      const vmText = JSON.stringify(
        db.prepare('SELECT ip, cloud_id, region, vm_type FROM vms').all(),
      );
      const eventText = JSON.stringify(
        db.prepare('SELECT metadata FROM workload_events').all(),
      );
      const allText = `${workloadText}\n${vmText}\n${eventText}`;

      expect(allText).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

      const ips = db
        .prepare('SELECT DISTINCT ip FROM vms WHERE ip IS NOT NULL')
        .all()
        .map((row) => (row as { ip: string }).ip);
      expect(ips.length).toBeGreaterThan(0);
      for (const ip of ips) {
        expect(ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
      }
    } finally {
      db.close();
    }
  });
});

function count(
  db: Database.Database,
  table: string,
  where?: string,
  params: unknown[] = [],
): number {
  const sql = `SELECT COUNT(*) AS count FROM ${table}${
    where ? ` WHERE ${where}` : ''
  }`;
  return (
    db.prepare(sql).get(...params) as {
      count: number;
    }
  ).count;
}

function countStates(
  states: WorkloadState[],
  targets: readonly WorkloadState[],
): number {
  return states.filter((state) => targets.includes(state)).length;
}
