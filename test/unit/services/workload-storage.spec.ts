import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CloudType, type CloudConfig } from '../../../src/shared/cloud.js';
import { DeployError } from '../../../src/shared/errors';
import { TEST_AWS_CRED, TEST_AZURE_CRED } from '../helpers/fixtures';
import {
  cleanupManagedWorkloadStorage,
  ensureWorkloadOutputStorage,
  ensureManagedWorkloadCheckpoint,
  readWorkloadCheckpointHealth,
  resolveWorkloadStorage,
  validateExistingWorkloadStorage,
  type WorkloadStorageProviderFactories,
} from '../../../src/api/services/workload-storage';

const storage = () => ({
  type: CloudType.AWS,
  region: 'us-east-1',
  hasBucket: vi.fn(),
  upsertBucket: vi.fn(),
  deleteBucket: vi.fn(),
});
const storageMocks = {
  input: storage(),
  output: storage(),
  checkpoint: storage(),
};
const providerFactories: WorkloadStorageProviderFactories = {
  input: vi.fn(() => storageMocks.input as any),
  output: vi.fn(() => storageMocks.output as any),
  checkpoint: vi.fn(() => storageMocks.checkpoint as any),
};

const workloadId = 'workload-storage-test';

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    cloudProvider: CloudType.Lambda,
    region: 'us-east-1',
    vmType: 'gpu_1x_a100_sxm4',
    ...overrides,
  };
}

