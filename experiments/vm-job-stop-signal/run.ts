#!/usr/bin/env tsx
/**
 * Live check: does `anycloud terminate` give a running VM Job's
 * container SIGTERM on each cloud? It runs the branch's API and CLI, starts one
 * VM Job per target whose process writes a marker blob when it gets SIGTERM,
 * terminates them, and asserts every marker arrives.
 *
 * `run [target...]` (default: azure aws gcp) and `cleanup` share a state
 * directory under RUNNER_TEMP that holds the API database, so cleanup can
 * terminate the run's Jobs and delete its marker container after a failure.
 * Reports in SPIKE_OUTPUT_DIR hold no credential, and the API log's SAS
 * signatures are redacted.
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
import { createStorageProvider } from '../../src/api/services/cloud-config.js';
import { canMintScopedStorageToken } from '../../src/api/services/gateways/cloud.js';
import { CloudType } from '../../src/shared/cloud.js';
import { ObjectNotFoundError } from '../../src/shared/errors.js';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

// The marker container is created in this process, which, like the API it
// starts, has no persisted API identity; IS_TEST supplies the test identity.
process.env.IS_TEST = 'true';
const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'vm-job-stop-signal');
const inventoryPath = join(state, 'inventory.json');
// Kept out of the evidence until its SAS signatures are redacted.
const apiLogPath = join(state, 'api.log');
const PORT = 18_431;
const API_URL = `http://127.0.0.1:${PORT}`;
// Azure regions other subscriptions' workloads use are avoided on purpose.
const MARKER_REGION = 'eastus';

type Target = 'azure' | 'aws' | 'gcp';
const TARGETS: Record<
  Target,
  {
    provider: string;
    vmTypes: string[];
    regions: string;
    env: () => object;
  }
> = {
  azure: {
    provider: 'azure',
    // eastus ran out of Standard_D2s_v5 capacity in run 42934468839.
    vmTypes: ['Standard_D2s_v5', 'Standard_D2as_v5', 'Standard_D2s_v4'],
    regions: 'eastus,eastus2,centralus',
    env: () => ({
      AZURE_APPLICATION_ID: required('AZURE_CLIENT_ID'),
      AZURE_SECRET: required('AZURE_CLIENT_SECRET'),
      AZURE_SUBSCRIPTION_ID: required('AZURE_SUBSCRIPTION_ID'),
      AZURE_DIRECTORY_ID: required('AZURE_TENANT_ID'),
    }),
  },
  aws: {
    provider: 'aws',
    vmTypes: ['t3.small', 't3a.small'],
    regions: 'us-east-1,us-east-2',
    env: () => ({
      AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
    }),
  },
  gcp: {
    provider: 'gcp',
    vmTypes: ['e2-standard-2', 'n2-standard-2'],
    regions: 'us-central1,us-east4',
    env: () => ({
      GCP_PROJECT_ID: required('GCP_PROJECT_ID'),
      GCP_CLIENT_EMAIL: required('GCP_CLIENT_EMAIL'),
      GCP_PRIVATE_KEY: required('GCP_PRIVATE_KEY'),
    }),
  },
};

interface Inventory {
  runId: string;
  container: string;
  jobs: Record<string, string>;
}

// The Job's process: a "started" marker, then a "term" marker on SIGTERM.
const JOB_SCRIPT = `
import os, signal, sys, time, urllib.request
def put(name):
    request = urllib.request.Request(
        f"{os.environ['MARKER_BASE']}/{name}?{os.environ['MARKER_SAS']}",
        data=str(time.time()).encode(), method="PUT",
        headers={"x-ms-blob-type": "BlockBlob"})
    urllib.request.urlopen(request, timeout=10).read()
def on_term(*_):
    put("term")
    sys.exit(0)
signal.signal(signal.SIGTERM, on_term)
put("started")
while True:
    time.sleep(1)
`;

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

function cli(args: string[], env: object = {}, timeoutMs = 300_000) {
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
        ...env,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `anycloud ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).slice(-600)}`,
    );
  }
  return result.stdout;
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
    evidence(
      'api.log',
      readFileSync(apiLogPath, 'utf8').replace(
        /sig=[^&\s"']+/g,
        'sig=REDACTED',
      ),
    );
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

function markerStorage() {
  return createStorageProvider({
    cloudProvider: CloudType.Azure,
    region: MARKER_REGION,
    credentials: {
      applicationId: required('AZURE_CLIENT_ID'),
      secret: required('AZURE_CLIENT_SECRET'),
      directoryId: required('AZURE_TENANT_ID'),
      subscriptionId: required('AZURE_SUBSCRIPTION_ID'),
    },
  });
}

async function marker(
  container: string,
  path: string,
): Promise<number | undefined> {
  try {
    const { stream } = await markerStorage().downloadObject(container, path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Number(Buffer.concat(chunks).toString()) * 1000;
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return undefined;
    throw error;
  }
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
    await sleep(5_000);
  }
}

/** Terminate the Jobs and wait until the API has deleted every VM. */
async function terminateAndAwaitCleanup(ids: string[]): Promise<unknown[]> {
  if (ids.length === 0) return [];
  // An already-terminated Job may refuse; the wait below asserts the outcome.
  try {
    cli(['terminate', ...ids]);
  } catch (error) {
    console.warn(String(error));
  }
  const list = ids.map((id) => `'${id}'`).join(',');
  return until('native cleanup of every Job', 15 * 60_000, async () => {
    const { rows } = JSON.parse(
      cli([
        'db',
        'query',
        '--json',
        `SELECT w.id, w.state, w.cleaned_at, ` +
          `(SELECT COUNT(*) FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL) AS live_vms ` +
          `FROM workloads w WHERE w.id IN (${list})`,
      ]),
    ) as {
      rows: { id: string; cleaned_at: unknown; live_vms: number }[];
    };
    const done =
      rows.length === ids.length &&
      rows.every((row) => row.cleaned_at !== null && row.live_vms === 0);
    return done ? rows : undefined;
  });
}

