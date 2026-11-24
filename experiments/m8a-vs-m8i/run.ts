#!/usr/bin/env tsx
/**
 * Newer CPU generations against the ones backmesh's runners land on today,
 * at equal vCPUs: backmesh's five benchmark builds in anycloud VM Jobs on AWS
 * (m8a against m8i), GCP and Azure; see README.md.
 *
 * `run [--cloud=aws] [--vcpus=4,16] [--rounds=10] [--parallel=3]
 * [--region=<the cloud's>]` starts the branch's API and runs rounds of one Job
 * per arm, `--parallel` rounds at a time. `spot [--cloud=aws]` reports the
 * arms' spot capacity in three US regions. `cleanup` restarts the API from
 * the run's state directory, terminates the inventory's Jobs and checks the
 * cloud for anything left. `report <results.json...>` rewrites the report
 * from saved results, without a cloud.
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
import { DefaultAzureCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DisksClient, InstancesClient } from '@google-cloud/compute';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'm8a-vs-m8i');
const inventoryPath = join(state, 'inventory.json');
const PORT = 18_432;
const API_URL = `http://127.0.0.1:${PORT}`;
const JOB_TIMEOUT_MS = 20 * 60_000;
// No round starts after this, so the last ones end, and the run cleans up,
// inside the Spike workflow's 85-minute step.
const ROUNDS_WINDOW_MS = 45 * 60_000;
// Stops starting rounds once the VMs' and disks' list-price cost reaches this.
const COST_CAP_USD = 8;
const SPOT_LAUNCH_WAIT_MS = 10 * 60_000;
// The last zone's refusal, which ends the launch attempt.
const LAST_ZONE_REFUSAL = /Availability Zone you requested \(([a-z0-9-]+)\)/;
// Capacity, quota and rate refusals in the API's log, on any cloud.
const REFUSAL =
  /\b(InsufficientInstanceCapacity|Unsupported|ZONE_RESOURCE_POOL_EXHAUSTED\w*|QUOTA_EXCEEDED|STOCKOUT|does not have enough resources|SkuNotAvailable|ZonalAllocationFailed|AllocationFailed|OverconstrainedAllocationRequest|OperationNotAllowed|throttled|[Pp]reempt\w*)\b/;

type Cloud = 'aws' | 'gcp' | 'azure';
type Arm = string;

// The root disk's list price per hour on top of the VM's: 100 GB at
// anycloud's default `high` tier, as backmesh's GCP and Azure runners have it.
// AWS: gp3 at the tier's 8,000 IOPS and 1,000 MiB/s, which these Jobs get;
// backmesh's runners pass 4,000 and 500 ($0.08/GB, $0.005/IOPS over 3,000
// and $0.04/MiB/s over 125, a month). GCP (Iowa, cloud.google.com/compute/
// disks-image-pricing, 2026-11): pd-ssd at $0.000232877/GiB-h; Hyperdisk
// Balanced, which c4d and n4d need, at $0.000109589/GiB-h with 8,000 IOPS
// and 1,000 MB/s provisioned ($0.000006849/IOPS-h over 3,000 and
// $0.000054795/MBps-h over 140). Azure: Premium SSD P10 (128 GiB) at
// $19.71 a month.
const MONTH_HOURS = 730;
const GP3_HIGH = (8 + 5_000 * 0.005 + 875 * 0.04) / MONTH_HOURS;
const PD_SSD = 100 * 0.000232877;
const HYPERDISK_HIGH =
  100 * 0.000109589 + 5_000 * 0.000006849 + 860 * 0.000054795;
const PREMIUM_P10 = 19.71 / MONTH_HOURS;

interface CloudSpec {
  region: string;
  spotRegions: string[];
  /** Each size's arms, today's first: every other arm is compared with it. */
  arms: (vcpus: number) => Arm[];
  diskPerHour: (arm: Arm) => number;
  env: () => object;
}

