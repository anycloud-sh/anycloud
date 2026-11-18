import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';

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
      gpuType: null,
    }),
    createComputeProvider: vi.fn(),
  };
});

vi.mock('../../../src/shared/utils', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../src/shared/utils')>();
  return {
    ...real,
    withTimeout: vi.fn((promise: Promise<unknown>) => promise),
    tcpPing: vi.fn().mockResolvedValue(true),
    checkNetworkConnectivity: vi.fn().mockResolvedValue(true),
  };
});

vi.mock(
  '../../../src/api/services/workload-workflows/completion',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../../../src/api/services/workload-workflows/completion')
      >();
    return { ...real, checkJobCompletion: vi.fn() };
  },
);

import {
  WORKLOAD_RECONCILE_DRAIN_BUDGET_MS,
  runWorkloadReconcileOnce,
} from '../../../src/api/services/monitor';
import { checkJobCompletion } from '../../../src/api/services/workload-workflows/completion';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import config from '../../../src/api/config';
import {
  ConcurrencyMeter,
  measureTickDrainMs,
} from '../helpers/concurrency-meter';
import { seedRunningJobs } from '../helpers/seed';

const MAX_RECONCILE_IN_FLIGHT = 40;

const PEAK_2X_N = 2000;
const SSH_MS = 2000;

describe('workload reconciler work path — scale', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  it(`drains ${PEAK_2X_N} due jobs within the SLA with aggregate in-flight <= ${MAX_RECONCILE_IN_FLIGHT}`, async () => {
    const meter = new ConcurrencyMeter();
    vi.mocked(checkJobCompletion).mockImplementation(
      meter.track('checkJobCompletion', async () => {
        await new Promise((r) => setTimeout(r, SSH_MS));
      }),
    );

    await seedRunningJobs(PEAK_2X_N);
    let status: Awaited<ReturnType<typeof runWorkloadReconcileOnce>>;
    const drainMs = await measureTickDrainMs(async () => {
      status = await runWorkloadReconcileOnce();
    });

    expect(meter.count('checkJobCompletion')).toBe(PEAK_2X_N);
    expect(meter.peakTotal()).toBeLessThanOrEqual(MAX_RECONCILE_IN_FLIGHT);
    expect(drainMs).toBeLessThanOrEqual(WORKLOAD_RECONCILE_DRAIN_BUDGET_MS);
    expect(status!.processedCount).toBe(PEAK_2X_N);
    expect(status!.failureCount).toBe(0);
    expect(status!.remainingDueCount).toBe(0);
    expect(status!.failed).toBe(false);
  });

  it('stops a diagnostic drain at its budget and reports remaining work', async () => {
    const slowSshMs = 10_000;
    const capacity =
      (WORKLOAD_RECONCILE_DRAIN_BUDGET_MS / slowSshMs) *
      MAX_RECONCILE_IN_FLIGHT;
    const n = capacity + MAX_RECONCILE_IN_FLIGHT;
    const meter = new ConcurrencyMeter();
    vi.mocked(checkJobCompletion).mockImplementation(
      meter.track('checkJobCompletion', async () => {
        await new Promise((r) => setTimeout(r, slowSshMs));
      }),
    );

    await seedRunningJobs(n);
    let status: Awaited<ReturnType<typeof runWorkloadReconcileOnce>>;
    await measureTickDrainMs(async () => {
      status = await runWorkloadReconcileOnce();
    });

    expect(meter.peakTotal()).toBeLessThanOrEqual(MAX_RECONCILE_IN_FLIGHT);
    expect(status!.processedCount).toBe(capacity);
    expect(status!.hitDrainBudget).toBe(true);
    expect(status!.remainingDueCount).toBe(MAX_RECONCILE_IN_FLIGHT);
  });

  it('does not reclaim rows from earlier pages when a drain outlives the lease interval', async () => {
    const longSshMs = 40_000;
    const n = MAX_RECONCILE_IN_FLIGHT * 2;
    const seen: string[] = [];
    const meter = new ConcurrencyMeter();
    vi.mocked(checkJobCompletion).mockImplementation(
      meter.track('checkJobCompletion', async (_persistence, id: string) => {
        seen.push(id);
        await new Promise((r) => setTimeout(r, longSshMs));
      }),
    );

    await seedRunningJobs(n);
    const drainMs = await measureTickDrainMs(() => runWorkloadReconcileOnce());

    expect(drainMs).toBeGreaterThan(30_000);
    expect(meter.count('checkJobCompletion')).toBe(n);
    expect(new Set(seen).size).toBe(n);
  });
});
