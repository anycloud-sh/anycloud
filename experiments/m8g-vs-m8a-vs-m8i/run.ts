#!/usr/bin/env tsx
/**
 * Graviton m8g against m8a and m8i at equal vCPUs: backmesh's five benchmark
 * builds and spot capacity; see README.md. anycloud's VM Jobs launch only
 * amd64 images, so every arm launches here through the EC2 API, alike.
 *
 * `run [--rounds=10] [--parallel=2]` runs the builds in us-east-2. `spot`
 * records placement scores and per-zone spot launches in three regions.
 * `cleanup` deletes everything tagged for the experiment and verifies it.
 * `report <results.json...>` rewrites the build report without a cloud.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  EC2Client,
  GetSpotPlacementScoresCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { Storage } from '@google-cloud/storage';

const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const TAG = { Key: 'anycloud-spike', Value: 'm8g-vs-m8a-vs-m8i' };
const BUILD_REGION = 'us-east-2';
const SPOT_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
// A guest that hasn't uploaded by then has failed; it halts, which
// terminates it, at that deadline regardless.
const GUEST_DEADLINE_MIN = 35;
const COST_CAP_USD = 8;

const ARMS = [
  'm8g.xlarge',
  'm8a.xlarge',
  'm8i.xlarge',
  'm8g.4xlarge',
  'm8a.4xlarge',
  'm8i.4xlarge',
] as const;
type Arm = (typeof ARMS)[number];
const arch = (arm: string) => (arm.startsWith('m8g') ? 'arm64' : 'amd64');
const PAIRS: [Arm, Arm][] = [
  ['m8g.xlarge', 'm8i.xlarge'],
  ['m8g.xlarge', 'm8a.xlarge'],
  ['m8g.4xlarge', 'm8i.4xlarge'],
  ['m8g.4xlarge', 'm8a.4xlarge'],
];

interface JobResult {
  id: string;
  arm: Arm;
  round: number;
  ok: boolean;
  zone: string;
  uptimeSeconds: number | null;
  timings: Record<string, number>;
  sysbench: Record<string, number>;
  lscpu: Record<string, string>;
  failedBuilds: string[];
  failure?: string;
}

function evidence(name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

const gcs = () =>
  new Storage({
    projectId: process.env.GCP_PROJECT_ID!,
    credentials: {
      client_email: process.env.GCP_CLIENT_EMAIL!,
      private_key: process.env.GCP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    },
  });

/** The catalog's on-demand and spot list prices, $/h, by type and region. */
async function prices() {
  const csv = await (
    await fetch(
      'https://raw.githubusercontent.com/anycloud-sh/catalog/main/aws/vms.csv',
    )
  ).text();
  const out: Record<string, { onDemand: number; spot: number[] }> = {};
  for (const line of csv.split('\n').slice(1)) {
    const [type, , , , , , price, spot, region] = line.split(',');
    if (!ARMS.includes(type as Arm)) continue;
    const key = `${type} ${region}`;
    out[key] ??= { onDemand: Number(price), spot: [] };
    out[key].spot.push(Number(spot));
  }
  return out;
}

/** Canonical's newest Ubuntu 24.04 server image for the arch. */
async function ubuntu(ec2: EC2Client, imageArch: 'amd64' | 'arm64') {
  const { Images = [] } = await ec2.send(
    new DescribeImagesCommand({
      Owners: ['099720109477'],
      Filters: [
        {
          Name: 'name',
          Values: [
            `ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${imageArch}-server-*`,
          ],
        },
        { Name: 'state', Values: ['available'] },
      ],
    }),
  );
  const image = Images.sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
  )[0];
  if (!image?.ImageId) throw new Error(`No Ubuntu 24.04 ${imageArch} image`);
  return { id: image.ImageId, root: image.RootDeviceName! };
}

/** anycloud's shared Job network's subnets, by zone, in zone order. */
async function subnets(ec2: EC2Client) {
  const { Vpcs = [] } = await ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: 'tag:Name', Values: ['anycloud-jobs'] }],
    }),
  );
  const vpc = Vpcs[0]?.VpcId;
  if (!vpc) throw new Error('No anycloud-jobs network in this region');
  const { Subnets = [] } = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: 'vpc-id', Values: [vpc] }],
    }),
  );
  return Subnets.map((s) => ({
    zone: s.AvailabilityZone!,
    id: s.SubnetId!,
  })).sort((a, b) => a.zone.localeCompare(b.zone));
}

