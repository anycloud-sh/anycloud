#!/usr/bin/env tsx
/**
 * Local NVMe against the network disk for CI builds, at 4 vCPUs on AWS, GCP
 * and Azure: three of backmesh's benchmark builds and two disk-heavy steps
 * in anycloud VM Jobs; see README.md.
 *
 * `run [--cloud=aws,gcp,azure] [--rounds=10] [--parallel=3]
 * [--arms=<arm,...>] [--on-demand]` starts each cloud's API from the branch, and one built
 * from `variant-nvme.patch`, then runs each cloud's rounds at once: one Job
 * per arm a round, `--parallel` rounds at a time. `cleanup [--cloud=...]`
 * restarts the APIs from the run's state directory, terminates the
 * inventories' Jobs and checks the clouds for anything left.
 * `report <results.json...>` rewrites the report
 * from saved results without a cloud.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
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
} from '@aws-sdk/client-ec2';
import { DefaultAzureCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DisksClient, InstancesClient } from '@google-cloud/compute';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const base = join(process.env.RUNNER_TEMP ?? tmpdir(), 'local-nvme');
const inventoryPath = (cloud: Cloud) => join(base, cloud, 'inventory.json');
const PORT = 18_442;
const JOB_TIMEOUT_MS = 45 * 60_000;
// No round starts after this, so the last ones end, and the run cleans up,
// inside the Spike workflow's 85-minute step.
const ROUNDS_WINDOW_MS = 50 * 60_000;
// Stops starting rounds once the VMs' and disks' list-price cost reaches this,
// so the three clouds stay under the owner's $10.
const COST_CAP_USD = 3;

type Cloud = 'aws' | 'gcp' | 'azure';
/**
 * A VM type, run by the branch's API, or `<type>@nvme`, run by an API built
 * from this checkout with `variant-nvme.patch` applied: its image stores and
 * /workspace on the type's local disk. `<type>#high`, on GCP, is the type
 * on the branch's API with `high`'s Hyperdisk, an on-demand runner's.
 */
