#!/usr/bin/env tsx
/**
 * Where a refused spot zone's time goes, and which launch strategy lands a VM
 * on m8a when it has capacity without that cost; see README.md.
 *
 * `run [--rounds=20] [--workers=2] [--minutes=70]` starts the branch's API,
 * then runs rounds of one trial per arm and size, the arms in random order.
 * `cleanup` terminates the run's Jobs, instances, fleets and launch templates
 * and checks AWS for anything left. `report <trials.json...>` rewrites the
 * report from saved trials, without a cloud.
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
  CreateFleetCommand,
  type CreateFleetCommandInput,
  CreateLaunchTemplateCommand,
  DeleteFleetsCommand,
  DeleteLaunchTemplateCommand,
  DescribeAvailabilityZonesCommand,
  DescribeFleetsCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeLaunchTemplatesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  EC2Client,
  GetSpotPlacementScoresCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { writeLocalApiToken } from '../../test/integration/helpers/local-api-token.js';

const root = join(import.meta.dirname, '..', '..');
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'spot-launch');
const inventoryPath = join(state, 'inventory.json');
const PORT = 18_433;
const API_URL = `http://127.0.0.1:${PORT}`;
// Stops starting trials once the estimated cost reaches this.
const COST_CAP_USD = 7;
const TAG = 'spot-launch-spike';
// Preference order: backmesh's region first.
const REGIONS = ['us-east-2', 'us-east-1', 'us-west-2'];
const SIZES = ['xlarge', '4xlarge'] as const;
type Size = (typeof SIZES)[number];
const ARMS = [
  'anycloud', // (a) today's anycloud path
  'sequential', // (b) RunInstances per zone, fail fast
  'parallel', // (c) the top candidates at once, keep the best
  'fleet', // (d) EC2 Fleet instant, capacity-optimized-prioritized
  'scores', // (e) zones ordered by cached spot placement scores
  'od-run', // on-demand RunInstances, fail fast
  'od-fleet', // on-demand EC2 Fleet instant, prioritized
] as const;
type Arm = (typeof ARMS)[number];
/** EC2's refusals of one zone; any other error ends that candidate. */
const ZONE_REFUSALS = new Set([
  'InsufficientInstanceCapacity',
  'InsufficientSpotCapacity',
  'Unsupported',
  'SpotMaxPriceTooLow',
]);
// On-demand list prices (us-east-1/us-east-2/us-west-2 are equal), $/h.
const ON_DEMAND: Record<string, number> = {
  'm8a.xlarge': 0.27048,
  'm8i.xlarge': 0.21168,
  'm8a.4xlarge': 1.08192,
  'm8i.4xlarge': 0.84672,
};

interface Inventory {
  runId: string;
  jobs: string[];
}

interface Call {
  op: string;
  region: string;
  zone?: string;
  type?: string;
  ms: number;
  code?: string;
  http?: number;
  attempts?: number;
  retryDelayMs?: number;
}

interface Launched {
  id: string;
  region: string;
  zone: string;
  type: string;
  spot: boolean;
  at: number;
}

interface Trial {
  arm: Arm;
  size: Size;
  round: number;
  /** Request to EC2 accepting the kept VM, and to it running. */
  acceptedS: number | null;
  runningS: number | null;
  type: string | null;
  region: string | null;
  zone: string | null;
  /** VMs launched besides the kept one, and every launched VM's cost. */
  extra: number;
  extraCostUsd: number;
  costUsd: number;
  calls: Call[];
  failure?: string;
}