function launch(
  ec2: EC2Client,
  options: {
    arm: Arm;
    image: { id: string; root: string };
    subnet: string;
    name: string;
    spot?: boolean;
    userData?: string;
    diskGb: number;
  },
) {
  return ec2.send(
    new RunInstancesCommand({
      ImageId: options.image.id,
      InstanceType: options.arm as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: options.subnet,
          AssociatePublicIpAddress: true,
        },
      ],
      BlockDeviceMappings: [
        {
          DeviceName: options.image.root,
          Ebs: {
            VolumeSize: options.diskGb,
            VolumeType: 'gp3',
            DeleteOnTermination: true,
          },
        },
      ],
      InstanceInitiatedShutdownBehavior: 'terminate',
      ...(options.spot && {
        InstanceMarketOptions: {
          MarketType: 'spot',
          SpotOptions: { SpotInstanceType: 'one-time' },
        },
      }),
      ...(options.userData && {
        UserData: Buffer.from(options.userData).toString('base64'),
      }),
      TagSpecifications: (['instance', 'volume'] as const).map((type) => ({
        ResourceType: type,
        Tags: [TAG, { Key: 'Name', Value: options.name }],
      })),
    }),
  );
}

/** Installs Docker, runs m8a-vs-m8i's guest.sh, uploads its log and halts. */
function userData(uploadUrl: string) {
  const guest = readFileSync(
    join(import.meta.dirname, '..', 'm8a-vs-m8i', 'guest.sh'),
  ).toString('base64');
  return `#!/bin/bash
(sleep ${GUEST_DEADLINE_MIN * 60}; shutdown -h now) &
export DEBIAN_FRONTEND=noninteractive
{
  # cloud-init's own apt run can hold the lock for a while after boot.
  for _ in $(seq 30); do
    apt-get update -qq && apt-get install -y -qq docker.io >/dev/null && break
    sleep 10
  done
  echo ${guest} | base64 -d > /guest.sh
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \\
    -v /guest.sh:/guest.sh docker:27-cli sh /guest.sh
  echo "UPTIME $(cut -d' ' -f1 /proc/uptime)"
} > /bench.log 2>&1
curl -sf -X PUT -H 'Content-Type: text/plain' --upload-file /bench.log '${uploadUrl}'
shutdown -h now
`;
}

