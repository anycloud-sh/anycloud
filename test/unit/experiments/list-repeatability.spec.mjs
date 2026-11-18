import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Native from 'better-sqlite3';
import { fixtureDigest } from '../../helpers/list-responsiveness/fixture.mjs';
import {
  createFixtureProof,
  verifyFixtureProof,
  validateFixtureAfterDrain,
} from '../../helpers/list-aggregation/fixture-proof.mjs';
import { calibratedComparison } from '../../helpers/list-aggregation/repeatability-evidence.mjs';
import {
  FIXTURE_STORAGE,
  requireFixtureCapacity,
  retainCorrectnessCopy,
  shareClosedFixtureCopy,
} from '../../helpers/list-aggregation/fixture-storage.mjs';

const directories = [];
const databases = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
function input() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'list-fixture-proof-'));
  directories.push(directory);
  const file = path.join(directory, 'input.db');
  const db = new Native(file);
  databases.push(db);
  for (const table of [
    'workloads',
    'container_specs',
    'vms',
    'workload_events',
    'credentials',
  ]) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT)`);
    db.prepare(`INSERT INTO ${table} (value) VALUES (?)`).run(
      'retained-' + table,
    );
  }
  db.exec('CREATE TABLE api_access_policy (id TEXT PRIMARY KEY, owner TEXT)');
  const fixture = { logicalSha256: fixtureDigest({ db }) };
  db.close();
  const proof = createFixtureProof(file, fixture, fixture.logicalSha256);
  return { directory, file, fixture, proof };
}
const drainage = {
  serverDrained: true,
  pendingAfterDrain: {},
  healthDrained: true,
};

describe('isolated fixture validation', () => {
  it('binds a fresh copy to the full logical validation without changing database bytes', () => {
    const { directory, file, fixture, proof } = input();
    const copy = path.join(directory, 'copy.db');
    copyFileSync(file, copy);
    const before = readFileSync(copy);
    expect(verifyFixtureProof(copy, fixture, proof)).toEqual({
      strategy: 'file-proof',
      ...proof,
    });
    const db = new Native(copy);
    databases.push(db);
    expect(validateFixtureAfterDrain({ db }, fixture, drainage)).toMatchObject({
      logicalSha256: fixture.logicalSha256,
      afterHealthDrain: true,
    });
    db.close();
    expect(readFileSync(copy)).toEqual(before);
  });

  it('rejects an altered database and a proof for a different logical fixture', () => {
    const { file, fixture, proof } = input();
    expect(() => createFixtureProof(file, fixture, '0'.repeat(64))).toThrow(
      /Independent preparation/,
    );
    expect(() =>
      verifyFixtureProof(file, { logicalSha256: '0'.repeat(64) }, proof),
    ).toThrow(/another logical fixture/);
    const db = new Native(file);
    db.exec("UPDATE workload_events SET value = 'altered'");
    db.close();
    expect(() => verifyFixtureProof(file, fixture, proof)).toThrow(
      /Fixture copy differs/,
    );
  });

  it('does not accept a missing proof, symbolic database or journal sidecar', () => {
    const { directory, file, fixture, proof } = input();
    expect(() => verifyFixtureProof(file, fixture, undefined)).toThrow(
      /Missing fixture proof/,
    );
    const link = path.join(directory, 'linked.db');
    symlinkSync(file, link);
    expect(() => verifyFixtureProof(link, fixture, proof)).toThrow(
      /regular closed database/,
    );
    for (const suffix of ['-wal', '-shm', '-journal']) {
      writeFileSync(file + suffix, '');
      expect(() => verifyFixtureProof(file, fixture, proof)).toThrow(/sidecar/);
      rmSync(file + suffix);
    }
  });

  it('rejects a regular file that is not a SQLite database', () => {
    const { file, fixture } = input();
    writeFileSync(file, 'this is not a SQLite database');
    expect(() =>
      createFixtureProof(file, fixture, fixture.logicalSha256),
    ).toThrow(/Invalid SQLite/);
  });

  it('checks logical contents again after serving requests', () => {
    const { file, fixture, proof } = input();
    expect(verifyFixtureProof(file, fixture, proof).logicalSha256).toBe(
      fixture.logicalSha256,
    );
    const db = new Native(file);
    databases.push(db);
    db.exec("UPDATE vms SET value = 'changed-during-request'");
    expect(() => validateFixtureAfterDrain({ db }, fixture, drainage)).toThrow(
      /Logical fixture changed/,
    );
  });

  it('cannot run heavy validation before work, handlers and health have drained', () => {
    let touched = false;
    const db = {
      get db() {
        touched = true;
        throw new Error('Unexpected database read');
      },
    };
    for (const invalid of [
      { ...drainage, serverDrained: false },
      { ...drainage, pendingAfterDrain: { handler: 1 } },
      { ...drainage, healthDrained: false },
    ])
      expect(() => validateFixtureAfterDrain(db, {}, invalid)).toThrow(
        /drained|active/,
      );
    expect(touched).toBe(false);
  });
});

describe('calibration admission', () => {
  it('never starts a candidate timing stage after inconclusive or rejected calibration', async () => {
    for (const decision of ['inconclusive', 'reject']) {
      const calls = [];
      const result = await calibratedComparison(async (stage) => {
        calls.push(stage);
        return { decision };
      });
      expect(calls).toEqual(['calibration']);
      expect(result).toEqual({ calibration: { decision }, comparison: null });
    }
  });

  it('starts exactly one comparison after calibration passes and preserves failures', async () => {
    const calls = [];
    const result = await calibratedComparison(async (stage) => {
      calls.push(stage);
      return { decision: stage === 'calibration' ? 'passes' : 'inconclusive' };
    });
    expect(calls).toEqual(['calibration', 'comparison']);
    expect(result.comparison.decision).toBe('inconclusive');
    await expect(
      calibratedComparison(async () => {
        throw new Error('broken accounting');
      }),
    ).rejects.toThrow('broken accounting');
  });
});

describe('bounded fixture storage', () => {
  it('preserves legitimate hosted-policy setup in a private correctness copy', () => {
    const { directory, file, fixture, proof } = input();
    const copy = path.join(directory, 'hosted.db');
    copyFileSync(file, copy);
    const db = new Native(copy);
    db.exec("INSERT INTO api_access_policy VALUES ('api', '77')");
    expect(
      validateFixtureAfterDrain({ db }, fixture, drainage).logicalSha256,
    ).toBe(fixture.logicalSha256);
    db.close();
    const bytes = readFileSync(copy);
    const receipt = retainCorrectnessCopy(copy);
    expect(receipt.database.sha256).not.toBe(proof.database.sha256);
    expect(receipt).toMatchObject({
      strategy: 'retained-correctness-copy',
      sharedAfterExit: false,
    });
    expect(readFileSync(copy)).toEqual(bytes);
    expect(statSync(copy).ino).not.toBe(statSync(file).ino);
  });

  it('retains many closed database paths without accumulating private copies', () => {
    const { directory, file, proof } = input();
    const original = readFileSync(file);
    const copies = Array.from({ length: 28 }, (_, i) =>
      path.join(directory, `trial-${i}.db`),
    );
    for (const copy of copies) {
      // Deliberately use ordinary copies: the hosted runner need not support
      // COPYFILE_FICLONE, which masked unbounded storage on the development Mac.
      copyFileSync(file, copy);
      expect(statSync(copy).ino).not.toBe(statSync(file).ino);
      const db = new Native(copy);
      expect(db.prepare('SELECT COUNT(*) AS count FROM vms').get().count).toBe(
        1,
      );
      db.close();
      expect(shareClosedFixtureCopy(file, copy, proof.database)).toMatchObject({
        database: proof.database,
        independentDuringTrial: true,
        sharedAfterExit: true,
      });
    }
    expect(new Set([file, ...copies].map((f) => statSync(f).ino)).size).toBe(1);
    for (const copy of copies) expect(readFileSync(copy)).toEqual(original);

    const active = path.join(directory, 'active.db');
    copyFileSync(file, active);
    const db = new Native(active);
    db.exec("UPDATE vms SET value = 'changed-live-copy'");
    db.close();
    expect(readFileSync(file)).toEqual(original);
    for (const copy of copies) expect(readFileSync(copy)).toEqual(original);
    const changed = readFileSync(active);
    expect(() => shareClosedFixtureCopy(file, active, proof.database)).toThrow(
      /retain the private copy/,
    );
    expect(readFileSync(active)).toEqual(changed);
  });

  it('refuses an already-shared live copy and preserves sidecars on failure', () => {
    const { directory, file, proof } = input();
    const copy = path.join(directory, 'copy.db');
    copyFileSync(file, copy);
    writeFileSync(copy + '-wal', 'unfinished evidence');
    expect(() => shareClosedFixtureCopy(file, copy, proof.database)).toThrow(
      /sidecar/,
    );
    expect(readFileSync(copy + '-wal', 'utf8')).toBe('unfinished evidence');
    rmSync(copy + '-wal');
    shareClosedFixtureCopy(file, copy, proof.database);
    expect(() => shareClosedFixtureCopy(file, copy, proof.database)).toThrow(
      /independent database copy/,
    );
  });

  it('stops before admission when disk cannot retain a failed copy and reporting reserve', () => {
    const { directory, proof } = input();
    const bytes = proof.database.bytes;
    const minimum =
      bytes * FIXTURE_STORAGE.transientCopies +
      FIXTURE_STORAGE.reportingReserveBytes;
    expect(
      requireFixtureCapacity(directory, bytes, () => ({
        bavail: minimum,
        bsize: 1,
      })),
    ).toEqual({
      availableBytes: minimum,
      requiredBytes: minimum,
      fixtureBytes: bytes,
    });
    expect(() =>
      requireFixtureCapacity(directory, bytes, () => ({
        bavail: minimum - 1,
        bsize: 1,
      })),
    ).toThrow(/no new trial may start/);
    expect(() =>
      requireFixtureCapacity(
        directory,
        FIXTURE_STORAGE.maximumFixtureBytes + 1,
      ),
    ).toThrow(/exceeds the frozen storage budget/);
  });
});
