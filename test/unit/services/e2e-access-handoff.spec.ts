import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E2E_ACCESS_KUBECONFIG_KEY,
  handOffE2eAccess,
  waitForFile,
} from '../../../src/api/services/e2e-access-handoff.js';

describe('e2e access hand-off (test-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-access-'));
  afterEach(() => rmSync(join(dir, 'kubeconfig'), { force: true }));

  it('copies the host’s kubeconfig into the bucket, then deletes it, and copies nothing on a restart', async () => {
    const path = join(dir, 'kubeconfig');
    writeFileSync(path, 'apiVersion: v1\nkind: Config\n');
    const uploads: { bucket: string; key: string; body: string }[] = [];
    const storage = {
      uploadObject: async (
        bucket: string,
        key: string,
        source: { kind: string; bytes?: Buffer },
      ) => void uploads.push({ bucket, key, body: source.bytes!.toString() }),
    };
    await expect(
      handOffE2eAccess({ path, bucket: 'prod-1', storage }),
    ).resolves.toBe('copied');
    expect(uploads).toEqual([
      {
        bucket: 'prod-1',
        key: E2E_ACCESS_KUBECONFIG_KEY,
        body: 'apiVersion: v1\nkind: Config\n',
      },
    ]);
    expect(E2E_ACCESS_KUBECONFIG_KEY).toBe('e2e/access-kubeconfig');
    expect(existsSync(path)).toBe(false);
    await expect(
      handOffE2eAccess({ path, bucket: 'prod-1', storage }),
    ).resolves.toBe('absent');
    expect(uploads).toHaveLength(1);
  });

  it('keeps the host’s copy when the upload fails, for the next start', async () => {
    const path = join(dir, 'kubeconfig');
    writeFileSync(path, 'k');
    await expect(
      handOffE2eAccess({
        path,
        bucket: 'prod-1',
        storage: {
          uploadObject: async () => {
            throw new Error('AccessDenied');
          },
        },
      }),
    ).rejects.toThrow('AccessDenied');
    expect(existsSync(path)).toBe(true);
  });

  it('waits for the boot script to write the kubeconfig, and gives up after its budget', async () => {
    const path = join(dir, 'kubeconfig');
    let sleeps = 0;
    const waiting = waitForFile(path, async () => {
      sleeps += 1;
      if (sleeps === 2) writeFileSync(path, 'k');
    });
    await expect(waiting).resolves.toBeUndefined();
    expect(sleeps).toBe(2);
    await expect(
      waitForFile(join(dir, 'never'), async () => {}, 3),
    ).rejects.toThrow('never appeared');
  });
});
