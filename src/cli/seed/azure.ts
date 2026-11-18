import { generateKeyPairSync } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CloudType } from '../../shared/cloud.js';
import { CLOUDFLARE_IPV4_RANGES } from '../../shared/cloudflare-ips.js';
import { discoverAccount, missingRights } from './accounts.js';
import template from './azure-template.json' with { type: 'json' };
import {
  CloudCliError,
  seedInstanceName,
  seedStackName,
  type CloudCli,
  type CloudSeed,
  type SeedDeleteResult,
  type SeedOutputs,
  type SeedResource,
} from './types.js';

type Remaining = SeedDeleteResult['remaining'][number];

/**
 * The Azure seed. One ARM deployment (`azure-template.json`) into the
 * installation's own resource group `anycloud-<id>` holds the network, the
 * management VM and its user-assigned managed identity, which is Contributor
 * on that group, so the API can delete it last (lane S6). The checkpoint
 * container sits in the subscription's shared storage account, in the
 * `anycloud-storage` group the API already uses, so deleting the
 * installation group keeps the backups (C28). The template's nested
 * deployment into that group creates the container and grants the identity
 * Storage Blob Data Contributor on it alone. That role has no
 * `deleteBlobVersion` data action, so a deleted or overwritten backup keeps
 * its earlier versions; it can still delete the whole container, which C28's
 * `--delete-buckets` needs.
 *
 * The storage account itself is created with `az storage account create`,
 * not in the template: an existing account may sit in another region, and an
 * ARM PUT would fail on its location or overwrite settings it doesn't own.
 */

const DEPLOYMENT = 'anycloud-seed';
/** The API's storage group and account (`Azure` gateway); the seed must match. */
const STORAGE_GROUP = 'anycloud-storage';
/** Azure's customData limit, before base64. */
const CUSTOM_DATA_MAX_BYTES = 65_535;
const DELETE_TIMEOUT_SECONDS = 1_800;

/** Pool resource types `deleteFallback` deletes first, in order; the rest follow. */
const DELETE_ORDER = [
  'microsoft.compute/virtualmachines',
  'microsoft.compute/disks',
  'microsoft.network/networkinterfaces',
  'microsoft.network/publicipaddresses',
  'microsoft.network/networksecuritygroups',
  'microsoft.network/virtualnetworks',
];
const KIND: Record<string, SeedResource['kind']> = {
  'microsoft.compute/virtualmachines': 'vm',
  'microsoft.compute/disks': 'disk',
  'microsoft.network/networksecuritygroups': 'firewall',
};

