#!/usr/bin/env tsx
/**
 * Live measurement: where the time from a VM Job host's kernel start to its
 * container's start goes, on each cloud. It runs the branch's API and CLI,
 * starts COUNT backmesh runner Jobs per target shaped like `backmesh-4`, and
 * reads the boot marks the branch keeps on each Job's Running event.
 *
 * `run [target...] [--count=N]` (default: aws gcp azure, 5) and `cleanup`
 * share a state directory; `diagnose [target...] [--count=N]` (default: gcp,
 * 3) instead holds Jobs running and saves each host's systemd ordering and
 * journal, to find what holds up sshd and containerd. All three
 * use a state directory under RUNNER_TEMP that holds the API database, so
 * cleanup can terminate the run's Jobs after a failure. Reports in
 * SPIKE_OUTPUT_DIR hold no credential.
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
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'vm-boot-marks');
const inventoryPath = join(state, 'inventory.json');
const apiLogPath = join(state, 'api.log');
const PORT = 18_433;
const API_URL = `http://127.0.0.1:${PORT}`;

/** backmesh v0.5.6's runner image: 724 MB of zstd layers. */
const IMAGE =
  'ghcr.io/backmesh/backmesh-runner@sha256:336e995b7a00ab3c3419fbf9f1d89ec9249d297b549198c29656f6c3c16713e4';

type Target = 'aws' | 'gcp' | 'azure';
/** `backmesh-4` on each cloud (backmesh src/runners/classes.ts), on demand. */
const TARGETS: Record<
  Target,
  { vmTypes: string[]; regions: string; disk: string[]; env: () => object }
> = {
  aws: {
    vmTypes: ['m8i.xlarge', 'm7a.xlarge', 'm7i.xlarge', 'm6a.xlarge'],
    regions: 'us-east-2,us-east-1',
    // backmesh's gp3 performance (runner-jobs.ts).
    disk: ['--disk-iops', '4000', '--disk-throughput', '500'],
    env: () => ({
      AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
    }),
  },
  gcp: {
    vmTypes: ['n2-standard-4', 'n2d-standard-4'],
    regions: 'us-east4,us-central1',
    disk: [],
    env: () => ({
      GCP_PROJECT_ID: required('GCP_PROJECT_ID'),
      GCP_CLIENT_EMAIL: required('GCP_CLIENT_EMAIL'),
      GCP_PRIVATE_KEY: required('GCP_PRIVATE_KEY'),
    }),
  },
  azure: {
    vmTypes: ['Standard_D4ads_v5', 'Standard_D4as_v5', 'Standard_D4s_v5'],
    regions: 'eastus2,centralus,eastus',
    disk: [],
    env: () => ({
      AZURE_APPLICATION_ID: required('AZURE_CLIENT_ID'),
      AZURE_SECRET: required('AZURE_CLIENT_SECRET'),
      AZURE_SUBSCRIPTION_ID: required('AZURE_SUBSCRIPTION_ID'),
      AZURE_DIRECTORY_ID: required('AZURE_TENANT_ID'),
    }),
  },
};

/**
 * The pieces, in boot order: each from one mark to the next. The user data
 * (prepare-start to pull-end) and the API's SSH steps (sshd to container-run)
 * run side by side; container-run waits for both.
 */
const PIECES: [piece: string, from: string, to: string][] = [
  ['kernel and initrd', 'kernel', 'userspace'],
  ['systemd to cloud-init', 'userspace', 'cloud-init-local'],
  ['cloud-init local stage', 'cloud-init-local', 'network-online'],
  ['network online to user data', 'network-online', 'prepare-start'],
  ['Docker install and start', 'prepare-start', 'docker-ready'],
  ['Docker archive to containerd up', 'docker-installed', 'containerd-ready'],
  ['image pull (user data)', 'pull-start', 'pull-end'],
  ['pull sync to disk', 'pull-unpacked', 'pull-end'],
  ['kernel to sshd', 'kernel', 'sshd'],
  ['sshd to the API reaching SSH', 'sshd', 'api-ssh'],
  ['cloud-init status --wait', 'api-ssh', 'cloud-init-done'],
  ['API host setup', 'cloud-init-done', 'api-pull'],
  ['pull wait to docker run', 'api-pull', 'container-run'],
  ['docker run to start', 'container-run', 'container-started'],
  ['kernel to container start', 'kernel', 'container-started'],
];

