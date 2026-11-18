import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';

import { CliClient } from '../integration/e2e/internal/cli.js';
import type { ProcessRunner } from '../integration/e2e/internal/process.js';
import { commandResultForTest } from './helpers/e2e.js';

// Another process reads the file as fast as it can, as a CLI child does.
const READER = `
const fs = require('node:fs');
const [file, ms] = process.argv.slice(1);
let reads = 0, empty = 0;
for (const end = Date.now() + Number(ms); Date.now() < end; reads++)
  if (fs.readFileSync(file, 'utf8') === '') empty++;
console.log(JSON.stringify({ reads, empty }));
`;

test('parallel CLI calls never leave local-api-token empty for a reader', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cli-token-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const runner = { run: async () => commandResultForTest() };
  const cli = new CliClient(
    runner as unknown as ProcessRunner,
    directory,
    directory,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 'a'.repeat(64),
  );
  await cli.run(['--version']);

  const reader = spawn(
    process.execPath,
    ['-e', READER, path.join(directory, 'local-api-token'), '500'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  reader.stdout.on('data', (chunk: Buffer) => (output += chunk));
  let finished = false;
  const closed = once(reader, 'close').then(() => (finished = true));
  while (!finished) {
    await Promise.all(
      Array.from({ length: 20 }, () => cli.run(['db', 'query'])),
    );
    // Yield to the event loop so the reader's exit can land.
    await new Promise((resolve) => setImmediate(resolve));
  }
  await closed;

  const { reads, empty } = JSON.parse(output) as {
    reads: number;
    empty: number;
  };
  expect(reads).toBeGreaterThan(0);
  expect(empty).toBe(0);
});
