import { Command } from 'commander';
import { createDbQueryCommand } from './query.js';
import { createDbSchemaCommand } from './schema.js';

export function createDbCommand(): Command {
  const db = new Command('db').description(
    '🔎  Read-only SQL inspection of the active API database',
  );
  db.addCommand(createDbQueryCommand());
  db.addCommand(createDbSchemaCommand());
  return db;
}
