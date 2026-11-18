import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { LocalJobStorage } from '../integration/e2e/internal/job-local-storage.js';

const clusterRecords: string[] = [];
afterEach(async () => {
  await Promise.all(
    clusterRecords
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'job-storage-')),
  );
  clusterRecords.push(root);
  const cleanup = new CleanupStack();
  const receipts: { name: string; value: unknown }[] = [];
  let childrenAbsent = true;
  const storage = new LocalJobStorage({
    root,
    host: 'http://127.0.0.1:18089',
    cleanup,
    artifacts: {
      json: async (name, value) => {
        receipts.push({ name, value });
        return name;
      },
    },
    childrenAbsent: () => {
      if (!childrenAbsent) throw new Error('child remains');
    },
  });
  return {
    root,
    cleanup,
    receipts,
    storage,
    childrenPresent: () => {
      childrenAbsent = false;
    },
    childrenRemoved: () => {
      childrenAbsent = true;
    },
  };
}

describe('Local Job storage identity and dependency fence', () => {
  test('registers before creation and proves exact absence with a complete root inventory', async () => {
    const world = await harness();
    await world.storage.create('j-input-owned', 'seed');
    expect(world.cleanup.observations()).toEqual([
      { label: 'Local Job bucket j-input-owned', completed: false },
    ]);
    expect(await world.storage.read('j-input-owned', 'seed.txt')).toBe('seed');
    await world.storage.release();
    expect(await readdir(world.root)).toEqual([]);
    expect(world.cleanup.observations()[0].completed).toBe(true);
    expect(world.receipts.at(-1)?.value).toMatchObject({
      inventoryComplete: true,
      absent: true,
      name: 'j-input-owned',
    });
  });

  test('keeps storage registered while any native child is unresolved', async () => {
    const world = await harness();
    await world.storage.create('j-output-owned');
    world.childrenPresent();
    await expect(world.cleanup.run()).rejects.toThrow('child remains');
    expect(await readdir(world.root)).toContain('j-output-owned');
    expect(world.cleanup.observations()[0].completed).toBe(false);
    world.childrenRemoved();
    await world.storage.release();
    expect(await readdir(world.root)).toEqual([]);
  });

  test('does not adopt or delete a foreign directory with a colliding name', async () => {
    const world = await harness();
    await mkdir(path.join(world.root, 'j-input-foreign'));
    await writeFile(
      path.join(world.root, 'j-input-foreign', 'foreign.txt'),
      'keep',
    );
    await expect(world.storage.create('j-input-foreign')).rejects.toThrow();
    await world.cleanup.run();
    expect(
      await readFile(
        path.join(world.root, 'j-input-foreign', 'foreign.txt'),
        'utf8',
      ),
    ).toBe('keep');
  });

  test('retains cleanup when an owned name is replaced by another directory', async () => {
    const world = await harness();
    await world.storage.create('j-checkpoint-owned');
    await rename(
      path.join(world.root, 'j-checkpoint-owned'),
      path.join(world.root, 'original'),
    );
    await mkdir(path.join(world.root, 'j-checkpoint-owned'));
    await expect(world.storage.release()).rejects.toThrow(
      'storage cleanup failed',
    );
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(await readdir(world.root)).toEqual([
      'j-checkpoint-owned',
      'original',
    ]);
  });

  test('rejects symlinked objects and path escapes', async () => {
    const world = await harness();
    await world.storage.create('j-input-owned');
    await writeFile(path.join(world.root, 'foreign.txt'), 'private');
    await symlink(
      path.join(world.root, 'foreign.txt'),
      path.join(world.root, 'j-input-owned', 'link.txt'),
    );
    await expect(
      world.storage.read('j-input-owned', 'link.txt'),
    ).rejects.toThrow('ordinary file');
    await expect(
      world.storage.write('j-input-owned', '../escape.txt', 'data'),
    ).rejects.toThrow('outside');
    await world.storage.release();
    expect(await readFile(path.join(world.root, 'foreign.txt'), 'utf8')).toBe(
      'private',
    );
  });
});
