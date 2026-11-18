/**
 * The provider-transfer spike's clouds: each storage's and compute
 * target's credential, prices, launch and the resources cleanup owns.
 */
import { execFileSync } from 'node:child_process';
import { createSign, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  GetBucketTaggingCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { StorageManagementClient } from '@azure/arm-storage';
import { DefaultAzureCredential } from '@azure/identity';
import {
  ImagesClient,
  InstancesClient,
  protos,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import { createStorageProvider } from '../../src/api/services/cloud-config.js';
import { CloudType } from '../../src/shared/cloud.js';
import { CLOUDFLARE_API } from '../../src/shared/cloudflare-token.js';

export const TAG = { key: 'anycloud-spike', value: 'provider-transfer' };
const PREFIX = 'ac-spike-xfer-';
export const runId =
  process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex');
export const name = `${PREFIX}${runId}`;

export const AWS_REGION = 'us-east-1';
export const AZURE_REGION = 'eastus';
export const GCP_REGION = 'us-east1';
const GCP_ZONE = 'us-east1-b';
const HYPERSTACK_REGION = 'CANADA-1';
const VERDA_LOCATION = 'FIN-01';
/** Cheapest first; Lambda sells no CPU-only instance. */
const LAMBDA_TYPES = ['gpu_1x_a10', 'gpu_1x_a6000', 'gpu_1x_a100_sxm4'];

const AWS_SECRETS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const AZURE_SECRETS = [
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
];
export const GCP_SECRETS = [
  'GCP_PROJECT_ID',
  'GCP_CLIENT_EMAIL',
  'GCP_PRIVATE_KEY',
];
const NEBIUS_SECRETS = [
  'NEBIUS_SERVICE_ACCOUNT_ID',
  'NEBIUS_PUBLIC_KEY_ID',
  'NEBIUS_PRIVATE_KEY',
  'NEBIUS_PROJECT_ID',
];
const HYPERSTACK_SECRETS = ['HYPERSTACK_API_KEY'];
const VERDA_SECRETS = ['VERDA_CLIENT_ID', 'VERDA_CLIENT_SECRET'];

// List prices, USD per GB (1e9 bytes) and per 1,000 requests, from this
// experiment's research.
const GCS_EGRESS_PER_GB = 0.12 / (2 ** 30 / 1e9); // $0.12/GiB

export type StorageId = 'azure' | 'r2' | 'aws' | 'gcs';
export type ComputeId =
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'lambda'
  | 'nebius'
  | 'hyperstack'
  | 'verda';

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** SAS and presigned query strings stay out of evidence, as in the runner. */
export const redact = (text: string) => text.replace(/\?[^\s"']*/g, '?…');

const awsCredentials = () => ({
  accessKeyId: env('AWS_ACCESS_KEY_ID'),
  secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  ...(process.env.AWS_SESSION_TOKEN
    ? { sessionToken: process.env.AWS_SESSION_TOKEN }
    : {}),
});
const gcpCredentials = () => ({
  projectId: env('GCP_PROJECT_ID'),
  clientEmail: env('GCP_CLIENT_EMAIL'),
  privateKey: env('GCP_PRIVATE_KEY').replace(/\\n/g, '\n'),
});
export const gcpOptions = () => {
  const { projectId, clientEmail, privateKey } = gcpCredentials();
  return {
    projectId,
    credentials: { client_email: clientEmail, private_key: privateKey },
  };
};
export const azure = () => {
  const credential = new DefaultAzureCredential();
  const subscription = env('AZURE_SUBSCRIPTION_ID');
  return {
    compute: new ComputeManagementClient(credential, subscription),
    network: new NetworkManagementClient(credential, subscription),
    resources: new ResourceManagementClient(credential, subscription),
    storage: new StorageManagementClient(credential, subscription),
  };
};
export const r2 = () =>
  createStorageProvider({
    cloudProvider: CloudType.Cloudflare,
    credentials: {
      accountId: env('CLOUDFLARE_ACCOUNT_ID'),
      apiToken: env('CLOUDFLARE_API_TOKEN'),
    },
  });
export const productAws = () =>
  createStorageProvider({
    cloudProvider: CloudType.AWS,
    credentials: awsCredentials(),
    region: AWS_REGION,
  });
export const productGcs = () =>
  createStorageProvider({
    cloudProvider: CloudType.GCP,
    credentials: gcpCredentials(),
    region: GCP_REGION,
  });

/** One resource group holds every Azure resource, storage and VM alike. */
let azureGroup: Promise<unknown> | undefined;
export const ensureAzureGroup = () =>
  (azureGroup ??= azure().resources.resourceGroups.createOrUpdate(name, {
    location: AZURE_REGION,
    tags: { [TAG.key]: TAG.value },
  }));

const ec2 = () => new EC2Client({ region: AWS_REGION });

async function launchAws(script: string, size: string) {
  const client = ec2();
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
      InstanceType: size as never,
      NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true }],
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(script).toString('base64'),
      InstanceInitiatedShutdownBehavior: 'terminate',
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: TAG.key, Value: TAG.value },
            { Key: 'Name', Value: name },
          ],
        },
      ],
    }),
  );
  return { id: Instances[0]?.InstanceId, region: AWS_REGION, size };
}

