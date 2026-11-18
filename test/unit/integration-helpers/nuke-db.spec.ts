import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '../../..');
const helperPath = join(projectRoot, 'test/integration/helpers/nuke-db.sh');

let fixtureDir: string;
let dbPath: string;
let db: Database.Database;

const callVmInvariant = (...workloadIds: string[]) =>
  spawnSync(
    'bash',
    [
      '-c',
      `
        print_info() { printf '%s\\n' "$*"; }
        print_warning() { printf '%s\\n' "$*" >&2; }
        fail() { printf '%s\\n' "$*" >&2; return 1; }
        source "$1"
        export SQLITE_PATH="$2"
        shift 2
        nuke_assert_workloads_vms_ended \
          "test completed overlay" \
          "$(date +%s)" \
          "$@"
      `,
      'bash',
      helperPath,
      dbPath,
      ...workloadIds,
    ],
    { encoding: 'utf-8' },
  );

const callApiFallback = (waitExitCode: number) =>
  spawnSync(
    'bash',
    [
      '-c',
      `
        print_info() { printf '%s\\n' "$*"; }
        print_warning() { printf '%s\\n' "$*" >&2; }
        fail() { printf '%s\\n' "$*" >&2; return 1; }
        wait_for_workloads_no_live_vms_until() {
          printf 'api-wait:%s:%s\\n' "$1" "$2"
          return "$API_WAIT_EXIT_CODE"
        }
        source "$1"
        unset SQLITE_PATH ANYCLOUD_DIR
        nuke_assert_workloads_vms_ended \
          "test API overlay" \
          123 \
          dep-api
      `,
      'bash',
      helperPath,
    ],
    {
      encoding: 'utf-8',
      env: { ...process.env, API_WAIT_EXIT_CODE: String(waitExitCode) },
    },
  );

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'nuke-db-invariant-'));
  dbPath = join(fixtureDir, 'api.db');
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE vms (
      workload_id TEXT NOT NULL,
      ip TEXT,
      cloud_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    )
  `);
});

afterEach(() => {
  db.close();
  rmSync(fixtureDir, { force: true, recursive: true });
});

describe('nuke VM invariant', () => {
  it('passes when every selected workload has ended its VM rows', () => {
    db.prepare(
      `INSERT INTO vms
       (workload_id, ip, cloud_id, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('nuke-run-1', '10.0.0.1', 'vm-ended', 1, 2);
    db.prepare(
      `INSERT INTO vms
       (workload_id, ip, cloud_id, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('unrelated-running', '10.0.0.2', 'vm-unrelated', 1, null);

    const result = callVmInvariant('nuke-run-1');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('test completed overlay VM invariant ok');
  });

  it('fails when a selected workload retains a live VM row', () => {
    db.prepare(
      `INSERT INTO vms
       (workload_id, ip, cloud_id, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('nuke-run-1', '10.0.0.1', 'vm-live', 1, null);

    const result = callVmInvariant('nuke-run-1');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'test completed overlay VM invariant failed',
    );
    expect(result.stderr).toContain('nuke-run-1:vm-live');
  });

  it('passes cleanly when there are no workload IDs', () => {
    const result = callVmInvariant();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no workloads');
  });

  it('falls back to the API provisioning ledger without a local database', () => {
    const result = callApiFallback(0);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('api-wait:123:dep-api');
    expect(result.stdout).toContain('test API overlay VM invariant ok');
  });

  it('fails when the API provisioning ledger cannot confirm cleanup', () => {
    const result = callApiFallback(1);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('api-wait:123:dep-api');
    expect(result.stderr).toContain('test API overlay VM invariant failed');
  });
});

describe('nuke-db.sh syntax', () => {
  it('parses without error', () => {
    const result = spawnSync('bash', ['-n', helperPath], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
  });
});
