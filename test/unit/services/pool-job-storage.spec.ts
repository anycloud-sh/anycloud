import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssumeRoleWithWebIdentityCommand,
  GetFederationTokenCommand,
} from '@aws-sdk/client-sts';
import { encryptCredential } from '../../../src/api/services/cloud-config.js';
import { AWS } from '../../../src/api/services/gateways/aws.js';
import { Azure } from '../../../src/api/services/gateways/azure.js';
import { GCP } from '../../../src/api/services/gateways/gcp.js';
import { mintGcpDownscopedToken } from '../../../src/api/services/provider-clients/gcp.js';
import { BucketNameTakenError } from '../../../src/shared/errors.js';
import { resetStorageCoordinatorForTests } from '../../../src/api/services/gateways/storage-coordinator.js';
import {
  getDeploymentStore,
  getPersistence,
  getWorkloadQueryStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  admitPoolJobStorage,
  assertPoolJobStorage,
  loadPoolJobConfigs,
  mintPoolJobStorage,
} from '../../../src/api/services/pool-job-storage.js';
import { submitPoolJob } from '../../../src/api/services/pool-job-admission.js';
import type { NodePoolServiceAdmissionInput } from '../../../src/api/services/node-pool-service-admission.js';
import { persistPoolJob } from '../../../src/api/services/workload-admission-persistence.js';
import { ImageRuntime, ImageVerdict } from '../../../src/shared/image.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../../src/shared/cloud.js';
import type { DedicatedWorkloadAdmissionInput } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import {
  makeContainerSpec,
  TEST_AWS_CRED,
  TEST_AWS_ROLE,
  TEST_AZURE_CRED,
  TEST_AZURE_ROLE,
  TEST_GCP_CRED,
  TEST_GCP_ROLE,
  TEST_LAMBDA_CRED,
} from '../helpers/fixtures.js';

/**
 * RFC 0043 pool Job credentials; S3, S17–S19 and S22's taken name run on real
 * Azure, S3 and GCS in pool-job-storage.
 */

// STS and the GCS token exchange answer without a network call.
const { federation } = vi.hoisted(() => ({ federation: vi.fn() }));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  STSClient: vi.fn(function () {
    return { send: federation };
  }),
}));
vi.mock(
  '../../../src/api/services/kubernetes/service-account-token.js',
  () => ({ apiServiceAccountToken: async () => 'sa-token' }),
);
vi.mock(
  '../../../src/api/services/provider-clients/gcp.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mintGcpDownscopedToken: vi.fn(),
  }),
);

const ACCOUNT_KEY = Buffer.from('k'.repeat(64)).toString('base64');
const azure = Azure.prototype as unknown as Record<string, () => unknown>;

function stubAzure(options: { sharedKey?: boolean; buckets?: string[] } = {}) {
  vi.restoreAllMocks();
  resetStorageCoordinatorForTests();
  vi.spyOn(Azure.prototype, 'findStorageAccount').mockResolvedValue({
    resourceGroup: 'anycloud-storage',
    account: { location: 'eastus', allowSharedKeyAccess: options.sharedKey },
  });
  if (options.sharedKey !== false) {
    vi.spyOn(azure, 'accountKey').mockResolvedValue(ACCOUNT_KEY);
  }
  const buckets = new Set(options.buckets);
  vi.spyOn(azure, 'hasBucketUncoordinated').mockImplementation(
    async (...[name]: unknown[]) => buckets.has(name as string),
  );
  return vi
    .spyOn(azure, 'upsertBucketUncoordinated')
    .mockResolvedValue(undefined);
}

/**
 * AWS and GCP storage with `buckets` existing (an S3 one in the region
 * `regions` names), minted grants, and a managed bucket created in the
 * gateway's region unless `createOwned` says otherwise.
 */
const setState = (id: string, state: string) =>
  getDB().query('UPDATE workloads SET state = ? WHERE id = ?', [state, id]);

function stubS3AndGcs(
  options: {
    buckets?: string[];
    regions?: Record<string, string>;
    createOwned?: (name: string) => Promise<string>;
  } = {},
) {
  const buckets = new Set(options.buckets);
  federation.mockResolvedValue({
    Credentials: {
      AccessKeyId: 'ASIA',
      SecretAccessKey: 's',
      SessionToken: 'session',
      Expiration: new Date(Date.now() + 3_600_000),
    },
  });
  vi.mocked(mintGcpDownscopedToken).mockResolvedValue({
    token: 'ya29',
    expiresAt: Date.now() + 3_600_000,
  });
  const created: string[] = [];
  const upserted: string[] = [];
  for (const gateway of [AWS, GCP]) {
    const proto = gateway.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    vi.spyOn(proto, 'hasBucketUncoordinated').mockImplementation(async (name) =>
      buckets.has(name as string),
    );
    vi.spyOn(proto, 'upsertBucketUncoordinated').mockImplementation(
      async (name) => void upserted.push(name as string),
    );
    vi.spyOn(proto, 'createOwnedBucket').mockImplementation(async function (
      this: { region: string },
      name,
    ) {
      created.push(name as string);
      return options.createOwned?.(name as string) ?? this.region;
    });
  }
  vi.spyOn(
    AWS.prototype as unknown as Record<string, (name: string) => unknown>,
    'getBucketRegion',
  ).mockImplementation(async (name) => options.regions?.[name]);
  return { created, upserted };
}

