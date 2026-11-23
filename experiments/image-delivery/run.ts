#!/usr/bin/env tsx
/**
 * Live measurement: how much each way of delivering backmesh's runner image
 * to a fresh VM Job host would win, on AWS, GCP and Azure. Every arm boots a
 * `backmesh-4`-shaped VM with the branch's own Job-host user data
 * (generateJobHostUserData, with its boot marks), changed only where the arm
 * changes delivery, then starts the image and runs a first step that reads
 * its tools. The runner's cloud CLIs make the VMs, registries and images.
 *
 * `run [cloud...] [--count=N] [--arms=a,b] [--parallel=N]` and `cleanup`.
 * Everything made is named `image-delivery-*` (ACR: `imagedelivery*`) and
 * tagged or labelled `anycloud-spike=image-delivery`; cleanup deletes by
 * that, so it needs no state from the run. Reports in SPIKE_OUTPUT_DIR hold
 * no credential.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { generateJobHostUserData } from '../../src/api/services/job-host.js';
import { RX_BYTES_FUNCTION } from '../../src/api/services/host-runtime/pull-timing.js';
import { BOOT_MARKS_PATH } from '../../src/api/services/host-runtime/boot-marks.js';
import { shellEscape } from '../../src/shared/utils.js';

const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
const state = join(process.env.RUNNER_TEMP ?? tmpdir(), 'image-delivery');
const bin = join(state, 'bin');
const PREFIX = 'image-delivery';
const TAG_KEY = 'anycloud-spike';
const TAG_VALUE = 'image-delivery';

/** backmesh v0.5.6's runner image, as in vm-boot-marks: 724 MB of zstd layers. */
const IMAGE =
  'ghcr.io/backmesh/backmesh-runner@sha256:336e995b7a00ab3c3419fbf9f1d89ec9249d297b549198c29656f6c3c16713e4';
const DIGEST = IMAGE.split('@')[1]!;

const CRANE = {
  url: 'https://github.com/google/go-containerregistry/releases/download/v0.22.1/go-containerregistry_Linux_x86_64.tar.gz',
  sha256: '0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0',
};
const BUILDX = {
  url: 'https://github.com/docker/buildx/releases/download/v0.39.1/buildx-v0.39.1.linux-amd64',
  sha256: '903090816da68f8bc1a2ff5346dd163a5adacfce4548d003c75df42cd47a9bf4',
};
const STARGZ = {
  url: 'https://github.com/containerd/stargz-snapshotter/releases/download/v0.19.1/stargz-snapshotter-v0.19.1-linux-amd64.tar.gz',
  sha256: '0e963599d7da5179810dcfaa1095e3d562660b7f6d526a9fb791a5e30f252680',
};
const STARGZ_SOCKET = '/run/containerd-stargz-grpc/containerd-stargz-grpc.sock';

/**
 * The first step: tools from the image's largest layers, and a compile, so a
 * lazy pull pays for what a job reads. BASH_ENV is cleared: the image's
 * first-use hook would install missing tools over the network.
 */
const STEP =
  'echo started $(cut -d" " -f1 /proc/uptime); node --version && npm --version && ' +
  'python3 -c "import ssl, sqlite3, json" && git --version && ' +
  'echo "int main(){return 0;}" | gcc -x c - -o /tmp/a && /tmp/a; rc=$?; ' +
  'echo stepped $(cut -d" " -f1 /proc/uptime); exit $rc';

type Source = 'ghcr' | 'regional' | 'estargz';
interface ArmSpec {
  source: Source;
  /** The transfer service's max_concurrent_downloads, instead of 3. */
  downloads?: number;
  lazy?: boolean;
  baked?: boolean;
  fastDisk?: boolean;
}
const ARMS = {
  ghcr: { source: 'ghcr' },
  regional: { source: 'regional' },
  'ghcr-c10': { source: 'ghcr', downloads: 10 },
  'regional-c10': { source: 'regional', downloads: 10 },
  lazy: { source: 'estargz', lazy: true },
  baked: { source: 'ghcr', baked: true },
  'fast-disk': { source: 'ghcr', fastDisk: true },
} satisfies Record<string, ArmSpec>;
type Arm = keyof typeof ARMS;

interface Registry {
  host: string;
  repo: string;
  user: string;
  password: () => Promise<string>;
}
interface Launched {
  id: string;
  ip: string;
  vmType: string;
  zone?: string;
}
interface Cloud {
  /** Signs in and finds the account. */
  login(): Promise<void>;
  /** What the VMs need to take SSH. */
  setup(runId: string): Promise<void>;
  /** The same-region registry. */
  registry(runId: string): Promise<Registry>;
  launch(
    name: string,
    userDataFile: string,
    opts: { fastDisk?: boolean; baked?: boolean; noResourceDisk?: boolean },
  ): Promise<Launched>;
  remove(vm: Launched): Promise<void>;
  /** Stops a prepared VM and makes the baked image from its disk. */
  bake(vm: Launched, runId: string): Promise<void>;
  /** Deletes everything the experiment made; returns what is left. */
  cleanup(): Promise<string[]>;
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

const toolEnv = () => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  CLOUDSDK_CONFIG: join(state, 'gcloud'),
  CLOUDSDK_CORE_PROJECT: process.env.GCP_PROJECT_ID ?? '',
  CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
  AZURE_CONFIG_DIR: join(state, 'azure'),
  DOCKER_CONFIG: join(state, 'docker'),
  AWS_DEFAULT_REGION: 'us-east-2',
  AWS_PAGER: '',
});

/** One command; its stdout. Errors name the command, never its arguments' secrets. */
function sh(
  cmd: string,
  args: string[],
  {
    input,
    timeoutMs = 20 * 60_000,
  }: { input?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: toolEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `${cmd} ${args.slice(0, 3).join(' ')} exited ${code}: ${(stderr || stdout).trim().slice(-800)}`,
          ),
        );
    });
    child.stdin.end(input ?? '');
  });
}

const json = async <T = any>(cmd: string, args: string[]): Promise<T> => {
  const out = await sh(cmd, args);
  return (out ? JSON.parse(out) : null) as T;
};

/** Retries `fn` while it fails with an error matching `retry`. */
async function retrying<T>(
  fn: () => Promise<T>,
  retry: RegExp,
  attempts = 20,
  delayMs = 10_000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !retry.test(String(error))) throw error;
      await sleep(delayMs);
    }
  }
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