interface Region {
  name: string;
  fast: EC2Client;
  /** The gateway's client options: 10 attempts, the SDK's standard retry. */
  gateway: EC2Client;
  launchTemplateId: string;
  /** The Jobs VPC's subnets, by zone, that offer each type. */
  subnets: Map<string, { id: string; zone: string }[]>;
  zoneIds: Map<string, string>;
  spotPrice: Map<string, number>;
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
    throw new Error(
      `anycloud ${args[0]} failed (${String(error.code)}): ${(error.stderr || error.stdout || '').slice(-600)}`,
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

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const tags = (runId: string, type: 'instance' | 'volume' | 'fleet') => ({
  ResourceType: type,
  Tags: [{ Key: TAG, Value: runId }],
});

/**
 * The Jobs VPC anycloud made (warmed by a Job per region), its default
 * security group, a launch template, zone offerings and spot prices.
 */
async function setUpRegion(name: string, runId: string): Promise<Region> {
  const fast = new EC2Client({ region: name, maxAttempts: 1 });
  const gateway = new EC2Client({ region: name, maxAttempts: 10 });
  const read = new EC2Client({ region: name, maxAttempts: 5 });
  const shared = [
    { Name: 'tag:Name', Values: ['anycloud-jobs'] },
    { Name: 'tag:anycloud_managed', Values: ['shared'] },
  ];
  const vpcId = (await read.send(new DescribeVpcsCommand({ Filters: shared })))
    .Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error(`${name} has no anycloud Jobs VPC`);
  const vpc = [{ Name: 'vpc-id', Values: [vpcId] }];
  const { Subnets = [] } = await read.send(
    new DescribeSubnetsCommand({ Filters: vpc }),
  );
  const { SecurityGroups = [] } = await read.send(
    new DescribeSecurityGroupsCommand({
      Filters: [...vpc, { Name: 'group-name', Values: ['default'] }],
    }),
  );
  const { Images = [] } = await read.send(
    new DescribeImagesCommand({
      Owners: ['amazon'],
      Filters: [
        { Name: 'name', Values: ['al2023-ami-2023.*-kernel-6.1-x86_64'] },
        { Name: 'state', Values: ['available'] },
      ],
    }),
  );
  const image = Images.sort((a, b) =>
    b.CreationDate!.localeCompare(a.CreationDate!),
  )[0]!.ImageId!;
  const { LaunchTemplate } = await read.send(
    new CreateLaunchTemplateCommand({
      LaunchTemplateName: `${TAG}-${runId}`,
      TagSpecifications: [
        { ResourceType: 'launch-template', Tags: [{ Key: TAG, Value: runId }] },
      ],
      LaunchTemplateData: {
        ImageId: image,
        SecurityGroupIds: [SecurityGroups[0]!.GroupId!],
        InstanceInitiatedShutdownBehavior: 'terminate',
        TagSpecifications: [tags(runId, 'instance'), tags(runId, 'volume')],
      },
    }),
  );
  const types = SIZES.flatMap((size) => [`m8a.${size}`, `m8i.${size}`]);
  const { InstanceTypeOfferings = [] } = await read.send(
    new DescribeInstanceTypeOfferingsCommand({
      LocationType: 'availability-zone',
      Filters: [{ Name: 'instance-type', Values: types }],
    }),
  );
  const subnets = new Map(
    types.map((type) => [
      type,
      Subnets.filter((s) =>
        InstanceTypeOfferings.some(
          (o) => o.InstanceType === type && o.Location === s.AvailabilityZone,
        ),
      )
        .map((s) => ({ id: s.SubnetId!, zone: s.AvailabilityZone! }))
        .sort((a, b) => a.zone.localeCompare(b.zone)),
    ]),
  );
  const { AvailabilityZones = [] } = await read.send(
    new DescribeAvailabilityZonesCommand({}),
  );
  const { SpotPriceHistory = [] } = await read.send(
    new DescribeSpotPriceHistoryCommand({
      InstanceTypes: types as never[],
      ProductDescriptions: ['Linux/UNIX'],
      StartTime: new Date(),
    }),
  );
  return {
    name,
    fast,
    gateway,
    launchTemplateId: LaunchTemplate!.LaunchTemplateId!,
    subnets,
    zoneIds: new Map(AvailabilityZones.map((z) => [z.ZoneId!, z.ZoneName!])),
    spotPrice: new Map(
      SpotPriceHistory.map((p) => [
        `${p.InstanceType} ${p.AvailabilityZone}`,
        Number(p.SpotPrice),
      ]),
    ),
  };
}

const errorOf = (error: unknown) => {
  const e = error as {
    Code?: string;
    name?: string;
    $metadata?: {
      httpStatusCode?: number;
      attempts?: number;
      totalRetryDelay?: number;
    };
  };
  return {
    code: e.Code ?? e.name ?? 'Error',
    http: e.$metadata?.httpStatusCode,
    attempts: e.$metadata?.attempts,
    retryDelayMs: e.$metadata?.totalRetryDelay,
  };
};

/**
 * One RunInstances into one zone. The fast client makes one attempt, so a
 * throttle is retried here after a second, as its own call.
 */
async function runInstance(
  region: Region,
  type: string,
  subnet: { id: string; zone: string },
  spot: boolean,
  calls: Call[],
  client = region.fast,
): Promise<Launched | null> {
  for (let throttled = 0; ; throttled++) {
    const started = Date.now();
    const call: Call = {
      op: 'RunInstances',
      region: region.name,
      zone: subnet.zone,
      type,
      ms: 0,
    };
    calls.push(call);
    try {
      const { Instances, $metadata } = await client.send(
        new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateId: region.launchTemplateId },
          InstanceType: type as never,
          SubnetId: subnet.id,
          MinCount: 1,
          MaxCount: 1,
          ...(spot && {
            InstanceMarketOptions: {
              MarketType: 'spot',
              SpotOptions: {
                SpotInstanceType: 'one-time',
                InstanceInterruptionBehavior: 'terminate',
              },
            },
          }),
        }),
      );
      Object.assign(call, {
        ms: Date.now() - started,
        http: $metadata.httpStatusCode,
        attempts: $metadata.attempts,
      });
      return {
        id: Instances![0]!.InstanceId!,
        region: region.name,
        zone: subnet.zone,
        type,
        spot,
        at: Date.now(),
      };
    } catch (error) {
      Object.assign(call, { ms: Date.now() - started, ...errorOf(error) });
      if (call.code === 'RequestLimitExceeded' && throttled < 10) {
        await sleep(1_000);
        continue;
      }
      return null;
    }
  }
}

