#!/usr/bin/env tsx
/**
 * A/B of the scheduler kick and the on-VM pull poll: main's API against this
 * branch's, one AWS Job of each shape per arm per round, interleaved; see
 * README.md.
 *
 * `run [--rounds=20] [--workers=4] [--minutes=75]` builds main's API (this
 * branch with fix.patch reversed) beside the branch's, starts both and runs
 * the rounds. `cleanup` terminates the run's Jobs through both APIs and
 * checks AWS for anything left; `check --run=<runId>` checks AWS alone.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
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
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'scheduler-kick-ab');
const inventoryPath = join(state, 'inventory.json');
const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
/** `cpu` pre-pulls in its user data; `gpu` has no Job host preparation, so
 * its image pull runs over SSH through runDetachedOnVm. */
const SHAPES = {
  cpu: { vmType: 'm7i.large', image: 'alpine:3.20' },
  gpu: {
    vmType: 'g4dn.xlarge',
    image: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
  },
} as const;
type Shape = keyof typeof SHAPES;
const ARMS = {
  main: { dir: join(state, 'main'), port: 18_451 },
  fix: { dir: root, port: 18_452 },
} as const;
type Arm = keyof typeof ARMS;

interface Inventory {
  runId: string;
  jobs: Record<Arm, string[]>;
}

interface Trial {
  arm: Arm;
  shape: Shape;
  round: number;
  /** Submission to the first VM launch request (its pre-registered row). */
  launchS: number | null;
  /** Submission to the Running event. */
  runningS: number | null;
  /** The Downloading event's pull telemetry. */
  pullMethod: string | null;
  pullS: number | null;
  region: string | null;
  state: string;
}

const home = (arm: Arm) => join(state, arm);
const apiUrl = (arm: Arm) => `http://127.0.0.1:${ARMS[arm].port}`;
const apiLog = (arm: Arm) => join(home(arm), 'api.log');

function evidence(name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

const execFileAsync = promisify(execFile);
async function cli(arm: Arm, args: string[], env: object = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(root, 'dist/cli/index.js'), ...args],
    {
      cwd: root,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANYCLOUD_DIR: join(home(arm), 'cli'),
        API_URL: apiUrl(arm),
        IS_TEST: 'true',
        CI: 'true',
        GITHUB_TOKEN: 'dummy-token-for-test',
        NO_COLOR: '1',
        ...env,
      },
    },
  ).catch((error: { stderr?: string; stdout?: string; code?: unknown }) => {
    throw new Error(
      `${arm}: anycloud ${args[0]} failed (${String(error.code)}): ${(error.stderr || error.stdout || '').slice(-600)}`,
    );
  });
  return stdout;
}

async function query<T>(arm: Arm, sql: string): Promise<T[]> {
  return (
    JSON.parse(await cli(arm, ['db', 'query', '--json', sql])) as { rows: T[] }
  ).rows;
}

