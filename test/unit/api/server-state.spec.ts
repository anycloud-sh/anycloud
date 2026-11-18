import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

describe('API server SQLite state initialization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTempDir();
    vi.resetModules();
    vi.stubEnv('ANYCLOUD_DIR', tempDir);
    vi.stubEnv('CIPHER_KEY', 'a'.repeat(64));
    vi.stubEnv('SQLITE_PATH', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults SQLite to api.db under ANYCLOUD_DIR', async () => {
    const { initializeSqlitePathForServer } = await import(
      '../../../src/api/server.js'
    );

    initializeSqlitePathForServer();

    expect(process.env.SQLITE_PATH).toBe(join(tempDir, 'api.db'));
    expect(existsSync(tempDir)).toBe(true);
  });

  it('migrates the legacy conductor.db filename before startup', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'conductor.db'), 'legacy');
    const { initializeSqlitePathForServer } = await import(
      '../../../src/api/server.js'
    );

    initializeSqlitePathForServer();

    expect(existsSync(join(tempDir, 'api.db'))).toBe(true);
    expect(existsSync(join(tempDir, 'conductor.db'))).toBe(false);
  });

  it('creates the parent directory for an explicit SQLite path', async () => {
    const sqlitePath = join(tempDir, 'nested', 'api.db');
    vi.stubEnv('SQLITE_PATH', sqlitePath);
    const { initializeSqlitePathForServer } = await import(
      '../../../src/api/server.js'
    );

    initializeSqlitePathForServer();

    expect(process.env.SQLITE_PATH).toBe(sqlitePath);
    expect(existsSync(dirname(sqlitePath))).toBe(true);
  });

  it('rejects a loopback workload callback origin for a hosted API', async () => {
    const { validateHostedWorkloadApiUrl } = await import(
      '../../../src/api/server.js'
    );

    for (const url of ['http://localhost:8080', 'http://0.0.0.0:8080']) {
      expect(() => validateHostedWorkloadApiUrl(true, url)).toThrow(
        /externally reachable/,
      );
    }
  });

  it('accepts a public hosted origin and local API loopback', async () => {
    const { validateHostedWorkloadApiUrl } = await import(
      '../../../src/api/server.js'
    );

    expect(() =>
      validateHostedWorkloadApiUrl(true, 'https://api.example.com'),
    ).not.toThrow();
    expect(() =>
      validateHostedWorkloadApiUrl(false, 'http://127.0.0.1:8080'),
    ).not.toThrow();
  });
});

function mkTempDir(): string {
  return join(
    tmpdir(),
    `anycloud-server-state-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}
