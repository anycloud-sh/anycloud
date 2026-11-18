import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.context/ctrl-c-diagnosis');
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const identity = (pid) =>
  execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], {
    encoding: 'utf8',
  }).trim();

async function prepare() {
  const variant = process.argv[3] ?? 'installed';
  const scenario = process.argv[4] ?? 'list-picker';
  const traced = process.argv.includes('--traced');
  const scenarios = {
    'list-picker': ['list'],
    'status-id': [
      'status',
      'ctrl-c-diagnosis-job',
      '--watch',
      '--interval',
      '1',
    ],
    'status-picker': ['status', '--watch', '--interval', '1'],
    'logs-id': ['logs', 'ctrl-c-diagnosis-job', '--follow'],
  };
  if (!Object.hasOwn(scenarios, scenario))
    throw new Error(`Unknown scenario: ${scenario}`);
  const manifest = json(
    join(evidence, traced ? 'manifest-traced.json' : 'manifest.json'),
  );
  const artifact = manifest.artifacts.find(
    (entry) => entry.variant === variant.replace(/-(node|bun)$/, ''),
  );
  if (
    !artifact ||
    (variant !== 'installed' && !/^(base|candidate)-(node|bun)$/.test(variant))
  ) {
    throw new Error(
      `Unavailable variant: ${variant}${traced ? ' (traced)' : ''}`,
    );
  }
  const node = variant.endsWith('-node');
  const executable = node ? manifest.nodePath : artifact.binary;
  const currentHash = createHash('sha256')
    .update(readFileSync(artifact.binary))
    .digest('hex');
  if (currentHash !== artifact.binarySha256)
    throw new Error(
      'Binary changed since preparation. Prepare fresh artifacts.',
    );
  const tty = execFileSync('/usr/bin/tty', [], {
    encoding: 'utf8',
    stdio: [0, 'pipe', 'ignore'],
  }).trim();
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync(join(evidence, 'capture-'));
  const request = {
    startedAt: new Date().toISOString(),
    directory,
    variant,
    scenario,
    traced,
    tty,
    cwd: process.cwd(),
    terminal: {
      TERM: process.env.TERM,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION,
    },
    executable,
    args: [...(node ? [artifact.entry] : []), ...scenarios[scenario]],
    artifact,
    manifest,
  };
  writeJson(join(directory, 'request.json'), request);
  const logFd = openSync(join(directory, 'fixture.log'), 'a', 0o600);
  const observer = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(import.meta.dirname, 'serve-fixture.ts'),
      directory,
    ],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  closeSync(logFd);
  observer.unref();
  const ready = join(directory, 'ready.json');
  const deadline = Date.now() + 30000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline || existsSync(join(directory, 'complete.json'))) {
      throw new Error(
        `Fixture startup failed; see ${join(directory, 'fixture.log')}`,
      );
    }
    await delay(100);
  }
  const fixture = json(ready);
  const env = {
    ...fixture.env,
    ...(traced ? { CTRL_C_DIAG_TRACE: join(directory, 'trace.jsonl') } : {}),
  };
  const command = [
    '/usr/bin/env',
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    executable,
    ...request.args,
  ]
    .map(quote)
    .join(' ');
  writeFileSync(
    join(directory, 'command.sh'),
    [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\\n' "$$" > ${quote(join(directory, 'cli.pid'))}`,
      `exec ${command}`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  process.stderr.write(
    `Capture: ${directory}\nRun the usual picker/watch steps, then press Ctrl-C. After exit, run: echo $?\nIf it hangs, from another terminal run:\nnode ${quote(join(import.meta.dirname, 'capture.mjs'))} signal ${quote(directory)}\nThe isolated fixture and observer stop after CLI exit (maximum 10 minutes).\n`,
  );
  process.stdout.write(directory + '\n');
}

function signal() {
  const directory = resolve(process.argv[3] ?? '');
  if (!directory.startsWith(evidence + '/capture-'))
    throw new Error('Expected a capture directory from this workspace.');
  if (existsSync(join(directory, 'complete.json')))
    throw new Error('That capture has already finished.');
  const observed = json(join(directory, 'identity.json'));
  if (identity(observed.pid) !== observed.identity)
    throw new Error('CLI process identity changed; no signal sent.');
  writeJson(join(directory, `external-sigint-${Date.now()}.json`), {
    at: Date.now(),
    pid: observed.pid,
    event: 'external.SIGINT',
  });
  process.kill(observed.pid, 'SIGINT');
  process.stdout.write(`Sent SIGINT to captured CLI ${observed.pid}.\n`);
}

try {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'signal') signal();
  else
    throw new Error(
      'Use capture.sh [installed|base-node|base-bun|candidate-node|candidate-bun] [list-picker|status-id|status-picker|logs-id] [--traced].',
    );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
