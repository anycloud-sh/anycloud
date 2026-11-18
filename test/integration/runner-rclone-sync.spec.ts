import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rcloneCopy } from '../../src/runner/transfer.js';
import { pinnedRclone } from './helpers/pinned-rclone.js';

describe('staging inputs with the pinned rclone', () => {
  // Owner decision 5: unchanged inputs survive to the next Job's staging,
  // changed ones are re-copied and files a Job added are removed.
  it('keeps unchanged inputs, re-copies changed ones and removes added files', async () => {
    const copy = rcloneCopy(await pinnedRclone());
    const root = mkdtempSync(join(tmpdir(), 'runner-input-'));
    const bucket = join(root, 'bucket');
    const input = join(root, 'input');
    mkdirSync(bucket);
    writeFileSync(join(bucket, 'kept'), 'kept');
    writeFileSync(join(bucket, 'changed'), 'v1');

    await expect(copy(bucket, input, {}, true)).resolves.toMatchObject({
      result: 'done',
    });
    const kept = statSync(join(input, 'kept')).ino;
    writeFileSync(join(input, 'added'), 'from the last Job');
    writeFileSync(join(bucket, 'changed'), 'v2, longer');

    await expect(copy(bucket, input, {}, true)).resolves.toMatchObject({
      result: 'done',
    });
    expect(statSync(join(input, 'kept')).ino).toBe(kept);
    expect(readFileSync(join(input, 'changed'), 'utf8')).toBe('v2, longer');
    expect(existsSync(join(input, 'added'))).toBe(false);
  }, 120_000);
});
