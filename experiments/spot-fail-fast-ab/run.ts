#!/usr/bin/env tsx
/**
 * A/B of the spot fail-fast fix: main's API against this branch's, one
 * anycloud spot Job each per round, interleaved; see README.md.
 *
 * `run [--rounds=20] [--workers=2] [--minutes=70]` builds main's API (this
 * branch with fix.patch reversed) beside the branch's, starts both and runs
 * the rounds. `cleanup` terminates the run's Jobs through both APIs and
 * checks AWS for anything left.
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
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'spot-fail-fast-ab');
const inventoryPath = join(state, 'inventory.json');
const REGIONS = ['us-east-2', 'us-east-1', 'us-west-2'];
const SIZES = ['xlarge', '4xlarge'] as const;
type Size = (typeof SIZES)[number];
const ARMS = {
  main: { dir: join(state, 'main'), port: 18_441 },
  fix: { dir: root, port: 18_442 },
} as const;
type Arm = keyof typeof ARMS;

interface Inventory {
  runId: string;
  jobs: Record<Arm, string[]>;
}

interface Trial {
  arm: Arm;
  size: Size;
  round: number;
  /** Submission to the API recording the VM's zone. */
  acceptedS: number | null;
  type: string | null;
  region: string | null;
  zone: string | null;
  /** The gateway's "EC2 refused the launch in this zone" log lines. */
  refusals: number;
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
      ['apply', '-R', join(root, 'experiments/spot-fail-fast-ab/fix.patch')],
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

/** Credentials, and an on-demand Job per region so the Jobs VPC exists. */
async function setUp(arm: Arm, inventory: Inventory) {
  await startApi(arm);
  await cli(arm, ['credentials', 'new', 'aws-spike', '--provider', 'aws'], {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  });
  await Promise.all(
    REGIONS.map(async (region) => {
      const id = `ab-${inventory.runId}-${arm}-w-${region.replace(/^us-(\w)\w+-/, 'us$1')}`;
      record(inventory, arm, id);
      await cli(arm, [
        'job',
        'alpine:3.20',
        '--id',
        id,
        '--credentials',
        'aws-spike',
        '--region',
        region,
        '--vm-type',
        'm8i.xlarge',
        '--max-retries',
        '0',
        '--no-checkpoint',
        '--',
        'true',
      ]);
      await until(`${id} to start`, 10 * 60_000, 5_000, async () => {
        const [r] = await query<{ state: string }>(
          arm,
          `SELECT state FROM workloads WHERE id = '${id}'`,
        );
        return ['running', 'completed', 'failed', 'invalid'].includes(
          r?.state ?? '',
        )
          ? true
          : undefined;
      });
    }),
  );
}

/** One spot Job allowed m8a then m8i in every region, as the spike's (a). */
async function trial(
  inventory: Inventory,
  arm: Arm,
  size: Size,
  round: number,
): Promise<Trial> {
  const jobId = `ab-${inventory.runId}-${arm}-${size === 'xlarge' ? 1 : 4}-r${round}`;
  record(inventory, arm, jobId);
  const submitted = Date.now();
  await cli(arm, [
    'job',
    'alpine:3.20',
    '--id',
    jobId,
    '--credentials',
    'aws-spike',
    '--regions',
    REGIONS.join(','),
    '--vm-type',
    `m8a.${size}`,
    '--vm-type',
    `m8i.${size}`,
    '--spot',
    '--max-retries',
    '0',
    '--no-checkpoint',
    '--',
    'sleep',
    '900',
  ]);
  const row = await until(`${jobId}'s VM`, 10 * 60_000, 1_000, async () => {
    const [r] = await query<{
      state: string;
      zone: string | null;
      region: string | null;
      vm_type: string | null;
    }>(
      arm,
      `SELECT w.state, v.availability_zone AS zone, v.region, v.vm_type FROM workloads w LEFT JOIN vms v ON v.workload_id = w.id AND v.availability_zone IS NOT NULL WHERE w.id = '${jobId}'`,
    );
    return r?.zone || ['failed', 'invalid'].includes(r?.state ?? '')
      ? r
      : undefined;
  }).catch(() => undefined);
  const accepted = Date.now();
  await cli(arm, ['terminate', jobId]).catch((e: unknown) =>
    console.warn(String(e)),
  );
  const refusals = readFileSync(apiLog(arm), 'utf8')
    .split('\n')
    .filter(
      (line) =>
        line.includes('EC2 refused the launch in this zone') &&
        line.includes(`"${jobId}-`),
    ).length;
  return {
    arm,
    size,
    round,
    acceptedS: row?.zone ? (accepted - submitted) / 1000 : null,
    type: row?.zone ? row.vm_type : null,
    region: row?.zone ? row.region : null,
    zone: row?.zone ?? null,
    refusals,
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};

function report(trials: Trial[]): string {
  const lines = [
    '| Arm | Size | n | Landed | On m8a | Accepted s, median (p90) | Refused zones per launch, median |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const size of SIZES) {
    for (const arm of Object.keys(ARMS) as Arm[]) {
      const mine = trials.filter((t) => t.arm === arm && t.size === size);
      const landed = mine.filter((t) => t.acceptedS !== null);
      const seconds = landed.map((t) => t.acceptedS!);
      lines.push(
        `| ${arm} | ${size} | ${mine.length} | ${landed.length} | ${landed.filter((t) => t.type?.startsWith('m8a')).length} | ${quantile(seconds, 0.5).toFixed(1)} (${quantile(seconds, 0.9).toFixed(1)}) | ${quantile(
          mine.map((t) => t.refusals),
          0.5,
        )} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
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
  // Each round runs both arms once, in random order, so drift in capacity
  // hits both alike.
  await Promise.all(
    SIZES.map(async (size) => {
      let next = 1;
      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (next <= rounds && Date.now() < deadline) {
            const round = next++;
            for (const arm of shuffle(Object.keys(ARMS) as Arm[])) {
              const t = await trial(inventory, arm, size, round);
              console.log(
                `${size} r${round} ${arm}: ${t.type ?? 'no VM'} ${t.acceptedS ?? '-'} s, ${t.refusals} refused`,
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
  const jobs = Object.values(inventory.jobs).flat();
  const left: { instances: string[]; volumes: string[] } = {
    instances: [],
    volumes: [],
  };
  for (const region of REGIONS) {
    const ec2 = new EC2Client({ region, maxAttempts: 5 });
    const ours = {
      Name: 'tag:anycloud_deployment',
      Values: jobs.length ? jobs : ['-'],
    };
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
    left.instances.push(
      ...Reservations.flatMap((r) => r.Instances ?? []).map(
        (i) => i.InstanceId!,
      ),
    );
    const { Volumes = [] } = await ec2.send(
      new DescribeVolumesCommand({ Filters: [ours] }),
    );
    left.volumes.push(...Volumes.map((v) => v.VolumeId!));
  }
  evidence('cleanup.json', { jobs: jobs.length, left });
  if (left.instances.length || left.volumes.length) {
    throw new Error(`AWS resources remain: ${JSON.stringify(left)}`);
  }
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'run') {
  await run(
    Number(flag('rounds', '20')),
    Number(flag('workers', '2')),
    Number(flag('minutes', '70')),
  );
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
