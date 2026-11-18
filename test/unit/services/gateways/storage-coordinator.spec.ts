import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coordinatedBucketExists,
  coordinatedBucketUpsert,
  invalidateBucketExists,
  resetStorageCoordinatorForTests,
  storageCoordinationKey,
} from '../../../../src/api/services/gateways/storage-coordinator';

describe('storage coordinator', () => {
  beforeEach(() => {
    resetStorageCoordinatorForTests();
  });

  it('shares concurrent existence checks for the same key', async () => {
    let release!: (value: boolean) => void;
    const checkExists = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);

    const checks = Promise.all([
      coordinatedBucketExists(key, checkExists),
      coordinatedBucketExists(key, checkExists),
      coordinatedBucketExists(key, checkExists),
    ]);
    await vi.waitFor(() => expect(checkExists).toHaveBeenCalledTimes(1));
    release(true);

    await expect(checks).resolves.toEqual([true, true, true]);
  });

  it('caches only positive existence checks', async () => {
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
    const checkExists = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(
      false,
    );
    await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(true);
    await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(true);
    expect(checkExists).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the targeted positive existence cache entry', async () => {
    const keyA = storageCoordinationKey(['gcp', 'project', 'bucket-a']);
    const keyB = storageCoordinationKey(['gcp', 'project', 'bucket-b']);
    const seedExists = vi.fn().mockResolvedValue(true);

    await expect(coordinatedBucketExists(keyA, seedExists)).resolves.toBe(true);
    await expect(coordinatedBucketExists(keyB, seedExists)).resolves.toBe(true);

    invalidateBucketExists(keyA);

    const recheckA = vi.fn().mockResolvedValue(false);
    const recheckB = vi.fn().mockResolvedValue(false);
    await expect(coordinatedBucketExists(keyA, recheckA)).resolves.toBe(false);
    await expect(coordinatedBucketExists(keyB, recheckB)).resolves.toBe(true);
    expect(recheckA).toHaveBeenCalledTimes(1);
    expect(recheckB).not.toHaveBeenCalled();
  });

  it('rechecks existence after the positive cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(now);
      const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
      const checkExists = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(
        true,
      );
      vi.setSystemTime(now.getTime() + 59_999);
      await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(
        true,
      );
      expect(checkExists).toHaveBeenCalledTimes(1);

      vi.setSystemTime(now.getTime() + 60_001);
      await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(
        false,
      );
      expect(checkExists).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache existence check failures', async () => {
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
    const checkExists = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary transport failure'))
      .mockResolvedValueOnce(true);

    await expect(coordinatedBucketExists(key, checkExists)).rejects.toThrow(
      'temporary transport failure',
    );
    await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(true);
    expect(checkExists).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent upserts and marks the bucket as existing', async () => {
    let release!: () => void;
    const upsert = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const checkExists = vi.fn().mockResolvedValue(true);
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);

    const upserts = Promise.all([
      coordinatedBucketUpsert(key, upsert),
      coordinatedBucketUpsert(key, upsert),
    ]);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    release();

    await expect(upserts).resolves.toEqual([undefined, undefined]);
    await expect(coordinatedBucketExists(key, checkExists)).resolves.toBe(true);
    expect(checkExists).not.toHaveBeenCalled();
  });

  it('does not cache failed upserts', async () => {
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
    const upsert = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(undefined);

    await expect(coordinatedBucketUpsert(key, upsert)).rejects.toThrow(
      'rate limited',
    );
    await expect(coordinatedBucketUpsert(key, upsert)).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('retries retryable shared upsert failures without rejecting waiters', async () => {
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
    let rejectFirst!: (reason: unknown) => void;
    const upsert = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const first = coordinatedBucketUpsert(key, upsert, {
      shouldRetryFailure: (error) =>
        error instanceof Error && error.message.includes('Premature close'),
      retryFailuresForMs: 1_000,
      retryDelayMs: 0,
    });
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    const second = coordinatedBucketUpsert(key, upsert, {
      shouldRetryFailure: (error) =>
        error instanceof Error && error.message.includes('Premature close'),
      retryFailuresForMs: 1_000,
      retryDelayMs: 0,
    });

    rejectFirst(new Error('Premature close'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('starts the retry window after the first transient failure is observed', async () => {
    vi.useFakeTimers();
    try {
      const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
      const upsert = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error('Premature close')), 100);
            }),
        )
        .mockResolvedValueOnce(undefined);

      const upsertResult = coordinatedBucketUpsert(key, upsert, {
        shouldRetryFailure: (error) =>
          error instanceof Error && error.message.includes('Premature close'),
        retryFailuresForMs: 50,
        retryDelayMs: 0,
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(upsertResult).resolves.toBeUndefined();
      expect(upsert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps 50 waiters on one retry session after transient owner failures', async () => {
    vi.useFakeTimers();
    try {
      const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
      const transient = new Error('Premature close');
      const upsert = vi
        .fn()
        .mockRejectedValueOnce(transient)
        .mockRejectedValueOnce(transient)
        .mockRejectedValueOnce(transient)
        .mockRejectedValueOnce(transient)
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce(undefined);
      const ownerOptions = {
        shouldRetryFailure: (error: unknown) =>
          error instanceof Error && error.message.includes('Premature close'),
        retryFailuresForMs: 1_000,
        retryDelayMs: 10,
        retryJitter: false,
      };
      const waiterShouldRetry = vi.fn(() => {
        throw new Error('waiter retry policy should not run');
      });
      const waiterOptions = {
        shouldRetryFailure: waiterShouldRetry,
        retryFailuresForMs: 1_000,
        retryDelayMs: 10,
        retryJitter: false,
      };

      const upserts = Promise.all([
        coordinatedBucketUpsert(key, upsert, ownerOptions),
        ...Array.from({ length: 49 }, () =>
          coordinatedBucketUpsert(key, upsert, waiterOptions),
        ),
      ]);
      await vi.runAllTimersAsync();

      await expect(upserts).resolves.toHaveLength(50);
      expect(upsert).toHaveBeenCalledTimes(6);
      expect(waiterShouldRetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry non-retryable shared upsert failures', async () => {
    const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
    let rejectFirst!: (reason: unknown) => void;
    const upsert = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    const first = coordinatedBucketUpsert(key, upsert, {
      shouldRetryFailure: () => false,
      retryFailuresForMs: 1_000,
      retryDelayMs: 0,
    });
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    const second = coordinatedBucketUpsert(key, upsert, {
      shouldRetryFailure: () => false,
      retryFailuresForMs: 1_000,
      retryDelayMs: 0,
    });

    rejectFirst(new Error('permission denied'));

    await expect(Promise.all([first, second])).rejects.toThrow(
      'permission denied',
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('stops retrying retryable upsert failures after the retry window', async () => {
    vi.useFakeTimers();
    try {
      const key = storageCoordinationKey(['gcp', 'project', 'bucket']);
      const upsert = vi.fn().mockRejectedValue(new Error('Premature close'));

      const upsertResult = coordinatedBucketUpsert(key, upsert, {
        shouldRetryFailure: (error) =>
          error instanceof Error && error.message.includes('Premature close'),
        retryFailuresForMs: 50,
        retryDelayMs: 10,
        retryJitter: false,
      });
      const assertion = expect(upsertResult).rejects.toThrow('Premature close');

      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      expect(upsert).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
