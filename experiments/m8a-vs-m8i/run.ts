#!/usr/bin/env tsx
/**
 * m8a (AMD Zen 5) against m8i (Intel) at equal vCPUs: backmesh's five
 * benchmark builds in anycloud VM Jobs; see README.md.
 *
 * `run [--rounds=10] [--parallel=3] [--region=us-east-2]` starts the branch's
 * API and runs rounds of one Job per arm, `--parallel` rounds at a time.
 * `spot` reports m8a's and m8i's spot capacity in three US regions.
 * `cleanup` restarts the API from the run's state directory, terminates the
 * inventory's Jobs and checks AWS for anything left. `report <results.json...>`
 * rewrites the report from saved results, without a cloud.
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
import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
  GetSpotPlacementScoresCommand,
} from '@aws-sdk/client-ec2';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'm8a-vs-m8i');
const inventoryPath = join(state, 'inventory.json');
const PORT = 18_432;
const API_URL = `http://127.0.0.1:${PORT}`;
const JOB_TIMEOUT_MS = 40 * 60_000;
// Stops starting rounds once the VMs' list-price cost reaches this.
const COST_CAP_USD = 8;
const SPOT_LAUNCH_WAIT_MS = 10 * 60_000;
// The last zone's refusal, which ends the launch attempt.
const LAST_ZONE_REFUSAL = /Availability Zone you requested \(([a-z0-9-]+)\)/;

const ARMS = [
  'm8a.xlarge',
  'm8i.xlarge',
  'm8a.4xlarge',
  'm8i.4xlarge',
] as const;
type Arm = (typeof ARMS)[number];
const PAIRS: [Arm, Arm][] = [
  ['m8a.xlarge', 'm8i.xlarge'],
  ['m8a.4xlarge', 'm8i.4xlarge'],
];

interface Inventory {
  runId: string;
  regions: string[];
  jobs: string[];
}

interface JobResult {
  id: string;
  arm: Arm;
  round: number;
  ok: boolean;
  zone: string | null;
  vmSeconds: number | null;
  pricePerHour: number | null;
  timings: Record<string, number>;
  sysbench: Record<string, number>;
  lscpu: Record<string, string>;
  failure?: string;
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
  throw new Error('API never became healthy; see api.log');
}

/** Parses the guest's `LSCPU`, `SYSBENCH` and `BENCH` lines. */
function parseLog(log: string) {
  const timings: Record<string, number> = {};
  const sysbench: Record<string, number> = {};
  const lscpu: Record<string, string> = {};
  for (const line of log.split('\n')) {
    const bench = /^BENCH (\S+) (\S+) (\d+)$/.exec(line.trim());
    if (bench) timings[`${bench[1]} ${bench[2]}`] = Number(bench[3]) / 1000;
    const sys = /^SYSBENCH (\d+) ([\d.]+)$/.exec(line.trim());
    if (sys) sysbench[sys[1] === '1' ? 'single' : 'all'] = Number(sys[2]);
    const cpu = /^LSCPU ([^:]+):\s*(.*)$/.exec(line.trim());
    if (cpu) lscpu[cpu[1]!] = cpu[2]!;
  }
  return { timings, sysbench, lscpu, done: log.includes('BENCH_DONE') };
}

