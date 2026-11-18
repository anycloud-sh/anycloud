import { Command } from 'commander';
import { createNewCommand } from './new.js';
import { createListCommand } from './list.js';
import { createDeleteCommand } from './delete.js';

export function createSecretsCommand(): Command {
  const secrets = new Command('secrets').description(
    '🔒 Manage named secrets (write-only, injected into containers)',
  );

  secrets.addCommand(createNewCommand());
  secrets.addCommand(createListCommand());
  secrets.addCommand(createDeleteCommand());

  return secrets;
}
