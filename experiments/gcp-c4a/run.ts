#!/usr/bin/env tsx
/**
 * GCP C4A (Axion, arm64) against C4D and N2 in europe-west4: spot capacity
 * per zone, launch-to-container time and a ripgrep release build, on demand
 * and on spot; see README.md. anycloud's GCP catalog has no C4A rows, so a VM
 * Job can't target it; every arm launches here through the Compute API, alike.
 *
 * `preflight` records quotas, machine types and images.
 * `run [--rounds=10] [--first-round=1] [--max-vcpus=32]` runs the builds.
 * `spot` tries one spot launch of each type in every zone.
 * `cleanup` deletes everything labelled for the experiment and verifies it.
 * `report <results.json...>` rewrites the build report without a cloud.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DisksClient,
  ImagesClient,
  InstancesClient,
  MachineTypesClient,
  RegionsClient,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import {
  dockerArchiveUrl,
  JOB_HOST_DOCKER_VERSION,
} from '../../src/api/runtime-artifacts.js';
import { JOB_HOST_DISK_GB } from '../../src/api/services/job-host.js';

const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const LABEL = { key: 'anycloud-spike', value: 'gcp-c4a' };
const REGION = 'europe-west4';
const ZONES = ['a', 'b', 'c'].map((z) => `${REGION}-${z}`);
// anycloud's auto-mode Jobs network: a subnet in every region, no ingress.
const NETWORK = 'anycloud-jobs';
// GCP deletes a VM at this age regardless (scheduling.maxRunDuration).
const MAX_RUN_MIN = 40;
const COST_CAP_USD = 20;
const RUST_IMAGE = 'rust:1.83-bookworm';

const TYPES = [
  'c4a-standard-4',
  'c4a-standard-16',
  'c4a-highmem-16',
  'c4d-standard-4',
  'n2-standard-4',
] as const;
type VmType = (typeof TYPES)[number];
type Market = 'on-demand' | 'spot';
const MARKETS: Market[] = ['on-demand', 'spot'];
const arch = (type: string) => (type.startsWith('c4a') ? 'arm64' : 'amd64');
// What an anycloud VM Job's default (medium) tier boots from: Hyperdisk
// Balanced on C4A and C4D, which take no Persistent Disk, and GCP's default
// (pd-standard) on N2. Every disk is JOB_HOST_DISK_GB, as a Job host's is.
const diskType = (type: string) =>
  type.startsWith('n2-') ? undefined : 'hyperdisk-balanced';

const project = () => process.env.GCP_PROJECT_ID!;
const credentials = () => ({
  client_email: process.env.GCP_CLIENT_EMAIL!,
  private_key: process.env.GCP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
});
const clients = () => {
  const options = { projectId: project(), credentials: credentials() };
  return {
    instances: new InstancesClient(options),
    disks: new DisksClient(options),
    operations: new ZoneOperationsClient(options),
    images: new ImagesClient(options),
    machineTypes: new MachineTypesClient(options),
    regions: new RegionsClient(options),
    storage: new Storage(options),
  };
};
type Clients = ReturnType<typeof clients>;

interface Result {
  id: string;
  type: VmType;
  market: Market;
  round: number;
  ok: boolean;
  zone: string;
  /** Zones that refused this VM before `zone` took it, with GCP's code. */
  refusals: string[];
  /** Epoch seconds at the insert request and when the insert finished. */
  insertAt: number;
  insertDoneAt: number;
  /** Epoch seconds the guest's kernel booted: a mark's epoch less its uptime. */
  kernelAt: number | null;
  /** Seconds since the kernel booted at each `MARK`. */
  marks: Record<string, number>;
  timings: Record<string, number>;
  lscpu: Record<string, string>;
  disk: Record<string, unknown>;
  failure?: string;
}