/** Tries each candidate's zones in turn; the first acceptance wins. */
async function sequential(
  candidates: { region: Region; type: string; zones?: string[] }[],
  spot: boolean,
  calls: Call[],
): Promise<Launched | null> {
  for (const { region, type, zones } of candidates) {
    for (const subnet of region.subnets.get(type) ?? []) {
      if (zones && !zones.includes(subnet.zone)) continue;
      const launched = await runInstance(region, type, subnet, spot, calls);
      if (launched) return launched;
      if (!ZONE_REFUSALS.has(calls.at(-1)!.code!)) break;
    }
  }
  return null;
}

/** One instant fleet per region in turn, m8a's overrides first. */
async function fleet(
  regions: Region[],
  types: string[],
  spot: boolean,
  runId: string,
  calls: Call[],
  fleets: { region: Region; id: string }[],
): Promise<Launched | null> {
  for (const region of regions) {
    const overrides = types.flatMap((type, priority) =>
      (region.subnets.get(type) ?? []).map((subnet) => ({
        InstanceType: type as never,
        SubnetId: subnet.id,
        Priority: priority,
      })),
    );
    const input: CreateFleetCommandInput = {
      Type: 'instant',
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: spot ? 'spot' : 'on-demand',
      },
      ...(spot
        ? {
            SpotOptions: {
              AllocationStrategy: 'capacity-optimized-prioritized',
              InstanceInterruptionBehavior: 'terminate',
            },
          }
        : { OnDemandOptions: { AllocationStrategy: 'prioritized' } }),
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateId: region.launchTemplateId,
            Version: '$Latest',
          },
          Overrides: overrides,
        },
      ],
      TagSpecifications: [tags(runId, 'fleet')],
    };
    const started = Date.now();
    const call: Call = { op: 'CreateFleet', region: region.name, ms: 0 };
    calls.push(call);
    try {
      const response = await region.fast.send(new CreateFleetCommand(input));
      call.ms = Date.now() - started;
      // Each refused override, as `<zone> <type> <code>`.
      const refusals = (response.Errors ?? []).map((e) => {
        const o = e.LaunchTemplateAndOverrides?.Overrides;
        return `${o?.AvailabilityZone ?? o?.SubnetId} ${o?.InstanceType} ${e.ErrorCode}`;
      });
      if (refusals.length) call.code = refusals.join('; ');
      fleets.push({ region, id: response.FleetId! });
      const instance = response.Instances?.[0];
      const id = instance?.InstanceIds?.[0];
      if (id) {
        const subnetId =
          instance.LaunchTemplateAndOverrides?.Overrides?.SubnetId;
        const type = instance.InstanceType!;
        return {
          id,
          region: region.name,
          zone:
            [...region.subnets.values()].flat().find((s) => s.id === subnetId)
              ?.zone ?? '?',
          type,
          spot,
          at: Date.now(),
        };
      }
    } catch (error) {
      Object.assign(call, { ms: Date.now() - started, ...errorOf(error) });
    }
  }
  return null;
}

interface ScoreCache {
  at: number;
  byZone: Map<string, number>;
}
const scoreCaches = new Map<Size, ScoreCache>();

/**
 * Each type's zones ranked by EC2's single-zone placement score (cached for
 * 10 min), best first, ties in preference order.
 */
