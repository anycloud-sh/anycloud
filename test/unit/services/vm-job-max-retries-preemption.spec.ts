import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';

// As preemption-scale.spec.ts: intercept the gateway factory and the config
// builder, and keep loadWorkloadConfigs real so it reads the seeded workload.
vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    buildCloudConfig: vi.fn().mockReturnValue({
      cloudProvider: 'GCP',
      region: 'us-central1',
      vmType: 'n2-standard-4',
    }),
    createComputeProvider: vi.fn(),
  };
});
vi.mock('../../../src/shared/utils', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../src/shared/utils')>();
  return {
    ...real,
    tcpPing: vi.fn().mockResolvedValue(true),
    checkNetworkConnectivity: vi.fn().mockResolvedValue(true),
  };
});
vi.mock(
  '../../../src/api/services/workload-workflows/completion',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/api/services/workload-workflows/completion')
    >()),
    checkJobCompletion: vi.fn().mockResolvedValue(undefined),
  }),
);
vi.mock('../../../src/api/services/service-storage-renewal', () => ({
  createStorageRenewer: () => ({
    forget: () => undefined,
    renew: async () => ({ disposition: 'completed' }),
  }),
}));

import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor';
import { createComputeProvider } from '../../../src/api/services/cloud-config';
import {
  getWorkloadQueryStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import config from '../../../src/api/config';
import { WorkloadState } from '../../../src/shared/workload.js';
import { makeMockCloudCompute } from '../helpers/fixtures';
import { seedSpotWorkloads } from '../helpers/seed';

describe('a spot VM Job preempted while it runs', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  it.each<[number | null, number, string]>([
    [0, 0, 'is not restarted past --max-retries'],
    [null, 1, 'restarts in place without a cap'],
  ])('with --max-retries %s %#: %s', async (maxRetries, restarts) => {
    const startVM = vi.fn().mockResolvedValue(null);
    vi.mocked(createComputeProvider).mockReturnValue(
      makeMockCloudCompute({
        verifyVMPreemption: vi.fn().mockResolvedValue(true),
        startVM,
      }),
    );
    const [id] = await seedSpotWorkloads(1);
    await getDB().query('UPDATE workloads SET max_retries = ? WHERE id = ?', [
      maxRetries,
      id,
    ]);

    await runWorkloadReconcileOnce();

    expect(startVM).toHaveBeenCalledTimes(restarts);
    expect((await getWorkloadQueryStore().getWorkload(id!))?.state).toBe(
      WorkloadState.Recovering,
    );
  });
});