async function until<T>(
  what: string,
  timeoutMs: number,
  intervalMs: number,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

const shuffle = <T>(items: readonly T[]): T[] =>
  items
    .map((item) => ({ item, key: Math.random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);

/** main's tree: this commit with the fix's source change reversed. */
function build() {
  const { dir } = ARMS.main;
  if (!existsSync(dir)) {
    execFileSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], {
      cwd: root,
      stdio: 'inherit',
    });
    execFileSync(
      'git',
      ['apply', '-R', join(root, 'experiments/scheduler-kick-ab/fix.patch')],
      { cwd: dir, stdio: 'inherit' },
    );
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  }
  for (const cwd of [dir, root]) {
    if (!existsSync(join(cwd, 'dist/api/server.js'))) {
      execFileSync('yarn', ['build'], { cwd, stdio: 'inherit' });
    }
  }
}

async function startApi(arm: Arm): Promise<void> {
  mkdirSync(home(arm), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeLocalApiToken(home(arm), token);
  writeLocalApiToken(join(home(arm), 'cli'), token);
  const log = openSync(apiLog(arm), 'a');
  const api = spawn(
    process.execPath,
    [join(ARMS[arm].dir, 'dist/api/server.js')],
    {
      cwd: ARMS[arm].dir,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        ANYCLOUD_DIR: home(arm),
        SQLITE_PATH: join(home(arm), 'api.db'),
        CIPHER_KEY: '',
        IS_TEST: 'true',
        PORT: String(ARMS[arm].port),
        GITHUB_TOKEN: 'dummy-token-for-test',
      },
    },
  );
  api.unref();
  process.on('exit', () => {
    api.kill('SIGTERM');
    evidence(`api-${arm}.log`, readFileSync(apiLog(arm), 'utf8'));
  });
  await until(`${arm}'s API`, 60_000, 1_000, () =>
    fetch(`${apiUrl(arm)}/health`)
      .then((response) => (response.ok ? true : undefined))
      .catch(() => undefined),
  );
}

function record(inventory: Inventory, arm: Arm, jobId: string) {
  inventory.jobs[arm].push(jobId);
  writeFileSync(inventoryPath, JSON.stringify(inventory));
}

async function submit(arm: Arm, jobId: string, shape: Shape, region?: string) {
  await cli(arm, [
    'job',
    SHAPES[shape].image,
    '--id',
    jobId,
    '--credentials',
    'aws-spike',
    ...(region ? ['--region', region] : ['--regions', REGIONS.join(',')]),
    '--vm-type',
    SHAPES[shape].vmType,
    '--max-retries',
    '0',
    '--no-checkpoint',
    '--',
    'sleep',
    '900',
  ]);
}

const ENDED = ['completed', 'failed', 'invalid', 'terminated'];

/** Credentials, and an on-demand Job per region so the Jobs VPC exists. */
async function setUp(arm: Arm, inventory: Inventory) {
  await startApi(arm);
  await cli(arm, ['credentials', 'new', 'aws-spike', '--provider', 'aws'], {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  });
  await Promise.all(
    REGIONS.map(async (region) => {
      const id = `kab-${inventory.runId}-${arm}-w-${region.replace(/^us-(\w)\w+-/, 'us$1')}`;
      record(inventory, arm, id);
      await submit(arm, id, 'cpu', region);
      await until(`${id} to start`, 10 * 60_000, 5_000, async () => {
        const [r] = await query<{ state: string }>(
          arm,
          `SELECT state FROM workloads WHERE id = '${id}'`,
        );
        return ['running', ...ENDED].includes(r?.state ?? '')
          ? true
          : undefined;
      });
      await cli(arm, ['terminate', id]).catch((e: unknown) =>
        console.warn(String(e)),
      );
    }),
  );
}

async function trial(
  inventory: Inventory,
  arm: Arm,
  shape: Shape,
  round: number,
): Promise<Trial> {
  const jobId = `kab-${inventory.runId}-${arm}-${shape}-r${round}`;
  record(inventory, arm, jobId);
  await submit(arm, jobId, shape);
  const row = await until(`${jobId} to run`, 20 * 60_000, 2_000, async () => {
    const [r] = await query<{
      state: string;
      submitted_at: number;
      launch_at: number | null;
      running_at: number | null;
      region: string | null;
      pull_method: string | null;
      pull_ms: number | null;
    }>(
      arm,
      `SELECT w.state, w.submitted_at,
           (SELECT MIN(v.created_at) FROM vms v WHERE v.workload_id = w.id) AS launch_at,
           (SELECT MIN(e.created_at) FROM workload_events e WHERE e.workload_id = w.id AND e.state = 'running') AS running_at,
           (SELECT v.region FROM vms v WHERE v.workload_id = w.id ORDER BY v.id DESC LIMIT 1) AS region,
           (SELECT json_extract(e.metadata, '$.imagePull.method') FROM workload_events e WHERE e.workload_id = w.id AND e.state = 'downloading' ORDER BY e.id DESC LIMIT 1) AS pull_method,
           (SELECT json_extract(e.metadata, '$.imagePull.elapsedMs') FROM workload_events e WHERE e.workload_id = w.id AND e.state = 'downloading' ORDER BY e.id DESC LIMIT 1) AS pull_ms
         FROM workloads w WHERE w.id = '${jobId}'`,
    );
    return r?.running_at || ENDED.includes(r?.state ?? '') ? r : undefined;
  }).catch(() => undefined);
  await cli(arm, ['terminate', jobId]).catch((e: unknown) =>
    console.warn(String(e)),
  );
  const since = (at: number | null | undefined) =>
    row && at ? (at - row.submitted_at) / 1000 : null;
  return {
    arm,
    shape,
    round,
    launchS: since(row?.launch_at),
    runningS: since(row?.running_at),
    pullMethod: row?.pull_method ?? null,
    pullS: row?.pull_ms != null ? row.pull_ms / 1000 : null,
    region: row?.region ?? null,
    state: row?.state ?? 'timed out',
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};
const cell = (xs: (number | null)[]) => {
  const ys = xs.filter((x): x is number => x !== null);
  return `${quantile(ys, 0.5).toFixed(1)} (${quantile(ys, 0.9).toFixed(1)}), n=${ys.length}`;
};

function report(trials: Trial[]): string {
  const lines = [
    '| Shape | Arm | Trials | Submit → launch request s | Submit → running s | Pull s | Pull methods |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const shape of Object.keys(SHAPES) as Shape[]) {
    for (const arm of Object.keys(ARMS) as Arm[]) {
      const mine = trials.filter((t) => t.arm === arm && t.shape === shape);
      const methods = [...new Set(mine.map((t) => t.pullMethod ?? '-'))];
      lines.push(
        `| ${shape} | ${arm} | ${mine.length} | ${cell(mine.map((t) => t.launchS))} | ${cell(mine.map((t) => t.runningS))} | ${cell(mine.map((t) => t.pullS))} | ${methods.join(', ')} |`,
      );
    }
  }
  return `Median (p90), n = trials with the mark.\n\n${lines.join('\n')}\n`;
}

async function run(rounds: number, workers: number, minutes: number) {
  mkdirSync(state, { recursive: true });
  const inventory: Inventory = {
    runId: randomBytes(3).toString('hex'),
    jobs: { main: [], fix: [] },
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  build();
  await Promise.all(
    (Object.keys(ARMS) as Arm[]).map((arm) => setUp(arm, inventory)),
  );
  const trials: Trial[] = [];
  const deadline = Date.now() + minutes * 60_000;
  // Each round runs both arms once, in random order, so drift in the cloud
  // hits both alike.
  await Promise.all(
    (Object.keys(SHAPES) as Shape[]).map(async (shape) => {
      let next = 1;
      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (next <= rounds && Date.now() < deadline) {
            const round = next++;
            for (const arm of shuffle(Object.keys(ARMS) as Arm[])) {
              const t = await trial(inventory, arm, shape, round);
              console.log(
                `${shape} r${round} ${arm}: ${t.state} launch ${t.launchS ?? '-'} s, running ${t.runningS ?? '-'} s, pull ${t.pullS ?? '-'} s (${t.pullMethod ?? '-'})`,
              );
              trials.push(t);
            }
            evidence('trials.json', trials);
            evidence('report.md', report(trials));
          }
        }),
      );
    }),
  );
  await verifyClean(inventory);
  console.log(report(trials));
}