async function launchGcp(script: string, size: string) {
  const [image] = await new ImagesClient(gcpOptions()).getFromFamily({
    project: 'ubuntu-os-cloud',
    family: 'ubuntu-2404-lts-amd64',
  });
  const [operation] = await new InstancesClient(gcpOptions()).insert({
    project: env('GCP_PROJECT_ID'),
    zone: GCP_ZONE,
    instanceResource: {
      name,
      machineType: `zones/${GCP_ZONE}/machineTypes/${size}`,
      labels: { [TAG.key]: TAG.value },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: { sourceImage: image.selfLink },
        },
      ],
      networkInterfaces: [
        { accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] },
      ],
      metadata: { items: [{ key: 'startup-script', value: script }] },
    },
  });
  await waitGcp(operation);
  return { id: name, zone: GCP_ZONE, size };
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
      project: env('GCP_PROJECT_ID'),
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

async function launchAzure(script: string, size: string) {
  const { compute, network } = azure();
  const tags = { [TAG.key]: TAG.value };
  await ensureAzureGroup();
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
  const ip = await network.publicIPAddresses.beginCreateOrUpdateAndWait(
    name,
    'spike',
    {
      location: AZURE_REGION,
      tags,
      sku: { name: 'Standard' },
      publicIPAllocationMethod: 'Static',
    },
  );
  const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
    name,
    'spike',
    {
      location: AZURE_REGION,
      tags,
      ipConfigurations: [
        {
          name: 'primary',
          subnet: { id: vnet.subnets![0]!.id },
          publicIPAddress: { id: ip.id },
        },
      ],
    },
  );
  const vm = await compute.virtualMachines.beginCreateOrUpdateAndWait(
    name,
    'spike',
    {
      location: AZURE_REGION,
      tags,
      hardwareProfile: { vmSize: size },
      osProfile: {
        computerName: 'spike',
        adminUsername: 'spike',
        // Never used: no inbound rule exists.
        adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
        customData: Buffer.from(script).toString('base64'),
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
    },
  );
  // The group is what cleanup lists and deletes.
  return { id: name, vmId: vm.vmId, region: AZURE_REGION, size };
}

/** A JSON API call; a bare-string body (Verda's IDs) comes back as is. */
async function api<T>(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${url.replace(/\?.*/, '')}: HTTP ${response.status} ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** An OpenSSH public key whose private half is discarded. */
function sshPublicKey(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'xfer-key-')), 'key');
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    name,
    '-f',
    file,
  ]);
  return readFileSync(`${file}.pub`, 'utf8').trim();
}

