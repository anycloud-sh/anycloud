import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { newTable } from '../../renderers/table.js';
import {
  printError,
  printInfo,
  printWarning,
  setJsonMode,
} from '../../utils/output.js';

export function createDbQueryCommand(): Command {
  return new Command('query')
    .description('Run a read-only SQL query against the active API database')
    .argument('<sql>', 'SELECT / WITH / EXPLAIN / PRAGMA statement')
    .option('--json', 'Emit rows as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud db query "SELECT id, state FROM workloads LIMIT 10"
  $ anycloud db query "SELECT * FROM workload_events WHERE workload_id = 'abc'" --json
  $ anycloud db query "PRAGMA table_info(workloads)"

Writes are blocked at the SQLite engine level — use the regular CLI
commands (submit / terminate / resubmit / ...) to mutate state.
`,
    )
    .action(async (sql: string, options?: { json?: boolean }) => {
      try {
        if (options?.json) setJsonMode(true);
        const api = await apiClient();
        const result = await api.database.query({
          sql,
        });

        if (options?.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.rows.length === 0) {
          printInfo('No rows.');
          return;
        }

        const columns = Object.keys(result.rows[0]);
        const table = newTable({ head: columns });
        for (const row of result.rows) {
          table.push(
            columns.map((c) => {
              const v = (row as Record<string, unknown>)[c];
              if (v === null || v === undefined) return '';
              if (typeof v === 'object') return JSON.stringify(v);
              return String(v);
            }),
          );
        }
        console.log(table.toString());
        printInfo(`${result.rowCount} row(s)`);
        if (result.truncated) {
          printWarning('Result truncated — add LIMIT or refine the query.');
        }
      } catch (error) {
        printError(`Query failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
