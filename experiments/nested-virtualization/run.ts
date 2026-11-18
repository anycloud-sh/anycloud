#!/usr/bin/env tsx
/**
 * RFC 0049 C10: does a VM type the catalog reports as supporting nested
 * virtualization, launched the way a --require-nested-virtualization pool
 * launches it, expose a usable /dev/kvm on AWS, GCP and Azure? See README.md.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVpcsCommand,
  EC2Client,
  GetConsoleOutputCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DefaultAzureCredential } from '@azure/identity';
import {
  ImagesClient,
  InstancesClient,
  NetworksClient,
  protos,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import { getCatalogs } from '../../src/shared/catalog/index.js';
import {
  azureNestedVirtualization,
  gcpNestedVirtualization,
} from '../../src/shared/catalog/nested-virtualization.js';
import { CloudType } from '../../src/shared/cloud.js';
import { nestedVirtualizationSupport } from '../../src/shared/cloud-config.js';

const TAG = { key: 'anycloud-spike', value: 'nested-virtualization' };
const AWS_REGION = 'us-east-1';
const GCP_ZONE = 'us-central1-a';
const AZURE_REGION = 'westus2';
const AZURE_GROUP = 'anycloud-spike-nested-virtualization';
const DEADLINE_MS = 25 * 60_000;

type TargetId = 'aws' | 'aws-control' | 'gcp' | 'gcp-control' | 'azure';
interface Target {
  id: TargetId;
  vmType: string;
  /** Launched with nested virtualization on, as the pool would. */
  nested: boolean;
}
const TARGETS: Target[] = [
  { id: 'aws', vmType: 'm7i.large', nested: true },
  // The same types without the launch setting: /dev/kvm must be absent.
  { id: 'aws-control', vmType: 'm7i.large', nested: false },
  { id: 'gcp', vmType: 'n2-standard-2', nested: true },
  { id: 'gcp-control', vmType: 'n2-standard-2', nested: false },
  { id: 'azure', vmType: 'Standard_D2s_v5', nested: true },
];

const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
function save(name: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/**
 * Reports on the serial console; powers off after 40 minutes (AWS
 * terminates). The verdict is SPIKE-KVM, read as the boot left it: pool Nodes
 * never modprobe, so KVM must autoload from the CPU's vmx/svm flag. The
 * modprobe after it only shows whether a join-time modprobe would help.
 * `probe` opens /dev/kvm and creates a VM: KVM_GET_API_VERSION, KVM_CREATE_VM.
 */
const GUEST = `#!/bin/bash
exec > /dev/console 2>&1
probe() {
  python3 -c '
import fcntl, os, sys
if not os.path.exists("/dev/kvm"): sys.exit(print("absent"))
try: fd = os.open("/dev/kvm", os.O_RDWR)
except OSError: sys.exit(print("unopenable"))
try:
  assert fcntl.ioctl(fd, 0xAE00) == 12
  os.close(fcntl.ioctl(fd, 0xAE01, 0))
except Exception: sys.exit(print("no-vm"))
print("usable")'
}
echo "SPIKE-CPU-FLAGS=$(grep -o -w -E 'vmx|svm' /proc/cpuinfo | sort -u | tr '\\n' ' ')"
echo "SPIKE-KVM-MODULES=$(grep -o -E '^kvm(_intel|_amd)? ' /proc/modules | tr '\\n' ' ')"
echo "SPIKE-KVM=$(probe)"
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
echo "SPIKE-KVM-AFTER-MODPROBE=$(probe)"
echo SPIKE-DONE
shutdown -h +40
`;

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
const gcpName = (target: Target) => `ac-spike-nv-${target.id}`;

/** Each nested target's type must be one the shipped catalog code admits. */
async function assertCatalogAdmits(): Promise<void> {
  await getCatalogs();
  const admitted: Record<TargetId, boolean | null | undefined> = {
    aws: nestedVirtualizationSupport(CloudType.AWS, 'm7i.large', AWS_REGION),
    'aws-control': null,
    gcp: gcpNestedVirtualization('n2-standard-2'),
    'gcp-control': null,
    azure: azureNestedVirtualization('Standard_D2s_v5'),
  };
  save('catalog.json', admitted);
  const refused = TARGETS.filter(
    (target) => target.nested && admitted[target.id] !== true,
  );
  if (refused.length) {
    throw new Error(
      `catalog does not admit ${refused.map((t) => t.id).join(', ')}`,
    );
  }
}

// ------------------------------------------------------------------- launch

async function awsConsole(target: Target): Promise<() => Promise<string>> {
  const client = ec2();
  const { Vpcs = [] } = await client.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }),
  );
  if (Vpcs.length === 0) {
    throw new Error(`AWS ${AWS_REGION} has no default VPC to launch into`);
  }
  const { Images = [] } = await client.send(
    new DescribeImagesCommand({
      Owners: ['099720109477'],
      Filters: [
        {
          Name: 'name',
          Values: ['ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*'],
        },
        { Name: 'state', Values: ['available'] },
      ],
    }),
  );
  const image = Images.sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
  )[0]!;
  const { Instances = [] } = await client.send(
    new RunInstancesCommand({
      ImageId: image.ImageId,
      InstanceType: target.vmType as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      // As AwsGateway.newVM sets it where the catalog reports support.
      ...(target.nested && {
        CpuOptions: { NestedVirtualization: 'enabled' },
      }),
      UserData: Buffer.from(GUEST).toString('base64'),
      InstanceInitiatedShutdownBehavior: 'terminate',
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [{ Key: TAG.key, Value: TAG.value }],
        },
      ],
    }),
  );
  const id = Instances[0]!.InstanceId!;
  save(`${target.id}-instance.json`, { id, region: AWS_REGION });
  return async () => {
    const { Output } = await client.send(
      new GetConsoleOutputCommand({ InstanceId: id, Latest: true }),
    );
    return Buffer.from(Output ?? '', 'base64').toString('utf8');
  };
}

