/**
 * The cluster-cloud substrate's view of a seed installation (RFC 0049 C26
 * (e), owner decision 2026-11-07). `cluster create` and `cluster delete` run
 * the CLI under test with the runner's own cloud CLI sign-in as the user's
 * session; everything the harness checks about the installation it reads
 * through that same cloud CLI (`aws`, `az`, `gcloud`), by the names the seed
 * derives from the cluster ID and the `anycloud_cluster` tag. Lanes that add
 * checks (ingress, capacity) build on this seam.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  seedInstanceName,
  seedStackName,
  type SeedCloud,
} from '../../../../../../src/cli/seed/types.js';
import type { CommandResult } from '../../types.js';
// Where the API hands the e2e access kubeconfig over (lane S5), when create
// ran with `ANYCLOUD_E2E_ACCESS`.
import { E2E_ACCESS_KUBECONFIG_KEY } from '../../../../../../src/api/services/e2e-access-handoff.js';

/** Runs one command; the substrate passes the e2e ProcessRunner. */
export type SeedRun = (
  executable: string,
  args: readonly string[],
  options?: {
    readonly timeoutMs?: number;
    readonly label?: string;
    /** False for output that holds a credential (the access kubeconfig). */
    readonly recordArtifact?: boolean;
  },
) => Promise<CommandResult>;

/** What `cluster create --json` prints: its one document, the cluster. */
export const seedCreatedSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    state: z.string(),
    managementApiUrl: z.string().url().nullable(),
    checkpointBucket: z
      .object({ name: z.string(), managed: z.boolean() })
      .nullable()
      .optional(),
  })
  .passthrough();
export type SeedCreated = z.infer<typeof seedCreatedSchema>;

/**
 * The one JSON document a `--json` command prints on stdout; anything else
 * there (a log line, a second document) is the defect that an earlier live run hit.
 */
export function parseOneDocument(
  result: CommandResult,
  command: string,
): unknown {
  const text = result.stdout.trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${command} --json printed no single JSON document on stdout (exit ${String(result.exitCode)}): ${text.slice(0, 500) || result.stderr.slice(-500)}`,
    );
  }
}

/** What the cloud shows of the installation, through its CLI. */
export type SeedInstallationState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly detail: string };

/** A resource still tagged for the cluster after delete, for the sweep artifact. */
export interface SeedLeftover {
  readonly kind: string;
  readonly id: string;
}

/** The account the CLI under test created in: every read is pinned to it. */
export interface SeedScope {
  readonly region: string;
  /** The GCP project or Azure subscription; unused on AWS, whose keys pin it. */
  readonly account: string;
}

interface CloudView {
  consoleOutput(clusterId: string): Promise<string | null>;
  stopManagementVm(clusterId: string): Promise<void>;
  installation(clusterId: string): Promise<SeedInstallationState>;
  tagged(clusterId: string): Promise<SeedLeftover[]>;
  readObject(bucket: string, key: string): Promise<string | null>;
}

const TAG = 'anycloud_cluster';

function stdoutOf(result: CommandResult, what: string): string {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed (exit ${String(result.exitCode)}): ${result.stderr.trim().slice(-500)}`,
    );
  }
  return result.stdout;
}

function json<T>(result: CommandResult, what: string): T {
  const text = stdoutOf(result, what).trim();
  if (!text) throw new Error(`${what} printed nothing`);
  return JSON.parse(text) as T;
}

/**
 * A missing object or installation, as that one call says it; anything else
 * (no sign-in, a wrong profile or subscription, a refused right) throws, so a
 * setup error never reads as a clean sweep.
 */
function absent(result: CommandResult, notFound: RegExp): boolean {
  return result.exitCode !== 0 && notFound.test(result.stderr);
}

type AwsRun = (
  args: string[],
  label: string,
  recordArtifact?: boolean,
) => Promise<CommandResult>;

