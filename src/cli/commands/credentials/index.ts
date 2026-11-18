import { Command } from 'commander';
import { createNewCommand } from './new.js';
import { createListCommand } from './list.js';
import { createEditCommand } from './edit.js';
import { createDeleteCommand } from './delete.js';

export function createCredentialsCommand(): Command {
  const credentials = new Command('credentials')
    .description('🔑 Manage cloud provider credentials')
    .alias('creds');

  credentials.addCommand(createNewCommand());
  credentials.addCommand(createListCommand());
  credentials.addCommand(createEditCommand());
  credentials.addCommand(createDeleteCommand());

  return credentials;
}
