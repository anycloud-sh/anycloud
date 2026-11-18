import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { expect } from 'vitest';
import {
  RCLONE_VERSION,
  RUNTIME_ARTIFACTS_BY_HOST_ARCH,
} from '../../../src/api/runtime-artifacts.js';

/** The one entry of a zip archive whose name ends with `suffix`. */
function unzipEntry(zip: Buffer, suffix: string): Buffer {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let entry = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const nameLength = zip.readUInt16LE(entry + 28);
    const name = zip.toString('utf8', entry + 46, entry + 46 + nameLength);
    if (name.endsWith(suffix)) {
      const size = zip.readUInt32LE(entry + 20);
      const local = zip.readUInt32LE(entry + 42);
      const data =
        local +
        30 +
        zip.readUInt16LE(local + 26) +
        zip.readUInt16LE(local + 28);
      const body = zip.subarray(data, data + size);
      return zip.readUInt16LE(entry + 10) === 8 ? inflateRawSync(body) : body;
    }
    entry +=
      46 +
      nameLength +
      zip.readUInt16LE(entry + 30) +
      zip.readUInt16LE(entry + 32);
  }
  throw new Error(`no ${suffix} in the archive`);
}

/** The pinned rclone the runner ships, fetched once and checked by digest. */
export async function pinnedRclone(): Promise<string> {
  const dir = join(tmpdir(), `anycloud-test-rclone-${RCLONE_VERSION}`);
  const path = join(dir, 'rclone');
  if (existsSync(path)) return path;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const { url, sha256 } = RUNTIME_ARTIFACTS_BY_HOST_ARCH[arch].rclone;
  const zip = Buffer.from(await (await fetch(url)).arrayBuffer());
  expect(createHash('sha256').update(zip).digest('hex')).toBe(sha256);
  mkdirSync(dir, { recursive: true });
  // Renamed into place, so a concurrent or interrupted run never sees half.
  const part = `${path}.${process.pid}`;
  writeFileSync(part, unzipEntry(zip, '/rclone'));
  chmodSync(part, 0o755);
  renameSync(part, path);
  return path;
}
