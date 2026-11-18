import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CandidateRegionAvailability,
  canClassifyTerminalAuthError,
  canFilterCandidateRegions,
  canLaunchSpotPools,
  canListBuckets,
  canListObjects,
  canManageCloudResources,
  canSupportIngress,
  confirmVMRelease,
  createCandidateRegionFilter,
  deleteWithRetry,
  createCloudCompute,
  createVMReleaseConfirmer,
  createCloudStorage,
  isCloudStorage,
  isPreemptible,
  isTransientTransportError,
  METADATA_NODE_POOL_BOOT,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  VM_RELEASE_CONFIRMING,
  VM_RELEASED,
  vmReleaseUnknown,
} from '../../../../src/api/services/gateways/cloud';
import { CandidatePreflightCache } from '../../../../src/api/services/candidate-preflight-cache';
import { resetStorageCoordinatorForTests } from '../../../../src/api/services/gateways/storage-coordinator';
import { CloudType, GpuRuntime } from '../../../../src/shared/cloud.js';
import {
  NEURON_RUNTIME_UNSUPPORTED_MESSAGE,
  PROVIDER_DATA,
} from '../../../../src/shared/providers';
import {
  BucketNotFoundError,
  ObjectNotFoundError,
} from '../../../../src/shared/errors';
import { retryUntil } from '../../../../src/shared/utils';
import { log } from '../../../../src/api/services/logger';
import { makeNewVMProps } from '../../helpers/fixtures';

// Mock the logger to avoid console output during tests
vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('deleteWithRetry', () => {
  const isNotFound = (e: any) => e.code === 'NOT_FOUND';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should succeed on first attempt', async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    await deleteWithRetry(deleteFn, 'test-resource', isNotFound, 3, 10);
    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it('should treat NOT_FOUND as success', async () => {
    const deleteFn = vi.fn().mockRejectedValue({ code: 'NOT_FOUND' });
    await deleteWithRetry(deleteFn, 'test-resource', isNotFound, 3, 10);
    expect(deleteFn).toHaveBeenCalledTimes(1);
    // No throw = success
  });

  it('should retry on any errors', async () => {
    const deleteFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'SOME_ERROR', message: 'retry me' })
      .mockRejectedValueOnce({ code: 'ANOTHER_ERROR', message: 'retry me' })
      .mockResolvedValue(undefined);

    await deleteWithRetry(deleteFn, 'test-resource', isNotFound, 5, 10);
    expect(deleteFn).toHaveBeenCalledTimes(3);
  });

  it('should throw after maxAttempts on errors', async () => {
    const deleteFn = vi
      .fn()
      .mockRejectedValue({ code: 'SOME_ERROR', message: 'keep retrying' });

    await expect(
      deleteWithRetry(deleteFn, 'test-resource', isNotFound, 3, 10),
    ).rejects.toEqual({ code: 'SOME_ERROR', message: 'keep retrying' });

    expect(deleteFn).toHaveBeenCalledTimes(3);
  });

  it('should succeed after errors if eventual success', async () => {
    const deleteFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'TEMP_ERROR', message: 'temp' })
      .mockResolvedValue(undefined);

    await deleteWithRetry(deleteFn, 'test-resource', isNotFound, 3, 10);
    expect(deleteFn).toHaveBeenCalledTimes(2);
  });

  it('should handle error then NOT_FOUND correctly', async () => {
    // First: some error, second: not found (treat as success)
    const deleteFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'TEMP_ERROR', message: 'temp' })
      .mockRejectedValueOnce({ code: 'NOT_FOUND' });

    await deleteWithRetry(deleteFn, 'test-resource', isNotFound, 5, 10);
    expect(deleteFn).toHaveBeenCalledTimes(2);
  });

  it('should use default maxAttempts and waitMs', async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    await deleteWithRetry(deleteFn, 'test-resource', isNotFound);
    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after one attempt when shouldRetry returns false (terminal error)', async () => {
    // A rotated credential re-fails identically every attempt; the predicate
    // short-circuits the chain instead of burning all maxAttempts.
    const terminal = { code: 'AuthorizationFailed', message: 'bad secret' };
    const deleteFn = vi.fn().mockRejectedValue(terminal);

    await expect(
      deleteWithRetry(
        deleteFn,
        'test-resource',
        isNotFound,
        180,
        10,
        () => false,
      ),
    ).rejects.toEqual(terminal);

    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying when shouldRetry returns true', async () => {
    const deleteFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'TEMP_ERROR', message: 'temp' })
      .mockResolvedValue(undefined);

    await deleteWithRetry(
      deleteFn,
      'test-resource',
      isNotFound,
      5,
      10,
      () => true,
    );
    expect(deleteFn).toHaveBeenCalledTimes(2);
  });
});