async function run(targets: Target[]) {
  mkdirSync(state, { recursive: true });
  const runId = randomBytes(3).toString('hex');
  const inventory: Inventory = {
    runId,
    container: `anycloud-stop-signal-${runId}`,
    jobs: {},
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await startApi();

  const storage = markerStorage();
  if (!canMintScopedStorageToken(storage))
    throw new Error('Azure storage does not mint');
  await storage.upsertBucket(inventory.container, 'spike', runId, 'spike');
  const token = await storage.mintScopedStorageToken([
    { bucket: inventory.container, mode: 'readwrite' },
  ]);
  const sas = (token?.credentials as { sasToken?: string }).sasToken;
  if (!sas) throw new Error('No SAS minted');

  for (const target of targets) {
    const spec = TARGETS[target];
    const id = `stop-signal-${target}-${runId}`;
    inventory.jobs[target] = id;
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    console.log(`Submitting ${id}; markers in ${inventory.container}`);
    cli(
      ['credentials', 'new', `${target}-spike`, '--provider', spec.provider],
      spec.env(),
    );
    cli([
      'job',
      'python:3.12-slim',
      '--id',
      id,
      '--credentials',
      `${target}-spike`,
      '--regions',
      spec.regions,
      ...spec.vmTypes.flatMap((vmType) => ['--vm-type', vmType]),
      '-e',
      `MARKER_BASE=https://${storage.storageAccountName}.blob.core.windows.net/${inventory.container}/${target}`,
      '-e',
      `MARKER_SAS=${sas.replace(/^\?/, '')}`,
      '--',
      'python3',
      '-u',
      '-c',
      `import base64; exec(base64.b64decode('${Buffer.from(JOB_SCRIPT).toString('base64')}'))`,
    ]);
  }

  // Each target reports on its own, so one cloud's failure keeps the others'.
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const started = await until(`${target} started`, 20 * 60_000, () =>
        marker(inventory.container, `${target}/started`),
      );
      const terminatedAt = Date.now();
      cli(['terminate', inventory.jobs[target]!]);
      const term = await until(`${target} SIGTERM marker`, 5 * 60_000, () =>
        marker(inventory.container, `${target}/term`),
      ).catch(() => undefined);
      return {
        target,
        job: inventory.jobs[target],
        startedAt: new Date(started).toISOString(),
        terminatedAt: new Date(terminatedAt).toISOString(),
        sigtermMarker: term !== undefined,
        sigtermAfterTerminateMs:
          term === undefined ? null : Math.round(term - terminatedAt),
      };
    }),
  );
  const results = settled.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          target: targets[index],
          job: inventory.jobs[targets[index]!],
          sigtermMarker: false,
          error: String(outcome.reason),
        },
  );
  const cleanup = await terminateAndAwaitCleanup(Object.values(inventory.jobs));
  await storage.deleteBucket(inventory.container);
  const passed = results.every((result) => result.sigtermMarker);
  evidence('summary.json', { passed, results, cleanup });
  console.log(JSON.stringify({ passed, results }, null, 2));
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
  await startApi();
  const jobs = await terminateAndAwaitCleanup(Object.values(inventory.jobs));
  const storage = markerStorage();
  await storage.deleteBucket(inventory.container);
  const containerLeft = await storage.hasBucket(inventory.container);
  evidence('cleanup.json', {
    jobs,
    container: inventory.container,
    containerLeft,
  });
  if (containerLeft) throw new Error(`${inventory.container} remains`);
}

const [command = 'run', ...rest] = process.argv.slice(2);
if (command === 'run') {
  const targets = (rest.length ? rest : ['azure', 'aws', 'gcp']) as Target[];
  for (const target of targets)
    if (!(target in TARGETS)) throw new Error(`Unknown target ${target}`);
  await run(targets);
} else if (command === 'cleanup') {
  await cleanup();
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
