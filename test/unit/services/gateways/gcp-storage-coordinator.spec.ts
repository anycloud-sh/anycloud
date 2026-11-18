import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { GCP } from '../../../../src/api/services/gateways/gcp';
import { resetStorageCoordinatorForTests } from '../../../../src/api/services/gateways/storage-coordinator';
import { CloudType } from '../../../../src/shared/cloud.js';

vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@google-cloud/compute', () => ({
  InstancesClient: vi.fn(),
  FirewallsClient: vi.fn(),
  GlobalOperationsClient: vi.fn(),
  ZoneOperationsClient: vi.fn(),
  ImagesClient: vi.fn(),
  DisksClient: vi.fn(),
  MachineTypesClient: vi.fn(),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn(),
}));

describe('GCP storage coordination', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-micro',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStorageCoordinatorForTests();
  });

  it('shares concurrent same-bucket checks across gateway instances', async () => {
    let releaseExists!: (value: [boolean]) => void;
    const exists = vi.fn(
      () =>
        new Promise<[boolean]>((resolve) => {
          releaseExists = resolve;
        }),
    );
    const storageClient = {
      bucket: vi.fn().mockReturnValue({ exists }),
    };
    const first = new GCP(completeCloudConfig(mockConfig));
    const second = new GCP(completeCloudConfig(mockConfig));
    first.storageClient = storageClient as never;
    second.storageClient = storageClient as never;

    const checks = Promise.all([
      first.storage().hasBucket('shared-bucket'),
      second.storage().hasBucket('shared-bucket'),
    ]);
    await vi.waitFor(() => expect(exists).toHaveBeenCalledTimes(1));
    releaseExists([true]);

    await expect(checks).resolves.toEqual([true, true]);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('does not cache provider check failures', async () => {
    const exists = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider refused the request'))
      .mockResolvedValueOnce([true]);
    const storageClient = {
      bucket: vi.fn().mockReturnValue({ exists }),
    };
    const gcp = new GCP(completeCloudConfig(mockConfig));
    gcp.storageClient = storageClient as never;

    await expect(gcp.storage().hasBucket('flaky-bucket')).rejects.toThrow(
      'provider refused the request',
    );
    await expect(gcp.storage().hasBucket('flaky-bucket')).resolves.toBe(true);
    expect(exists).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent same-bucket upserts across gateway instances', async () => {
    let releaseCreate!: (value: unknown) => void;
    const createBucket = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve;
        }),
    );
    const bucket = {
      exists: vi.fn().mockResolvedValue([false]),
    };
    const storageClient = {
      bucket: vi.fn().mockReturnValue(bucket),
      createBucket,
    };
    const first = new GCP(completeCloudConfig(mockConfig));
    const second = new GCP(completeCloudConfig(mockConfig));
    first.storageClient = storageClient as never;
    second.storageClient = storageClient as never;

    const upserts = Promise.all([
      first.storage().upsertBucket('shared-output', '0.3.2', 'deploy-1', ''),
      second.storage().upsertBucket('shared-output', '0.3.2', 'deploy-2', ''),
    ]);
    await vi.waitFor(() => expect(createBucket).toHaveBeenCalledTimes(1));
    releaseCreate([bucket]);

    await expect(upserts).resolves.toEqual([undefined, undefined]);
    expect(bucket.exists).toHaveBeenCalledTimes(1);
    expect(createBucket).toHaveBeenCalledTimes(1);
  });

  it('recovers 50 shared upserts after repeated transient premature-close failures', async () => {
    vi.useFakeTimers();
    try {
      const transientClose = new Error(
        'Invalid response body while trying to fetch https://oauth2.googleapis.com/token: Premature close',
      );
      const exists = vi
        .fn()
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockResolvedValueOnce([false]);
      const bucket = { exists };
      const createBucket = vi.fn().mockResolvedValue([bucket]);
      const storageClient = {
        bucket: vi.fn().mockReturnValue(bucket),
        createBucket,
      };
      const gateways = Array.from({ length: 50 }, () => {
        const gateway = new GCP(completeCloudConfig(mockConfig));
        gateway.storageClient = storageClient as never;
        return gateway;
      });

      const upserts = Promise.all(
        gateways.map((gateway, index) =>
          gateway
            .storage()
            .upsertBucket('shared-output', '0.3.2', `deploy-${index + 1}`, ''),
        ),
      );
      await vi.runAllTimersAsync();

      await expect(upserts).resolves.toHaveLength(50);
      expect(exists).toHaveBeenCalledTimes(9);
      expect(createBucket).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