// ---------------------------------------------------------------- AWS

const AWS_TAGS = (type: string, name: string) =>
  `ResourceType=${type},Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=Name,Value=${name}}]`;

function awsCloud(): Cloud {
  const ec2 = (args: string[]) =>
    json('aws', ['ec2', ...args, '--output', 'json']);
  let ami = '';
  let rootDevice = '/dev/sda1';
  let baked = '';
  let group = '';
  return {
    async login() {
      required('AWS_ACCESS_KEY_ID');
      const images = await ec2([
        'describe-images',
        '--owners',
        '099720109477',
        '--filters',
        'Name=name,Values=ubuntu-minimal/images/hvm-ssd*/ubuntu-noble-24.04-amd64-minimal-*',
        'Name=state,Values=available',
      ]);
      const latest = images.Images.sort((a: any, b: any) =>
        b.CreationDate.localeCompare(a.CreationDate),
      )[0];
      ami = latest.ImageId;
      rootDevice = latest.RootDeviceName;
    },
    async setup(runId) {
      const vpcs = await ec2([
        'describe-vpcs',
        '--filters',
        'Name=isDefault,Values=true',
      ]);
      const vpc = vpcs.Vpcs[0]?.VpcId;
      if (!vpc) throw new Error('us-east-2 has no default VPC');
      group = (
        await ec2([
          'create-security-group',
          '--group-name',
          `${PREFIX}-${runId}`,
          '--description',
          'image-delivery spike: SSH',
          '--vpc-id',
          vpc,
          '--tag-specifications',
          AWS_TAGS('security-group', `${PREFIX}-${runId}`),
        ])
      ).GroupId;
      await ec2([
        'authorize-security-group-ingress',
        '--group-id',
        group,
        '--protocol',
        'tcp',
        '--port',
        '22',
        '--cidr',
        '0.0.0.0/0',
      ]);
    },
    async registry(runId) {
      const repo = `${PREFIX}-${runId}/runner`;
      const created = await json('aws', [
        'ecr',
        'create-repository',
        '--repository-name',
        repo,
        '--tags',
        `Key=${TAG_KEY},Value=${TAG_VALUE}`,
        '--output',
        'json',
      ]);
      return {
        host: created.repository.repositoryUri.split('/')[0],
        repo,
        user: 'AWS',
        password: () => sh('aws', ['ecr', 'get-login-password']),
      };
    },
    async launch(name, userDataFile, { fastDisk, baked: fromBaked }) {
      let lastError: unknown;
      for (const vmType of ['m8i.xlarge', 'm7i.xlarge', 'm7a.xlarge']) {
        try {
          const out = await ec2([
            'run-instances',
            '--image-id',
            fromBaked ? baked : ami,
            '--instance-type',
            vmType,
            '--security-group-ids',
            group,
            '--user-data',
            `file://${userDataFile}`,
            '--block-device-mappings',
            JSON.stringify([
              {
                DeviceName: rootDevice,
                // backmesh-4's gp3; the fast arm takes gp3's ceiling for 100 GB.
                Ebs: {
                  VolumeSize: 100,
                  VolumeType: 'gp3',
                  Iops: fastDisk ? 16_000 : 4_000,
                  Throughput: fastDisk ? 1_000 : 500,
                  DeleteOnTermination: true,
                },
              },
            ]),
            '--metadata-options',
            'HttpTokens=required',
            '--tag-specifications',
            AWS_TAGS('instance', name),
            AWS_TAGS('volume', name),
          ]);
          const id = out.Instances[0].InstanceId as string;
          for (;;) {
            const described = await retrying(
              () => ec2(['describe-instances', '--instance-ids', id]),
              /InvalidInstanceID/,
            );
            const ip = described.Reservations[0].Instances[0].PublicIpAddress;
            if (ip) return { id, ip, vmType };
            await sleep(2_000);
          }
        } catch (error) {
          lastError = error;
          if (!/InsufficientInstanceCapacity|Unsupported/.test(String(error)))
            throw error;
        }
      }
      throw lastError;
    },
    async remove(vm) {
      await ec2(['terminate-instances', '--instance-ids', vm.id]);
    },
    async bake(vm, runId) {
      await ec2(['stop-instances', '--instance-ids', vm.id]);
      await sh('aws', [
        'ec2',
        'wait',
        'instance-stopped',
        '--instance-ids',
        vm.id,
      ]);
      baked = (
        await ec2([
          'create-image',
          '--instance-id',
          vm.id,
          '--name',
          `${PREFIX}-${runId}-baked`,
          '--tag-specifications',
          AWS_TAGS('image', `${PREFIX}-${runId}-baked`),
          AWS_TAGS('snapshot', `${PREFIX}-${runId}-baked`),
        ])
      ).ImageId;
      for (let i = 0; i < 180; i++) {
        const images = await ec2(['describe-images', '--image-ids', baked]);
        const imageState = images.Images[0]?.State;
        if (imageState === 'available') return;
        if (imageState === 'failed') throw new Error('AMI creation failed');
        await sleep(10_000);
      }
      throw new Error('AMI never became available');
    },
    async cleanup() {
      const tag = `Name=tag:${TAG_KEY},Values=${TAG_VALUE}`;
      const instances = async () =>
        (
          await ec2([
            'describe-instances',
            '--filters',
            tag,
            'Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down',
          ])
        ).Reservations.flatMap((r: any) =>
          r.Instances.map((i: any) => i.InstanceId as string),
        ) as string[];
      const live = await instances();
      if (live.length) {
        await ec2(['terminate-instances', '--instance-ids', ...live]);
        await sh('aws', [
          'ec2',
          'wait',
          'instance-terminated',
          '--instance-ids',
          ...live,
        ]);
      }
      const images = async () =>
        (
          await ec2(['describe-images', '--owners', 'self', '--filters', tag])
        ).Images.map((i: any) => i.ImageId as string) as string[];
      for (const image of await images())
        await ec2(['deregister-image', '--image-id', image]);
      const snapshots = async () =>
        (
          await ec2([
            'describe-snapshots',
            '--owner-ids',
            'self',
            '--filters',
            tag,
          ])
        ).Snapshots.map((s: any) => s.SnapshotId as string) as string[];
      for (const snapshot of await snapshots())
        await ec2(['delete-snapshot', '--snapshot-id', snapshot]);
      const groups = async () =>
        (
          await ec2([
            'describe-security-groups',
            '--filters',
            `Name=group-name,Values=${PREFIX}-*`,
          ])
        ).SecurityGroups.map((g: any) => g.GroupId as string) as string[];
      for (const id of await groups())
        await retrying(
          () => ec2(['delete-security-group', '--group-id', id]),
          /DependencyViolation/,
          30,
        );
      const repos = async () =>
        (
          await json('aws', [
            'ecr',
            'describe-repositories',
            '--output',
            'json',
          ])
        ).repositories
          .map((r: any) => r.repositoryName as string)
          .filter((name: string) => name.startsWith(`${PREFIX}-`)) as string[];
      for (const repo of await repos())
        await sh('aws', [
          'ecr',
          'delete-repository',
          '--repository-name',
          repo,
          '--force',
        ]);
      return [
        ...(await instances()).map((id) => `aws instance ${id}`),
        ...(await images()).map((id) => `aws image ${id}`),
        ...(await snapshots()).map((id) => `aws snapshot ${id}`),
        ...(await groups()).map((id) => `aws security group ${id}`),
        ...(await repos()).map((id) => `aws ECR repository ${id}`),
      ];
    },
  };
}

