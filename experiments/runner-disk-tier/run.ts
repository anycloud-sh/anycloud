#!/usr/bin/env tsx
/** How a runner VM's gp3 IOPS and MiB/s change its start; see README.md. */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeVolumesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { Storage } from '@google-cloud/storage';
import { DockerManager } from '../../src/api/services/docker.js';
import {
  generateJobHostUserData,
  jobHostPrepare,
} from '../../src/api/services/job-host.js';
import { CloudType } from '../../src/shared/cloud.js';
import { gp3VolumePerformance } from '../../src/shared/gp3-performance.js';
import { WorkloadType } from '../../src/shared/workload.js';

const TAG = { key: 'anycloud-spike', value: 'runner-disk-tier' };
// backmesh v0.4.1's release notes pin this runner image.
const IMAGE =
  'ghcr.io/backmesh/backmesh-runner@sha256:1e8a4ad2e249343a2ebda33adcabfbe74b428977f61e8f42161859554cf41e67';
// backmesh-4 on AWS: its first type (`VM_TYPES` in backmesh's
// `src/runners/classes.ts`), spot, a 100 GB root (`RUNNER_DISK_GB`).
const REGION = 'us-east-2';
const ZONES = ['us-east-2a', 'us-east-2b', 'us-east-2c'];
const VM_TYPE = 'm8i.xlarge';
const VCPUS = 4;
const DISK_GB = 100;
// The arms' `--disk-iops` / `--disk-throughput`.
const ARMS = {
  baseline: { diskIops: 3000, diskThroughputMibps: 125 },
  today: { diskIops: 4000, diskThroughputMibps: 500 },
  high: { diskIops: 8000, diskThroughputMibps: 1000 },
};
type Arm = keyof typeof ARMS;
const ROUNDS = 5;
// Two rounds' VMs at once.
const CONCURRENCY = 6;
// The npm step: express v5.1.0 with a lockfile resolved once per run, so
// every VM installs the same tree. Its .npmrc turns lockfiles off.
const EXPRESS_URL =
  'https://codeload.github.com/expressjs/express/tar.gz/refs/tags/v5.1.0';
const NODE_IMAGE = 'node:22';
const GUEST_DEADLINE_MIN = 25;
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
const runId = process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex');
const name = `ac-spike-disk-${runId}`;

interface Job {
  id: string;
  arm: Arm;
  round: number;
  attempts: { zone: string; at: number; error?: string }[];
  launchAt?: number;
  zone?: string;
  instanceId?: string;
  done?: boolean;
  error?: string;
}

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** A throwaway OpenSSH ed25519 key for the user data; nothing ever uses it. */
function publicKey(): string {
  const { publicKey: key } = generateKeyPairSync('ed25519');
  const raw = key.export({ type: 'spki', format: 'der' }).subarray(12);
  const field = (b: Buffer) =>
    Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64')} spike`;
}

/**
 * The runner's `docker run`, as the API builds it for backmesh's runner Job
 * (backmesh `src/listener/runner-jobs.ts` `submit`), without its JIT config.
 */
function runnerCommand(job: Job): string {
  const props: Parameters<typeof DockerManager.getCommand>[0] = {
    id: job.id,
    image: IMAGE,
    imageDigest: null,
    workloadType: WorkloadType.Job,
    env: { BACKMESH_SUBMITTED_AT: '0' },
    registryUsername: 'spike',
    deploymentId: null,
    userId: 'spike',
    command: null,
    secretNames: null,
    hostDocker: true,
    dockerOptions: {
      network: 'host',
      shmSize: `${(VCPUS * 4) / 2}g`,
      binds: ['/tmp:/tmp', '/var/tmp:/var/tmp', '/mnt:/mnt'],
    },
  };
  return DockerManager.getCommand(props);
}

/**
 * The product's Job host cloud-config, and a boothook that starts the guest
 * in its own unit, so the guest never holds up cloud-init.
 */
