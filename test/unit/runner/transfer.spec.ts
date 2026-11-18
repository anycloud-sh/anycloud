import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rcloneCopy } from '../../../src/runner/transfer.js';

/** A fake rclone: runs `body` in sh with the copy's env. */
function fakeRclone(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'fake-rclone-')), 'rclone');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** As rclone does, print stats only when they are logged at NOTICE. */
const stats = (bytes: number | string) =>
  `case " $* " in *" --stats-log-level NOTICE "*) echo "{\\"stats\\":{\\"bytes\\":${bytes}}}" >&2;; esac`;

describe('rcloneCopy', () => {
  it('passes the grant env and the shipped CA bundle only to rclone, and copies or syncs', async () => {
    const rclone = fakeRclone(
      '[ "$1" = "${VERB:-copy}" ] && [ "$KEY" = value ] && [ -z "$ANYCLOUD_SECRET" ] && [ "$SSL_CERT_FILE" = "$(dirname "$0")/ca-certificates.crt" ] || exit 1',
    );
    process.env.ANYCLOUD_SECRET = 'leak';
    try {
      await expect(
        rcloneCopy(rclone)('a', 'b', { KEY: 'value' }),
      ).resolves.toEqual({
        result: 'done',
        detail: 'rclone exited with code 0',
        moved: false,
      });
      await expect(
        rcloneCopy(rclone)('a', 'b', { KEY: 'value', VERB: 'sync' }, true),
      ).resolves.toMatchObject({ result: 'done' });
    } finally {
      delete process.env.ANYCLOUD_SECRET;
    }
  });

  it('classifies a missing directory, a denied read and other failures, redacting query strings', async () => {
    const copy = (body: string) => rcloneCopy(fakeRclone(body))('a', 'b', {});
    expect((await copy('exit 3')).result).toBe('missing');
    expect(
      await copy(
        `echo '{"level":"error","msg":"GET https://acct.blob.core.windows.net/c?sig=secret: 403 AuthorizationFailure"}' >&2; exit 1`,
      ),
    ).toEqual({
      result: 'denied',
      detail:
        'GET https://acct.blob.core.windows.net/c?… 403 AuthorizationFailure',
      moved: false,
    });
    expect((await copy('exit 5')).result).toBe('failed');
  });

  it('0043/S19 retries a copy whose grant lapsed: a GCS token past its expiry, fatal in rclone, and S3 ExpiredToken', async () => {
    const copy = (body: string) => rcloneCopy(fakeRclone(body))('a', 'b', {});
    // rclone 1.68's own lines for a GCS token past its `expiry`.
    const gcs = await copy(
      `echo '{"level":"error","msg":"Get \\"https://storage.googleapis.com/storage/v1/b/b/o\\": token expired and there is no refresh token"}' >&2; echo '{"level":"error","msg":"Fatal error received - not attempting retries"}' >&2; exit 7`,
    );
    expect(gcs.result).toBe('failed');
    const s3 = await copy(
      `echo '{"level":"error","msg":"operation error S3: PutObject, https response error StatusCode: 400, api error ExpiredToken: The provided token has expired."}' >&2; exit 1`,
    );
    expect(s3.result).toBe('failed');
    // A forged or revoked S3 token stays denied.
    const forged = await copy(
      `echo '{"level":"error","msg":"StatusCode: 403, api error InvalidAccessKeyId"}' >&2; exit 1`,
    );
    expect(forged.result).toBe('denied');
  });

  it('stops a copy that makes no progress and keeps one that does', async () => {
    const stalled = rcloneCopy(fakeRclone(`${stats(1)}; sleep 5`), 300);
    await expect(stalled('a', 'b', {})).resolves.toMatchObject({
      result: 'stalled',
      moved: true,
    });

    // Half a second of copying, with progress more often than the limit.
    const progressing = rcloneCopy(
      fakeRclone(`for n in 1 2 3 4 5; do ${stats('$n')}; sleep 0.1; done`),
      300,
    );
    await expect(progressing('a', 'b', {})).resolves.toMatchObject({
      result: 'done',
    });
  });
});