async function gcpConsole(target: Target): Promise<() => Promise<string>> {
  await new NetworksClient(gcpOptions())
    .get({ project: process.env.GCP_PROJECT_ID!, network: 'default' })
    .catch((error: unknown) => {
      throw new Error(
        `GCP project has no default network to launch into: ${String(error)}`,
      );
    });
  const [image] = await new ImagesClient(gcpOptions()).getFromFamily({
    project: 'ubuntu-os-cloud',
    family: 'ubuntu-2404-lts-amd64',
  });
  const instances = new InstancesClient(gcpOptions());
  const [operation] = await instances.insert({
    project: process.env.GCP_PROJECT_ID!,
    zone: GCP_ZONE,
    instanceResource: {
      name: gcpName(target),
      machineType: `zones/${GCP_ZONE}/machineTypes/${target.vmType}`,
      labels: { [TAG.key]: TAG.value },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: { sourceImage: image.selfLink },
        },
      ],
      networkInterfaces: [{}],
      metadata: { items: [{ key: 'startup-script', value: GUEST }] },
      // As GcpGateway.newVM sets it for a --require-nested-virtualization pool.
      ...(target.nested && {
        advancedMachineFeatures: { enableNestedVirtualization: true },
      }),
    },
  });
  await waitGcp(operation);
  return async () => {
    const [serial] = await instances.getSerialPortOutput({
      project: process.env.GCP_PROJECT_ID!,
      zone: GCP_ZONE,
      instance: gcpName(target),
    });
    return serial.contents ?? '';
  };
}

// Compute calls resolve to `{ latestResponse }`, not the LROperation their
// types declare: poll the zone operation until it is DONE.
async function waitGcp(operation: object): Promise<void> {
  const operations = new ZoneOperationsClient(gcpOptions());
  let current = (
    operation as { latestResponse: protos.google.cloud.compute.v1.IOperation }
  ).latestResponse;
  while (current.status !== 'DONE') {
    [current] = await operations.wait({
      project: process.env.GCP_PROJECT_ID!,
      zone: GCP_ZONE,
      operation: current.name!,
    });
  }
  if (current.error) {
    throw new Error(
      `GCP operation ${current.name} failed: ${JSON.stringify(current.error)}`,
    );
  }
}

/** Azure has no launch setting: the size series decides. */
async function azureConsole(target: Target): Promise<() => Promise<string>> {
  const { compute, network, resources } = azure();
  const tags = { [TAG.key]: TAG.value };
  await resources.resourceGroups.createOrUpdate(AZURE_GROUP, {
    location: AZURE_REGION,
    tags,
  });
  const vnet = await network.virtualNetworks.beginCreateOrUpdateAndWait(
    AZURE_GROUP,
    'spike',
    {
      location: AZURE_REGION,
      tags,
      addressSpace: { addressPrefixes: ['10.10.0.0/16'] },
      subnets: [{ name: 'spike', addressPrefix: '10.10.0.0/24' }],
    },
  );
  const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
    AZURE_GROUP,
    target.id,
    {
      location: AZURE_REGION,
      tags,
      ipConfigurations: [
        { name: 'primary', subnet: { id: vnet.subnets![0]!.id } },
      ],
    },
  );
  await compute.virtualMachines.beginCreateOrUpdateAndWait(
    AZURE_GROUP,
    target.id,
    {
      location: AZURE_REGION,
      tags,
      hardwareProfile: { vmSize: target.vmType },
      osProfile: {
        computerName: target.id,
        adminUsername: 'spike',
        // Never used: the VM has no public address.
        adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
        customData: Buffer.from(GUEST).toString('base64'),
      },
      storageProfile: {
        imageReference: {
          publisher: 'canonical',
          offer: 'ubuntu-24_04-lts',
          sku: 'server',
          version: 'latest',
        },
        osDisk: { createOption: 'FromImage', deleteOption: 'Delete' },
      },
      networkProfile: { networkInterfaces: [{ id: nic.id, primary: true }] },
      diagnosticsProfile: { bootDiagnostics: { enabled: true } },
    },
  );
  return async () => {
    const { serialConsoleLogBlobUri } =
      await compute.virtualMachines.retrieveBootDiagnosticsData(
        AZURE_GROUP,
        target.id,
      );
    if (!serialConsoleLogBlobUri) return '';
    const response = await fetch(serialConsoleLogBlobUri);
    return response.ok ? response.text() : '';
  };
}