function userData(job: Job, evidenceUrl: string, expressUrl: string): string {
  const settings = {
    SPIKE_ROUND: job.round,
    SPIKE_DEADLINE_MIN: GUEST_DEADLINE_MIN,
    SPIKE_EVIDENCE_URL: evidenceUrl,
    SPIKE_EXPRESS_URL: expressUrl,
    SPIKE_NODE_IMAGE: NODE_IMAGE,
  };
  const guest = [
    '#!/bin/bash',
    ...Object.entries(settings).map(([k, v]) => `export ${k}='${v}'`),
    `cat > /var/spike/runner-run.sh <<'SPIKE_EOF'\n${runnerCommand(job)}\nSPIKE_EOF`,
    readFileSync(new URL('guest.sh', import.meta.url), 'utf8'),
  ].join('\n');
  const host = jobHostPrepare(
    {
      workloadType: WorkloadType.Job,
      image: IMAGE,
      imageDigest: null,
      githubToken: null,
      registryUsername: null,
    },
    { cloudProvider: CloudType.AWS, region: REGION },
    null,
  )!;
  const product = generateJobHostUserData(
    { publicKey: publicKey(), privateKey: '' },
    host,
  );
  const boothook = [
    '#cloud-boothook',
    '#!/bin/bash',
    '[ -e /var/spike/started ] && exit 0',
    'mkdir -p /var/spike && touch /var/spike/started',
    `echo ${gzipSync(guest).toString('base64')} | base64 -d | gunzip > /var/spike/guest.sh`,
    'systemd-run --no-block --unit=spike-guest -p DefaultDependencies=no /bin/bash /var/spike/guest.sh',
  ].join('\n');
  const b = `SPIKE-${randomBytes(8).toString('hex')}`;
  const part = (type: string, body: string) =>
    `--${b}\nContent-Type: ${type}; charset="us-ascii"\nMIME-Version: 1.0\n\n${body.trimEnd()}\n`;
  return `Content-Type: multipart/mixed; boundary="${b}"\nMIME-Version: 1.0\n\n${part('text/cloud-boothook', boothook)}${part('text/cloud-config', product)}--${b}--\n`;
}

const ec2 = () => new EC2Client({ region: REGION });
const gcpOptions = () => ({
  projectId: process.env.GCP_PROJECT_ID!,
  credentials: {
    client_email: process.env.GCP_CLIENT_EMAIL!,
    private_key: process.env.GCP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  },
});

/** Ubuntu 24.04 minimal, as aws.ts resolves it for a CPU VM Job host. */
async function minimalImage() {
  const { Images = [] } = await ec2().send(
    new DescribeImagesCommand({
      Owners: ['099720109477'],
      Filters: [
        {
          Name: 'name',
          Values: [
            'ubuntu-minimal/images/hvm-ssd*/ubuntu-noble-24.04-amd64-minimal-*',
          ],
        },
        { Name: 'state', Values: ['available'] },
        { Name: 'architecture', Values: ['x86_64'] },
      ],
    }),
  );
  const exact =
    /ubuntu-minimal\/images\/hvm-ssd(-gp3)?\/ubuntu-noble-24\.04-amd64-minimal-[0-9]{8}(\.[0-9]+)?$/;
  const image = Images.filter((i) => exact.test(i.Name ?? '')).sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
  )[0]!;
  return { id: image.ImageId!, root: image.RootDeviceName!, name: image.Name };
}

async function launch(
  job: Job,
  image: { id: string; root: string },
  data: string,
): Promise<void> {
  const tags = [
    { Key: TAG.key, Value: TAG.value },
    { Key: 'Name', Value: `${name}-${job.id}` },
  ];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const zone of ZONES) {
      const at = Date.now();
      try {
        const { Instances = [] } = await ec2().send(
          new RunInstancesCommand({
            ImageId: image.id,
            InstanceType: VM_TYPE as _InstanceType,
            Placement: { AvailabilityZone: zone },
            NetworkInterfaces: [
              { DeviceIndex: 0, AssociatePublicIpAddress: true },
            ],
            InstanceMarketOptions: {
              MarketType: 'spot',
              SpotOptions: {
                SpotInstanceType: 'one-time',
                InstanceInterruptionBehavior: 'terminate',
              },
            },
            // aws.ts bootDiskFor: the Job's own IOPS and MiB/s.
            BlockDeviceMappings: [
              {
                DeviceName: image.root,
                Ebs: {
                  VolumeSize: DISK_GB,
                  VolumeType: 'gp3',
                  ...gp3VolumePerformance(undefined, ARMS[job.arm]),
                  DeleteOnTermination: true,
                },
              },
            ],
            MinCount: 1,
            MaxCount: 1,
            // Gzipped, which cloud-init reads, to stay inside AWS's 16 KB.
            UserData: gzipSync(data).toString('base64'),
            InstanceInitiatedShutdownBehavior: 'terminate',
            TagSpecifications: [
              { ResourceType: 'instance', Tags: tags },
              { ResourceType: 'volume', Tags: tags },
            ],
          }),
        );
        job.launchAt = at;
        job.zone = zone;
        job.instanceId = Instances[0]!.InstanceId!;
        job.attempts.push({ zone, at });
        return;
      } catch (error) {
        job.attempts.push({ zone, at, error: String(error).slice(0, 400) });
      }
    }
    await delay(30_000);
  }
  throw new Error(`no zone launched ${job.id}`);
}

// ---------------------------------------------------------------- analysis