async function byScore(
  regions: Region[],
  size: Size,
  calls: Call[],
): Promise<{ region: Region; type: string; zones: string[] }[]> {
  const types = [`m8a.${size}`, `m8i.${size}`];
  let cache = scoreCaches.get(size);
  if (!cache || Date.now() - cache.at > 10 * 60_000) {
    const byZone = new Map<string, number>();
    for (const type of types) {
      const started = Date.now();
      const { SpotPlacementScores = [] } = await regions[0]!.fast.send(
        new GetSpotPlacementScoresCommand({
          InstanceTypes: [type],
          TargetCapacity: 1,
          SingleAvailabilityZone: true,
          RegionNames: REGIONS,
        }),
      );
      calls.push({
        op: 'GetSpotPlacementScores',
        region: 'us-east-1',
        type,
        ms: Date.now() - started,
      });
      for (const s of SpotPlacementScores) {
        const region = regions.find((r) => r.name === s.Region)!;
        const zone = region.zoneIds.get(s.AvailabilityZoneId!);
        if (zone) byZone.set(`${type} ${zone}`, s.Score ?? 0);
      }
    }
    cache = { at: Date.now(), byZone };
    scoreCaches.set(size, cache);
  }
  const zones = types.flatMap((type, t) =>
    regions.flatMap((region, r) =>
      (region.subnets.get(type) ?? []).map((subnet) => ({
        region,
        type,
        zone: subnet.zone,
        score: cache.byZone.get(`${type} ${subnet.zone}`) ?? 0,
        preference: t * 100 + r,
      })),
    ),
  );
  zones.sort((a, b) => b.score - a.score || a.preference - b.preference);
  return zones.map(({ region, type, zone }) => ({
    region,
    type,
    zones: [zone],
  }));
}

/** Today's path: an anycloud spot Job allowed both types in all regions. */
async function anycloudTrial(
  inventory: Inventory,
  regions: Region[],
  size: Size,
  round: number,
  calls: Call[],
): Promise<{ launched: Launched | null; submitted: number; jobId: string }> {
  const jobId = `sl-${inventory.runId}-${size === 'xlarge' ? 1 : 4}-r${round}`;
  inventory.jobs.push(jobId);
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const submitted = Date.now();
  await cli([
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
      `SELECT w.state, v.availability_zone AS zone, v.region, v.vm_type FROM workloads w LEFT JOIN vms v ON v.workload_id = w.id AND v.availability_zone IS NOT NULL WHERE w.id = '${jobId}'`,
    );
    return r?.zone || ['failed', 'invalid'].includes(r?.state ?? '')
      ? r
      : undefined;
  }).catch(() => undefined);
  const acceptedAt = Date.now();
  calls.push({ op: 'anycloud job', region: '', ms: acceptedAt - submitted });
  if (!row?.zone || !row.region || !row.vm_type) {
    return { launched: null, submitted, jobId };
  }
  const region = regions.find((r) => r.name === row.region)!;
  const id = await until(`${jobId}'s instance`, 60_000, 1_000, async () => {
    const { Reservations = [] } = await region.fast.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: 'tag:anycloud_deployment', Values: [jobId] }],
      }),
    );
    return Reservations[0]?.Instances?.[0]?.InstanceId;
  }).catch(() => undefined);
  return {
    launched: id
      ? {
          id,
          region: region.name,
          zone: row.zone,
          type: row.vm_type,
          spot: true,
          at: acceptedAt,
        }
      : null,
    submitted,
    jobId,
  };
}

async function waitRunning(region: Region, id: string): Promise<number | null> {
  return until(`${id} to run`, 180_000, 1_000, async () => {
    const { Reservations = [] } = await region.fast
      .send(new DescribeInstancesCommand({ InstanceIds: [id] }))
      .catch(() => ({ Reservations: [] }));
    const state = Reservations[0]?.Instances?.[0]?.State?.Name;
    if (state === 'running') return Date.now();
    if (state && state !== 'pending') return null;
    return undefined;
  }).catch(() => null);
}

const priceOf = (regions: Region[], vm: Launched) =>
  vm.spot
    ? (regions
        .find((r) => r.name === vm.region)!
        .spotPrice.get(`${vm.type} ${vm.zone}`) ?? ON_DEMAND[vm.type]! / 2)
    : ON_DEMAND[vm.type]!;

/** EC2 bills Linux by the second, with a minute's minimum. */
const costOf = (regions: Region[], vm: Launched, ended: number) =>
  (priceOf(regions, vm) * Math.max(60, (ended - vm.at) / 1000)) / 3600;

async function terminate(regions: Region[], vms: Launched[]) {
  for (const vm of vms) {
    const region = regions.find((r) => r.name === vm.region)!;
    await region.fast
      .send(new TerminateInstancesCommand({ InstanceIds: [vm.id] }))
      .catch((error) => console.warn(`terminate ${vm.id}: ${String(error)}`));
  }
}

