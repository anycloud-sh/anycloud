#!/usr/bin/env tsx
/**
 * Azure arm64 runners: Cobalt 100 (Dpsv6) and Ampere Altra (Dpsv5) against
 * today's Dadsv5 runner, as anycloud VM Jobs from the branch's API; see
 * README.md.
 *
 * `preflight` builds the Azure catalog with the branch's fetcher and records
 * the arms' catalog rows (Arch, family, prices), Canonical's Ubuntu 24.04
 * SKUs and the subscription's quotas, creating nothing. `run [--rounds=8]
 * [--parallel=2] [--arms=<type,...>]` seeds the API and CLI with that
 * catalog and runs three of backmesh's benchmark builds in one on-demand Job
 * per arm a round. `spot` tries one spot Job of each 2-vCPU Arm type in each
 * region, one at a time. `cleanup` restarts the API from the run's state and
 * checks Azure for anything left. `report <results.json...>` rewrites the
 * report without a cloud.
 *
 * The published catalog has no Azure Arch column until this branch's fetcher
 * runs on main, so the run points GitHub's catalog hosts at 0.0.0.0 while the
 * API runs: its refresh fails and it keeps the seeded catalog.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
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
import { promisify } from 'node:util';
import { DefaultAzureCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';
import { AzureCatalogFetcher } from '../../src/shared/catalog/azure.js';
import { entriesToCSV } from '../../src/shared/catalog/fetcher.js';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'azure-arm64');
const inventoryPath = join(state, 'inventory.json');
const PORT = 18_446;
const API_URL = `http://127.0.0.1:${PORT}`;
const JOB_TIMEOUT_MS = 25 * 60_000;
// No round starts after this, so the last ones end, and the run cleans up,
// inside the Spike workflow's 85-minute step.
const ROUNDS_WINDOW_MS = 50 * 60_000;
// Stops starting rounds once the VMs' and disks' list-price cost reaches this.
const COST_CAP_USD = 8;
const CATALOG_HOSTS = ['raw.githubusercontent.com', 'api.github.com'];

/** The builds' region: Cobalt's and Ampere's quota is there. */
const REGION = 'eastus2';
/** Today's runner type first; every other arm is compared with it. */
const ARMS = ['Standard_D4ads_v5', 'Standard_D4ps_v6', 'Standard_D4ps_v5'];
/** The spot probe's regions and types: 2 vCPUs, under CI's 3 spot vCPUs a region. */
const SPOT_REGIONS = ['eastus2', 'centralus', 'westeurope'];
const SPOT_TYPES = ['Standard_D2ps_v6', 'Standard_D2ps_v5'];
/** Every type the preflight reports on: the arms, the probe's and the high-memory Cobalt. */
const PREFLIGHT_TYPES = [
  ...ARMS,
  ...SPOT_TYPES,
  'Standard_D4pds_v6',
  'Standard_E4ps_v6',
  'Standard_D16ps_v6',
  'Standard_E16ps_v6',
];
// backmesh's Azure runner disk: 100 GB on the `high` tier, Premium SSD P10
// (128 GiB), $19.71 a month of 730 hours.
const DISK_ARGS = ['--disk-size', '100'];
const DISK_PER_HOUR = 19.71 / 730;

interface Inventory {
  runId: string;
  jobs: string[];
}

interface JobResult {
  id: string;
  arm: string;
  round: number;
  ok: boolean;
  zone: string | null;
  attempts: number;
  vmSeconds: number | null;
  pricePerHour: number | null;
  timings: Record<string, number>;
  arch: string | null;
  cpu: string | null;
  failure?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const creds = () => ({
  subscriptionId: required('AZURE_SUBSCRIPTION_ID'),
  tenantId: required('AZURE_TENANT_ID'),
  clientId: required('AZURE_CLIENT_ID'),
  clientSecret: required('AZURE_CLIENT_SECRET'),
});

function evidence(name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

const execFileAsync = promisify(execFile);
async function cli(args: string[], env: object = {}, timeoutMs = 300_000) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(root, 'dist/cli/index.js'), ...args],
    {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
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
  ).catch((error: { stderr?: string; stdout?: string; code?: unknown }) => {
    throw Object.assign(
      new Error(
        `anycloud ${args[0]} failed (${String(error.code)}): ${(error.stderr || error.stdout || '').slice(-600)}`,
      ),
      { output: error.stdout },
    );
  });
  return stdout;
}