/** One VM's seconds; marks are epoch seconds from the guest. */
function metrics(job: Job, dir: string) {
  const marks: Record<string, number> = {};
  for (const line of readFileSync(join(dir, 'marks.txt'), 'utf8').split('\n')) {
    const [key, value] = line.split(' ');
    if (key && value && Number.isFinite(Number(value)))
      marks[key] = Number(value);
  }
  const results = readFileSync(join(dir, 'results.txt'), 'utf8');
  const since = (a?: number, b?: number) =>
    a !== undefined && b !== undefined ? +(a - b).toFixed(2) : undefined;
  const launch = job.launchAt! / 1000;
  return {
    launchToBoot: since(marks.btime, launch),
    bootToDocker: since(marks.docker_ready, marks.btime),
    pull: since(marks.pull_end, marks.pull_start),
    bootToReady: since(marks.runner_started, marks.btime),
    launchToReady: since(marks.runner_started, launch),
    runnerRun: since(marks.runner_started, marks.runner_run),
    nodePull: since(marks.node_pulled, marks.node_pull),
    npmCi: since(marks.npm_done, marks.npm_start),
    ok: /^OK /m.test(results),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Median (min–max) per arm and metric. */
function summarize(rows: { arm: Arm; values: Record<string, unknown> }[]) {
  return Object.fromEntries(
    (Object.keys(ARMS) as Arm[]).map((arm) => {
      const mine = rows.filter((r) => r.arm === arm);
      const keys = Object.keys(mine[0]?.values ?? {}).filter((k) => k !== 'ok');
      return [
        arm,
        Object.fromEntries(
          keys.map((k) => {
            const xs = mine
              .map((r) => r.values[k])
              .filter((v): v is number => typeof v === 'number');
            return [
              k,
              xs.length
                ? {
                    n: xs.length,
                    median: +median(xs).toFixed(2),
                    min: Math.min(...xs),
                    max: Math.max(...xs),
                  }
                : null,
            ];
          }),
        ),
      ];
    }),
  );
}

// ---------------------------------------------------------------- run

async function run(): Promise<void> {
  const bucket = new Storage(gcpOptions()).bucket(name);
  await bucket.create({
    location: 'US-EAST4',
    labels: { [TAG.key]: TAG.value },
  });
  // express v5.1.0 with one lockfile for every VM.
  const work = join(output, 'express');
  mkdirSync(work, { recursive: true });
  execFileSync(
    'bash',
    [
      '-c',
      `curl -fsSL ${EXPRESS_URL} | tar xz --strip-components=1 -C "$0" && cd "$0" && rm .npmrc && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null`,
      work,
    ],
    { stdio: 'inherit' },
  );
  const tarball = execFileSync('tar', [
    'czf',
    '-',
    '-C',
    work,
    '--exclude=node_modules',
    '.',
  ]);
  await bucket
    .file('express.tgz')
    .save(tarball, { contentType: 'application/gzip' });
  const expires = Date.now() + 2 * 60 * 60_000;
  const [expressUrl] = await bucket
    .file('express.tgz')
    .getSignedUrl({ version: 'v4', action: 'read', expires });

  const image = await minimalImage();
  // Interleaved: each round runs every arm, in a rotated order.
  const arms = Object.keys(ARMS) as Arm[];
  const jobs: Job[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[(i + round) % arms.length]!;
      jobs.push({ id: `${arm}-r${round}`, arm, round, attempts: [] });
    }
  }
  save('plan.json', {
    runId,
    name,
    image: IMAGE,
    ami: image,
    vmType: VM_TYPE,
    arms: Object.fromEntries(
      arms.map((arm) => [arm, gp3VolumePerformance(undefined, ARMS[arm])]),
    ),
    jobs: jobs.map((j) => j.id),
  });

  const evidence = (job: Job) => bucket.file(`evidence/${job.id}.tgz`);
  const deadline = Date.now() + 80 * 60_000;
  const runJob = async (job: Job) => {
    try {
      const [url] = await evidence(job).getSignedUrl({
        version: 'v4',
        action: 'write',
        contentType: 'application/gzip',
        expires,
      });
      const data = userData(job, url, expressUrl);
      if (gzipSync(data).length > 16_384) {
        throw new Error("gzipped user data exceeds AWS's 16 KB");
      }
      await launch(job, image, data);
      const until = Math.min(
        deadline,
        Date.now() + (GUEST_DEADLINE_MIN + 5) * 60_000,
      );
      while (Date.now() < until && !job.done) {
        await delay(15_000);
        if (!(await evidence(job).exists())[0]) continue;
        const dir = join(output, job.id);
        mkdirSync(dir, { recursive: true });
        await evidence(job).download({ destination: `${dir}.tgz` });
        execFileSync('tar', ['xzf', `${dir}.tgz`, '-C', dir]);
        job.done = true;
      }
      if (!job.done) job.error = 'no evidence before the deadline';
    } catch (error) {
      job.error = String(error).slice(0, 1000);
    } finally {
      // The guest terminates itself; this covers one that didn't.
      if (job.instanceId) {
        await ec2()
          .send(
            new TerminateInstancesCommand({ InstanceIds: [job.instanceId] }),
          )
          .catch((error) => {
            job.error = `${job.error ?? ''} terminate: ${String(error).slice(0, 300)}`;
          });
      }
      save('jobs.json', jobs);
    }
  };
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (Date.now() > deadline - 20 * 60_000) {
          job.error = 'not started: too close to the deadline';
          continue;
        }
        await runJob(job);
      }
    }),
  );

  const rows = jobs
    .filter((j) => j.done)
    .map((job) => ({
      arm: job.arm,
      job: job.id,
      zone: job.zone,
      instanceId: job.instanceId,
      values: metrics(job, join(output, job.id)),
    }));
  const { SpotPriceHistory = [] } = await ec2().send(
    new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [VM_TYPE as _InstanceType],
      ProductDescriptions: ['Linux/UNIX'],
      StartTime: new Date(),
    }),
  );
  const summary = {
    runId,
    sourceSha: process.env.SPIKE_SOURCE_SHA ?? null,
    spotPrice: Object.fromEntries(
      SpotPriceHistory.map((p) => [p.AvailabilityZone, Number(p.SpotPrice)]),
    ),
    errors: jobs
      .filter((j) => j.error)
      .map((j) => ({ job: j.id, error: j.error })),
    launchRefusals: jobs.flatMap((j) =>
      j.attempts.filter((a) => a.error).map((a) => ({ job: j.id, ...a })),
    ),
    summary: summarize(rows),
    rows,
  };
  save('summary.json', summary);
  console.log(JSON.stringify(summary, null, 2));
  if (rows.some((r) => !r.values.ok) || summary.errors.length) {
    throw new Error('a VM failed a step or left no evidence; see summary.json');
  }
}