describe('retryUntil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return result when condition is met on first attempt', async () => {
    const operation = vi.fn().mockResolvedValue({ status: 'ready' });
    const condition = (result: any) => result.status === 'ready';

    const result = await retryUntil(operation, condition, 'test-resource', {
      maxAttempts: 3,
      waitMs: 10,
    });

    expect(result).toEqual({ status: 'ready' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should poll until condition is met', async () => {
    const operation = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ready' });
    const condition = (result: any) => result.status === 'ready';

    const result = await retryUntil(operation, condition, 'test-resource', {
      maxAttempts: 5,
      waitMs: 10,
    });

    expect(result).toEqual({ status: 'ready' });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts when condition never met', async () => {
    const operation = vi.fn().mockResolvedValue({ status: 'pending' });
    const condition = (result: any) => result.status === 'ready';

    await expect(
      retryUntil(operation, condition, 'vm-instance', {
        maxAttempts: 3,
        waitMs: 10,
      }),
    ).rejects.toThrow('vm-instance failed after 3 attempts');

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should propagate operation errors', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Network error'));
    const condition = (result: any) => result.status === 'ready';

    await expect(
      retryUntil(operation, condition, 'test-resource', {
        maxAttempts: 3,
        waitMs: 10,
      }),
    ).rejects.toThrow('Network error');

    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('transient-transport retry', () => {
  describe('isTransientTransportError', () => {
    it('matches transport-level drops (retryable)', () => {
      // The exact error the gcp-invalid e2e leg hit: the OAuth token POST was
      // severed mid-response. The same shape applies to any cloud's token fetch.
      expect(
        isTransientTransportError(
          new Error(
            'Invalid response body while trying to fetch https://www.googleapis.com/oauth2/v4/token: Premature close',
          ),
        ),
      ).toBe(true);
      expect(isTransientTransportError(new Error('read ECONNRESET'))).toBe(
        true,
      );
      expect(isTransientTransportError(new Error('socket hang up'))).toBe(true);
    });

    it('matches undici "fetch failed" and other transport tokens', () => {
      expect(isTransientTransportError(new Error('fetch failed'))).toBe(true);
      expect(isTransientTransportError(new Error('write EPIPE'))).toBe(true);
    });

    it('matches structured network codes, including wrapped causes', () => {
      expect(
        isTransientTransportError(
          Object.assign(new Error('request failed'), {
            code: 'ECONNREFUSED',
          }),
        ),
      ).toBe(true);
      expect(
        isTransientTransportError(
          new Error('getaddrinfo ENOTFOUND management.azure.com'),
        ),
      ).toBe(true);
      expect(
        isTransientTransportError(
          Object.assign(new Error('cloud SDK request failed'), {
            cause: Object.assign(new Error('DNS lookup failed'), {
              code: 'EAI_AGAIN',
            }),
          }),
        ),
      ).toBe(true);
    });

    it('matches standard fetch deadline timeouts but not caller cancellation', () => {
      expect(
        isTransientTransportError(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        ),
      ).toBe(true);
      expect(
        isTransientTransportError(
          new DOMException('This operation was aborted', 'AbortError'),
        ),
      ).toBe(false);
    });

    it('does NOT match terminal auth errors or non-Errors (fail fast)', () => {
      // invalid_grant / invalid auth are application responses, not transport
      // drops — a genuinely bad credential must fail fast, not retry.
      expect(
        isTransientTransportError(new Error('invalid_grant: bad key')),
      ).toBe(false);
      expect(
        isTransientTransportError(
          new Error('Request had invalid authentication credentials'),
        ),
      ).toBe(false);
      expect(isTransientTransportError('Premature close')).toBe(false);
      expect(isTransientTransportError(undefined)).toBe(false);
    });
  });
});

describe('VM release confirmation', () => {
  const stablePolicy = {
    requiredReleaseObservations: 2,
    minObservationIntervalMs: 10_000,
  };

  it('requires successful observations completed at least one interval apart', async () => {
    let now = 1_000;
    const observeOnce = vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE);
    const confirmer = createVMReleaseConfirmer(stablePolicy, () => now);

    await expect(confirmer.observe(observeOnce)).resolves.toBe(
      VM_RELEASE_CONFIRMING,
    );
    now = 10_999;
    await expect(confirmer.observe(observeOnce)).resolves.toBe(
      VM_RELEASE_CONFIRMING,
    );
    expect(observeOnce).toHaveBeenCalledOnce();

    now = 11_000;
    await expect(confirmer.observe(observeOnce)).resolves.toBe(VM_RELEASED);
    expect(observeOnce).toHaveBeenCalledTimes(2);
  });

  it('measures the interval from observation completion, not request start', async () => {
    let now = 1_000;
    const observeOnce = vi
      .fn()
      .mockImplementationOnce(async () => {
        now = 6_000;
        return VM_RELEASE_CANDIDATE;
      })
      .mockResolvedValue(VM_RELEASE_CANDIDATE);
    const confirmer = createVMReleaseConfirmer(stablePolicy, () => now);

    await expect(confirmer.observe(observeOnce)).resolves.toBe(
      VM_RELEASE_CONFIRMING,
    );
    now = 15_999;
    await expect(confirmer.observe(observeOnce)).resolves.toBe(
      VM_RELEASE_CONFIRMING,
    );
    expect(observeOnce).toHaveBeenCalledOnce();

    now = 16_000;
    await expect(confirmer.observe(observeOnce)).resolves.toBe(VM_RELEASED);
  });

  it.each([
    ['present', VM_PRESENT],
    ['unknown', vmReleaseUnknown('provider unavailable')],
  ])(
    'starts a new series after a %s observation',
    async (_name, resetState) => {
      let now = 0;
      const confirmer = createVMReleaseConfirmer(stablePolicy, () => now);

      await confirmer.observe(async () => VM_RELEASE_CANDIDATE);
      now = 10_000;
      await expect(confirmer.observe(async () => resetState)).resolves.toBe(
        resetState,
      );
      now = 20_000;
      await expect(
        confirmer.observe(async () => VM_RELEASE_CANDIDATE),
      ).resolves.toBe(VM_RELEASE_CONFIRMING);
      now = 30_000;
      await expect(
        confirmer.observe(async () => VM_RELEASE_CANDIDATE),
      ).resolves.toBe(VM_RELEASED);
    },
  );

  it('propagates cancellation through the wait between observations', async () => {
    const controller = new AbortController();
    const compute = createCloudCompute({
      type: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(async () => {
        controller.abort(new Error('release deadline exceeded'));
        return VM_RELEASE_CANDIDATE;
      }),
      releaseConfirmationPolicy: stablePolicy,
    });

    await expect(
      confirmVMRelease(compute, 'vm-1', { signal: controller.signal }),
    ).resolves.toEqual({
      state: 'unknown',
      error: 'release deadline exceeded',
    });
  });
});

describe('createCloudStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStorageCoordinatorForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStorageCoordinatorForTests();
  });

  it('brands public storage objects instead of accepting structural matches', () => {
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });

    expect(isCloudStorage(storage)).toBe(true);
    expect(isCloudStorage({ hasBucket: vi.fn() })).toBe(false);
  });

  it('only exposes bucket discovery when the provider supplies listing operations', async () => {
    const baseOps = {
      type: CloudType.GCP,
      region: 'us-central1',
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    };
    const storageWithoutDiscovery = createCloudStorage(baseOps);
    expect(canListBuckets(storageWithoutDiscovery)).toBe(false);
    expect(canListObjects(storageWithoutDiscovery)).toBe(false);

    const rawListBuckets = vi.fn().mockResolvedValue({
      buckets: [{ name: 'data', region: null, createdAt: null }],
      nextCursor: 'bucket-page-2',
    });
    const rawListObjects = vi.fn().mockResolvedValue({
      entries: [{ kind: 'prefix' as const, key: 'models/' }],
      nextCursor: null,
    });
    const storage = createCloudStorage({
      ...baseOps,
      rawListBuckets,
      rawListObjects,
    });
    expect(canListBuckets(storage)).toBe(true);
    expect(canListObjects(storage)).toBe(true);
    if (!canListBuckets(storage) || !canListObjects(storage)) {
      throw new Error('Expected listing capabilities');
    }

    const controller = new AbortController();
    await expect(
      storage.listBuckets(
        { pageSize: 25, cursor: 'bucket-page-1' },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ nextCursor: 'bucket-page-2' });
    const listOptions = {
      prefix: 'models/',
      recursive: false,
      pageSize: 25,
      cursor: 'object-page-1',
    };
    await expect(
      storage.listObjects('data', listOptions, { signal: controller.signal }),
    ).resolves.toMatchObject({ entries: [{ key: 'models/' }] });
    expect(rawListBuckets).toHaveBeenCalledWith(
      { pageSize: 25, cursor: 'bucket-page-1' },
      controller.signal,
    );
    expect(rawListObjects).toHaveBeenCalledWith(
      'data',
      listOptions,
      controller.signal,
    );
  });

  it('raises only the absence the provider classifies, and only where it applies', async () => {
    const providerError = new Error('provider not found');
    const classify = vi.fn();
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn().mockRejectedValue(providerError),
      rawDownloadObject: vi.fn().mockRejectedValue(providerError),
      classifyStorageFailure: classify,
    });
    const source = {
      kind: 'buffer' as const,
      bytes: Buffer.from('x'),
      contentLength: 1,
    };

    classify.mockResolvedValue({ kind: 'bucket-missing', code: '404' });
    await expect(storage.downloadObject('b', 'k')).rejects.toEqual(
      new BucketNotFoundError('b', providerError),
    );
    await expect(storage.uploadObject('b', 'k', source)).rejects.toEqual(
      new BucketNotFoundError('b', providerError),
    );
    classify.mockResolvedValue({ kind: 'object-missing', code: '404' });
    await expect(storage.downloadObject('b', 'k')).rejects.toEqual(
      new ObjectNotFoundError('b', 'k', providerError),
    );
    // An upload creates its object; only a missing bucket is reportable.
    await expect(storage.uploadObject('b', 'k', source)).rejects.toBe(
      providerError,
    );
    classify.mockResolvedValue(undefined);
    await expect(storage.downloadObject('b', 'k')).rejects.toBe(providerError);
    // Denial and throttling are reported by the bucket surface, which knows
    // the credential; workload callers keep the provider error.
    classify.mockResolvedValue({ kind: 'denied', code: '403' });
    await expect(storage.downloadObject('b', 'k')).rejects.toBe(providerError);
    classify.mockRejectedValue(new Error('classification failed'));
    await expect(storage.downloadObject('b', 'k')).rejects.toBe(providerError);
    // Only a download names its key, so only it can be classified 'object'.
    expect(classify).toHaveBeenCalledWith(providerError, 'b', 'k');
    expect(classify).toHaveBeenCalledWith(providerError, 'b', undefined);
  });

  it('retries provider object-listing failures through the storage policy', async () => {
    vi.useFakeTimers();
    const rawListObjects = vi
      .fn()
      .mockRejectedValueOnce(new Error('Premature close'))
      .mockResolvedValueOnce({ entries: [], nextCursor: null });
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      retryPolicy: {
        maxAttempts: 2,
        waitMs: 1,
        jitter: false,
        shouldRetry: isTransientTransportError,
      },
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
      rawListObjects,
    });
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    const listing = storage.listObjects('data', {
      prefix: '',
      recursive: true,
      pageSize: 1000,
    });
    await vi.runAllTimersAsync();
    await expect(listing).resolves.toEqual({ entries: [], nextCursor: null });
    expect(rawListObjects).toHaveBeenCalledTimes(2);
  });

  it('retries upload operations with the same replayable source', async () => {
    vi.useFakeTimers();
    const source = {
      kind: 'buffer' as const,
      bytes: Buffer.from('payload'),
      contentLength: 7,
    };
    const rawUploadObject = vi
      .fn()
      .mockRejectedValueOnce(new Error('Premature close'))
      .mockResolvedValueOnce(undefined);
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      retryPolicy: {
        maxAttempts: 2,
        waitMs: 1,
        jitter: false,
        shouldRetry: isTransientTransportError,
      },
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject,
      rawDownloadObject: vi.fn(),
    });

    const upload = storage.uploadObject('bucket', 'path', source);
    await vi.runAllTimersAsync();
    await expect(upload).resolves.toBeUndefined();

    expect(rawUploadObject).toHaveBeenCalledTimes(2);
    expect(rawUploadObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        bucketName: 'bucket',
        remotePath: 'path',
        source,
      }),
    );
    expect(rawUploadObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bucketName: 'bucket',
        remotePath: 'path',
        source,
      }),
    );
  });

  it('coordinates shared bucket existence checks in the storage factory', async () => {
    let resolveExists!: (exists: boolean) => void;
    const rawHasBucket = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveExists = resolve;
        }),
    );
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });

    const checks = [
      storage.hasBucket('bucket'),
      storage.hasBucket('bucket'),
      storage.hasBucket('bucket'),
    ];
    expect(rawHasBucket).toHaveBeenCalledTimes(1);

    resolveExists(true);
    await expect(Promise.all(checks)).resolves.toEqual([true, true, true]);
  });

  it('cancels only the initiating caller wait for a shared existence check', async () => {
    let resolveExists!: (exists: boolean) => void;
    const rawHasBucket = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveExists = resolve;
        }),
    );
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });
    const controller = new AbortController();
    const cancellation = new DOMException('request stopped', 'AbortError');

    const initiating = storage.hasBucket('bucket', {
      signal: controller.signal,
    });
    const surviving = storage.hasBucket('bucket');
    let initiatingSettled = false;
    const observeInitiating = initiating.then(
      () => {
        initiatingSettled = true;
      },
      () => {
        initiatingSettled = true;
      },
    );
    const initiatingAssertion = expect(initiating).rejects.toBe(cancellation);
    const survivingAssertion = expect(surviving).resolves.toBe(true);

    controller.abort(cancellation);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const cancelledBeforeSharedWorkSettled = initiatingSettled;
    resolveExists(true);

    await Promise.all([
      observeInitiating,
      initiatingAssertion,
      survivingAssertion,
    ]);
    expect(cancelledBeforeSharedWorkSettled).toBe(true);
    expect(rawHasBucket).toHaveBeenCalledOnce();
  });

  it('invalidates a cached positive existence result after deleting a bucket', async () => {
    let bucketExists = true;
    const rawHasBucket = vi.fn().mockImplementation(async () => bucketExists);
    const rawDeleteBucket = vi.fn().mockImplementation(async () => {
      bucketExists = false;
    });
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket,
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });

    await expect(storage.hasBucket('bucket')).resolves.toBe(true);
    await expect(storage.hasBucket('bucket')).resolves.toBe(true);
    expect(rawHasBucket).toHaveBeenCalledTimes(1);

    await expect(storage.deleteBucket('bucket')).resolves.toBeUndefined();

    await expect(storage.hasBucket('bucket')).resolves.toBe(false);
    expect(rawDeleteBucket).toHaveBeenCalledTimes(1);
    expect(rawHasBucket).toHaveBeenCalledTimes(2);
  });

  it('invalidates a cached positive existence result after a normalized not-found delete', async () => {
    const notFound = { code: 'NOT_FOUND' };
    const rawHasBucket = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const rawDeleteBucket = vi.fn().mockRejectedValue(notFound);
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket,
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
      isNotFound: (error) => error === notFound,
    });

    await expect(storage.hasBucket('bucket')).resolves.toBe(true);
    await expect(storage.deleteBucket('bucket')).resolves.toBeUndefined();

    await expect(storage.hasBucket('bucket')).resolves.toBe(false);
    expect(rawDeleteBucket).toHaveBeenCalledTimes(1);
    expect(rawHasBucket).toHaveBeenCalledTimes(2);
  });

  it('retains a cached positive existence result after a failed delete', async () => {
    const terminalError = new Error('invalid_grant');
    const rawHasBucket = vi.fn().mockResolvedValue(true);
    const rawDeleteBucket = vi.fn().mockRejectedValue(terminalError);
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket,
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });

    await expect(storage.hasBucket('bucket')).resolves.toBe(true);
    await expect(storage.deleteBucket('bucket')).rejects.toBe(terminalError);

    await expect(storage.hasBucket('bucket')).resolves.toBe(true);
    expect(rawDeleteBucket).toHaveBeenCalledTimes(1);
    expect(rawHasBucket).toHaveBeenCalledTimes(1);
  });

  it('invalidates a cached positive result when a cancelled delete may have completed', async () => {
    let bucketExists = true;
    let finishDelete!: () => void;
    const rawHasBucket = vi.fn().mockImplementation(async () => bucketExists);
    const rawDeleteBucket = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = () => {
            bucketExists = false;
            resolve();
          };
        }),
    );
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket,
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });
    const controller = new AbortController();
    const cancellation = new DOMException('request stopped', 'AbortError');

    await expect(storage.hasBucket('bucket')).resolves.toBe(true);
    const deletion = storage.deleteBucket('bucket', {
      signal: controller.signal,
    });
    const deletionAssertion = expect(deletion).rejects.toBe(cancellation);

    controller.abort(cancellation);
    finishDelete();

    await deletionAssertion;
    await expect(storage.hasBucket('bucket')).resolves.toBe(false);
    expect(rawDeleteBucket).toHaveBeenCalledOnce();
    expect(rawHasBucket).toHaveBeenCalledTimes(2);
  });

  it('uses coordinated bucket retry for shared bucket upserts', async () => {
    vi.useFakeTimers();
    const rawUploadObject = vi
      .fn()
      .mockRejectedValueOnce(new Error('Premature close'))
      .mockResolvedValueOnce(undefined);
    const rawUpsertBucket = vi
      .fn()
      .mockRejectedValueOnce(new Error('Premature close'))
      .mockResolvedValueOnce(undefined);
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      retryPolicy: {
        maxAttempts: 2,
        waitMs: 1,
        jitter: false,
        shouldRetry: isTransientTransportError,
      },
      rawBucketCoordinationKey: () => 'bucket-key',
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: rawUpsertBucket,
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject,
      rawDownloadObject: vi.fn(),
    });

    const upsert = storage.upsertBucket('bucket', '0.3.2', 'deploy-1', '');
    await vi.runAllTimersAsync();
    await expect(upsert).resolves.toBeUndefined();
    expect(rawUpsertBucket).toHaveBeenCalledTimes(2);

    const upload = storage.uploadObject('bucket', 'path', {
      kind: 'buffer',
      bytes: Buffer.from('payload'),
      contentLength: 7,
    });
    await vi.runAllTimersAsync();

    await expect(upload).resolves.toBeUndefined();
    expect(rawUploadObject).toHaveBeenCalledTimes(2);
  });

  it('cancels only the initiating caller wait for a shared bucket upsert', async () => {
    let resolveUpsert!: () => void;
    const rawUpsertBucket = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const storage = createCloudStorage({
      type: CloudType.Azure,
      region: 'eastus',
      coordinatedUpsertShouldRetry: isTransientTransportError,
      rawBucketCoordinationKey: (bucketName) => `test:${bucketName}`,
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: rawUpsertBucket,
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });
    const controller = new AbortController();
    const cancellation = new DOMException('request stopped', 'AbortError');

    const initiating = storage.upsertBucket('bucket', '0.3.2', 'deploy-1', '', {
      signal: controller.signal,
    });
    const surviving = storage.upsertBucket('bucket', '0.3.2', 'deploy-2', '');
    let initiatingSettled = false;
    const observeInitiating = initiating.then(
      () => {
        initiatingSettled = true;
      },
      () => {
        initiatingSettled = true;
      },
    );
    const initiatingAssertion = expect(initiating).rejects.toBe(cancellation);
    const survivingAssertion = expect(surviving).resolves.toBeUndefined();

    controller.abort(cancellation);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const cancelledBeforeSharedWorkSettled = initiatingSettled;
    resolveUpsert();

    await Promise.all([
      observeInitiating,
      initiatingAssertion,
      survivingAssertion,
    ]);
    expect(cancelledBeforeSharedWorkSettled).toBe(true);
    expect(rawUpsertBucket).toHaveBeenCalledOnce();
  });

  it('generically retries bucket upserts that do not own retry', async () => {
    vi.useFakeTimers();
    const rawUpsertBucket = vi
      .fn()
      .mockRejectedValueOnce(new Error('Premature close'))
      .mockResolvedValueOnce(undefined);
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      retryPolicy: {
        maxAttempts: 2,
        waitMs: 1,
        jitter: false,
        shouldRetry: isTransientTransportError,
      },
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: rawUpsertBucket,
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });

    const upsert = storage.upsertBucket('bucket', '0.3.2', 'deploy-1', '');
    await vi.runAllTimersAsync();

    await expect(upsert).resolves.toBeUndefined();
    expect(rawUpsertBucket).toHaveBeenCalledTimes(2);
  });

  it('treats not-found delete errors as success without retrying', async () => {
    const shouldRetry = vi.fn().mockReturnValue(true);
    const rawDeleteObject = vi.fn().mockRejectedValue({ code: 'NOT_FOUND' });
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      retryPolicy: {
        maxAttempts: 3,
        waitMs: 1,
        jitter: false,
        shouldRetry,
      },
      rawHasBucket: vi.fn(),
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject,
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
      isNotFound: (error) => (error as { code?: string })?.code === 'NOT_FOUND',
    });

    await expect(
      storage.deleteObject('bucket', 'path'),
    ).resolves.toBeUndefined();
    expect(rawDeleteObject).toHaveBeenCalledTimes(1);
    expect(shouldRetry).not.toHaveBeenCalled();
  });

  it('does not retry terminal storage errors', async () => {
    const rawHasBucket = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    const storage = createCloudStorage({
      type: CloudType.GCP,
      region: 'us-central1',
      retryPolicy: {
        maxAttempts: 3,
        waitMs: 1,
        jitter: false,
        shouldRetry: isTransientTransportError,
      },
      rawHasBucket,
      rawUpsertBucketUncoordinated: vi.fn(),
      rawDeleteBucket: vi.fn(),
      rawDeleteObject: vi.fn(),
      rawUploadObject: vi.fn(),
      rawDownloadObject: vi.fn(),
    });

    await expect(storage.hasBucket('bucket')).rejects.toThrow('invalid_grant');
    expect(rawHasBucket).toHaveBeenCalledTimes(1);
  });
});

