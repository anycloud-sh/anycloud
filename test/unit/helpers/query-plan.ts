import BetterSqlite3 from 'better-sqlite3';
import { vi } from 'vitest';
import type { DB } from '../../../src/api/services/repositories/db.js';

export function explainQueryPlan(
  dbFile: string,
  sql: string,
  params: unknown[] = [],
): string[] {
  const db = new BetterSqlite3(dbFile, { readonly: true });
  try {
    return db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => String((row as { detail: unknown }).detail));
  } finally {
    db.close();
  }
}

/** Index-name-only assertions accept `SCAN ... USING INDEX`; this does not. */
export function searchesIndex(details: string[], indexName: string): boolean {
  const escaped = indexName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\bSEARCH\\b.*\\bUSING (?:COVERING )?INDEX ${escaped}\\b`,
  );
  return details.some((detail) => pattern.test(detail));
}

/** Record the statements `db.read()` snapshots run, shaped like a query spy. */
export function spyOnReadQueries(db: DB): {
  mock: { calls: [string, unknown[] | undefined][] };
} {
  const calls: [string, unknown[] | undefined][] = [];
  // A second spy on the same method would wrap itself; start from the original.
  if (vi.isMockFunction(db.read)) vi.mocked(db.read).mockRestore();
  const read = db.read.bind(db);
  vi.spyOn(db, 'read').mockImplementation((fn) =>
    read((reader) =>
      fn({
        query: (sql, params) => {
          calls.push([sql, params]);
          return reader.query(sql, params);
        },
      }),
    ),
  );
  return { mock: { calls } };
}
