import type {
  DbQueryResponse,
  DbSchemaResponse,
} from '../../shared/api-contract/database-schemas.js';
import type { User } from './entities.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

const MAX_ROWS = 10_000;

export function firstKeyword(sql: string): string {
  let remaining = sql;
  for (;;) {
    const before = remaining;
    remaining = remaining.replace(/^\s+/, '');
    if (remaining.startsWith('--')) {
      const newline = remaining.indexOf('\n');
      remaining = newline === -1 ? '' : remaining.slice(newline + 1);
    } else if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/');
      remaining = end === -1 ? '' : remaining.slice(end + 2);
    }
    if (remaining === before) break;
  }
  const match = remaining.match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : '';
}

export const READ_ONLY_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'PRAGMA',
]);

export class InvalidDbQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDbQueryError';
  }
}

export interface DatabaseDomain {
  query(
    actor: User,
    sql: string,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<DbQueryResponse>;
  schema(
    actor: User,
    table: string | undefined,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<DbSchemaResponse>;
}

interface ReadOnlyStatement {
  readonly reader: boolean;
  iterate(): Iterable<unknown>;
  all(): unknown[];
}

export interface ReadOnlyDatabase {
  prepare(sql: string): ReadOnlyStatement;
}

export interface DatabaseDomainDependencies {
  getDatabase(): Promise<ReadOnlyDatabase>;
  recordEvent(
    actor: Pick<User, 'username'>,
    event: string,
    properties?: Record<string, unknown>,
  ): void;
  now(): number;
}

export function createDatabaseDomain(
  dependencies: DatabaseDomainDependencies,
): DatabaseDomain {
  return {
    async query(actor, sql, clientVersion, signal) {
      const startTime = dependencies.now();
      let rowCount = 0;
      let failureMessage: string | undefined;
      try {
        signal?.throwIfAborted();
        if (!sql.trim()) throw new InvalidDbQueryError('sql is required');
        const keyword = firstKeyword(sql);
        if (!READ_ONLY_KEYWORDS.has(keyword)) {
          throw new InvalidDbQueryError(
            `Only SELECT, WITH, EXPLAIN, and PRAGMA statements are allowed (got ${keyword || 'empty'})`,
          );
        }

        const db = await dependencies.getDatabase();
        const statement = db.prepare(sql);
        const rows: Record<string, unknown>[] = [];
        let truncated = false;
        if (statement.reader) {
          for (const row of statement.iterate()) {
            if (rows.length >= MAX_ROWS) {
              truncated = true;
              break;
            }
            rows.push(row as Record<string, unknown>);
          }
        } else {
          rows.push(...(statement.all() as Record<string, unknown>[]));
        }
        rowCount = rows.length;
        signal?.throwIfAborted();
        return { rows, rowCount, truncated };
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'db_query', {
          version: clientVersion,
          durationMs: dependencies.now() - startTime,
          rowCount,
          ...(failureMessage && { error: failureMessage }),
        });
      }
    },

    async schema(actor, table, clientVersion, signal) {
      const startTime = dependencies.now();
      let failureMessage: string | undefined;
      try {
        signal?.throwIfAborted();
        const db = await dependencies.getDatabase();
        const objects = db
          .prepare(
            `SELECT name, type FROM sqlite_master
             WHERE type IN ('table', 'view')
               AND name NOT LIKE 'sqlite_%'
               AND name != '_migrations'
             ORDER BY name`,
          )
          .all() as Array<{ name: string; type: 'table' | 'view' }>;

        const tables: DbSchemaResponse['tables'] = objects
          .filter((object) => !table || object.name === table)
          .map((object) => {
            const columns = (
              db.prepare(`PRAGMA table_info(${object.name})`).all() as any[]
            ).map((column) => ({
              name: String(column.name),
              type: String(column.type),
              ...(column.notnull ? { notNull: true as const } : {}),
              ...(column.pk ? { primaryKey: true as const } : {}),
              ...(column.dflt_value !== null && column.dflt_value !== undefined
                ? { defaultValue: String(column.dflt_value) }
                : {}),
            }));
            const foreignKeys = (
              db
                .prepare(`PRAGMA foreign_key_list(${object.name})`)
                .all() as any[]
            ).map((foreignKey) => ({
              column: String(foreignKey.from),
              references: {
                table: String(foreignKey.table),
                column: String(foreignKey.to),
              },
              ...(foreignKey.on_delete && foreignKey.on_delete !== 'NO ACTION'
                ? { onDelete: String(foreignKey.on_delete) }
                : {}),
              ...(foreignKey.on_update && foreignKey.on_update !== 'NO ACTION'
                ? { onUpdate: String(foreignKey.on_update) }
                : {}),
            }));
            const indexes = (
              db.prepare(`PRAGMA index_list(${object.name})`).all() as any[]
            )
              .filter((index) => index.origin === 'c')
              .map((index) => ({
                name: String(index.name),
                ...(index.unique ? { unique: true as const } : {}),
              }));
            return {
              name: object.name,
              type: object.type,
              columns,
              ...(foreignKeys.length > 0 ? { foreignKeys } : {}),
              ...(indexes.length > 0 ? { indexes } : {}),
            };
          });
        signal?.throwIfAborted();
        return { tables };
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'db_schema', {
          version: clientVersion,
          durationMs: dependencies.now() - startTime,
          ...(failureMessage && { error: failureMessage }),
          ...(table && { table }),
        });
      }
    },
  };
}
