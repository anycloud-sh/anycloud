import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiOwnershipBackfillIsRunning,
  startApiOwnershipBackfill,
  stopApiOwnershipBackfill,
} from '../../../src/api/services/api-ownership-backfill.js';
import type {
  ApiOwnershipBackfillSummary,
  ApiOwnershipBackfillTarget,
  ApiOwnershipRepository,
} from '../../../src/api/services/api-ownership-store.js';
import { CloudType } from '../../../src/shared/cloud.js';

const persistenceMocks = vi.hoisted(() => ({
  getApiOwnershipStore: vi.fn(),
  getCredentialSecretStore: vi.fn(),
}));

vi.mock('../../../src/api/services/persistence.js', () => persistenceMocks);

const RETRY_INTERVAL_MS = 5 * 60 * 1000;

function summary(
  overrides: Partial<ApiOwnershipBackfillSummary> = {},
): ApiOwnershipBackfillSummary {
  return {
    pending: 0,
    retry: 0,
    completed: 0,
    missing: 0,
    unsupported: 0,
    conflict: 0,
    ...overrides,
  };
}

function retryTargets(): ApiOwnershipBackfillTarget[] {
  return Array.from({ length: 20 }, (_, index) => ({
    vmRowId: index + 1,
    cloudId: `legacy-vm-${index + 1}`,
    ownerKind: 'workload',
    ownerId: `workload-${index + 1}`,
    userId: 'user-1',
    endedAt: null,
    credentialId: null,
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    availabilityZone: null,
    vmType: 't3.small',
  }));
}

describe('API ownership backfill scheduling', () => {
  let store: ApiOwnershipRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store = {
      seedLegacyTargets: vi.fn(),
      listActionableTargets: vi.fn(),
      recordTargetResult: vi.fn(),
      summarize: vi.fn(),
    };
    persistenceMocks.getApiOwnershipStore.mockReturnValue(store);
    persistenceMocks.getCredentialSecretStore.mockReturnValue({
      getCredentialWithCloudProvider: vi.fn(),
    });
  });

  afterEach(() => {
    stopApiOwnershipBackfill();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('continues immediately while never-attempted targets remain', async () => {
    vi.mocked(store.listActionableTargets)
      .mockResolvedValueOnce(retryTargets())
      .mockResolvedValueOnce([]);
    vi.mocked(store.summarize)
      .mockResolvedValueOnce(summary({ pending: 20, retry: 20 }))
      .mockResolvedValueOnce(summary());
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    startApiOwnershipBackfill();
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 0);
  });

  it('backs off when a full batch leaves only retry targets', async () => {
    vi.mocked(store.listActionableTargets)
      .mockResolvedValueOnce(retryTargets())
      .mockResolvedValueOnce([]);
    vi.mocked(store.summarize)
      .mockResolvedValueOnce(summary({ retry: 20 }))
      .mockResolvedValueOnce(summary());
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    startApiOwnershipBackfill();
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      RETRY_INTERVAL_MS,
    );
    expect(store.summarize).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 1);
    expect(store.summarize).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(store.summarize).toHaveBeenCalledTimes(2);
    expect(apiOwnershipBackfillIsRunning()).toBe(false);
  });

  it('backs off when pending results cannot be persisted', async () => {
    vi.mocked(store.listActionableTargets).mockResolvedValue(retryTargets());
    vi.mocked(store.recordTargetResult).mockRejectedValue(
      new Error('SQLITE_FULL'),
    );
    vi.mocked(store.summarize).mockResolvedValue(summary({ pending: 20 }));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    startApiOwnershipBackfill();
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      RETRY_INTERVAL_MS,
    );
    expect(store.listActionableTargets).toHaveBeenCalledOnce();
  });
});
