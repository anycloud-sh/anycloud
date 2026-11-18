#!/usr/bin/env node

import { writeSync } from 'node:fs';
import { formatWithOptions } from 'node:util';
import { Command } from 'commander';
import { createSubmitCommand } from './commands/submit.js';
import { rewriteDeprecatedJobAlias } from './deprecated-job-aliases.js';
import { createServeCommand } from './commands/serve.js';
import { createVmCommand } from './commands/vm.js';
import { createImagesCommand } from './commands/images.js';
import { completePendingSignIn } from './services/oauth.js';
import { printWarning } from './utils/output.js';
import { createStatusCommand } from './commands/status.js';
import { createWaitCommand } from './commands/wait.js';
import { createTerminateCommand } from './commands/terminate.js';
import { createResubmitCommand } from './commands/resubmit.js';
import { createListCommand } from './commands/list.js';
import { createUpdateCommand } from './commands/update.js';
import { createExecCommand } from './commands/exec.js';
import { createLogsCommand } from './commands/logs.js';
import { createSshCommand } from './commands/ssh.js';
import { createCredentialsCommand } from './commands/credentials/index.js';
import { createSecretsCommand } from './commands/secrets/index.js';
import { createLoginCommand } from './commands/login.js';
import { createApiCommand } from './commands/api.js';
import { createCostCommand } from './commands/cost.js';
import { createQuotaCommand } from './commands/quota.js';
import { createThrottleCommand } from './commands/throttle.js';
import { createBudgetCommand } from './commands/budget.js';
import { createSpendCommand } from './commands/spend.js';
import { createRegionsCommand } from './commands/regions.js';
import { createVmTypesCommand } from './commands/vm-types.js';
import { createGpusCommand } from './commands/gpus.js';
import { createPricingCommand } from './commands/pricing.js';
import { createBucketCommand } from './commands/bucket/index.js';
import { createNotificationsCommand } from './commands/notifications.js';
import { createDbCommand } from './commands/db/index.js';
import { createDocsCommand } from './commands/docs.js';
import { createClusterCommand } from './commands/cluster.js';
import { setPreFlightCheck } from '../shared/services/api-client/runtime.js';
import { inspectLocalApiContainer } from '../shared/local-api-container.js';
import packageJson from '../../package.json' with { type: 'json' };
import { maybeShowVersionBanner } from './utils/version-check.js';

const rootCommandSections = [
  {
    title: 'PLATFORM',
    commands: ['job', 'service', 'vm', 'cluster', 'bucket'],
  },
  {
    title: 'MANAGE',
    commands: [
      'list',
      'status',
      'logs',
      'exec',
      'ssh',
      'resubmit',
      'terminate',
      'db',
    ],
  },
  {
    title: 'CATALOG',
    commands: ['images', 'regions', 'gpus', 'vm-types', 'pricing', 'docs'],
  },
  {
    title: 'SETUP',
    commands: ['login', 'credentials', 'quota', 'secrets', 'api', 'update'],
  },
  {
    title: 'SPEND',
    commands: ['spend', 'cost', 'budget', 'throttle', 'notifications'],
  },
] as const;

// Write console output synchronously, so a slow pipe reader still receives all
// of it. Once process.stdout or process.stderr has been read, Bun's console
// drops output past the 64 KiB pipe buffer
// (https://github.com/oven-sh/bun/issues/36419), and on both Bun and Node an
// asynchronous pipe write still pending at process.exit() is lost.
const backoff = new Int32Array(new SharedArrayBuffer(4));
function writeLineSync(fd: 1 | 2, args: unknown[]): void {
  // Colour inspected objects on a colour terminal, as Node's console does.
  const stream = fd === 1 ? process.stdout : process.stderr;
  const colors = stream.isTTY && stream.hasColors();
  let pending = Buffer.from(`${formatWithOptions({ colors }, ...args)}\n`);
  while (pending.length > 0) {
    try {
      pending = pending.subarray(writeSync(fd, pending));
    } catch (error) {
      // Like Node's console, drop output the reader no longer accepts (EPIPE).
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return;
      // A non-blocking pipe is full: wait for the reader instead of spinning.
      Atomics.wait(backoff, 0, 0, 5);
    }
  }
}
console.log =
  console.info =
  console.debug =
    (...args: unknown[]) => writeLineSync(1, args);
console.error = console.warn = (...args: unknown[]) => writeLineSync(2, args);

// Set CLI-specific pre-flight check: inspect the API Docker container.
setPreFlightCheck(inspectLocalApiContainer);

rewriteDeprecatedJobAlias(process.argv, (message) => console.error(message));

