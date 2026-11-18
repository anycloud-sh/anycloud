import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostedApiIdentity } from '../../../src/shared/hosted-api-identity.js';

import {
  bindDatabaseApiIdentity,
  parseApiIdentityStamp,
  resetApiIdentityForTest,
  resolveApiIdentity,
} from '../../../src/api/services/api-identity.js';
import { ApiOwnershipStore } from '../../../src/api/services/api-ownership-store.js';
import { createDatabase } from '../../../src/api/services/repositories/db.js';
import type { CloseableDB } from '../../../src/api/services/repositories/db.js';

const HOSTED_A = hostedApiIdentity('hosted-a');
const HOSTED_B = hostedApiIdentity('hosted-b');
const FOREIGN = 'ffffffffffffffffffffffffffffffff';

/**
 * Identity lives only in the database. A local API has nothing to compare a
 * stamp against, so it takes whatever it finds; a hosted API derives its own
 * value from WORKLOAD_ID every boot, which is what makes disagreement
 * detectable there and only there.
 */
describe('API identity', () => {
  let tempDir: string;
  let open: CloseableDB[];

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `anycloud-api-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    open = [];
    resetApiIdentityForTest();
  });

  afterEach(() => {
    for (const db of open) db.close();
    resetApiIdentityForTest();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Open the named database, reusing the file across reopens. */
  async function openDb(name: string): Promise<CloseableDB> {
    vi.stubEnv('SQLITE_PATH', join(tempDir, name));
    const db = createDatabase();
    await db.init?.();
    open.push(db);
    return db;
  }

  async function reopen(name: string): Promise<CloseableDB> {
    resetApiIdentityForTest();
    return openDb(name);
  }

  async function stampValue(db: CloseableDB): Promise<string | undefined> {
    const rows = await db.query<{ value: string }>(
      'SELECT value FROM _metadata WHERE key = ?',
      ['api_identity'],
    );
    return rows[0]?.value;
  }

  async function writeStamp(db: CloseableDB, value: string): Promise<void> {
    await db.query(
      `INSERT INTO _metadata (key, value) VALUES ('api_identity', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value],
    );
  }

  it('derives a stable hosted identity from the workload id', () => {
    expect(resolveApiIdentity({ hosted: true, workloadId: 'hosted-a' })).toBe(
      HOSTED_A,
    );
    expect(HOSTED_A).toMatch(/^[0-9a-f]{32}$/);
    expect(HOSTED_A).toBe('d423ad73325061e6bf79ba74e825068b');
    expect(HOSTED_B).not.toBe(HOSTED_A);
    expect(() => resolveApiIdentity({ hosted: true })).toThrow(
      'requires WORKLOAD_ID',
    );
  });

  it('gives a local API no identity of its own to compare against', () => {
    expect(resolveApiIdentity({ hosted: false })).toBeUndefined();
  });

  it('mints an identity for a local database that carries none', async () => {
    const db = await openDb('local-new.db');

    await expect(bindDatabaseApiIdentity(db)).resolves.toEqual({
      newlyBound: true,
    });
    expect(await stampValue(db)).toMatch(/^v1:[0-9a-f]{32}$/);
  });

  it('reuses the identity a local database already carries', async () => {
    const first = await openDb('local-reuse.db');
    await bindDatabaseApiIdentity(first);
    const minted = await stampValue(first);
    first.close();

    const second = await reopen('local-reuse.db');
    await expect(bindDatabaseApiIdentity(second)).resolves.toEqual({
      newlyBound: false,
    });
    expect(await stampValue(second)).toBe(minted);
  });

  it('adopts a stamp a local API did not write, having nothing to refuse it with', async () => {
    // The file that used to provide a second opinion is gone, so this is the
    // deliberate trade: local cannot detect a copied database, and the cipher
    // key remains what actually protects the credentials inside it.
    const db = await openDb('local-foreign.db');
    await writeStamp(db, `v1:${FOREIGN}`);

    await expect(bindDatabaseApiIdentity(db)).resolves.toEqual({
      newlyBound: false,
    });
    expect(await stampValue(db)).toBe(`v1:${FOREIGN}`);
  });

  it('upgrades a local stamp written before schemes were recorded', async () => {
    const db = await openDb('local-bare.db');
    await writeStamp(db, FOREIGN);

    await bindDatabaseApiIdentity(db);

    expect(await stampValue(db)).toBe(`v1:${FOREIGN}`);
  });

  it('refuses a local stamp it cannot read', async () => {
    const db = await openDb('local-scheme.db');
    await writeStamp(db, `v2:${FOREIGN}`);

    await expect(bindDatabaseApiIdentity(db)).rejects.toThrow(/scheme v2/i);
  });

  it('stamps a hosted database that carries none', async () => {
    const db = await openDb('hosted-new.db');

    await expect(bindDatabaseApiIdentity(db, HOSTED_A)).resolves.toEqual({
      newlyBound: true,
    });
    expect(await stampValue(db)).toBe(`v1:${HOSTED_A}`);
  });

  it('accepts a hosted database stamped by the same workload', async () => {
    const first = await openDb('hosted-same.db');
    await bindDatabaseApiIdentity(first, HOSTED_A);
    first.close();

    const second = await reopen('hosted-same.db');
    await expect(bindDatabaseApiIdentity(second, HOSTED_A)).resolves.toEqual({
      newlyBound: false,
    });
  });

  it('accepts and upgrades a hosted stamp written before schemes were recorded', async () => {
    const db = await openDb('hosted-bare.db');
    await writeStamp(db, HOSTED_A);

    await bindDatabaseApiIdentity(db, HOSTED_A);

    expect(await stampValue(db)).toBe(`v1:${HOSTED_A}`);
  });

  it('refuses a hosted database stamped by a different API', async () => {
    const first = await openDb('hosted-copied.db');
    await bindDatabaseApiIdentity(first, HOSTED_A);
    first.close();

    const second = await reopen('hosted-copied.db');
    await expect(bindDatabaseApiIdentity(second, HOSTED_B)).rejects.toThrow(
      /copied from another/i,
    );
  });

  it('tells a hosted scheme change apart from a copied database', async () => {
    // The two need different remedies, so they must not read the same.
    const db = await openDb('hosted-scheme.db');
    await writeStamp(db, `v2:${HOSTED_A}`);

    await expect(bindDatabaseApiIdentity(db, HOSTED_A)).rejects.toThrow(
      /scheme v2/i,
    );
    await expect(bindDatabaseApiIdentity(db, HOSTED_A)).rejects.not.toThrow(
      /copied from another/i,
    );
  });

  it('refuses to change identity part-way through a process', async () => {
    const db = await openDb('hosted-swap.db');
    await bindDatabaseApiIdentity(db, HOSTED_A);

    await expect(bindDatabaseApiIdentity(db, HOSTED_B)).rejects.toThrow(
      /identity changed/i,
    );
  });

  it('leaves the ownership backfill seed readable after binding', async () => {
    // seedLegacyTargets records the owning identity in a row of its own and
    // refuses to run under a different one.
    const db = await openDb('hosted-seed.db');
    await bindDatabaseApiIdentity(db, HOSTED_A);
    const store = new ApiOwnershipStore(db);

    await expect(store.seedLegacyTargets(HOSTED_A)).resolves.toBeTypeOf(
      'number',
    );
    await expect(store.seedLegacyTargets(HOSTED_A)).resolves.toBe(0);
  });

  it('records the scheme with every stamp it writes', async () => {
    const db = await openDb('scheme-recorded.db');

    await bindDatabaseApiIdentity(db, HOSTED_A);

    const stamp = await stampValue(db);
    expect(stamp).toBeDefined();
    expect(parseApiIdentityStamp(stamp!)).toEqual({
      scheme: 'v1',
      identity: HOSTED_A,
    });
  });
});