/** EC2 types the harness confirms: their describe, its id filter, the ids it returns. */
const EC2_DESCRIBES: Record<string, readonly [string, string, string]> = {
  instance: [
    'describe-instances',
    'instance-id',
    // An ended instance stays visible for about an hour too.
    "Reservations[].Instances[?State.Name!='terminated'].InstanceId[]",
  ],
  volume: ['describe-volumes', 'volume-id', 'Volumes[].VolumeId'],
  'network-interface': [
    'describe-network-interfaces',
    'network-interface-id',
    'NetworkInterfaces[].NetworkInterfaceId',
  ],
  'security-group': [
    'describe-security-groups',
    'group-id',
    'SecurityGroups[].GroupId',
  ],
};

/**
 * The tagged ARNs that still exist, by each type's authoritative describe. EC2
 * describes filter by id, so a deleted id is simply not returned (not an
 * error); a bucket answers head-bucket, a stack describe-stacks short of
 * DELETE_COMPLETE. A type the harness cannot confirm counts as remaining.
 */
async function existingAwsResources(
  aws: AwsRun,
  arns: readonly string[],
): Promise<string[]> {
  const ec2 = new Map<string, Map<string, string>>();
  const confirmed = new Set<string>();
  const checks: Promise<void>[] = [];
  for (const arn of arns) {
    const [, type, id] =
      /^arn:aws:ec2:[^:]*:[^:]*:([a-z-]+)\/(\S+)$/.exec(arn) ?? [];
    if (type && id && EC2_DESCRIBES[type]) {
      const ids = ec2.get(type) ?? new Map<string, string>();
      ec2.set(type, ids.set(id, arn));
      continue;
    }
    const bucket = /^arn:aws:s3:::([^/]+)$/.exec(arn)?.[1];
    if (bucket) {
      checks.push(
        (async () => {
          const result = await aws(
            ['s3api', 'head-bucket', '--bucket', bucket],
            'seed-aws-bucket',
          );
          if (absent(result, /\(404\)|Not Found|NoSuchBucket/)) return;
          stdoutOf(result, 'aws s3api head-bucket');
          confirmed.add(arn);
        })(),
      );
      continue;
    }
    if (/^arn:aws:cloudformation:[^:]*:[^:]*:stack\//.test(arn)) {
      checks.push(
        (async () => {
          const result = await aws(
            [
              'cloudformation',
              'describe-stacks',
              '--stack-name',
              arn,
              '--output',
              'json',
            ],
            'seed-aws-tagged-stack',
          );
          if (absent(result, /ValidationError.*does not exist/)) return;
          const { Stacks } = json<{ Stacks: { StackStatus: string }[] }>(
            result,
            'aws cloudformation describe-stacks',
          );
          if (
            Stacks.some(({ StackStatus }) => StackStatus !== 'DELETE_COMPLETE')
          )
            confirmed.add(arn);
        })(),
      );
      continue;
    }
    confirmed.add(arn);
  }
  for (const [type, ids] of ec2) {
    const [describe, filter, query] = EC2_DESCRIBES[type];
    const all = [...ids.keys()];
    // EC2 takes at most 200 values in one filter.
    for (let at = 0; at < all.length; at += 200) {
      const batch = all.slice(at, at + 200);
      checks.push(
        (async () => {
          const found = json<string[]>(
            await aws(
              [
                'ec2',
                describe,
                '--filters',
                `Name=${filter},Values=${batch.join(',')}`,
                '--query',
                query,
                '--output',
                'json',
              ],
              `seed-aws-tagged-${type}`,
            ),
            `aws ec2 ${describe}`,
          );
          for (const id of found) {
            const arn = ids.get(id);
            if (arn) confirmed.add(arn);
          }
        })(),
      );
    }
  }
  await Promise.all(checks);
  return arns.filter((arn) => confirmed.has(arn));
}