// Warn if a newer CLI release is available. Skip for --version/--help/help/update
// and bare `anycloud` (help screen).
const firstArg = process.argv[2];
const skipVersionCheck =
  !firstArg ||
  firstArg.startsWith('-') ||
  firstArg === 'update' ||
  firstArg === 'upgrade' ||
  firstArg === 'help';
if (!skipVersionCheck) {
  maybeShowVersionBanner(packageJson.version);
}

// Create main CLI program
const program = new Command();

program
  .name('anycloud')
  .enablePositionalOptions()
  .description('☁️  anycloud')
  .version(packageJson.version)
  .configureHelp({
    formatHelp: (cmd, helper) => {
      const sections = [];

      // Description
      if (cmd.description()) {
        sections.push(`${cmd.description()}\n`);
      }

      sections.push(`Version: ${packageJson.version}\n`);

      // Commands
      const commandList = helper
        .visibleCommands(cmd)
        .filter((subcmd: Command) => subcmd.name() !== 'help');
      if (commandList.length > 0) {
        const formatCommand = (subcmd: Command): string => {
          // Command usage without aliases.
          const name = subcmd.name();
          const args = subcmd.registeredArguments
            .map((arg: any) =>
              arg.required ? `<${arg.name()}>` : `[${arg.name()}]`,
            )
            .join(' ');
          const hasVisibleOptions = subcmd.options.some(
            (option: any) => !option.hidden,
          );
          const opts = hasVisibleOptions ? '[options] ' : '';
          const usage = `${name} ${opts}${args}`.trim();
          const desc = subcmd.description();
          const gap = ' '.repeat(Math.max(2, 32 - usage.length));
          return `  ${usage}${gap}${desc}`;
        };

        const commandsByName = new Map(
          commandList.map((subcmd) => [subcmd.name(), subcmd]),
        );
        const renderedCommands = new Set<string>();
        const renderedSections: string[] = [];

        for (const section of rootCommandSections) {
          const sectionCommands = section.commands.flatMap((name) => {
            const subcmd = commandsByName.get(name);
            if (!subcmd) return [];
            renderedCommands.add(name);
            return [formatCommand(subcmd)];
          });

          if (sectionCommands.length > 0) {
            renderedSections.push(
              `${section.title}\n${sectionCommands.join('\n')}`,
            );
          }
        }

        // Keep newly registered commands discoverable until they are assigned
        // to a section above.
        const otherCommands = commandList
          .filter((subcmd) => !renderedCommands.has(subcmd.name()))
          .map(formatCommand);
        if (otherCommands.length > 0) {
          renderedSections.push(`OTHER\n${otherCommands.join('\n')}`);
        }

        sections.push(renderedSections.join('\n\n'));
      }

      sections.push('\nDocs: anycloud docs  •  https://anycloud.sh');

      return sections.join('\n');
    },
  })
  // Finish a sign-in an earlier command relayed, once the user has approved it.
  .hook('preAction', async (_program, actionCommand) => {
    if (actionCommand.name() === 'login') return;
    // Unreachable GitHub must not fail a command that may not need the sign-in.
    await completePendingSignIn().catch((error: Error) =>
      printWarning(`GitHub sign-in not completed: ${error.message}`, true),
    );
  });

// Register commands
program.addCommand(createLoginCommand());
program.addCommand(createImagesCommand());
program.addCommand(createSubmitCommand());
program.addCommand(createServeCommand());
program.addCommand(createVmCommand());
program.addCommand(createClusterCommand());
program.addCommand(createStatusCommand());
program.addCommand(createWaitCommand());
program.addCommand(createListCommand());
program.addCommand(createTerminateCommand());
program.addCommand(createResubmitCommand());
program.addCommand(createUpdateCommand());
program.addCommand(createExecCommand());
program.addCommand(createLogsCommand());
program.addCommand(createSshCommand());
program.addCommand(createCredentialsCommand());
program.addCommand(createSecretsCommand());
program.addCommand(createApiCommand());
program.addCommand(createCostCommand());
program.addCommand(createQuotaCommand());
program.addCommand(createThrottleCommand());
program.addCommand(createBudgetCommand());
program.addCommand(createSpendCommand());
program.addCommand(createRegionsCommand());
program.addCommand(createVmTypesCommand());
program.addCommand(createGpusCommand());
program.addCommand(createPricingCommand());
program.addCommand(createBucketCommand());
program.addCommand(createNotificationsCommand());
program.addCommand(createDbCommand());
program.addCommand(createDocsCommand());

// Parse command-line arguments and close stdin after completion
// The prompts library keeps stdin open, preventing process exit
// Closing stdin after parseAsync completes ensures clean exit for all commands
program
  .parseAsync(process.argv)
  .then(() => {
    process.stdin.pause();
    process.stdin.destroy();
  })
  .catch((err) => {
    if (err instanceof Error) console.error(err.message);
    process.exit(1);
  });