// ---------------------------------------------------------------- GCP

const GCP_REGION = 'us-east4';

function gcpCloud(): Cloud {
  const gcloud = (args: string[]) =>
    json('gcloud', [...args, '--format=json', '--quiet']);
  let bakedImage = '';
  const project = () => required('GCP_PROJECT_ID');
  return {
    async login() {
      const keyFile = join(state, 'gcp-key.json');
      writeFileSync(
        keyFile,
        JSON.stringify({
          type: 'service_account',
          project_id: project(),
          client_email: required('GCP_CLIENT_EMAIL'),
          private_key: required('GCP_PRIVATE_KEY').replace(/\\n/g, '\n'),
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
        { mode: 0o600 },
      );
      await sh('gcloud', [
        'auth',
        'activate-service-account',
        `--key-file=${keyFile}`,
      ]);
    },
    async setup() {},
    async registry(runId) {
      await gcloud([
        'artifacts',
        'repositories',
        'create',
        `${PREFIX}-${runId}`,
        '--repository-format=docker',
        `--location=${GCP_REGION}`,
        `--labels=${TAG_KEY}=${TAG_VALUE}`,
      ]);
      return {
        host: `${GCP_REGION}-docker.pkg.dev`,
        repo: `${project()}/${PREFIX}-${runId}/runner`,
        user: 'oauth2accesstoken',
        password: () => sh('gcloud', ['auth', 'print-access-token']),
      };
    },
    async launch(name, userDataFile, { fastDisk, baked }) {
      let lastError: unknown;
      for (const zone of ['a', 'b', 'c'].map((z) => `${GCP_REGION}-${z}`)) {
        for (const vmType of ['n2-standard-4', 'n2d-standard-4']) {
          try {
            const [vm] = await gcloud([
              'compute',
              'instances',
              'create',
              name,
              `--zone=${zone}`,
              `--machine-type=${vmType}`,
              // The product's VM Jobs network, and its standing SSH rule's tag:
              // the CI account can make networks but not delete them.
              '--network=anycloud-jobs',
              '--tags=anycloud-jobs',
              '--boot-disk-size=100GB',
              // The API's default type, which the product's medium tier on
              // n2 leaves in place; `--disk-tier high` asks for pd-ssd.
              `--boot-disk-type=${fastDisk ? 'pd-ssd' : 'pd-standard'}`,
              ...(baked
                ? [`--image=${bakedImage}`]
                : [
                    '--image-family=ubuntu-minimal-2404-lts-amd64',
                    '--image-project=ubuntu-os-cloud',
                  ]),
              `--metadata-from-file=user-data=${userDataFile}`,
              `--labels=${TAG_KEY}=${TAG_VALUE}`,
            ]);
            return {
              id: name,
              ip: vm.networkInterfaces[0].accessConfigs[0].natIP,
              vmType,
              zone,
            };
          } catch (error) {
            lastError = error;
            if (
              !/RESOURCE_POOL_EXHAUSTED|enough resources|not available in zone|does not exist in zone/i.test(
                String(error),
              )
            )
              throw error;
          }
        }
      }
      throw lastError;
    },
    async remove(vm) {
      await gcloud([
        'compute',
        'instances',
        'delete',
        vm.id,
        `--zone=${vm.zone}`,
      ]);
    },
    async bake(vm, runId) {
      await gcloud([
        'compute',
        'instances',
        'stop',
        vm.id,
        `--zone=${vm.zone}`,
      ]);
      bakedImage = `${PREFIX}-${runId}-baked`;
      await gcloud([
        'compute',
        'images',
        'create',
        bakedImage,
        `--source-disk=${vm.id}`,
        `--source-disk-zone=${vm.zone}`,
        `--labels=${TAG_KEY}=${TAG_VALUE}`,
      ]);
    },
    async cleanup() {
      const filter = `--filter=name~^${PREFIX}-`;
      const instances = async () =>
        ((await gcloud(['compute', 'instances', 'list', filter])) as any[]).map(
          (i) => ({
            name: i.name as string,
            zone: (i.zone as string).split('/').pop()!,
          }),
        );
      await Promise.all(
        (await instances()).map((i) =>
          gcloud([
            'compute',
            'instances',
            'delete',
            i.name,
            `--zone=${i.zone}`,
          ]),
        ),
      );
      const list = async (kind: string[]) =>
        ((await gcloud([...kind, 'list', filter])) as any[]).map(
          (r) => r.name as string,
        );
      const images = ['compute', 'images'];
      const firewalls = ['compute', 'firewall-rules'];
      const networks = ['compute', 'networks'];
      // Earlier runs made their own networks; the list below reports any
      // this account can't delete.
      for (const kind of [images, firewalls, networks])
        for (const name of await list(kind))
          await gcloud([...kind, 'delete', name]).catch((error) =>
            console.warn(String(error)),
          );
      // With the Artifact Registry API disabled there are none.
      const repos = async () =>
        (
          ((await gcloud([
            'artifacts',
            'repositories',
            'list',
            `--location=${GCP_REGION}`,
          ]).catch((error: unknown) => {
            if (
              /SERVICE_DISABLED|has no attribute 'content'/.test(String(error))
            )
              return [];
            throw error;
          })) ?? []) as any[]
        )
          .map((r) => (r.name as string).split('/').pop()!)
          .filter((name) => name.startsWith(`${PREFIX}-`));
      for (const repo of await repos())
        await gcloud([
          'artifacts',
          'repositories',
          'delete',
          repo,
          `--location=${GCP_REGION}`,
        ]);
      return [
        ...(await instances()).map((i) => `gcp instance ${i.name}`),
        ...(await list(images)).map((n) => `gcp image ${n}`),
        ...(await list(firewalls)).map((n) => `gcp firewall ${n}`),
        ...(await list(networks)).map((n) => `gcp network ${n}`),
        ...(await repos()).map((n) => `gcp repository ${n}`),
      ];
    },
  };
}

// ---------------------------------------------------------------- Azure

const AZURE_REGION = 'eastus2';

function azureCloud(): Cloud {
  const az = (args: string[]) => json('az', [...args, '--output', 'json']);
  let group = '';
  let bakedImage = '';
  // Azure's admin key must differ from the run's: cloud-init gives root the
  // admin key behind a "log in as" command, which would shadow the run's.
  const publicKeyFile = join(state, 'admin-key.pub');
  return {
    async login() {
      await sh('az', [
        'login',
        '--service-principal',
        '--username',
        required('AZURE_CLIENT_ID'),
        '--password',
        required('AZURE_CLIENT_SECRET'),
        '--tenant',
        required('AZURE_TENANT_ID'),
        '--output',
        'none',
      ]);
      await sh('az', [
        'account',
        'set',
        '--subscription',
        required('AZURE_SUBSCRIPTION_ID'),
      ]);
    },
    async setup(runId) {
      group = `${PREFIX}-${runId}`;
      await az([
        'group',
        'create',
        '--name',
        group,
        '--location',
        AZURE_REGION,
        '--tags',
        `${TAG_KEY}=${TAG_VALUE}`,
      ]);
      await az([
        'network',
        'vnet',
        'create',
        '-g',
        group,
        '--name',
        'net',
        '--address-prefix',
        '10.80.0.0/16',
        '--subnet-name',
        'sub',
        '--subnet-prefix',
        '10.80.0.0/20',
      ]);
      await az(['network', 'nsg', 'create', '-g', group, '--name', 'nsg']);
      await az([
        'network',
        'nsg',
        'rule',
        'create',
        '-g',
        group,
        '--nsg-name',
        'nsg',
        '--name',
        'ssh',
        '--priority',
        '100',
        '--protocol',
        'Tcp',
        '--destination-port-ranges',
        '22',
        '--access',
        'Allow',
      ]);
    },
    async registry(runId) {
      const name = `imagedelivery${runId}`;
      const registry = await az([
        'acr',
        'create',
        '-g',
        group,
        '--name',
        name,
        '--sku',
        'Standard',
        '--tags',
        `${TAG_KEY}=${TAG_VALUE}`,
      ]);
      return {
        host: registry.loginServer,
        repo: 'runner',
        user: '00000000-0000-0000-0000-000000000000',
        password: async () =>
          (await az(['acr', 'login', '--name', name, '--expose-token']))
            .accessToken,
      };
    },
    async launch(name, userDataFile, { fastDisk, baked, noResourceDisk }) {
      // A baked image can't keep its stores on Standard_D4ads_v5's resource
      // disk, which is empty at boot: it, and its builder, take the size
      // with none.
      const vmType = noResourceDisk ? 'Standard_D4as_v5' : 'Standard_D4ads_v5';
      const vm = await az([
        'vm',
        'create',
        '-g',
        group,
        '--name',
        name,
        '--image',
        baked ? bakedImage : 'canonical:ubuntu-24_04-lts:minimal:latest',
        '--size',
        vmType,
        '--os-disk-size-gb',
        '100',
        '--storage-sku',
        fastDisk ? 'Premium_LRS' : 'Standard_LRS',
        '--custom-data',
        userDataFile,
        '--vnet-name',
        'net',
        '--subnet',
        'sub',
        '--nsg',
        'nsg',
        '--public-ip-sku',
        'Standard',
        '--admin-username',
        'spike',
        '--ssh-key-values',
        publicKeyFile,
        '--os-disk-delete-option',
        'Delete',
        '--nic-delete-option',
        'Delete',
        '--tags',
        `${TAG_KEY}=${TAG_VALUE}`,
      ]);
      return { id: name, ip: vm.publicIpAddress, vmType };
    },
    async remove(vm) {
      await sh('az', [
        'vm',
        'delete',
        '-g',
        group,
        '--name',
        vm.id,
        '--yes',
        '--no-wait',
      ]);
    },
    async bake(vm, runId) {
      await az(['vm', 'deallocate', '-g', group, '--name', vm.id]);
      await sh('az', ['vm', 'generalize', '-g', group, '--name', vm.id]);
      bakedImage = (
        await az([
          'image',
          'create',
          '-g',
          group,
          '--name',
          `${PREFIX}-${runId}-baked`,
          '--source',
          vm.id,
          '--hyper-v-generation',
          'V2',
          '--tags',
          `${TAG_KEY}=${TAG_VALUE}`,
        ])
      ).id;
    },
    async cleanup() {
      const groups = async () =>
        (
          (await az([
            'group',
            'list',
            '--tag',
            `${TAG_KEY}=${TAG_VALUE}`,
          ])) as any[]
        ).map((g) => g.name as string);
      await Promise.all(
        (await groups()).map((name) =>
          sh('az', ['group', 'delete', '--name', name, '--yes'], {
            timeoutMs: 18 * 60_000,
          }),
        ),
      );
      return (await groups()).map((name) => `azure resource group ${name}`);
    },
  };
}

// ---------------------------------------------------------------- the host side

type CloudName = 'aws' | 'gcp' | 'azure';
const CLOUDS: Record<CloudName, { cloud: Cloud; mirror: string }> = {
  aws: { cloud: awsCloud(), mirror: 'us-east-2.ec2' },
  gcp: { cloud: gcpCloud(), mirror: `${GCP_REGION}.gce` },
  azure: { cloud: azureCloud(), mirror: 'azure' },
};

/** `text` with `find` replaced; it must occur exactly once. */
function once(text: string, find: string, replacement: string): string {
  const parts = text.split(find);
  if (parts.length !== 2)
    throw new Error(`Expected one ${JSON.stringify(find)} in the user data`);
  return parts.join(replacement);
}

/** A command that writes `content` to `path`, gzipped in transit: AWS caps user data at 16 KB. */
const writeFile = (path: string, content: string) =>
  `echo ${gzipSync(content).toString('base64')} | base64 -d | gunzip > ${path}`;

/** Starts `script` in its own unit at once, as the product's preparation does. */
const startUnit = (unit: string, script: string) =>
  `${writeFile(`/run/${unit}.sh`, script)}; ` +
  `systemd-run --no-block --unit=${unit} -p DefaultDependencies=no /bin/bash /run/${unit}.sh`;

const mark = (name: string) =>
  `echo "${name} $(cut -d' ' -f1 /proc/uptime)" >> ${BOOT_MARKS_PATH}`;

/**
 * Waits for the product's preparation, then starts the image and its first
 * step at once: the API's own steps are left out, so `container-started` is
 * when the host could start it. A lazy arm pulls here, through
 * stargz-snapshotter, once Docker (and so containerd) is up.
 */
function measureScript(image: string, lazyCredentials: string | null): string {
  const run = lazyCredentials
    ? `until [ -S ${STARGZ_SOCKET} ]; do sleep 0.2; [ $SECONDS -lt 600 ] || fail no-stargz; done
rx=$(ac_rx)
${mark('pull-start')}
ctr-remote -n spike images rpull --user ${shellEscape(lazyCredentials)} "$IMAGE" > $O/pull.log 2>&1 || fail rpull
${mark('pull-end')}
echo "pull-bytes $(($(ac_rx) - rx))" >> ${BOOT_MARKS_PATH}
rx=$(ac_rx)
${mark('container-run')}
ctr -n spike run --rm --snapshotter stargz --env BASH_ENV= "$IMAGE" step bash -c "$STEP" > $O/step.log 2>&1`
    : `until [ -s $P/pull ]; do sleep 0.2; [ $SECONDS -lt 600 ] || fail no-pull; done
rx=$(ac_rx)
${mark('container-run')}
docker run --rm --entrypoint bash -e BASH_ENV= "$IMAGE" -c "$STEP" > $O/step.log 2>&1`;
  return `#!/bin/bash
set -u
P=/run/anycloud/prepare O=/run/spike IMAGE=${shellEscape(image)} STEP=${shellEscape(STEP)}
mkdir -p $O /run/anycloud
${RX_BYTES_FUNCTION}
fail() { echo "$1" > $O/error; touch $O/done; exit 1; }
until [ -s $P/docker ]; do sleep 0.2; [ $SECONDS -lt 600 ] || fail no-docker; done
[ "$(cat $P/docker)" = 0 ] || fail docker
${run}
echo $? > $O/step-rc
echo "step-bytes $(($(ac_rx) - rx))" >> ${BOOT_MARKS_PATH}
awk '$1 == "started" || $1 == "stepped" { print "container-" $1, $2 }' $O/step.log >> ${BOOT_MARKS_PATH}
touch $O/done
`;
}

/** Installs and runs stargz-snapshotter, alongside the product's preparation. */
const STARGZ_SCRIPT = `#!/bin/bash
set -u
mkdir -p /run/anycloud /run/spike /etc/containerd-stargz-grpc ${STARGZ_SOCKET.replace(/\/[^/]+$/, '')}
{
  curl -fsSL --retry 5 ${STARGZ.url} -o /tmp/stargz.tgz &&
    echo "${STARGZ.sha256}  /tmp/stargz.tgz" | sha256sum -c - &&
    tar -xzf /tmp/stargz.tgz -C /usr/local/bin containerd-stargz-grpc ctr-remote &&
    touch /etc/containerd-stargz-grpc/config.toml
} > /run/spike/stargz.log 2>&1 || exit 1
${mark('stargz-installed')}
modprobe fuse 2>/dev/null
DOCKER_CONFIG=/etc/spike-docker exec /usr/local/bin/containerd-stargz-grpc \\
  --address ${STARGZ_SOCKET} --config /etc/containerd-stargz-grpc/config.toml >> /run/spike/stargz.log 2>&1
`;

interface Pull {
  ref: string;
  /** A same-region registry's host and credentials. */
  registry?: { host: string; user: string; password: string; header: string };
}

/**
 * The product's Job-host user data for `pull.ref`, changed only where `arm`
 * changes delivery, with the measurement started beside it.
 */
function userData(arm: Arm, pull: Pull, mirror: string, publicKey: string) {
  const spec: ArmSpec = ARMS[arm];
  const raw = generateJobHostUserData(
    { publicKey, privateKey: '' },
    { prePullImage: spec.lazy ? null : pull.ref, ubuntuMirror: mirror },
  );
  const config = JSON.parse(raw.replace(/^#cloud-config\n/, '')) as {
    bootcmd: string[][];
  };
  const command = config.bootcmd[0]![2]!;
  const encoded = /echo ([A-Za-z0-9+/=]{100,}) \| base64 -d \| gunzip/.exec(
    command,
  )![1]!;
  let script = gunzipSync(Buffer.from(encoded, 'base64')).toString();
  const spike: string[] = ['mkdir -p /run/spike'];
  if (spec.downloads)
    script = once(
      script,
      'max_concurrent_downloads = 3',
      `max_concurrent_downloads = ${spec.downloads}`,
    );
  if (spec.lazy) {
    script = once(
      script,
      '\nCONFIG_EOF',
      `\n\n[proxy_plugins.stargz]\n  type = "snapshot"\n  address = "${STARGZ_SOCKET}"\nCONFIG_EOF`,
    );
    const { host, user, password } = pull.registry!;
    spike.push(
      `mkdir -p /etc/spike-docker && ${writeFile('/etc/spike-docker/config.json', JSON.stringify({ auths: { [host]: { auth: b64(`${user}:${password}`) } } }))}`,
      startUnit('spike-stargz', STARGZ_SCRIPT),
    );
  } else if (pull.registry) {
    // The transfer pull reads the registry's credentials from a hosts
    // directory, as the product's GHCR login does.
    const { host, header } = pull.registry;
    script = once(
      script,
      'images pull --snapshotter "$AC_SNAPSHOTTER" "$AC_PULL_IMAGE"',
      'images pull --snapshotter "$AC_SNAPSHOTTER" --hosts-dir /etc/spike-hosts "$AC_PULL_IMAGE"',
    );
    const hosts = `server = "https://${host}"\ncapabilities = ["pull", "resolve"]\n\n[header]\n  authorization = "${header}"\n`;
    spike.push(
      `mkdir -p /etc/spike-hosts/${host} && ${writeFile(`/etc/spike-hosts/${host}/hosts.toml`, hosts)}`,
    );
  }
  spike.push(
    startUnit(
      'spike-measure',
      measureScript(
        pull.ref,
        spec.lazy ? `${pull.registry!.user}:${pull.registry!.password}` : null,
      ),
    ),
  );
  config.bootcmd = [
    ['sh', '-c', spike.join('; ')],
    ['sh', '-c', command.replace(encoded, gzipSync(script).toString('base64'))],
  ];
  return `#cloud-config\n${JSON.stringify(config)}\n`;
}

/** The header a pull sends to `host`: Basic, or a pull-scoped bearer token. */
async function pullHeader(
  host: string,
  repo: string,
  user: string,
  password: string,
): Promise<string> {
  const basic = `Basic ${b64(`${user}:${password}`)}`;
  const challenge =
    (await fetch(`https://${host}/v2/`)).headers.get('www-authenticate') ?? '';
  if (!/^bearer/i.test(challenge)) return basic;
  const realm = new URL(/realm="([^"]+)"/i.exec(challenge)![1]!);
  const service = /service="([^"]+)"/i.exec(challenge)?.[1];
  if (service) realm.searchParams.set('service', service);
  realm.searchParams.set('scope', `repository:${repo}:pull`);
  const response = await fetch(realm, { headers: { authorization: basic } });
  if (!response.ok)
    throw new Error(`${host} token exchange failed: ${response.status}`);
  const body = (await response.json()) as {
    token?: string;
    access_token?: string;
  };
  return `Bearer ${body.token ?? body.access_token}`;
}