function evidence(name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

const codeOf = (error: unknown) => {
  const e = error as { errors?: { code?: string; message?: string }[] };
  return e.errors?.[0]?.code ?? (error as Error).name ?? 'Error';
};
const messageOf = (error: unknown) => {
  const e = error as { errors?: { code?: string; message?: string }[] };
  return e.errors?.[0]?.message ?? (error as Error).message ?? String(error);
};

/** Waits for a zone operation; throws its first error, as GCP reports it. */
async function settle(c: Clients, zone: string, raw: unknown) {
  const response = ((raw as { latestResponse?: unknown }).latestResponse ??
    raw) as { name?: string };
  const operation = response.name!.split('/').pop()!;
  for (;;) {
    const [op] = await c.operations.wait({
      project: project(),
      zone,
      operation,
    });
    if (op.status === 'DONE') {
      if (op.error?.errors?.length) throw op.error;
      return;
    }
  }
}

/** Canonical's newest Ubuntu 24.04 minimal image, as a VM Job host boots. */
async function ubuntu(c: Clients, imageArch: 'amd64' | 'arm64') {
  const [image] = await c.images.getFromFamily({
    project: 'ubuntu-os-cloud',
    family: `ubuntu-minimal-2404-lts-${imageArch}`,
  });
  return { link: image.selfLink!, name: image.name! };
}

async function insert(
  c: Clients,
  options: {
    type: VmType;
    zone: string;
    name: string;
    image: string;
    market: Market;
    diskGb: number;
    startupScript?: string;
  },
) {
  const labels = { [LABEL.key]: LABEL.value };
  const disk = diskType(options.type);
  const [operation] = await c.instances.insert({
    project: project(),
    zone: options.zone,
    instanceResource: {
      name: options.name,
      machineType: `zones/${options.zone}/machineTypes/${options.type}`,
      labels,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: options.image,
            diskSizeGb: String(options.diskGb),
            ...(disk && {
              diskType: `zones/${options.zone}/diskTypes/${disk}`,
            }),
            labels,
          },
        },
      ],
      networkInterfaces: [
        {
          network: `projects/${project()}/global/networks/${NETWORK}`,
          accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
        },
      ],
      scheduling: {
        provisioningModel: options.market === 'spot' ? 'SPOT' : 'STANDARD',
        instanceTerminationAction: 'DELETE',
        maxRunDuration: { seconds: MAX_RUN_MIN * 60 },
        ...(options.market === 'spot' && { automaticRestart: false }),
      },
      ...(options.startupScript && {
        metadata: {
          items: [{ key: 'startup-script', value: options.startupScript }],
        },
      }),
    },
  });
  await settle(c, options.zone, operation);
}

async function remove(c: Clients, zone: string, name: string) {
  try {
    const [operation] = await c.instances.delete({
      project: project(),
      zone,
      instance: name,
    });
    await settle(c, zone, operation);
  } catch (error) {
    if ((error as { code?: number }).code !== 5) throw error; // NOT_FOUND
  }
}

/**
 * Installs anycloud's pinned static Docker, pulls the Rust image and builds
 * ripgrep in it, as m8a-vs-m8i's guest.sh does, then uploads its log and
 * halts. Each `MARK` carries the kernel's uptime and the epoch.
 */
function startupScript(type: VmType, uploadUrl: string) {
  const dockerUrl = dockerArchiveUrl(
    arch(type) === 'arm64' ? 'aarch64' : 'x86_64',
    JOB_HOST_DOCKER_VERSION,
  );
  return `#!/bin/bash
mark() { echo "MARK $1 $(cut -d' ' -f1 /proc/uptime) $(date +%s.%N)"; }
{
  mark startup-script
  lscpu | sed 's/^/LSCPU /'
  for _ in 1 2 3 4 5; do
    curl -fsSL '${dockerUrl}' | tar -xz -C /usr/local/bin --strip-components=1 && break
    sleep 3
  done
  mark docker-downloaded
  # No iptables on Ubuntu minimal: the containers use the host's network.
  dockerd --iptables=false --bridge=none >/var/log/dockerd.log 2>&1 &
  until docker info >/dev/null 2>&1; do sleep 0.2; done
  mark docker-ready
  docker pull -q ${RUST_IMAGE} >/dev/null
  mark image-pulled
  docker run --rm --network host ${RUST_IMAGE} bash -c '
    set -eu
    echo "MARK container-started $(cut -d" " -f1 /proc/uptime) $(date +%s.%N)"
    timed() {
      label=$1; shift
      start=$(date +%s%N)
      if ! "$@" >/tmp/out 2>&1; then tail -40 /tmp/out; echo "BENCH_FAIL $label"; exit 1; fi
      echo "BENCH $label $(( ($(date +%s%N) - start) / 1000000 ))"
    }
    timed clone git clone -q --depth 1 -b 14.1.1 https://github.com/BurntSushi/ripgrep /p
    cd /p
    timed fetch cargo fetch --locked
    timed build cargo build --release --locked
    echo "MARK build-done $(cut -d" " -f1 /proc/uptime) $(date +%s.%N)"
    echo BENCH_DONE'
  echo "UPTIME $(cut -d' ' -f1 /proc/uptime)"
} > /bench.log 2>&1
curl -sf -X PUT -H 'Content-Type: text/plain' --upload-file /bench.log '${uploadUrl}'
poweroff
`;
}