const lambda = <T>(method: string, path: string, body?: unknown) =>
  api<{ data: T }>(
    method,
    `https://cloud.lambda.ai/api/v1${path}`,
    {
      Authorization: `Basic ${Buffer.from(`${env('LAMBDA_API_KEY')}:`).toString('base64')}`,
    },
    body,
  ).then((response) => response.data);

/** The cheapest listed type with capacity, and its first region. */
async function lambdaPlacement(size: string) {
  const types = await lambda<
    Record<string, { regions_with_capacity_available: { name: string }[] }>
  >('GET', '/instance-types');
  const placement = size.split(',').flatMap((type) =>
    (types[type]?.regions_with_capacity_available ?? []).map((region) => ({
      type,
      region: region.name,
    })),
  )[0];
  if (!placement) throw new Error(`No Lambda capacity for ${size}`);
  return placement;
}

async function launchLambda(script: string, size: string) {
  const { type, region } = await lambdaPlacement(size);
  const { instance_ids } = await lambda<{ instance_ids: string[] }>(
    'POST',
    '/instance-operations/launch',
    {
      region_name: region,
      instance_type_name: type,
      // The product's placeholder key in the CI account (gateways/lambda.ts).
      ssh_key_names: ['anycloud-api'],
      name,
      tags: [{ key: TAG.key, value: TAG.value }],
      user_data: script,
    },
  );
  return { id: instance_ids[0], region, size: type };
}

