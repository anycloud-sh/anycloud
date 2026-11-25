#!/usr/bin/env tsx
/**
 * Live check: do VM Jobs run on GCP C4A (Axion, arm64)? It builds the GCP
 * catalog with the branch's fetcher (SkyPilot rows plus C4A priced from Cloud
 * Billing), seeds the branch's API and CLI with it, and runs a spot
 * `c4a-highmem-16` Job and an on-demand `c4a-standard-4` Job of a multi-arch
 * public image in europe-west4. Each must print `aarch64` and pin the image's
 * arm64 digest. An amd64-only image and a mixed arm64/amd64 type list must be
 * refused before any VM starts.
 *
 * The published catalog has no C4A rows until this branch's fetcher runs on
 * main, so the run points GitHub's catalog hosts at 0.0.0.0 while the API runs:
 * its refresh fails and it keeps the seeded catalog.
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
import { GcpCatalogFetcher } from '../../src/shared/catalog/gcp.js';
import { entriesToCSV } from '../../src/shared/catalog/fetcher.js';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'gcp-c4a-jobs');
const inventoryPath = join(state, 'inventory.json');
const apiLogPath = join(state, 'api.log');
const PORT = 18_434;
const API_URL = `http://127.0.0.1:${PORT}`;
const IMAGE = 'alpine:3.20';
// Docker Hub's per-architecture repository: an amd64 build only.
const AMD64_ONLY_IMAGE = 'amd64/alpine:3.20';
const REGION = 'europe-west4';
const JOBS = [
  { key: 'spot', vmTypes: ['c4a-highmem-16'], spot: true },
  { key: 'on-demand', vmTypes: ['c4a-standard-4'], spot: false },
];
const CATALOG_HOSTS = ['raw.githubusercontent.com', 'api.github.com'];

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
        GCP_PROJECT_ID: required('GCP_PROJECT_ID'),
        GCP_CLIENT_EMAIL: required('GCP_CLIENT_EMAIL'),
        GCP_PRIVATE_KEY: required('GCP_PRIVATE_KEY'),
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

function sudo(script: string) {
  const asRoot = process.getuid?.() === 0;
  const result = spawnSync(
    asRoot ? 'sh' : 'sudo',
    asRoot ? ['-c', script] : ['-n', 'sh', '-c', script],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`failed: ${script}`);
}

/** Build the branch's GCP catalog, then hold the API and CLI to it. */
async function seedCatalog() {
  const entries = await new GcpCatalogFetcher({
    projectId: required('GCP_PROJECT_ID'),
    clientEmail: required('GCP_CLIENT_EMAIL'),
    privateKey: required('GCP_PRIVATE_KEY'),
  }).fetchAll();
  const csv = entriesToCSV(entries);
  for (const dir of [state, join(state, 'cli')]) {
    mkdirSync(join(dir, 'catalogs'), { recursive: true });
    writeFileSync(join(dir, 'catalogs', 'gcp.csv'), csv);
  }
  const c4a = entries.filter((entry) => entry.instanceType.startsWith('c4a-'));
  evidence('catalog-c4a.csv', entriesToCSV(c4a));
  if (!existsSync('/etc/hosts.gcp-c4a')) {
    sudo(
      `cp /etc/hosts /etc/hosts.gcp-c4a && echo "0.0.0.0 ${CATALOG_HOSTS.join(' ')}" >> /etc/hosts`,
    );
  }
  process.on('exit', () => {
    if (existsSync('/etc/hosts.gcp-c4a'))
      sudo('mv /etc/hosts.gcp-c4a /etc/hosts');
  });
  return {
    rows: entries.length,
    arm64Types: [
      ...new Set(
        entries.filter((e) => e.arch === 'arm64').map((e) => e.instanceType),
      ),
    ].length,
    c4aRows: c4a.length,
    europeWest4: c4a
      .filter((entry) => entry.region === REGION)
      .map(({ instanceType, availabilityZone, price, spotPrice, arch }) => ({
        instanceType,
        availabilityZone,
        price,
        spotPrice,
        arch,
      })),
    c4aRegions: [...new Set(c4a.map((entry) => entry.region))].sort(),
  };
}