/** Ends the run's Jobs through both APIs, and checks AWS for what's left. */
async function verifyClean(inventory: Inventory) {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    const jobs = inventory.jobs[arm];
    if (!jobs.length) continue;
    await cli(arm, ['terminate', ...jobs]).catch((e: unknown) =>
      console.warn(String(e)),
    );
    const list = jobs.map((id) => `'${id}'`).join(',');
    await until(`${arm}'s API to clean up`, 15 * 60_000, 10_000, async () => {
      const [left] = await query<{ n: number }>(
        arm,
        `SELECT COUNT(*) AS n FROM workloads w WHERE w.id IN (${list}) AND (w.cleaned_at IS NULL OR EXISTS (SELECT 1 FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL))`,
      );
      return left?.n === 0 ? true : undefined;
    });
  }
  await verifyAws(Object.values(inventory.jobs).flat());
}

/**
 * Fails if an instance or volume tagged with one of `jobs` (wildcards
 * allowed) is left once EBS has had ten minutes to finish deleting. A
 * volume left `available` is the run's own, so it is deleted and reported.
 */
async function verifyAws(jobs: string[]) {
  const ours = { Name: 'tag:anycloud_deployment', Values: jobs };
  let left: Record<string, string[]> = {};
  await until('AWS to finish deleting', 10 * 60_000, 30_000, async () => {
    left = {};
    for (const region of REGIONS) {
      const ec2 = new EC2Client({ region, maxAttempts: 5 });
      const { Reservations = [] } = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            ours,
            {
              Name: 'instance-state-name',
              Values: ['pending', 'running', 'stopping', 'stopped'],
            },
          ],
        }),
      );
      for (const i of Reservations.flatMap((r) => r.Instances ?? [])) {
        (left[i.State?.Name ?? '?'] ??= []).push(i.InstanceId!);
      }
      const { Volumes = [] } = await ec2.send(
        new DescribeVolumesCommand({ Filters: [ours] }),
      );
      for (const v of Volumes) {
        (left[`volume ${v.State}`] ??= []).push(`${region} ${v.VolumeId}`);
        if (v.State === 'available') {
          await ec2.send(new DeleteVolumeCommand({ VolumeId: v.VolumeId }));
        }
      }
    }
    console.log(`AWS left: ${JSON.stringify(left)}`);
    return Object.keys(left).length ? undefined : true;
  }).catch(() => undefined);
  evidence('cleanup.json', { jobs, left });
  if (Object.keys(left).length) {
    throw new Error(`AWS resources remain: ${JSON.stringify(left)}`);
  }
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'run') {
  await run(
    Number(flag('rounds', '20')),
    Number(flag('workers', '4')),
    Number(flag('minutes', '75')),
  );
} else if (command === 'check') {
  // A run whose inventory went with its runner: `check --run=<runId>`.
  await verifyAws([`kab-${flag('run', '-')}-*`]);
} else if (command === 'cleanup') {
  if (!existsSync(inventoryPath)) {
    evidence('cleanup.json', { note: 'no inventory: run created nothing' });
  } else {
    build();
    await Promise.all((Object.keys(ARMS) as Arm[]).map(startApi));
    await verifyClean(
      JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory,
    );
  }
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