function awsView(run: SeedRun, { region }: SeedScope): CloudView {
  const aws = (args: string[], label: string, recordArtifact = true) =>
    run('aws', [...args, '--region', region], { label, recordArtifact });
  return {
    async consoleOutput(clusterId) {
      const ids = stdoutOf(
        await aws(
          [
            'ec2',
            'describe-instances',
            '--filters',
            `Name=tag:${TAG},Values=${clusterId}`,
            `Name=tag:Name,Values=${seedInstanceName(clusterId)}`,
            '--query',
            'Reservations[].Instances[].InstanceId',
            '--output',
            'text',
          ],
          'seed-aws-console-vm',
        ),
        'aws ec2 describe-instances',
      )
        .split(/\s+/)
        .filter(Boolean);
      if (!ids[0]) return null;
      return stdoutOf(
        await aws(
          [
            'ec2',
            'get-console-output',
            '--instance-id',
            ids[0],
            // The newest output, not only what was buffered at the last state change.
            '--latest',
            '--query',
            'Output',
            '--output',
            'text',
          ],
          'seed-aws-console',
          false,
        ),
        'aws ec2 get-console-output',
      );
    },
    async stopManagementVm(clusterId) {
      const ids = stdoutOf(
        await aws(
          [
            'ec2',
            'describe-instances',
            '--filters',
            `Name=tag:${TAG},Values=${clusterId}`,
            `Name=tag:Name,Values=${seedInstanceName(clusterId)}`,
            'Name=instance-state-name,Values=pending,running',
            '--query',
            'Reservations[].Instances[].InstanceId',
            '--output',
            'text',
          ],
          'seed-aws-management-vm',
        ),
        'aws ec2 describe-instances',
      )
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length !== 1)
        throw new Error(
          `expected one running management VM for ${clusterId}, found ${ids.length}`,
        );
      stdoutOf(
        await aws(
          ['ec2', 'stop-instances', '--instance-ids', ids[0]],
          'seed-aws-stop',
        ),
        'aws ec2 stop-instances',
      );
      // `stopping` still counts as running for the dead-API delete.
      stdoutOf(
        await aws(
          ['ec2', 'wait', 'instance-stopped', '--instance-ids', ids[0]],
          'seed-aws-stopped',
        ),
        'aws ec2 wait instance-stopped',
      );
    },
    async installation(clusterId) {
      const result = await aws(
        [
          'cloudformation',
          'describe-stacks',
          '--stack-name',
          seedStackName(clusterId),
          '--output',
          'json',
        ],
        'seed-aws-stack',
      );
      if (absent(result, /ValidationError.*Stack with id \S+ does not exist/))
        return { kind: 'absent' };
      const { Stacks } = json<{ Stacks: { StackStatus: string }[] }>(
        result,
        'aws cloudformation describe-stacks',
      );
      return {
        kind: 'present',
        detail: `stack ${Stacks[0]?.StackStatus ?? 'unknown'}`,
      };
    },
    async tagged(clusterId) {
      const { ResourceTagMappingList } = json<{
        ResourceTagMappingList: { ResourceARN: string }[];
      }>(
        await aws(
          [
            'resourcegroupstaggingapi',
            'get-resources',
            '--tag-filters',
            `Key=${TAG},Values=${clusterId}`,
            '--output',
            'json',
          ],
          'seed-aws-tagged',
        ),
        'aws resourcegroupstaggingapi get-resources',
      );
      // The tagging API keeps listing deleted resources for about an hour, so
      // it is only a hint: each ARN counts once its own describe still finds it.
      const existing = await existingAwsResources(
        aws,
        ResourceTagMappingList.map(({ ResourceARN }) => ResourceARN),
      );
      // The CloudFormation service role the stack's own delete keeps; no
      // tag search finds IAM roles.
      const role = `${seedStackName(clusterId)}-cfn`;
      const roleRead = await aws(
        ['iam', 'get-role', '--role-name', role, '--output', 'json'],
        'seed-aws-cfn-role',
      );
      const roles = absent(roleRead, /NoSuchEntity/)
        ? []
        : (stdoutOf(roleRead, 'aws iam get-role'),
          [{ kind: 'iam', id: `role/${role}` }]);
      return [
        ...roles,
        ...existing.map((arn) => ({
          kind: arn.split(':')[2] ?? 'aws',
          id: arn,
        })),
      ];
    },
    async readObject(bucket, key) {
      const result = await aws(
        ['s3', 'cp', `s3://${bucket}/${key}`, '-'],
        'seed-aws-object',
        false,
      );
      if (absent(result, /\(404\)|NoSuchKey|Key ".*" does not exist/))
        return null;
      return stdoutOf(result, 'aws s3 cp');
    },
  };
}