// ---------------------------------------------------------------- cleanup

/** Remove every tagged instance, volume and bucket, and verify none remain. */
async function cleanup(): Promise<void> {
  const client = ec2();
  const storage = new Storage(gcpOptions());
  const tagged = [{ Name: `tag:${TAG.key}`, Values: [TAG.value] }];
  const owned = {
    instances: async () => {
      const { Reservations = [] } = await client.send(
        new DescribeInstancesCommand({
          Filters: [
            ...tagged,
            {
              Name: 'instance-state-name',
              Values: [
                'pending',
                'running',
                'stopping',
                'stopped',
                'shutting-down',
              ],
            },
          ],
        }),
      );
      return Reservations.flatMap((r) => r.Instances ?? []).map(
        (i) => i.InstanceId!,
      );
    },
    volumes: async () => {
      const { Volumes = [] } = await client.send(
        new DescribeVolumesCommand({ Filters: tagged }),
      );
      return Volumes.map((v) => `${v.VolumeId} ${v.State}`);
    },
    buckets: async () => {
      const [buckets] = await storage.getBuckets({ prefix: 'ac-spike-disk-' });
      return buckets
        .filter((b) => b.metadata.labels?.[TAG.key] === TAG.value)
        .map((b) => b.name);
    },
  };
  const list = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(owned).map(async ([key, get]) => [key, await get()]),
      ),
    ) as Record<keyof typeof owned, string[]>;
  const removed = await list();
  if (removed.instances.length) {
    await client.send(
      new TerminateInstancesCommand({ InstanceIds: removed.instances }),
    );
  }
  for (const bucket of removed.buckets) {
    await storage.bucket(bucket).deleteFiles({ force: true });
    await storage.bucket(bucket).delete();
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = await list();
    if (Object.values(remaining).every((ids) => ids.length === 0)) {
      save('cleanup.json', { removed, remaining });
      console.log(JSON.stringify({ removed, remaining }, null, 2));
      return;
    }
    await delay(15_000);
  }
  save('cleanup.json', { removed, remaining: await list() });
  throw new Error('tagged spike resources remain after cleanup');
}

/** Print one VM's user data and its gzipped size, without touching a cloud. */
function render(): void {
  const job: Job = { id: 'today-r1', arm: 'today', round: 1, attempts: [] };
  const data = userData(job, 'https://evidence', 'https://express');
  console.log(data);
  console.error(`${gzipSync(data).length} bytes gzipped`);
}

const phase = process.argv[2] ?? process.env.SPIKE_PHASE ?? 'run';
if (phase === 'render') render();
else await (phase === 'cleanup' ? cleanup() : run());