const CLOUDS: Record<Cloud, CloudSpec> = {
  aws: {
    region: 'us-east-2',
    spotRegions: ['us-east-1', 'us-east-2', 'us-west-2'],
    arms: (n) =>
      ['m8i', 'm8a'].map((f) => `${f}.${n === 4 ? '' : n / 4}xlarge`),
    diskPerHour: () => GP3_HIGH,
    env: () => ({
      AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
    }),
  },
  // backmesh: n2, then n2d. c4d and n4d are Zen 5, c3d Zen 4.
  gcp: {
    // us-central1 refused on-demand n4d-standard-4 in every zone in run
    // 45260033603.
    region: 'us-central1,us-east1',
    spotRegions: ['us-central1', 'us-east4', 'us-east1'],
    arms: (n) =>
      ['n2', 'n2d', 'c3d', 'c4d', 'n4d'].map((f) => `${f}-standard-${n}`),
    diskPerHour: (arm) => (/^(c4d|n4d)-/.test(arm) ? HYPERDISK_HIGH : PD_SSD),
    env: () => ({
      GCP_PROJECT_ID: required('GCP_PROJECT_ID'),
      GCP_CLIENT_EMAIL: required('GCP_CLIENT_EMAIL'),
      GCP_PRIVATE_KEY: required('GCP_PRIVATE_KEY'),
    }),
  },
  // backmesh: Dadsv5 first. v6 is Zen 4, v7 Zen 5.
  azure: {
    region: 'eastus2',
    spotRegions: ['eastus2', 'eastus', 'centralus'],
    arms: (n) =>
      ['ads_v5', 'ads_v6', 'as_v6', 'ads_v7', 'as_v7'].map(
        (f) => `Standard_D${n}${f}`,
      ),
    diskPerHour: () => PREMIUM_P10,
    env: () => ({
      AZURE_APPLICATION_ID: required('AZURE_CLIENT_ID'),
      AZURE_SECRET: required('AZURE_CLIENT_SECRET'),
      AZURE_SUBSCRIPTION_ID: required('AZURE_SUBSCRIPTION_ID'),
      AZURE_DIRECTORY_ID: required('AZURE_TENANT_ID'),
    }),
  },
};

const cloudOf = (arm: Arm): Cloud =>
  arm.startsWith('Standard_') ? 'azure' : arm.includes('-') ? 'gcp' : 'aws';
const vcpusOf = (arm: Arm) =>
  cloudOf(arm) === 'aws'
    ? 4 * (Number(/^m8\w\.(\d*)xlarge$/.exec(arm)?.[1]) || 1)
    : Number(/(\d+)/.exec(arm.replace(/^\w+?-standard-|^Standard_D/, ''))?.[1]);
/** Each arm with its size's first (today's), on any cloud and size. */
const pairsOf = (arms: Arm[]): [Arm, Arm][] =>
  arms.flatMap((arm) => {
    const today = CLOUDS[cloudOf(arm)].arms(vcpusOf(arm))[0]!;
    return arm !== today && arms.includes(today) ? [[arm, today]] : [];
  });
/** A Job ID's arm part: m8a-xlarge, c4d-4, d4ads-v6. */
const shortArm = (arm: Arm) =>
  arm
    .replace('Standard_', '')
    .replace('-standard-', '-')
    .replace(/[._]/g, '-')
    .toLowerCase();

interface Inventory {
  runId: string;
  cloud: Cloud;
  regions: string[];
  jobs: string[];
}

