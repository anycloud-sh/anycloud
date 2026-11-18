import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';

// Mirror preemption-scale: keep loadWorkloadConfigs real (reads the seeded
// workload + credential), fix buildCloudConfig.
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

// Make every job reachable so each one reaches the SSH (checkJobCompletion) path;
// keep withTimeout / sleep / etc. real.
vi.mock('../../../src/shared/utils', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../src/shared/utils')>();
  return {
    ...real,
    tcpPing: vi.fn().mockResolvedValue(true),
    checkNetworkConnectivity: vi.fn().mockResolvedValue(true),
  };
});

// checkJobCompletion is the per-job SSH operation. Stub it so we can model latency
// + meter concurrency without real SSH. (Phase 1b re-enables the *real*
// checkJobCompletion against the FakeTransport seam for SSH-path correctness;
// that's a separate concern from this scale test.)
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

import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor';
import { checkJobCompletion } from '../../../src/api/services/workload-workflows/completion';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import config from '../../../src/api/config';
import {
  ConcurrencyMeter,
  measureTickDrainMs,
} from '../helpers/concurrency-meter';
import { seedRunningJobs } from '../helpers/seed';

const MAX_RECONCILE_IN_FLIGHT = 40;

// ~2x the observed production peak.
const N = 2000;
// Modeled per-item SSH latency (tcpPing + docker inspect). Modeled, not measured —
// the cap is only as good as this number; see SLAC.md.
const SSH_MS = 2000;
// Completion-detection SLA: we deliberately do NOT require draining within one 30s
// poll (that needs an unsafe cap ~130). A finished job must be *detected* within
// this budget. The cap is sized so drain ≤ SLA at 2x load (see SLAC.md).
const STALENESS_SLA_MS = 120_000; // 2 minutes

describe('poll reconciliation job-completion path — bounded AND within the completion-detection SLA at 2x load', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  it(`stays under the cap and detects completion within the SLA for ${N} running jobs`, async () => {
    const meter = new ConcurrencyMeter();
    vi.mocked(checkJobCompletion).mockImplementation(
      meter.track('checkJobCompletion', async () => {
        await new Promise((r) => setTimeout(r, SSH_MS)); // modeled SSH latency
      }),
    );

    await seedRunningJobs(N);
    const drainMs = await measureTickDrainMs(() => runWorkloadReconcileOnce());

    // Every reachable job is checked (tcpPing mocked reachable).
    expect(meter.count('checkJobCompletion')).toBe(N);
    // SAFETY: SSH fan-out never exceeds the cap (no socket/heap blowup).
    expect(meter.peak('checkJobCompletion')).toBeLessThanOrEqual(
      MAX_RECONCILE_IN_FLIGHT,
    );
    // THROUGHPUT (as bounded staleness, NOT one-poll): a completing job is detected
    // within the SLA. drain ≈ ⌈N/cap⌉·D = ⌈2000/40⌉·2s = 100s ≤ 120s. If this goes
    // red, the fix is event-push / global-gate / shard — NOT a bigger cap (SLAC.md).
    expect(drainMs).toBeLessThanOrEqual(STALENESS_SLA_MS);
  });
});