// ---------------------------------------------------------------- collecting

const SSH_COLLECT = `for _ in $(seq 660); do [ -e /run/spike/done ] && break; sleep 1; done
[ -e /run/spike/done ] || echo "unfinished yes"
echo "clock $(date +%s.%N) $(cut -d' ' -f1 /proc/uptime)"
cat ${BOOT_MARKS_PATH}
for f in method pull docker; do echo "prepare-$f $(cat /run/anycloud/prepare/$f 2>/dev/null || echo -)"; done
echo "step-rc $(cat /run/spike/step-rc 2>/dev/null || echo -)"
echo "error $(cat /run/spike/error 2>/dev/null || echo -)"
echo ---
tail -c 1500 /run/spike/step.log /run/spike/pull.log /run/spike/stargz.log /run/anycloud/prepare/pull.log /run/anycloud/prepare/docker-install.log 2>/dev/null
[ -e /run/spike/done ] || systemctl status anycloud-prepare spike-measure --no-pager 2>&1 | tail -30
true`;

function ssh(ip: string, command: string, timeoutMs: number) {
  return sh(
    'ssh',
    [
      '-i',
      join(state, 'key'),
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'LogLevel=ERROR',
      `root@${ip}`,
      command,
    ],
    { timeoutMs },
  );
}