// ---------------------------------------------------------------------- run

async function observe(target: Target): Promise<Record<string, unknown>> {
  const read = await (target.id.startsWith('aws')
    ? awsConsole(target)
    : target.id === 'azure'
      ? azureConsole(target)
      : gcpConsole(target));
  const started = Date.now();
  let serial = '';
  while (Date.now() - started < DEADLINE_MS && !serial.includes('SPIKE-DONE')) {
    await delay(20_000);
    serial = await read().catch(() => serial);
  }
  save(`${target.id}-console.txt`, serial);
  const kvm = /SPIKE-KVM=(\S+)/.exec(serial)?.[1] ?? null;
  return {
    target: target.id,
    vmType: target.vmType,
    nested: target.nested,
    kvm,
    kvmAfterModprobe:
      /SPIKE-KVM-AFTER-MODPROBE=(\S+)/.exec(serial)?.[1] ?? null,
    kvmModules: /SPIKE-KVM-MODULES=(.*)/.exec(serial)?.[1]?.trim() ?? null,
    cpuFlags: /SPIKE-CPU-FLAGS=(.*)/.exec(serial)?.[1]?.trim() ?? null,
    pass: kvm === (target.nested ? 'usable' : 'absent'),
  };
}

async function run(only: string[]): Promise<void> {
  await assertCatalogAdmits();
  const targets = TARGETS.filter(
    (target) => only.length === 0 || only.includes(target.id),
  );
  const results = await Promise.all(
    targets.map((target) =>
      observe(target).catch((error: unknown) => ({
        target: target.id,
        error: String(error),
        pass: false,
      })),
    ),
  );
  save('summary.json', results);
  const failed = results.filter((result) => !result.pass);
  if (failed.length) {
    throw new Error(`failed: ${failed.map((r) => r.target).join(', ')}`);
  }
}

// ------------------------------------------------------------------ cleanup

/** Deletes what `owned` lists, then waits until it lists nothing. */
async function sweep(
  owned: () => Promise<string[]>,
  remove: (ids: string[]) => Promise<unknown>,
): Promise<string[]> {
  const removed = await owned();
  if (removed.length) await remove(removed);
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await owned()).length === 0) return removed;
    await delay(15_000);
  }
  throw new Error(`${(await owned()).join(', ')} remain after cleanup`);
}

async function cleanupAws(): Promise<string[]> {
  const client = ec2();
  return sweep(
    async () => {
      const { Reservations = [] } = await client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: `tag:${TAG.key}`, Values: [TAG.value] },
            {
              Name: 'instance-state-name',
              Values: ['pending', 'running', 'stopping', 'stopped'],
            },
          ],
        }),
      );
      return Reservations.flatMap((r) => r.Instances ?? []).map(
        (i) => i.InstanceId!,
      );
    },
    (ids) => client.send(new TerminateInstancesCommand({ InstanceIds: ids })),
  );
}

async function cleanupGcp(): Promise<string[]> {
  const instances = new InstancesClient(gcpOptions());
  const project = process.env.GCP_PROJECT_ID!;
  return sweep(
    async () => {
      const [list] = await instances.list({
        project,
        zone: GCP_ZONE,
        filter: `labels.${TAG.key}=${TAG.value}`,
      });
      return list.map((instance) => instance.name!);
    },
    (names) =>
      Promise.all(
        names.map(async (instance) => {
          const [operation] = await instances.delete({
            project,
            zone: GCP_ZONE,
            instance,
          });
          await waitGcp(operation);
        }),
      ),
  );
}

async function cleanupAzure(): Promise<string[]> {
  const { resources } = azure();
  return sweep(
    async () =>
      (await resources.resourceGroups.checkExistence(AZURE_GROUP)).body
        ? [AZURE_GROUP]
        : [],
    (groups) =>
      Promise.all(
        groups.map((group) =>
          resources.resourceGroups.beginDeleteAndWait(group),
        ),
      ),
  );
}

/** Each cloud is swept even when another fails; any failure fails cleanup. */
async function cleanup(): Promise<void> {
  const clouds = { aws: cleanupAws, gcp: cleanupGcp, azure: cleanupAzure };
  const settled = await Promise.allSettled(
    Object.values(clouds).map((sweepCloud) => sweepCloud()),
  );
  const report = Object.fromEntries(
    Object.keys(clouds).map((cloud, index) => {
      const result = settled[index]!;
      return [
        cloud,
        result.status === 'fulfilled'
          ? { removed: result.value }
          : { error: String(result.reason) },
      ];
    }),
  );
  save('cleanup.json', report);
  const errors = Object.entries(report).filter(([, r]) => 'error' in r);
  if (errors.length) {
    throw new Error(
      `cleanup failed: ${errors.map(([cloud, r]) => `${cloud}: ${(r as { error: string }).error}`).join('; ')}`,
    );
  }
}

const [phase = process.env.SPIKE_PHASE ?? 'run', ...only] =
  process.argv.slice(2);
await (phase === 'cleanup' ? cleanup() : run(only));
