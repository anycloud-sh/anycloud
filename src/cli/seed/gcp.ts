import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOUDFLARE_IPV4_RANGES } from '../../shared/cloudflare-ips.js';
import { CloudType } from '../../shared/cloud.js';
import { getZoneSuffixes } from '../../shared/cloud-config.js';
import { gcpBootsFromHyperdisk } from '../../shared/gcp-boot-disks.js';
import { discoverAccount, missingRights } from './accounts.js';
import {
  CloudCliError,
  seedInstanceName,
  type CloudCli,
  type CloudSeed,
  type SeedAccount,
  type SeedDeleteResult,
  type SeedOutputs,
  type SeedParams,
  type SeedResource,
} from './types.js';

/**
 * The GCP seed: a few raw `gcloud` calls (seed design call 1), each adopting
 * what already exists, so a re-run resumes. GCP has no stack, so each
 * resource is found again by a name derived from the cluster ID, or by the
 * `anycloud_cluster` label where no name is derivable (the bucket, pool VMs).
 */

const BUCKET_METADATA_KEY = 'anycloud-bucket';
/** The VM's only bucket role: object read and write (an overwrite needs delete), without objectAdmin's object IAM. */
const BUCKET_ROLE = 'roles/storage.objectUser';
const PROPAGATION_ATTEMPTS = 8;
const PROPAGATION_DELAY_MS = 5_000;

/** Today's management ports without SSH: the Kubernetes API, and the API through Cloudflare. */
function gcpFirewallRules(clusterId: string) {
  const prefix = `${seedInstanceName(clusterId)}-`;
  // The default network is IPv4-only, so IPv6 ranges would match nothing.
  return [
    { name: `${prefix}k8s`, allow: 'tcp:6443', sources: ['0.0.0.0/0'] },
    {
      name: `${prefix}api`,
      allow: 'tcp:80,tcp:443',
      sources: [...CLOUDFLARE_IPV4_RANGES],
    },
  ];
}

/**
 * Account IDs hold 6–30 characters, which `anycloud-` plus a cluster ID
 * (`<name>-<ms>-<rand>`) overflows, so the ID is hashed; the display name
 * keeps it readable.
 */
export function gcpServiceAccountEmail(
  clusterId: string,
  project: string,
): string {
  const digest = createHash('sha256').update(clusterId).digest('hex');
  return `anycloud-${digest.slice(0, 20)}@${project}.iam.gserviceaccount.com`;
}

/** The management VM's zone; `selfDeleteValues` and `deploy` must agree on it. */
function gcpSeedZone(region: string, zone: string | null): string {
  if (zone?.startsWith(`${region}-`)) return zone;
  const suffix = zone || getZoneSuffixes(region)[0];
  if (!suffix) throw new Error(`GCP region ${region} has no known zone.`);
  return `${region}-${suffix}`;
}

/** GCP labels are lowercase `[a-z0-9_-]`, at most 63 characters. */
function label(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 63);
}

/**
 * The VM's one project role, conditioned on its own instance and boot disk,
 * which is as narrow as IAM conditions go: Compute conditions match names,
 * not labels. It has no firewall role: deleting a rule also needs
 * `compute.networks.updatePolicy` on the network, which no condition can
 * name, so the CLI deletes the rules once the VM is gone.
 */
const INSTANCE_ROLE = 'roles/compute.instanceAdmin.v1';
function instanceCondition(clusterId: string, zone: string) {
  const vm = seedInstanceName(clusterId);
  return {
    title: 'anycloud-instance',
    expression: `resource.name.endsWith("/zones/${zone}/instances/${vm}") || resource.name.endsWith("/zones/${zone}/disks/${vm}")`,
  };
}

/**
 * The service account's description. It is created first and deleted last,
 * so `findByName` and the cleanup after a self-delete read the installation
 * from it; a bucket name too long for its 256 characters is left out.
 */
function accountDescription(params: SeedParams): string {
  const description = `anycloud_cluster=${params.clusterId} anycloud_cluster_name=${label(params.clusterName)}`;
  const withBucket = `${description} anycloud_bucket=${params.bucket.name}`;
  return withBucket.length <= 256 ? withBucket : description;
}

function parseDescription(description = ''): Record<string, string> {
  return Object.fromEntries(
    description.split(' ').map((pair) => pair.split('=', 2)),
  );
}