function parseLog(log: string) {
  const timings: Record<string, number> = {};
  const lscpu: Record<string, string> = {};
  const marks: Record<string, number> = {};
  let kernelAt: number | null = null;
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    const bench = /^BENCH (\S+) (\d+)$/.exec(line);
    if (bench) timings[bench[1]!] = Number(bench[2]) / 1000;
    const cpu = /^LSCPU ([^:]+):\s*(.*)$/.exec(line);
    if (cpu) lscpu[cpu[1]!] = cpu[2]!;
    const mark = /^MARK (\S+) ([\d.]+) ([\d.]+)$/.exec(line);
    if (mark) {
      marks[mark[1]!] = Number(mark[2]);
      kernelAt ??= Number(mark[3]) - Number(mark[2]);
    }
  }
  return { timings, lscpu, marks, kernelAt, done: log.includes('BENCH_DONE') };
}

/**
 * europe-west4 list prices, $/h, on 2026-11-25, from gcloud-compute.com,
 * which publishes Google's Billing Catalog SKUs per type; spot prices move.
 * The Billing Catalog API is disabled in CI's project. N2's and C4D's on-demand
 * prices match anycloud's catalog (SkyPilot's); it has no C4A rows.
 */
const PRICES: Record<
  VmType,
  { vcpus: number; onDemand: number; spot: number }
> = {
  'c4a-standard-4': { vcpus: 4, onDemand: 0.1886, spot: 0.0289 },
  'c4a-standard-16': { vcpus: 16, onDemand: 0.7543, spot: 0.1156 },
  'c4a-highmem-16': { vcpus: 16, onDemand: 0.9902, spot: 0.1517 },
  'c4d-standard-4': { vcpus: 4, onDemand: 0.1965, spot: 0.0887 },
  'n2-standard-4': { vcpus: 4, onDemand: 0.2138, spot: 0.0718 },
};
const hourly = (r: { type: VmType; market: Market }) =>
  PRICES[r.type][r.market === 'spot' ? 'spot' : 'onDemand'];

/** The region's CPU and disk quotas, and which zones offer each type. */
async function preflight(c: Clients) {
  const [region] = await c.regions.get({ project: project(), region: REGION });
  const quotas = (region.quotas ?? [])
    .filter((q) => /CPUS|HYPERDISK|DISKS|SSD/.test(q.metric ?? ''))
    .map((q) => ({ metric: q.metric, limit: q.limit, usage: q.usage }));
  const offered: Record<string, string[]> = {};
  for (const type of TYPES) {
    offered[type] = [];
    for (const zone of ZONES) {
      const found = await c.machineTypes
        .get({ project: project(), zone, machineType: type })
        .then(() => true)
        .catch(() => false);
      if (found) offered[type].push(zone);
    }
  }
  const images = {
    amd64: await ubuntu(c, 'amd64'),
    arm64: await ubuntu(c, 'arm64'),
  };
  const out = { quotas, offered, images };
  evidence('preflight.json', out);
  return out;
}

