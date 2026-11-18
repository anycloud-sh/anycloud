import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CliClient } from '../integration/e2e/internal/cli.js';
import {
  completedJobByCli,
  logsStopWithTheirReader,
  statusCheckpoint,
} from '../integration/e2e/internal/cli-observations.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import { commandResultForTest } from './helpers/e2e.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** A CliClient whose CLI is `script`, run by node from dist/cli/index.js. */
async function cliRunning(script: string): Promise<CliClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cli-obs-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'dist', 'cli'), { recursive: true });
  await writeFile(path.join(directory, 'dist', 'cli', 'index.js'), script);
  const artifacts = new ArtifactStore(directory, new Redactor());
  await artifacts.initialize({ test: 'CLI observations' });
  return new CliClient(
    new ProcessRunner(artifacts, new AbortController().signal, directory),
    directory,
    directory,
    undefined,
    'token',
  );
}

describe('logsStopWithTheirReader', () => {
  // Endless output on stderr, as Python logging writes it: only an fd write
  // notices that `grep -m1` has gone.
  const endless = (stream: 1 | 2, onEpipe: string) => `
    const { writeSync } = require('node:fs');
    for (let i = 0; ; i++) {
      try {
        writeSync(${stream}, 'Loaded ' + i + '/10 existing results from results.json\\n');
      } catch (error) {
        if (error.code === 'EPIPE') { ${onEpipe} }
        throw error;
      }
    }`;

  test('reports the first match and a zero exit when the CLI stops with its reader', async () => {
    const cli = await cliRunning(endless(2, 'process.exit(0);'));
    await expect(
      logsStopWithTheirReader(cli, 'job', 'existing results from'),
    ).resolves.toEqual({ matched: true, cliExitedZero: true });
  });

  test('reports a CLI that fails once its reader is gone', async () => {
    const cli = await cliRunning(endless(1, 'process.exit(3);'));
    await expect(
      logsStopWithTheirReader(cli, 'job', 'existing results from'),
    ).resolves.toEqual({ matched: true, cliExitedZero: false });
  });
});

describe('CLI job observations', () => {
  const scripted = (outputs: Record<string, string>) => {
    const run = async (args: readonly string[]) =>
      commandResultForTest({
        args: [...args],
        exitCode: 0,
        stdout: outputs[args[0] ?? ''] ?? '',
      });
    return { run, runWithTransientRetries: run };
  };

  test('a completed Job needs a succeeded wait result and the finished line', async () => {
    const result = JSON.stringify({ type: 'result', outcome: 'succeeded' });
    await expect(
      completedJobByCli(
        scripted({
          wait: `{"type":"state"}\n${result}\n`,
          status: '✓ container    finished, exit 0',
        }),
        'job',
      ),
    ).resolves.toEqual({ waitSucceeded: true, statusFinished: true });
    await expect(
      completedJobByCli(
        scripted({
          wait: JSON.stringify({ type: 'result', outcome: 'failed' }),
          status: '✗ container    exited',
        }),
        'job',
      ),
    ).resolves.toEqual({ waitSucceeded: false, statusFinished: false });
  });

  test('status checkpoint facts come from status --json', async () => {
    const checkpoint = {
      bucket: 'b',
      mount: '/mnt/checkpoint',
      retained: false,
    };
    await expect(
      statusCheckpoint(
        scripted({ status: JSON.stringify({ checkpoint }) }),
        'job',
      ),
    ).resolves.toEqual(checkpoint);
  });
});
