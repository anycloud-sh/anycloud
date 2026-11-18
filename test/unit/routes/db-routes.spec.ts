import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';

// Set SQLITE_PATH before any module that opens a connection loads. The
// The repository's readonly handle is module-scoped and resolves the path lazily
// on first request, so this stub must land before any request fires —
// `vi.stubEnv` at module top accomplishes that.
const tmpDir = mkdtempSync(join(tmpdir(), 'anycloud-db-routes-'));
vi.stubEnv('SQLITE_PATH', join(tmpDir, 'test.db'));

import { createApp } from '../../../src/api/server.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { getDB, resetDB } from '../../../src/api/services/repositories/db.js';
import { createTestWorkload } from '../utils.js';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import { testAuthenticate } from '../../helpers/test-authentication.js';

const TEST_PORT = 8788;
const BASE = `http://localhost:${TEST_PORT}`;
const ACCESS_TOKEN = 'mock-github-token';

let server: Server | null = null;

beforeAll(async () => {
  resetDB();
  resetPersistence();
  await getDB().init?.();
  const app = createApp({ authenticate: testAuthenticate });
  await new Promise<void>((resolve) => {
    server = app.listen(TEST_PORT, () => {
      server!.keepAliveTimeout = 0;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  // Wipe workloads and credentials between tests so seeded fixtures
  // don't leak. The workloads table has an FK to credentials, so order
  // matters.
  await getDB().query('DELETE FROM workloads');
  await getDB().query('DELETE FROM credentials');
});

async function postQuery(body: unknown, auth = true): Promise<Response> {
  return fetch(`${BASE}/v1/database/queries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
      ...(auth ? { Authorization: `Bearer ${ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function getSchema(
  options: { auth?: boolean; table?: string } = { auth: true },
): Promise<Response> {
  const headers: Record<string, string> = {
    [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
  };
  if (options.auth) headers.Authorization = `Bearer ${ACCESS_TOKEN}`;
  const url = options.table
    ? `${BASE}/v1/database/schema?table=${encodeURIComponent(options.table)}`
    : `${BASE}/v1/database/schema`;
  return fetch(url, { method: 'GET', headers });
}

describe('POST /v1/database/queries', () => {
  it('returns 401 without a Bearer token', async () => {
    const res = await postQuery({ sql: 'SELECT 1' }, false);
    expect(res.status).toBe(401);
  });

  it('rejects DELETE with 400 and the allowed-keyword error', async () => {
    const res = await postQuery({
      sql: 'DELETE FROM workloads',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/SELECT/);
    expect(body.message).toMatch(/DELETE/);
  });

  it('rejects UPDATE with 400', async () => {
    const res = await postQuery({
      sql: "UPDATE workloads SET state='x'",
    });
    expect(res.status).toBe(400);
  });

  it('readonly handle refuses mutating WITH...DELETE', async () => {
    // `WITH ... DELETE` is a SQLite form where the outer statement is a
    // DELETE — it bypasses the SELECT-prefix check. The readonly handle
    // must keep the row intact regardless of how the response surfaces.
    await createTestWorkload('with-delete-victim', 'test-user');
    const attack = await postQuery({
      sql: 'WITH x AS (SELECT 1) DELETE FROM workloads',
    });
    expect(attack.ok).toBe(false);

    // Verify via a clean SELECT that the row is still there.
    const check = await postQuery({
      sql: "SELECT id FROM workloads WHERE id = 'with-delete-victim'",
    });
    expect(check.status).toBe(200);
    const body = (await check.json()) as { rowCount: number };
    expect(body.rowCount).toBe(1);
  });

  it('returns rows for a SELECT', async () => {
    await createTestWorkload('seed-row-1', 'test-user');
    const res = await postQuery({
      sql: "SELECT id FROM workloads WHERE id = 'seed-row-1'",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string }>;
      rowCount: number;
      truncated: boolean;
    };
    expect(body.rowCount).toBe(1);
    expect(body.rows[0].id).toBe('seed-row-1');
    expect(body.truncated).toBe(false);
  });

  it('accepts PRAGMA', async () => {
    const res = await postQuery({
      sql: 'PRAGMA table_info(workloads)',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ name: string }> };
    const colNames = body.rows.map((r) => r.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('state');
  });
});

describe('GET /v1/database/schema', () => {
  it('returns 401 without Bearer token', async () => {
    const res = await getSchema({ auth: false });
    expect(res.status).toBe(401);
  });

  it('returns all tables with column info', async () => {
    const res = await getSchema();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tables: Array<{ name: string; columns: Array<{ name: string }> }>;
    };
    const names = body.tables.map((t) => t.name);
    expect(names).toContain('workloads');
    expect(names).toContain('workload_events');
    const workloads = body.tables.find((t) => t.name === 'workloads')!;
    expect(workloads.columns.length).toBeGreaterThan(0);
    expect(workloads.columns.map((c) => c.name)).toContain('id');
  });

  it('filters to a single table when ?table= is set', async () => {
    const res = await getSchema({ auth: true, table: 'workloads' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tables: Array<{
        name: string;
        foreignKeys: Array<{ column: string }>;
      }>;
    };
    expect(body.tables.length).toBe(1);
    expect(body.tables[0].name).toBe('workloads');
    expect(Array.isArray(body.tables[0].foreignKeys)).toBe(true);
  });
});