async function runJob(
  inventory: Inventory,
  arm: Arm,
  round: number,
): Promise<JobResult> {
  const id = `m8-${inventory.runId}-r${round}-${arm.replace('.', '-')}`;
  inventory.jobs.push(id);
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const guest = readFileSync(join(import.meta.dirname, 'guest.sh'));
  await cli([
    'job',
    'docker:27-cli',
    '--id',
    id,
    '--credentials',
    'aws-spike',
    '--regions',
    inventory.regions[0]!,
    '--vm-type',
    arm,
    '--disk-size',
    '100',
    '--max-retries',
    '0',
    '--no-checkpoint',
    '--host-docker',
    '--',
    'sh',
    '-c',
    `echo ${guest.toString('base64')} | base64 -d | sh`,
  ]);
  console.log(`round ${round}: submitted ${id}`);
  // The VM is deleted when the Job ends, so its log is followed from the start.
  const log = await cli(['logs', id, '--follow'], {}, JOB_TIMEOUT_MS).catch(
    (error: Error & { output?: string }) => `${error.output}\n${error.message}`,
  );
  writeFileSync(join(output, `${id}.log`), log);
  const parsed = parseLog(log);
  // The API ends the VM after the Job; wait for that, so its lifetime is final.
  await cli(['terminate', id]).catch(() => undefined);
  const vm = await until(`${id}'s VM to end`, 10 * 60_000, async () => {
    const [row] = await query<{
      availability_zone: string | null;
      price_per_hour: number | null;
      created_at: number;
      ended_at: number | null;
    }>(
      `SELECT availability_zone, price_per_hour, created_at, ended_at FROM vms WHERE workload_id = '${id}' ORDER BY created_at DESC LIMIT 1`,
    );
    return row?.ended_at ? row : row ? undefined : null;
  });
  return {
    id,
    arm,
    round,
    ok: parsed.done,
    zone: vm?.availability_zone ?? null,
    vmSeconds: vm?.ended_at ? (vm.ended_at - vm.created_at) / 1000 : null,
    pricePerHour: vm?.price_per_hour ?? null,
    timings: parsed.timings,
    sysbench: parsed.sysbench,
    lscpu: parsed.lscpu,
    ...(parsed.done ? {} : { failure: log.split('\n').slice(-40).join('\n') }),
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

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const costOf = (r: JobResult) =>
  ((r.vmSeconds ?? 0) / 3600) * (r.pricePerHour ?? 0);

/** Records an empty inventory, then starts the API with CI's AWS credentials. */
async function setUp(regions: string[]): Promise<Inventory> {
  mkdirSync(state, { recursive: true });
  mkdirSync(output, { recursive: true });
  const inventory: Inventory = {
    runId: randomBytes(3).toString('hex'),
    regions,
    jobs: [],
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await startApi();
  await cli(['credentials', 'new', 'aws-spike', '--provider', 'aws'], {
    AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
  });
  return inventory;
}

async function run(rounds: number, parallel: number, region: string) {
  const inventory = await setUp([region]);
  const results: JobResult[] = [];
  const save = () => {
    evidence('results.json', { region, results });
    evidence('report.md', report(results));
  };
  // Each round starts one Job per arm at once, in a random order, so drift
  // over the run and a slow minute hit every arm alike.
  let next = 1;
  const worker = async () => {
    while (next <= rounds) {
      const spent = results.reduce((sum, r) => sum + costOf(r), 0);
      if (spent >= COST_CAP_USD) {
        console.warn(`Cost cap: $${spent.toFixed(2)} spent; no more rounds`);
        return;
      }
      const round = next++;
      const settled = await Promise.allSettled(
        shuffle(ARMS).map((arm) => runJob(inventory, arm, round)),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') results.push(outcome.value);
        else console.error(`round ${round}: ${String(outcome.reason)}`);
      }
      save();
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  await verifyClean(inventory);
  const failed = results.filter((r) => !r.ok);
  console.log(report(results));
  if (failed.length || results.length < rounds * ARMS.length) {
    throw new Error(
      `${failed.length} Jobs failed; ${results.length} of ${rounds * ARMS.length} reported`,
    );
  }
}

/** Terminates the Jobs, waits for the API's cleanup, then asks AWS directly. */
async function verifyClean(inventory: Inventory) {
  if (inventory.jobs.length) {
    await cli(['terminate', ...inventory.jobs]).catch((error: unknown) =>
      console.warn(String(error)),
    );
  }
  const list = inventory.jobs.map((id) => `'${id}'`).join(',') || "''";
  await until('the API to clean up every Job', 15 * 60_000, async () => {
    const [left] = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workloads w WHERE w.id IN (${list}) AND (w.cleaned_at IS NULL OR EXISTS (SELECT 1 FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL))`,
    );
    return left?.n === 0 ? true : undefined;
  });
  const filter = { Name: 'tag:anycloud_deployment', Values: inventory.jobs };
  const left = { instances: [] as string[], volumes: [] as string[] };
  for (const region of inventory.jobs.length ? inventory.regions : []) {
    const ec2 = new EC2Client({ region });
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          filter,
          {
            Name: 'instance-state-name',
            Values: ['pending', 'running', 'stopping', 'stopped'],
          },
        ],
      }),
    );
    const { Volumes } = await ec2.send(
      new DescribeVolumesCommand({ Filters: [filter] }),
    );
    left.instances.push(
      ...(Reservations ?? []).flatMap((r) =>
        (r.Instances ?? []).map((i) => i.InstanceId!),
      ),
    );
    left.volumes.push(...(Volumes ?? []).map((v) => v.VolumeId!));
  }
  evidence('cleanup.json', { jobs: inventory.jobs.length, left });
  if (left.instances.length || left.volumes.length) {
    throw new Error(`AWS resources remain: ${JSON.stringify(left)}`);
  }
}

const SPOT_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

/**
 * Spot capacity for each arm: EC2's placement scores (1–10) for one instance
 * in each region and in each of its zones, then one real spot VM Job per arm
 * and region through anycloud, which reports whether a VM launched, where,
 * and the capacity refusals the API logged on the way.
 */
async function spot() {
  const ec2 = new EC2Client({ region: 'us-east-1' });
  const scores: Record<string, unknown> = {};
  for (const arm of ARMS) {
    for (const single of [false, true]) {
      const { SpotPlacementScores } = await ec2.send(
        new GetSpotPlacementScoresCommand({
          InstanceTypes: [arm],
          TargetCapacity: 1,
          SingleAvailabilityZone: single,
          RegionNames: SPOT_REGIONS,
        }),
      );
      scores[`${arm} ${single ? 'zones' : 'regions'}`] = (
        SpotPlacementScores ?? []
      ).map((s) => `${s.AvailabilityZoneId ?? s.Region} ${s.Score}`);
    }
  }
  evidence('spot-scores.json', scores);
  console.log(JSON.stringify(scores, null, 2));

  const inventory = await setUp(SPOT_REGIONS);
  const launches = await Promise.all(
    SPOT_REGIONS.flatMap((region) =>
      ARMS.map(async (arm, index) => {
        // Such as m8s-1a2b3c-use2-a4; IDs are at most 28 characters.
        const id = `m8s-${inventory.runId}-${region.replace(/^us-(\w)\w+-/, 'us$1')}-${arm[2]}${arm.includes('4x') ? 4 : 1}`;
        inventory.jobs.push(id);
        writeFileSync(inventoryPath, JSON.stringify(inventory));
        // Spaced out: twelve launches at once hit the account's
        // RunInstances rate limit in run 45247427638.
        await sleep(
          (SPOT_REGIONS.indexOf(region) * ARMS.length + index) * 10_000,
        );
        const submitted = Date.now();
        await cli([
          'job',
          'alpine:3.20',
          '--id',
          id,
          '--credentials',
          'aws-spike',
          '--regions',
          region,
          '--vm-type',
          arm,
          '--spot',
          '--max-retries',
          '0',
          '--no-checkpoint',
          '--',
          'sleep',
          '60',
        ]);
        // A VM row exists from "Creating VM"; its zone is set once EC2 has
        // accepted the launch.
        const outcome = await until(
          `${id}'s VM`,
          SPOT_LAUNCH_WAIT_MS,
          async () => {
            const [row] = await query<{ state: string; zone: string | null }>(
              `SELECT w.state, (SELECT v.availability_zone FROM vms v WHERE v.workload_id = w.id AND v.availability_zone IS NOT NULL LIMIT 1) AS zone FROM workloads w WHERE w.id = '${id}'`,
            );
            return row?.zone || row?.state === 'failed' ? row : undefined;
          },
        ).catch(() => undefined);
        const seconds = Math.round((Date.now() - submitted) / 1000);
        await cli(['terminate', id]).catch(() => undefined);
        return {
          id,
          arm,
          region,
          zone: outcome?.zone ?? null,
          outcome: outcome?.zone
            ? `launched within ${seconds} s`
            : (outcome?.state ?? 'no VM within 10 min'),
        };
      }),
    ),
  );
  await verifyClean(inventory);
  // EC2's refusals the API logged, by Job: `<zone> <code>` for each zone it
  // moved on from, the last zone's capacity refusal, and rate limiting.
  const log = readFileSync(join(state, 'api.log'), 'utf8')
    .split('\n')
    // The API also prints its migrations, which aren't JSON.
    .filter((line) => line.startsWith('{'))
    .map(
      (line) =>
        JSON.parse(line) as {
          message: string;
          id?: string;
          vmId?: string;
          zone?: string;
          code?: string;
          error?: { message?: string };
        },
    );
  const results = launches.map((launch) => ({
    ...launch,
    refusals: log
      .filter((e) => e.id === launch.id || e.vmId?.startsWith(`${launch.id}-`))
      .flatMap((e) => {
        if (e.zone && e.code) return [`${e.zone} ${e.code}`];
        const error = e.error?.message ?? '';
        const zone = LAST_ZONE_REFUSAL.exec(error)?.[1];
        if (zone) return [`${zone} InsufficientInstanceCapacity`];
        return error.includes('throttled') ? ['RunInstances throttled'] : [];
      }),
  }));
  evidence('spot-launches.json', results);
  console.log(JSON.stringify(results, null, 2));
}

async function cleanup() {
  if (!existsSync(inventoryPath)) {
    evidence('cleanup.json', { note: 'no inventory: run created nothing' });
    return;
  }
  await startApi();
  await verifyClean(
    JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory,
  );
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

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

function report(results: JobResult[]): string {
  const ok = results.filter((r) => r.ok);
  const of = (arm: Arm) => ok.filter((r) => r.arm === arm);
  const fmt = (x: number) => x.toFixed(1);
  const lines: string[] = [];
  const metrics = [
    ...new Set(ok.flatMap((r) => Object.keys(r.timings))),
  ].sort();
  for (const [a, i] of PAIRS) {
    const [ra, ri] = [of(a), of(i)];
    const price = (rs: JobResult[]) => rs[0]?.pricePerHour ?? 0;
    lines.push(
      `### ${a} vs ${i} (n = ${ra.length} and ${ri.length})`,
      '',
      `Seconds; ratio is m8a's median over m8i's, below 1 is m8a faster. Cost is the median at on-demand list price ($${price(ra)}/h and $${price(ri)}/h).`,
      '',
      `| Build command | ${a} median (range) | ${i} median (range) | Ratio | Mann-Whitney p | ${a} cost | ${i} cost |`,
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const metric of metrics) {
      const xa = ra.flatMap((r) => r.timings[metric] ?? []);
      const xi = ri.flatMap((r) => r.timings[metric] ?? []);
      if (!xa.length || !xi.length) continue;
      const cell = (xs: number[]) =>
        `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})`;
      const cost = (xs: number[], rs: JobResult[]) =>
        `$${((median(xs) / 3600) * price(rs)).toFixed(4)}`;
      lines.push(
        `| ${metric} | ${cell(xa)} | ${cell(xi)} | ${(median(xa) / median(xi)).toFixed(2)} | ${mannWhitney(xa, xi).toPrecision(2)} | ${cost(xa, ra)} | ${cost(xi, ri)} |`,
      );
    }
    for (const kind of ['single', 'all'] as const) {
      const xa = ra.flatMap((r) => r.sysbench[kind] ?? []);
      const xi = ri.flatMap((r) => r.sysbench[kind] ?? []);
      if (!xa.length || !xi.length) continue;
      lines.push(
        `| sysbench cpu, ${kind === 'single' ? '1 thread' : 'all threads'} (events/s, higher is faster) | ${fmt(median(xa))} | ${fmt(median(xi))} | ${(median(xa) / median(xi)).toFixed(2)} | ${mannWhitney(xa, xi).toPrecision(2)} | | |`,
      );
    }
    lines.push('');
  }
  lines.push('### CPUs', '');
  for (const arm of ARMS) {
    const cpu = of(arm)[0]?.lscpu ?? {};
    lines.push(
      `- ${arm}: ${cpu['Model name'] ?? '?'}; ${cpu['CPU(s)'] ?? '?'} vCPUs, ${cpu['Thread(s) per core'] ?? '?'} threads per core; zones ${[...new Set(of(arm).map((r) => r.zone))].join(', ')}`,
    );
  }
  const spent = results.reduce((sum, r) => sum + costOf(r), 0);
  lines.push(
    '',
    `${results.length} Jobs, ${results.length - ok.length} failed; VMs' list-price cost $${spent.toFixed(2)}.`,
  );
  return `${lines.join('\n')}\n`;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'run') {
  await run(
    Number(flag('rounds', '10')),
    Number(flag('parallel', '3')),
    flag('region', 'us-east-2'),
  );
} else if (command === 'spot') {
  await spot();
} else if (command === 'cleanup') {
  await cleanup();
} else if (command === 'report') {
  const results = rest.flatMap(
    (path) =>
      (JSON.parse(readFileSync(path, 'utf8')) as { results: JobResult[] })
        .results,
  );
  console.log(report(results));
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