interface JobResult {
  id: string;
  arm: Arm;
  round: number;
  ok: boolean;
  region?: string | null;
  zone: string | null;
  /** The Job's VMs, failed launches included; vmSeconds sums them. */
  attempts?: number;
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

const apiHealthy = () =>
  fetch(`${API_URL}/health`)
    .then((response) => response.ok)
    .catch(() => false);

async function startApi(): Promise<void> {
  // The run's API outlives a run step that timed out; cleanup reuses it and
  // its token.
  if (await apiHealthy()) return;
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
    if (await apiHealthy()) return;
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
  const id = `${inventory.cloud === 'aws' ? 'm8' : 'cg'}-${inventory.runId}-r${round}-${shortArm(arm)}`;
  inventory.jobs.push(id);
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const guest = readFileSync(join(import.meta.dirname, 'guest.sh'));
  await cli([
    'job',
    'docker:27-cli',
    '--id',
    id,
    '--credentials',
    `${inventory.cloud}-spike`,
    '--regions',
    inventory.regions.join(','),
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
  // Every VM the Job had, failed attempts too, newest first.
  const vms = await until(`${id}'s VMs to end`, 10 * 60_000, async () => {
    const rows = await query<{
      region: string | null;
      availability_zone: string | null;
      price_per_hour: number | null;
      created_at: number;
      ended_at: number | null;
    }>(
      `SELECT region, availability_zone, price_per_hour, created_at, ended_at FROM vms WHERE workload_id = '${id}' ORDER BY created_at DESC`,
    );
    return rows.every((row) => row.ended_at) ? rows : undefined;
  });
  const [vm] = vms;
  return {
    id,
    arm,
    round,
    ok: parsed.done,
    region: vm?.region ?? null,
    zone: vm?.availability_zone ?? null,
    attempts: vms.length,
    vmSeconds: vm
      ? vms.reduce((sum, v) => sum + (v.ended_at! - v.created_at), 0) / 1000
      : null,
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

const diskPerHour = (arm: Arm) => CLOUDS[cloudOf(arm)].diskPerHour(arm);
/** A Job's whole VM time at the VM's and its disk's list prices. */
const costOf = (r: JobResult) =>
  ((r.vmSeconds ?? 0) / 3600) * ((r.pricePerHour ?? 0) + diskPerHour(r.arm));

/** Records an empty inventory, then starts the API with CI's credentials. */
async function setUp(cloud: Cloud, regions: string[]): Promise<Inventory> {
  mkdirSync(state, { recursive: true });
  mkdirSync(output, { recursive: true });
  const inventory: Inventory = {
    runId: randomBytes(3).toString('hex'),
    cloud,
    regions,
    jobs: [],
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await startApi();
  await cli(
    ['credentials', 'new', `${cloud}-spike`, '--provider', cloud],
    CLOUDS[cloud].env(),
  );
  return inventory;
}

async function run(
  cloud: Cloud,
  arms: Arm[],
  rounds: number,
  parallel: number,
  region: string,
) {
  const inventory = await setUp(cloud, region.split(','));
  const results: JobResult[] = [];
  const save = () => {
    evidence('results.json', { region, results });
    evidence('report.md', report(results));
  };
  // Each round starts one Job per arm at once, in a random order, so drift
  // over the run and a slow minute hit every arm alike.
  let next = 1;
  const lastStart = Date.now() + ROUNDS_WINDOW_MS;
  const worker = async () => {
    while (next <= rounds && Date.now() < lastStart) {
      const spent = results.reduce((sum, r) => sum + costOf(r), 0);
      if (spent >= COST_CAP_USD) {
        console.warn(`Cost cap: $${spent.toFixed(2)} spent; no more rounds`);
        return;
      }
      const round = next++;
      const settled = await Promise.allSettled(
        shuffle(arms).map((arm) => runJob(inventory, arm, round)),
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
  if (failed.length || results.length < rounds * arms.length) {
    throw new Error(
      `${failed.length} Jobs failed; ${results.length} of ${rounds * arms.length} reported`,
    );
  }
}

/** Terminates the Jobs, waits for the API's cleanup, then asks the cloud. */
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
  const left = inventory.jobs.length ? await leftovers(inventory) : [];
  evidence('cleanup.json', { jobs: inventory.jobs.length, left });
  if (left.length) {
    throw new Error(`Cloud resources remain: ${JSON.stringify(left)}`);
  }
}

/**
 * The cloud's resources tagged (labelled, on GCP) `anycloud_deployment` with
 * one of the run's Job IDs: instances and volumes on AWS, instances and disks
 * in every GCP zone, and every Azure resource.
 */
async function leftovers({ cloud, regions, jobs }: Inventory) {
  const ours = (id: string | null | undefined) => !!id && jobs.includes(id);
  const left: string[] = [];
  if (cloud === 'gcp') {
    left.push(...(await gcpLeftovers(ours)).map((r) => `${r.kind} ${r.name}`));
  } else if (cloud === 'azure') {
    const resources = new ResourceManagementClient(
      new DefaultAzureCredential(),
      required('AZURE_SUBSCRIPTION_ID'),
    ).resources.list({ filter: "tagName eq 'anycloud_deployment'" });
    for await (const r of resources)
      if (ours(r.tags?.anycloud_deployment)) left.push(r.id!);
  } else {
    const filter = { Name: 'tag:anycloud_deployment', Values: jobs };
    for (const region of regions) {
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
      left.push(
        ...(Reservations ?? []).flatMap((r) =>
          (r.Instances ?? []).map((i) => i.InstanceId!),
        ),
        ...(Volumes ?? []).map((v) => v.VolumeId!),
      );
    }
  }
  return left;
}

const gcpOptions = () => ({
  projectId: required('GCP_PROJECT_ID'),
  credentials: {
    client_email: required('GCP_CLIENT_EMAIL'),
    private_key: required('GCP_PRIVATE_KEY').replace(/\\n/g, '\n'),
  },
});

/** GCP instances and disks whose `anycloud_deployment` label `ours` takes. */
async function gcpLeftovers(ours: (id: string | undefined) => boolean) {
  const project = required('GCP_PROJECT_ID');
  const filter = 'labels.anycloud_deployment:*';
  const found: { kind: 'instance' | 'disk'; name: string; zone: string }[] = [];
  for await (const [zone, { instances }] of new InstancesClient(
    gcpOptions(),
  ).aggregatedListAsync({ project, filter })) {
    for (const i of instances ?? [])
      if (ours(i.labels?.anycloud_deployment))
        found.push({ kind: 'instance', name: i.name!, zone });
  }
  for await (const [zone, { disks }] of new DisksClient(
    gcpOptions(),
  ).aggregatedListAsync({ project, filter })) {
    for (const d of disks ?? [])
      if (ours(d.labels?.anycloud_deployment))
        found.push({ kind: 'disk', name: d.name!, zone });
  }
  return found.map((r) => ({ ...r, zone: r.zone.replace(/^zones\//, '') }));
}

/**
 * Deletes the GCP instances and disks of the Jobs whose IDs start with
 * `prefix`, for a run whose API and inventory were lost with its runner.
 */
async function sweep(prefix: string) {
  if (!/^(cg|m8)s?-[0-9a-f]{6}-/.test(prefix)) {
    throw new Error(`${prefix} is not a run's Job ID prefix`);
  }
  const ours = (id: string | undefined) => !!id?.startsWith(prefix);
  const project = required('GCP_PROJECT_ID');
  const found = await gcpLeftovers(ours);
  console.log(JSON.stringify(found, null, 2));
  const instances = new InstancesClient(gcpOptions());
  const disks = new DisksClient(gcpOptions());
  // Deletes what's left until nothing is: instances first, since an
  // instance's boot disk goes with it. A delete already under way fails, so
  // errors only wait for the next pass.
  await until('the sweep', 10 * 60_000, async () => {
    const now = await gcpLeftovers(ours);
    if (!now.length) return true;
    const kind = now.some((r) => r.kind === 'instance') ? 'instance' : 'disk';
    await Promise.allSettled(
      now
        .filter((r) => r.kind === kind)
        .map(({ name, zone }) =>
          kind === 'instance'
            ? instances.delete({ project, zone, instance: name })
            : disks.delete({ project, zone, disk: name }),
        ),
    );
    return undefined;
  }).catch((error: unknown) => console.warn(String(error)));
  const left = await gcpLeftovers(ours);
  evidence('sweep.json', { prefix, deleted: found, left });
  if (left.length)
    throw new Error(`GCP resources remain: ${JSON.stringify(left)}`);
}

/**
 * Spot capacity for each arm in the cloud's three spot regions: the cloud's
 * placement scores for one instance (EC2's 1–10 and Azure's High, Medium or
 * Low; GCP has none), by region and by zone, then, on AWS and GCP, one real
 * spot VM Job per arm and region through anycloud, which reports whether a VM
 * launched, where, and the capacity refusals the API logged on the way.
 */
async function spot(
  cloud: Cloud,
  arms: Arm[],
  regions: string[],
  { hold, count }: { hold: number; count: number },
) {
  if (cloud !== 'gcp') {
    const scores =
      cloud === 'aws'
        ? await ec2Scores(arms, regions)
        : await azureScores(arms, regions);
    evidence('spot-scores.json', scores);
    console.log(JSON.stringify(scores, null, 2));
  }
  // Azure gives CI's subscription 3 spot vCPUs a region: scores only.
  if (cloud === 'azure') return;
  const inventory = await setUp(cloud, regions);
  const copies = Array.from({ length: count }, (_, k) => k);
  const launches = await Promise.all(
    regions.flatMap((region) =>
      arms
        .flatMap((arm) => copies.map((k) => ({ arm, k })))
        .map(async ({ arm, k }, index) => {
          // Such as cgs-1a2b3c-usc1-c4d-4; IDs are at most 28 characters.
          const id = `${cloud === 'aws' ? 'm8' : 'cg'}s-${inventory.runId}-${region.replace(/^us-(\w)\w+?-?(\d)$/, 'us$1$2')}-${shortArm(arm)}${count > 1 ? `-${k}` : ''}`;
          inventory.jobs.push(id);
          writeFileSync(inventoryPath, JSON.stringify(inventory));
          // Spaced out: twelve launches at once hit the account's
          // RunInstances rate limit in run 45247427638.
          await sleep(
            (regions.indexOf(region) * arms.length * count + index) * 10_000,
          );
          const submitted = Date.now();
          await cli([
            'job',
            'alpine:3.20',
            '--id',
            id,
            '--credentials',
            `${cloud}-spike`,
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
            String(hold),
          ]);
          // The Job leaves provisioning once the cloud has accepted a VM: GCP
          // sets the VM's zone before it has.
          const outcome = await until(
            `${id}'s VM`,
            SPOT_LAUNCH_WAIT_MS,
            async () => {
              const [row] = await query<{ state: string; zone: string | null }>(
                `SELECT w.state, (SELECT v.availability_zone FROM vms v WHERE v.workload_id = w.id AND v.availability_zone IS NOT NULL LIMIT 1) AS zone FROM workloads w WHERE w.id = '${id}'`,
              );
              return row && !['queued', 'provisioning'].includes(row.state)
                ? row
                : undefined;
            },
          ).catch(() => undefined);
          const seconds = Math.round((Date.now() - submitted) / 1000);
          const launched = outcome?.zone && outcome.state !== 'failed';
          // `--hold`: the Job sleeps that long, and a spot reclaim ends it
          // early in another state than succeeded (`--max-retries 0`).
          const held =
            launched && hold > 60
              ? await until(`${id} to end`, (hold + 900) * 1000, async () => {
                  const [row] = await query<{
                    state: string;
                    vms: number;
                    price: number | null;
                  }>(
                    `SELECT w.state, (SELECT COUNT(*) FROM vms v WHERE v.workload_id = w.id) AS vms, (SELECT MAX(v.price_per_hour) FROM vms v WHERE v.workload_id = w.id) AS price FROM workloads w WHERE w.id = '${id}'`,
                  );
                  return row &&
                    ![
                      'queued',
                      'provisioning',
                      'initializing',
                      'running',
                    ].includes(row.state)
                    ? {
                        ...row,
                        seconds: Math.round((Date.now() - submitted) / 1000),
                      }
                    : undefined;
                }).catch(() => undefined)
              : undefined;
          await cli(['terminate', id]).catch(() => undefined);
          return {
            id,
            arm,
            region,
            zone: outcome?.zone ?? null,
            outcome: launched
              ? `launched within ${seconds} s`
              : (outcome?.state ?? 'no VM within 10 min'),
            ...(held && { ended: held }),
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
        // GCP and anything else: the refusal and the zone it names.
        const refusal = REFUSAL.exec(JSON.stringify(e))?.[1];
        if (!refusal) return [];
        const at = e.zone ?? /zones\/([a-z0-9-]+)/.exec(JSON.stringify(e))?.[1];
        return [`${at ?? '?'} ${refusal}`];
      }),
  }));
  evidence('spot-launches.json', results);
  console.log(JSON.stringify(results, null, 2));
}

async function ec2Scores(arms: Arm[], regions: string[]) {
  const ec2 = new EC2Client({ region: 'us-east-1' });
  const scores: Record<string, unknown> = {};
  for (const arm of arms) {
    for (const single of [false, true]) {
      const { SpotPlacementScores } = await ec2.send(
        new GetSpotPlacementScoresCommand({
          InstanceTypes: [arm],
          TargetCapacity: 1,
          SingleAvailabilityZone: single,
          RegionNames: regions,
        }),
      );
      scores[`${arm} ${single ? 'zones' : 'regions'}`] = (
        SpotPlacementScores ?? []
      ).map((s) => `${s.AvailabilityZoneId ?? s.Region} ${s.Score}`);
    }
  }
  return scores;
}

/**
 * Azure's Spot Placement Score for one VM of each arm, by region and, per
 * region, by zone. A refusal (such as a missing permission) is recorded as
 * the score.
 */
async function azureScores(arms: Arm[], regions: string[]) {
  const { token } = await new DefaultAzureCredential().getToken(
    'https://management.azure.com/.default',
  );
  const generate = async (desiredLocations: string[], zones: boolean) => {
    const response = await fetch(
      `https://management.azure.com/subscriptions/${required('AZURE_SUBSCRIPTION_ID')}/providers/Microsoft.Compute/locations/${desiredLocations[0]}/placementScores/spot/generate?api-version=2025-06-05`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          desiredLocations,
          desiredSizes: arms.map((sku) => ({ sku })),
          desiredCount: 1,
          availabilityZones: zones,
        }),
      },
    );
    const body = (await response.json()) as {
      placementScores?: {
        sku: string;
        region: string;
        availabilityZone?: string;
        score: string;
        isQuotaAvailable?: boolean;
      }[];
    };
    if (!response.ok || !body.placementScores) {
      return [`${response.status} ${JSON.stringify(body).slice(0, 600)}`];
    }
    return body.placementScores.map(
      (s) =>
        `${s.sku} ${s.region}${s.availabilityZone ? `-${s.availabilityZone}` : ''} ${s.score}${s.isQuotaAvailable === false ? ' (no quota)' : ''}`,
    );
  };
  return {
    regions: await generate(regions, false),
    ...Object.fromEntries(
      await Promise.all(
        regions.map(async (r) => [`${r} zones`, await generate([r], true)]),
      ),
    ),
  };
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
  const arms = [...new Set(results.map((r) => r.arm))];
  for (const [a, i] of pairsOf(arms)) {
    const [ra, ri] = [of(a), of(i)];
    const price = (rs: JobResult[]) => rs[0]?.pricePerHour ?? 0;
    lines.push(
      `### ${a} vs ${i} (n = ${ra.length} and ${ri.length})`,
      '',
      `Seconds; ratio is ${a}'s median over ${i}'s, below 1 is ${a} faster. Cost is the median at on-demand list price ($${price(ra)}/h and $${price(ri)}/h). A Job's cost is its whole VM time at the VM's and the disk's prices ($${diskPerHour(a).toFixed(4)}/h and $${diskPerHour(i).toFixed(4)}/h).`,
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
    for (const [what, value] of [
      ['VM time per Job (s)', (r: JobResult) => r.vmSeconds ?? []],
      ['Cost per Job ($, VM and disk)', (r: JobResult) => costOf(r)],
    ] as const) {
      const [xa, xi] = [ra.flatMap(value), ri.flatMap(value)];
      if (!xa.length || !xi.length) continue;
      const m = (xs: number[]) =>
        what.startsWith('Cost') ? median(xs).toFixed(4) : fmt(median(xs));
      lines.push(
        `| ${what} | ${m(xa)} | ${m(xi)} | ${(median(xa) / median(xi)).toFixed(2)} | ${mannWhitney(xa, xi).toPrecision(2)} | | |`,
      );
    }
    lines.push('');
  }
  lines.push('### CPUs', '');
  for (const arm of arms) {
    const cpu = of(arm)[0]?.lscpu ?? {};
    const failed = results.filter((r) => r.arm === arm && !r.ok).length;
    lines.push(
      `- ${arm}: ${cpu['Model name'] ?? '?'}; ${cpu['CPU(s)'] ?? '?'} vCPUs, ${cpu['Thread(s) per core'] ?? '?'} threads per core; zones ${[...new Set(of(arm).map((r) => r.zone))].join(', ')}${failed ? `; ${failed} failed` : ''}`,
    );
  }
  const spent = results.reduce((sum, r) => sum + costOf(r), 0);
  lines.push(
    '',
    `${results.length} Jobs, ${results.length - ok.length} failed; VMs' and disks' list-price cost $${spent.toFixed(2)}.`,
  );
  return `${lines.join('\n')}\n`;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const cloud = flag('cloud', 'aws') as Cloud;
if (!(cloud in CLOUDS)) throw new Error(`Unknown cloud ${cloud}`);
// `--arms=<type,...>` runs just those of the sizes' arms.
const only = flag('arms', '').split(',').filter(Boolean);
const arms = flag('vcpus', cloud === 'aws' ? '4,16' : '4')
  .split(',')
  .flatMap((n) => CLOUDS[cloud].arms(Number(n)))
  .filter((arm) => !only.length || only.includes(arm));
if (command === 'run') {
  await run(
    cloud,
    arms,
    Number(flag('rounds', '10')),
    Number(flag('parallel', '3')),
    flag('region', CLOUDS[cloud].region),
  );
} else if (command === 'spot') {
  await spot(
    cloud,
    arms,
    flag('regions', CLOUDS[cloud].spotRegions.join(',')).split(','),
    { hold: Number(flag('hold', '60')), count: Number(flag('count', '1')) },
  );
} else if (command === 'sweep') {
  await sweep(flag('prefix', ''));
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