function parseLog(log: string) {
  const timings: Record<string, number> = {};
  const sysbench: Record<string, number> = {};
  const lscpu: Record<string, string> = {};
  const failedBuilds: string[] = [];
  let uptime: number | null = null;
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    const bench = /^BENCH (\S+) (\S+) (\d+)$/.exec(line);
    if (bench) timings[`${bench[1]} ${bench[2]}`] = Number(bench[3]) / 1000;
    const sys = /^SYSBENCH (\d+) ([\d.]+)$/.exec(line);
    if (sys) sysbench[sys[1] === '1' ? 'single' : 'all'] = Number(sys[2]);
    const cpu = /^LSCPU ([^:]+):\s*(.*)$/.exec(line);
    if (cpu) lscpu[cpu[1]!] = cpu[2]!;
    const failed = /^BENCH_FAIL (\S+)/.exec(line);
    if (failed) failedBuilds.push(failed[1]!);
    const up = /^UPTIME ([\d.]+)$/.exec(line);
    if (up) uptime = Number(up[1]);
  }
  return {
    timings,
    sysbench,
    lscpu,
    uptime,
    failedBuilds,
    done: log.includes('BENCH_DONE'),
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

async function run(rounds: number, parallel: number) {
  const runId = randomBytes(3).toString('hex');
  const ec2 = new EC2Client({ region: BUILD_REGION });
  const images = {
    amd64: await ubuntu(ec2, 'amd64'),
    arm64: await ubuntu(ec2, 'arm64'),
  };
  // Each VM goes to the first zone of anycloud's Job network that takes it.
  const zones = await subnets(ec2);
  const price = await prices();
  const bucket = gcs().bucket(`m8g-builds-${runId}`);
  await bucket.create({
    location: 'US-EAST4',
    labels: { 'anycloud-spike': TAG.Value },
  });
  const results: JobResult[] = [];
  const cost = (r: JobResult) =>
    ((r.uptimeSeconds ?? GUEST_DEADLINE_MIN * 60) / 3600) *
    price[`${r.arm} ${BUILD_REGION}`]!.onDemand;
  const save = () => {
    evidence('results.json', { region: BUILD_REGION, price, results });
    evidence('report.md', report(results, price));
  };

  const job = async (arm: Arm, round: number): Promise<JobResult> => {
    const id = `${runId}-r${round}-${arm}`;
    const file = bucket.file(`${id}.log`);
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      contentType: 'text/plain',
      expires: Date.now() + (GUEST_DEADLINE_MIN + 15) * 60_000,
    });
    let zone = '';
    const refusals: string[] = [];
    for (const subnet of zones) {
      try {
        await launch(ec2, {
          arm,
          image: images[arch(arm)],
          subnet: subnet.id,
          name: `m8g-builds-${id}`,
          userData: userData(url),
          diskGb: 100,
        });
        zone = subnet.zone;
        break;
      } catch (error) {
        refusals.push(`${subnet.zone}: ${(error as Error).name}`);
      }
    }
    if (!zone)
      throw new Error(`${id} launched nowhere: ${refusals.join(', ')}`);
    console.log(`round ${round}: ${arm} in ${zone}`);
    const deadline = Date.now() + (GUEST_DEADLINE_MIN + 5) * 60_000;
    while (Date.now() < deadline && !(await file.exists())[0]) {
      await sleep(15_000);
    }
    const log = (await file.exists())[0]
      ? (await file.download())[0].toString()
      : 'no log uploaded';
    writeFileSync(join(output, `${id}.log`), log);
    const parsed = parseLog(log);
    return {
      id,
      arm,
      round,
      ok: parsed.done,
      zone,
      uptimeSeconds: parsed.uptime,
      timings: parsed.timings,
      sysbench: parsed.sysbench,
      lscpu: parsed.lscpu,
      failedBuilds: parsed.failedBuilds,
      ...(parsed.done
        ? {}
        : { failure: log.split('\n').slice(-40).join('\n') }),
    };
  };

  // Each round starts one VM per arm at once, in a random order.
  let next = 1;
  const worker = async () => {
    while (next <= rounds) {
      const spent = results.reduce((sum, r) => sum + cost(r), 0);
      if (spent >= COST_CAP_USD) {
        console.warn(`Cost cap: $${spent.toFixed(2)} spent; no more rounds`);
        return;
      }
      const round = next++;
      const settled = await Promise.allSettled(
        shuffle(ARMS).map((arm) => job(arm, round)),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') results.push(outcome.value);
        else console.error(`round ${round}: ${String(outcome.reason)}`);
      }
      save();
    }
  };
  mkdirSync(output, { recursive: true });
  await Promise.all(Array.from({ length: parallel }, worker));
  await cleanup();
  console.log(report(results, price));
  const failed = results.filter((r) => !r.ok);
  if (failed.length || results.length < rounds * ARMS.length) {
    throw new Error(
      `${failed.length} VMs failed; ${results.length} of ${rounds * ARMS.length} reported`,
    );
  }
}

/**
 * Spot capacity, not launch strategy: EC2's placement scores for one instance
 * of each arm by region and zone, then one spot launch of each arm in every
 * zone of anycloud's Job network, each terminated as soon as EC2 accepts it.
 */
async function spot() {
  const scores: Record<string, string[]> = {};
  const scorer = new EC2Client({ region: 'us-east-1' });
  for (const arm of ARMS) {
    for (const single of [false, true]) {
      const { SpotPlacementScores = [] } = await scorer.send(
        new GetSpotPlacementScoresCommand({
          InstanceTypes: [arm],
          TargetCapacity: 1,
          SingleAvailabilityZone: single,
          RegionNames: SPOT_REGIONS,
        }),
      );
      scores[`${arm} ${single ? 'zones' : 'regions'}`] =
        SpotPlacementScores.map(
          (s) => `${s.AvailabilityZoneId ?? s.Region} ${s.Score}`,
        ).sort();
    }
  }
  evidence('spot-scores.json', scores);

  const runId = randomBytes(3).toString('hex');
  const attempts = (
    await Promise.all(
      SPOT_REGIONS.map(async (region) => {
        const ec2 = new EC2Client({ region });
        const images = {
          amd64: await ubuntu(ec2, 'amd64'),
          arm64: await ubuntu(ec2, 'arm64'),
        };
        const out: { arm: Arm; zone: string; result: string }[] = [];
        // One at a time per region, 2 s apart, under RunInstances' rate limit.
        for (const subnet of await subnets(ec2)) {
          for (const arm of ARMS) {
            let result: string;
            try {
              const { Instances = [] } = await launch(ec2, {
                arm,
                image: images[arch(arm)],
                subnet: subnet.id,
                name: `m8g-spot-${runId}`,
                spot: true,
                diskGb: 8,
              });
              await ec2.send(
                new TerminateInstancesCommand({
                  InstanceIds: Instances.map((i) => i.InstanceId!),
                }),
              );
              result = 'launched';
            } catch (error) {
              result = (error as Error).name;
            }
            out.push({ arm, zone: subnet.zone, result });
            await sleep(2_000);
          }
        }
        return out;
      }),
    )
  ).flat();
  evidence('spot-launches.json', attempts);
  const summary = spotSummary(scores, attempts);
  evidence('spot.md', summary);
  console.log(summary);
  await cleanup();
}

