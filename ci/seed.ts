import { homedir } from 'os';
import { join } from 'path';
import { formatNukeDbSeedSummary, seedNukeDb } from './seed/nuke-db.js';

interface ParsedOptions {
  command: string | undefined;
  workloads: number | undefined;
  seed?: string;
  manifestPath?: string;
  dryRun: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  yarn seed nuke-db <workloads> [--seed <string>] [--manifest <path>] [--dry-run]',
    '',
    'Environment:',
    '  SQLITE_PATH       DB path to seed; defaults to $ANYCLOUD_DIR/api.db',
    '  ANYCLOUD_DIR      local anycloud data dir; defaults to ~/.anycloud',
    '  CIPHER_KEY        optional encryption key; otherwise cipher.key is created/read in ANYCLOUD_DIR',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedOptions {
  const [command, workloadsRaw, ...rest] = argv;
  const workloads =
    workloadsRaw && /^[0-9]+$/.test(workloadsRaw)
      ? Number(workloadsRaw)
      : undefined;
  const parsed: ParsedOptions = {
    command,
    workloads,
    dryRun: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--seed') {
      parsed.seed = requireValue(rest, ++i, '--seed');
    } else if (arg === '--manifest') {
      parsed.manifestPath = requireValue(rest, ++i, '--manifest');
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function getAnycloudDir(): string {
  return process.env.ANYCLOUD_DIR || join(homedir(), '.anycloud');
}

function resolveDbPath(): string {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  return join(getAnycloudDir(), 'api.db');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command !== 'nuke-db' || parsed.workloads === undefined) {
    throw new Error(usage());
  }

  const dbPath = resolveDbPath();
  const manifest = await seedNukeDb({
    dbPath,
    workloads: parsed.workloads,
    seed: parsed.seed ?? process.env.NUKE_DB_RANDOM_SEED,
    manifestPath: parsed.manifestPath,
    dryRun: parsed.dryRun,
  });

  console.log(formatNukeDbSeedSummary(manifest));
  if (parsed.dryRun) {
    console.log(`dry_run=true`);
  } else {
    console.log(`db=${dbPath}`);
    if (parsed.manifestPath) console.log(`manifest=${parsed.manifestPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
