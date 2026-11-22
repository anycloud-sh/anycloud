import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export {
  seedFixture,
  fixtureDigest,
  BUSINESS_NOW,
  PRIMARY,
  HOUR,
} from '../list-responsiveness/fixture.mjs';
import {
  BUSINESS_NOW,
  fixtureDigest,
} from '../list-responsiveness/fixture.mjs';

const tables = [
  'workloads',
  'container_specs',
  'vms',
  'workload_events',
  'credentials',
];

export function inspectFixture(db, previous) {
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.db.prepare('PRAGMA integrity_check').all(), [
    { integrity_check: 'ok' },
  ]);
  return {
    ...previous,
    now: BUSINESS_NOW,
    counts: Object.fromEntries(
      tables.map((table) => [
        table,
        db.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      ]),
    ),
    logicalSha256: fixtureDigest(db),
    vmShape: db.db
      .prepare(
        `SELECT SUM(ip IS NULL) AS nullIp,
      SUM(ip IS NOT NULL) AS withIp, SUM(ip = '') AS emptyIp,
      SUM(ended_at IS NULL) AS live FROM vms`,
      )
      .get(),
  };
}

export function deepenFixture(db, previous) {
  assert.equal(previous.profile, 'ip-heavy');
  const rows = db.db
    .prepare(
      `SELECT workload_id, credential_id, MIN(created_at) AS earliest,
    region, vm_type FROM vms WHERE ip IS NULL GROUP BY workload_id`,
    )
    .all();
  const insert = db.db.prepare(`INSERT INTO vms
    (workload_id, cloud_id, ip, created_at, ended_at, credential_id, region, vm_type, price_per_hour, cost)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, 0)`);
  db.db.transaction(() => {
    for (const row of rows)
      for (let i = 0; i < 127; i++) {
        const at = row.earliest - 3_600_000;
        insert.run(
          row.workload_id,
          row.workload_id + '-aggregation-placeholder-' + i,
          at,
          at,
          row.credential_id,
          row.region,
          row.vm_type,
        );
      }
  })();
  return inspectFixture(db, {
    ...previous,
    profile: 'ip-heavy-depth',
    depth: {
      parentLogicalSha256: previous.logicalSha256,
      addedRows: rows.length * 127,
      addedPerWorkload: 127,
    },
  });
}

// The source migrations rename Workload/Deployment record ownership. Compare
// every retained column by its old name, including encrypted bytes, before and
// after normal migration; newly introduced columns belong to the new manifest.
export function retainedProjection(native, descriptors, renamed = false) {
  const hashes = {};
  for (const { table, columns } of descriptors) {
    const mappedTable = renamed
      ? ({
          deployments: 'workloads',
          deployment_events: 'workload_events',
          workers: 'deployments',
        }[table] ?? table)
      : table;
    const mappedColumn = (column) => {
      if (!renamed) return column;
      if (column === 'worker_id') return 'deployment_id';
      if (column === 'deployment_id') return 'workload_id';
      if (column === 'deployment_type') return 'workload_type';
      return column;
    };
    const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
    const select = columns
      .map((column) => quote(mappedColumn(column)) + ' AS ' + quote(column))
      .join(', ');
    const hash = createHash('sha256');
    let count = 0;
    for (const row of native
      .prepare(`SELECT ${select} FROM ${quote(mappedTable)} ORDER BY rowid`)
      .iterate()) {
      hash.update(JSON.stringify(row) + '\n');
      count++;
    }
    hashes[table] = { count, sha256: hash.digest('hex') };
  }
  return hashes;
}