describe('createCloudCompute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves new and adopted VM endpoints while leaving inventory observations raw', async () => {
    const rawNewVM = vi.fn().mockResolvedValue({
      cloudId: 'new-vm',
      ip: '203.0.113.10',
    });
    const rawAdoptProvisioningAttempt = vi.fn().mockResolvedValue({
      cloudId: 'adopted-vm',
      ip: '203.0.113.11',
      sshHost: '127.0.0.1',
      sshPort: 22022,
      sshUsername: 'acuser',
    });
    const inventory = [{ cloudId: 'starting-vm', ip: '' }];
    const compute = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawAdoptProvisioningAttempt,
      rawNewVM,
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn().mockResolvedValue(inventory),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    });
    const props = makeNewVMProps({
      workloadId: 'endpoint-resolution',
      vmId: 'endpoint-resolution-0',
      ipWhitelist: [],
      startupScript: '#!/bin/bash',
      version: '1.0.0',
      userId: 'test-user',
    });

    await expect(compute.newVM(props)).resolves.toEqual({
      cloudId: 'new-vm',
      ip: '203.0.113.10',
      sshHost: '203.0.113.10',
      sshPort: 22,
      sshUsername: 'root',
    });
    await expect(
      compute.adoptProvisioningAttempt?.({
        workloadId: props.workloadId,
        vmId: props.vmId,
        userId: props.userId,
      }),
    ).resolves.toEqual({
      cloudId: 'adopted-vm',
      ip: '203.0.113.11',
      sshHost: '127.0.0.1',
      sshPort: 22022,
      sshUsername: 'acuser',
    });
    await expect(compute.getAllVMs()).resolves.toBe(inventory);
  });

  it('rejects a provisioned VM without an IP at the shared boundary', async () => {
    const compute = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn().mockResolvedValue({
        cloudId: 'missing-ip',
        ip: null,
      }),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    });

    await expect(
      compute.newVM({
        workloadId: 'missing-ip',
        vmId: 'missing-ip-0',
        ipWhitelist: [],
        startupScript: '#!/bin/bash',
        version: '1.0.0',
        userId: 'test-user',
      }),
    ).rejects.toThrow(
      'Cannot resolve gateway VM missing-ip without an IP address',
    );
  });

  it('resolves resource-scoped VM endpoints through the same boundary', async () => {
    const compute = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
      resourceScoped: {
        nodePoolBoot: METADATA_NODE_POOL_BOOT,
        prepareResourceNetwork: vi.fn(),
        adoptResourceProvisioningAttempt: vi.fn().mockResolvedValue({
          cloudId: 'adopted-resource-vm',
          ip: '203.0.113.20',
        }),
        newResourceVM: vi.fn().mockResolvedValue({
          cloudId: 'resource-vm',
          ip: '203.0.113.21',
          sshPort: 22022,
        }),
        terminateResourceNetwork: vi.fn(),
      },
    });
    expect(canManageCloudResources(compute)).toBe(true);
    if (!canManageCloudResources(compute)) {
      throw new Error('expected resource-scoped compute capability');
    }

    await expect(
      compute.adoptResourceProvisioningAttempt?.({
        scope: { id: 'cluster-1', tags: {} },
        vmId: 'cluster-1-vm-0',
      }),
    ).resolves.toMatchObject({
      sshHost: '203.0.113.20',
      sshPort: 22,
      sshUsername: 'root',
    });
    await expect(
      compute.newResourceVM({
        scope: { id: 'cluster-1', tags: {} },
        vmId: 'cluster-1-vm-1',
        ipWhitelist: [],
        startupScript: '#!/bin/bash',
        version: '1.0.0',
      }),
    ).resolves.toMatchObject({
      sshHost: '203.0.113.21',
      sshPort: 22022,
      sshUsername: 'root',
    });
  });

  it('enforces the cloud runtime capability before raw provider code, including Lambda', async () => {
    const rawNewVM = vi.fn().mockResolvedValue({
      cloudId: 'lambda-instance',
      ip: '203.0.113.10',
    });
    const compute = createCloudCompute({
      type: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM,
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    });
    const props = makeNewVMProps({
      workloadId: 'runtime-capability',
      vmId: 'runtime-capability-0',
      ipWhitelist: [],
      startupScript: '#!/bin/bash',
      version: '1.0.0',
      userId: 'test-user',
      gpuRuntime: GpuRuntime.Neuron,
    });

    await expect(compute.newVM(props)).rejects.toMatchObject({
      statusCode: 400,
      message: NEURON_RUNTIME_UNSUPPORTED_MESSAGE,
    });
    expect(rawNewVM).not.toHaveBeenCalled();

    await expect(
      compute.newVM({ ...props, gpuRuntime: GpuRuntime.Cuda }),
    ).resolves.toMatchObject({ cloudId: 'lambda-instance' });
    expect(rawNewVM).toHaveBeenCalledOnce();
  });

  it('preserves optional preemption and candidate-availability capabilities', async () => {
    const verifyVMPreemption = vi.fn().mockResolvedValue(true);
    const startVM = vi.fn().mockResolvedValue('203.0.113.10');
    const runPreflight = vi.fn(async () => true);
    const candidateRegionFilter = createCandidateRegionFilter({
      cache: new CandidatePreflightCache<boolean>(),
      cacheKey: () => 'account',
      runPreflight,
      assess: () => CandidateRegionAvailability.Verified,
    });
    const compute = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      spot: true,
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
      stoppedVmObservation: { observeStoppedVm: vi.fn() },
      stoppedVmRestart: { verifyVMPreemption, startVM },
      candidateRegionFilter,
    });

    expect(isPreemptible(compute)).toBe(true);
    expect(canFilterCandidateRegions(compute)).toBe(true);
    expect(
      isPreemptible({
        verifyVMPreemption: vi.fn(),
        startVM: vi.fn(),
      }),
    ).toBe(false);

    if (!isPreemptible(compute) || !canFilterCandidateRegions(compute)) {
      throw new Error('expected optional compute capabilities');
    }
    await expect(compute.verifyVMPreemption('vm-1')).resolves.toBe(true);
    await expect(compute.startVM('vm-1')).resolves.toBe('203.0.113.10');
    await expect(
      compute.filterCandidateRegions(
        [{ vmType: 't3.large', region: 'us-east-1' }],
        true,
        'dep-1',
        {
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 5_000,
        },
      ),
    ).resolves.toEqual([{ vmType: 't3.large', region: 'us-east-1' }]);
    expect(runPreflight).toHaveBeenCalledOnce();
  });

  it('0044/S23: admits Spot pools on Spot launch and stopped-VM observation, keeping restart for VM spot Jobs', () => {
    const ops = {
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    };
    const stoppedVmObservation = { observeStoppedVm: vi.fn() };
    const stopOnEvict = createCloudCompute({
      ...ops,
      spotLaunch: true,
      stoppedVmObservation,
    });
    expect(canLaunchSpotPools(stopOnEvict)).toBe(true);
    expect(isPreemptible(stopOnEvict)).toBe(false);
    expect(
      canLaunchSpotPools(createCloudCompute({ ...ops, spotLaunch: true })),
    ).toBe(false);
    expect(
      canLaunchSpotPools(createCloudCompute({ ...ops, stoppedVmObservation })),
    ).toBe(false);
  });

  it('0044/S24: a pools-only gateway refuses the cluster scope before any provider call', async () => {
    const resourceScoped = {
      nodePoolBoot: METADATA_NODE_POOL_BOOT,
      prepareResourceNetwork: vi.fn(),
      adoptResourceProvisioningAttempt: vi.fn().mockResolvedValue(null),
      newResourceVM: vi.fn().mockResolvedValue({
        cloudId: 'pool-vm',
        ip: '203.0.113.21',
      }),
      terminateResourceNetwork: vi.fn(),
    };
    const data = PROVIDER_DATA[CloudType.AWS].compute as {
      poolsOnly?: boolean;
    };
    data.poolsOnly = true;
    try {
      const compute = createCloudCompute({
        type: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.large',
        rawValidateCredentials: vi.fn(),
        rawClassifyError: vi.fn(),
        rawNewVM: vi.fn(),
        rawRequestVMTermination: vi.fn(),
        rawTerminateNetworking: vi.fn(),
        rawGetAllVMs: vi.fn(),
        rawUpsertFirewall: vi.fn(),
        observeVMReleaseOnce: vi.fn(),
        resourceScoped,
      });
      if (!canManageCloudResources(compute)) {
        throw new Error('expected resource-scoped compute capability');
      }
      const cluster = { id: 'anycloud-cluster-inst-1', tags: {} };
      const launch = {
        vmId: 'vm-1',
        ipWhitelist: [],
        startupScript: '#!/bin/bash',
        version: '1.0.0',
      };
      await expect(
        compute.prepareResourceNetwork({ ingress: [] }, cluster, '1.0.0'),
      ).rejects.toThrow("can't host a cluster's management VM");
      await expect(
        compute.adoptResourceProvisioningAttempt!({
          scope: cluster,
          vmId: 'vm-1',
        }),
      ).rejects.toThrow("can't host a cluster's management VM");
      await expect(
        compute.newResourceVM({ ...launch, scope: cluster }),
      ).rejects.toThrow("can't host a cluster's management VM");
      expect(resourceScoped.prepareResourceNetwork).not.toHaveBeenCalled();
      expect(
        resourceScoped.adoptResourceProvisioningAttempt,
      ).not.toHaveBeenCalled();
      expect(resourceScoped.newResourceVM).not.toHaveBeenCalled();

      await expect(
        compute.newResourceVM({
          ...launch,
          scope: { id: 'gpu-a1b2c3', tags: {} },
        }),
      ).resolves.toMatchObject({ cloudId: 'pool-vm' });
    } finally {
      delete data.poolsOnly;
    }
  });

  it('preserves ingress support as a branded optional capability', () => {
    const supportsIngress = vi.fn().mockReturnValue(true);
    const compute = createCloudCompute({
      type: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
      ingressSupport: {
        supportsIngress,
      },
    });
    const withoutSupport = createCloudCompute({
      type: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    });

    expect(canSupportIngress(compute)).toBe(true);
    expect(canSupportIngress(withoutSupport)).toBe(false);
    expect(
      canSupportIngress({
        supportsIngress: vi.fn(),
      }),
    ).toBe(false);
    if (!canSupportIngress(compute)) {
      throw new Error('expected ingress support capability');
    }
    expect(compute.supportsIngress({ ingress: [] })).toBe(true);
    expect(supportsIngress).toHaveBeenCalledWith({ ingress: [] });
  });

  it('preserves terminal auth classification without making it required', () => {
    const isTerminalAuthError = vi.fn().mockReturnValue(true);
    const compute = createCloudCompute({
      type: CloudType.Azure,
      region: 'eastus',
      spot: true,
      vmType: 'Standard_D2s_v5',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
      terminalAuthErrorClassifier: {
        isTerminalAuthError,
      },
    });
    const withoutClassifier = createCloudCompute({
      type: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    });

    expect(canClassifyTerminalAuthError(compute)).toBe(true);
    if (!canClassifyTerminalAuthError(compute)) {
      throw new Error('expected terminal auth classifier');
    }
    expect(compute.isTerminalAuthError(new Error('bad secret'))).toBe(true);
    expect(isTerminalAuthError).toHaveBeenCalledOnce();
    expect(canClassifyTerminalAuthError(withoutClassifier)).toBe(false);
    expect(
      canClassifyTerminalAuthError({
        isTerminalAuthError: vi.fn(),
      }),
    ).toBe(false);
  });

  it('owns terminateVMs fan-out and returns only confirmed VM ids', async () => {
    const rawRequestVMTermination = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('still attached'))
      .mockResolvedValueOnce(undefined);
    const compute = createCloudCompute({
      type: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination,
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
    });

    await expect(
      compute.terminateVMs(['vm-1', 'vm-2', 'vm-3']),
    ).resolves.toEqual(['vm-1', 'vm-3']);
    expect(rawRequestVMTermination).toHaveBeenCalledTimes(3);
    expect(rawRequestVMTermination).toHaveBeenNthCalledWith(1, 'vm-1');
    expect(rawRequestVMTermination).toHaveBeenNthCalledWith(2, 'vm-2');
    expect(rawRequestVMTermination).toHaveBeenNthCalledWith(3, 'vm-3');
  });

  it('excludes a vmId that never confirms terminated even when the raw call did not throw', async () => {
    // Regression guard: a gateway whose terminate call resolves ok but whose
    // cloud never actually confirms the specific vmId gone (see the Lambda
    // false-positive incident) must not be reported as deleted.
    const rawRequestVMTermination = vi.fn().mockResolvedValue(undefined);
    const observeVMReleaseOnce = vi.fn().mockResolvedValue(VM_PRESENT);
    const compute = createCloudCompute({
      type: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination,
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce,
      releaseConfirmMaxAttempts: 2,
      releaseConfirmWaitMs: 1,
    });

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await expect(compute.terminateVMs(['vm-1'])).resolves.toEqual([]);
    expect(rawRequestVMTermination).toHaveBeenCalledWith('vm-1');
    expect(observeVMReleaseOnce).toHaveBeenCalledWith('vm-1');
    // The exclusion above is correct but was silent, which is what made a
    // fleet-wide teardown regression unattributable from the record alone.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unconfirmed'),
      expect.objectContaining({ cloudId: 'vm-1', provider: CloudType.Lambda }),
    );
    warnSpy.mockRestore();
  });

  it('confirms termination after an unknown provider result', async () => {
    const rawRequestVMTermination = vi.fn().mockResolvedValue(undefined);
    const observeVMReleaseOnce = vi
      .fn()
      .mockResolvedValueOnce(vmReleaseUnknown('provider unavailable'))
      .mockResolvedValueOnce(VM_RELEASE_CANDIDATE);
    const compute = createCloudCompute({
      type: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'gpu_1x_a100',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination,
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce,
      releaseConfirmMaxAttempts: 3,
      releaseConfirmWaitMs: 1,
    });

    await expect(compute.terminateVMs(['vm-1'])).resolves.toEqual(['vm-1']);
    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(2);
  });

  it('treats provider placeholders as already gone without raw calls', async () => {
    const rawRequestVMTermination = vi.fn().mockResolvedValue(undefined);
    const compute = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination,
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
      releaseConfirmWaitMs: 1,
      isPlaceholderVMId: (vmId) => vmId.startsWith('placeholder-'),
    });

    await expect(
      compute.terminateVMs(['placeholder-1', 'i-real']),
    ).resolves.toEqual(['placeholder-1', 'i-real']);
    expect(rawRequestVMTermination).toHaveBeenCalledOnce();
    expect(rawRequestVMTermination).toHaveBeenCalledWith('i-real');
  });
});
