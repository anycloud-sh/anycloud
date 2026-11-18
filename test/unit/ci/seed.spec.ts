import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '../../..');
const seedEntrypoint = join(projectRoot, 'ci/seed.ts');

describe('seed CLI persistence boundary', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const directory of tmpDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createPaths() {
    const root = mkdtempSync(join(tmpdir(), 'anycloud-seed-cli-'));
    tmpDirs.push(root);
    const anycloudDir = join(root, 'state');
    return {
      root,
      anycloudDir,
      dbPath: join(anycloudDir, 'api.db'),
      keyPath: join(anycloudDir, 'cipher.key'),
      manifestPath: join(root, 'manifest.json'),
    };
  }

  function execute(paths: ReturnType<typeof createPaths>, args: string[]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANYCLOUD_DIR: paths.anycloudDir,
      SQLITE_PATH: paths.dbPath,
    };
    delete env.CIPHER_KEY;
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', seedEntrypoint, ...args],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env,
        timeout: 30_000,
      },
    );
  }

  it('keeps dry-run pure when the state directory does not exist', () => {
    const paths = createPaths();
    const result = execute(paths, [
      'nuke-db',
      '1',
      '--dry-run',
      '--manifest',
      paths.manifestPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('workloads=1');
    expect(result.stdout).toContain('dry_run=true');
    expect(existsSync(paths.anycloudDir)).toBe(false);
    expect(existsSync(paths.keyPath)).toBe(false);
    expect(existsSync(paths.dbPath)).toBe(false);
    expect(existsSync(paths.manifestPath)).toBe(false);
  });

  it('does not load crypto or touch an existing keyless DB during dry-run', () => {
    const paths = createPaths();
    mkdirSync(paths.anycloudDir, { recursive: true });
    const original = Buffer.from('not-opened-by-dry-run');
    writeFileSync(paths.dbPath, original);

    const result = execute(paths, ['nuke-db', '1', '--dry-run']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('dry_run=true');
    expect(readFileSync(paths.dbPath)).toEqual(original);
    expect(existsSync(paths.keyPath)).toBe(false);
  });

  it('loads persistence for a real seed and lets production config create the key', () => {
    const paths = createPaths();
    const result = execute(paths, [
      'nuke-db',
      '1',
      '--seed',
      'boundary-test',
      '--manifest',
      paths.manifestPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`db=${paths.dbPath}`);
    expect(result.stdout).toContain(`manifest=${paths.manifestPath}`);
    expect(readFileSync(paths.keyPath, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(paths.keyPath).size).toBe(64);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths.manifestPath, 'utf8'))).toMatchObject({
      name: 'seed nuke-db',
      counts: { workloads: 1 },
    });

    const db = new Database(paths.dbPath, { readonly: true });
    try {
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM workloads').get(),
      ).toEqual({ count: 1 });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM container_specs').get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
