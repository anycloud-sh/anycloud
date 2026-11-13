import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterEach,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';
import {
  resetPersistence,
  getCredentialSecretStore,
  getWorkloadLifecycle as lifecycle,
  getWorkloadQueryStore,
} from '../../../src/api/services/persistence.js';
import {
  provisionTestVm,
  seedTestWorkload,
  walkToState,
} from '../../helpers/workload-store.js';
import { DockerManager } from '../../../src/api/services/docker';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import config from '../../../src/api/config';
import {
  RETRY_JITTER_CAP_MS,
  RETRY_PROVISIONING_BASE_MS,
  RETRY_PROVISIONING_CAP_MS,
} from '../../../src/api/config';

const { updateNotificationMock } = vi.hoisted(() => ({
  updateNotificationMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/api/services/serve/default-runtime', async () =>
  (await import('../helpers/monitor-harness')).serveRuntimeMock(),
);
vi.mock(
  '../../../src/api/services/host-runtime/vm-container-repair',
  async () =>
    (await import('../helpers/monitor-harness')).vmContainerRepairMock(),
);
vi.mock(
  '../../../src/api/services/workload-workflows/vm-host-startup',
  async () => (await import('../helpers/monitor-harness')).vmHostStartupMock(),
);
vi.mock('../../../src/api/services/workload-workflows/completion', async () =>
  (await import('../helpers/monitor-harness')).completionMock(),
);
vi.mock('../../../src/api/services/host-runtime/termination', async () =>
  (await import('../helpers/monitor-harness')).terminationMock(),
);
vi.mock('../../../src/api/services/workload-cleanup', async () =>
  (await import('../helpers/monitor-harness')).workloadCleanupMock(),
);
vi.mock('../../../src/api/services/update-notifications', () => ({
  UPDATE_NOTIFICATION_INTERVAL_MS: 60 * 60_000,
  runUpdateNotificationOnce: updateNotificationMock,
}));
vi.mock('../../../src/api/services/docker');
vi.mock('../../../src/api/services/catalog-readiness', async () =>
  (await import('../helpers/monitor-harness')).catalogReadinessMock(),
);
vi.mock('../../../src/shared/utils', async (importOriginal) =>
  (await import('../helpers/monitor-harness')).sharedUtilsMock(
    await importOriginal(),
  ),
);
vi.mock('../../../src/api/services/cloud-config', async (importOriginal) =>
  (await import('../helpers/monitor-harness')).cloudConfigMock(
    await importOriginal(),
  ),
);

import {
  createMonitor,
  kickProvisioningScheduler,
  resetJobCompletionMonitorStateForTests,
  runWorkloadReconcileOnce,
  startBackgroundServices,
  stopBackgroundServices,
} from '../../../src/api/services/monitor';
import {
  computeRetryWait,
  retryWindow,
} from '../../../src/api/services/retry-backoff';
import { WorkloadReconciler } from '../../../src/api/services/workload-reconciler';
import {
  encryptCredential,
  hashCredential,
} from '../../../src/api/services/cloud-config';
import { TEST_LAMBDA_CRED } from '../helpers/fixtures';
import { checkNetworkConnectivity } from '../../../src/shared/utils';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

describe('createMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a task to finish before scheduling the next run', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const task = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const monitor = createMonitor('test-monitor', 30_000, task);

    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(task).toHaveBeenCalledTimes(1);

      release();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
    }
  });

  it('reports tick liveness, including for a tick that threw', async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('tick failed'))
      .mockResolvedValue(undefined);
    const monitor = createMonitor('liveness', 30_000, task);

    expect(monitor.lastCompletedAt()).toBeNull();

    try {
      monitor.start();
      // Seeded at start, so the first interval never reads as a stall.
      const startedAt = monitor.lastCompletedAt();
      expect(startedAt).toBe(Date.now());

      await vi.advanceTimersByTimeAsync(30_000);
      expect(task).toHaveBeenCalledOnce();
      expect(monitor.lastCompletedAt()).toBe(startedAt! + 30_000);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.lastCompletedAt()).toBe(startedAt! + 60_000);
    } finally {
      monitor.stop();
    }

    expect(monitor.lastCompletedAt()).toBeNull();
  });

  it('does not resurrect liveness when a tick resolves after stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const monitor = createMonitor('stopped-mid-tick', 30_000, task);

    monitor.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledOnce();

    monitor.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.lastCompletedAt()).toBeNull();
  });

  it('does not re-arm when stopped while its task is running', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const monitor = createMonitor('stopped-in-flight', 30_000, task);

    monitor.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledOnce();

    monitor.stop();
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(90_000);

    expect(task).toHaveBeenCalledOnce();
  });

  it('runs a kicked tick at once, and one more for kicks during it', async () => {
    vi.useFakeTimers();
    const releases: (() => void)[] = [];
    const task = vi.fn(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const monitor = createMonitor('kicked', 30_000, task);

    try {
      monitor.start();
      monitor.kick();
      expect(task).toHaveBeenCalledOnce();

      // Three submits while it runs share one follow-up tick.
      monitor.kick();
      monitor.kick();
      monitor.kick();
      releases[0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(2);

      releases[1]!();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(task).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(3);
    } finally {
      monitor.stop();
    }
  });

  it('ignores a kick while stopped', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => {});
    const monitor = createMonitor('stopped-kick', 30_000, task);
    monitor.kick();
    monitor.start();
    monitor.stop();
    monitor.kick();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(task).not.toHaveBeenCalled();
  });
});

