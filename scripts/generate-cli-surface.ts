// Emits test/integration/e2e/internal/cli-surface.generated.ts from the real
// commander tree, so a harness call with a flag the CLI does not have fails to
// compile instead of failing a live run. Run through tsx (`yarn
// generate:cli-surface`); `--check` regenerates and fails on drift.

import type { Argument, Command, Option } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLoginCommand } from '../src/cli/commands/login.js';
import { createImagesCommand } from '../src/cli/commands/images.js';
import { createSubmitCommand } from '../src/cli/commands/submit.js';
import { createServeCommand } from '../src/cli/commands/serve.js';
import { createVmCommand } from '../src/cli/commands/vm.js';
import { createClusterCommand } from '../src/cli/commands/cluster.js';
import { createStatusCommand } from '../src/cli/commands/status.js';
import { createWaitCommand } from '../src/cli/commands/wait.js';
import { createListCommand } from '../src/cli/commands/list.js';
import { createTerminateCommand } from '../src/cli/commands/terminate.js';
import { createResubmitCommand } from '../src/cli/commands/resubmit.js';
import { createUpdateCommand } from '../src/cli/commands/update.js';
import { createExecCommand } from '../src/cli/commands/exec.js';
import { createLogsCommand } from '../src/cli/commands/logs.js';
import { createSshCommand } from '../src/cli/commands/ssh.js';
import { createCredentialsCommand } from '../src/cli/commands/credentials/index.js';
import { createSecretsCommand } from '../src/cli/commands/secrets/index.js';
import { createApiCommand } from '../src/cli/commands/api.js';
import { createCostCommand } from '../src/cli/commands/cost.js';
import { createQuotaCommand } from '../src/cli/commands/quota.js';
import { createThrottleCommand } from '../src/cli/commands/throttle.js';
import { createBudgetCommand } from '../src/cli/commands/budget.js';
import { createSpendCommand } from '../src/cli/commands/spend.js';
import { createRegionsCommand } from '../src/cli/commands/regions.js';
import { createVmTypesCommand } from '../src/cli/commands/vm-types.js';
import { createGpusCommand } from '../src/cli/commands/gpus.js';
import { createPricingCommand } from '../src/cli/commands/pricing.js';
import { createBucketCommand } from '../src/cli/commands/bucket/index.js';
import { createNotificationsCommand } from '../src/cli/commands/notifications.js';
import { createDbCommand } from '../src/cli/commands/db/index.js';
import { createDocsCommand } from '../src/cli/commands/docs.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(repoRoot, 'src/cli/index.ts');
const outputPath = join(
  repoRoot,
  'test/integration/e2e/internal/cli-surface.generated.ts',
);

/** The factories src/cli/index.ts registers; the check below refuses to drift from that list. */
const factories = {
  createLoginCommand,
  createImagesCommand,
  createSubmitCommand,
  createServeCommand,
  createVmCommand,
  createClusterCommand,
  createStatusCommand,
  createWaitCommand,
  createListCommand,
  createTerminateCommand,
  createResubmitCommand,
  createUpdateCommand,
  createExecCommand,
  createLogsCommand,
  createSshCommand,
  createCredentialsCommand,
  createSecretsCommand,
  createApiCommand,
  createCostCommand,
  createQuotaCommand,
  createThrottleCommand,
  createBudgetCommand,
  createSpendCommand,
  createRegionsCommand,
  createVmTypesCommand,
  createGpusCommand,
  createPricingCommand,
  createBucketCommand,
  createNotificationsCommand,
  createDbCommand,
  createDocsCommand,
};

export interface CliSurfaceEntry {
  readonly args: readonly string[];
  readonly options: readonly string[];
}

/** One option as the type layer reads it: `name`, `name=` (takes a value), `name=!` (mandatory value). */
export function optionSpec(
  option: Pick<
    Option,
    'long' | 'required' | 'optional' | 'mandatory' | 'flags'
  >,
): string {
  if (typeof option.long !== 'string' || !option.long.startsWith('--')) {
    throw new Error(`Option without a long flag: ${String(option.flags)}`);
  }
  const takesValue = Boolean(option.required || option.optional);
  return `${option.long.slice(2)}${takesValue ? '=' : ''}${takesValue && option.mandatory ? '!' : ''}`;
}

function argumentSpec(argument: Argument): string {
  const name = `${argument.name()}${argument.variadic ? '...' : ''}`;
  return argument.required ? `<${name}>` : `[${name}]`;
}

/**
 * Every command reachable from `commands`, keyed by its path (`api create`);
 * a command's aliases are keys of their own at the same level.
 */
export function cliSurfaceFromCommands(
  commands: readonly Command[],
): Record<string, CliSurfaceEntry> {
  const surface: Record<string, CliSurfaceEntry> = {};
  const walk = (command: Command, parents: readonly string[]): void => {
    const entry = {
      args: command.registeredArguments.map(argumentSpec),
      options: command.options.filter((o) => !o.hidden).map(optionSpec),
    };
    for (const name of [command.name(), ...command.aliases()]) {
      surface[[...parents, name].join(' ')] = entry;
    }
    for (const child of command.commands) {
      walk(child, [...parents, command.name()]);
    }
  };
  for (const command of commands) walk(command, []);
  return Object.fromEntries(
    Object.entries(surface).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function renderCliSurface(
  surface: Record<string, CliSurfaceEntry>,
): string {
  const quote = (value: string) => `'${value.replaceAll("'", "\\'")}'`;
  const list = (values: readonly string[]) =>
    `[${values.map(quote).join(', ')}]`;
  const lines = Object.entries(surface).map(
    ([path, { args, options }]) =>
      `  ${quote(path)}: { args: ${list(args)}, options: ${list(options)} },`,
  );
  return [
    '// Generated by `yarn generate:cli-surface` from the commander tree in src/cli;',
    '// do not edit. `yarn check:cli-surface` fails when this file drifts.',
    '// Option specs: `name` (flag), `name=` (takes a value), `name=!` (mandatory value).',
    'export const cliSurface = {',
    ...lines,
    '} as const;',
    '',
    'export type CliSurface = typeof cliSurface;',
    '',
  ].join('\n');
}

/**
 * The commands src/cli/index.ts registers, instantiated without parsing
 * anything. The static import list above must match the registrations; a new
 * command added to the CLI fails this check until it is added here.
 */
function realCommands(): Command[] {
  const source = readFileSync(indexPath, 'utf8');
  const registered = [
    ...source.matchAll(/^program\.addCommand\((create\w+Command)\(\)\);$/gmu),
  ].map(([, factory]) => factory);
  const known = Object.keys(factories);
  const missing = registered.filter((name) => !known.includes(name));
  const stale = known.filter((name) => !registered.includes(name));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `scripts/generate-cli-surface.ts must import exactly the factories src/cli/index.ts registers (missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'})`,
    );
  }
  return registered.map((name) => factories[name as keyof typeof factories]());
}

function main(): void {
  const rendered = renderCliSurface(cliSurfaceFromCommands(realCommands()));
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(outputPath, 'utf8');
    } catch {
      // A missing file is drift too.
    }
    if (current !== rendered) {
      console.error(
        `${outputPath} does not match the CLI's commander tree; run \`yarn generate:cli-surface\`.`,
      );
      process.exit(1);
    }
    console.log('CLI surface snapshot matches the commander tree.');
    return;
  }
  writeFileSync(outputPath, rendered);
  console.log(`Wrote ${outputPath}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