async function startApi(seed = true): Promise<void> {
  if (!existsSync(join(root, 'dist/api/server.js'))) {
    const build = spawnSync('yarn', ['build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('yarn build failed');
  }
  // Cleanup only terminates: it needs no C4A rows.
  if (seed) {
    const catalog = await seedCatalog();
    evidence('catalog.json', catalog);
    console.log(JSON.stringify(catalog, null, 2));
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
  const id = `c4a-${name}-${randomBytes(3).toString('hex')}`;
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

/** Submit a Job, follow it to completion, and read what it ran. */
async function job(
  id: string,
  { vmTypes, spot }: { vmTypes: string[]; spot: boolean },
  expectedDigest: string | null,
) {
  console.log(`Submitting ${id}`);
  const submittedAt = Date.now();
  cli([
    'job',
    IMAGE,
    '--id',
    id,
    '--credentials',
    'gcp-spike',
    '--regions',
    REGION,
    ...vmTypes.flatMap((vmType) => ['--vm-type', vmType]),
    ...(spot ? ['--spot'] : []),
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
  const cleanup = await terminateAndAwaitCleanup(id);
  return {
    id,
    completed: waited.status === 0,
    printedAarch64: logs.includes('arch=aarch64'),
    pinnedArm64Digest:
      expectedDigest !== null && spec?.image_digest === expectedDigest,
    spec,
    secondsToCompletion: Math.round((Date.now() - submittedAt) / 1000),
    logs: logs.slice(-2000),
    wait: waited.stdout.trim(),
    vms,
    cleanup,
  };
}

async function run() {
  mkdirSync(state, { recursive: true });
  const suffix = randomBytes(3).toString('hex');
  const ids = JOBS.map(({ key }) => `c4a-${key}-${suffix}`);
  writeFileSync(inventoryPath, JSON.stringify({ ids }));
  await startApi();
  cli(['credentials', 'new', 'gcp-spike', '--provider', 'gcp']);

  const refusals = [
    refusal(
      'amd64-only',
      [
        AMD64_ONLY_IMAGE,
        '--credentials',
        'gcp-spike',
        '--vm-type',
        'c4a-standard-4',
        '--spot',
      ],
      'has no linux/arm64 build',
    ),
    refusal(
      'mixed-list',
      [
        IMAGE,
        '--credentials',
        'gcp-spike',
        '--vm-type',
        'c4a-standard-4',
        '--vm-type',
        'n2-standard-4',
      ],
      'mixes arm64 (c4a-standard-4) and amd64 (n2-standard-4)',
    ),
  ];

  const expectedDigest = (await inspectImage(IMAGE, null, 'arm64')).digest;
  const jobs = [];
  for (const [index, entry] of JOBS.entries()) {
    jobs.push({ ...entry, ...(await job(ids[index], entry, expectedDigest)) });
  }
  const passed =
    jobs.every(
      (entry) =>
        entry.completed && entry.printedAarch64 && entry.pinnedArm64Digest,
    ) && refusals.every((entry) => entry.refused && entry.noVm);
  evidence('summary.json', { passed, expectedDigest, jobs, refusals });
  console.log(JSON.stringify({ passed, jobs, refusals }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function cleanup() {
  if (!existsSync(inventoryPath)) {
    evidence('cleanup.json', { note: 'no inventory: run created nothing' });
    return;
  }
  const { ids } = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
    ids: string[];
  };
  await startApi(false);
  const jobs = [];
  for (const id of ids) jobs.push(await terminateAndAwaitCleanup(id));
  evidence('cleanup.json', { jobs });
}

const [command = 'run'] = process.argv.slice(2);
if (command === 'run') await run();
else if (command === 'cleanup') await cleanup();
else throw new Error(`Unknown command ${command}`);
process.exit();
