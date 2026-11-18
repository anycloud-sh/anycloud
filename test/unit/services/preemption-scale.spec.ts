import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';

// Mirror monitor.spec.ts: intercept the cloud-gateway factory + the config
// builder; leave loadWorkloadConfigs real so it reads the seeded workload.
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

// A Running spot job performs its completion check after the preemption probe.
// Keep that real production ordering while making the unrelated SSH path cheap.
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
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../../../src/api/services/workload-workflows/completion')
      >();
    return {
      ...real,
      checkJobCompletion: vi.fn().mockResolvedValue(undefined),
    };
  },
);

// Running Jobs also renew their minted bucket tokens on this lane; that path
// has its own spec (service-storage-renewal.spec.ts). Isolate the fan-out.
vi.mock('../../../src/api/services/service-storage-renewal', () => ({
  createStorageRenewer: () => ({
    forget: () => undefined,
    renew: async () => ({ disposition: 'completed' }),
  }),
}));

import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor';
import { PREEMPTION_POLL_INTERVAL_MS } from '../../../src/api/services/workload-workflows/retry-recovery';
import { createComputeProvider } from '../../../src/api/services/cloud-config';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import config from '../../../src/api/config';
import { makeMockCloudCompute } from '../helpers/fixtures';
import {
  ConcurrencyMeter,
  measureTickDrainMs,
} from '../helpers/concurrency-meter';
import { seedSpotWorkloads } from '../helpers/seed';

const MAX_RECONCILE_IN_FLIGHT = 40;

// ~2x the observed production peak (~825-988 concurrent spot workloads).
const N = 2000;
// Modeled per-item latency: verifyVMPreemption is one cloud API call
// (DescribeInstances). See SLAC.md — this D is a modeled bound, not measured.
const CLOUD_MS = 500;

describe('poll reconciliation preemption path — bounded AND keeps up at 2x load', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  it(`stays under the cap and drains within one poll for ${N} spot workloads`, async () => {
    const meter = new ConcurrencyMeter();
    const fake = makeMockCloudCompute({
      verifyVMPreemption: meter.track('verifyVMPreemption', async () => {
        await new Promise((r) => setTimeout(r, CLOUD_MS)); // modeled cloud latency
        return false; // no preemption → isolates the fan-out
      }),
    });
    vi.mocked(createComputeProvider).mockReturnValue(fake);

    await seedSpotWorkloads(N);
    const drainMs = await measureTickDrainMs(() => runWorkloadReconcileOnce());

    // The tick ran end-to-end (every VM checked).
    expect(meter.count('verifyVMPreemption')).toBe(N);
    // SAFETY: fan-out never exceeds the cap (no socket/heap blowup).
    expect(meter.peak('verifyVMPreemption')).toBeLessThanOrEqual(
      MAX_RECONCILE_IN_FLIGHT,
    );
    // THROUGHPUT: cheap cloud calls + aggregate cap 40 drain 2x load inside one
    // 30s poll, so preemption keeps its cadence at scale.
    // drain ≈ ⌈N/cap⌉·D = 50·500ms = 25s.
    expect(drainMs).toBeLessThanOrEqual(PREEMPTION_POLL_INTERVAL_MS);
  });
});
