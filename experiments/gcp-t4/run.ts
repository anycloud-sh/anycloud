#!/usr/bin/env tsx
/**
 * Live check for one NVIDIA T4 on a GCP N1 machine. It generates the GCP
 * catalog with this branch's fetcher, serves that catalog to the branch's API
 * and CLI, and runs a `--gpu-type t4` VM Job of nvidia/cuda's base image that
 * runs `nvidia-smi`. A spot Job goes first; if it doesn't run, an on-demand Job
 * does. `run [spot|ondemand...]` picks the attempts.
 *
 * `run` and `cleanup` share a state directory under RUNNER_TEMP that holds the
 * API database, so cleanup can terminate the run's Jobs after a failure. Both
 * then list GCP instances and disks labelled with the Jobs' IDs and fail if any
 * remain. Reports in SPIKE_OUTPUT_DIR hold no credential.
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
import { DisksClient, InstancesClient } from '@google-cloud/compute';
import { parse } from 'csv-parse/sync';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'gcp-t4');
const inventoryPath = join(state, 'inventory.json');
const catalogPath = join(state, 'gcp.csv');
const PORT = 18_432;
const API_URL = `http://127.0.0.1:${PORT}`;
const IMAGE = 'nvidia/cuda:12.4.1-base-ubuntu22.04';
const T4_TYPES = ['n1-standard-4-t4', 'n1-highmem-4-t4'];
// Long enough for a cold GPU boot and image pull; a quota refusal that keeps
// the Job waiting ends the attempt here.
const ATTEMPT_TIMEOUT_MS = 25 * 60_000;

type Attempt = 'spot' | 'ondemand';

interface Inventory {
  runId: string;
  jobs: string[];
}

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

// Both processes fetch the GCP catalog through serve-catalog.mjs.
const catalogEnv = {
  NODE_OPTIONS: `--import ${join(import.meta.dirname, 'serve-catalog.mjs')}`,
  SPIKE_GCP_CATALOG: catalogPath,
};

function cliResult(args: string[], timeoutMs = 300_000) {
  return spawnSync(
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
        GCP_PROJECT_ID: required('GCP_PROJECT_ID'),
        GCP_CLIENT_EMAIL: required('GCP_CLIENT_EMAIL'),
        GCP_PRIVATE_KEY: required('GCP_PRIVATE_KEY'),
        ...catalogEnv,
      },
    },
  );
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

function query<T>(sql: string): T[] {
  return (JSON.parse(cli(['db', 'query', '--json', sql])) as { rows: T[] })
    .rows;
}

/** Generate the GCP catalog with this branch and check its T4 rows. */
function generateCatalog() {
  const fetch = spawnSync(
    'yarn',
    [
      'tsx',
      'scripts/fetch-catalog.ts',
      '--cloud',
      'gcp',
      '--output',
      catalogPath,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (fetch.status !== 0) throw new Error('GCP catalog fetch failed');
  const rows = parse(readFileSync(catalogPath, 'utf8'), {
    columns: true,
  }) as Record<string, string>[];
  const t4Rows = rows.filter((row) => row['AcceleratorName'] === 'T4');
  const byType = Object.fromEntries(
    T4_TYPES.map((type) => {
      const typeRows = t4Rows.filter((row) => row['InstanceType'] === type);
      const prices = (column: string) =>
        typeRows.map((row) => Number(row[column])).filter((p) => p > 0);
      return [
        type,
        {
          zones: typeRows.length,
          regions: new Set(typeRows.map((row) => row['Region'])).size,
          minPrice: Math.min(...prices('Price')),
          minSpotPrice: Math.min(...prices('SpotPrice')),
          sample: typeRows[0],
        },
      ];
    }),
  );
  const unexpected = [
    ...new Set(
      t4Rows
        .map((row) => row['InstanceType'])
        .filter((type) => !T4_TYPES.includes(type!)),
    ),
  ];
  evidence('catalog.json', { t4Rows: t4Rows.length, byType, unexpected });
  for (const [type, summary] of Object.entries(byType)) {
    if (
      !summary.zones ||
      !Number.isFinite(summary.minPrice) ||
      !Number.isFinite(summary.minSpotPrice)
    ) {
      throw new Error(`${type} lacks on-demand or spot rows`);
    }
  }
  if (unexpected.length) throw new Error(`Unexpected T4 types: ${unexpected}`);
}

async function startApi(): Promise<void> {
  if (!existsSync(join(root, 'dist/api/server.js'))) {
    const build = spawnSync('yarn', ['build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('yarn build failed');
  }
  const token = randomBytes(32).toString('hex');
  writeLocalApiToken(state, token);
  writeLocalApiToken(join(state, 'cli'), token);
  const logPath = join(state, 'api.log');
  const api = spawn(process.execPath, [join(root, 'dist/api/server.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
    env: {
      ...process.env,
      ...catalogEnv,
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
    evidence('api.log', readFileSync(logPath, 'utf8'));
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

async function until<T>(
  what: string,
  timeoutMs: number,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10_000);
  }
}

/** Terminate the Jobs, wait for the API's cleanup, then check GCP itself. */
async function terminateAndVerifyCleanup(ids: string[]) {
  if (ids.length > 0) {
    // An already-finished Job may refuse; the waits below assert the outcome.
    const terminate = cliResult(['terminate', ...ids]);
    if (terminate.status !== 0) console.warn(terminate.stderr);
  }
  const list = ids.map((id) => `'${id}'`).join(',');
  const records = ids.length
    ? await until('the API to clean up every Job', 15 * 60_000, async () => {
        const rows = query<{ cleaned_at: unknown; live_vms: number }>(
          `SELECT w.id, w.state, w.cleaned_at, ` +
            `(SELECT COUNT(*) FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL) AS live_vms ` +
            `FROM workloads w WHERE w.id IN (${list})`,
        );
        return rows.every((row) => row.cleaned_at !== null && !row.live_vms)
          ? rows
          : undefined;
      })
    : [];

  const credentials = {
    projectId: required('GCP_PROJECT_ID'),
    credentials: {
      client_email: required('GCP_CLIENT_EMAIL'),
      private_key: required('GCP_PRIVATE_KEY'),
    },
  };
  const filter = ids.map((id) => `labels.anycloud_deployment = "${id}"`);
  const remaining: string[] = [];
  for (const condition of filter) {
    for await (const [zone, { instances }] of new InstancesClient(
      credentials,
    ).aggregatedListAsync({
      project: credentials.projectId,
      filter: condition,
    }))
      remaining.push(
        ...(instances ?? []).map((i) => `instance ${zone}/${i.name}`),
      );
    for await (const [zone, { disks }] of new DisksClient(
      credentials,
    ).aggregatedListAsync({
      project: credentials.projectId,
      filter: condition,
    }))
      remaining.push(...(disks ?? []).map((d) => `disk ${zone}/${d.name}`));
  }
  return { records, remaining };
}

async function attempt(inventory: Inventory, kind: Attempt) {
  const id = `gcp-t4-${kind}-${inventory.runId}`;
  inventory.jobs.push(id);
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  console.log(`Running ${id}`);
  const job = cliResult(
    [
      'job',
      IMAGE,
      '--id',
      id,
      '--credentials',
      'gcp-spike',
      '--gpu-type',
      't4',
      '--gpus',
      'all',
      ...(kind === 'spot' ? ['--spot'] : []),
      '--wait',
      '--',
      'sh',
      '-c',
      'nvidia-smi && nvidia-smi -L',
    ],
    ATTEMPT_TIMEOUT_MS,
  );
  const logs = cliResult(['logs', id]).stdout;
  const status = cliResult(['status', id, '--history', '--verbose']).stdout;
  const vms = query(
    `SELECT vm_type, region, availability_zone, price_per_hour, cost, created_at, ended_at ` +
      `FROM vms WHERE workload_id = '${id}'`,
  );
  const passed =
    job.status === 0 &&
    /Tesla T4/.test(logs) &&
    vms.length > 0 &&
    vms.every((vm) => T4_TYPES.includes((vm as { vm_type: string }).vm_type));
  evidence(`${kind}-logs.txt`, logs);
  evidence(`${kind}-status.txt`, status);
  return {
    id,
    kind,
    passed,
    exitStatus: job.status,
    timedOut: job.error?.message.includes('ETIMEDOUT') ?? false,
    jobOutput: (job.stdout + job.stderr).slice(-2_000),
    vms,
  };
}

async function run(kinds: Attempt[]) {
  mkdirSync(state, { recursive: true });
  const inventory: Inventory = {
    runId: randomBytes(3).toString('hex'),
    jobs: [],
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  generateCatalog();
  await startApi();
  cli(['credentials', 'new', 'gcp-spike', '--provider', 'gcp']);

  const results = [];
  for (const kind of kinds) {
    const result = await attempt(inventory, kind);
    results.push(result);
    if (result.passed) break;
    // A Job left waiting on quota must not run on after its attempt.
    const terminate = cliResult(['terminate', result.id]);
    if (terminate.status !== 0) console.warn(terminate.stderr);
  }
  const cleanup = await terminateAndVerifyCleanup(inventory.jobs);
  const passed =
    results.some((result) => result.passed) && cleanup.remaining.length === 0;
  evidence('summary.json', { passed, results, cleanup });
  console.log(JSON.stringify({ passed, results, cleanup }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function cleanup() {
  if (!existsSync(inventoryPath)) {
    evidence('cleanup.json', { note: 'no inventory: run created nothing' });
    return;
  }
  const inventory = JSON.parse(
    readFileSync(inventoryPath, 'utf8'),
  ) as Inventory;
  if (!existsSync(catalogPath)) generateCatalog();
  await startApi();
  const result = await terminateAndVerifyCleanup(inventory.jobs);
  evidence('cleanup.json', result);
  if (result.remaining.length) {
    throw new Error(`GCP resources remain: ${result.remaining.join(', ')}`);
  }
}

const [command = 'run', ...rest] = process.argv.slice(2);
if (command === 'run') {
  const kinds = (rest.length ? rest : ['spot', 'ondemand']) as Attempt[];
  for (const kind of kinds)
    if (kind !== 'spot' && kind !== 'ondemand')
      throw new Error(`Unknown attempt ${kind}`);
  await run(kinds);
} else if (command === 'cleanup') {
  await cleanup();
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