/** A second Azure subscription, so its own storage account signs. */
const STORAGE_AZURE_CRED = {
  ...TEST_AZURE_CRED,
  subscriptionId: 'storage-sub',
};
const R2_CRED: CloudCredentials = {
  cloudProvider: CloudType.Cloudflare,
  accountId: 'acct',
  apiToken: 'token',
};
const COMPUTE_ACCOUNT = 'anycloudtestsubi';
const STORAGE_ACCOUNT = 'anycloudstorages';

async function seedCredential(
  id: string,
  credentials: CloudCredentials,
  name: string | null = null,
): Promise<void> {
  await getDB().query(
    `INSERT INTO credentials (id, name, encrypted_data, cloud_provider) VALUES (?, ?, ?, ?)`,
    [id, name, await encryptCredential(credentials), credentials.cloudProvider],
  );
}

/**
 * A node pool, `azure-east` by default, whose compute credential is
 * `cred-az`; `azure-storage` names a separate Azure storage account.
 */
async function seedAzurePool(
  pool: {
    name?: string;
    compute?: CloudCredentials;
    spot?: boolean;
    region?: string | null;
  } = {},
): Promise<void> {
  const { clusters, nodePools } = getPersistence();
  await seedCredential('cred-az', pool.compute ?? TEST_AZURE_CRED);
  await seedCredential('cred-storage', STORAGE_AZURE_CRED, 'azure-storage');
  await seedCredential('cred-aws', TEST_AWS_CRED, 'aws-storage');
  await seedCredential('cred-gcp', TEST_GCP_CRED, 'gcp-storage');
  await seedCredential('cred-r2', R2_CRED, 'r2-storage');
  await clusters.recordSelf({
    id: 'cluster-a',
    ownerUserId: 'owner',
    name: 'production',
    kubernetesIdentity: 'uid-cluster',
    connection: '{"stored":true}',
  });
  await nodePools.create({
    id: 'pool-a',
    clusterId: 'cluster-a',
    ownerUserId: 'owner',
    name: pool.name ?? 'azure-east',
    computeCredentialId: 'cred-az',
    region: pool.region === undefined ? 'eastus' : pool.region,
    zone: null,
    vmTypes: [
      { Lambda: 'gpu_1x_a10', AWS: 'm5.xlarge', GCP: 'e2-standard-4' }[
        (pool.compute ?? TEST_AZURE_CRED).cloudProvider as string
      ] ?? 'Standard_D4s_v5',
    ],
    minVmCount: 1,
    maxVmCount: 1,
    spot: pool.spot,
  });
  await nodePools.markReady('pool-a');
}

