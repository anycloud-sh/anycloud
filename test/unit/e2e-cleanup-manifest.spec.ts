import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, onTestFinished, test, vi } from 'vitest';

import { CleanupManifest } from '../integration/e2e/internal/cleanup-manifest.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    appendFile: vi.fn(original.appendFile),
    readFile: vi.fn(original.readFile),
    writeFile: vi.fn(original.writeFile),
  };
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cleanup-manifest-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'resources-to-clean');
  return { file, manifest: new CleanupManifest(file) };
}

describe('cleanup manifests', () => {
  test('keeps concurrent releases and a new reservation through a paused write', async () => {
    const original =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const { file, manifest } = await fixture();
    await manifest.add('first');
    await manifest.add('second');
    vi.clearAllMocks();

    let startWrite!: () => void;
    let resumeWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      startWrite = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      startWrite();
      await resumed;
      await original.writeFile(...args);
    });

    const first = manifest.remove('first');
    await writing;
    const second = manifest.remove('second');
    const reservation = manifest.add('third');
    try {
      // Both removals would otherwise read the old contents, and the paused
      // write would overwrite any reservation appended in the meantime.
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(appendFile).not.toHaveBeenCalled();
    } finally {
      resumeWrite();
      await Promise.all([first, second, reservation]);
    }
    expect(await original.readFile(file, 'utf8')).toBe('third\n');
  });

  test.each(['read', 'write'] as const)(
    'reports a failed %s without losing registrations or poisoning the queue',
    async (operation) => {
      const { file, manifest } = await fixture();
      await manifest.add('first');
      const error = Object.assign(new Error('manifest unavailable'), {
        code: 'EACCES',
      });
      if (operation === 'read') {
        vi.mocked(readFile).mockRejectedValueOnce(error);
      } else {
        vi.mocked(writeFile).mockRejectedValueOnce(error);
      }

      const release = manifest.remove('first');
      const reservation = manifest.add('second');
      await expect(release).rejects.toBe(error);
      await reservation;
      expect(await readFile(file, 'utf8')).toBe('first\nsecond\n');
    },
  );

  test('accepts an absent manifest and persists a later reservation', async () => {
    const { file, manifest } = await fixture();
    await manifest.remove('missing');
    await manifest.add('new');
    expect(await readFile(file, 'utf8')).toBe('new\n');
  });
});
