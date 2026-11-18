import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkloadState } from '../../../src/shared/workload.js';

const bridge = resolve('test/integration/helpers/workload-fixture-cli.ts');

describe('workload fixture shell bridge', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'anycloud-workload-fixture-'));
    databasePath = join(directory, 'api.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists the workload, shared spec and durable owner from a subprocess', () => {
    const seeded = spawnSync(process.execPath, ['--import', 'tsx', bridge], {
      encoding: 'utf8',
      input: JSON.stringify({
        id: 'shell-fixture',
        userId: 'captured-user',
        ownerUserId: 'durable-owner',
        image: 'example/shell:latest',
        state: WorkloadState.Terminated,
      }),
      timeout: 15_000,
      env: {
        ...process.env,
        ANYCLOUD_DIR: directory,
        ANYCLOUD_TEST_DB_TEMPLATE_PATH: '',
        CIPHER_KEY: 'a'.repeat(64),
        IS_TEST: 'true',
        SQLITE_PATH: databasePath,
      },
    });
    expect(seeded.status, seeded.stderr).toBe(0);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db
          .prepare(
            `
          SELECT d.id, d.user_id, d.owner_user_id, d.state,
                 s.workload_id, s.deployment_id, s.image
          FROM workloads d
          LEFT JOIN container_specs s ON s.workload_id = d.id
        `,
          )
          .all(),
      ).toEqual([
        {
          id: 'shell-fixture',
          user_id: 'captured-user',
          owner_user_id: 'durable-owner',
          state: WorkloadState.Terminated,
          workload_id: 'shell-fixture',
          deployment_id: null,
          image: 'example/shell:latest',
        },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
