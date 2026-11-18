import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printError, setJsonMode } from '../../utils/output.js';

export function createDbSchemaCommand(): Command {
  return new Command('schema')
    .description('Introspect tables, columns, foreign keys, and indexes')
    .argument('[table]', 'Restrict output to a single table')
    .option('--json', 'Emit schema as JSON (default for agents)')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud db schema
  $ anycloud db schema workloads
  $ anycloud db schema --json
`,
    )
    .action(async (table: string | undefined, options?: { json?: boolean }) => {
      try {
        if (options?.json) setJsonMode(true);
        const api = await apiClient();
        const result = await api.database.schema({
          query: {
            ...(table ? { table } : {}),
          },
        });

        if (options?.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.tables.length === 0) {
          console.log(table ? `No table named '${table}'.` : 'No tables.');
          return;
        }

        for (const t of result.tables) {
          console.log(`\n${t.type} ${t.name}`);
          for (const c of t.columns) {
            const flags = [
              c.primaryKey && 'PK',
              c.notNull && 'NOT NULL',
              c.defaultValue !== undefined && `DEFAULT ${c.defaultValue}`,
            ]
              .filter(Boolean)
              .join(' ');
            const suffix = flags ? `  ${flags}` : '';
            console.log(`  ${c.name.padEnd(28)} ${c.type}${suffix}`);
          }
          for (const fk of t.foreignKeys ?? []) {
            console.log(
              `  → ${fk.column} references ${fk.references.table}(${fk.references.column})`,
            );
          }
          for (const idx of t.indexes ?? []) {
            const u = idx.unique ? 'UNIQUE ' : '';
            console.log(`  • ${u}INDEX ${idx.name}`);
          }
        }
      } catch (error) {
        printError(`Schema lookup failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