type Arm = string;
const vmOf = (arm: Arm) => arm.split(/[@#]/)[0]!;
const variantOf = (arm: Arm) => arm.split('@')[1] ?? 'head';
const VARIANT = 'nvme';

/** A build of the API and CLI, with its own state, database and port. */
interface Api {
  cloud: Cloud;
  variant: string;
  root: string;
  state: string;
  port: number;
}
/** Each cloud's API of a variant; the variant's build is shared. */
const apiOf = (cloud: Cloud, variant: string): Api => ({
  cloud,
  variant,
  root: variant === 'head' ? root : join(base, `src-${variant}`),
  state: join(base, cloud, variant),
  port:
    PORT +
    2 * Object.keys(CLOUDS).indexOf(cloud) +
    (variant === 'head' ? 0 : 1),
});

// Disks' list prices per hour, a month being 730 hours. AWS gp3 (us-east-2):
// $0.08/GB, $0.005/IOPS over 3,000 and $0.04/MiB/s over 125, a month. GCP
// Hyperdisk Balanced (cloud.google.com/compute/disks-image-pricing, Iowa,
// 2026-11): $0.000109589/GiB-h, $0.000006849/IOPS-h over 3,000 and
// $0.000054795/MBps-h over 140. Azure Premium SSD P10 (128 GiB): $19.71 a month.
const MONTH_HOURS = 730;
const gp3 = (gb: number, iops: number, mibps: number) =>
  (gb * 0.08 + (iops - 3_000) * 0.005 + (mibps - 125) * 0.04) / MONTH_HOURS;
const hyperdisk = (gb: number, iops: number, mbps: number) =>
  gb * 0.000109589 + (iops - 3_000) * 0.000006849 + (mbps - 140) * 0.000054795;

/** A Job's OS disk: its CLI flags and its list price per hour. */
interface Disk {
  args: string[];
  perHour: number;
}
// backmesh's runner disks (`src/listener/runner-jobs.ts`): 100 GB gp3 at
// 4,000 IOPS and 500 MiB/s on AWS; on GCP a spot c4d's Hyperdisk Balanced at
// 3,000 IOPS and 750 MiB/s (`#high` is an on-demand one's); Azure's `high`
// tier, Premium SSD.
const RUNNER_DISK: Record<Cloud, Disk> = {
  aws: {
    args: [
      '--disk-size',
      '100',
      '--disk-iops',
      '4000',
      '--disk-throughput',
      '500',
    ],
    perHour: gp3(100, 4_000, 500),
  },
  gcp: {
    args: [
      '--disk-size',
      '100',
      '--disk-iops',
      '3000',
      '--disk-throughput',
      '750',
    ],
    perHour: hyperdisk(100, 3_000, 750),
  },
  azure: { args: ['--disk-size', '100'], perHour: 19.71 / MONTH_HOURS },
};
// With the stores and /workspace on the local disk, the OS disk holds only
// the OS: the Job host's default 30 GB at the cloud's baseline, the
// `medium` tier. Azure's resource disk must be at least the OS disk's size
// to take them, which 100 GB is, so its disk stays the runners'.
const OS_ONLY_DISK: Record<Cloud, Disk> = {
  aws: {
    args: ['--disk-size', '30', '--disk-tier', 'medium'],
    perHour: gp3(30, 3_000, 125),
  },
  gcp: {
    args: ['--disk-size', '30', '--disk-tier', 'medium'],
    perHour: hyperdisk(30, 3_000, 140),
  },
  azure: RUNNER_DISK.azure,
};
// An on-demand c4d runner's: GCP's `high` tier, 8,000 IOPS and 1,000 MiB/s.
const HIGH_DISK: Disk = {
  args: ['--disk-size', '100', '--disk-tier', 'high'],
  perHour: hyperdisk(100, 8_000, 1_000),
};
const diskOf = (cloud: Cloud, arm: Arm) =>
  arm.endsWith('#high')
    ? HIGH_DISK
    : variantOf(arm) === VARIANT
      ? OS_ONLY_DISK[cloud]
      : RUNNER_DISK[cloud];

interface CloudSpec {
  region: string;
  spot: boolean;
  /** The baseline first; every other arm is compared with it. */
  arms: Arm[];
  env: () => object;
}

// On AWS and GCP the 4-vCPU type with a local NVMe disk nearest the runners',
// on the runners' disk and with the variant: the pair isolates the disk from
// the CPU. Today's runner types (m8a, c4d) aren't run; the first run had
// them. On Azure the runners' Dadsv5 already has its image stores on the
// resource disk; the variant adds /workspace.
const CLOUDS: Record<Cloud, CloudSpec> = {
  aws: {
    // m8id is m8i's Xeon 6 with a 237 GB instance store; there's no m8ad.
    region: 'us-east-2',
    spot: true,
    arms: ['m8id.xlarge', `m8id.xlarge@${VARIANT}`],
    env: () => ({
      AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
    }),
  },
  gcp: {
    // c4d's smallest -lssd type has 8 vCPUs; c4 (Xeon) has one at 4, with a
    // 375 GiB local SSD. us-east4 is backmesh's GCP anchor region.
    region: 'us-east4',
    spot: true,
    arms: ['c4-standard-4-lssd', `c4-standard-4-lssd@${VARIANT}`],
    env: () => ({
      GCP_PROJECT_ID: required('GCP_PROJECT_ID'),
      GCP_CLIENT_EMAIL: required('GCP_CLIENT_EMAIL'),
      GCP_PRIVATE_KEY: required('GCP_PRIVATE_KEY'),
    }),
  },
  azure: {
    // Our subscription (the Spike workflow's `azure_subscription=own`) has
    // no DADSv5 quota in eastus.
    region: 'centralus',
    spot: false,
    arms: ['Standard_D4ads_v5', `Standard_D4ads_v5@${VARIANT}`],
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
/**
 * Each arm against its cloud's baseline, and a `#high` arm against its type
 * on the runners' disk (`--arms=c4d-standard-4,c4d-standard-4#high`).
 */
const pairsOf = (arms: Arm[]): [Arm, Arm][] =>
  arms.flatMap((arm): [Arm, Arm][] => {
    if (arm.includes('#'))
      return arms.includes(vmOf(arm)) ? [[vmOf(arm), arm]] : [];
    const baseline = CLOUDS[cloudOf(arm)].arms[0]!;
    return arm !== baseline && arms.includes(baseline) ? [[arm, baseline]] : [];
  });
/** A Job ID's arm part, for IDs of at most 28 characters: m8id-xl-nvme, c4-4-lssd, c4d-4-high, d4ads-v5. */
const shortArm = (arm: Arm) =>
  arm
    .replace('Standard_', '')
    .replace('xlarge', 'xl')
    .replace('-standard-', '-')
    .replace(/[._@#]/g, '-')
    .toLowerCase();

interface Inventory {
  runId: string;
  cloud: Cloud;
  regions: string[];
  /** The run's APIs, by variant; `head` first. */
  variants: string[];
  /** Each Job's ID and its API's variant. */
  jobs: { id: string; variant: string }[];
}

interface JobResult {
  id: string;
  arm: Arm;
  round: number;
  ok: boolean;
  zone: string | null;
  spot: boolean;
  /** The Job's VMs, failed launches included; vmSeconds sums them. */
  attempts: number;
  vmSeconds: number | null;
  pricePerHour: number | null;
  timings: Record<string, number>;
  /** Each path's mount source and filesystem on the host. */
  disks: Record<string, string>;
  cpu: string | null;
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
const apiUrl = (api: Api) => `http://127.0.0.1:${api.port}`;
async function cli(
  args: string[],
  api: Api,
  env: object = {},
  timeoutMs = 300_000,
) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(api.root, 'dist/cli/index.js'), ...args],
    {
      cwd: api.root,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANYCLOUD_DIR: join(api.state, 'cli'),
        API_URL: apiUrl(api),
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

async function query<T>(sql: string, api: Api): Promise<T[]> {
  return (
    JSON.parse(await cli(['db', 'query', '--json', sql], api)) as {
      rows: T[];
    }
  ).rows;
}

const apiHealthy = (api: Api) =>
  fetch(`${apiUrl(api)}/health`)
    .then((response) => response.ok)
    .catch(() => false);

function runOrThrow(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed`);
}

async function startApi(api: Api): Promise<void> {
  // The run's API outlives a run step that timed out; cleanup reuses it and
  // its token.
  if (await apiHealthy(api)) return;
  if (api.variant !== 'head' && !existsSync(api.root)) {
    runOrThrow('git', ['worktree', 'add', '--detach', api.root, 'HEAD'], root);
    runOrThrow(
      'git',
      ['apply', join(import.meta.dirname, `variant-${api.variant}.patch`)],
      api.root,
    );
    symlinkSync(join(root, 'node_modules'), join(api.root, 'node_modules'));
  }
  if (!existsSync(join(api.root, 'dist/api/server.js')))
    runOrThrow('yarn', ['build'], api.root);
  mkdirSync(api.state, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeLocalApiToken(api.state, token);
  writeLocalApiToken(join(api.state, 'cli'), token);
  const logPath = join(api.state, 'api.log');
  const server = spawn(
    process.execPath,
    [join(api.root, 'dist/api/server.js')],
    {
      cwd: api.root,
      detached: true,
      stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
      env: {
        ...process.env,
        ANYCLOUD_DIR: api.state,
        SQLITE_PATH: join(api.state, 'api.db'),
        CIPHER_KEY: '',
        IS_TEST: 'true',
        PORT: String(api.port),
        GITHUB_TOKEN: 'dummy-token-for-test',
      },
    },
  );
  server.unref();
  process.on('exit', () => {
    server.kill('SIGTERM');
    evidence(
      `api-${api.cloud}-${api.variant}.log`,
      readFileSync(logPath, 'utf8'),
    );
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await apiHealthy(api)) return;
    await sleep(1_000);
  }
  throw new Error(`The ${api.variant} API never became healthy; see its log`);
}

const apisOf = ({ cloud, variants }: Inventory) =>
  variants.map((v) => apiOf(cloud, v));

/** Parses the guest's `BENCH`, `DISK` and `LSCPU` lines. */
function parseLog(log: string) {
  const timings: Record<string, number> = {};
  const disks: Record<string, string> = {};
  let cpu: string | null = null;
  for (const line of log.split('\n').map((l) => l.trim())) {
    const bench = /^BENCH (\S+) (\S+) (\d+)$/.exec(line);
    if (bench) timings[`${bench[1]} ${bench[2]}`] = Number(bench[3]) / 1000;
    const disk = /^DISK (\S+) (.*)$/.exec(line);
    if (disk) disks[disk[1]!] = disk[2]!;
    cpu = /^LSCPU Model name:\s*(.*)$/.exec(line)?.[1] ?? cpu;
  }
  return {
    timings,
    disks,
    cpu,
    done: log.includes('BENCH_DONE') && !log.includes('BENCH_FAIL'),
  };
}

/** The block device under a `findmnt` source such as `/dev/nvme1n1[/anycloud/workspace] ext4`. */
const deviceOf = (source = '') => source.split(/[[\s]/)[0];

async function runJob(
  inventory: Inventory,
  arm: Arm,
  round: number,
): Promise<JobResult> {
  const id = `ln-${inventory.runId}-r${round}-${shortArm(arm)}`;
  const variant = variantOf(arm);
  const api = apiOf(inventory.cloud, variant);
  const spot = CLOUDS[inventory.cloud].spot && !onDemand;
  inventory.jobs.push({ id, variant });
  writeFileSync(inventoryPath(inventory.cloud), JSON.stringify(inventory));
  const guest = readFileSync(join(import.meta.dirname, 'guest.sh'));
  await cli(
    [
      'job',
      'docker:27-cli',
      '--id',
      id,
      '--credentials',
      `${inventory.cloud}-spike`,
      '--regions',
      inventory.regions.join(','),
      '--vm-type',
      vmOf(arm),
      ...diskOf(inventory.cloud, arm).args,
      '--max-retries',
      '0',
      '--no-checkpoint',
      '--host-docker',
      ...(spot ? ['--spot'] : []),
      '--',
      'sh',
      '-c',
      `echo ${guest.toString('base64')} | base64 -d | sh`,
    ],
    api,
  );
  console.log(`round ${round}: submitted ${id}`);
  // The VM is deleted when the Job ends, so its log is followed from the start.
  const log = await cli(
    ['logs', id, '--follow'],
    api,
    {},
    JOB_TIMEOUT_MS,
  ).catch(
    (error: Error & { output?: string }) => `${error.output}\n${error.message}`,
  );
  writeFileSync(join(output, `${id}.log`), log);
  const parsed = parseLog(log);
  // The API ends the VM after the Job; wait for that, so its lifetime is final.
  await cli(['terminate', id], api).catch(() => undefined);
  // Every VM the Job had, failed attempts too, newest first.
  const vms = await until(`${id}'s VMs to end`, 10 * 60_000, async () => {
    const rows = await query<{
      availability_zone: string | null;
      price_per_hour: number | null;
      created_at: number;
      ended_at: number | null;
    }>(
      `SELECT availability_zone, price_per_hour, created_at, ended_at FROM vms WHERE workload_id = '${id}' ORDER BY created_at DESC`,
      api,
    );
    return rows.every((row) => row.ended_at) ? rows : undefined;
  });
  const [vm] = vms;
  // The host's boot marks, seconds after its kernel started, from the Job's
  // Running event: the container's start, and the variant's local disk
  // setup (its mkfs, mount and binds), which runs beside Docker's install.
  const [running] = await query<{ metadata: string | null }>(
    `SELECT metadata FROM workload_events WHERE workload_id = '${id}' AND state = 'running' ORDER BY id DESC LIMIT 1`,
    api,
  );
  const marks = ((running?.metadata &&
    (JSON.parse(running.metadata) as { bootMarks?: Record<string, number> })
      .bootMarks) ||
    {}) as Record<string, number>;
  const boot = {
    ...(marks['container-started'] !== undefined && {
      'boot kernel-to-container-start': marks['container-started'],
    }),
    ...(marks['local-disk-ready'] !== undefined &&
      marks['local-disk-start'] !== undefined && {
        'boot local-disk-setup':
          marks['local-disk-ready'] - marks['local-disk-start'],
      }),
  };
  // The variant's whole point: its /workspace is off the OS disk.
  const local =
    variant !== VARIANT ||
    (!!parsed.disks['/workspace'] &&
      deviceOf(parsed.disks['/workspace']) !== deviceOf(parsed.disks['/']));
  return {
    id,
    arm,
    round,
    ok: parsed.done && local,
    zone: vm?.availability_zone ?? null,
    spot,
    attempts: vms.length,
    vmSeconds: vm
      ? vms.reduce((sum, v) => sum + (v.ended_at! - v.created_at), 0) / 1000
      : null,
    pricePerHour: vm?.price_per_hour ?? null,
    timings: { ...boot, ...parsed.timings },
    disks: parsed.disks,
    cpu: parsed.cpu,
    ...(parsed.done && local
      ? {}
      : {
          failure: `${local ? '' : '/workspace is on the OS disk\n'}${log.split('\n').slice(-40).join('\n')}`,
        }),
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

/** A Job's whole VM time at the VM's price and its disk's list price. */
const costOf = (r: JobResult) =>
  ((r.vmSeconds ?? 0) / 3600) *
  ((r.pricePerHour ?? 0) + diskOf(cloudOf(r.arm), r.arm).perHour);

/**
 * Records an empty inventory for the cloud's arms, then starts each of its
 * APIs with CI's credentials.
 */
async function setUp(
  cloud: Cloud,
  arms: Arm[],
  regions: string[],
): Promise<Inventory> {
  mkdirSync(join(base, cloud), { recursive: true });
  mkdirSync(output, { recursive: true });
  const inventory: Inventory = {
    runId: randomBytes(3).toString('hex'),
    cloud,
    regions,
    variants: ['head', ...new Set(arms.flatMap((a) => a.split('@').slice(1)))],
    jobs: [],
  };
  writeFileSync(inventoryPath(cloud), JSON.stringify(inventory));
  for (const api of apisOf(inventory)) {
    await startApi(api);
    await cli(
      ['credentials', 'new', `${cloud}-spike`, '--provider', cloud],
      api,
      CLOUDS[cloud].env(),
    );
  }
  return inventory;
}

/** Runs the cloud's rounds, then checks that nothing is left. */
async function run(
  inventory: Inventory,
  arms: Arm[],
  rounds: number,
  parallel: number,
): Promise<JobResult[]> {
  const { cloud, regions } = inventory;
  const results: JobResult[] = [];
  const save = () => {
    evidence(`results-${cloud}.json`, { regions, results });
    evidence(`report-${cloud}.md`, report(results));
  };
  // Each round starts one Job per arm at once, in a random order, so drift
  // over the run and a slow minute hit every arm alike.
  let next = 1;
  const lastStart = Date.now() + ROUNDS_WINDOW_MS;
  const worker = async () => {
    while (next <= rounds && Date.now() < lastStart) {
      const spent = results.reduce((sum, r) => sum + costOf(r), 0);
      if (spent >= COST_CAP_USD) {
        console.warn(
          `${cloud} cost cap: $${spent.toFixed(2)} spent; no more rounds`,
        );
        return;
      }
      const round = next++;
      const settled = await Promise.allSettled(
        shuffle(arms).map((arm) => runJob(inventory, arm, round)),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') results.push(outcome.value);
        else
          console.error(`${cloud} round ${round}: ${String(outcome.reason)}`);
      }
      save();
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  await verifyClean(inventory);
  console.log(report(results));
  const failed = results.filter((r) => !r.ok);
  if (failed.length || results.length < rounds * arms.length) {
    throw new Error(
      `${cloud}: ${failed.length} Jobs failed; ${results.length} of ${rounds * arms.length} reported`,
    );
  }
  return results;
}

/** Terminates the Jobs, waits for each API's cleanup, then asks the cloud. */
async function verifyClean(inventory: Inventory) {
  for (const api of apisOf(inventory)) {
    const ids = inventory.jobs
      .filter((job) => job.variant === api.variant)
      .map((job) => job.id);
    if (!ids.length) continue;
    await cli(['terminate', ...ids], api).catch((error: unknown) =>
      console.warn(String(error)),
    );
    const list = ids.map((id) => `'${id}'`).join(',');
    await until(
      `the ${api.variant} API to clean up every Job`,
      15 * 60_000,
      async () => {
        const [left] = await query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM workloads w WHERE w.id IN (${list}) AND (w.cleaned_at IS NULL OR EXISTS (SELECT 1 FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL))`,
          api,
        );
        return left?.n === 0 ? true : undefined;
      },
    );
  }
  const left = inventory.jobs.length ? await leftovers(inventory) : [];
  evidence(`cleanup-${inventory.cloud}.json`, {
    jobs: inventory.jobs.length,
    left,
  });
  if (left.length) {
    throw new Error(`Cloud resources remain: ${JSON.stringify(left)}`);
  }
}

/**
 * The cloud's resources tagged (labelled, on GCP) `anycloud_deployment` with
 * one of the run's Job IDs: instances and volumes on AWS, instances and disks
 * in every GCP zone, and every Azure resource.
 */
async function leftovers({ cloud, regions, jobs: inventoryJobs }: Inventory) {
  const jobs = inventoryJobs.map((job) => job.id);
  const ours = (id: string | null | undefined) => !!id && jobs.includes(id);
  const left: string[] = [];
  if (cloud === 'gcp') {
    const options = {
      projectId: required('GCP_PROJECT_ID'),
      credentials: {
        client_email: required('GCP_CLIENT_EMAIL'),
        private_key: required('GCP_PRIVATE_KEY').replace(/\\n/g, '\n'),
      },
    };
    const project = required('GCP_PROJECT_ID');
    const filter = 'labels.anycloud_deployment:*';
    for await (const [, { instances }] of new InstancesClient(
      options,
    ).aggregatedListAsync({ project, filter })) {
      for (const i of instances ?? [])
        if (ours(i.labels?.anycloud_deployment))
          left.push(`instance ${i.name}`);
    }
    for await (const [, { disks }] of new DisksClient(
      options,
    ).aggregatedListAsync({ project, filter })) {
      for (const d of disks ?? [])
        if (ours(d.labels?.anycloud_deployment)) left.push(`disk ${d.name}`);
    }
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

/** Each cloud the run recorded an inventory for, checked in parallel. */
async function cleanup(clouds: Cloud[]) {
  const inventories = clouds
    .filter((c) => existsSync(inventoryPath(c)))
    .map(
      (c) => JSON.parse(readFileSync(inventoryPath(c), 'utf8')) as Inventory,
    );
  for (const api of inventories.flatMap(apisOf)) await startApi(api);
  await settle(inventories.map(verifyClean));
}

/** Waits for every promise, then throws the first failure. */
async function settle<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((o) => o.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((o) => (o as PromiseFulfilledResult<T>).value);
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

/** The timed commands: the first run's builds, then the disk-heavy steps. */
const BUILDS = [
  'pull toolchain-images',
  'docker build',
  'rust build',
  'typescript install',
  'typescript build',
];
const DISK_HEAVY = [
  'ml pull',
  'ml build',
  'ml save',
  'ml load',
  'cache restore',
  'cache save',
];
const sumOf = (steps: string[]) => (r: JobResult) =>
  steps.every((b) => r.timings[b] !== undefined)
    ? steps.reduce((sum, b) => sum + r.timings[b]!, 0)
    : undefined;

function report(results: JobResult[]): string {
  const ok = results.filter((r) => r.ok);
  const of = (arm: Arm) => ok.filter((r) => r.arm === arm);
  const fmt = (x: number) => x.toFixed(1);
  const lines: string[] = [];
  const arms = [...new Set(results.map((r) => r.arm))];
  const metrics: [string, (r: JobResult) => number | undefined][] = [
    ...[...new Set(ok.flatMap((r) => Object.keys(r.timings)))]
      .sort()
      .map((m): [string, (r: JobResult) => number | undefined] => [
        m,
        (r) => r.timings[m],
      ]),
    ['all builds', sumOf(BUILDS)],
    ['all disk-heavy', sumOf(DISK_HEAVY)],
    ['VM time per Job', (r) => r.vmSeconds ?? undefined],
    ['cost per Job ($)', (r) => (r.vmSeconds === null ? undefined : costOf(r))],
  ];
  for (const [a, b] of pairsOf(arms)) {
    const [ra, rb] = [of(a), of(b)];
    const price = (rs: JobResult[]) =>
      median(rs.map((r) => r.pricePerHour ?? 0));
    const disk = (arm: Arm) => diskOf(cloudOf(arm), arm).perHour;
    lines.push(
      `### ${a} vs ${b} (n = ${ra.length} and ${rb.length})`,
      '',
      `Seconds, except cost; ratio is ${a}'s median over ${b}'s, below 1 is ${a} faster or cheaper. VMs' median price $${price(ra).toFixed(4)}/h and $${price(rb).toFixed(4)}/h, disks' $${disk(a).toFixed(4)}/h and $${disk(b).toFixed(4)}/h.`,
      '',
      `| Measure | ${a} median (p90) | ${b} median (p90) | Ratio | Mann-Whitney p |`,
      '| --- | --- | --- | --- | --- |',
    );
    for (const [metric, value] of metrics) {
      const xa = ra.flatMap((r) => value(r) ?? []);
      const xb = rb.flatMap((r) => value(r) ?? []);
      if (!xa.length || !xb.length) continue;
      const cell = (xs: number[]) =>
        metric.startsWith('cost')
          ? `${median(xs).toFixed(4)} (${quantile(xs, 0.9).toFixed(4)})`
          : `${fmt(median(xs))} (${fmt(quantile(xs, 0.9))})`;
      lines.push(
        `| ${metric} | ${cell(xa)} | ${cell(xb)} | ${(median(xa) / median(xb)).toFixed(2)} | ${mannWhitney(xa, xb).toPrecision(2)} |`,
      );
    }
    lines.push('');
  }
  lines.push('### Arms', '');
  for (const arm of arms) {
    const all = results.filter((r) => r.arm === arm);
    const first = of(arm)[0];
    const failed = all.filter((r) => !r.ok).length;
    lines.push(
      `- ${arm}: ${first?.cpu ?? '?'}; ${all.some((r) => r.spot) ? 'spot' : 'on demand'}; zones ${[...new Set(of(arm).map((r) => r.zone))].join(', ')}; / on ${first?.disks['/'] ?? '?'}, /workspace on ${first?.disks['/workspace'] ?? '?'}, /var/lib/containerd on ${first?.disks['/var/lib/containerd'] ?? '?'}${failed ? `; ${failed} failed` : ''}`,
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
const onDemand = rest.includes('--on-demand');
const clouds = flag('cloud', 'aws,gcp,azure').split(',') as Cloud[];
for (const c of clouds)
  if (!(c in CLOUDS)) throw new Error(`Unknown cloud ${c}`);
const only = flag('arms', '').split(',').filter(Boolean);
const armsOf = (c: Cloud) =>
  CLOUDS[c].arms.filter((arm) => !only.length || only.includes(arm));
if (command === 'run') {
  // The APIs start one at a time, since they share the variant's build; the
  // clouds' rounds then run at once.
  const inventories: Inventory[] = [];
  for (const c of clouds)
    inventories.push(await setUp(c, armsOf(c), CLOUDS[c].region.split(',')));
  const results = await settle(
    inventories.map((inventory) =>
      run(
        inventory,
        armsOf(inventory.cloud),
        Number(flag('rounds', '10')),
        Number(flag('parallel', '3')),
      ),
    ),
  );
  evidence('report.md', report(results.flat()));
} else if (command === 'cleanup') {
  await cleanup(clouds);
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