describe('background service lifecycle', () => {
  afterEach(async () => {
    await stopBackgroundServices();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent starts and stops', async () => {
    let releaseStart!: () => void;
    const startSpy = vi
      .spyOn(WorkloadReconciler.prototype, 'start')
      .mockReturnValue(
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
      );
    const stopSpy = vi
      .spyOn(WorkloadReconciler.prototype, 'stop')
      .mockResolvedValue(undefined);

    const firstStart = startBackgroundServices();
    const secondStart = startBackgroundServices();
    expect(startSpy).toHaveBeenCalledOnce();
    const firstStop = stopBackgroundServices();
    const secondStop = stopBackgroundServices();
    releaseStart();
    await Promise.all([firstStart, secondStart, firstStop, secondStop]);

    expect(startSpy).toHaveBeenCalledOnce();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(updateNotificationMock).toHaveBeenCalledOnce();
  });

  it('runs the provisioning scheduler when kicked', async () => {
    await startBackgroundServices();
    const countDeploying = vi.spyOn(getWorkloadQueryStore(), 'countDeploying');
    kickProvisioningScheduler();
    await vi.waitFor(() => expect(countDeploying).toHaveBeenCalledOnce());
  });
});

describe('workload reconcile routing while the API network is down', () => {
  beforeEach(() => {
    resetPersistence();
    resetJobCompletionMonitorStateForTests();
    vi.clearAllMocks();
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.mocked(checkNetworkConnectivity).mockResolvedValue(true);
  });

  it.each([
    [WorkloadType.Job, WorkloadState.Running, CloudType.GCP, 1],
    [WorkloadType.Vm, WorkloadState.Running, CloudType.GCP, 1],
    [WorkloadType.Job, WorkloadState.Finalizing, CloudType.GCP, 1],
  ])(
    'consults the API network before VM-host work (%s in %s on %s, %i probes)',
    async (workloadType, state, provider, deferredCount) => {
      await seedTestWorkload({
        id: 'routed',
        userId: 'test-user',
        workloadType,
        requestedComputeProvider: provider,
        credentialId: null,
        state: WorkloadState.Queued,
      });
      await walkToState('routed', state);

      const status = await runWorkloadReconcileOnce();

      expect(status).toMatchObject({ processedCount: 1, deferredCount });
      // Only VM-host work consults the API network before touching the host.
      expect(checkNetworkConnectivity).toHaveBeenCalledTimes(deferredCount);
    },
  );
});