async function query<T>(sql: string): Promise<T[]> {
  return (
    JSON.parse(await cli(['db', 'query', '--json', sql])) as { rows: T[] }
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

/** An ARM GET with the client-credentials token. */
async function arm<T>(path: string): Promise<T> {
  const { tenantId, clientId, clientSecret } = creds();
  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://management.azure.com/.default',
      }),
    },
  );
  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };
  const response = await fetch(`https://management.azure.com${path}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!response.ok)
    throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Builds the branch's Azure catalog and records, for the preflight's types,
 * their rows in the spot regions, the SKUs' raw `CpuArchitectureType`,
 * Canonical's Ubuntu 24.04 SKUs, and the quotas of the types' families.
 */
async function preflight() {
  const entries = await new AzureCatalogFetcher(creds()).fetchAll();
  const sub = `/subscriptions/${creds().subscriptionId}`;
  const rows = entries
    .filter(
      (e) =>
        PREFLIGHT_TYPES.includes(e.instanceType) &&
        SPOT_REGIONS.includes(e.region),
    )
    .map(({ instanceType, region, price, spotPrice, quotaGroup, arch }) => ({
      instanceType,
      region,
      price,
      spotPrice,
      quotaGroup,
      arch,
    }));
  const skus = await arm<{
    value: {
      name: string;
      locations: string[];
      capabilities?: { name: string; value: string }[];
    }[];
  }>(
    `${sub}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${REGION}'`,
  );
  const capabilities = Object.fromEntries(
    skus.value
      .filter((s) => PREFLIGHT_TYPES.includes(s.name))
      .map((s) => [
        s.name,
        Object.fromEntries(
          (s.capabilities ?? [])
            .filter((c) =>
              [
                'CpuArchitectureType',
                'HyperVGenerations',
                'PremiumIO',
                'MaxResourceVolumeMB',
                'vCPUs',
                'MemoryGB',
              ].includes(c.name),
            )
            .map((c) => [c.name, c.value]),
        ),
      ]),
  );
  const images = await arm<{ name: string }[]>(
    `${sub}/providers/Microsoft.Compute/locations/${REGION}/publishers/canonical/artifacttypes/vmimage/offers/ubuntu-24_04-lts/skus?api-version=2024-07-01`,
  );
  const families = new Set(rows.map((r) => r.quotaGroup?.toLowerCase()));
  const quotas = Object.fromEntries(
    await Promise.all(
      SPOT_REGIONS.map(async (region) => {
        const usages = await arm<{
          value: {
            name: { value: string };
            currentValue: number;
            limit: number;
          }[];
        }>(
          `${sub}/providers/Microsoft.Compute/locations/${region}/usages?api-version=2024-07-01`,
        );
        return [
          region,
          usages.value
            .filter(
              (u) =>
                families.has(u.name.value.toLowerCase()) ||
                ['cores', 'lowPriorityCores'].includes(u.name.value),
            )
            .map((u) => `${u.name.value} ${u.currentValue}/${u.limit}`),
        ];
      }),
    ),
  );
  const summary = {
    rows,
    capabilities,
    ubuntu2404Skus: images.map((i) => i.name).sort(),
    quotas,
    arm64Types: [
      ...new Set(
        entries.filter((e) => e.arch === 'arm64').map((e) => e.instanceType),
      ),
    ].sort(),
  };
  evidence('preflight.json', summary);
  console.log(JSON.stringify({ ...summary, arm64Types: undefined }, null, 2));
  for (const type of PREFLIGHT_TYPES.filter((t) => t !== ARMS[0])) {
    if (!rows.some((r) => r.instanceType === type && r.arch === 'arm64'))
      throw new Error(`The branch's catalog doesn't mark ${type} arm64`);
  }
  for (const sku of ['minimal-arm64', 'server-arm64'])
    if (!summary.ubuntu2404Skus.includes(sku))
      throw new Error(`Canonical's ubuntu-24_04-lts has no ${sku} SKU`);
  return entries;
}