async function run(rounds: number, firstRound: number, maxVcpus: number) {
  const c = clients();
  const runId = randomBytes(3).toString('hex');
  const { images, quotas } = await preflight(c);
  console.log(JSON.stringify(quotas, null, 2));
  const bucket = c.storage.bucket(`gcp-c4a-${runId}`);
  await bucket.create({
    location: REGION.toUpperCase(),
    labels: { [LABEL.key]: LABEL.value },
  });
  const results: Result[] = [];
  const cost = (r: Result) =>
    ((r.marks['build-done'] ?? MAX_RUN_MIN * 60) / 3600) * hourly(r);
  const save = () => {
    evidence('results.json', { region: REGION, prices: PRICES, results });
    evidence('report.md', report(results));
  };

  const job = async (
    type: VmType,
    market: Market,
    round: number,
  ): Promise<Result> => {
    const id = `${runId}-r${round}-${market === 'spot' ? 's' : 'd'}-${type}`;
    const file = bucket.file(`${id}.log`);
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      contentType: 'text/plain',
      expires: Date.now() + (MAX_RUN_MIN + 15) * 60_000,
    });
    const name = `gcp-c4a-${id}`;
    const refusals: string[] = [];
    let zone = '';
    let insertAt = 0;
    let insertDoneAt = 0;
    for (const candidate of ZONES) {
      insertAt = Date.now() / 1000;
      try {
        await insert(c, {
          type,
          zone: candidate,
          name,
          image: images[arch(type)].link,
          market,
          diskGb: JOB_HOST_DISK_GB,
          startupScript: startupScript(type, url),
        });
        insertDoneAt = Date.now() / 1000;
        zone = candidate;
        break;
      } catch (error) {
        refusals.push(
          `${candidate}: ${codeOf(error)}: ${messageOf(error).slice(0, 300)}`,
        );
      }
    }
    const base = {
      id,
      type,
      market,
      round,
      refusals,
      insertAt,
      insertDoneAt,
      lscpu: {},
      marks: {},
      timings: {},
      disk: {},
    };
    if (!zone) {
      return {
        ...base,
        ok: false,
        zone: '',
        kernelAt: null,
        failure: 'launched nowhere',
      };
    }
    console.log(`round ${round}: ${market} ${type} in ${zone}`);
    const [disk] = await c.disks.get({ project: project(), zone, disk: name });
    const deadline = Date.now() + (MAX_RUN_MIN + 2) * 60_000;
    let status = '';
    while (Date.now() < deadline && !(await file.exists())[0]) {
      // A spot VM GCP preempts is deleted (instanceTerminationAction).
      status = await c.instances
        .get({ project: project(), zone, instance: name })
        .then(([i]) => i.status ?? '')
        .catch(() => 'GONE');
      if (status === 'GONE') break;
      await sleep(10_000);
    }
    const log = (await file.exists())[0]
      ? (await file.download())[0].toString()
      : '';
    await remove(c, zone, name);
    writeFileSync(
      join(output, `${id}.log`),
      log || `no log; instance ${status}`,
    );
    const parsed = parseLog(log);
    return {
      ...base,
      ok: parsed.done,
      zone,
      kernelAt: parsed.kernelAt,
      marks: parsed.marks,
      timings: parsed.timings,
      lscpu: parsed.lscpu,
      disk: {
        type: disk.type?.split('/').pop(),
        sizeGb: disk.sizeGb,
        provisionedIops: disk.provisionedIops,
        provisionedThroughput: disk.provisionedThroughput,
      },
      ...(parsed.done
        ? {}
        : {
            failure: log
              ? log.split('\n').slice(-30).join('\n')
              : `no log; instance ${status}`,
          }),
    };
  };

  // Round by round, each round's arms in a random order; a VM starts once
  // the running VMs leave it room under the vCPU cap.
  const queue = Array.from(
    { length: rounds },
    (_, i) => firstRound + i,
  ).flatMap((round) =>
    shuffle(
      TYPES.flatMap((type) =>
        MARKETS.map((market) => ({ type, market, round })),
      ),
    ),
  );
  mkdirSync(output, { recursive: true });
  let used = 0;
  const running = new Set<Promise<void>>();
  for (const next of queue) {
    const vcpus = PRICES[next.type].vcpus;
    while (used + vcpus > maxVcpus) await Promise.race(running);
    const spent = results.reduce((sum, r) => sum + cost(r), 0);
    if (spent >= COST_CAP_USD) {
      console.warn(`Cost cap: $${spent.toFixed(2)} spent; no more VMs`);
      break;
    }
    used += vcpus;
    const task = job(next.type, next.market, next.round)
      .then((r) => void results.push(r))
      .catch((error) =>
        console.error(
          `${next.type} ${next.market} r${next.round}: ${messageOf(error)}`,
        ),
      )
      .finally(() => {
        used -= vcpus;
        running.delete(task);
        save();
      });
    running.add(task);
  }
  await Promise.all(running);
  save();
  await cleanup();
  console.log(report(results));
  const failed = results.filter((r) => !r.ok);
  if (failed.length || results.length < queue.length) {
    throw new Error(
      `${failed.length} VMs failed; ${results.length} of ${queue.length} reported`,
    );
  }
}