describe('Secret files on the Workload poll', () => {
  beforeEach(() => {
    resetPersistence();
    resetJobCompletionMonitorStateForTests();
    vi.clearAllMocks();
  });

  it('delivers a Running Service its Secret files on the poll', async () => {
    await getCredentialSecretStore().saveSecret('hf', { HF_TOKEN: 'v' });
    await seedTestWorkload({
      id: 'secret-service',
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      requestedComputeProvider: CloudType.GCP,
      credentialId: null,
      secretNames: ['hf'],
      state: WorkloadState.Queued,
    });
    await provisionTestVm('secret-service', {
      cloudId: 'vm-1',
      ip: '192.0.2.9',
    });
    await walkToState('secret-service', WorkloadState.Running);
    vi.mocked(
      DockerManager.prototype.readSecretFileRevisions,
    ).mockResolvedValue(new Map([['hf', null]]));

    await runWorkloadReconcileOnce();

    expect(DockerManager.prototype.writeSecretFiles).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'hf', values: { HF_TOKEN: 'v' } }),
    );
  });
});

describe('computeRetryWait', () => {
  const provisioningCeiling = (attempt: number) =>
    Math.min(
      RETRY_PROVISIONING_BASE_MS * Math.pow(2, attempt - 1),
      RETRY_PROVISIONING_CAP_MS,
    );

  it('doubles the provisioning ceiling per attempt until it saturates the cap', () => {
    // random() === 1 draws the top of the window, which is the ceiling itself.
    const tops = [1, 2, 3, 4, 5].map((n) =>
      computeRetryWait(WorkloadState.Provisioning, n, () => 1),
    );
    expect(tops).toEqual([1, 2, 3, 4, 5].map(provisioningCeiling));
    // Anchored to the shipped defaults so an accidental retune is visible here
    // and not only in production latency.
    expect(tops).toEqual([150_000, 300_000, 600_000, 600_000, 600_000]);
  });

  it('keeps the provisioning floor a fixed fraction of the ceiling at every attempt', () => {
    // The floor is relative, not absolute: jitter must stay proportionally wide
    // once the ceiling saturates, or a whole fleet re-synchronises on the cap.
    const bottoms = [1, 2, 3, 4].map((n) =>
      computeRetryWait(WorkloadState.Provisioning, n, () => 0),
    );
    expect(bottoms).toEqual(
      [1, 2, 3, 4].map((n) => Math.floor(provisioningCeiling(n) * 0.1)),
    );
    expect(bottoms).toEqual([15_000, 30_000, 60_000, 60_000]);
  });

  it('never returns more than RETRY_JITTER_CAP_MS for any provisioning attempt', () => {
    // Load-bearing: ~25 sites across this suite use
    // `Date.now() - RETRY_JITTER_CAP_MS - 1000` as a "definitely past due"
    // sentinel. A curve that can exceed the cap silently breaks all of them.
    for (let n = 1; n <= 100; n += 1) {
      expect(
        computeRetryWait(WorkloadState.Provisioning, n, () => 1),
      ).toBeLessThanOrEqual(RETRY_JITTER_CAP_MS);
    }
  });

  it('exposes the same window it samples from, on both curves', () => {
    for (const state of [
      WorkloadState.Provisioning,
      WorkloadState.Starting,
      null,
    ]) {
      for (const n of [0, 1, 2, 3, 10]) {
        const { minMs, maxMs } = retryWindow(state, n);
        expect(computeRetryWait(state, n, () => 0)).toBe(minMs);
        expect(computeRetryWait(state, n, () => 1)).toBe(maxMs);
        const mid = computeRetryWait(state, n, () => 0.5);
        expect(mid).toBeGreaterThanOrEqual(minMs);
        expect(mid).toBeLessThanOrEqual(maxMs);
      }
    }
  });

  it('null failedAtState uses the gentler non-provisioning curve', () => {
    // 60s initial ± 40% jitter → 36s–84s on retry 1
    const wait = computeRetryWait(null, 1);
    expect(wait).toBeGreaterThanOrEqual(36_000);
    expect(wait).toBeLessThanOrEqual(84_000);
  });

  it('non-provisioning failures use gentler backoff (60s initial ± 40% jitter)', () => {
    const states = [
      WorkloadState.Starting,
      WorkloadState.Downloading,
      WorkloadState.Syncing,
      WorkloadState.Initializing,
    ];
    for (const state of states) {
      const wait1 = computeRetryWait(state, 1);
      expect(wait1).toBeGreaterThanOrEqual(36_000);
      expect(wait1).toBeLessThanOrEqual(84_000);
    }
  });

  it('non-provisioning curve caps at 300s with jitter', () => {
    // Retry count well past where growth saturates the cap
    const waits = Array.from({ length: 50 }, () =>
      computeRetryWait(WorkloadState.Starting, 10),
    );
    // 300s ± 40% → 180s–420s
    waits.forEach((w) => {
      expect(w).toBeGreaterThanOrEqual(180_000);
      expect(w).toBeLessThanOrEqual(420_000);
    });
  });

  it('supports deterministic random injection', () => {
    expect(computeRetryWait(WorkloadState.Starting, 3, () => 0.25)).toBe(
      computeRetryWait(WorkloadState.Starting, 3, () => 0.25),
    );
  });
});

