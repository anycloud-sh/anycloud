import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, onTestFinished, test } from 'vitest';

import {
  buildDownloadManifest,
  buildUploadManifest,
  writeStreamAtomically,
} from '../../src/cli/commands/bucket/batch.js';
import type { BucketEntry } from '../../src/shared/api-contract/bucket-metadata-schemas.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import type {
  JobBucketRef,
  JobBucketTransferOptions,
} from '../integration/e2e/internal/job-cloud-storage.js';
import { JOB_BUCKET_MOLECULES } from '../integration/e2e/internal/targets/job-profiles.js';
import { prepareJobTransfers } from '../integration/e2e/internal/transports/job-transfers.js';

async function fixture(
  fault?:
    | 'contents'
    | 'mode'
    | 'collision-side-effect'
    | 'prefix-leak'
    | 'sibling',
) {
  const root = await mkdtemp(path.join(tmpdir(), 'job-transfers-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const inputShape: Readonly<Pick<JobBucketRef, 'name'>> = {
    name: 'job-transfer-input',
  };
  const input = inputShape as JobBucketRef;
  const objects = new Map<string, Buffer>();
  const commands: {
    operation: string;
    args: readonly string[];
    options: JobBucketTransferOptions;
  }[] = [];
  const deadlineAt = Date.now() + 60_000;
  const entries = (prefix: string, recursive: boolean): BucketEntry[] => {
    const result = new Map<string, BucketEntry>();
    for (const [key, value] of objects) {
      if (!key.startsWith(prefix)) continue;
      const slash = key.slice(prefix.length).indexOf('/');
      if (!recursive && slash >= 0) {
        const nested = key.slice(0, prefix.length + slash + 1);
        result.set(nested, { kind: 'prefix', key: nested });
      } else
        result.set(key, {
          kind: 'object',
          key,
          sizeBytes: value.length,
          lastModifiedAt: null,
        });
    }
    return [...result.values()];
  };
  const storage: Parameters<typeof prepareJobTransfers>[0] = {
    buckets: async () => [input.name],
    entries: async (ref, prefix, recursive) => {
      expect(ref).toBe(input);
      return entries(prefix ?? '', recursive);
    },
    transfer: async (ref, operation, args, deadline, options = {}) => {
      expect(ref).toBe(input);
      expect(deadline).toBe(deadlineAt);
      commands.push({ operation, args, options });
      const recursive = options.recursive === true;
      if (operation === 'upload') {
        if (recursive) {
          for (const item of await buildUploadManifest(args[0], args[1]))
            objects.set(item.key, await readFile(item.localPath));
        } else objects.set(args[1], await readFile(args[0]));
      } else if (operation === 'rm') {
        if (fault !== 'prefix-leak')
          for (const key of objects.keys())
            if (key.startsWith(args[0])) objects.delete(key);
        if (fault === 'sibling')
          objects.delete('recursive-keep-run-1/sibling.txt');
      } else {
        const downloads = recursive
          ? await buildDownloadManifest(
              entries(args[0], true).filter((entry) => entry.kind === 'object'),
              args[0],
              args[1],
            )
          : [{ kind: 'file', key: args[0], localPath: args[1] }];
        for (const item of downloads) {
          if (item.kind === 'directory') {
            await mkdir(item.localPath, { recursive: true });
          } else {
            const contents = objects.get(item.key);
            if (!contents) throw new Error('Test object is absent');
            const bytes =
              fault === 'contents' ? Buffer.from('wrong') : contents;
            await writeStreamAtomically(
              Readable.from([bytes]),
              item.localPath,
              bytes.length,
            );
            if (fault === 'mode') await chmod(item.localPath, 0o777);
          }
        }
      }
    },
    rejectsFileDirectoryCollision: async (ref, prefix, destination) => {
      expect(ref).toBe(input);
      try {
        await buildDownloadManifest(
          entries(prefix, true).filter((entry) => entry.kind === 'object'),
          prefix,
          destination,
        );
        return false;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('file/directory collision')
        )
          throw error;
        if (fault === 'collision-side-effect')
          await writeFile(path.join(destination, 'partial'), 'left behind');
        return true;
      }
    },
  };
  return {
    objects,
    commands,
    run: (recursive: boolean) =>
      prepareJobTransfers(
        storage,
        input,
        new FixtureFiles(root),
        'run-1',
        recursive,
        deadlineAt,
      ),
  };
}

describe('Job CLI transfer fixture with real public batch file operations', () => {
  test('preserves contents, modes, hidden files, collision preflight and sibling objects', async () => {
    const world = await fixture();
    expect(await world.run(true)).toEqual({
      listedBucket: true,
      rootObject: true,
      nestedPrefix: true,
      literalPrefix: true,
      recursiveObjects: true,
      recursive: {
        rootContents: true,
        nestedContents: true,
        hiddenContents: true,
        existingMode: true,
        newMode: true,
        singleContents: true,
        singleMode: true,
        collisions: true,
        deletedPrefix: true,
        retainedSibling: true,
      },
    });
    expect([...world.objects.keys()].sort()).toEqual([
      'molecules.json',
      'nested/molecules.json',
      'recursive-keep-run-1/sibling.txt',
    ]);
    expect(JSON.parse(world.objects.get('molecules.json')!.toString())).toEqual(
      JOB_BUCKET_MOLECULES,
    );
    for (const command of world.commands.filter(
      (entry) => entry.options.recursive,
    )) {
      expect(command.options.concurrency).toBe('2');
      if (command.operation === 'rm') expect(command.options.yes).toBe(true);
    }
  });

  test('keeps the declared nonrecursive cross-cloud baseline without extra file mutations', async () => {
    const world = await fixture();
    const result = await world.run(false);
    expect(result.recursive).toBeUndefined();
    expect(Object.values(result)).toEqual([true, true, true, true, true]);
    expect(world.commands.map((command) => command.operation)).toEqual([
      'upload',
      'upload',
    ]);
    expect([...world.objects.keys()]).toEqual([
      'molecules.json',
      'nested/molecules.json',
    ]);
  });

  test.each([
    ['contents', 'nestedContents'],
    ['mode', 'existingMode'],
    ['collision-side-effect', 'collisions'],
    ['prefix-leak', 'deletedPrefix'],
    ['sibling', 'retainedSibling'],
  ] as const)(
    'reports the actual %s failure instead of returning successful facts',
    async (fault, assertion) => {
      const world = await fixture(fault);
      expect((await world.run(true)).recursive?.[assertion]).toBe(false);
    },
  );
});
