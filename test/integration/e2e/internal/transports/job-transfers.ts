import { chmod, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FixtureFiles } from '../files.js';
import type { JobBucketRef, JobCloudStorage } from '../job-cloud-storage.js';
import { JOB_BUCKET_MOLECULES } from '../targets/job-profiles.js';
import type { JobTransferFacts } from '../targets/job-types.js';

/** Exercise the public transfer path with the Bash fixture's contents and modes. */
export async function prepareJobTransfers(
  storage: Pick<
    JobCloudStorage,
    'transfer' | 'buckets' | 'entries' | 'rejectsFileDirectoryCollision'
  >,
  input: JobBucketRef,
  files: Pick<FixtureFiles, 'text' | 'directory'>,
  runLabel: string,
  recursive: boolean,
  deadlineAt: number,
): Promise<JobTransferFacts> {
  const base = `job-transfer-${input.name}`;
  const molecules = await files.text(
    `${base}/molecules.json`,
    JSON.stringify(JOB_BUCKET_MOLECULES),
  );
  await storage.transfer(
    input,
    'upload',
    [molecules, 'molecules.json'],
    deadlineAt,
  );
  await storage.transfer(
    input,
    'upload',
    [molecules, 'nested/molecules.json'],
    deadlineAt,
  );
  const listedBucket = (await storage.buckets(deadlineAt)).includes(input.name);
  const root = await storage.entries(input, undefined, false, deadlineAt);
  const nested = await storage.entries(input, 'nested/', false, deadlineAt);
  const all = await storage.entries(input, undefined, true, deadlineAt);
  const facts = {
    listedBucket,
    rootObject: root.some(
      (entry) => entry.kind === 'object' && entry.key === 'molecules.json',
    ),
    nestedPrefix: root.some(
      (entry) => entry.kind === 'prefix' && entry.key === 'nested/',
    ),
    literalPrefix: nested.some(
      (entry) =>
        entry.kind === 'object' && entry.key === 'nested/molecules.json',
    ),
    recursiveObjects:
      all.every((entry) => entry.kind === 'object') &&
      ['molecules.json', 'nested/molecules.json'].every((key) =>
        all.some((entry) => entry.key === key),
      ),
  };
  if (!recursive) return facts;
  const prefix = `recursive-${runLabel}/`;
  const sibling = `recursive-keep-${runLabel}/sibling.txt`;
  const source = await files.directory(`${base}/source`);
  const download = await files.directory(`${base}/download`);
  const contents = {
    'root.txt': `root-${runLabel}`,
    'nested/value.txt': `nested-${runLabel}`,
    '.hidden': `hidden-${runLabel}`,
  };
  for (const [key, value] of Object.entries(contents))
    await files.text(`${base}/source/${key}`, value);
  const existing = await files.text(`${base}/download/root.txt`, 'stale');
  await chmod(existing, 0o600);
  const single = await files.text(`${base}/single.txt`, 'stale-single');
  await chmod(single, 0o640);
  const expectedMode = 0o666 & ~process.umask();
  await storage.transfer(input, 'upload', [source, prefix], deadlineAt, {
    recursive: true,
    concurrency: '2',
  });
  await storage.transfer(input, 'upload', [molecules, sibling], deadlineAt);
  await storage.transfer(input, 'download', [prefix, download], deadlineAt, {
    recursive: true,
    concurrency: '2',
  });
  const rootContents =
    (await readFile(path.join(download, 'root.txt'), 'utf8')) ===
    contents['root.txt'];
  const nestedContents =
    (await readFile(path.join(download, 'nested/value.txt'), 'utf8')) ===
    contents['nested/value.txt'];
  const hiddenContents =
    (await readFile(path.join(download, '.hidden'), 'utf8')) ===
    contents['.hidden'];
  const existingMode = ((await stat(existing)).mode & 0o777) === 0o600;
  const newMode =
    ((await stat(path.join(download, 'nested/value.txt'))).mode & 0o777) ===
    expectedMode;
  await storage.transfer(
    input,
    'download',
    [`${prefix}root.txt`, single],
    deadlineAt,
  );
  const singleContents =
    (await readFile(single, 'utf8')) === contents['root.txt'];
  const singleMode = ((await stat(single)).mode & 0o777) === 0o640;

  // Both keys are legal in object storage, but cannot share a local file path.
  // Require the specific rejection and an untouched destination, not any error.
  const collisionPrefix = `collision-${runLabel}/`;
  const collisionDestination = await files.directory(`${base}/collision`);
  await storage.transfer(
    input,
    'upload',
    [molecules, `${collisionPrefix}file`],
    deadlineAt,
  );
  await storage.transfer(
    input,
    'upload',
    [molecules, `${collisionPrefix}file/child`],
    deadlineAt,
  );
  const collisions =
    (await storage.rejectsFileDirectoryCollision(
      input,
      collisionPrefix,
      collisionDestination,
      deadlineAt,
    )) && (await readdir(collisionDestination)).length === 0;
  const purge = { recursive: true, yes: true, concurrency: '2' };
  await storage.transfer(input, 'rm', [collisionPrefix], deadlineAt, purge);
  await storage.transfer(input, 'rm', [prefix], deadlineAt, purge);
  const deletedPrefix =
    (await storage.entries(input, prefix, true, deadlineAt)).length === 0 &&
    (await storage.entries(input, collisionPrefix, true, deadlineAt)).length ===
      0;
  const retainedSibling = (
    await storage.entries(
      input,
      `recursive-keep-${runLabel}/`,
      true,
      deadlineAt,
    )
  ).some((entry) => entry.kind === 'object' && entry.key === sibling);
  return {
    ...facts,
    recursive: {
      rootContents,
      nestedContents,
      hiddenContents,
      existingMode,
      newMode,
      singleContents,
      singleMode,
      collisions,
      deletedPrefix,
      retainedSibling,
    },
  };
}