/** The storage account and SAS fields of a grant's rclone env. */
function sas(env: Record<string, string>) {
  const url = new URL(env.RCLONE_CONFIG_AZUREBLOB_SAS_URL!);
  return {
    account: url.hostname.split('.')[0],
    ...Object.fromEntries(url.searchParams),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('pool Job storage credentials', () => {
  beforeEach(resetPersistence);

  it('0043/S3 mints the input bucket read-only and the Job prefix of output without delete, each with its persisted credential', async () => {
    const upsert = stubAzure();
    await seedAzurePool();
    await getDeploymentStore().create(
      {
        id: 'deployment-a',
        ownerUserId: 'owner',
        name: 'managed',
        nodePoolId: 'pool-a',
        config: makeContainerSpec({ image: 'ghcr.io/example/train:latest' }),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      },
      { kind: 'api' },
    );
    for (const id of ['job-1', 'job-2']) {
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id,
        userId: 'owner',
        deploymentId: 'deployment-a',
      });
    }
    await getDB().query(
      `UPDATE workloads SET input_bucket = 'dataset', output_bucket = 'results', checkpoint_bucket = 'state',
         input_storage_credential_id = 'cred-az', output_storage_credential_id = 'cred-az',
         checkpoint_storage_credential_id = 'cred-storage',
         input_storage_region = 'eastus', output_storage_region = 'eastus', checkpoint_storage_region = 'westus'
       WHERE id = 'job-1'`,
    );

    const { input, ...prefixed } = await mintPoolJobStorage('job-1');
    expect(input?.remote).toBe('azureblob:dataset/');
    expect(sas(input!.env)).toMatchObject({
      account: COMPUTE_ACCOUNT,
      sr: 'c',
      sp: 'rl',
    });
    expect(Object.keys(prefixed).sort()).toEqual(['checkpoint', 'output']);
    // 0043/S3 signed by an explicit storage credential too.
    for (const [role, bucket, account] of [
      ['output', 'results', COMPUTE_ACCOUNT],
      ['checkpoint', 'state', STORAGE_ACCOUNT],
    ] as const) {
      expect(prefixed[role]?.remote).toBe(`azureblob:${bucket}/job-1/`);
      expect(sas(prefixed[role]!.env)).toMatchObject({
        account,
        sr: 'd',
        sdd: '1',
        sp: 'rcwl',
      });
    }
    expect(JSON.stringify(prefixed)).not.toContain(ACCOUNT_KEY);
    // A Job without buckets mints nothing.
    await expect(mintPoolJobStorage('job-2')).resolves.toEqual({});

    // D-managed: with checkpoint storage and no bucket, as a spot pool's Job
    // is admitted, it gets its whole managed checkpoint bucket, named after
    // it, without delete; an explicit bucket keeps its prefix.
    await getDB().query(
      `UPDATE workloads SET state = 'syncing', checkpoint_storage_credential_id = 'cred-az', checkpoint_storage_region = 'eastus' WHERE id = 'job-2'`,
    );
    upsert.mockClear();
    const managed = await mintPoolJobStorage('job-2');
    // Each claim ensures the bucket, so a resubmit after cleanup deleted it
    // gets it back; the delete clears the coordinator's bucket cache.
    resetStorageCoordinatorForTests();
    await mintPoolJobStorage('job-2');
    expect(upsert.mock.calls).toEqual([
      ['job-2', expect.any(String), 'job-2', 'owner'],
      ['job-2', expect.any(String), 'job-2', 'owner'],
    ]);
    // A renewal after the Job ended mints but never recreates the bucket.
    upsert.mockClear();
    resetStorageCoordinatorForTests();
    await getDB().query(
      `UPDATE workloads SET state = 'terminated' WHERE id = 'job-2'`,
    );
    expect((await mintPoolJobStorage('job-2')).checkpoint).toBeDefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(Object.keys(managed)).toEqual(['checkpoint']);
    expect(managed.checkpoint?.remote).toBe('azureblob:job-2/');
    expect(sas(managed.checkpoint!.env)).toMatchObject({ sr: 'c', sp: 'rcwl' });
    expect((await mintPoolJobStorage('job-1')).checkpoint?.remote).toBe(
      'azureblob:state/job-1/',
    );
    // The persisted selection decides, never the pool: with the storage
    // credential, the managed bucket is in its account (0043/S16).
    await getDB().query(
      `UPDATE workloads SET checkpoint_storage_credential_id = 'cred-storage' WHERE id = 'job-2'`,
    );
    const elsewhere = (await mintPoolJobStorage('job-2')).checkpoint!;
    expect(sas(elsewhere.env)).toMatchObject({ account: STORAGE_ACCOUNT });
  });
});