interface Inventory {
  runId: string;
  jobs: Record<string, Target>;
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

/** The branch's CLI against the run's API. */
function spawnCli(args: string[], env: object, timeoutMs: number, input = '') {
  return spawnSync(
    process.execPath,
    [join(root, 'dist/cli/index.js'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      input,
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
}

function cli(args: string[], env: object = {}, timeoutMs = 300_000) {
  const result = spawnCli(args, env, timeoutMs);
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

const sqlList = (ids: string[]) => ids.map((id) => `'${id}'`).join(',');

/** Wait until every Job has ended: each starts, exits 0 and completes. */
async function awaitEnded(ids: string[]) {
  const deadline = Date.now() + 40 * 60_000;
  for (;;) {
    const rows = query<{ id: string; state: string }>(
      `SELECT id, state FROM workloads WHERE id IN (${sqlList(ids)})`,
    );
    const ended = rows.filter((row) =>
      ['completed', 'failed', 'errored', 'invalid', 'terminated'].includes(
        row.state,
      ),
    );
    if (ended.length === ids.length) return rows;
    if (Date.now() > deadline) {
      console.warn('Timed out waiting for the Jobs to end', rows);
      return rows;
    }
    await sleep(15_000);
  }
}

/** Terminate the Jobs and wait until the API has deleted every VM. */
async function terminateAndAwaitCleanup(ids: string[]): Promise<unknown[]> {
  if (ids.length === 0) return [];
  // An ended Job refuses; the wait below asserts the outcome.
  try {
    cli(['terminate', ...ids]);
  } catch (error) {
    console.warn(String(error));
  }
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const rows = query<{ id: string; cleaned_at: unknown; live_vms: number }>(
      `SELECT w.id, w.state, w.cleaned_at, ` +
        `(SELECT COUNT(*) FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL) AS live_vms ` +
        `FROM workloads w WHERE w.id IN (${sqlList(ids)})`,
    );
    if (
      rows.length === ids.length &&
      rows.every((row) => row.cleaned_at !== null && row.live_vms === 0)
    )
      return rows;
    if (Date.now() > deadline) throw new Error('Jobs were not cleaned up');
    await sleep(10_000);
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (value: number | null) =>
  value === null ? null : Math.round(value * 100) / 100;

/** Each Job's marks, VM, image pull and API step times. */
function samples(ids: string[]) {
  const events = query<{
    workload_id: string;
    state: string;
    metadata: string | null;
    created_at: number;
  }>(
    `SELECT workload_id, state, metadata, created_at FROM workload_events ` +
      `WHERE workload_id IN (${sqlList(ids)}) ORDER BY id`,
  );
  const workloads = query<{
    id: string;
    state: string;
    vm_type: string | null;
    region: string | null;
  }>(
    `SELECT id, state, vm_type, region FROM workloads WHERE id IN (${sqlList(ids)})`,
  );
  return workloads.map((workload) => {
    const own = events.filter((event) => event.workload_id === workload.id);
    const meta = (state: string) => {
      const event = own.findLast((e) => e.state === state);
      return event?.metadata
        ? (JSON.parse(event.metadata) as Record<string, unknown>)
        : {};
    };
    const first = own[0]?.created_at ?? 0;
    const marks: Record<string, number> = {
      kernel: 0,
      ...(meta('running').bootMarks as Record<string, number> | undefined),
    };
    return {
      id: workload.id,
      state: workload.state,
      vmType: workload.vm_type,
      region: workload.region,
      marks,
      imagePull: meta('downloading').imagePull ?? null,
      // The API's steps, in seconds after the Job's first event.
      steps: own.map((e) => ({
        state: e.state,
        at: round((e.created_at - first) / 1000),
      })),
    };
  });
}

function summarize(jobs: ReturnType<typeof samples>) {
  const withMarks = jobs.filter((job) => 'container-started' in job.marks);
  const names = [...new Set(withMarks.flatMap((j) => Object.keys(j.marks)))];
  return {
    jobs: jobs.length,
    withMarks: withMarks.length,
    pieces: Object.fromEntries(
      PIECES.map(([piece, from, to]) => [
        piece,
        round(
          median(
            withMarks
              .filter((j) => from in j.marks && to in j.marks)
              .map((j) => j.marks[to]! - j.marks[from]!),
          ),
        ),
      ]),
    ),
    marks: Object.fromEntries(
      names.map((name) => [
        name,
        round(
          median(
            withMarks.filter((j) => name in j.marks).map((j) => j.marks[name]!),
          ),
        ),
      ]),
    ),
  };
}

/**
 * Start the API and COUNT Jobs per target of `image` with `args`, shaped like
 * `backmesh-4`; returns their IDs, which the inventory holds for cleanup.
 */
async function submit(
  targets: Target[],
  count: number,
  image: string,
  args: string[],
): Promise<string[]> {
  mkdirSync(state, { recursive: true });
  const runId = randomBytes(3).toString('hex');
  const inventory: Inventory = { runId, jobs: {} };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await startApi();

  for (const target of targets) {
    const spec = TARGETS[target];
    cli(
      ['credentials', 'new', `${target}-spike`, '--provider', target],
      spec.env(),
    );
    for (let index = 0; index < count; index++) {
      const id = `boot-marks-${target}-${runId}-${index}`;
      inventory.jobs[id] = target;
      writeFileSync(inventoryPath, JSON.stringify(inventory));
      console.log(`Submitting ${id}`);
      cli([
        'job',
        image,
        '--id',
        id,
        '--credentials',
        `${target}-spike`,
        '--regions',
        spec.regions,
        ...spec.vmTypes.flatMap((vmType) => ['--vm-type', vmType]),
        '--disk-size',
        '100',
        ...spec.disk,
        '--host-docker',
        '--shm-size',
        '8g',
        '--max-retries',
        '0',
        '--no-checkpoint',
        '--',
        ...args,
      ]);
    }
  }
  return Object.keys(inventory.jobs);
}

async function run(targets: Target[], count: number) {
  // runner-job's `timings` exits 0 at once without a job's state, so the
  // Job boots exactly as a runner does and then completes.
  const ids = await submit(targets, count, IMAGE, ['timings']);
  await awaitEnded(ids);
  const jobs = samples(ids);
  const byTarget = Object.fromEntries(
    targets.map((target) => [
      target,
      summarize(
        jobs.filter((job) => job.id.startsWith(`boot-marks-${target}-`)),
      ),
    ]),
  );
  const cleanup = await terminateAndAwaitCleanup(ids);
  evidence('jobs.json', jobs);
  evidence('summary.json', { image: IMAGE, byTarget, cleanup });
  console.log(JSON.stringify(byTarget, null, 2));
  // Each target needs marks from at least `count` Jobs to have measured it.
  if (Object.values(byTarget).some((t) => t.withMarks < count))
    process.exitCode = 1;
}

/** What a host's systemd says held up sshd, containerd and Docker. */
const DIAGNOSE_SCRIPT = `cat /run/anycloud/boot-marks
echo; systemd-analyze
for unit in ssh.service containerd.service docker.service google-guest-agent.service snapd.seeded.service anycloud-prepare.service; do
  echo; echo "== $unit"
  systemctl show -p After -p Requires -p Wants -p ExecMainStartTimestampMonotonic -p ActiveEnterTimestampMonotonic "$unit"
  systemctl cat "$unit" 2>/dev/null | grep -E '^(#|After|Before|Requires|Wants|Type|ExecStart)'
done
echo; systemd-analyze critical-chain ssh.service containerd.service google-guest-agent.service 2>&1
echo; systemd-analyze blame 2>&1 | head -40
echo; cat /run/anycloud/prepare/docker-install.log
echo; journalctl -b -o short-monotonic --no-pager | head -n 6000
`;

/** Hold Jobs running, save each host's systemd evidence, then clean up. */
async function diagnose(targets: Target[], count: number) {
  const ids = await submit(targets, count, 'ubuntu:24.04', ['sleep', '1800']);
  const deadline = Date.now() + 30 * 60_000;
  const pending = new Set(ids);
  while (pending.size > 0 && Date.now() < deadline) {
    const rows = query<{ id: string; state: string }>(
      `SELECT id, state FROM workloads WHERE id IN (${sqlList([...pending])})`,
    );
    for (const row of rows) {
      if (row.state === 'running') {
        const ssh = spawnCli(
          ['ssh', row.id, '--host'],
          {},
          120_000,
          DIAGNOSE_SCRIPT,
        );
        evidence(`diagnose-${row.id}.txt`, `${ssh.stdout}\n${ssh.stderr}`);
        pending.delete(row.id);
      } else if (row.state !== 'queued' && !/ing$/.test(row.state)) {
        console.warn(`${row.id} ended ${row.state} before it ran`);
        pending.delete(row.id);
      }
    }
    await sleep(10_000);
  }
  evidence('jobs.json', samples(ids));
  evidence('cleanup.json', await terminateAndAwaitCleanup(ids));
  if (pending.size > 0) process.exitCode = 1;
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
  evidence('cleanup.json', {
    jobs: await terminateAndAwaitCleanup(Object.keys(inventory.jobs)),
  });
}

const [command = 'run', ...rest] = process.argv.slice(2);
if (command === 'run') {
  const count = Number(
    rest.find((arg) => arg.startsWith('--count='))?.slice(8) ?? 5,
  );
  const named = rest.filter((arg) => !arg.startsWith('--'));
  const targets = (named.length ? named : ['aws', 'gcp', 'azure']) as Target[];
  for (const target of targets)
    if (!(target in TARGETS)) throw new Error(`Unknown target ${target}`);
  await run(targets, count);
} else if (command === 'diagnose') {
  const count = Number(
    rest.find((arg) => arg.startsWith('--count='))?.slice(8) ?? 3,
  );
  const named = rest.filter((arg) => !arg.startsWith('--'));
  const targets = (named.length ? named : ['gcp']) as Target[];
  for (const target of targets)
    if (!(target in TARGETS)) throw new Error(`Unknown target ${target}`);
  await diagnose(targets, count);
} else if (command === 'cleanup') {
  await cleanup();
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