describe('workload storage lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.input.hasBucket.mockResolvedValue(true);
    storageMocks.output.hasBucket.mockResolvedValue(true);
    storageMocks.checkpoint.hasBucket.mockResolvedValue(true);
    storageMocks.input.upsertBucket.mockResolvedValue(undefined);
    storageMocks.output.upsertBucket.mockResolvedValue(undefined);
    storageMocks.checkpoint.upsertBucket.mockResolvedValue(undefined);
    storageMocks.checkpoint.deleteBucket.mockResolvedValue(undefined);
  });

  it('resolves role access and cleanup policies explicitly', async () => {
    const storage = await resolveWorkloadStorage(
      config({
        inputBucket: 'input',
        outputBucket: 'output',
        spot: true,
        inputStorageCredentials: TEST_AWS_CRED,
        inputStorageRegion: 'us-east-1',
        outputStorageCredentials: TEST_AWS_CRED,
        outputStorageRegion: 'us-east-1',
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
      workloadId,
      undefined,
      providerFactories,
    );

    expect(storage.targets.input).toMatchObject({
      role: 'input',
      name: 'input',
      mode: 'read',
      cleanupPolicy: 'retain',
    });
    expect(storage.targets.output).toMatchObject({
      role: 'output',
      name: 'output',
      mode: 'readwrite',
      cleanupPolicy: 'retain',
    });
    expect(storage.targets.checkpoint).toMatchObject({
      role: 'checkpoint',
      name: workloadId,
      mode: 'readwrite',
      cleanupPolicy: 'delete-with-workload',
    });
  });

  // Every VM and pool storage path resolves here, including a resubmit of a
  // workload recorded before the backup bucket was refused at admission.
  describe('the API backup bucket', () => {
    function backupOn(cloudProvider: CloudType) {
      vi.stubEnv(
        'ANYCLOUD_BACKUP_CONFIG',
        JSON.stringify({
          bucket: 'api-backups',
          region: 'us-east-1',
          cloudProvider,
          credentials: { cloudProvider },
        }),
      );
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
    }
    // No storage credential or region, so a region lookup would reach the
    // bucket through the compute cloud's provider.
    const roles = {
      input: { inputBucket: 'api-backups' },
      output: { outputBucket: 'api-backups' },
      checkpoint: { checkpointBucket: 'api-backups' },
    };

    it.each(Object.entries(roles))(
      'is refused as the %s bucket before any provider call',
      async (_role, overrides) => {
        backupOn(CloudType.AWS);
        await expect(
          resolveWorkloadStorage(
            config({ cloudProvider: CloudType.AWS, ...overrides }),
            workloadId,
            undefined,
            providerFactories,
          ),
        ).rejects.toThrow("API's own backup bucket");
        expect(providerFactories.input).not.toHaveBeenCalled();
        expect(providerFactories.output).not.toHaveBeenCalled();
        expect(providerFactories.checkpoint).not.toHaveBeenCalled();
      },
    );

    it("takes a role's cloud from its storage credential", async () => {
      backupOn(CloudType.AWS);
      await expect(
        resolveWorkloadStorage(
          config({
            outputBucket: 'api-backups',
            outputStorageCredentials: TEST_AWS_CRED,
          }),
          workloadId,
          undefined,
          providerFactories,
        ),
      ).rejects.toThrow("API's own backup bucket");
      expect(providerFactories.output).not.toHaveBeenCalled();
    });

    it('is never deleted by cleanup when it is a managed checkpoint', async () => {
      backupOn(CloudType.AWS);
      await cleanupManagedWorkloadStorage(
        config({
          spot: true,
          checkpointStorageCredentials: TEST_AWS_CRED,
          checkpointStorageRegion: 'us-east-1',
        }),
        'api-backups',
        providerFactories,
      );
      expect(storageMocks.checkpoint.deleteBucket).not.toHaveBeenCalled();
    });

    it('is not confused with a same-named bucket on another cloud', async () => {
      backupOn(CloudType.GCP);
      const storage = await resolveWorkloadStorage(
        config({
          inputBucket: 'api-backups',
          inputStorageCredentials: TEST_AWS_CRED,
          inputStorageRegion: 'us-east-1',
        }),
        workloadId,
        undefined,
        providerFactories,
      );
      expect(storage.targets.input?.name).toBe('api-backups');
    });
  });

  it('classifies a missing retained input as a user error', async () => {
    storageMocks.input.hasBucket.mockResolvedValue(false);
    const storage = await resolveWorkloadStorage(
      config({
        inputBucket: 'missing-input',
        inputStorageCredentials: TEST_AWS_CRED,
        inputStorageRegion: 'us-east-1',
      }),
      workloadId,
      undefined,
      providerFactories,
    );

    const validation = validateExistingWorkloadStorage(storage);
    await expect(validation).rejects.toBeInstanceOf(DeployError);
    await expect(validation).rejects.toMatchObject({ statusCode: 400 });
    expect(storageMocks.input.upsertBucket).not.toHaveBeenCalled();
  });

  it('creates retained output and managed checkpoint targets idempotently', async () => {
    const storage = await resolveWorkloadStorage(
      config({
        outputBucket: 'output',
        spot: true,
        outputStorageCredentials: TEST_AWS_CRED,
        outputStorageRegion: 'us-east-1',
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
      workloadId,
      undefined,
      providerFactories,
    );
    const metadata = { version: '1.2.3', userId: 'octocat' };

    await ensureWorkloadOutputStorage(storage, metadata);
    await ensureManagedWorkloadCheckpoint(storage, metadata);

    expect(storageMocks.output.upsertBucket).toHaveBeenCalledWith(
      'output',
      '1.2.3',
      workloadId,
      'octocat',
    );
    expect(storageMocks.checkpoint.upsertBucket).toHaveBeenCalledWith(
      workloadId,
      '1.2.3',
      workloadId,
      'octocat',
    );
  });

  it('resolves only the managed checkpoint during cleanup', async () => {
    await cleanupManagedWorkloadStorage(
      config({
        inputBucket: 'unavailable-input',
        outputBucket: 'unavailable-output',
        spot: true,
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
      workloadId,
      providerFactories,
    );

    expect(providerFactories.input).not.toHaveBeenCalled();
    expect(providerFactories.output).not.toHaveBeenCalled();
    expect(providerFactories.checkpoint).toHaveBeenCalledOnce();
    expect(storageMocks.checkpoint.deleteBucket).toHaveBeenCalledWith(
      workloadId,
    );
  });

  it('skips deleting a managed checkpoint whose name its cloud forbids', async () => {
    const azureStorage = { ...storage(), type: CloudType.Azure };
    await cleanupManagedWorkloadStorage(
      config({
        spot: true,
        checkpointStorageCredentials: TEST_AZURE_CRED,
        checkpointStorageRegion: 'eastus',
      }),
      'x--y',
      { ...providerFactories, checkpoint: vi.fn(() => azureStorage as any) },
    );

    expect(azureStorage.deleteBucket).not.toHaveBeenCalled();
  });

  it('deletes a managed checkpoint created before S3 reserved its name', async () => {
    await cleanupManagedWorkloadStorage(
      config({
        spot: true,
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
      'xn--abc',
      providerFactories,
    );

    expect(storageMocks.checkpoint.deleteBucket).toHaveBeenCalledWith(
      'xn--abc',
    );
  });

  it('does not resolve or delete an explicit retained checkpoint', async () => {
    await cleanupManagedWorkloadStorage(
      config({
        checkpointBucket: 'retained-checkpoint',
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
      workloadId,
      providerFactories,
    );

    expect(providerFactories.checkpoint).not.toHaveBeenCalled();
    expect(storageMocks.checkpoint.deleteBucket).not.toHaveBeenCalled();
  });
});

describe('readWorkloadCheckpointHealth', () => {
  const spotConfig = config({
    spot: true,
    checkpointStorageCredentials: TEST_AWS_CRED,
    checkpointStorageRegion: 'us-east-1',
  });
  const lister = (page: {
    entries: Array<
      | { kind: 'prefix'; key: string }
      | {
          kind: 'object';
          key: string;
          sizeBytes: number | null;
          lastModifiedAt: number | null;
        }
    >;
    nextCursor: string | null;
  }) => {
    const listObjects = vi.fn(async () => page);
    const factories: WorkloadStorageProviderFactories = {
      ...providerFactories,
      checkpoint: vi.fn(
        () =>
          Object.assign({}, storageMocks.checkpoint, { listObjects }) as any,
      ),
    };
    return { listObjects, factories };
  };

  it('counts objects, bytes and the newest modification in one recursive page', async () => {
    const { listObjects, factories } = lister({
      entries: [
        { kind: 'object', key: 'a/1.pt', sizeBytes: 100, lastModifiedAt: 5 },
        { kind: 'object', key: 'a/2.pt', sizeBytes: null, lastModifiedAt: 9 },
        { kind: 'object', key: 'b.json', sizeBytes: 20, lastModifiedAt: null },
      ],
      nextCursor: null,
    });
    await expect(
      readWorkloadCheckpointHealth(spotConfig, workloadId, '', factories),
    ).resolves.toEqual({
      objects: 3,
      bytes: 120,
      lastModifiedAt: 9,
      truncated: false,
    });
    expect(listObjects).toHaveBeenCalledWith(workloadId, {
      prefix: '',
      recursive: true,
      pageSize: 1000,
    });
  });

  it("0043/S10 lists only a pool Job's own prefix", async () => {
    const { listObjects, factories } = lister({
      entries: [],
      nextCursor: null,
    });
    await readWorkloadCheckpointHealth(
      spotConfig,
      workloadId,
      `${workloadId}/`,
      factories,
    );
    expect(listObjects).toHaveBeenCalledWith(
      workloadId,
      expect.objectContaining({ prefix: `${workloadId}/` }),
    );
  });

  it('marks a capped listing as truncated and an empty bucket as never written', async () => {
    const capped = lister({ entries: [], nextCursor: 'more' });
    await expect(
      readWorkloadCheckpointHealth(
        spotConfig,
        workloadId,
        '',
        capped.factories,
      ),
    ).resolves.toEqual({
      objects: 0,
      bytes: 0,
      lastModifiedAt: null,
      truncated: true,
    });
  });

  it('refuses a Workload without a checkpoint or a provider that cannot list', async () => {
    await expect(
      readWorkloadCheckpointHealth(config(), workloadId, '', providerFactories),
    ).rejects.toThrow('no checkpoint');
    await expect(
      readWorkloadCheckpointHealth(
        spotConfig,
        workloadId,
        '',
        providerFactories,
      ),
    ).rejects.toThrow('cannot list');
  });
});