describe('bounded retry-candidate hydration', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
  });

  async function seedWorkload(id: string): Promise<void> {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
  }

  it('reports failedAtState as Provisioning and a recent lastRetryAt for a provisioning failure trace', async () => {
    await seedWorkload('prov-fail');
    await walkToState('prov-fail', WorkloadState.Provisioning);
    const before = Date.now();
    await walkToState('prov-fail', WorkloadState.Retrying);

    const [c] = await lifecycle().getRetryCandidatesByIds(['prov-fail']);
    expect(c).toBeDefined();
    expect(c?.failedAtState).toBe(WorkloadState.Provisioning);
    expect(c?.retryCount).toBe(1);
    // lastRetryAt must reflect the timestamp of the Retrying event just recorded
    expect(c?.lastRetryAt).toBeGreaterThanOrEqual(before);
    expect(c?.lastRetryAt).toBeLessThanOrEqual(Date.now());
  });

  it('reports failedAtState as Initializing for an infra failure trace', async () => {
    await seedWorkload('init-fail');
    await walkToState('init-fail', WorkloadState.Provisioning);
    await walkToState('init-fail', WorkloadState.Initializing);
    await walkToState('init-fail', WorkloadState.Retrying);

    const [c] = await lifecycle().getRetryCandidatesByIds(['init-fail']);
    expect(c?.failedAtState).toBe(WorkloadState.Initializing);
    expect(c?.retryCount).toBe(1);
  });

  it('accumulates retryCount and tracks the most recent failure step across retry cycles', async () => {
    await seedWorkload('multi-retry');

    // First cycle: failed at Provisioning
    await walkToState('multi-retry', WorkloadState.Provisioning);
    await walkToState('multi-retry', WorkloadState.Retrying);

    // Second cycle: re-queued, then failed at Initializing
    await walkToState('multi-retry', WorkloadState.Queued);
    await walkToState('multi-retry', WorkloadState.Provisioning);
    await walkToState('multi-retry', WorkloadState.Initializing);
    await walkToState('multi-retry', WorkloadState.Retrying);

    const [c] = await lifecycle().getRetryCandidatesByIds(['multi-retry']);
    expect(c?.retryCount).toBe(2);
    expect(c?.failedAtState).toBe(WorkloadState.Initializing); // last failure, not first
  });
});