/**
 * The Azure checkpoint bucket is a container in the subscription's shared
 * storage account, `anycloud` and the subscription's first 8 hex digits, in
 * `anycloud-storage` (lane S3's `azureStorageAccountName`).
 */
export function azureStorageAccount(subscriptionId: string): string {
  return `anycloud${subscriptionId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

function azureView(
  run: SeedRun,
  { account }: SeedScope,
  temporaryFile: () => Promise<{ path: string; read(): Promise<string> }>,
): CloudView {
  const az = (args: string[], label: string, recordArtifact = true) =>
    run('az', [...args, '--subscription', account], { label, recordArtifact });
  return {
    async consoleOutput(clusterId) {
      const ids = stdoutOf(
        await az(
          [
            'vm',
            'list',
            '--resource-group',
            seedStackName(clusterId),
            '--query',
            '[].id',
            '--output',
            'tsv',
          ],
          'seed-azure-console-vm',
        ),
        'az vm list',
      )
        .split(/\s+/)
        .filter(Boolean);
      const vm = ids[0];
      if (!vm) return null;
      // The serial log, when boot diagnostics are on; then the boot script's
      // own log through the VM agent's run-command (no SSH).
      const read = async (args: string[], label: string) => {
        const result = await az(args, label, false);
        return result.exitCode === 0
          ? result.stdout
          : `(${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim().slice(-300)})`;
      };
      const serial = await read(
        ['vm', 'boot-diagnostics', 'get-boot-log', '--ids', vm],
        'seed-azure-console',
      );
      const boot = await read(
        [
          'vm',
          'run-command',
          'invoke',
          '--ids',
          vm,
          '--command-id',
          'RunShellScript',
          '--scripts',
          `tail -n 400 ${MANAGEMENT_BOOT_LOG}`,
          '--query',
          'value[0].message',
          '--output',
          'tsv',
        ],
        'seed-azure-boot-log',
      );
      return `${serial}\n--- ${MANAGEMENT_BOOT_LOG} ---\n${boot}`;
    },
    async stopManagementVm(clusterId) {
      const ids = stdoutOf(
        await az(
          [
            'vm',
            'list',
            '--resource-group',
            seedStackName(clusterId),
            '--query',
            '[].id',
            '--output',
            'tsv',
          ],
          'seed-azure-management-vm',
        ),
        'az vm list',
      )
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length !== 1)
        throw new Error(
          `expected one management VM in ${seedStackName(clusterId)}, found ${ids.length}`,
        );
      stdoutOf(
        await az(['vm', 'deallocate', '--ids', ids[0]], 'seed-azure-stop'),
        'az vm deallocate',
      );
    },
    async installation(clusterId) {
      const result = await az(
        [
          'group',
          'show',
          '--name',
          seedStackName(clusterId),
          '--output',
          'json',
        ],
        'seed-azure-group',
      );
      if (absent(result, /\(ResourceGroupNotFound\)/))
        return { kind: 'absent' };
      const { properties } = json<{
        properties: { provisioningState: string };
      }>(result, 'az group show');
      return {
        kind: 'present',
        detail: `group ${properties.provisioningState}`,
      };
    },
    async tagged(clusterId) {
      return json<{ id: string; type: string }[]>(
        await az(
          [
            'resource',
            'list',
            '--tag',
            `${TAG}=${clusterId}`,
            '--output',
            'json',
          ],
          'seed-azure-tagged',
        ),
        'az resource list',
      ).map(({ id, type }) => ({ kind: type, id }));
    },
    async readObject(bucket, key) {
      // A file, not stdout: the download needs a seekable target.
      const file = await temporaryFile();
      const result = await az(
        [
          'storage',
          'blob',
          'download',
          '--account-name',
          azureStorageAccount(account),
          '--container-name',
          bucket,
          '--name',
          key,
          '--auth-mode',
          'key',
          '--file',
          file.path,
          '--no-progress',
          '--output',
          'none',
        ],
        'seed-azure-object',
        false,
      );
      if (absent(result, /\(BlobNotFound\)|ErrorCode:BlobNotFound/))
        return null;
      stdoutOf(result, 'az storage blob download');
      return file.read();
    },
  };
}

function gcpView(run: SeedRun, { account }: SeedScope): CloudView {
  const gcloud = (args: string[], label: string, recordArtifact = true) =>
    run('gcloud', [...args, `--project=${account}`, '--quiet'], {
      label,
      recordArtifact,
    });
  const list = async (args: string[], label: string) =>
    json<{ name: string; status?: string }[]>(
      await gcloud([...args, '--format=json'], label),
      `gcloud ${args.slice(0, 3).join(' ')}`,
    );
  return {
    async consoleOutput(clusterId) {
      const name = seedInstanceName(clusterId);
      const [instance] = (await list(
        ['compute', 'instances', 'list', `--filter=name=${name}`],
        'seed-gcp-console-vm',
      )) as { zone?: string }[];
      const zone = instance?.zone?.split('/').pop();
      if (!zone) return null;
      return stdoutOf(
        await gcloud(
          [
            'compute',
            'instances',
            'get-serial-port-output',
            name,
            `--zone=${zone}`,
          ],
          'seed-gcp-console',
          false,
        ),
        'gcloud compute instances get-serial-port-output',
      );
    },
    async stopManagementVm(clusterId) {
      const name = seedInstanceName(clusterId);
      const [instance] = (await list(
        ['compute', 'instances', 'list', `--filter=name=${name}`],
        'seed-gcp-management-vm',
      )) as { zone?: string }[];
      const zone = instance?.zone?.split('/').pop();
      if (!zone) throw new Error(`no management VM ${name}`);
      stdoutOf(
        await gcloud(
          ['compute', 'instances', 'stop', name, `--zone=${zone}`],
          'seed-gcp-stop',
        ),
        'gcloud compute instances stop',
      );
    },
    async installation(clusterId) {
      const [instance] = await list(
        [
          'compute',
          'instances',
          'list',
          `--filter=name=${seedInstanceName(clusterId)}`,
        ],
        'seed-gcp-instance',
      );
      return instance
        ? {
            kind: 'present',
            detail: `instance ${instance.status ?? 'unknown'}`,
          }
        : { kind: 'absent' };
    },
    async tagged(clusterId) {
      const label = `labels.${TAG}=${clusterId}`;
      const [instances, disks, buckets, firewalls] = await Promise.all([
        list(
          ['compute', 'instances', 'list', `--filter=${label}`],
          'seed-gcp-tagged-instances',
        ),
        list(
          ['compute', 'disks', 'list', `--filter=${label}`],
          'seed-gcp-tagged-disks',
        ),
        list(
          ['storage', 'buckets', 'list', `--filter=${label}`],
          'seed-gcp-tagged-buckets',
        ),
        // Firewall rules carry no labels: the seed names them for the cluster.
        list(
          [
            'compute',
            'firewall-rules',
            'list',
            `--filter=name~^${seedInstanceName(clusterId)}-`,
          ],
          'seed-gcp-firewalls',
        ),
      ]);
      // The seed's service account (`anycloud-` and the ID's first 20 SHA-256
      // hex digits, as lane S4 names it), by that email; its
      // project bindings outlive it as `deleted:serviceAccount:…`.
      const email = `anycloud-${createHash('sha256').update(clusterId).digest('hex').slice(0, 20)}@${account}.iam.gserviceaccount.com`;
      const accounts = (await list(
        ['iam', 'service-accounts', 'list', `--filter=email=${email}`],
        'seed-gcp-service-accounts',
      )) as { email?: string; name: string }[];
      const { bindings = [] } = json<{
        bindings?: { role: string; members: string[] }[];
      }>(
        await gcloud(
          ['projects', 'get-iam-policy', account, '--format=json'],
          'seed-gcp-iam-policy',
        ),
        'gcloud projects get-iam-policy',
      );
      const bound = bindings.flatMap(({ role, members }) =>
        members
          .filter(
            (member) =>
              member === `serviceAccount:${email}` ||
              member.startsWith(`deleted:serviceAccount:${email}?`),
          )
          .map((member) => ({ kind: 'binding', id: `${role} ${member}` })),
      );
      return [
        ...accounts.map((r) => ({
          kind: 'serviceAccount',
          id: r.email ?? r.name,
        })),
        ...bound,
        ...instances.map((r) => ({ kind: 'instance', id: r.name })),
        ...disks.map((r) => ({ kind: 'disk', id: r.name })),
        ...buckets.map((r) => ({ kind: 'bucket', id: r.name })),
        ...firewalls.map((r) => ({ kind: 'firewall', id: r.name })),
      ];
    },
    async readObject(bucket, key) {
      const result = await gcloud(
        ['storage', 'cat', `gs://${bucket}/${key}`],
        'seed-gcp-object',
        false,
      );
      if (absent(result, /matched no objects|No URLs matched/)) return null;
      return stdoutOf(result, 'gcloud storage cat');
    },
  };
}

