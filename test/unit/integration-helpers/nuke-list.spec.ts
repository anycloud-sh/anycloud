import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '../../..');
const helperPath = join(projectRoot, 'test/integration/helpers/nuke-list.sh');

let fixtureDir: string;
let snapshotPath: string;

const callHelper = (body: string) =>
  spawnSync(
    'bash',
    [
      '-c',
      `
        fail() { printf '%s\\n' "$*" >&2; return 1; }
        API_URL="http://unused"
        PROJECT_ROOT="/tmp/unused"
        TEST_RUN="test-run"
        NUKE_COUNT=1
        source "$1"
        SNAPSHOT_PATH="$3"
        eval "$2"
      `,
      'bash',
      helperPath,
      body,
      snapshotPath,
    ],
    { encoding: 'utf-8' },
  );

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'nuke-list-helper-'));
  snapshotPath = join(fixtureDir, 'snapshot.json');
});

afterEach(() => {
  rmSync(fixtureDir, { force: true, recursive: true });
});

describe('nuke list helpers', () => {
  it('fails a strict snapshot when the list request fails', () => {
    const result = callHelper(`
      node() {
        printf 'simulated list failure\\n' >&2
        return 42
      }
      nuke_list_snapshot "completion measurement" "$SNAPSHOT_PATH"
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('simulated list failure');
    expect(result.stderr).toContain(
      'completion measurement: nuke list request failed',
    );
  });

  it('keeps the explicit best-effort wrapper non-fatal for cleanup', () => {
    const result = callHelper(`
      node() { return 42; }
      nuke_list_json_best_effort
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[]');
  });

  it('bounds the best-effort cleanup request with the seeded DB timeout', () => {
    const result = callHelper(`
      NUKE_DB_TIMEOUT_MS=321
      nuke_db_run_with_timeout() {
        printf '%s\\n' "$1" > "$SNAPSHOT_PATH"
        return 124
      }
      nuke_list_json_best_effort
      cat "$SNAPSHOT_PATH"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['[]', '321']);
  });

  it('writes and validates a successful list snapshot', () => {
    const result = callHelper(`
      node() {
        printf '%s\\n' '[{"id":"nuke-test-run-1","state":"running"}]'
      }
      nuke_list_snapshot "completion measurement" "$SNAPSHOT_PATH"
    `);

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(snapshotPath, 'utf-8'))).toEqual([
      { id: 'nuke-test-run-1', state: 'running' },
    ]);
  });

  it('rejects malformed successful output', () => {
    const result = callHelper(`
      node() { printf '%s\\n' '{bad'; }
      nuke_list_snapshot "completion measurement" "$SNAPSHOT_PATH"
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'completion measurement: nuke list returned malformed or non-array JSON',
    );
  });
});

describe('nuke-list.sh syntax', () => {
  it('parses without error', () => {
    const result = spawnSync('bash', ['-n', helperPath], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
  });
});
