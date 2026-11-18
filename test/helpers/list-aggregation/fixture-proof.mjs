import assert from 'node:assert/strict';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { hashFile } from './evidence.mjs';
import { fixtureDigest } from '../list-responsiveness/fixture.mjs';

// A closed, independently validated seed binds the logical fixture to exact
// bytes. Checking its copy does not materialize millions of rows in the API's
// V8 heap before the first request. The API repeats logical validation only
// after both work and health have drained.
export function closedDatabaseIdentity(file) {
  const stat = lstatSync(file);
  assert(stat.isFile(), 'Fixture must be a regular closed database');
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert(!existsSync(file + suffix), 'Unexpected fixture sidecar: ' + suffix);
  const header = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  try {
    assert.equal(readSync(fd, header, 0, header.length, 0), header.length);
  } finally {
    closeSync(fd);
  }
  assert.equal(
    header.toString(),
    'SQLite format 3\0',
    'Invalid SQLite fixture',
  );
  return { bytes: stat.size, sha256: hashFile(file) };
}

export function createFixtureProof(file, fixture, validatedLogicalSha256) {
  assert.match(fixture.logicalSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    validatedLogicalSha256,
    fixture.logicalSha256,
    'Independent preparation did not validate this logical fixture',
  );
  return {
    version: 1,
    logicalSha256: validatedLogicalSha256,
    database: closedDatabaseIdentity(file),
  };
}

export function verifyFixtureProof(file, fixture, proof) {
  assert.equal(proof?.version, 1, 'Missing fixture proof');
  assert.equal(
    proof.logicalSha256,
    fixture.logicalSha256,
    'Proof belongs to another logical fixture',
  );
  assert.deepEqual(
    closedDatabaseIdentity(file),
    proof.database,
    'Fixture copy differs from the independently validated database',
  );
  return { strategy: 'file-proof', ...proof };
}

export function validateFixtureAfterDrain(db, fixture, drainage) {
  assert.equal(drainage.serverDrained, true, 'Work has not drained');
  assert.deepEqual(drainage.pendingAfterDrain, {}, 'Handlers remain active');
  assert.equal(drainage.healthDrained, true, 'Health has not drained');
  const started = performance.now();
  const logicalSha256 = fixtureDigest(db);
  assert.equal(
    logicalSha256,
    fixture.logicalSha256,
    'Logical fixture changed during the HTTP trial',
  );
  assert.deepEqual(db.db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.db.pragma('integrity_check'), [
    { integrity_check: 'ok' },
  ]);
  return {
    logicalSha256,
    elapsedMs: performance.now() - started,
    afterHealthDrain: true,
  };
}
