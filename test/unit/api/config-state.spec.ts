import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('API config state initialization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTempDir();
    vi.resetModules();
    vi.stubEnv('ANYCLOUD_DIR', tempDir);
    vi.stubEnv('CIPHER_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates and persists a cipher key on first run', async () => {
    const config = (await import('../../../src/api/config.js')).default;
    const keyPath = join(tempDir, 'cipher.key');

    expect(config.cipherKey).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, 'utf-8').trim()).toBe(config.cipherKey);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('reuses a persisted cipher key', async () => {
    const keyPath = join(tempDir, 'cipher.key');
    const key = 'a'.repeat(64);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(keyPath, key);

    const config = (await import('../../../src/api/config.js')).default;

    expect(config.cipherKey).toBe(key);
  });

  it('re-tightens a key restored with the sync default modes', async () => {
    const keyPath = join(tempDir, 'cipher.key');
    const key = 'b'.repeat(64);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(keyPath, key);
    // A restore rebuilds the state directory from object storage, which carries
    // no file modes, so both land world-readable.
    chmodSync(tempDir, 0o755);
    chmodSync(keyPath, 0o644);

    const config = (await import('../../../src/api/config.js')).default;

    expect(config.cipherKey).toBe(key);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(tempDir).mode & 0o777).toBe(0o700);
  });

  it('refuses to generate a new key when an existing DB has no key file', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'api.db'), '');

    await expect(import('../../../src/api/config.js')).rejects.toThrow(
      /refusing to generate a new key because SQLite DB exists/,
    );
  });
});

function mkTempDir(): string {
  return join(
    tmpdir(),
    `anycloud-config-state-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}