/** Waits for the measurement to finish, then reads it over SSH. */
async function collect(ip: string): Promise<string> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      return await ssh(ip, SSH_COLLECT, 12.5 * 60_000);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(3_000);
    }
  }
}

interface Trial {
  cloud: CloudName;
  arm: Arm;
  rep: number;
  name: string;
  vmType?: string;
  launchedAt: number;
  kernelAt?: number;
  marks: Record<string, number>;
  facts: Record<string, string>;
  tail?: string;
  error?: string;
}

function parse(trial: Trial, text: string) {
  const [head = '', tail = ''] = text.split('\n---\n');
  for (const line of head.split('\n')) {
    const [name = '', ...values] = line.trim().split(/\s+/);
    if (name === 'clock') {
      trial.kernelAt = Number(values[0]) - Number(values[1]);
    } else if (
      !/^(prepare-|step-rc$|error$)/.test(name) &&
      values.length === 1 &&
      /^-?\d+(\.\d+)?$/.test(values[0]!)
    ) {
      trial.marks[name] = Number(values[0]);
    } else if (name) {
      trial.facts[name] = values.join(' ');
    }
  }
  trial.tail = tail;
}

/** Runs `fn` with at most `size` running at once, first come first served. */
function limiter(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < size) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// ---------------------------------------------------------------- summary

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (value: number | null, digits = 1) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Each trial's figures, in seconds unless named otherwise. */
function figures(t: Trial) {
  const m = t.marks;
  const pull =
    'pull-start' in m && 'pull-end' in m
      ? m['pull-end']! - m['pull-start']!
      : null;
  const launchToKernel =
    t.kernelAt === undefined ? null : t.kernelAt - t.launchedAt;
  const kernelToStepEnd = m['container-stepped'] ?? null;
  return {
    ok: t.facts['step-rc'] === '0' && 'container-started' in m,
    pull,
    pullMB: 'pull-bytes' in m ? m['pull-bytes']! / 1e6 : null,
    pullMBps: pull && 'pull-bytes' in m ? m['pull-bytes']! / 1e6 / pull : null,
    stepMB: 'step-bytes' in m ? m['step-bytes']! / 1e6 : null,
    dockerReady: m['docker-ready'] ?? null,
    kernelToContainer: m['container-started'] ?? null,
    firstStep:
      'container-stepped' in m && 'container-started' in m
        ? m['container-stepped']! - m['container-started']!
        : null,
    launchToKernel,
    launchToStepEnd:
      launchToKernel !== null && kernelToStepEnd !== null
        ? launchToKernel + kernelToStepEnd
        : null,
  };
}
type Figures = ReturnType<typeof figures>;
const FIGURES: (keyof Omit<Figures, 'ok'>)[] = [
  'pull',
  'pullMB',
  'pullMBps',
  'stepMB',
  'dockerReady',
  'kernelToContainer',
  'firstStep',
  'launchToKernel',
  'launchToStepEnd',
];

