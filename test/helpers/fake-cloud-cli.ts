/**
 * Fake `aws`, `az` and `gcloud` executables for the seed's tests (RFC 0049
 * C26 (e), lanes S1–S4). Tests never run a real cloud CLI: the fakes sit
 * first on a PATH that holds nothing else, record every call, and answer
 * from a responder table the test sets.
 *
 *   const clis = installFakeCloudClis({
 *     aws: [{ match: ['sts', 'get-caller-identity'], stdout: { Account: '1' } }],
 *   });
 *   vi.stubEnv('PATH', clis.env.PATH);
 *   await runArgv('aws', ['sts', 'get-caller-identity']);
 *   clis.calls(); // [{ cli: 'aws', args: ['sts', 'get-caller-identity'], stdin: '' }]
 *   clis.cleanup();
 *
 * `runArgv` (src/cli/services/slurp/cli-exec.ts) runs the CLIs with the
 * process environment, so a test sets `PATH` to `clis.env.PATH` for its
 * duration (`vi.stubEnv`), or passes `clis.env` to a child process.
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeCloudCliName = 'aws' | 'az' | 'gcloud';

export const FAKE_CLOUD_CLIS: readonly FakeCloudCliName[] = [
  'aws',
  'az',
  'gcloud',
];

/** One answer: the first responder whose `match` fits the argv answers it. */
export interface FakeCliResponder {
  /** An argv prefix, or a pattern tested against the argv joined by spaces. */
  match: readonly string[] | RegExp;
  /** Written to stdout; an object is JSON-stringified. */
  stdout?: string | object;
  stderr?: string;
  /** Default 0. */
  exitCode?: number;
  /** Answer this many calls, then fall through to the next responder; default unlimited. */
  times?: number;
}

export interface FakeCliCall {
  cli: FakeCloudCliName;
  args: string[];
  /** Empty when the caller wrote nothing. */
  stdin: string;
}

export interface FakeCloudClis {
  /** The directory holding the fakes, the only entry of `env.PATH`'s fake part. */
  dir: string;
  /** `process.env` with `PATH` set to the fakes and Node's own directory only. */
  env: NodeJS.ProcessEnv;
  /** Every call so far, in order. */
  calls(): FakeCliCall[];
  /** Append a responder for one CLI; it answers after those already set. */
  respond(cli: FakeCloudCliName, responder: FakeCliResponder): void;
  cleanup(): void;
}

interface StoredResponder {
  prefix?: string[];
  pattern?: { source: string; flags: string };
  stdout?: string;
  stderr?: string;
  exitCode: number;
  remaining: number | null;
}

// The fake itself: plain Node, reading the table and log paths it is given.
const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const cli = require('node:path').basename(process.argv[1]);
const dir = ${'__DIR__'};
const args = process.argv.slice(2);
let stdin = '';
try { if (!process.stdin.isTTY) stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ cli, args, stdin }) + '\\n');
const tablePath = dir + '/responders.json';
const table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
const joined = args.join(' ');
const list = table[cli] || [];
const index = list.findIndex((r) =>
  r.remaining !== 0 &&
  (r.prefix
    ? r.prefix.every((part, i) => args[i] === part)
    : new RegExp(r.pattern.source, r.pattern.flags).test(joined)),
);
if (index === -1) {
  process.stderr.write('unexpected fake ' + cli + ' call: ' + joined + '\\n');
  process.exit(2);
}
const r = list[index];
if (r.remaining !== null) {
  r.remaining -= 1;
  fs.writeFileSync(tablePath, JSON.stringify(table));
}
if (r.stdout !== undefined) process.stdout.write(r.stdout);
if (r.stderr !== undefined) process.stderr.write(r.stderr);
process.exitCode = r.exitCode;
`;

function stored(responder: FakeCliResponder): StoredResponder {
  const { match } = responder;
  return {
    ...(match instanceof RegExp
      ? { pattern: { source: match.source, flags: match.flags } }
      : { prefix: [...match] }),
    ...(responder.stdout === undefined
      ? {}
      : {
          stdout:
            typeof responder.stdout === 'string'
              ? responder.stdout
              : JSON.stringify(responder.stdout),
        }),
    ...(responder.stderr === undefined ? {} : { stderr: responder.stderr }),
    exitCode: responder.exitCode ?? 0,
    remaining: responder.times ?? null,
  };
}

/**
 * Install fake `aws`, `az` and `gcloud` in a fresh temp dir. Every fake is
 * installed, so an unexpected call to a CLI with no responders fails loudly
 * instead of reaching a real one.
 */
export function installFakeCloudClis(
  responders: Partial<Record<FakeCloudCliName, FakeCliResponder[]>> = {},
): FakeCloudClis {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cloud-cli-'));
  const tablePath = join(dir, 'responders.json');
  const logPath = join(dir, 'calls.jsonl');
  writeFileSync(logPath, '');
  const table: Record<string, StoredResponder[]> = Object.fromEntries(
    FAKE_CLOUD_CLIS.map((cli) => [cli, (responders[cli] ?? []).map(stored)]),
  );
  writeFileSync(tablePath, JSON.stringify(table));
  for (const cli of FAKE_CLOUD_CLIS) {
    const path = join(dir, cli);
    writeFileSync(path, FAKE_SOURCE.replace('__DIR__', JSON.stringify(dir)));
    chmodSync(path, 0o755);
  }
  // Node's own directory stays reachable for the shebang; nothing else does.
  const nodeDir = join(process.execPath, '..');
  return {
    dir,
    env: { ...process.env, PATH: `${dir}:${nodeDir}` },
    calls: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCliCall),
    respond(cli, responder) {
      const current = JSON.parse(readFileSync(tablePath, 'utf8')) as Record<
        string,
        StoredResponder[]
      >;
      current[cli] = [...(current[cli] ?? []), stored(responder)];
      writeFileSync(tablePath, JSON.stringify(current));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