/**
 * Spot capacity, not launch strategy: one spot launch of each type in each
 * zone, one at a time, each deleted as soon as GCP accepts it.
 */
async function spot() {
  const c = clients();
  const runId = randomBytes(3).toString('hex');
  const images = {
    amd64: await ubuntu(c, 'amd64'),
    arm64: await ubuntu(c, 'arm64'),
  };
  const attempts: {
    type: VmType;
    zone: string;
    result: string;
    message?: string;
  }[] = [];
  for (const zone of ZONES) {
    for (const type of TYPES) {
      const name = `gcp-c4a-spot-${runId}-${type}-${zone.slice(-1)}`;
      try {
        await insert(c, {
          type,
          zone,
          name,
          image: images[arch(type)].link,
          market: 'spot',
          diskGb: 10,
        });
        attempts.push({ type, zone, result: 'launched' });
        // A failed delete isn't a refusal; the cleanup deletes what's left.
        await remove(c, zone, name).catch(() => {});
      } catch (error) {
        attempts.push({
          type,
          zone,
          result: codeOf(error),
          message: messageOf(error).slice(0, 300),
        });
      }
    }
  }
  evidence('spot-launches.json', { at: new Date().toISOString(), attempts });
  const lines = ['| Type | Zones launched | Refusals |', '| --- | --- | --- |'];
  for (const type of TYPES) {
    const tried = attempts.filter((a) => a.type === type);
    const refused = tried.filter((a) => a.result !== 'launched');
    lines.push(
      `| ${type} | ${tried.length - refused.length} of ${tried.length} | ${refused.map((a) => `${a.zone.slice(-1)} ${a.result}`).join(', ')} |`,
    );
  }
  evidence('spot.md', `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  await cleanup();
}

/**
 * Deletes every labelled instance and disk in the region and the run
 * buckets, then verifies. It isn't scoped to one run: the Spike workflow's
 * concurrency group runs one command of an experiment at a time.
 */
async function cleanup() {
  const c = clients();
  const filter = `labels.${LABEL.key} = "${LABEL.value}"`;
  const listInstances = async (zone: string) =>
    (await c.instances.list({ project: project(), zone, filter }))[0].map(
      (i) => i.name!,
    );
  const listDisks = async (zone: string) =>
    (await c.disks.list({ project: project(), zone, filter }))[0].map(
      (d) => d.name!,
    );
  const left: Record<string, string[]> = {};
  for (const zone of ZONES) {
    await Promise.all(
      (await listInstances(zone)).map((name) => remove(c, zone, name)),
    );
    for (const disk of await listDisks(zone)) {
      const [operation] = await c.disks.delete({
        project: project(),
        zone,
        disk,
      });
      await settle(c, zone, operation).catch(() => {});
    }
    left[zone] = [...(await listInstances(zone)), ...(await listDisks(zone))];
  }
  const [buckets] = await c.storage.getBuckets({ prefix: 'gcp-c4a-' });
  for (const bucket of buckets) {
    await bucket.deleteFiles({ force: true });
    await bucket.delete();
  }
  left.buckets = (await c.storage.getBuckets({ prefix: 'gcp-c4a-' }))[0].map(
    (b) => b.name,
  );
  evidence('cleanup.json', left);
  if (Object.values(left).some((ids) => ids.length)) {
    throw new Error(`Resources remain: ${JSON.stringify(left)}`);
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

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function report(results: Result[]): string {
  const fmt = (x: number) => x.toFixed(1);
  const cell = (xs: number[]) =>
    xs.length
      ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})`
      : '';
  const arms = TYPES.flatMap((type) =>
    MARKETS.map((market) => ({ type, market })),
  );
  const of = (type: VmType, market: Market) =>
    results.filter((r) => r.ok && r.type === type && r.market === market);
  const lines = [
    'Seconds, median (range). Launch is the insert request; kernel is the',
    "guest kernel's boot; first step is the build container's first command.",
    'Cost per build is the build time at the list price; per VM, kernel boot',
    "to the build's end.",
    '',
    '| Arm | n | Launch → kernel | Kernel → container | Launch → first step | Image pull | cargo fetch | cargo build --release | $/h | $ per build | $ per VM |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { type, market } of arms) {
    const rs = of(type, market);
    const n = results.filter(
      (r) => r.type === type && r.market === market,
    ).length;
    if (!n) continue;
    const pick = (f: (r: Result) => number | undefined) =>
      rs.flatMap((r) => {
        const v = f(r);
        return v === undefined || Number.isNaN(v) ? [] : [v];
      });
    const toKernel = pick((r) =>
      r.kernelAt === null ? undefined : r.kernelAt - r.insertAt,
    );
    const toContainer = pick((r) => r.marks['container-started']);
    const firstStep = pick((r) =>
      r.kernelAt === null || r.marks['container-started'] === undefined
        ? undefined
        : r.kernelAt + r.marks['container-started'] - r.insertAt,
    );
    const pull = pick((r) =>
      r.marks['image-pulled'] === undefined
        ? undefined
        : r.marks['image-pulled'] - r.marks['docker-ready']!,
    );
    const build = pick((r) => r.timings.build);
    const vm = pick((r) => r.marks['build-done']);
    const rate = hourly({ type, market });
    const dollars = (xs: number[]) =>
      xs.length ? `$${((median(xs) / 3600) * rate).toFixed(4)}` : '';
    lines.push(
      `| ${type} ${market} | ${rs.length} of ${n} | ${cell(toKernel)} | ${cell(toContainer)} | ${cell(firstStep)} | ${cell(pull)} | ${cell(pick((r) => r.timings.fetch))} | ${cell(build)} | ${rate} | ${dollars(build)} | ${dollars(vm)} |`,
    );
  }
  const phases = [...new Set(results.flatMap((r) => Object.keys(r.marks)))];
  lines.push(
    '',
    "### Where a VM's time goes",
    '',
    'Median seconds since the kernel booted at each mark.',
    '',
    `| Arm | ${phases.join(' | ')} |`,
    `| --- | ${phases.map(() => '---').join(' | ')} |`,
  );
  for (const { type, market } of arms) {
    const rs = of(type, market);
    if (!rs.length) continue;
    const at = (p: string) => rs.flatMap((r) => r.marks[p] ?? []);
    lines.push(
      `| ${type} ${market} | ${phases.map((p) => (at(p).length ? fmt(median(at(p))) : '')).join(' | ')} |`,
    );
  }
  lines.push('', '### CPUs, disks and zones', '');
  for (const { type, market } of arms) {
    const all = results.filter((r) => r.type === type && r.market === market);
    if (!all.length) continue;
    const cpu = all.find((r) => r.ok)?.lscpu ?? {};
    const zones = [...new Set(all.map((r) => r.zone || 'none'))].join(', ');
    lines.push(
      `- ${type} ${market}: ${cpu['Model name'] ?? '?'} (${cpu['Architecture'] ?? '?'}), ${cpu['CPU(s)'] ?? '?'} vCPUs, ${cpu['Thread(s) per core'] ?? '?'} threads per core; disk ${JSON.stringify(all[0]!.disk)}; zones ${zones}`,
    );
    for (const refusal of all.flatMap((r) => r.refusals))
      lines.push(`  - refused: ${refusal}`);
  }
  const failed = results.filter((r) => !r.ok);
  lines.push('', `${results.length} VMs, ${failed.length} failed.`);
  for (const r of failed)
    lines.push('', `${r.id} failed:`, '', '```', r.failure ?? '', '```');
  return `${lines.join('\n')}\n`;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
if (command === 'preflight') {
  console.log(JSON.stringify(await preflight(clients()), null, 2));
} else if (command === 'run') {
  await run(
    Number(flag('rounds', '10')),
    Number(flag('first-round', '1')),
    Number(flag('max-vcpus', '32')),
  );
} else if (command === 'spot') {
  await spot();
} else if (command === 'cleanup') {
  await cleanup();
} else if (command === 'report') {
  const saved = rest.map(
    (path) =>
      JSON.parse(readFileSync(path, 'utf8')) as {
        results: Result[];
      },
  );
  console.log(report(saved.flatMap((s) => s.results)));
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