function summarize(trials: Trial[]) {
  const byCloud: Record<
    string,
    {
      arms: Record<string, Record<string, number | null>>;
      landed: Record<string, string>;
    }
  > = {};
  for (const cloud of [...new Set(trials.map((t) => t.cloud))]) {
    const arms: Record<string, Record<string, number | null>> = {};
    const landed: Record<string, string> = {};
    for (const arm of [...new Set(trials.map((t) => t.arm))]) {
      const all = trials.filter((t) => t.cloud === cloud && t.arm === arm);
      const ok = all.map(figures).filter((f) => f.ok);
      // Each VM type the arm's trials landed on, and how many.
      const types = new Map<string, number>();
      for (const t of all)
        types.set(t.vmType ?? '—', (types.get(t.vmType ?? '—') ?? 0) + 1);
      landed[arm] = [...types].map(([type, n]) => `${type}×${n}`).join(' ');
      arms[arm] = {
        trials: all.length,
        ok: ok.length,
        // Each VM type a trial landed on, and how many.
        ...Object.fromEntries(
          FIGURES.map((key) => [
            key,
            round(
              median(ok.flatMap((f) => (f[key] === null ? [] : [f[key]!]))),
            ),
          ]),
        ),
      };
    }
    const base = arms.ghcr;
    for (const values of Object.values(arms)) {
      for (const key of ['launchToStepEnd', 'kernelToContainer'] as const) {
        values[`${key}Win`] =
          base?.[key] != null && values[key] != null
            ? round(base[key]! - values[key]!)
            : null;
      }
    }
    byCloud[cloud] = { arms, landed };
  }
  return byCloud;
}