async function trial(
  inventory: Inventory,
  regions: Region[],
  arm: Arm,
  size: Size,
  round: number,
): Promise<Trial> {
  const types = [`m8a.${size}`, `m8i.${size}`];
  // m8a in every region before m8i in any.
  const preferred = types.flatMap((type) =>
    regions.map((region) => ({ region, type })),
  );
  const calls: Call[] = [];
  const extras: Launched[] = [];
  const fleets: { region: Region; id: string }[] = [];
  let started = Date.now();
  let kept: Launched | null = null;
  let jobId: string | undefined;
  let failure: string | undefined;
  try {
    if (arm === 'anycloud') {
      const result = await anycloudTrial(
        inventory,
        regions,
        size,
        round,
        calls,
      );
      ({ launched: kept, submitted: started, jobId } = result);
    } else if (arm === 'sequential' || arm === 'od-run') {
      kept = await sequential(preferred, arm === 'sequential', calls);
    } else if (arm === 'scores') {
      kept = await sequential(await byScore(regions, size, calls), true, calls);
    } else if (arm === 'fleet' || arm === 'od-fleet') {
      kept = await fleet(
        regions,
        types,
        arm === 'fleet',
        inventory.runId,
        calls,
        fleets,
      );
    } else {
      // m8a in every region and m8i in the first, at once; the most
      // preferred acceptance is kept, then the rest in order if none.
      const top = [
        ...preferred.slice(0, regions.length),
        preferred[regions.length]!,
      ];
      const launched = await Promise.all(
        top.map((candidate) => sequential([candidate], true, calls)),
      );
      kept = launched.find(Boolean) ?? null;
      extras.push(
        ...launched.filter((vm): vm is Launched => !!vm && vm !== kept),
      );
      kept ??= await sequential(preferred.slice(top.length), true, calls);
    }
  } catch (error) {
    failure = String(error);
  }
  const accepted = kept ? kept.at : null;
  await terminate(regions, extras);
  const ended = Date.now();
  const running = kept
    ? await waitRunning(regions.find((r) => r.name === kept.region)!, kept.id)
    : null;
  if (jobId) await cli(['terminate', jobId]).catch(() => undefined);
  else if (kept) await terminate(regions, [kept]);
  // An instant fleet can only be deleted with its instances.
  for (const { region, id } of fleets) {
    await region.fast
      .send(
        new DeleteFleetsCommand({ FleetIds: [id], TerminateInstances: true }),
      )
      .catch((error) => console.warn(`delete fleet ${id}: ${String(error)}`));
  }
  const extraCostUsd = extras.reduce(
    (sum, vm) => sum + costOf(regions, vm, ended),
    0,
  );
  return {
    arm,
    size,
    round,
    acceptedS: accepted ? (accepted - started) / 1000 : null,
    runningS: running ? (running - started) / 1000 : null,
    type: kept?.type ?? null,
    region: kept?.region ?? null,
    zone: kept?.zone ?? null,
    extra: extras.length,
    extraCostUsd,
    costUsd: extraCostUsd + (kept ? costOf(regions, kept, Date.now()) : 0),
    calls,
    ...(kept ? {} : { failure: failure ?? 'no VM' }),
  };
}

/**
 * The gateway's client against a zone that just refused: whether EC2 answers
 * a refusal with a 5xx the SDK retries, and how long those retries take.
 */
async function attribute(regions: Region[], trials: Trial[], probes: Call[]) {
  const refusal = trials
    .flatMap((t) => (t.arm === 'sequential' ? t.calls : []))
    .find((c) => c.code === 'InsufficientInstanceCapacity');
  if (!refusal) return;
  const region = regions.find((r) => r.name === refusal.region)!;
  const subnet = region.subnets
    .get(refusal.type!)!
    .find((s) => s.zone === refusal.zone)!;
  const calls: Call[] = [];
  const launched = await runInstance(
    region,
    refusal.type!,
    subnet,
    true,
    calls,
    region.gateway,
  );
  if (launched) await terminate(regions, [launched]);
  probes.push(
    ...calls.map((c) => ({ ...c, op: 'RunInstances (gateway client)' })),
  );
}