/** The API gateway's account name: one per subscription. */
export function azureStorageAccountName(subscriptionId: string): string {
  return `anycloud${subscriptionId.replace(/-/g, '').substring(0, 8)}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CloudCliError && /NotFound|not found/i.test(error.stderr)
  );
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`az returned no ${field}`);
  }
  return value;
}

/** A throwaway OpenSSH key: Azure requires one on a Linux VM; port 22 stays closed and the private half is never kept. */
function throwawaySshKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  // An SSH mpint: positive, so a leading high bit needs a zero byte.
  const mpint = (b64url: string) => {
    const bytes = Buffer.from(b64url, 'base64url');
    return field(
      bytes[0]! & 0x80 ? Buffer.concat([Buffer.of(0), bytes]) : bytes,
    );
  };
  const blob = Buffer.concat([
    field(Buffer.from('ssh-rsa')),
    mpint(jwk.e!),
    mpint(jwk.n!),
  ]);
  return `ssh-rsa ${blob.toString('base64')}`;
}

/** The pinned outputs of the seed deployment. */
function parseOutputs(deployment: any): SeedOutputs {
  const outputs = deployment?.properties?.outputs ?? {};
  const value = (name: string) => str(outputs[name]?.value, `${name} output`);
  return {
    publicIp: value('publicIp'),
    instanceId: value('instanceId'),
    bucket: value('bucket'),
    identity: value('identity'),
  };
}

export function createAzureSeed(cli: CloudCli): CloudSeed {
  /**
   * `words` holds the fixed argv and values that never contain spaces (IDs,
   * regions, names); paths and tags go in `extra`.
   */
  const az = (
    words: string,
    extra: readonly string[] = [],
    signal?: AbortSignal,
  ) => cli.run({ args: [...words.split(' '), ...extra] }, { signal });
  const azJson = async (
    words: string,
    extra: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<any> => {
    const out = await az(words, [...extra, '-o', 'json'], signal);
    return out.trim() ? JSON.parse(out) : null;
  };
  const azJsonOrNull = async (words: string): Promise<any> => {
    try {
      return await azJson(words);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const readDeployment = (clusterId: string) =>
    azJsonOrNull(
      `deployment group show -g ${seedStackName(clusterId)} -n ${DEPLOYMENT}`,
    );
  const account = () => discoverAccount('azure', cli);

  async function ensureStorageAccount(
    name: string,
    region: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const shared = `-g ${STORAGE_GROUP}`;
    try {
      await az(`storage account show ${shared} -n ${name} -o none`, [], signal);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // The group may already hold other installations' account elsewhere.
      if (
        (await az(`group exists -n ${STORAGE_GROUP}`, [], signal)).trim() !==
        'true'
      ) {
        await az(
          `group create -n ${STORAGE_GROUP} -l ${region} --tags managed_by=anycloud -o none`,
          [],
          signal,
        );
      }
      // The API gateway's own account settings (`Azure.ensureStorageAccount`).
      await az(
        `storage account create ${shared} -n ${name} -l ${region} --sku Standard_LRS --kind StorageV2 --access-tier Hot --allow-shared-key-access true --allow-blob-public-access false --min-tls-version TLS1_2 --tags managed_by=anycloud -o none`,
        [],
        signal,
      );
    }
    // Versioning is the account's: the identity can't turn it on itself.
    await az(
      `storage account blob-service-properties update ${shared} --account-name ${name} --enable-versioning true -o none`,
      [],
      signal,
    );
  }

  /**
   * The checkpoint's grant and container, from the checkpoint deployment in
   * the storage group, which outlives the installation group. The grant
   * would outlive the identity, and the API's Contributor can't remove it,
   * so the user's credentials do, after the self-delete or in the fallback.
   * The container goes only under `--delete-buckets` and only when managed,
   * and retires that record.
   */
  async function cleanCheckpoint(
    clusterId: string,
    deleteBuckets: boolean,
  ): Promise<SeedDeleteResult> {
    const deleted: SeedResource[] = [];
    const remaining: Remaining[] = [];
    const checkpoint = await azJsonOrNull(
      `deployment group show -g ${STORAGE_GROUP} -n ${seedInstanceName(clusterId)}-checkpoint`,
    );
    const input = checkpoint?.properties?.parameters ?? {};
    const grant = checkpoint?.properties?.outputs?.roleAssignmentId?.value;
    if (typeof grant === 'string') {
      const entry = { kind: 'identity' as const, id: grant, selector: grant };
      try {
        await az('role assignment delete -o none --ids', [grant]);
        deleted.push(entry);
      } catch (error) {
        if (!(error instanceof CloudCliError)) throw error;
        if (isNotFound(error)) deleted.push(entry);
        else remaining.push(entry);
      }
    }
    const container = input.container?.value;
    if (typeof container !== 'string') return { deleted, remaining };
    const storageAccount = input.account?.value;
    const bucket = { kind: 'bucket' as const, id: container };
    const left = {
      ...bucket,
      selector: `container ${container} in storage account ${storageAccount} (group ${STORAGE_GROUP})`,
    };
    // `managed`, not `create`: a restored managed bucket existed already.
    if (!deleteBuckets || input.managed?.value !== true) {
      return { deleted, remaining: [...remaining, left] };
    }
    try {
      // Exits 0 when the API already deleted it.
      await az(
        `storage container delete --auth-mode key --account-name ${storageAccount} -o none`,
        ['--name', container],
      );
    } catch (error) {
      if (!(error instanceof CloudCliError)) throw error;
      return { deleted, remaining: [...remaining, left] };
    }
    deleted.push(bucket);
    try {
      await az(
        `deployment group delete -g ${STORAGE_GROUP} -n ${checkpoint.name}`,
      );
    } catch (error) {
      // Only bookkeeping: the next --delete-buckets run retires it.
      if (!(error instanceof CloudCliError)) throw error;
    }
    return { deleted, remaining };
  }

  return {
    cloud: 'azure',
    discoverAccount: account,
    checkRights: (signedIn) => missingRights('azure', cli, signedIn),

    async findByName(clusterName) {
      const groups: Array<{ tags?: Record<string, string> }> =
        (await azJson('group list', [
          '--tag',
          `anycloud_cluster_name=${clusterName}`,
        ])) ?? [];
      const ids = [
        ...new Set(groups.flatMap((g) => g.tags?.anycloud_cluster ?? [])),
      ];
      if (ids.length > 1) {
        throw new Error(
          `Azure has ${ids.length} installations named "${clusterName}" (${ids.join(', ')}); name one by its ID.`,
        );
      }
      return ids[0] ?? null;
    },

    selfDeleteValues(params) {
      return { cloud: 'azure', resourceGroup: seedStackName(params.clusterId) };
    },

    async deploy(params, signal) {
      const scriptBytes = Buffer.byteLength(params.startupScript);
      if (scriptBytes > CUSTOM_DATA_MAX_BYTES) {
        throw new Error(
          `The startup script is ${scriptBytes} bytes; Azure customData holds at most ${CUSTOM_DATA_MAX_BYTES}.`,
        );
      }
      const { account: subscriptionId } = await account();
      const group = seedStackName(params.clusterId);
      const vm = seedInstanceName(params.clusterId);
      const storageAccount = azureStorageAccountName(subscriptionId);
      const tags = Object.entries(params.tags).map(([k, v]) => `${k}=${v}`);
      await az(
        `group create -n ${group} -l ${params.region} -o none`,
        tags.length ? ['--tags', ...tags] : [],
        signal,
      );
      await ensureStorageAccount(storageAccount, params.region, signal);
      // customData can't change on an existing VM, so a resumed deploy leaves
      // the VM as it is and reconciles the rest.
      const vms: Array<{ name: string; provisioningState?: string }> =
        (await azJson(`vm list -g ${group}`, [], signal)) ?? [];
      const existing = vms.find((candidate) => candidate.name === vm);
      if (existing?.provisioningState === 'Failed') {
        throw new Error(
          `Management VM ${vm} failed to provision; delete the cluster and create it again.`,
        );
      }
      const parameters = {
        clusterId: params.clusterId,
        vmSize: params.vmType,
        // service-terminology-ok: Azure owns this marketplace SKU spelling
        imageSku: 'server',
        zone: params.zone ?? '',
        // ARM wants customData base64; the VM gets the script as given.
        customData: Buffer.from(params.startupScript).toString('base64'),
        adminPublicKey: throwawaySshKey(),
        deployVm: !existing,
        // The VM has an IPv4 address only.
        cloudflareRanges: [...CLOUDFLARE_IPV4_RANGES],
        storageResourceGroup: STORAGE_GROUP,
        storageAccount,
        checkpointContainer: params.bucket.name,
        createCheckpointContainer:
          params.bucket.managed && !params.bucket.exists,
        checkpointManaged: params.bucket.managed,
        tags: params.tags,
      };
      // Files, not argv: the script would pass Windows' command-line limit.
      const dir = await mkdtemp(join(tmpdir(), 'anycloud-seed-'));
      try {
        const templateFile = join(dir, 'template.json');
        const parametersFile = join(dir, 'parameters.json');
        await writeFile(templateFile, JSON.stringify(template));
        const values = Object.entries(parameters).map(([k, value]) => [
          k,
          { value },
        ]);
        await writeFile(
          parametersFile,
          JSON.stringify({
            $schema:
              'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
            contentVersion: '1.0.0.0',
            parameters: Object.fromEntries(values),
          }),
          { mode: 0o600 },
        );
        const deployment = await azJson(
          `deployment group create -g ${group} -n ${DEPLOYMENT}`,
          [
            '--template-file',
            templateFile,
            '--parameters',
            `@${parametersFile}`,
          ],
          signal,
        );
        return parseOutputs(deployment);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async status(clusterId) {
      const group = seedStackName(clusterId);
      const shown = await azJsonOrNull(`group show -n ${group}`);
      if (!shown) return { kind: 'absent' };
      if (shown.properties?.provisioningState === 'Deleting') {
        return { kind: 'in-progress', detail: 'resource group deleting' };
      }
      const deployment = await readDeployment(clusterId);
      const state = deployment?.properties?.provisioningState;
      if (state === 'Failed' || state === 'Canceled') {
        const detail = deployment.properties.error?.message;
        return { kind: 'failed', detail: detail ?? `deployment ${state}` };
      }
      if (state !== 'Succeeded') {
        return {
          kind: 'in-progress',
          detail: `deployment ${state ?? 'not started'}`,
        };
      }
      const outputs = parseOutputs(deployment);
      const power: unknown = await azJson(
        `vm get-instance-view -g ${group} -n ${outputs.instanceId}`,
        [
          '--query',
          "instanceView.statuses[?starts_with(code, 'PowerState/')].code",
        ],
      );
      const stopped =
        Array.isArray(power) &&
        power.some((code) => /^PowerState\/(deallocated|stopped)$/.test(code));
      return { kind: 'deployed', outputs, stopped };
    },

    backupValues({ bucket, region }, signedIn) {
      return {
        bucket: bucket.name,
        region,
        cloudProvider: CloudType.Azure,
        credentials: {
          cloudProvider: CloudType.Azure,
          kind: 'instance',
          subscriptionId: signedIn.account,
          directoryId: str(signedIn.directory, 'tenant'),
        },
      };
    },

    afterSelfDelete: (clusterId, _region, { deleteBuckets }) =>
      cleanCheckpoint(clusterId, deleteBuckets),

    async readObject(bucket, key) {
      const { account: subscriptionId } = await account();
      const dir = await mkdtemp(join(tmpdir(), 'anycloud-seed-'));
      const file = join(dir, 'object');
      try {
        await az(
          `storage blob download --auth-mode key --account-name ${azureStorageAccountName(subscriptionId)} -o none`,
          ['--container-name', bucket, '--name', key, '--file', file],
        );
        return await readFile(file, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async deleteFallback(clusterId, region, { deleteBuckets }) {
      const group = seedStackName(clusterId);
      const selector = `anycloud_cluster=${clusterId}`;
      const deleted: SeedResource[] = [];
      const remaining: Remaining[] = [];
      // Pool VMs and their networking, in the shared regional groups.
      const tagged: Array<{
        id: string;
        type: string;
        resourceGroup: string;
        location?: string;
      }> = (await azJson(`resource list --tag ${selector}`)) ?? [];
      const rank = (type: string) => {
        const index = DELETE_ORDER.indexOf(type.toLowerCase());
        return index === -1 ? DELETE_ORDER.length : index;
      };
      const pool = tagged.filter(
        (resource) =>
          resource.resourceGroup.toLowerCase() !== group.toLowerCase(),
      );
      for (let step = 0; step <= DELETE_ORDER.length; step++) {
        const batch = pool.filter((resource) => rank(resource.type) === step);
        await Promise.all(
          batch.map(async (resource) => {
            const entry = {
              kind: KIND[resource.type.toLowerCase()] ?? ('network' as const),
              id: resource.id,
              ...(resource.location && { location: resource.location }),
            };
            try {
              await az('resource delete -o none --ids', [resource.id]);
            } catch (error) {
              // A VM's NIC and disk may already have gone with it.
              if (!isNotFound(error)) {
                if (!(error instanceof CloudCliError)) throw error;
                remaining.push({ ...entry, selector });
                return;
              }
            }
            deleted.push(entry);
          }),
        );
      }

      if (await azJsonOrNull(`group show -n ${group}`)) {
        await az(`group delete -n ${group} --yes --no-wait`);
        await az(
          `group wait -n ${group} --deleted --timeout ${DELETE_TIMEOUT_SECONDS}`,
        );
        deleted.push({ kind: 'group', id: group, location: region });
      }

      const checkpoint = await cleanCheckpoint(clusterId, deleteBuckets);
      return {
        deleted: [...deleted, ...checkpoint.deleted],
        remaining: [...remaining, ...checkpoint.remaining],
      };
    },
  };
}
