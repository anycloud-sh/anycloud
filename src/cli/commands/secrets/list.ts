import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { newTable } from '../../renderers/table.js';
import chalk from 'chalk';
import { printSuccess, printInfo } from '../../utils/output.js';

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

export function createListCommand(): Command {
  return new Command('list')
    .description('📋 List saved secrets (names and timestamps only)')
    .option('--all', 'Include secrets whose names start with _')
    .addHelpText(
      'after',
      `
Values are never returned — only names and timestamps. To rotate a
value, re-run "anycloud secrets new <name> KEY=NEW_VALUE". Running VM
Jobs, Services and VMs see it in /run/anycloud-secrets/<name>/<KEY>
within seconds; environment variables change only when the workload
starts again.
`,
    )
    .action(async (options: { all?: boolean }) => {
      const api = await apiClient();
      const secrets = (await api.secrets.list()).filter(
        (secret) => options.all || !secret.name.startsWith('_'),
      );

      if (secrets.length === 0) {
        printInfo(
          'No saved secrets. Create one with "anycloud secrets new <name> KEY=VALUE".',
        );
        return;
      }

      printSuccess(`Saved (${secrets.length}):`);
      console.log('');
      const table = newTable({
        head: ['Name', 'Created', 'Updated'].map((h) => chalk.cyan(h)),
        style: { head: [], border: ['dim'] },
      });
      for (const s of secrets) {
        table.push([s.name, formatTime(s.createdAt), formatTime(s.updatedAt)]);
      }
      console.log(table.toString());
    });
}
