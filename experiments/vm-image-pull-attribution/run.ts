#!/usr/bin/env tsx
/** The image-pull attribution spike (VQ-3); see README.md. */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  type _InstanceType,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DefaultAzureCredential } from '@azure/identity';
import {
  ImagesClient,
  InstancesClient,
  protos,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import {
  CONTAINERD_TRANSFER_CHUNK_BYTES,
  CONTAINERD_TRANSFER_CONCURRENCY,
  CONTAINERD_TRANSFER_PULL_COMMAND,
} from '../../src/api/services/containerd-transfer.js';
import {
  dockerArchiveUrl,
  installUnpigzCommand,
} from '../../src/api/runtime-artifacts.js';
import { selectAzureGpuImageId } from '../../src/shared/catalog/azure-gpu-map.js';
import { lambdaOsImageFamily } from '../../src/shared/catalog/lambda.js';
import { gcpGpuMachineCapability } from '../../src/shared/gcp-machine-capabilities.js';

const TAG = { key: 'anycloud-spike', value: 'vm-image-pull-attribution' };
// e2e-gpu's pinned MACE image: 17 layers, 9,826,830,040 bytes compressed. The
// probe blob is its largest layer (5,688,518,449 bytes).
const IMAGE =
  'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d';
const IMAGE_BYTES = 9_826_830_040;
const PROBE_BLOB =
  'sha256:c5308251d35b5a8110dc26c5c093acc15b96080265def5165f9e906cafd99bab';
// `--aws-region=<region>` moves the AWS targets and their cleanup.
const AWS_REGION =
  process.argv.find((a) => a.startsWith('--aws-region='))?.split('=')[1] ??
  'us-east-1';
const AZURE_REGION = 'westus2';
const GCP_ZONES = ['us-east4-a', 'us-east4-c', 'us-east4-b'];
const DISK_GB = 100;
const GUEST_DEADLINE_MIN = 60;
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
const runId = process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex');
const name = `ac-spike-pull-${runId}`;

type Cloud = 'aws' | 'azure' | 'gcp' | 'lambda';
interface Target {
  id: string;
  cloud: Cloud;
  size: string;
  gpu: boolean;
  /** The e2e MACE leg's disk tier; CPU targets take the default, medium. */
  highDisk?: boolean;
}
// GPU: e2e-gpu's MACE legs (job-profiles.ts maceFullPull), 100 GB disks.
const TARGETS: Target[] = [
  {
    id: 'aws-gpu',
    cloud: 'aws',
    size: 'g6e.xlarge',
    gpu: true,
    highDisk: true,
  },
  {
    id: 'azure-gpu',
    cloud: 'azure',
    size: 'Standard_NC4as_T4_v3',
    gpu: true,
    highDisk: true,
  },
  { id: 'gcp-gpu', cloud: 'gcp', size: 'g2-standard-4', gpu: true },
  { id: 'lambda-gpu', cloud: 'lambda', size: 'gpu_1x_a10', gpu: true },
  { id: 'aws-cpu', cloud: 'aws', size: 't3.medium', gpu: false },
  { id: 'azure-cpu', cloud: 'azure', size: 'Standard_D2s_v5', gpu: false },
  { id: 'gcp-cpu', cloud: 'gcp', size: 'e2-standard-2', gpu: false },
];

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

function guestScript(target: Target, uploadUrl: string): string {
  const settings = {
    SPIKE_TARGET: target.id,
    SPIKE_IMAGE: IMAGE,
    SPIKE_PROBE_BLOB: PROBE_BLOB,
    SPIKE_DOCKER_URL: dockerArchiveUrl('x86_64'),
    SPIKE_TRANSFER_CONCURRENCY: CONTAINERD_TRANSFER_CONCURRENCY,
    SPIKE_TRANSFER_CHUNK_BYTES: CONTAINERD_TRANSFER_CHUNK_BYTES,
    SPIKE_DEADLINE_MIN: GUEST_DEADLINE_MIN,
    SPIKE_EVIDENCE_URL: uploadUrl,
  };
  return [
    '#!/bin/bash',
    ...Object.entries(settings).map(([key, value]) => `${key}='${value}'`),
    'mkdir -p /var/spike',
    "cat > /var/spike/transfer-pull.sh <<'SPIKE_EOF'",
    CONTAINERD_TRANSFER_PULL_COMMAND.trimEnd(),
    'SPIKE_EOF',
    "cat > /var/spike/install-unpigz.sh <<'SPIKE_EOF'",
    installUnpigzCommand(),
    'SPIKE_EOF',
    readFileSync(new URL('guest.sh', import.meta.url), 'utf8'),
  ].join('\n');
}

/** One step's metrics from the guest's one-second samples. */
function measure(samples: number[][], start: number, end: number) {
  const base = samples.filter((s) => s[0]! <= start).at(-1) ?? samples[0]!;
  const span = samples.filter((s) => s[0]! > start && s[0]! <= end + 1);
  const last = span.at(-1) ?? base;
  const fetched = last[1]! - base[1]!;
  const lastByteAt =
    span.find((s) => s[1]! - base[1]! >= fetched * 0.995)?.[0] ?? end;
  let peakWrite = 0;
  for (let i = 5; i < span.length; i++) {
    const rate =
      ((span[i]![2]! - span[i - 5]![2]!) * 512) /
      (span[i]![0]! - span[i - 5]![0]!);
    peakWrite = Math.max(peakWrite, rate);
  }
  const jiffies = last[5]! - base[5]! || 1;
  const wall = end - start;
  const mb = (bytes: number) => +(bytes / 1e6).toFixed(0);
  return {
    wallSec: +wall.toFixed(1),
    fetchedMB: mb(fetched),
    lastByteSec: +(Math.min(lastByteAt, end) - start).toFixed(1),
    unpackSec: +(end - Math.min(lastByteAt, end)).toFixed(1),
    fetchMBps: mb(fetched / Math.max(Math.min(lastByteAt, end) - start, 1)),
    writtenMB: mb((last[2]! - base[2]!) * 512),
    writeMBps: mb(((last[2]! - base[2]!) * 512) / wall),
    peakWrite5sMBps: mb(peakWrite),
    cpuBusyPct: +((100 * (last[3]! - base[3]!)) / jiffies).toFixed(0),
    iowaitPct: +((100 * (last[4]! - base[4]!)) / jiffies).toFixed(0),
  };
}

function analyse(dir: string) {
  const meta = readFileSync(join(dir, 'meta'), 'utf8').trim().split('\n');
  const samples = readFileSync(join(dir, 'samples.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' ').map(Number))
    .filter((s) => s.length === 6 && s.every(Number.isFinite));
  const phases = Object.fromEntries(
    readFileSync(join(dir, 'phases.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [step, start, end, code] = line.split('\t');
        const metrics = measure(samples, Number(start), Number(end));
        const pull = step!.endsWith('-pull');
        return [
          step!,
          {
            exitCode: Number(code),
            ...metrics,
            ...(pull && {
              cold: metrics.fetchedMB * 1e6 >= IMAGE_BYTES * 0.95,
            }),
          },
        ];
      }),
  );
  return { meta, phases };
}

// ---------------------------------------------------------------- providers

const ec2 = () => new EC2Client({ region: AWS_REGION });
const azure = () => {
  const credential = new DefaultAzureCredential();
  const subscription = process.env.AZURE_SUBSCRIPTION_ID!;
  return {
    compute: new ComputeManagementClient(credential, subscription),
    network: new NetworkManagementClient(credential, subscription),
    resources: new ResourceManagementClient(credential, subscription),
  };
};
const gcpOptions = () => ({
  projectId: process.env.GCP_PROJECT_ID!,
  credentials: {
    client_email: process.env.GCP_CLIENT_EMAIL!,
    private_key: process.env.GCP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  },
});
async function lambda<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await lambdaPage<T>(method, path, body)).data;
}
async function lambdaPage<T>(method: string, path: string, body?: unknown) {
  const response = await fetch(`https://cloud.lambda.ai/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.LAMBDA_API_KEY}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Lambda ${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as { data: T; page_token?: string | null };
}

/** The image and root volume the AWS gateway gives a VM Job (aws.ts). */
async function launchAws(target: Target, script: string): Promise<void> {
  const client = ec2();
  const [owner, pattern] = target.gpu
    ? ['amazon', 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*']
    : [
        '099720109477',
        'ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*',
      ];
  const { Images = [] } = await client.send(
    new DescribeImagesCommand({
      Owners: [owner],
      Filters: [
        { Name: 'name', Values: [pattern] },
        { Name: 'architecture', Values: ['x86_64'] },
      ],
    }),
  );
  // aws.ts's exact-name checks, which skip variants the wildcard also matches.
  const exact = target.gpu
    ? /^Deep Learning Base OSS Nvidia Driver GPU AMI \(Ubuntu 24\.04\) [0-9]{8}$/
    : /ubuntu\/images\/hvm-ssd(-gp3)?\/ubuntu-noble-24\.04-amd64-server-[0-9]{8}(\.[0-9]+)?$/;
  const image = Images.filter(
    (i) => i.State === 'available' && exact.test(i.Name ?? ''),
  ).sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
  )[0]!;
  const errors: string[] = [];
  // On-demand GPU capacity varies by zone; try each until one launches.
  for (const zone of ['a', 'b', 'c', 'd', 'f']) {
    try {
      await client.send(
        new RunInstancesCommand({
          ImageId: image.ImageId,
          InstanceType: target.size as _InstanceType,
          Placement: { AvailabilityZone: `${AWS_REGION}${zone}` },
          NetworkInterfaces: [
            { DeviceIndex: 0, AssociatePublicIpAddress: true },
          ],
          BlockDeviceMappings: [
            {
              DeviceName: image.RootDeviceName,
              Ebs: {
                VolumeSize: DISK_GB,
                VolumeType: 'gp3',
                DeleteOnTermination: true,
                // aws.ts rootVolumePerformanceForDiskTier(high).
                ...(target.highDisk && { Iops: 8000, Throughput: 1000 }),
              },
            },
          ],
          MinCount: 1,
          MaxCount: 1,
          UserData: Buffer.from(script).toString('base64'),
          InstanceInitiatedShutdownBehavior: 'terminate',
          TagSpecifications: [
            {
              ResourceType: 'instance',
              Tags: [
                { Key: TAG.key, Value: TAG.value },
                { Key: 'Name', Value: `${name}-${target.id}` },
              ],
            },
          ],
        }),
      );
      return;
    } catch (error) {
      errors.push(`${zone}: ${String(error)}`);
    }
  }
  throw new Error(`${target.id}: ${errors.join('; ')}`);
}

/** Azure's medium tier is Standard_LRS and high is Premium_LRS (azure.ts). */
async function launchAzure(targets: Target[], scripts: string[]) {
  const { compute, network, resources } = azure();
  const tags = { [TAG.key]: TAG.value };
  await resources.resourceGroups.createOrUpdate(name, {
    location: AZURE_REGION,
    tags,
  });
  const vnet = await network.virtualNetworks.beginCreateOrUpdateAndWait(
    name,
    'spike',
    {
      location: AZURE_REGION,
      tags,
      addressSpace: { addressPrefixes: ['10.10.0.0/16'] },
      subnets: [{ name: 'spike', addressPrefix: '10.10.0.0/24' }],
    },
  );
  await Promise.all(
    targets.map(async (target, index) => {
      const ip = await network.publicIPAddresses.beginCreateOrUpdateAndWait(
        name,
        target.id,
        {
          location: AZURE_REGION,
          tags,
          sku: { name: 'Standard' },
          publicIPAllocationMethod: 'Static',
        },
      );
      const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
        name,
        target.id,
        {
          location: AZURE_REGION,
          tags,
          // Like azure.ts, without accelerated networking.
          ipConfigurations: [
            {
              name: 'primary',
              subnet: { id: vnet.subnets![0]!.id },
              publicIPAddress: { id: ip.id },
            },
          ],
        },
      );
      await compute.virtualMachines.beginCreateOrUpdateAndWait(
        name,
        target.id,
        {
          location: AZURE_REGION,
          tags,
          hardwareProfile: { vmSize: target.size },
          osProfile: {
            computerName: target.id,
            adminUsername: 'spike',
            // Never used: the network has no inbound rule.
            adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
            customData: Buffer.from(scripts[index]!).toString('base64'),
          },
          storageProfile: {
            imageReference: target.gpu
              ? {
                  communityGalleryImageId: selectAzureGpuImageId(
                    target.size,
                    'T4',
                  )!,
                }
              : {
                  publisher: 'canonical',
                  offer: 'ubuntu-24_04-lts',
                  sku: 'server',
                  version: 'latest',
                },
            osDisk: {
              createOption: 'FromImage',
              deleteOption: 'Delete',
              diskSizeGB: DISK_GB,
              managedDisk: {
                storageAccountType: target.highDisk
                  ? 'Premium_LRS'
                  : 'Standard_LRS',
              },
            },
          },
          networkProfile: {
            networkInterfaces: [{ id: nic.id, primary: true }],
          },
        },
      );
    }),
  );
}

/** gcp.ts gives a medium-tier g2 pd-balanced and an e2 the image's default. */
async function launchGcp(target: Target, script: string): Promise<void> {
  const capability = gcpGpuMachineCapability(target.size);
  const family = capability?.launchQualified
    ? capability.image
    : { project: 'ubuntu-os-cloud', family: 'ubuntu-2404-lts-amd64' };
  const [image] = await new ImagesClient(gcpOptions()).getFromFamily(family);
  const errors: string[] = [];
  for (const zone of target.gpu ? GCP_ZONES : GCP_ZONES.slice(0, 1)) {
    try {
      const [operation] = await new InstancesClient(gcpOptions()).insert({
        project: process.env.GCP_PROJECT_ID!,
        zone,
        instanceResource: {
          name: `${name}-${target.id}`,
          machineType: `zones/${zone}/machineTypes/${target.size}`,
          labels: { [TAG.key]: TAG.value },
          scheduling: {
            onHostMaintenance: target.gpu ? 'TERMINATE' : 'MIGRATE',
          },
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: image.selfLink,
                diskSizeGb: String(DISK_GB),
                ...(target.gpu && {
                  diskType: `zones/${zone}/diskTypes/pd-balanced`,
                }),
              },
            },
          ],
          networkInterfaces: [
            {
              accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
            },
          ],
          metadata: { items: [{ key: 'startup-script', value: script }] },
        },
      });
      await waitGcp(operation, zone);
      return;
    } catch (error) {
      errors.push(`${zone}: ${String(error)}`);
    }
  }
  throw new Error(`${target.id}: ${errors.join('; ')}`);
}

// Compute calls resolve to `{ latestResponse }`, not the LROperation their
// types declare: poll the zone operation until it is DONE.
async function waitGcp(operation: object, zone: string): Promise<void> {
  const operations = new ZoneOperationsClient(gcpOptions());
  let current = (
    operation as { latestResponse: protos.google.cloud.compute.v1.IOperation }
  ).latestResponse;
  while (current.status !== 'DONE') {
    [current] = await operations.wait({
      project: process.env.GCP_PROJECT_ID!,
      zone,
      operation: current.name!,
    });
  }
  if (current.error) {
    throw new Error(
      `GCP operation ${current.name} failed: ${JSON.stringify(current.error)}`,
    );
  }
}

/** The first region with capacity, on the image family gateways/lambda.ts uses. */
async function launchLambda(target: Target, script: string): Promise<void> {
  const types = await lambda<
    Record<string, { regions_with_capacity_available: { name: string }[] }>
  >('GET', '/instance-types');
  const region = types[target.size]?.regions_with_capacity_available[0]?.name;
  if (!region) throw new Error(`No Lambda capacity for ${target.size}`);
  await lambda('POST', '/instance-operations/launch', {
    region_name: region,
    instance_type_name: target.size,
    image: { family: lambdaOsImageFamily(target.size) },
    // The product's placeholder key in the CI account (gateways/lambda.ts).
    ssh_key_names: ['anycloud-api'],
    name: `${name}-${target.id}`,
    tags: [{ key: TAG.key, value: TAG.value }],
    user_data: script,
  });
}

async function run(only: string[]): Promise<void> {
  const targets = TARGETS.filter(
    (target) => only.length === 0 || only.includes(target.id),
  );
  // Guests upload their evidence to signed URLs on one GCS bucket; no cloud
  // credential reaches a VM.
  const bucket = new Storage(gcpOptions()).bucket(name);
  await bucket.create({
    location: 'US-EAST4',
    labels: { [TAG.key]: TAG.value },
  });
  const scripts = await Promise.all(
    targets.map(async (target) => {
      const [url] = await bucket.file(`${target.id}.tgz`).getSignedUrl({
        version: 'v4',
        action: 'write',
        contentType: 'application/gzip',
        expires: Date.now() + (GUEST_DEADLINE_MIN + 15) * 60_000,
      });
      return guestScript(target, url);
    }),
  );
  save('launch.json', { runId, name, image: IMAGE, targets });
  const azureTargets = targets.filter((t) => t.cloud === 'azure');
  const launchers = { aws: launchAws, gcp: launchGcp, lambda: launchLambda };
  const launches = await Promise.allSettled([
    ...(azureTargets.length
      ? [
          launchAzure(
            azureTargets,
            azureTargets.map((t) => scripts[targets.indexOf(t)]!),
          ),
        ]
      : []),
    ...targets.flatMap((target, index) =>
      target.cloud === 'azure'
        ? []
        : [launchers[target.cloud](target, scripts[index]!)],
    ),
  ]);
  const launchErrors = launches.flatMap((launch) =>
    launch.status === 'rejected' ? [String(launch.reason)] : [],
  );
  const results: Record<
    string,
    ReturnType<typeof analyse> | { error: string }
  > = {};
  const deadline = Date.now() + (GUEST_DEADLINE_MIN + 5) * 60_000;
  const pending = new Set(targets.map((target) => target.id));
  while (pending.size && Date.now() < deadline) {
    await delay(30_000);
    for (const id of [...pending]) {
      const file = bucket.file(`${id}.tgz`);
      if (!(await file.exists())[0]) continue;
      pending.delete(id);
      const dir = join(output, id);
      mkdirSync(dir, { recursive: true });
      await file.download({ destination: `${dir}.tgz` });
      execFileSync('tar', ['xzf', `${dir}.tgz`, '-C', dir]);
      try {
        results[id] = analyse(dir);
      } catch (error) {
        results[id] = { error: String(error) };
      }
    }
  }
  for (const id of pending) results[id] = { error: 'no evidence uploaded' };
  save('summary.json', {
    runId,
    sourceSha: process.env.SPIKE_SOURCE_SHA ?? null,
    launchErrors,
    results,
  });
  console.log(JSON.stringify({ launchErrors, results }, null, 2));
  const incomplete = Object.values(results).some(
    (r) =>
      'error' in r ||
      !r.phases['docker-pull'] ||
      Object.values(r.phases).some((p) => p.exitCode !== 0 || p.cold === false),
  );
  if (launchErrors.length || incomplete) {
    throw new Error(
      'a target did not launch, finish or pull cold; see summary.json',
    );
  }
}

/** Remove everything tagged for this experiment, on every cloud, and verify. */
async function cleanup(): Promise<void> {
  const client = ec2();
  const { resources } = azure();
  const instances = new InstancesClient(gcpOptions());
  const storage = new Storage(gcpOptions());
  const owned = {
    aws: async () => {
      const { Reservations = [] } = await client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: `tag:${TAG.key}`, Values: [TAG.value] },
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
    azure: async () => {
      const groups: string[] = [];
      for await (const group of resources.resourceGroups.list({
        filter: `tagName eq '${TAG.key}' and tagValue eq '${TAG.value}'`,
      })) {
        groups.push(group.name!);
      }
      return groups;
    },
    // zone/name pairs, from every zone.
    gcp: async () => {
      const found: string[] = [];
      for await (const [zone, list] of instances.aggregatedListAsync({
        project: process.env.GCP_PROJECT_ID!,
        filter: `labels.${TAG.key} = "${TAG.value}"`,
      })) {
        for (const instance of list.instances ?? []) {
          found.push(`${zone.replace('zones/', '')}/${instance.name}`);
        }
      }
      return found;
    },
    buckets: async () => {
      const [buckets] = await storage.getBuckets({ prefix: 'ac-spike-pull-' });
      return buckets
        .filter((b) => b.metadata.labels?.[TAG.key] === TAG.value)
        .map((b) => b.name);
    },
    // Lambda pages the list (50 by default) until page_token is null.
    lambda: async () => {
      const all: {
        id: string;
        status: string;
        tags?: { key: string; value: string }[];
      }[] = [];
      let token: string | null | undefined;
      do {
        const page = await lambdaPage<typeof all>(
          'GET',
          `/instances${token ? `?page_token=${encodeURIComponent(token)}` : ''}`,
        );
        all.push(...page.data);
        token = page.page_token;
      } while (token);
      return all
        .filter(
          (i) =>
            i.status !== 'terminated' &&
            i.tags?.some(
              (tag) => tag.key === TAG.key && tag.value === TAG.value,
            ),
        )
        .map((i) => i.id);
    },
  };
  const list = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(owned).map(async ([key, get]) => [key, await get()]),
      ),
    ) as Record<keyof typeof owned, string[]>;
  const removed = await list();
  if (removed.aws.length) {
    await client.send(
      new TerminateInstancesCommand({ InstanceIds: removed.aws }),
    );
  }
  if (removed.lambda.length) {
    await lambda('POST', '/instance-operations/terminate', {
      instance_ids: removed.lambda,
    });
  }
  await Promise.all([
    ...removed.azure.map((group) =>
      resources.resourceGroups.beginDeleteAndWait(group),
    ),
    ...removed.gcp.map(async (pair) => {
      const [zone, instance] = pair.split('/');
      const [operation] = await instances.delete({
        project: process.env.GCP_PROJECT_ID!,
        zone,
        instance,
      });
      await waitGcp(operation, zone!);
    }),
    ...removed.buckets.map(async (bucket) => {
      await storage.bucket(bucket).deleteFiles({ force: true });
      await storage.bucket(bucket).delete();
    }),
  ]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = await list();
    if (Object.values(remaining).every((ids) => ids.length === 0)) {
      save('cleanup.json', { removed, remaining });
      return;
    }
    await delay(15_000);
  }
  throw new Error('tagged spike resources remain after cleanup');
}

const [phase = process.env.SPIKE_PHASE ?? 'run', ...only] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--aws-region='));
await (phase === 'cleanup' ? cleanup() : run(only));
