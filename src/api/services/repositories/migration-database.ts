/** Native synchronous connection available only to startup schema migrations. */
export interface MigrationDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): void;
  query<T>(sql: string, params?: unknown[]): T[];
}