let nebiusToken: Promise<string> | undefined;
/** A 12-hour token from a JWT signed with the service account's key. */
function nebiusAuth(): Promise<string> {
  const exchange = async () => {
    const account = env('NEBIUS_SERVICE_ACCOUNT_ID');
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT', kid: env('NEBIUS_PUBLIC_KEY_ID') })}.${part({ iss: account, sub: account, iat: now, exp: now + 300 })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(env('NEBIUS_PRIVATE_KEY').replace(/\\n/g, '\n'), 'base64url');
    const response = await fetch(
      'https://auth.eu.nebius.com:443/oauth2/token/exchange',
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          subject_token: `${unsigned}.${signature}`,
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Nebius token exchange: HTTP ${response.status}`);
    }
    return ((await response.json()) as { access_token: string }).access_token;
  };
  return (nebiusToken ??= exchange());
}

const nebius = async <T>(method: string, path: string, body?: unknown) =>
  api<T>(
    method,
    `https://api.nebius.cloud${path}`,
    { Authorization: `Bearer ${await nebiusAuth()}` },
    body,
  );

interface NebiusResource {
  metadata: { id: string; name?: string; labels?: Record<string, string> };
}

/** The project's default subnet. */
async function nebiusSubnet() {
  const { items = [] } = await nebius<{ items?: NebiusResource[] }>(
    'GET',
    `/vpc/v1/subnets?parentId=${env('NEBIUS_PROJECT_ID')}`,
  );
  if (!items[0]) throw new Error('The Nebius project has no subnet');
  return { subnetId: items[0].metadata.id };
}

async function launchNebius(script: string, size: string) {
  const [platform, preset] = size.split('/');
  const { subnetId } = await nebiusSubnet();
  const labels = { [TAG.key]: TAG.value };
  const operation = await nebius<{ id: string; resourceId?: string }>(
    'POST',
    '/compute/v1/instances',
    {
      metadata: { parentId: env('NEBIUS_PROJECT_ID'), name, labels },
      spec: {
        resources: { platform, preset },
        // Deleted with the instance.
        bootDisk: {
          attachMode: 'READ_WRITE',
          managedDisk: {
            name,
            labels,
            spec: {
              sizeGibibytes: '50',
              type: 'NETWORK_SSD',
              sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
            },
          },
        },
        networkInterfaces: [
          { name: 'eth0', subnetId, ipAddress: {}, publicIpAddress: {} },
        ],
        cloudInitUserData: script,
      },
    },
  );
  return { id: operation.resourceId, operation: operation.id, size };
}

const hyperstack = <T>(method: string, path: string, body?: unknown) =>
  api<T>(
    method,
    `https://infrahub-api.nexgencloud.com/v1${path}`,
    { api_key: env('HYPERSTACK_API_KEY') },
    body,
  );
const HYPERSTACK_IMAGE = 'Ubuntu Server 24.04 LTS R570 CUDA 12.8';

async function hyperstackPreflight(size: string) {
  const query = `region=${HYPERSTACK_REGION}`;
  const [flavors, images] = await Promise.all([
    hyperstack<unknown>('GET', `/core/flavors?${query}`),
    hyperstack<unknown>('GET', `/core/images?${query}`),
  ]);
  // Shapes vary by endpoint; the names are what must appear.
  if (!JSON.stringify(flavors).includes(`"${size}"`)) {
    throw new Error(`Hyperstack ${HYPERSTACK_REGION} lists no flavor ${size}`);
  }
  if (!JSON.stringify(images).includes(`"${HYPERSTACK_IMAGE}"`)) {
    throw new Error(`Hyperstack lists no image ${HYPERSTACK_IMAGE}`);
  }
  return { size, image: HYPERSTACK_IMAGE };
}

/** The run's own environment holds its keypair and VM. */
async function launchHyperstack(script: string, size: string) {
  await hyperstack('POST', '/core/environments', {
    name,
    region: HYPERSTACK_REGION,
  });
  await hyperstack('POST', '/core/keypairs', {
    name,
    environment_name: name,
    public_key: sshPublicKey(),
  });
  const { instances = [] } = await hyperstack<{ instances?: { id: number }[] }>(
    'POST',
    '/core/virtual-machines',
    {
      name,
      environment_name: name,
      image_name: HYPERSTACK_IMAGE,
      flavor_name: size,
      key_name: name,
      count: 1,
      assign_floating_ip: true,
      labels: [TAG.value],
      user_data: script,
    },
  );
  return { id: String(instances[0]?.id), region: HYPERSTACK_REGION, size };
}

let verdaToken: Promise<string> | undefined;
const verda = async <T>(method: string, path: string, body?: unknown) => {
  verdaToken ??= api<{ access_token: string }>(
    'POST',
    'https://api.verda.com/v1/oauth2/token',
    {},
    {
      grant_type: 'client_credentials',
      client_id: env('VERDA_CLIENT_ID'),
      client_secret: env('VERDA_CLIENT_SECRET'),
    },
  ).then((response) => response.access_token);
  return api<T>(
    method,
    `https://api.verda.com/v1${path}`,
    { Authorization: `Bearer ${await verdaToken}` },
    body,
  );
};
const VERDA_TAGS = [{ key: TAG.key, value: TAG.value }];

async function verdaPreflight(size: string) {
  const available = await verda<boolean>(
    'GET',
    `/instance-availability/${size}?location_code=${VERDA_LOCATION}`,
  );
  if (available !== true) {
    throw new Error(`Verda has no ${size} in ${VERDA_LOCATION}`);
  }
  return { size, location: VERDA_LOCATION };
}

/** SSH keys and scripts take no tags: the name prefix marks them. */
async function launchVerda(script: string, size: string) {
  const keyId = await verda<string>('POST', '/ssh-keys', {
    name,
    key: sshPublicKey(),
  });
  const scriptId = await verda<string>('POST', '/scripts', { name, script });
  const id = await verda<string>('POST', '/instances', {
    instance_type: size,
    image: 'ubuntu-24.04',
    hostname: name,
    description: name,
    location_code: VERDA_LOCATION,
    ssh_key_ids: [keyId],
    startup_script_id: scriptId,
    os_volume: { name, size: 50, tags: VERDA_TAGS },
    tags: VERDA_TAGS,
    is_spot: false,
  });
  return { id, location: VERDA_LOCATION, size };
}

// ------------------------------------------------------------------ records

/** A resource type a run creates, found by its tag, label or name prefix. */
interface Owned {
  list: () => Promise<string[]>;
  remove: (id: string) => Promise<unknown>;
}
type Call = (method: string, path: string, body?: unknown) => Promise<any>;

/** A REST collection: list it, keep what `pick` claims, delete each by ID. */
function owned(
  call: Call,
  path: () => string,
  pick: (body: any) => (string | number)[] | undefined,
  remove: (id: string) => Promise<unknown> = (id) =>
    call('DELETE', `${path().split('?')[0]}/${id}`),
): Owned {
  return {
    list: async () => (pick(await call('GET', path())) ?? []).map(String),
    remove,
  };
}

const tagged = (item: { tags?: { key: string; value: string }[] }) =>
  item.tags?.some((tag) => tag.key === TAG.key && tag.value === TAG.value);
const labelled = (item: NebiusResource) =>
  item.metadata.labels?.[TAG.key] === TAG.value;

interface HyperstackOwned {
  id: number;
  name: string;
  labels?: string[];
  environment?: { name: string };
}
const hyperstackEnvironments = async () =>
  (
    await hyperstack<{ environments?: HyperstackOwned[] }>(
      'GET',
      '/core/environments',
    )
  ).environments?.filter((item) => item.name.startsWith(PREFIX)) ?? [];

interface VerdaOwned {
  id: string;
  name?: string;
  status?: string;
  tags?: { key: string; value: string }[];
}
const verdaNamed = (path: string) =>
  owned(
    verda,
    () => path,
    (items: VerdaOwned[]) =>
      items.filter((item) => item.name?.startsWith(PREFIX)).map((i) => i.id),
  );

interface Cloud {
  secrets: string[];
  /** What cleanup deletes; a compute target's `instances` holds its launch ID. */
  owned: Record<string, Owned>;
}

interface StorageCloud extends Cloud {
  /** The compute target in the storage's own region, which pays no egress. */
  sameCloud?: ComputeId;
  egressPerGB: number;
  writePer1k: number;
  readPer1k: number;
}

export const STORAGES: Record<StorageId, StorageCloud> = {
  // Azure's resource group is the compute record's: it holds both.
  azure: {
    sameCloud: 'azure',
    egressPerGB: 0.087,
    writePer1k: 0.005,
    readPer1k: 0.0004,
    secrets: AZURE_SECRETS,
    owned: {},
  },
  // R2 buckets take no tags: the name prefix marks ownership.
  r2: {
    egressPerGB: 0,
    writePer1k: 0.0045,
    readPer1k: 0.00036,
    secrets: ['CLOUDFLARE_API_TOKEN'],
    owned: {
      buckets: owned(
        (method, path) =>
          api(method, `${CLOUDFLARE_API}${path}`, {
            Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`,
          }),
        () =>
          `/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/r2/buckets?name_contains=${PREFIX}&per_page=1000`,
        (body: { result?: { buckets?: { name: string }[] } }) =>
          body.result?.buckets
            ?.map((bucket) => bucket.name)
            .filter((bucket) => bucket.startsWith(PREFIX)),
        (id) => r2().deleteBucket(id),
      ),
    },
  },
  aws: {
    sameCloud: 'aws',
    egressPerGB: 0.09,
    writePer1k: 0.005,
    readPer1k: 0.0004,
    secrets: AWS_SECRETS,
    owned: {
      buckets: {
        list: async () => {
          const client = new S3Client({ region: AWS_REGION });
          const { Buckets = [] } = await client.send(
            new ListBucketsCommand({ Prefix: PREFIX }),
          );
          const owned: string[] = [];
          for (const { Name } of Buckets) {
            const { TagSet = [] } = await client
              .send(new GetBucketTaggingCommand({ Bucket: Name }))
              .catch((error: { name?: string }) => {
                // A bucket with no tags isn't ours.
                if (error.name === 'NoSuchTagSet') return { TagSet: [] };
                throw error;
              });
            if (TagSet.some((t) => t.Key === TAG.key && t.Value === TAG.value))
              owned.push(Name!);
          }
          return owned;
        },
        remove: (bucket) => productAws().deleteBucket(bucket),
      },
    },
  },
  // The storage under test and the evidence bucket.
  gcs: {
    sameCloud: 'gcp',
    egressPerGB: GCS_EGRESS_PER_GB,
    writePer1k: 0.005,
    readPer1k: 0.0004,
    secrets: GCP_SECRETS,
    owned: {
      buckets: {
        list: async () => {
          const [buckets] = await new Storage(gcpOptions()).getBuckets({
            prefix: PREFIX,
          });
          return buckets
            .filter((bucket) => bucket.metadata.labels?.[TAG.key] === TAG.value)
            .map((bucket) => bucket.name);
        },
        remove: async (id) => {
          const bucket = new Storage(gcpOptions()).bucket(id);
          await bucket.deleteFiles({ force: true });
          await bucket.delete();
        },
      },
    },
  },
};

interface ComputeCloud extends Cloud {
  /** The default instance type; `--size <id>=<type>` overrides it. */
  size: string;
  /** Internet egress, which a checkpoint upload to another cloud pays. */
  egressPerGB: number;
  /** Read-only checks that the launch can succeed, run before anything is created. */
  preflight?: (size: string) => Promise<Record<string, unknown>>;
  /** Returns the ID that `owned.instances` lists. */
  launch: (script: string, size: string) => Promise<{ id?: string }>;
}

export const COMPUTES: Record<ComputeId, ComputeCloud> = {
  aws: {
    size: 'm6i.xlarge',
    egressPerGB: 0.09,
    secrets: AWS_SECRETS,
    launch: launchAws,
    owned: {
      instances: {
        list: async () => {
          const { Reservations = [] } = await ec2().send(
            new DescribeInstancesCommand({
              Filters: [{ Name: `tag:${TAG.key}`, Values: [TAG.value] }],
            }),
          );
          return Reservations.flatMap((r) => r.Instances ?? [])
            .filter((i) => i.State?.Name !== 'terminated')
            .map((i) => i.InstanceId!);
        },
        remove: (id) =>
          ec2().send(new TerminateInstancesCommand({ InstanceIds: [id] })),
      },
    },
  },
  gcp: {
    size: 'e2-standard-4',
    egressPerGB: GCS_EGRESS_PER_GB,
    secrets: GCP_SECRETS,
    launch: launchGcp,
    owned: {
      instances: {
        list: async () => {
          const [list] = await new InstancesClient(gcpOptions()).list({
            project: env('GCP_PROJECT_ID'),
            zone: GCP_ZONE,
            filter: `labels.${TAG.key}=${TAG.value}`,
          });
          return list.map((instance) => instance.name!);
        },
        remove: async (instance) => {
          const [operation] = await new InstancesClient(gcpOptions()).delete({
            project: env('GCP_PROJECT_ID'),
            zone: GCP_ZONE,
            instance,
          });
          await waitGcp(operation);
        },
      },
    },
  },
  // The group holds the storage account, the VM and its network.
  azure: {
    size: 'Standard_D4s_v5',
    egressPerGB: 0.087,
    secrets: AZURE_SECRETS,
    launch: launchAzure,
    owned: {
      instances: {
        list: async () => {
          const groups: string[] = [];
          for await (const group of azure().resources.resourceGroups.list({
            filter: `tagName eq '${TAG.key}' and tagValue eq '${TAG.value}'`,
          })) {
            groups.push(group.name!);
          }
          return groups;
        },
        remove: (group) => azure().resources.resourceGroups.beginDelete(group),
      },
    },
  },
  lambda: {
    size: LAMBDA_TYPES.join(','),
    egressPerGB: 0,
    secrets: ['LAMBDA_API_KEY'],
    preflight: lambdaPlacement,
    launch: launchLambda,
    owned: {
      instances: owned(
        lambda,
        () => '/instances',
        (items: (VerdaOwned & { status: string })[]) =>
          items
            .filter((item) => item.status !== 'terminated' && tagged(item))
            .map((item) => item.id),
        (id) =>
          lambda('POST', '/instance-operations/terminate', {
            instance_ids: [id],
          }),
      ),
    },
  },
  nebius: {
    // Needs non-GPU vCPU quota in eu-north1, which defaults to 0.
    size: 'cpu-d3/4vcpu-16gb',
    // VPC traffic is free; internet egress is unconfirmed.
    egressPerGB: 0,
    secrets: NEBIUS_SECRETS,
    preflight: nebiusSubnet,
    launch: launchNebius,
    // Deleting an instance deletes its managed disk and public address;
    // leftover labelled disks are swept.
    owned: Object.fromEntries(
      (['instances', 'disks'] as const).map((kind) => [
        kind,
        owned(
          nebius,
          () => `/compute/v1/${kind}?parentId=${env('NEBIUS_PROJECT_ID')}`,
          (body: { items?: NebiusResource[] }) =>
            body.items?.filter(labelled).map((item) => item.metadata.id),
        ),
      ]),
    ),
  },
  hyperstack: {
    // Its CPU flavors have too little memory for the tmpfs.
    size: 'n3-RTX-A6000x1',
    egressPerGB: 0,
    secrets: HYPERSTACK_SECRETS,
    preflight: hyperstackPreflight,
    launch: launchHyperstack,
    // Deleting a VM releases its floating IP; the environment goes last.
    owned: {
      instances: {
        list: async () => {
          const vms: string[] = [];
          for (const environment of await hyperstackEnvironments()) {
            const { instances = [] } = await hyperstack<{
              instances?: HyperstackOwned[];
            }>(
              'GET',
              `/core/virtual-machines?environment=${encodeURIComponent(environment.name)}&exact_environment_match=true`,
            );
            vms.push(
              ...instances
                .filter((vm) => vm.labels?.includes(TAG.value))
                .map((vm) => String(vm.id)),
            );
          }
          return vms;
        },
        remove: (id) => hyperstack('DELETE', `/core/virtual-machines/${id}`),
      },
      keypairs: owned(
        hyperstack,
        () => '/core/keypairs',
        (body: { keypairs?: HyperstackOwned[] }) =>
          body.keypairs
            ?.filter((key) => key.environment?.name.startsWith(PREFIX))
            .map((key) => key.id),
        (id) => hyperstack('DELETE', `/core/keypair/${id}`),
      ),
      environments: {
        list: async () =>
          (await hyperstackEnvironments()).map((item) => String(item.id)),
        remove: (id) => hyperstack('DELETE', `/core/environments/${id}`),
      },
    },
  },
  verda: {
    size: 'CPU.4V.16G',
    // Unconfirmed.
    egressPerGB: 0,
    secrets: VERDA_SECRETS,
    preflight: verdaPreflight,
    launch: launchVerda,
    owned: {
      instances: owned(
        verda,
        () => `/instances?tag=${encodeURIComponent(`${TAG.key}=${TAG.value}`)}`,
        (items: VerdaOwned[]) =>
          items
            .filter((item) => tagged(item) && item.status !== 'discontinued')
            .map((item) => item.id),
        (id) =>
          verda('PUT', '/instances', {
            action: 'delete',
            id: [id],
            delete_permanently: true,
          }),
      ),
      volumes: owned(
        verda,
        () => '/volumes',
        (items: VerdaOwned[]) => items.filter(tagged).map((item) => item.id),
        (id) => verda('DELETE', `/volumes/${id}`, { is_permanent: true }),
      ),
      scripts: verdaNamed('/scripts'),
      'ssh-keys': verdaNamed('/ssh-keys'),
    },
  },
};