/** Holds the API and CLI to the branch's catalog for the run. */
function seedCatalog(csv: string) {
  for (const dir of [state, join(state, 'cli')]) {
    mkdirSync(join(dir, 'catalogs'), { recursive: true });
    writeFileSync(join(dir, 'catalogs', 'azure.csv'), csv);
  }
  if (!existsSync('/etc/hosts.azure-arm64')) {
    sudo(
      `cp /etc/hosts /etc/hosts.azure-arm64 && echo "0.0.0.0 ${CATALOG_HOSTS.join(' ')}" >> /etc/hosts`,
    );
  }
  // /etc/hosts is bind-mounted in a container runner: rewrite it in place. A
  // failure must not stop the API's own exit handler.
  process.on('exit', () => {
    try {
      if (existsSync('/etc/hosts.azure-arm64'))
        sudo(
          'cat /etc/hosts.azure-arm64 > /etc/hosts && rm /etc/hosts.azure-arm64',
        );
    } catch (error) {
      console.error(error);
    }
  });
}

const apiHealthy = () =>
  fetch(`${API_URL}/health`)
    .then((response) => response.ok)
    .catch(() => false);

async function startApi(): Promise<void> {
  if (await apiHealthy()) return;
  if (!existsSync(join(root, 'dist/api/server.js'))) {
    const build = spawnSync('yarn', ['build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('yarn build failed');
  }
  mkdirSync(state, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeLocalApiToken(state, token);
  writeLocalApiToken(join(state, 'cli'), token);
  const logPath = join(state, 'api.log');
  const server = spawn(process.execPath, [join(root, 'dist/api/server.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
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
  server.unref();
  process.on('exit', () => {
    server.kill('SIGTERM');
    evidence('api.log', readFileSync(logPath, 'utf8'));
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await apiHealthy()) return;
    await sleep(1_000);
  }
  throw new Error('The API never became healthy; see its log');
}

/** Seeds the catalog, starts the API and records an empty inventory. */
async function setUp(): Promise<Inventory> {
  mkdirSync(state, { recursive: true });
  seedCatalog(entriesToCSV(await preflight()));
  await startApi();
  const { subscriptionId, tenantId, clientId, clientSecret } = creds();
  await cli(['credentials', 'new', 'azure-spike', '--provider', 'azure'], {
    AZURE_APPLICATION_ID: clientId,
    AZURE_SECRET: clientSecret,
    AZURE_SUBSCRIPTION_ID: subscriptionId,
    AZURE_DIRECTORY_ID: tenantId,
  });
  const inventory = { runId: randomBytes(3).toString('hex'), jobs: [] };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  return inventory;
}

/** Parses the guest's `BENCH`, `LSCPU` and `ARCH` lines. */
function parseLog(log: string) {
  const timings: Record<string, number> = {};
  let cpu: string | null = null;
  let arch: string | null = null;
  for (const line of log.split('\n').map((l) => l.trim())) {
    const bench = /^BENCH (\S+) (\S+) (\d+)$/.exec(line);
    if (bench) timings[`${bench[1]} ${bench[2]}`] = Number(bench[3]) / 1000;
    cpu = /^LSCPU Model name:\s*(.*)$/.exec(line)?.[1] ?? cpu;
    arch = /^ARCH (\S+)$/.exec(line)?.[1] ?? arch;
  }
  return {
    timings,
    cpu,
    arch,
    done: log.includes('BENCH_DONE') && !log.includes('BENCH_FAIL'),
  };
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

/**
 * Submits a Job and follows it to its end; returns its log, its VMs (failed
 * launches too, newest first) and its Running event's boot marks and time.
 */
async function job(
  inventory: Inventory,
  id: string,
  args: string[],
  command: string,
) {
  inventory.jobs.push(id);
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await cli([
    'job',
    'docker:27-cli',
    '--id',
    id,
    '--credentials',
    'azure-spike',
    '--max-retries',
    '0',
    '--no-checkpoint',
    '--host-docker',
    ...args,
    '--',
    'sh',
    '-c',
    command,
  ]);
  // The VM is deleted when the Job ends, so its log is followed from the start.
  const log = await cli(['logs', id, '--follow'], {}, JOB_TIMEOUT_MS).catch(
    (error: Error & { output?: string }) => `${error.output}\n${error.message}`,
  );
  writeFileSync(join(output, `${id}.log`), log);
  await cli(['terminate', id]).catch(() => undefined);
  const vms = await until(`${id}'s VMs to end`, 10 * 60_000, async () => {
    const rows = await query<{
      availability_zone: string | null;
      price_per_hour: number | null;
      created_at: number;
      ended_at: number | null;
    }>(
      `SELECT availability_zone, price_per_hour, created_at, ended_at FROM vms WHERE workload_id = '${id}' ORDER BY created_at DESC`,
    );
    return rows.every((row) => row.ended_at) ? rows : undefined;
  });
  const events = await query<{
    state: string;
    metadata: string | null;
    created_at: number;
  }>(
    `SELECT state, metadata, created_at FROM workload_events WHERE workload_id = '${id}' ORDER BY id`,
  );
  const running = events.find((e) => e.state === 'running');
  const marks = ((running?.metadata &&
    (JSON.parse(running.metadata) as { bootMarks?: Record<string, number> })
      .bootMarks) ||
    {}) as Record<string, number>;
  return { log, vms, events, running, marks };
}

/** One on-demand build Job of `arm`. */
async function runBuild(
  inventory: Inventory,
  arm: string,
  round: number,
): Promise<JobResult> {
  const id = `aa-${inventory.runId}-r${round}-${arm.replace('Standard_', '').replace('_', '-').toLowerCase()}`;
  const guest = Buffer.concat([
    Buffer.from('echo "ARCH $(uname -m)"\n'),
    readFileSync(join(import.meta.dirname, '..', 'local-nvme', 'guest.sh')),
  ]);
  const { log, vms, running, marks } = await job(
    inventory,
    id,
    ['--regions', REGION, '--vm-type', arm, ...DISK_ARGS],
    `echo ${guest.toString('base64')} | base64 -d | sh`,
  );
  console.log(`round ${round}: ${id} ended`);
  const parsed = parseLog(log);
  const [vm] = vms;
  const wantArch = arm === ARMS[0] ? 'x86_64' : 'aarch64';
  const ok = parsed.done && parsed.arch === wantArch;
  return {
    id,
    arm,
    round,
    ok,
    zone: vm?.availability_zone ?? null,
    attempts: vms.length,
    vmSeconds: vm
      ? vms.reduce((sum, v) => sum + (v.ended_at! - v.created_at), 0) / 1000
      : null,
    pricePerHour: vm?.price_per_hour ?? null,
    timings: {
      ...(running &&
        vm && {
          'boot launch-to-container':
            (running.created_at - vm.created_at) / 1000,
        }),
      ...(marks['container-started'] !== undefined && {
        'boot kernel-to-container': marks['container-started'],
      }),
      ...parsed.timings,
    },
    arch: parsed.arch,
    cpu: parsed.cpu,
    ...(ok
      ? {}
      : {
          failure: `arch ${parsed.arch}\n${log.split('\n').slice(-40).join('\n')}`,
        }),
  };
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const costOf = (r: JobResult) =>
  ((r.vmSeconds ?? 0) / 3600) * ((r.pricePerHour ?? 0) + DISK_PER_HOUR);

/** Each round starts one Job per arm at once, in a random order. */
async function runRounds(
  inventory: Inventory,
  arms: string[],
  rounds: number,
  parallel: number,
) {
  const results: JobResult[] = [];
  let next = 1;
  const lastStart = Date.now() + ROUNDS_WINDOW_MS;
  const worker = async () => {
    while (next <= rounds && Date.now() < lastStart) {
      const spent = results.reduce((sum, r) => sum + costOf(r), 0);
      if (spent >= COST_CAP_USD) {
        console.warn(`cost cap: $${spent.toFixed(2)} spent; no more rounds`);
        return;
      }
      const round = next++;
      const settled = await Promise.allSettled(
        shuffle(arms).map((arm) => runBuild(inventory, arm, round)),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') results.push(outcome.value);
        else console.error(`round ${round}: ${String(outcome.reason)}`);
      }
      evidence('results.json', { region: REGION, results });
      evidence('report.md', report(results));
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  await verifyClean(inventory);
  console.log(report(results));
  const failed = results.filter((r) => !r.ok);
  if (failed.length || results.length < rounds * arms.length)
    throw new Error(
      `${failed.length} Jobs failed; ${results.length} of ${rounds * arms.length} reported`,
    );
}

/**
 * One spot Job of each 2-vCPU Arm type in each region, one at a time, under
 * CI's 3 spot vCPUs a region: whether it launched, and Azure's refusal if not.
 */
async function spot(inventory: Inventory) {
  const noMarks: Record<string, number> = {};
  const outcomes: Record<string, unknown>[] = [];
  for (const region of SPOT_REGIONS) {
    for (const type of SPOT_TYPES) {
      const id = `aa-${inventory.runId}-spot-${region}-${type.replace('Standard_', '').replace('_', '-').toLowerCase()}`;
      const { log, vms, events, running, marks } = await job(
        inventory,
        id,
        ['--regions', region, '--vm-type', type, '--spot', '--disk-size', '30'],
        'echo "ARCH $(uname -m)"',
      ).catch((error: Error) => ({
        log: error.message,
        vms: [],
        events: [],
        running: undefined,
        marks: noMarks,
      }));
      outcomes.push({
        region,
        type,
        launched: !!running,
        arch: parseLog(log).arch,
        vms: vms.length,
        'kernel-to-container': marks['container-started'] ?? null,
        'launch-to-container':
          running && vms[0]
            ? (running.created_at - vms[0].created_at) / 1000
            : null,
        // A refusal's events carry Azure's code; the log tail has the rest.
        failure: running
          ? null
          : {
              events: events.map((e) => `${e.state} ${e.metadata ?? ''}`),
              log: log.slice(-600),
            },
      });
      evidence('spot.json', outcomes);
      console.log(JSON.stringify(outcomes.at(-1)));
    }
  }
  await verifyClean(inventory);
}

/** Terminates the Jobs, waits for the API's cleanup, then asks Azure. */
async function verifyClean(inventory: Inventory) {
  if (!inventory.jobs.length) return;
  await cli(['terminate', ...inventory.jobs]).catch((error: unknown) =>
    console.warn(String(error)),
  );
  const list = inventory.jobs.map((id) => `'${id}'`).join(',');
  await until('the API to clean up every Job', 15 * 60_000, async () => {
    const [left] = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workloads w WHERE w.id IN (${list}) AND (w.cleaned_at IS NULL OR EXISTS (SELECT 1 FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL))`,
    );
    return left?.n === 0 ? true : undefined;
  });
  const left: string[] = [];
  const resources = new ResourceManagementClient(
    new DefaultAzureCredential(),
    required('AZURE_SUBSCRIPTION_ID'),
  ).resources.list({ filter: "tagName eq 'anycloud_deployment'" });
  for await (const r of resources)
    if (inventory.jobs.includes(r.tags?.anycloud_deployment ?? ''))
      left.push(r.id!);
  evidence('cleanup.json', { jobs: inventory.jobs.length, left });
  if (left.length)
    throw new Error(`Azure resources remain: ${JSON.stringify(left)}`);
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
};
const median = (xs: number[]) => quantile(xs, 0.5);

/** Two-sided Mann-Whitney U, normal approximation with tie correction. */
function mannWhitney(a: number[], b: number[]): number {
  const all = [
    ...a.map((v) => ({ v, g: 0 })),
    ...b.map((v) => ({ v, g: 1 })),
  ].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j]!.v === all[i]!.v) j++;
    for (let k = i; k < j; k++) ranks[k] = (i + j + 1) / 2;
    tieTerm += (j - i) ** 3 - (j - i);
    i = j;
  }
  const n1 = a.length;
  const n2 = b.length;
  const n = n1 + n2;
  const r1 = all.reduce((sum, x, i) => (x.g === 0 ? sum + ranks[i]! : sum), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - (n1 * n2) / 2) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

function normalCdf(z: number): number {
  // Abramowitz and Stegun 26.2.17.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** The timed build commands, which sum to a Job's build time. */
const BUILDS = [
  'pull toolchain-images',
  'docker build',
  'rust build',
  'typescript install',
  'typescript build',
];

function report(results: JobResult[]): string {
  const ok = results.filter((r) => r.ok);
  const of = (arm: string) => ok.filter((r) => r.arm === arm);
  const arms = [...new Set(results.map((r) => r.arm))];
  const metrics: [string, (r: JobResult) => number | undefined][] = [
    ...[...new Set(ok.flatMap((r) => Object.keys(r.timings)))]
      .sort()
      .map((m): [string, (r: JobResult) => number | undefined] => [
        m,
        (r) => r.timings[m],
      ]),
    [
      'all builds',
      (r) =>
        BUILDS.every((b) => r.timings[b] !== undefined)
          ? BUILDS.reduce((sum, b) => sum + r.timings[b]!, 0)
          : undefined,
    ],
    ['VM time per Job', (r) => r.vmSeconds ?? undefined],
    ['cost per Job ($)', (r) => (r.vmSeconds === null ? undefined : costOf(r))],
  ];
  const today = ARMS[0]!;
  const lines: string[] = [];
  for (const a of arms.filter((arm) => arm !== today)) {
    const [ra, rb] = [of(a), of(today)];
    const price = (rs: JobResult[]) =>
      median(rs.map((r) => r.pricePerHour ?? 0));
    lines.push(
      `### ${a} vs ${today} (n = ${ra.length} and ${rb.length})`,
      '',
      `Seconds, except cost; ratio is ${a}'s median over ${today}'s, below 1 is ${a} faster or cheaper. VMs' median price $${price(ra).toFixed(4)}/h and $${price(rb).toFixed(4)}/h, the disk's $${DISK_PER_HOUR.toFixed(4)}/h.`,
      '',
      `| Measure | ${a} median (p90) | ${today} median (p90) | Ratio | Mann-Whitney p |`,
      '| --- | --- | --- | --- | --- |',
    );
    for (const [metric, value] of metrics) {
      const xa = ra.flatMap((r) => value(r) ?? []);
      const xb = rb.flatMap((r) => value(r) ?? []);
      if (!xa.length || !xb.length) continue;
      const digits = metric.startsWith('cost') ? 4 : 1;
      const cell = (xs: number[]) =>
        `${median(xs).toFixed(digits)} (${quantile(xs, 0.9).toFixed(digits)})`;
      lines.push(
        `| ${metric} | ${cell(xa)} | ${cell(xb)} | ${(median(xa) / median(xb)).toFixed(2)} | ${mannWhitney(xa, xb).toPrecision(2)} |`,
      );
    }
    lines.push('');
  }
  lines.push('### Arms', '');
  for (const arm of arms) {
    const all = results.filter((r) => r.arm === arm);
    const failed = all.filter((r) => !r.ok).length;
    lines.push(
      `- ${arm}: ${of(arm)[0]?.cpu ?? '?'} (${of(arm)[0]?.arch ?? '?'}); zones ${[...new Set(of(arm).map((r) => r.zone))].join(', ')}${failed ? `; ${failed} failed` : ''}`,
    );
  }
  const spent = results.reduce((sum, r) => sum + costOf(r), 0);
  lines.push(
    '',
    `${results.length} Jobs, ${results.length - ok.length} failed; VMs' and disks' cost $${spent.toFixed(2)}.`,
  );
  return `${lines.join('\n')}\n`;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'preflight') {
  await preflight();
} else if (command === 'run') {
  const only = flag('arms', '').split(',').filter(Boolean);
  await runRounds(
    await setUp(),
    ARMS.filter((arm) => !only.length || only.includes(arm)),
    Number(flag('rounds', '8')),
    Number(flag('parallel', '2')),
  );
} else if (command === 'spot') {
  await spot(await setUp());
} else if (command === 'cleanup') {
  if (existsSync(inventoryPath)) {
    await startApi();
    await verifyClean(
      JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory,
    );
  }
} else if (command === 'report') {
  console.log(
    report(
      rest.flatMap(
        (path) =>
          (JSON.parse(readFileSync(path, 'utf8')) as { results: JobResult[] })
            .results,
      ),
    ),
  );
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