/** Another project's bucket of the same global name. */
const FORBIDDEN =
  /HTTPError 403|AccessDenied|does not have storage\.buckets\.get/i;
/** IAM's answer for a deleted service account (or a real refusal). */
export const ACCOUNT_DENIED_OR_GONE =
  /Permission 'iam\.serviceAccounts\.(get|delete)' denied on resource \(or it may not exist\)/;
const ALREADY_EXISTS = /already exists|already own it/i;
/** What a service account too new for IAM or Compute to see yet fails with. */
const PROPAGATING =
  /service ?account[^\n]*(does not exist|not found)|does not have access to service account/i;
const NOT_FOUND =
  /not found|NOT_FOUND|does not exist|matched no objects|No URLs matched|HTTPError 404/i;

function stderrMatches(error: unknown, pattern: RegExp): boolean {
  return error instanceof CloudCliError && pattern.test(error.stderr);
}

interface GcsBucket {
  name?: string;
  location?: string;
  labels?: Record<string, string>;
}

/**
 * This installation's bucket: labelled for it, or, before its labels are
 * set, unlabelled and named for the cluster as S1 names a managed bucket.
 */
function ownBucket(
  name: string,
  bucket: GcsBucket,
  clusterId: string,
): boolean {
  const owner = bucket.labels?.anycloud_cluster;
  return owner === undefined ? name === clusterId : owner === label(clusterId);
}

interface GcpInstance {
  id?: string;
  name?: string;
  zone?: string;
  status?: string;
  networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[];
  serviceAccounts?: { email?: string }[];
  metadata?: { items?: { key?: string; value?: string }[] };
}

function outputsOf(instance: GcpInstance): SeedOutputs | null {
  const publicIp = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
  const identity = instance.serviceAccounts?.[0]?.email;
  const bucket = instance.metadata?.items?.find(
    (item) => item.key === BUCKET_METADATA_KEY,
  )?.value;
  if (!publicIp || !instance.id || !identity || !bucket) return null;
  return { publicIp, instanceId: instance.id, bucket, identity };
}

