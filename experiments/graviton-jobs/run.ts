#!/usr/bin/env tsx
/**
 * Live check: does a VM Job run on AWS Graviton? It runs the branch's API and
 * CLI, starts a spot Job of a multi-arch public image on an arm64 type, and
 * asserts the container printed `aarch64` and ran the image's arm64 build. It
 * also asserts that an amd64-only image and a mixed arm64/amd64 type list are
 * refused before any VM starts.
 *
 * `run` and `cleanup` share a state directory under RUNNER_TEMP that holds
 * the API database, so cleanup can terminate the run's Job after a failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspectImage } from '../../src/shared/image-registry.js';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'graviton-jobs');
const inventoryPath = join(state, 'inventory.json');
const apiLogPath = join(state, 'api.log');
const PORT = 18_433;
const API_URL = `http://127.0.0.1:${PORT}`;
const IMAGE = 'alpine:3.20';
// Docker Hub's per-architecture repository: an amd64 build only.
const AMD64_ONLY_IMAGE = 'amd64/alpine:3.20';
const REGIONS = 'us-east-2,us-east-1,us-west-2';
const VM_TYPES = ['m8g.xlarge', 'm7g.xlarge'];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function evidence(name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

function cliResult(args: string[], timeoutMs = 300_000) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'dist/cli/index.js'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANYCLOUD_DIR: join(state, 'cli'),
        API_URL,
        IS_TEST: 'true',
        CI: 'true',
        GITHUB_TOKEN: 'dummy-token-for-test',
        NO_COLOR: '1',
        AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
        AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function cli(args: string[], timeoutMs?: number): string {
  const result = cliResult(args, timeoutMs);
  if (result.status !== 0) {
    throw new Error(
      `anycloud ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).slice(-600)}`,
    );
  }
  return result.stdout;
}

function query(sql: string): Record<string, unknown>[] {
  return (
    JSON.parse(cli(['db', 'query', '--json', sql])) as {
      rows: Record<string, unknown>[];
    }
  ).rows;
}

async function startApi(): Promise<void> {
  if (!existsSync(join(root, 'dist/api/server.js'))) {
    const build = spawnSync('yarn', ['build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('yarn build failed');
  }
  const token = randomBytes(32).toString('hex');
  writeLocalApiToken(state, token);
  writeLocalApiToken(join(state, 'cli'), token);
  const log = openSync(apiLogPath, 'a');
  const api = spawn(process.execPath, [join(root, 'dist/api/server.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      ANYCLOUD_DIR: state,
      SQLITE_PATH: join(state, 'api.db'),
      CIPHER_KEY: '',
      IS_TEST: 'true',
      PORT: String(PORT),
      GITHUB_TOKEN: 'dummy-token-for-test',
    },
  });
  api.unref();
  process.on('exit', () => {
    api.kill('SIGTERM');
    evidence('api.log', readFileSync(apiLogPath, 'utf8'));
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${API_URL}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return;
    await sleep(1_000);
  }
  throw new Error('API never became healthy; see api log');
}

/** Terminate the Job and wait until the API has ended every VM it started. */
async function terminateAndAwaitCleanup(id: string): Promise<unknown> {
  const terminated = cliResult(['terminate', id]);
  if (terminated.status !== 0) console.warn(terminated.stderr);
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const [row] = query(
      `SELECT w.id, w.state, w.cleaned_at, ` +
        `(SELECT COUNT(*) FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL) AS live_vms ` +
        `FROM workloads w WHERE w.id = '${id}'`,
    );
    if (!row || (row.cleaned_at !== null && row.live_vms === 0)) return row;
    if (Date.now() > deadline)
      throw new Error(`${id} still has VMs: ${JSON.stringify(row)}`);
    await sleep(10_000);
  }
}

/** A submission that must be refused before any VM starts. */
function refusal(name: string, args: string[], expected: string) {
  const id = `graviton-${name}-${randomBytes(3).toString('hex')}`;
  const result = cliResult(['job', ...args, '--id', id, '--no-checkpoint']);
  const message = `${result.stdout}\n${result.stderr}`;
  const vms = query(
    `SELECT COUNT(*) AS n FROM vms WHERE workload_id = '${id}'`,
  );
  return {
    name,
    refused: result.status !== 0 && message.includes(expected),
    noVm: vms[0]?.n === 0,
    message: message.trim().slice(-600),
  };
}

async function run() {
  mkdirSync(state, { recursive: true });
  const id = `graviton-job-${randomBytes(3).toString('hex')}`;
  writeFileSync(inventoryPath, JSON.stringify({ id }));
  await startApi();
  cli(['credentials', 'new', 'aws-spike', '--provider', 'aws']);

  const refusals = [
    refusal(
      'amd64-only',
      [
        AMD64_ONLY_IMAGE,
        '--credentials',
        'aws-spike',
        '--vm-type',
        'm8g.xlarge',
        '--spot',
      ],
      'has no linux/arm64 build',
    ),
    refusal(
      'mixed-list',
      [
        IMAGE,
        '--credentials',
        'aws-spike',
        '--vm-type',
        'm8g.xlarge',
        '--vm-type',
        'm8a.xlarge',
      ],
      'mixes arm64 (m8g.xlarge) and amd64 (m8a.xlarge)',
    ),
  ];

  console.log(`Submitting ${id}`);
  const submittedAt = Date.now();
  cli([
    'job',
    IMAGE,
    '--id',
    id,
    '--credentials',
    'aws-spike',
    '--regions',
    REGIONS,
    ...VM_TYPES.flatMap((vmType) => ['--vm-type', vmType]),
    '--spot',
    '--no-checkpoint',
    '--',
    'sh',
    '-c',
    'echo "arch=$(uname -m)"; cat /etc/alpine-release',
  ]);
  const logs = cli(['logs', id, '--follow'], 30 * 60_000);
  const waited = cliResult(['wait', id, '--timeout', '10m', '--json']);
  const [spec] = query(
    `SELECT image, image_digest FROM container_specs WHERE workload_id = '${id}'`,
  );
  const vms = query(`SELECT * FROM vms WHERE workload_id = '${id}'`);
  const expectedDigest = (await inspectImage(IMAGE, null, 'arm64')).digest;
  const cleanup = await terminateAndAwaitCleanup(id);

  const job = {
    id,
    completed: waited.status === 0,
    printedAarch64: logs.includes('arch=aarch64'),
    pinnedArm64Digest:
      expectedDigest !== null && spec?.image_digest === expectedDigest,
    expectedDigest,
    spec,
    secondsToCompletion: Math.round((Date.now() - submittedAt) / 1000),
    logs: logs.slice(-2000),
    wait: waited.stdout.trim(),
    vms,
  };
  const passed =
    job.completed &&
    job.printedAarch64 &&
    job.pinnedArm64Digest &&
    refusals.every((entry) => entry.refused && entry.noVm);
  evidence('summary.json', { passed, job, refusals, cleanup });
  console.log(JSON.stringify({ passed, job, refusals }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function cleanup() {
  if (!existsSync(inventoryPath)) {
    evidence('cleanup.json', { note: 'no inventory: run created nothing' });
    return;
  }
  const { id } = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
    id: string;
  };
  await startApi();
  evidence('cleanup.json', { job: await terminateAndAwaitCleanup(id) });
}

const [command = 'run'] = process.argv.slice(2);
if (command === 'run') await run();
else if (command === 'cleanup') await cleanup();
else throw new Error(`Unknown command ${command}`);
process.exit();
