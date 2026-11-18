#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertSpikeRevision,
  executeSpike,
  parseSpikeArguments,
  spikeEntrypoint,
} from './spike.js';

async function main(): Promise<void> {
  const [phase, ...extra] = process.argv.slice(2);
  if ((phase !== 'run' && phase !== 'cleanup') || extra.length) {
    throw new Error('Usage: yarn tsx ci/run-spike.ts <run|cleanup>');
  }
  const root = process.cwd();
  const experiment = process.env.SPIKE_EXPERIMENT ?? '';
  const sourceSha = process.env.SPIKE_SOURCE_SHA ?? '';
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assertSpikeRevision(sourceSha, actualSha);
  const entrypoint = spikeEntrypoint(root, experiment);
  const args = parseSpikeArguments(
    (phase === 'cleanup'
      ? process.env.SPIKE_CLEANUP_ARGUMENTS
      : process.env.SPIKE_ARGUMENTS) || '[]',
  );
  if (!process.env.SPIKE_OUTPUT_DIR)
    throw new Error('SPIKE_OUTPUT_DIR is required');
  const output = resolve(process.env.SPIKE_OUTPUT_DIR);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const receipt = {
    experiment,
    sourceSha,
    phase,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    startedAt: new Date().toISOString(),
  };
  // Prefixed so a receipt cannot overwrite an experiment report of the same name.
  const path = resolve(output, `spike-${phase}.json`);
  await writeFile(
    path,
    `${JSON.stringify({ ...receipt, outcome: 'started' }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const exitCode = await executeSpike({
    root,
    entrypoint,
    args,
    environment: {
      ...process.env,
      SPIKE_PHASE: phase,
      SPIKE_OUTPUT_DIR: output,
    },
  });
  await writeFile(
    path,
    `${JSON.stringify({ ...receipt, finishedAt: new Date().toISOString(), exitCode, outcome: exitCode === 0 ? 'completed' : 'failed' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Spike runner failed');
  process.exitCode = 1;
});