function spotSummary(
  scores: Record<string, string[]>,
  attempts: { arm: Arm; zone: string; result: string }[],
) {
  const lines = [
    '| Arm | Region | Zones launched | Refusals | Region score | Zone scores |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const arm of ARMS) {
    for (const region of SPOT_REGIONS) {
      const tried = attempts.filter(
        (a) => a.arm === arm && a.zone.startsWith(region),
      );
      const refused = tried.filter((a) => a.result !== 'launched');
      const regionScore = scores[`${arm} regions`]!.find((s) =>
        s.startsWith(`${region} `),
      )?.split(' ')[1];
      const prefix = {
        'us-east-1': 'use1',
        'us-east-2': 'use2',
        'us-west-2': 'usw2',
      }[region]!;
      const zoneScores = scores[`${arm} zones`]!.filter((s) =>
        s.startsWith(prefix),
      )
        .map((s) => s.split(' ')[1])
        .join(' ');
      lines.push(
        `| ${arm} | ${region} | ${tried.length - refused.length} of ${tried.length} | ${refused.map((a) => `${a.zone.slice(-1)} ${a.result}`).join(', ')} | ${regionScore ?? '?'} | ${zoneScores} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Terminates every tagged instance, deletes the buckets, and verifies. */
async function cleanup() {
  const left: Record<string, string[]> = {};
  for (const region of SPOT_REGIONS) {
    const ec2 = new EC2Client({ region });
    const live = async () =>
      (
        await ec2.send(
          new DescribeInstancesCommand({
            Filters: [
              { Name: `tag:${TAG.Key}`, Values: [TAG.Value] },
              {
                Name: 'instance-state-name',
                Values: ['pending', 'running', 'stopping', 'stopped'],
              },
            ],
          }),
        )
      ).Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
    const instances = (await live()).map((i) => i.InstanceId!);
    if (instances.length) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: instances }));
    }
    // Volumes go with their instance's termination.
    const deadline = Date.now() + 10 * 60_000;
    let volumes: string[] = [];
    for (;;) {
      const { Volumes = [] } = await ec2.send(
        new DescribeVolumesCommand({
          Filters: [{ Name: `tag:${TAG.Key}`, Values: [TAG.Value] }],
        }),
      );
      volumes = Volumes.map((v) => v.VolumeId!);
      if (!volumes.length || Date.now() > deadline) break;
      await sleep(15_000);
    }
    left[region] = [...(await live()).map((i) => i.InstanceId!), ...volumes];
  }
  const storage = gcs();
  const [buckets] = await storage.getBuckets({ prefix: 'm8g-builds-' });
  for (const bucket of buckets) {
    await bucket.deleteFiles({ force: true });
    await bucket.delete();
  }
  const [remaining] = await storage.getBuckets({ prefix: 'm8g-builds-' });
  left.buckets = remaining.map((b) => b.name);
  evidence('cleanup.json', left);
  if (Object.values(left).some((ids) => ids.length)) {
    throw new Error(`Resources remain: ${JSON.stringify(left)}`);
  }
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
  const [n1, n2] = [a.length, b.length];
  const n = n1 + n2;
  const r1 = all.reduce((sum, x, i) => (x.g === 0 ? sum + ranks[i]! : sum), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - (n1 * n2) / 2) - 0.5) / sigma;
  // Abramowitz and Stegun 26.2.17.
  const t = 1 / (1 + 0.2316419 * z);
  const tail =
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * tail);
}

function report(
  results: JobResult[],
  price: Record<string, { onDemand: number; spot: number[] }>,
): string {
  const ok = results.filter((r) => r.ok);
  const of = (arm: Arm) => ok.filter((r) => r.arm === arm);
  const fmt = (x: number) => x.toFixed(1);
  const metrics = [
    ...new Set(ok.flatMap((r) => Object.keys(r.timings))),
  ].sort();
  const lines: string[] = [];
  for (const [g, other] of PAIRS) {
    const [rg, ro] = [of(g), of(other)];
    lines.push(
      `### ${g} vs ${other} (n = ${rg.length} and ${ro.length})`,
      '',
      `Seconds; the ratio is ${g}'s median over ${other}'s, below 1 is ${g} faster.`,
      '',
      `| Build command | ${g} median (range) | ${other} median (range) | Ratio | Mann-Whitney p |`,
      '| --- | --- | --- | --- | --- |',
    );
    const row = (name: string, xg: number[], xo: number[], range = true) => {
      if (!xg.length || !xo.length) {
        lines.push(
          `| ${name} | ${xg.length ? fmt(median(xg)) : 'none'} | ${xo.length ? fmt(median(xo)) : 'none'} | | |`,
        );
        return;
      }
      const cell = (xs: number[]) =>
        range
          ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})`
          : fmt(median(xs));
      lines.push(
        `| ${name} | ${cell(xg)} | ${cell(xo)} | ${(median(xg) / median(xo)).toFixed(2)} | ${mannWhitney(xg, xo).toPrecision(2)} |`,
      );
    };
    for (const metric of metrics) {
      row(
        metric,
        rg.flatMap((r) => r.timings[metric] ?? []),
        ro.flatMap((r) => r.timings[metric] ?? []),
      );
    }
    for (const kind of ['single', 'all'] as const) {
      row(
        `sysbench cpu, ${kind === 'single' ? '1 thread' : 'all threads'} (events/s, higher is faster)`,
        rg.flatMap((r) => r.sysbench[kind] ?? []),
        ro.flatMap((r) => r.sysbench[kind] ?? []),
        false,
      );
    }
    lines.push('');
  }
  lines.push(
    '### Cost per VM',
    '',
    "The median of each VM's uptime (boot to upload) times the catalog's us-east-2 list price; spot is the median of its zones' spot prices.",
    '',
    '| Arm | Uptime | On-demand $/h | Cost on demand | Spot $/h | Cost on spot |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const arm of ARMS) {
    const up = of(arm).flatMap((r) => r.uptimeSeconds ?? []);
    const p = price[`${arm} ${BUILD_REGION}`];
    if (!up.length || !p) continue;
    const spotPrice = median(p.spot);
    const hours = median(up) / 3600;
    lines.push(
      `| ${arm} | ${fmt(median(up))} s | ${p.onDemand} | $${(hours * p.onDemand).toFixed(4)} | ${spotPrice} | $${(hours * spotPrice).toFixed(4)} |`,
    );
  }
  lines.push('', '### CPUs', '');
  for (const arm of ARMS) {
    const cpu = of(arm)[0]?.lscpu ?? {};
    lines.push(
      `- ${arm}: ${cpu['Model name'] ?? '?'} (${cpu['Architecture'] ?? '?'}); ${cpu['CPU(s)'] ?? '?'} vCPUs, ${cpu['Thread(s) per core'] ?? '?'} threads per core; zones ${[...new Set(of(arm).map((r) => r.zone))].join(', ')}`,
    );
  }
  lines.push(
    '',
    `${results.length} VMs, ${results.length - ok.length} failed.`,
  );
  for (const arm of ARMS) {
    const failed = of(arm).flatMap((r) => r.failedBuilds);
    if (failed.length) {
      lines.push(`- ${arm}: builds that failed: ${failed.join(', ')}`);
    }
  }
  for (const r of results.filter((x) => !x.ok)) {
    lines.push('', `${r.id} failed:`, '', '```', r.failure ?? '', '```');
  }
  return `${lines.join('\n')}\n`;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'run') {
  await run(Number(flag('rounds', '10')), Number(flag('parallel', '2')));
} else if (command === 'spot') {
  await spot();
} else if (command === 'cleanup') {
  await cleanup();
} else if (command === 'report') {
  const saved = rest.map(
    (path) =>
      JSON.parse(readFileSync(path, 'utf8')) as {
        price: Record<string, { onDemand: number; spot: number[] }>;
        results: JobResult[];
      },
  );
  console.log(
    report(
      saved.flatMap((s) => s.results),
      saved[0]!.price,
    ),
  );
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
