import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { closedDatabaseIdentity } from './fixture-proof.mjs';

export const FIXTURE_STORAGE = {
  version: 1,
  maximumFixtureBytes: 1024 ** 3,
  maximumCorrectnessBytes: 16 * 1024 ** 2,
  privateCorrectnessCopies: 6,
  reportingReserveBytes: 2 * 1024 ** 3,
  transientCopies: 4,
  strategy:
    'share identical closed mixed/user copies; retain small correctness copies privately; independently copy every live trial',
};

export function requireFixtureCapacity(
  directory,
  fixtureBytes = FIXTURE_STORAGE.maximumFixtureBytes,
  inspect = statfsSync,
) {
  assert(
    Number.isSafeInteger(fixtureBytes) &&
      fixtureBytes > 0 &&
      fixtureBytes <= FIXTURE_STORAGE.maximumFixtureBytes,
    'Fixture exceeds the frozen storage budget',
  );
  const fs = inspect(directory);
  const availableBytes = fs.bavail * fs.bsize;
  const requiredBytes =
    fixtureBytes * FIXTURE_STORAGE.transientCopies +
    FIXTURE_STORAGE.reportingReserveBytes;
  assert(
    Number.isSafeInteger(availableBytes) && availableBytes >= requiredBytes,
    `Insufficient fixture disk headroom: ${availableBytes} available, ${requiredBytes} required; no new trial may start`,
  );
  return { availableBytes, requiredBytes, fixtureBytes };
}

export function retainCorrectnessCopy(copy) {
  const database = closedDatabaseIdentity(copy);
  assert(
    database.bytes <= FIXTURE_STORAGE.maximumCorrectnessBytes,
    'Correctness copy exceeds the reporting reserve',
  );
  return {
    version: FIXTURE_STORAGE.version,
    strategy: 'retained-correctness-copy',
    database,
    independentDuringTrial: true,
    sharedAfterExit: false,
  };
}

// The child has exited and completed all logical/HTTP validation. Keep every
// closed database path and byte while sharing storage with the immutable seed.
// COPYFILE_FICLONE alone cannot guarantee this on filesystems without reflinks.
export function shareClosedFixtureCopy(seed, copy, expectedDatabase) {
  assert.notEqual(path.resolve(seed), path.resolve(copy));
  const original = closedDatabaseIdentity(seed);
  assert.deepEqual(original, expectedDatabase, 'The retained seed changed');
  assert.deepEqual(
    closedDatabaseIdentity(copy),
    original,
    'Closed trial bytes differ from the seed; retain the private copy',
  );
  const seedStat = statSync(seed);
  const copyStat = statSync(copy);
  assert.equal(seedStat.dev, copyStat.dev, 'Fixture copies cross filesystems');
  assert.notEqual(
    seedStat.ino,
    copyStat.ino,
    'A live trial must have used an independent database copy',
  );
  const temporary = copy + '.closed-seed-link';
  assert(!existsSync(temporary), 'Do not replace an existing storage receipt');
  linkSync(seed, temporary);
  try {
    renameSync(temporary, copy);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const shared = statSync(copy);
  assert.equal(shared.dev, seedStat.dev);
  assert.equal(shared.ino, seedStat.ino);
  return {
    version: FIXTURE_STORAGE.version,
    strategy: 'identical-closed-copy',
    database: original,
    independentDuringTrial: true,
    sharedAfterExit: true,
  };
}