/**
 * The startup script's log on the management VM (lane S5). Only Azure reads
 * it without SSH (run-command). AWS's and GCP's consoles show the kernel and
 * cloud-init, but not this log unless the script also writes it to the
 * console.
 */
const MANAGEMENT_BOOT_LOG = '/var/log/anycloud-boot.log';

export interface SeedInstallation {
  readonly cloud: SeedCloud;
  /** The stack, resource group or management VM, as the cloud shows it. */
  installation(clusterId: string): Promise<SeedInstallationState>;
  /**
   * Everything still tagged `anycloud_cluster=<id>` (and GCP's named firewall
   * rules), but the buckets delete keeps by design.
   */
  leftovers(
    clusterId: string,
    kept?: readonly string[],
  ): Promise<SeedLeftover[]>;
  /** The management VM's serial or console output; null when there is no VM. */
  consoleOutput(clusterId: string): Promise<string | null>;
  /** Stop (not delete) the management VM, so its hosted API stops answering. */
  stopManagementVm(clusterId: string): Promise<void>;
  /** The kubeconfig S5 writes for e2e; null until it is there. Never recorded as an artifact. */
  accessKubeconfig(bucket: string): Promise<string | null>;
}

export function seedInstallation(
  cloud: SeedCloud,
  run: SeedRun,
  scope: SeedScope,
  temporaryFile: () => Promise<{ path: string; read(): Promise<string> }>,
): SeedInstallation {
  const view =
    cloud === 'aws'
      ? awsView(run, scope)
      : cloud === 'azure'
        ? azureView(run, scope, temporaryFile)
        : gcpView(run, scope);
  return {
    cloud,
    installation: (id) => view.installation(id),
    stopManagementVm: (id) => view.stopManagementVm(id),
    consoleOutput: (id) => view.consoleOutput(id),
    leftovers: async (id, kept = []) =>
      (await view.tagged(id)).filter(
        (leftover) =>
          !kept.some(
            (name) =>
              leftover.id === name ||
              leftover.id.endsWith(`:${name}`) ||
              leftover.id.endsWith(`/${name}`),
          ),
      ),
    accessKubeconfig: (bucket) =>
      view.readObject(bucket, E2E_ACCESS_KUBECONFIG_KEY),
  };
}