describe('pool Job storage admission', () => {
  const admit = (overrides: Partial<CloudConfig> = {}) =>
    assertPoolJobStorage(
      'job-1',
      {
        cloudProvider: CloudType.Azure,
        credentials: TEST_AZURE_CRED,
        region: 'eastus',
        inputBucket: 'dataset',
        outputBucket: 'results',
        checkpointBucket: 'state',
        ...overrides,
      },
      { version: '0.1.71', userId: 'owner' },
    );

  it('0043/S9 0043/S22 refuses an R2 bucket, one bucket in two roles, a missing input and an account without Shared Key, creating nothing', async () => {
    let upsert = stubAzure({ buckets: ['dataset', 'state'] });
    await expect(
      admit({ outputStorageCredentials: R2_CRED, outputStorageRegion: 'auto' }),
    ).rejects.toThrow(
      'The output storage is on Cloudflare, but storage for Jobs on a node pool is on Azure, AWS or GCP. Name a credential for one of them with --output-storage-credentials.',
    );
    await expect(admit({ outputBucket: 'state' })).rejects.toThrow(
      /conflicts with checkpoint bucket/,
    );
    expect(upsert).not.toHaveBeenCalled();

    upsert = stubAzure({ buckets: ['state'] });
    await expect(admit()).rejects.toThrow("Bucket 'dataset' does not exist");
    expect(upsert).not.toHaveBeenCalled();

    upsert = stubAzure({ sharedKey: false, buckets: ['dataset', 'state'] });
    await expect(admit()).rejects.toThrow(/Shared Key authorization disabled/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("creates no bucket for a bucketless Job on an on-demand pool, and a spot pool Job's managed bucket last", async () => {
    const pool = {
      computeCredentialId: 'cred-az',
      cloudProvider: CloudType.Azure,
      region: 'eastus',
      clusterRegion: null,
    };
    const input = { cloudConfig: { cloudProvider: CloudType.Azure } };
    const admitTo = (spot: boolean) =>
      admitPoolJobStorage(
        { ...pool, spot },
        input as DedicatedWorkloadAdmissionInput,
        'job-9',
        'owner',
      );
    resetPersistence();
    await seedAzurePool();
    let upsert = stubAzure();
    await expect(admitTo(false)).resolves.toEqual({});
    expect(upsert).not.toHaveBeenCalled();
    // D-managed: once every check passed, admission creates the bucket.
    await expect(admitTo(true)).resolves.toEqual({
      checkpointBucket: undefined,
      checkpointStorageCredentialId: 'cred-az',
      checkpointStorageRegion: 'eastus',
    });
    expect(upsert).toHaveBeenCalledWith(
      'job-9',
      expect.any(String),
      'job-9',
      'owner',
    );
    // 0043/S9: an account that can't sign is refused before any bucket.
    upsert = stubAzure({ sharedKey: false });
    await expect(admitTo(true)).rejects.toThrow(
      /Shared Key authorization disabled/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('creates a missing output bucket', async () => {
    const upsert = stubAzure({ buckets: ['dataset', 'state'] });
    await admit();
    expect(upsert).toHaveBeenCalledWith(
      'results',
      expect.any(String),
      'job-1',
      'owner',
    );
  });
});

describe('pool Job storage from admission to execution', () => {
  beforeEach(resetPersistence);

  const submit = (input: Partial<NodePoolServiceAdmissionInput>) =>
    submitPoolJob(
      {
        nodePools: getPersistence().nodePools,
        resolveScope: async () => ({ kind: 'api' }),
        inspectImage: vi.fn(async () => ({
          verdict: ImageVerdict.Ok,
          amd64Digest: `sha256:${'a'.repeat(64)}`,
          imageRuntime: ImageRuntime.Unknown,
          compressedLayerBytes: null,
          entrypoint: ['/entrypoint.sh'],
          cmd: ['train'],
        })),
        validateId: async (id) => id,
        preflightSecrets: async () => {},
        admitStorage: admitPoolJobStorage,
        persist: persistPoolJob,
        schedule: () => {},
      },
      { id: 'owner', username: 'owner', token: 'github-token' },
      {
        image: 'ghcr.io/example/train:latest',
        cloudConfig: {},
        nodePool: 'azure-east',
        ...input,
      },
    );

  const columns = (id: string) =>
    getDB().query(
      `SELECT input_bucket, output_bucket, checkpoint_bucket,
              input_storage_credential_id AS input, input_storage_region AS input_region,
              output_storage_credential_id AS output, output_storage_region AS output_region,
              checkpoint_storage_credential_id AS checkpoint, checkpoint_storage_region AS checkpoint_region
       FROM workloads WHERE id = ?`,
      [id],
    );
  const remotes = (grants: Awaited<ReturnType<typeof mintPoolJobStorage>>) =>
    Object.fromEntries(
      Object.entries(grants).map(([role, grant]) => [
        role,
        [grant?.remote, sas(grant!.env).account],
      ]),
    );

  it("RFC 0049 C3: stores a pool Job's --max-retries, 0 included", async () => {
    stubAzure();
    await seedAzurePool();
    await submit({ id: 'job-mr', maxRetries: 0 });
    expect(
      (await getWorkloadQueryStore().getWorkload('job-mr'))?.maxRetries,
    ).toBe(0);
  });

  it('mints at execution the buckets admission checked and stored, signed with the node pool credential', async () => {
    const upsert = stubAzure({ buckets: ['dataset', 'state'] });
    await seedAzurePool();
    await submit({
      id: 'job-9',
      cloudConfig: {
        inputBucket: 'dataset',
        outputBucket: 'results',
        checkpointBucket: 'state',
      },
    });
    // The missing output bucket is created at admission, as for VM Jobs.
    expect(upsert).toHaveBeenCalledWith(
      'results',
      expect.any(String),
      'job-9',
      'owner',
    );
    // The compute credential serves every role, and its selection persists.
    expect(await columns('job-9')).toEqual([
      {
        input_bucket: 'dataset',
        output_bucket: 'results',
        checkpoint_bucket: 'state',
        input: 'cred-az',
        input_region: 'eastus',
        output: 'cred-az',
        output_region: 'eastus',
        checkpoint: 'cred-az',
        checkpoint_region: 'eastus',
      },
    ]);
    expect(remotes(await mintPoolJobStorage('job-9'))).toEqual({
      input: ['azureblob:dataset/', COMPUTE_ACCOUNT],
      output: ['azureblob:results/job-9/', COMPUTE_ACCOUNT],
      checkpoint: ['azureblob:state/job-9/', COMPUTE_ACCOUNT],
    });
  });

  it('0043/S14 signs every role of a Job on a Lambda pool with the named Azure storage credential, which creates the output bucket', async () => {
    const upsert = stubAzure({ buckets: ['dataset', 'state'] });
    await seedAzurePool({ name: 'lambda-a10', compute: TEST_LAMBDA_CRED });
    const named = {
      inputStorageCredentialName: 'azure-storage',
      outputStorageCredentialName: 'azure-storage',
      checkpointStorageCredentialName: 'azure-storage',
    };
    await submit({
      id: 'job-14',
      nodePool: 'lambda-a10',
      dockerOptions: { gpus: '1' },
      ...named,
      cloudConfig: {
        inputBucket: 'dataset',
        outputBucket: 'results',
        checkpointBucket: 'state',
        inputStorageRegion: 'westus',
        outputStorageRegion: 'westus',
        checkpointStorageRegion: 'westus',
      },
    });
    expect(upsert).toHaveBeenCalledWith(
      'results',
      expect.any(String),
      'job-14',
      'owner',
    );
    expect(await columns('job-14')).toEqual([
      expect.objectContaining({
        input: 'cred-storage',
        input_region: 'westus',
        output: 'cred-storage',
        checkpoint: 'cred-storage',
        checkpoint_region: 'westus',
      }),
    ]);
    expect(remotes(await mintPoolJobStorage('job-14'))).toEqual({
      input: ['azureblob:dataset/', STORAGE_ACCOUNT],
      output: ['azureblob:results/job-14/', STORAGE_ACCOUNT],
      checkpoint: ['azureblob:state/job-14/', STORAGE_ACCOUNT],
    });
  });

  it('0043/S15 renews after an API restart, and after its pool is deleted, with the storage identity admission selected', async () => {
    stubAzure({ buckets: ['dataset'] });
    await seedAzurePool();
    await submit({
      id: 'job-15',
      outputStorageCredentialName: 'azure-storage',
      cloudConfig: {
        inputBucket: 'dataset',
        outputBucket: 'results',
        outputStorageRegion: 'westus',
      },
    });
    const claimed = remotes(await mintPoolJobStorage('job-15'));
    expect(claimed).toEqual({
      input: ['azureblob:dataset/', COMPUTE_ACCOUNT],
      output: ['azureblob:results/job-15/', STORAGE_ACCOUNT],
    });
    // A renewal, after a restart or not, reads only the row, so the pool's
    // deletion changes neither who signs nor where.
    await getDB().query(`UPDATE node_pools SET state = ? WHERE id = 'pool-a'`, [
      NodePoolState.Deleted,
    ]);
    expect(remotes(await mintPoolJobStorage('job-15'))).toEqual(claimed);
    const job = await getWorkloadQueryStore().getWorkload('job-15');
    expect(await loadPoolJobConfigs(job!)).toMatchObject({
      inputStorageCredentials: TEST_AZURE_CRED,
      inputStorageRegion: 'eastus',
      outputStorageCredentials: STORAGE_AZURE_CRED,
      outputStorageRegion: 'westus',
    });
  });

  // RFC 0047 amendment 7 and § Bucket tokens: a role connection signs pool
  // storage as a key does, whether it is the pool's compute credential or the
  // named storage credential of a Job on another cloud's pool.
  it.each([
    ['AWS', TEST_AWS_ROLE, 'us-east-1'],
    ['GCP', TEST_GCP_ROLE, 'us-central1'],
    ['Azure', TEST_AZURE_ROLE, 'eastus'],
  ] as const)(
    '0047 amendment 7: an %s role connection signs grants as compute and as named storage',
    async (_cloud, role, region) => {
      stubAzure();
      stubS3AndGcs();
      federation.mockClear();
      vi.mocked(mintGcpDownscopedToken).mockClear();
      await seedAzurePool({ name: 'role-pool', compute: role, region });
      await seedCredential('cred-role', role, 'role-storage');
      await submit({
        id: 'job-rc',
        nodePool: 'role-pool',
        cloudConfig: { outputBucket: 'results' },
      });
      // A Lambda pool's Job names the same connection for its output.
      await seedCredential('cred-lambda', TEST_LAMBDA_CRED);
      await getPersistence().nodePools.create({
        id: 'pool-l',
        clusterId: 'cluster-a',
        ownerUserId: 'owner',
        name: 'lambda-rc',
        computeCredentialId: 'cred-lambda',
        region: 'us-east-1',
        zone: null,
        vmTypes: ['gpu_1x_a10'],
        minVmCount: 1,
        maxVmCount: 1,
      });
      await getPersistence().nodePools.markReady('pool-l');
      await submit({
        id: 'job-rs',
        nodePool: 'lambda-rc',
        dockerOptions: { gpus: '1' },
        outputStorageCredentialName: 'role-storage',
        cloudConfig: { outputBucket: 'results', outputStorageRegion: region },
      });
      expect([
        ...(await columns('job-rc')),
        ...(await columns('job-rs')),
      ]).toEqual([
        expect.objectContaining({ output: 'cred-az' }),
        expect.objectContaining({ output: 'cred-role' }),
      ]);

      for (const id of ['job-rc', 'job-rs']) {
        const { output } = await mintPoolJobStorage(id);
        expect(output?.remote).toMatch(new RegExp(`:results/${id}/$`));
      }
      // Each Job's admission trial mint, then each claim's.
      if (role.cloudProvider === CloudType.AWS) {
        const sent = federation.mock.calls.map(([command]) => command);
        expect(sent.some((c) => c instanceof GetFederationTokenCommand)).toBe(
          false,
        );
        expect(
          sent.map((c: AssumeRoleWithWebIdentityCommand) => [
            c.input.RoleArn,
            c.input.RoleSessionName,
            c.input.DurationSeconds,
          ]),
        ).toEqual(
          ['job-rc', 'job-rs', 'job-rc', 'job-rs'].map((id) => [
            (role as { roleArn: string }).roleArn,
            `anycloud-${id}@results`,
            43_200,
          ]),
        );
      } else if (role.cloudProvider === CloudType.GCP) {
        expect(
          vi
            .mocked(mintGcpDownscopedToken)
            .mock.calls.map(([source, grants]) => [source, grants]),
        ).toEqual(
          ['job-rc', 'job-rs', 'job-rc', 'job-rs'].map((id) => [
            expect.objectContaining({ kind: 'role' }),
            [
              {
                bucket: 'results',
                prefix: `${id}/`,
                mode: 'readwrite',
                noDelete: true,
              },
            ],
          ]),
        );
      } else {
        // The role's own subscription's storage account signs both.
        for (const id of ['job-rc', 'job-rs']) {
          const { output } = await mintPoolJobStorage(id);
          expect(sas(output!.env)).toMatchObject({
            account: 'anycloudrole0000',
            sr: 'd',
            sp: 'rcwl',
          });
        }
      }
    },
  );

  it('0043/S9 0043/S22 refuses storage no selected credential can serve, before storing the Job', async () => {
    stubAzure({ buckets: ['dataset'] });
    await seedAzurePool({ name: 'lambda-a10', compute: TEST_LAMBDA_CRED });
    const lambda = { nodePool: 'lambda-a10', dockerOptions: { gpus: '1' } };
    // A bucket on a compute-only pool with no storage credential.
    await expect(
      submit({
        id: 'job-1',
        ...lambda,
        cloudConfig: { inputBucket: 'dataset' },
      }),
    ).rejects.toThrow(
      'The input storage is on Lambda, but storage for Jobs on a node pool is on Azure, AWS or GCP. Name a credential for one of them with --input-storage-credentials.',
    );
    // An R2 bucket: R2 mints no prefix grant yet (CF3).
    await expect(
      submit({
        id: 'job-2',
        ...lambda,
        outputStorageCredentialName: 'r2-storage',
        cloudConfig: { outputBucket: 'results' },
      }),
    ).rejects.toThrow('The output storage is on Cloudflare');
    // A cross-cloud credential with no region, and one that doesn't exist.
    await expect(
      submit({
        id: 'job-3',
        ...lambda,
        inputStorageCredentialName: 'azure-storage',
        cloudConfig: { inputBucket: 'dataset' },
      }),
    ).rejects.toThrow('inputStorageRegion is required');
    await expect(
      submit({
        id: 'job-4',
        ...lambda,
        inputStorageCredentialName: 'missing',
        cloudConfig: { inputBucket: 'dataset', inputStorageRegion: 'westus' },
      }),
    ).rejects.toThrow('Input storage credential "missing" not found');
    expect(await getDB().query('SELECT id FROM workloads')).toEqual([]);
  });

  it("0043/S22 refuses a credential that cannot mint, for a bucket or a managed one, with VM Jobs' message", async () => {
    stubAzure();
    stubS3AndGcs({ buckets: ['dataset'] });
    await seedAzurePool({
      name: 'aws-spot',
      compute: { ...TEST_AWS_CRED, sessionToken: 'sso' },
      spot: true,
    });
    for (const cloudConfig of [{}, { inputBucket: 'dataset' }]) {
      await expect(
        submit({ id: 'job-1', nodePool: 'aws-spot', cloudConfig }),
      ).rejects.toThrow(
        'GetFederationToken requires long-term IAM user credentials',
      );
    }
    expect(await getDB().query('SELECT id FROM workloads')).toEqual([]);
  });

  it.each([
    ['AWS', TEST_AWS_CRED, 's3', 'us-west-2'],
    ['GCP', TEST_GCP_CRED, 'gcs', 'eastus'],
  ] as const)(
    "0043/S17 0043/S21 signs S3 or GCS with a %s spot pool's compute credential, persists each bucket's region and creates the managed bucket at admission and claim, never once it runs",
    async (_cloud, compute, remote, inputRegion) => {
      stubAzure();
      const { created, upserted } = stubS3AndGcs({
        buckets: ['dataset'],
        regions: { dataset: 'us-west-2' },
      });
      await seedAzurePool({ name: 'spot', compute, spot: true });
      await submit({
        id: 'job-21',
        nodePool: 'spot',
        cloudConfig: { inputBucket: 'dataset', outputBucket: 'results' },
      });
      expect([created, upserted]).toEqual([['job-21'], ['results']]);
      // An S3 bucket's own region; the pool's for GCS and the new buckets.
      expect(await columns('job-21')).toEqual([
        {
          input_bucket: 'dataset',
          output_bucket: 'results',
          checkpoint_bucket: null,
          input: 'cred-az',
          input_region: inputRegion,
          output: 'cred-az',
          output_region: 'eastus',
          checkpoint: 'cred-az',
          checkpoint_region: 'eastus',
        },
      ]);
      // The claim's read, while the Job stages, creates it again.
      await setState('job-21', 'syncing');
      const grants = await mintPoolJobStorage('job-21');
      expect(created).toEqual(['job-21', 'job-21']);
      const remotes = (g: typeof grants) =>
        Object.fromEntries(
          Object.entries(g).map(([role, grant]) => [role, grant!.remote]),
        );
      // A renewal once it runs only re-mints the same selection: no
      // createBucket or projects.get, which createOwnedBucket alone calls.
      for (const state of ['running', 'finalizing']) {
        await setState('job-21', state);
        expect(remotes(await mintPoolJobStorage('job-21'))).toEqual(
          remotes(grants),
        );
      }
      expect(created).toEqual(['job-21', 'job-21']);
      expect(remotes(grants)).toEqual({
        input: `${remote}:dataset/`,
        output: `${remote}:results/job-21/`,
        checkpoint: `${remote}:job-21/`,
      });
      if (remote === 's3') {
        expect(grants.input!.env.RCLONE_CONFIG_S3_REGION).toBe('us-west-2');
      }
    },
  );

  it("0043/S16 puts an AWS spot Job's managed bucket where --checkpoint-storage-credentials names, without --checkpoint-bucket", async () => {
    const upsert = stubAzure();
    const { created } = stubS3AndGcs();
    await seedAzurePool({
      name: 'aws-spot',
      compute: TEST_AWS_CRED,
      spot: true,
    });
    // The pool's AWS region names no Azure location.
    await expect(
      submit({
        id: 'job-3',
        nodePool: 'aws-spot',
        checkpointStorageCredentialName: 'azure-storage',
      }),
    ).rejects.toThrow(/checkpointStorageRegion is required/);
    await submit({
      id: 'job-3',
      nodePool: 'aws-spot',
      checkpointStorageCredentialName: 'azure-storage',
      cloudConfig: { checkpointStorageRegion: 'westus' },
    });
    expect(await columns('job-3')).toEqual([
      expect.objectContaining({
        checkpoint_bucket: null,
        checkpoint: 'cred-storage',
        checkpoint_region: 'westus',
        input: null,
        output: null,
      }),
    ]);
    expect(upsert).toHaveBeenCalledWith(
      'job-3',
      expect.any(String),
      'job-3',
      'owner',
    );
    expect(created).toEqual([]);
  });

  it("stores every role's region for an unpinned pool on a hosted API, so execution mints for the bucket it created", async () => {
    const { created, upserted } = stubS3AndGcs({
      buckets: ['dataset'],
      regions: { dataset: 'us-east-2' },
    });
    // A hosted API's own cluster record has no region, like this one.
    await seedAzurePool({
      name: 'aws-spot',
      compute: TEST_AWS_CRED,
      spot: true,
      region: null,
    });
    await submit({
      id: 'job-u',
      nodePool: 'aws-spot',
      cloudConfig: { inputBucket: 'dataset', outputBucket: 'results' },
    });
    expect(upserted).toEqual(['results']);
    expect(created).toEqual(['job-u']);
    // Each bucket admission created is in the storage cloud's default region.
    expect(await columns('job-u')).toEqual([
      expect.objectContaining({
        input_region: 'us-east-2',
        output_region: 'us-east-1',
        checkpoint_region: 'us-east-1',
      }),
    ]);
    expect(Object.keys(await mintPoolJobStorage('job-u')).sort()).toEqual([
      'checkpoint',
      'input',
      'output',
    ]);
  });

  it('0043/S20 signs each role of a Lambda pool Job with its own credential, on its own backend', async () => {
    stubAzure({ buckets: ['state'] });
    stubS3AndGcs({ buckets: ['dataset'] });
    await seedAzurePool({ name: 'lambda-a10', compute: TEST_LAMBDA_CRED });
    await submit({
      id: 'job-20',
      nodePool: 'lambda-a10',
      dockerOptions: { gpus: '1' },
      inputStorageCredentialName: 'gcp-storage',
      outputStorageCredentialName: 'aws-storage',
      checkpointStorageCredentialName: 'azure-storage',
      cloudConfig: {
        inputBucket: 'dataset',
        outputBucket: 'results',
        checkpointBucket: 'state',
        inputStorageRegion: 'us-central1',
        outputStorageRegion: 'us-east-2',
        checkpointStorageRegion: 'westus',
      },
    });
    const { input, output, checkpoint } = await mintPoolJobStorage('job-20');
    expect([input!.remote, output!.remote, checkpoint!.remote]).toEqual([
      'gcs:dataset/',
      's3:results/job-20/',
      'azureblob:state/job-20/',
    ]);
    expect(input!.env.RCLONE_CONFIG_GCS_TOKEN).toContain('ya29');
    expect(output!.env.AWS_SESSION_TOKEN).toBe('session');
    expect(sas(checkpoint!.env).account).toBe(STORAGE_ACCOUNT);
  });

  it.each([
    ['AWS', TEST_AWS_CRED],
    ['GCP', TEST_GCP_CRED],
  ] as const)(
    '0043/S22 refuses a %s spot Job whose ID another owner holds as a bucket name; a claim that meets one throws it',
    async (_cloud, compute) => {
      stubAzure();
      let taken = true;
      stubS3AndGcs({
        createOwned: async (name) => {
          if (taken) throw new BucketNameTakenError(name, null);
          return 'eastus';
        },
      });
      await seedAzurePool({ name: 'spot', compute, spot: true });
      await expect(submit({ id: 'train-1', nodePool: 'spot' })).rejects.toThrow(
        'Pass --checkpoint-bucket or choose a different --id.',
      );
      expect(await getDB().query('SELECT id FROM workloads')).toEqual([]);
      // Lost after admission: the claim's create throws, which ends the Job.
      taken = false;
      await submit({ id: 'train-1', nodePool: 'spot' });
      taken = true;
      await setState('train-1', 'syncing');
      await expect(mintPoolJobStorage('train-1')).rejects.toBeInstanceOf(
        BucketNameTakenError,
      );
    },
  );

  it("0043/S22 refuses the loser of two submits of one ID as a duplicate, leaving the winner's bucket", async () => {
    stubAzure();
    const { created } = stubS3AndGcs();
    const deleted = vi.spyOn(
      AWS.prototype as unknown as Record<string, () => Promise<void>>,
      'deleteBucket',
    );
    await seedAzurePool({ name: 'spot', compute: TEST_AWS_CRED, spot: true });
    await submit({ id: 'job-r', nodePool: 'spot' });
    // The loser's create reuses the winner's bucket before its insert fails.
    await expect(submit({ id: 'job-r', nodePool: 'spot' })).rejects.toThrow(
      /already exists/,
    );
    expect(created).toEqual(['job-r', 'job-r']);
    expect(deleted).not.toHaveBeenCalled();
    expect(await getDB().query('SELECT id FROM workloads')).toEqual([
      { id: 'job-r' },
    ]);
  });

  it('0043/S9 refuses a Job on a Lambda spot pool with no checkpoint storage credential', async () => {
    stubAzure();
    await seedAzurePool({
      name: 'lambda-spot',
      compute: TEST_LAMBDA_CRED,
      spot: true,
    });
    await expect(
      submit({
        id: 'job-1',
        nodePool: 'lambda-spot',
        dockerOptions: { gpus: '1' },
      }),
    ).rejects.toThrow(
      'The checkpoint storage is on Lambda, but storage for Jobs on a node pool is on Azure, AWS or GCP. Name a credential for one of them with --checkpoint-storage-credentials.',
    );
  });

  it.each([
    ['Azure', TEST_AZURE_CRED, { outputBucket: 'results' }, {}],
    ['AWS', TEST_AWS_CRED, { outputBucket: 'results' }, {}],
    ['GCP', TEST_GCP_CRED, { outputBucket: 'results' }, {}],
    ['Lambda', TEST_LAMBDA_CRED, {}, { dockerOptions: { gpus: '1' } }],
  ] as const)(
    'gives a %s spot pool Job with --no-checkpoint no checkpoint bucket, column or grant, keeping its other buckets',
    async (_cloud, compute, cloudConfig, options) => {
      const upsert = stubAzure();
      const { created, upserted } = stubS3AndGcs();
      await seedAzurePool({ name: 'spot', compute, spot: true });
      await submit({
        id: 'job-nc',
        nodePool: 'spot',
        noCheckpoint: true,
        cloudConfig,
        ...options,
      });
      const output = 'outputBucket' in cloudConfig;
      expect(created).toEqual([]);
      const azureUpserted = (upsert.mock.calls as unknown[][]).map(
        ([name]) => name,
      );
      expect([...upserted, ...azureUpserted]).toEqual(
        output ? ['results'] : [],
      );
      expect(await columns('job-nc')).toEqual([
        expect.objectContaining({
          output_bucket: output ? 'results' : null,
          output: output ? 'cred-az' : null,
          checkpoint_bucket: null,
          checkpoint: null,
          checkpoint_region: null,
        }),
      ]);
      // The runner uploads only the roles it has a grant for.
      await setState('job-nc', 'syncing');
      expect(Object.keys(await mintPoolJobStorage('job-nc'))).toEqual(
        output ? ['output'] : [],
      );
    },
  );

  it('refuses --no-checkpoint with a checkpoint storage option, storing nothing', async () => {
    stubAzure({ buckets: ['state'] });
    await seedAzurePool({ spot: true });
    for (const option of [
      { cloudConfig: { checkpointBucket: 'state' } },
      { cloudConfig: { checkpointStorageRegion: 'eastus' } },
      { checkpointStorageCredentialName: 'azure-storage' },
    ]) {
      await expect(
        submit({ id: 'job-1', noCheckpoint: true, ...option }),
      ).rejects.toThrow('--no-checkpoint takes no checkpoint storage options.');
    }
    expect(await getDB().query('SELECT id FROM workloads')).toEqual([]);
  });

  it('refuses inline storage credentials and a storage option without its bucket, storing nothing', async () => {
    stubAzure({ buckets: ['dataset'] });
    await seedAzurePool();
    await expect(
      submit({
        id: 'job-1',
        cloudConfig: {
          inputBucket: 'dataset',
          inputStorageCredentials: STORAGE_AZURE_CRED,
        },
      }),
    ).rejects.toThrow(
      "A Job on a node pool takes a saved credential's name with --input-storage-credentials, not inline credentials.",
    );
    await expect(
      submit({ id: 'job-2', cloudConfig: { outputStorageRegion: 'eastus' } }),
    ).rejects.toThrow(
      'Storage options for the output bucket need --output-bucket.',
    );
    await expect(
      submit({
        id: 'job-3',
        checkpointStorageCredentialName: 'azure-storage',
      }),
    ).rejects.toThrow(
      'Storage options for the checkpoint bucket need --checkpoint-bucket.',
    );
    expect(await getDB().query('SELECT id FROM workloads')).toEqual([]);
  });
});