/** gcloud reads these values from files: their quotes and commas break flag parsing. */
async function withFile<T>(
  content: string,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'anycloud-seed-'));
  try {
    const path = join(dir, 'value');
    await writeFile(path, content, { mode: 0o600 });
    return await use(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface GcpSeedOptions {
  /** Waits between retries while a new service account propagates. */
  sleep?: (ms: number) => Promise<void>;
}

export function createGcpSeed(
  cli: CloudCli,
  options: GcpSeedOptions = {},
): CloudSeed {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let account: Promise<SeedAccount> | undefined;

  /** `words` is the space-separated command; `args` are its operands and flags. */
  const gcloud = (words: string, ...args: string[]) =>
    cli.run({ args: [...words.split(' '), ...args, '--quiet'] });
  const json = async <T>(words: string, ...args: string[]): Promise<T> =>
    JSON.parse(await gcloud(words, ...args, '--format=json')) as T;

  /** "Already exists" adopts the resource and runs `adopt` (an update), if any. */
  async function createOrAdopt(
    create: () => Promise<unknown>,
    adopt?: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await create();
    } catch (error) {
      if (!stderrMatches(error, ALREADY_EXISTS)) throw error;
      await adopt?.();
    }
  }

  /** IAM is eventually consistent: a new service account reads as absent for a while. */
  async function whilePropagating(run: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await run();
        return;
      } catch (error) {
        if (
          attempt >= PROPAGATION_ATTEMPTS ||
          !stderrMatches(error, PROPAGATING)
        )
          throw error;
        await sleep(PROPAGATION_DELAY_MS);
      }
    }
  }

  /** False when it was already gone, so a re-run of delete resumes. */
  async function deleteIfPresent(run: () => Promise<unknown>) {
    try {
      await run();
      return true;
    } catch (error) {
      if (stderrMatches(error, NOT_FOUND)) return false;
      throw error;
    }
  }

  /**
   * IAM answers a call on a deleted service account with "permission denied
   * (or it may not exist)". It counts as gone only once Resource Manager
   * confirms the caller holds the rights, so a real gap stays an error.
   */
  let accountRights: Promise<boolean> | undefined;
  async function accountGone(error: unknown): Promise<boolean> {
    if (!stderrMatches(error, ACCOUNT_DENIED_OR_GONE)) return false;
    accountRights ??= seed
      .discoverAccount()
      .then((account) =>
        missingRights('gcp', cli, account, [
          'iam.serviceAccounts.get',
          'iam.serviceAccounts.delete',
        ]),
      )
      .then((missing) => missing?.length === 0);
    accountRights.catch(() => (accountRights = undefined));
    return accountRights;
  }

  const projectFlag = async () =>
    `--project=${(await seed.discoverAccount()).account}`;

  const seed: CloudSeed = {
    cloud: 'gcp',

    discoverAccount() {
      account ??= discoverAccount('gcp', cli);
      account.catch(() => (account = undefined));
      return account;
    },

    checkRights: (signedIn) => missingRights('gcp', cli, signedIn),

    async findByName(clusterName) {
      // The service account is created first, so it also finds a create
      // that stopped before the VM.
      const accounts = await json<{ description?: string }[]>(
        'iam service-accounts list',
        await projectFlag(),
        '--filter=email~^anycloud-',
      );
      const ids = new Set(
        accounts.flatMap(({ description }) => {
          const values = parseDescription(description);
          const id = values.anycloud_cluster;
          return id && values.anycloud_cluster_name === label(clusterName)
            ? [id]
            : [];
        }),
      );
      if (ids.size > 1)
        throw new Error(
          `GCP has ${ids.size} installations named ${clusterName}: ${[...ids].join(', ')}.`,
        );
      return [...ids][0] ?? null;
    },

    selfDeleteValues({ clusterId, region, zone }) {
      return {
        cloud: 'gcp',
        instanceName: seedInstanceName(clusterId),
        zone: gcpSeedZone(region, zone),
      };
    },

    backupValues({ bucket, region }, { account: projectId }) {
      return {
        bucket: bucket.name,
        region,
        cloudProvider: CloudType.GCP,
        credentials: {
          cloudProvider: CloudType.GCP,
          kind: 'instance',
          projectId,
        },
      };
    },

    async deploy(params) {
      const { account: project } = await seed.discoverAccount();
      const p = `--project=${project}`;
      const zone = gcpSeedZone(params.region, params.zone);
      const vm = seedInstanceName(params.clusterId);
      const email = gcpServiceAccountEmail(params.clusterId, project);
      const member = `--member=serviceAccount:${email}`;
      // `status`, the adopt check and `deleteFallback` find resources by it.
      const tags = { ...params.tags, anycloud_cluster: params.clusterId };
      const labelPairs = Object.entries(tags)
        .map(([key, value]) => `${label(key)}=${label(value)}`)
        .join(',');
      const labels = `--labels=${labelPairs}`;

      await createOrAdopt(() =>
        gcloud(
          'iam service-accounts create',
          email.split('@')[0],
          p,
          `--display-name=AnyCloud cluster ${params.clusterId}`.slice(0, 100),
          `--description=${accountDescription(params)}`,
        ),
      );
      await withFile(
        JSON.stringify(instanceCondition(params.clusterId, zone)),
        (file) =>
          whilePropagating(() =>
            gcloud(
              'projects add-iam-policy-binding',
              project,
              member,
              `--role=${INSTANCE_ROLE}`,
              `--condition-from-file=${file}`,
            ),
          ),
      );

      for (const rule of gcpFirewallRules(params.clusterId)) {
        const shape = [
          `--allow=${rule.allow}`,
          `--source-ranges=${rule.sources.join(',')}`,
          `--target-tags=${vm}`,
        ];
        await createOrAdopt(
          () =>
            gcloud(
              'compute firewall-rules create',
              rule.name,
              p,
              '--network=default',
              '--direction=INGRESS',
              ...shape,
            ),
          () => gcloud('compute firewall-rules update', rule.name, p, ...shape),
        );
      }

      const bucket = `gs://${params.bucket.name}`;
      if (params.bucket.managed && !params.bucket.exists) {
        // No `--labels` here: gcloud before 590.0.0 rejects it on create.
        await createOrAdopt(() =>
          gcloud(
            'storage buckets create',
            bucket,
            p,
            `--location=${params.region}`,
            '--uniform-bucket-level-access',
            '--public-access-prevention',
          ),
        );
        // "You already own it" holds for any of the project's buckets, so an
        // adopted bucket must be this installation's.
        const described = await json<GcsBucket>(
          'storage buckets describe',
          bucket,
          p,
        );
        if (!ownBucket(params.bucket.name, described, params.clusterId))
          throw new Error(
            `GCS bucket ${params.bucket.name} exists without label anycloud_cluster=${label(params.clusterId)}; choose another bucket name.`,
          );
      }
      if (params.bucket.managed)
        // Labels it, or relabels a restore from the cluster's own bucket, so
        // `--delete-buckets` finds it by label.
        await gcloud(
          'storage buckets update',
          bucket,
          p,
          '--versioning',
          `--update-labels=${labelPairs}`,
        );
      // Object rights only: the API never deletes the bucket; the CLI does,
      // under `--delete-buckets`, after the API is gone.
      await whilePropagating(() =>
        gcloud(
          'storage buckets add-iam-policy-binding',
          bucket,
          member,
          `--role=${BUCKET_ROLE}`,
        ),
      );

      await withFile(params.startupScript, (script) =>
        whilePropagating(() =>
          createOrAdopt(() =>
            gcloud(
              'compute instances create',
              vm,
              p,
              `--zone=${zone}`,
              `--machine-type=${params.vmType}`,
              '--image-family=ubuntu-2404-lts-amd64',
              '--image-project=ubuntu-os-cloud',
              // K3s, its images, the API's and its SQLite fit with headroom,
              // as on AWS's 16 GB. Persistent Disk machines would default to
              // pd-standard, whose speed shrinks with its size.
              '--boot-disk-size=20GB',
              ...(gcpBootsFromHyperdisk(params.vmType)
                ? []
                : ['--boot-disk-type=pd-balanced']),
              `--service-account=${email}`,
              '--scopes=cloud-platform',
              // The DNS Worker matches the caller's IPv4 against the A record.
              '--stack-type=IPV4_ONLY',
              `--tags=${vm}`,
              labels,
              `--metadata=${BUCKET_METADATA_KEY}=${params.bucket.name}`,
              `--metadata-from-file=startup-script=${script}`,
            ),
          ),
        ),
      );

      const outputs = outputsOf(
        await json<GcpInstance>(
          'compute instances describe',
          vm,
          p,
          `--zone=${zone}`,
        ),
      );
      if (!outputs)
        throw new Error(
          `GCP instance ${vm} has no external IP, service account or bucket metadata.`,
        );
      if (outputs.identity !== email)
        throw new Error(
          `GCP instance ${vm} runs as ${outputs.identity}, not ${email}.`,
        );
      return outputs;
    },

    async status(clusterId) {
      const [instance] = await json<GcpInstance[]>(
        'compute instances list',
        await projectFlag(),
        `--filter=name=${seedInstanceName(clusterId)}`,
      );
      if (!instance) return { kind: 'absent' };
      const outputs = outputsOf(instance);
      const state = instance.status ?? 'UNKNOWN';
      // Going down counts as down, so a resume never adopts a stopping VM.
      const stopped = [
        'STOPPING',
        'TERMINATED',
        'SUSPENDING',
        'SUSPENDED',
      ].includes(state);
      if (outputs && (state === 'RUNNING' || stopped))
        return { kind: 'deployed', outputs, stopped };
      if (state === 'RUNNING')
        return { kind: 'failed', detail: `${instance.name} lacks its outputs` };
      return { kind: 'in-progress', detail: `${instance.name} is ${state}` };
    },

    async readObject(bucket, key) {
      try {
        return await gcloud(
          'storage cat',
          `gs://${bucket}/${key}`,
          await projectFlag(),
        );
      } catch (error) {
        if (stderrMatches(error, NOT_FOUND)) return null;
        throw error;
      }
    },

    // The API deleted its own VM; pool VMs it left are not this step's.
    afterSelfDelete: (clusterId, _region, { deleteBuckets }) =>
      deleteInstallation(clusterId, deleteBuckets, false),

    deleteFallback: (clusterId, _region, { deleteBuckets }) =>
      deleteInstallation(clusterId, deleteBuckets, true),
  };

  /** Every step treats not-found as done, so a re-run resumes. */
  async function deleteInstallation(
    clusterId: string,
    deleteBuckets: boolean,
    withVms: boolean,
  ): Promise<SeedDeleteResult> {
    const { account: project } = await seed.discoverAccount();
    const p = `--project=${project}`;
    const deleted: SeedResource[] = [];
    const remaining: SeedDeleteResult['remaining'][number][] = [];
    const selector = `labels.anycloud_cluster=${label(clusterId)}`;

    // The management VM and the installation's pool VMs.
    const instances = withVms
      ? await json<GcpInstance[]>(
          'compute instances list',
          p,
          `--filter=name=${seedInstanceName(clusterId)} OR ${selector}`,
        )
      : [];
    for (const { name = '', zone: zoneUrl = '' } of instances) {
      const zone = zoneUrl.split('/').pop() ?? '';
      if (
        await deleteIfPresent(() =>
          gcloud('compute instances delete', name, p, `--zone=${zone}`),
        )
      )
        deleted.push({ kind: 'vm', id: name, location: zone });
    }

    for (const { name } of gcpFirewallRules(clusterId)) {
      if (
        await deleteIfPresent(() =>
          gcloud('compute firewall-rules delete', name, p),
        )
      )
        deleted.push({ kind: 'firewall', id: name });
    }

    const buckets = await json<GcsBucket[]>(
      'storage buckets list',
      p,
      `--filter=${selector}`,
    );
    // A create that stopped before its labels leaves the managed bucket,
    // named for the cluster, unlabelled.
    if (!buckets.some(({ name }) => name === clusterId)) {
      const unlabelled = await json<GcsBucket>(
        'storage buckets describe',
        `gs://${clusterId}`,
        p,
      ).catch((error: unknown) => {
        if (stderrMatches(error, NOT_FOUND)) return undefined;
        // Another project's bucket of that name, or the user's own they
        // can't read: shown, so it isn't forgotten.
        if (stderrMatches(error, FORBIDDEN)) {
          remaining.push({
            kind: 'bucket',
            id: clusterId,
            selector: `gs://${clusterId}`,
            reason: `couldn't be read (403), so it may be this installation's unlabelled bucket`,
          });
          return undefined;
        }
        throw error;
      });
      if (unlabelled && ownBucket(clusterId, unlabelled, clusterId))
        buckets.push({ ...unlabelled, name: clusterId });
    }
    const email = gcpServiceAccountEmail(clusterId, project);
    const member = `--member=serviceAccount:${email}`;
    const kept: string[] = [];
    for (const { name = '', location } of buckets) {
      const bucket: SeedResource = {
        kind: 'bucket',
        id: name,
        location: location?.toLowerCase(),
      };
      if (!deleteBuckets) {
        remaining.push({ ...bucket, selector });
        kept.push(name);
      } else if (
        await deleteIfPresent(() =>
          gcloud('storage rm --recursive', `gs://${name}`, p),
        )
      )
        deleted.push(bucket);
    }
    // A supplied bucket is named only by the service account.
    const supplied = await json<{ description?: string }>(
      'iam service-accounts describe',
      email,
      p,
    )
      .then(({ description }) => parseDescription(description).anycloud_bucket)
      .catch(async (error: unknown) => {
        if (stderrMatches(error, NOT_FOUND) || (await accountGone(error)))
          return undefined;
        throw error;
      });
    if (supplied && !buckets.some(({ name }) => name === supplied))
      kept.push(supplied);
    // A kept bucket's policy would otherwise hold a `deleted:` member.
    for (const name of kept) {
      await deleteIfPresent(() =>
        gcloud(
          'storage buckets remove-iam-policy-binding',
          `gs://${name}`,
          member,
          `--role=${BUCKET_ROLE}`,
        ),
      );
    }

    // The VM's service account can't delete itself without losing its
    // rights mid-delete, so the CLI removes it once the VM is gone.
    await deleteIfPresent(() =>
      gcloud(
        'projects remove-iam-policy-binding',
        project,
        member,
        `--role=${INSTANCE_ROLE}`,
        '--all',
      ),
    );
    const accountDeleted = await gcloud('iam service-accounts delete', email, p)
      .then(() => true)
      .catch(async (error: unknown) => {
        if (stderrMatches(error, NOT_FOUND) || (await accountGone(error)))
          return false;
        throw error;
      });
    if (accountDeleted) deleted.push({ kind: 'serviceAccount', id: email });

    return { deleted, remaining };
  }
  return seed;
}