/** Records the inventory, starts the API with CI's AWS credentials, warms each region. */
async function setUp(): Promise<{ inventory: Inventory; regions: Region[] }> {
  mkdirSync(state, { recursive: true });
  mkdirSync(output, { recursive: true });
  const inventory: Inventory = {
    runId: randomBytes(3).toString('hex'),
    jobs: [],
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await startApi();
  await cli(['credentials', 'new', 'aws-spike', '--provider', 'aws'], {
    AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
  });
  // An on-demand Job per region makes the Jobs VPC if it's missing and warms
  // the API's caches, so the anycloud arm's first trial isn't a cold start.
  await Promise.all(
    REGIONS.map(async (region) => {
      const id = `sl-${inventory.runId}-warm-${region.replace(/^us-(\w)\w+-/, 'us$1')}`;
      inventory.jobs.push(id);
      writeFileSync(inventoryPath, JSON.stringify(inventory));
      await cli([
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
  const regions = await Promise.all(
    REGIONS.map((r) => setUpRegion(r, inventory.runId)),
  );
  return { inventory, regions };
}

async function run(rounds: number, workers: number, minutes: number) {
  const { inventory, regions } = await setUp();
  evidence(
    'setup.json',
    regions.map((r) => ({
      region: r.name,
      zones: Object.fromEntries(
        [...r.subnets].map(([t, s]) => [t, s.map((x) => x.zone)]),
      ),
      spotPrice: Object.fromEntries(r.spotPrice),
    })),
  );
  const trials: Trial[] = [];
  const probes: Call[] = [];
  const deadline = Date.now() + minutes * 60_000;
  const save = () => {
    evidence('trials.json', trials);
    evidence('attribution.json', probes);
    evidence('report.md', report(trials, probes));
  };
  // Workers per size share the round counter; each round runs every arm
  // once, in random order, so drift hits every arm alike.
  await Promise.all(
    SIZES.map(async (size) => {
      let next = 1;
      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (next <= rounds && Date.now() < deadline) {
            const round = next++;
            for (const arm of shuffle(ARMS)) {
              const spent = trials.reduce((sum, t) => sum + t.costUsd, 0);
              if (spent >= COST_CAP_USD) {
                console.warn(`Cost cap: ~$${spent.toFixed(2)} spent`);
                return;
              }
              const t = await trial(inventory, regions, arm, size, round);
              console.log(
                `${size} r${round} ${arm}: ${t.type ?? t.failure} ${t.acceptedS ?? '-'} s`,
              );
              trials.push(t);
            }
            if (round <= 8) {
              await attribute(
                regions,
                trials.filter((t) => t.size === size && t.round === round),
                probes,
              );
            }
            save();
          }
        }),
      );
    }),
  );
  save();
  await verifyClean(inventory);
  console.log(report(trials, probes));
}

/** Deletes everything tagged with the run, ends its Jobs, and checks AWS. */
async function verifyClean(inventory: Inventory) {
  if (inventory.jobs.length) {
    await cli(['terminate', ...inventory.jobs]).catch((e: unknown) =>
      console.warn(String(e)),
    );
    const list = inventory.jobs.map((id) => `'${id}'`).join(',');
    await until(
      'the API to clean up every Job',
      15 * 60_000,
      10_000,
      async () => {
        const [left] = await query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM workloads w WHERE w.id IN (${list}) AND (w.cleaned_at IS NULL OR EXISTS (SELECT 1 FROM vms v WHERE v.workload_id = w.id AND v.ended_at IS NULL))`,
        );
        return left?.n === 0 ? true : undefined;
      },
    );
  }
  const left: Record<string, string[]> = {
    instances: [],
    volumes: [],
    fleets: [],
    templates: [],
  };
  for (const region of REGIONS) {
    const ec2 = new EC2Client({ region, maxAttempts: 5 });
    const ours = { Name: `tag:${TAG}`, Values: [inventory.runId] };
    const jobs = {
      Name: 'tag:anycloud_deployment',
      Values: inventory.jobs.length ? inventory.jobs : ['-'],
    };
    const live = {
      Name: 'instance-state-name',
      Values: ['pending', 'running', 'stopping', 'stopped'],
    };
    const { Fleets = [] } = await ec2.send(new DescribeFleetsCommand({}));
    const fleets = Fleets.filter(
      (f) =>
        f.FleetState !== 'deleted' &&
        f.Tags?.some((t) => t.Key === TAG && t.Value === inventory.runId),
    ).map((f) => f.FleetId!);
    if (fleets.length)
      await ec2.send(
        new DeleteFleetsCommand({ FleetIds: fleets, TerminateInstances: true }),
      );
    const instances = async (filter: typeof ours) =>
      (
        (
          await ec2.send(
            new DescribeInstancesCommand({ Filters: [filter, live] }),
          )
        ).Reservations ?? []
      ).flatMap((r) => (r.Instances ?? []).map((i) => i.InstanceId!));
    const mine = await instances(ours);
    if (mine.length)
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: mine }));
    // Volumes go with their instances, so wait for those to end.
    await until(
      `${region}'s instances to end`,
      5 * 60_000,
      10_000,
      async () => {
        const { Reservations = [] } = await ec2.send(
          new DescribeInstancesCommand({
            Filters: [
              ours,
              { Name: 'instance-state-name', Values: ['shutting-down'] },
            ],
          }),
        );
        return Reservations.length ? undefined : true;
      },
    ).catch(() => undefined);
    const { LaunchTemplates = [] } = await ec2.send(
      new DescribeLaunchTemplatesCommand({ Filters: [ours] }),
    );
    for (const t of LaunchTemplates) {
      await ec2.send(
        new DeleteLaunchTemplateCommand({
          LaunchTemplateId: t.LaunchTemplateId,
        }),
      );
    }
    left.instances!.push(
      ...(await instances(ours)),
      ...(await instances(jobs)),
    );
    for (const filter of [ours, jobs]) {
      const { Volumes = [] } = await ec2.send(
        new DescribeVolumesCommand({ Filters: [filter] }),
      );
      left.volumes!.push(...Volumes.map((v) => v.VolumeId!));
    }
    const { Fleets: after = [] } = await ec2.send(
      new DescribeFleetsCommand({}),
    );
    left.fleets!.push(
      ...after
        .filter(
          (f) =>
            !['deleted', 'deleted_running', 'deleted_terminating'].includes(
              f.FleetState!,
            ) &&
            f.Tags?.some((t) => t.Key === TAG && t.Value === inventory.runId),
        )
        .map((f) => f.FleetId!),
    );
    const { LaunchTemplates: templates = [] } = await ec2.send(
      new DescribeLaunchTemplatesCommand({ Filters: [ours] }),
    );
    left.templates!.push(...templates.map((t) => t.LaunchTemplateId!));
  }
  evidence('cleanup.json', { jobs: inventory.jobs.length, left });
  if (Object.values(left).some((ids) => ids.length)) {
    throw new Error(`AWS resources remain: ${JSON.stringify(left)}`);
  }
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

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The anycloud arm's refusals from the API log: seconds since the previous one. */
function anycloudRefusals(log: string, trials: Trial[], runId: string) {
  const entries = log
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map(
      (line) =>
        JSON.parse(line) as {
          timestamp: string;
          message: string;
          vmId?: string;
          id?: string;
          zone?: string;
          code?: string;
        },
    );
  const rows: { job: string; zone: string; code: string; gapS: number }[] = [];
  for (const t of trials.filter((x) => x.arm === 'anycloud')) {
    const job = `sl-${runId}-${t.size === 'xlarge' ? 1 : 4}-r${t.round}`;
    const mine = entries.filter(
      (e) => e.id === job || e.vmId?.startsWith(`${job}-`),
    );
    // Between two refusals of one VM's launch there is only the second
    // zone's RunInstances call.
    const previous = new Map<string, number>();
    for (const e of mine.filter((x) => x.message.startsWith('EC2 refused'))) {
      const at = Date.parse(e.timestamp);
      const before = previous.get(e.vmId ?? '');
      if (before !== undefined) {
        rows.push({
          job,
          zone: e.zone ?? '?',
          code: e.code ?? '?',
          gapS: (at - before) / 1000,
        });
      }
      previous.set(e.vmId ?? '', at);
    }
  }
  return rows;
}

function report(
  trials: Trial[],
  probes: Call[],
  log?: string,
  runId?: string,
): string {
  const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
  const lines = [
    '| Arm | Size | n | Landed | On m8a | Accepted s, median (p90) | Running s, median (p90) | API calls, median | Extra VMs | Cost $ | Failure modes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const size of SIZES) {
    for (const arm of ARMS) {
      const ts = trials.filter((t) => t.arm === arm && t.size === size);
      if (!ts.length) continue;
      const landed = ts.filter((t) => t.type);
      const accepted = landed.flatMap((t) => t.acceptedS ?? []);
      const running = landed.flatMap((t) => t.runningS ?? []);
      const codes = new Map<string, number>();
      for (const c of ts.flatMap((t) => t.calls)) {
        if (c.code)
          for (const code of c.code.split('; '))
            codes.set(
              code.split(' ').at(-1)!,
              (codes.get(code.split(' ').at(-1)!) ?? 0) + 1,
            );
      }
      lines.push(
        `| ${arm} | ${size} | ${ts.length} | ${landed.length} | ${landed.filter((t) => t.type!.startsWith('m8a')).length} | ${fmt(median(accepted))} (${fmt(quantile(accepted, 0.9))}) | ${fmt(median(running))} (${fmt(quantile(running, 0.9))}) | ${median(ts.map((t) => t.calls.length))} | ${ts.reduce((s, t) => s + t.extra, 0)} ($${ts.reduce((s, t) => s + t.extraCostUsd, 0).toFixed(3)}) | ${ts.reduce((s, t) => s + t.costUsd, 0).toFixed(3)} | ${[...codes].map(([c, n]) => `${c} ×${n}`).join(', ')} |`,
      );
    }
  }
  const direct = trials
    .flatMap((t) => t.calls)
    .filter((c) => c.op === 'RunInstances');
  const refused = direct.filter((c) => c.code && ZONE_REFUSALS.has(c.code));
  const accepted = direct.filter((c) => !c.code);
  lines.push(
    '',
    `One-attempt RunInstances: ${refused.length} zone refusals answered in median ${median(refused.map((c) => c.ms))} ms (max ${Math.max(...refused.map((c) => c.ms))}), HTTP ${[...new Set(refused.map((c) => c.http))].join('/')}; ${accepted.length} acceptances in median ${median(accepted.map((c) => c.ms))} ms.`,
    '',
    '| Gateway-client probe | Zone | Type | Outcome | HTTP | SDK attempts | SDK retry delay s | Elapsed s |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...probes.map(
      (p, i) =>
        `| ${i + 1} | ${p.zone} | ${p.type} | ${p.code ?? 'accepted'} | ${p.http ?? ''} | ${p.attempts ?? ''} | ${p.retryDelayMs === undefined ? '' : (p.retryDelayMs / 1000).toFixed(1)} | ${(p.ms / 1000).toFixed(1)} |`,
    ),
  );
  if (log && runId) {
    const gaps = anycloudRefusals(log, trials, runId);
    lines.push(
      '',
      `anycloud arm, from the API log: ${gaps.length} zone refusals, each ${fmt(median(gaps.map((g) => g.gapS)))} s median after the previous step (range ${fmt(Math.min(...gaps.map((g) => g.gapS)))}–${fmt(Math.max(...gaps.map((g) => g.gapS)))}).`,
    );
  }
  const landings = new Map<string, number>();
  for (const t of trials)
    if (t.zone)
      landings.set(
        `${t.arm} ${t.type} ${t.zone}`,
        (landings.get(`${t.arm} ${t.type} ${t.zone}`) ?? 0) + 1,
      );
  lines.push(
    '',
    '| Arm | Type | Zone | Landings |',
    '| --- | --- | --- | --- |',
    ...[...landings]
      .sort()
      .map(([k, n]) => `| ${k.split(' ').join(' | ')} | ${n} |`),
  );
  const spent = trials.reduce((sum, t) => sum + t.costUsd, 0);
  lines.push(
    '',
    `${trials.length} trials; estimated EC2 cost $${spent.toFixed(2)}.`,
  );
  return `${lines.join('\n')}\n`;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'run') {
  try {
    await run(
      Number(flag('rounds', '20')),
      Number(flag('workers', '2')),
      Number(flag('minutes', '70')),
    );
  } finally {
    const inventory = JSON.parse(
      readFileSync(inventoryPath, 'utf8'),
    ) as Inventory;
    const trials = existsSync(join(output, 'trials.json'))
      ? (JSON.parse(
          readFileSync(join(output, 'trials.json'), 'utf8'),
        ) as Trial[])
      : [];
    const probes = existsSync(join(output, 'attribution.json'))
      ? (JSON.parse(
          readFileSync(join(output, 'attribution.json'), 'utf8'),
        ) as Call[])
      : [];
    evidence(
      'report.md',
      report(
        trials,
        probes,
        existsSync(join(state, 'api.log'))
          ? readFileSync(join(state, 'api.log'), 'utf8')
          : undefined,
        inventory.runId,
      ),
    );
  }
} else if (command === 'cleanup') {
  await cleanup();
} else if (command === 'report') {
  const [trialsPath, probesPath, logPath, runId] = rest;
  console.log(
    report(
      JSON.parse(readFileSync(trialsPath!, 'utf8')) as Trial[],
      probesPath
        ? (JSON.parse(readFileSync(probesPath, 'utf8')) as Call[])
        : [],
      logPath ? readFileSync(logPath, 'utf8') : undefined,
      runId,
    ),
  );
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
