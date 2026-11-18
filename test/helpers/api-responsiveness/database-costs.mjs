import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

async function readIndexes(db) {
  return db.query(
    "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
  );
}

export async function storageSnapshot(db) {
  const [{ page_count: pages }] = await db.query(
    'SELECT * FROM pragma_page_count',
  );
  const [{ page_size: pageSize }] = await db.query(
    'SELECT * FROM pragma_page_size',
  );
  const [{ version: sqliteVersion }] = await db.query(
    'SELECT sqlite_version() AS version',
  );
  return {
    bytes: pages * pageSize,
    sqliteVersion,
    journalMode: (await db.query('SELECT * FROM pragma_journal_mode'))[0],
    synchronous: (await db.query('SELECT * FROM pragma_synchronous'))[0],
    indexes: await readIndexes(db),
  };
}

/** Time the real added/changed index DDL on the migrated fixture, then roll back. */
export async function measureIndexCreation(db, baselineIndexes) {
  const indexes = await readIndexes(db);
  const previous = new Map(baselineIndexes.map(({ name, sql }) => [name, sql]));
  const changed = indexes.filter(({ name, sql }) => previous.get(name) !== sql);
  const measurements = [];
  if (changed.length) {
    const rollback = new Error('Roll back index-cost probe');
    try {
      await db.transaction((tx) => {
        for (const { name, sql } of changed) {
          tx.query('DROP INDEX "' + name.replaceAll('"', '""') + '"');
          const started = performance.now();
          tx.query(sql);
          measurements.push({
            name,
            sql,
            createMs: performance.now() - started,
          });
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    assert.deepEqual(
      await readIndexes(db),
      indexes,
      'Index probe did not roll back',
    );
  }
  return {
    method:
      'rebuild added/changed indexes on the migrated fixture; rollback excludes commit/fsync',
    indexes: measurements,
    totalCreateMs: measurements.reduce((sum, index) => sum + index.createMs, 0),
    committed: false,
  };
}