function table(summary: ReturnType<typeof summarize>): string {
  const rows = [
    '| Cloud | Arm | VM types | ok | pull s | pull MB | MB/s | kernel→container s | first step s | launch→kernel s | launch→step end s | win s |',
    '| ----- | --- | -------- | -- | ------ | ------- | ---- | ------------------ | ------------ | --------------- | ----------------- | ----- |',
  ];
  for (const [cloud, { arms, landed }] of Object.entries(summary))
    for (const [arm, v] of Object.entries(arms))
      rows.push(
        `| ${cloud} | ${arm} | ${landed[arm]} | ${v.ok}/${v.trials} | ${v.pull ?? '—'} | ${v.pullMB ?? '—'} | ${v.pullMBps ?? '—'} | ${v.kernelToContainer ?? '—'} | ${v.firstStep ?? '—'} | ${v.launchToKernel ?? '—'} | ${v.launchToStepEnd ?? '—'} | ${v.launchToStepEndWin ?? '—'} |`,
      );
  return `${rows.join('\n')}\n`;
}

// ---------------------------------------------------------------- run

async function installTools() {
  mkdirSync(join(state, 'docker', 'cli-plugins'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fetchChecked = async (
    tool: { url: string; sha256: string },
    file: string,
  ) => {
    await sh('curl', ['-fsSL', '--retry', '5', tool.url, '-o', file]);
    await sh('sha256sum', ['-c', '-'], { input: `${tool.sha256}  ${file}\n` });
  };
  await fetchChecked(CRANE, join(state, 'crane.tgz'));
  await sh('tar', ['-xzf', join(state, 'crane.tgz'), '-C', bin, 'crane']);
  const buildx = join(state, 'docker', 'cli-plugins', 'docker-buildx');
  await fetchChecked(BUILDX, buildx);
  await sh('chmod', ['+x', buildx]);
  for (const key of ['key', 'admin-key'])
    await sh('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      join(state, key),
    ]);
}

/**
 * Copies the image into each same-region registry by digest, and builds its
 * eStargz conversion once, into the first, then copies that to the others.
 */
async function copyImages(registries: Registry[], runId: string) {
  const auths: Record<string, { auth: string }> = {};
  for (const r of registries)
    auths[r.host] = { auth: b64(`${r.user}:${await r.password()}`) };
  writeFileSync(
    join(state, 'docker', 'config.json'),
    JSON.stringify({ auths }),
    { mode: 0o600 },
  );
  await Promise.all(
    registries.map((r) =>
      sh('crane', ['copy', IMAGE, `${r.host}/${r.repo}:baseline`]),
    ),
  );
  const [first, ...rest] = registries;
  const context = join(state, 'estargz');
  mkdirSync(context, { recursive: true });
  writeFileSync(join(context, 'Dockerfile'), `FROM ${IMAGE}\n`);
  const builder = `${PREFIX}-${runId}`;
  await sh('docker', [
    'buildx',
    'create',
    '--name',
    builder,
    '--driver',
    'docker-container',
  ]);
  try {
    const target = `${first!.host}/${first!.repo}:estargz`;
    await sh('docker', [
      'buildx',
      'build',
      '--builder',
      builder,
      '--platform',
      'linux/amd64',
      '--output',
      `type=image,name=${target},push=true,compression=estargz,force-compression=true,oci-mediatypes=true`,
      context,
    ]);
    const estargz = await sh('crane', ['digest', target]);
    await Promise.all(
      rest.map((r) =>
        sh('crane', ['copy', target, `${r.host}/${r.repo}:estargz`]),
      ),
    );
    return estargz;
  } finally {
    await sh('docker', ['buildx', 'rm', '--force', builder]).catch(() => {});
  }
}

async function measureCloud(
  name: CloudName,
  /** The cloud's registry, or why it has none. */
  registry: Registry | string,
  estargz: string,
  arms: Arm[],
  count: number,
  parallel: number,
  runId: string,
  deadline: number,
): Promise<Trial[]> {
  const { cloud, mirror } = CLOUDS[name];
  const publicKey = readFileSync(join(state, 'key.pub'), 'utf8');
  const slot = limiter(parallel);
  const trials: Trial[] = [];

  /** One trial; rep -1 is the bake's builder, which the bake stops and removes. */
  const trialOf = async (arm: Arm, rep: number): Promise<Trial> => {
    const spec: ArmSpec = ARMS[arm];
    const vmName =
      rep < 0
        ? `${PREFIX}-${runId}-builder`
        : `${PREFIX}-${runId}-${arm}-${rep}`;
    const trial: Trial = {
      cloud: name,
      arm,
      rep,
      name: vmName,
      launchedAt: 0,
      marks: {},
      facts: {},
    };
    if (rep >= 0) trials.push(trial);
    if (Date.now() > deadline) {
      trial.error = 'skipped: past the run deadline';
      return trial;
    }
    if (spec.source !== 'ghcr' && typeof registry === 'string') {
      trial.error = `skipped: no same-region registry: ${registry}`;
      return trial;
    }
    let vm: Launched | undefined;
    try {
      const pull: Pull = { ref: IMAGE };
      if (spec.source !== 'ghcr' && typeof registry !== 'string') {
        const password = await registry.password();
        const digest = spec.source === 'estargz' ? estargz : DIGEST;
        pull.ref = `${registry.host}/${registry.repo}@${digest}`;
        pull.registry = {
          host: registry.host,
          user: registry.user,
          password,
          header: await pullHeader(
            registry.host,
            registry.repo,
            registry.user,
            password,
          ),
        };
      }
      const file = join(state, `${vmName}.user-data`);
      writeFileSync(file, userData(arm, pull, mirror, publicKey), {
        mode: 0o600,
      });
      trial.launchedAt = Date.now() / 1000;
      vm = await cloud.launch(vmName, file, {
        fastDisk: spec.fastDisk,
        baked: spec.baked && rep >= 0,
        noResourceDisk: spec.baked,
      });
      trial.vmType = vm.vmType;
      parse(trial, await collect(vm.ip));
      console.log(name, arm, rep, JSON.stringify(figures(trial)));
      return trial;
    } catch (error) {
      trial.error = String(error).slice(0, 1500);
      console.warn(name, arm, rep, trial.error);
      return trial;
    } finally {
      if (vm && rep >= 0)
        await cloud.remove(vm).catch((error) => console.warn(String(error)));
      if (vm && rep < 0) trial.facts.builder = JSON.stringify(vm);
    }
  };

  const plain = arms.filter((arm) => arm !== 'baked');
  const work: Promise<unknown>[] = [];
  for (let rep = 0; rep < count; rep++)
    for (const arm of plain) work.push(slot(() => trialOf(arm, rep)));
  if (arms.includes('baked')) {
    work.push(
      (async () => {
        // The builder prepares as the baseline does; its disk becomes the image.
        const builder = await slot(() => trialOf('baked', -1));
        const vm = builder.facts.builder
          ? (JSON.parse(builder.facts.builder) as Launched)
          : undefined;
        try {
          if (!vm || builder.error)
            throw new Error(`builder: ${builder.error}`);
          await ssh(vm.ip, 'cloud-init clean --logs && sync', 120_000);
          await cloud.bake(vm, runId);
        } catch (error) {
          console.warn(name, 'bake failed', String(error));
          for (let rep = 0; rep < count; rep++)
            trials.push({
              cloud: name,
              arm: 'baked',
              rep,
              name: '',
              launchedAt: 0,
              marks: {},
              facts: {},
              error: `bake failed: ${String(error).slice(0, 800)}`,
            });
          return;
        } finally {
          if (vm) await cloud.remove(vm).catch(() => {});
        }
        await Promise.all(
          Array.from({ length: count }, (_, rep) =>
            slot(() => trialOf('baked', rep)),
          ),
        );
      })(),
    );
  }
  await Promise.all(work);
  return trials;
}

async function run(
  clouds: CloudName[],
  arms: Arm[],
  count: number,
  parallel: number,
) {
  const started = Date.now();
  // Leaves the workflow's 85-minute step time to finish the started trials.
  const deadline = started + 60 * 60_000;
  mkdirSync(state, { recursive: true });
  const runId = randomBytes(3).toString('hex');
  console.log(
    `Run ${runId}: ${clouds.join(', ')}; arms ${arms.join(', ')}; ${count} each`,
  );
  await installTools();
  await Promise.all(clouds.map((c) => CLOUDS[c].cloud.login()));
  await Promise.all(clouds.map((c) => CLOUDS[c].cloud.setup(runId)));
  // A cloud without its registry still runs the arms that pull from GHCR.
  const registries = await Promise.all(
    clouds.map((c) =>
      CLOUDS[c].cloud
        .registry(runId)
        .catch((error: unknown) => String(error).slice(0, 600)),
    ),
  );
  const made = registries.filter((r): r is Registry => typeof r !== 'string');
  const estargz = made.length ? await copyImages(made, runId) : '';
  console.log(
    `Images copied (${Math.round((Date.now() - started) / 1000)} s); eStargz ${estargz}`,
  );
  const trials = (
    await Promise.all(
      clouds.map((c, i) =>
        measureCloud(
          c,
          registries[i]!,
          estargz,
          arms,
          count,
          parallel,
          runId,
          deadline,
        ),
      ),
    )
  ).flat();
  const summary = summarize(trials);
  evidence('trials.json', trials);
  evidence('summary.json', { image: IMAGE, estargz, runId, summary });
  evidence('table.md', table(summary));
  console.log(table(summary));
  if (trials.some((t) => !figures(t).ok)) process.exitCode = 1;
}

async function cleanup() {
  mkdirSync(state, { recursive: true });
  const results = await Promise.allSettled(
    (Object.keys(CLOUDS) as CloudName[]).map(async (name) => {
      const { cloud } = CLOUDS[name];
      await cloud.login();
      return cloud.cleanup();
    }),
  );
  const left = results.flatMap((r) =>
    r.status === 'fulfilled'
      ? r.value
      : [`cleanup failed: ${String(r.reason).slice(0, 500)}`],
  );
  evidence('cleanup.json', { left });
  console.log(left.length ? left : 'Nothing left');
  if (left.length) process.exitCode = 1;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const option = (name: string) =>
  rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (command === 'run') {
  const named = rest.filter((arg) => !arg.startsWith('--'));
  const clouds = (named.length ? named : Object.keys(CLOUDS)) as CloudName[];
  const arms = (option('arms')?.split(',') ?? Object.keys(ARMS)) as Arm[];
  for (const cloud of clouds)
    if (!(cloud in CLOUDS)) throw new Error(`Unknown cloud ${cloud}`);
  for (const arm of arms)
    if (!(arm in ARMS)) throw new Error(`Unknown arm ${arm}`);
  await run(
    clouds,
    arms,
    Number(option('count') ?? 5),
    Number(option('parallel') ?? 5),
  );
} else if (command === 'cleanup') {
  await cleanup();
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit();
