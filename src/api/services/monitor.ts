/**
 * Background reconciliation and periodic tasks with centralized lifecycle.
 *
 * Composition only: this module wires each workflow's declared dependencies,
 * routes the bounded process-local controller's work to those workflows, and
 * starts and stops the periodic monitors.
 */

import { log } from './logger.js';
import { createStorageRenewer } from './service-storage-renewal.js';
import { deliverLiveSecretFiles } from './live-secret-files.js';
import {
  getWorkloadQueryStore,
  getWorkloadSpendStore,
  getWorkloadLifecycle,
  getWorkloadOutcomes,
  getProvisioningAttemptStore,
  getWorkloadEventStore,
  getCredentialSecretStore,
  getNotificationsStore,
  getSpendControlsStore,
} from './persistence.js';
import {
  reconcilePreemptionCandidate,
  reconcileRetryCandidate,
  resetRetryRecoveryStateForTests,
  type RetryRecoveryPersistence,
} from './workload-workflows/retry-recovery.js';
import {
  reconcileCleanupCandidate,
  type CleanupPersistence,
} from './workload-workflows/cleanup.js';
import {
  reconcileFinalizingJob,
  reconcileRunningJobCompletion,
  type CompletionReconcilePersistence,
} from './workload-workflows/completion-reconcile.js';
import {
  reconcileRunningVm,
  type PersistentVmRepairPersistence,
} from './workload-workflows/persistent-vm-repair.js';
import { wakeWorkloadPipeline } from './workload-workflows/workload-pipeline.js';
import {
  runProvisioningScheduler,
  type ProvisioningSchedulerDeps,
} from './workload-workflows/provisioning-scheduler.js';
import { resetVMReleaseObserverForTests } from './host-runtime/vm-release-observer.js';
import { vmHostStartupDeps } from './job/default-runtime.js';
import { resumeOnExistingVM } from './workload-workflows/vm-host-startup.js';
import { PROVISIONING_SCHEDULER_INTERVAL_MS } from '../config.js';
import {
  WorkloadReconciler,
  type WorkloadReconcileDrainStatus,
  type WorkloadReconcileResult,
  type WorkloadReconcileWork,
} from './workload-reconciler.js';
import { checkNetworkConnectivity } from '../../shared/utils.js';
import {
  WorkloadState,
  WorkloadType,
  isDeployPipelineState,
  PREEMPTIBLE_STATES,
  TERMINAL_STATES,
} from '../../shared/workload.js';
import { activeWorkloadWorkCount } from './workload-work-registry.js';
import {
  runUpdateNotificationOnce,
  UPDATE_NOTIFICATION_INTERVAL_MS,
} from './update-notifications.js';
import {
  API_HEALTH_MONITOR_INTERVAL_MS,
  runApiHealthMonitorOnce,
  startApiHealthWatchdog,
  stopApiHealthWatchdog,
  type MonitorTickStatus,
} from './api-health.js';
import {
  runVmReleaseNotificationsOnce,
  VM_RELEASE_NOTIFICATION_INTERVAL_MS,
} from './vm-release-notifications.js';
import {
  NOTIFICATIONS_DIGEST_INTERVAL_MS,
  runNotificationsDigestOnce,
} from './notifications-digest.js';
import {
  COST_CALCULATION_INTERVAL_MS,
  runCostCalculationOnce,
} from './cost-calculation/monitor.js';
import {
  CATALOG_REFRESH_INTERVAL_MS,
  refreshCatalogs,
} from './catalog-readiness.js';

export interface Monitor {
  readonly name: string;
  readonly intervalMs: number;
  start(): void;
  stop(): void;
  /**
   * Run a tick now rather than at the next interval, or, while one runs,
   * another as soon as it finishes. Kicks before that tick starts share it.
   */
  kick(): void;
  /**
   * Epoch ms of the last finished tick, or of `start()` before the first one.
   * Null while stopped. A tick that threw still counts as finished — the
   * failure is logged separately, and this only answers whether the schedule is
   * still turning.
   */
  lastCompletedAt(): number | null;
}

/**
 * Create a scheduled monitor that runs a task at regular intervals
 */
export function createMonitor(
  name: string,
  intervalMs: number,
  task: () => Promise<void>,
): Monitor {
  let timerId: NodeJS.Timeout | null = null;
  let active = false;
  let generation = 0;
  let completedAt: number | null = null;
  let running = false;
  let kicked = false;

  const run = async (scheduledGeneration: number) => {
    timerId = null;
    if (!active || scheduledGeneration !== generation) return;
    running = true;
    kicked = false;
    try {
      await task();
    } catch (error) {
      log.error(`${name} failed`, {
        id: 'system',
        error: error,
      });
    } finally {
      running = false;
    }
    // Below the guard: a tick that resolves after stop() must not resurrect
    // liveness for a monitor that is no longer running.
    if (!active || scheduledGeneration !== generation) return;
    completedAt = Date.now();
    timerId = setTimeout(
      () => run(scheduledGeneration),
      kicked ? 0 : intervalMs,
    ).unref();
  };

  return {
    name,
    intervalMs,
    start: () => {
      if (active) return;
      active = true;
      generation += 1;
      // Seed liveness at start so the first interval does not read as a stall.
      completedAt = Date.now();
      const scheduledGeneration = generation;
      log.info(`Starting ${name}`, { id: 'system', intervalMs });
      timerId = setTimeout(() => run(scheduledGeneration), intervalMs).unref();
    },
    stop: () => {
      if (!active) return;
      active = false;
      generation += 1;
      completedAt = null;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      log.info(`Stopped ${name}`, { id: 'system' });
    },
    kick: () => {
      if (!active) return;
      if (running) {
        kicked = true;
        return;
      }
      if (timerId) clearTimeout(timerId);
      void run(generation);
    },
    lastCompletedAt: () => completedAt,
  };
}

// ============================================================================
// Workflow composition
// ============================================================================

/**
 * Every workflow's declared dependencies, resolved per work item. The
 * reconciler's active-recovery work runs the pipeline, so the pipeline reaches
 * the reconciler through this port.
 */
function workflowDeps(): RetryRecoveryPersistence &
  CleanupPersistence &
  CompletionReconcilePersistence &
  PersistentVmRepairPersistence &
  ProvisioningSchedulerDeps {
  return {
    store: getWorkloadQueryStore(),
    spend: getWorkloadSpendStore(),
    lifecycle: getWorkloadLifecycle(),
    outcomes: getWorkloadOutcomes(),
    attempts: getProvisioningAttemptStore(),
    events: getWorkloadEventStore(),
    credentials: getCredentialSecretStore(),
    spendControls: getSpendControlsStore(),
    notifications: getNotificationsStore(),
    resume: {
      resumeOnExistingVM: (config, job) =>
        resumeOnExistingVM(vmHostStartupDeps(), config, job),
    },
    reconciler: workloadReconciler,
    networkAvailable: reconcileNetworkAvailable,
  };
}

export function resetJobCompletionMonitorStateForTests(): void {
  resetRetryRecoveryStateForTests();
  resetVMReleaseObserverForTests();
  reconcileNetworkResult = undefined;
  reconcileNetworkCheck = undefined;
}

// ============================================================================
// Unified workload-state reconciler
// ============================================================================

export const WORKLOAD_RECONCILE_DRAIN_BUDGET_MS = 120_000;

const RECONCILE_NETWORK_CACHE_TTL_MS = 5_000;
let reconcileNetworkResult:
  | { checkedAt: number; available: boolean }
  | undefined;
let reconcileNetworkCheck: Promise<boolean> | undefined;

async function reconcileNetworkAvailable(): Promise<boolean> {
  const now = Date.now();
  if (
    reconcileNetworkResult &&
    now - reconcileNetworkResult.checkedAt < RECONCILE_NETWORK_CACHE_TTL_MS
  ) {
    return reconcileNetworkResult.available;
  }
  if (reconcileNetworkCheck) return reconcileNetworkCheck;

  reconcileNetworkCheck = checkNetworkConnectivity()
    .then((available) => {
      reconcileNetworkResult = { checkedAt: Date.now(), available };
      if (!available) {
        log.warn('Skipping workload SSH checks: API network is down', {
          id: 'system',
        });
      }
      return available;
    })
    .finally(() => {
      reconcileNetworkCheck = undefined;
    });
  return reconcileNetworkCheck;
}

/**
 * Reconcile one admitted work item from current durable state. The controller
 * owns timing and work-kind admission; handlers retain domain eligibility and
 * state-transition checks for races after the controller preflight.
 */
const storageRenewer = createStorageRenewer();

async function reconcileWorkloadWork(
  work: WorkloadReconcileWork,
): Promise<WorkloadReconcileResult> {
  const store = getWorkloadQueryStore();
  const workload = await store.getWorkload(work.workloadId);
  if (!workload) return { disposition: 'stale' };

  const state = workload.state as WorkloadState;
  if (state !== WorkloadState.Running) storageRenewer.forget(workload.id);
  switch (work.kind) {
    case 'poll': {
      let didTransition = false;
      if (workload.spot && PREEMPTIBLE_STATES.includes(state)) {
        didTransition = await reconcilePreemptionCandidate(
          workflowDeps(),
          workload,
        );
      }
      if (didTransition) return { disposition: 'completed' };

      if (
        workload.workloadType === WorkloadType.Job &&
        state === WorkloadState.Running
      ) {
        if (
          workload.cloudProvider !== null &&
          !(await reconcileNetworkAvailable())
        ) {
          return { disposition: 'deferred' };
        }
        await reconcileRunningJobCompletion(workflowDeps(), workload);
        await deliverLiveSecretFiles(workload);
        return storageRenewer.renew(workload);
      }
      if (
        workload.workloadType === WorkloadType.Vm &&
        state === WorkloadState.Running
      ) {
        if (!(await reconcileNetworkAvailable())) {
          return { disposition: 'deferred' };
        }
        const result = await reconcileRunningVm(workflowDeps(), workload);
        await deliverLiveSecretFiles(workload);
        return result;
      }
      if (
        workload.workloadType === WorkloadType.Service &&
        state === WorkloadState.Running
      ) {
        await deliverLiveSecretFiles(workload);
        return storageRenewer.renew(workload);
      }
      return workload.spot && PREEMPTIBLE_STATES.includes(state)
        ? { disposition: 'completed' }
        : { disposition: 'stale' };
    }

    case 'retry-prepare':
    case 'retry-launch':
      if (
        !work.retry ||
        (state !== WorkloadState.Retrying && state !== WorkloadState.Recovering)
      ) {
        return { disposition: 'stale' };
      }
      // The reconciler sends `retry-prepare` while the backoff is pending and
      // `retry-launch` once it is due (always, for Recovering). Preparation
      // settles resources and, on `completed`, is rescheduled as the launch;
      // only the launch queues, at the candidate revision the reconciler read.
      // A `release-pending` deferral re-paces the retry from this handler's
      // start until the VM release is confirmed.
      return reconcileRetryCandidate(workflowDeps(), work.retry, workload, {
        launch: work.kind === 'retry-launch',
        expectedRevision: work.expectedRevision,
      });

    case 'finalization':
      if (state !== WorkloadState.Finalizing) {
        return { disposition: 'stale' };
      }
      if (
        workload.cloudProvider !== null &&
        !(await reconcileNetworkAvailable())
      ) {
        return { disposition: 'deferred' };
      }
      return reconcileFinalizingJob(workflowDeps(), workload);

    case 'cleanup':
      if (!TERMINAL_STATES.includes(state)) {
        return { disposition: 'stale' };
      }
      return reconcileCleanupCandidate(workflowDeps(), workload);

    case 'active-recovery':
      if (!isDeployPipelineState(state)) {
        return { disposition: 'stale' };
      }
      await wakeWorkloadPipeline(workflowDeps(), workload.id);
      return { disposition: 'completed' };
  }
}

const workloadReconciler = new WorkloadReconciler({
  reconcile: reconcileWorkloadWork,
});

export async function requestWorkloadCleanup(
  workloadId: string,
): Promise<boolean> {
  return workloadReconciler.enqueueCleanupNow(workloadId);
}

/** Poll a Running Workload now, so a saved Secret reaches it in seconds. */
export async function requestWorkloadPoll(workloadId: string): Promise<void> {
  await workloadReconciler.enqueuePollNow(workloadId);
}

function emptyWorkloadReconcileStatus(
  startedAt: number,
  overrides?: Partial<WorkloadReconcileDrainStatus>,
): WorkloadReconcileDrainStatus {
  return {
    processedCount: 0,
    failureCount: 0,
    deferredCount: 0,
    staleCount: 0,
    hitDrainBudget: false,
    remainingDueCount: 0,
    oldestDueAgeMs: 0,
    drainMs: Date.now() - startedAt,
    failed: false,
    ...overrides,
  };
}

export async function runWorkloadReconcileOnce(options?: {
  activeRecoveryNow?: boolean;
}): Promise<WorkloadReconcileDrainStatus> {
  const startedAt = Date.now();
  try {
    await workloadReconciler.discoverNow(options);
    return await workloadReconciler.drainDue(
      WORKLOAD_RECONCILE_DRAIN_BUDGET_MS,
    );
  } catch (error) {
    log.error('Workload reconcile failed', {
      id: 'system',
      error: error,
    });
    return emptyWorkloadReconcileStatus(startedAt, { failed: true });
  }
}

/** Admit a just-queued Workload now rather than at the next interval. */
export function kickProvisioningScheduler(): void {
  monitors.find((monitor) => monitor.name === 'provisioning-scheduler')?.kick();
}

/** One provisioning-scheduler tick with composed dependencies. */
export function runProvisioningSchedulerOnce(): Promise<void> {
  return runProvisioningScheduler(workflowDeps());
}

// ============================================================================
// Centralized Management
// ============================================================================

let monitors: Monitor[] = [];

/** Liveness of every running monitor, for the degradation watchdog. */
function monitorTickStatuses(): MonitorTickStatus[] {
  const statuses: MonitorTickStatus[] = [];
  for (const monitor of monitors) {
    const lastCompletedAt = monitor.lastCompletedAt();
    if (lastCompletedAt === null) continue;
    statuses.push({
      name: monitor.name,
      intervalMs: monitor.intervalMs,
      lastCompletedAt,
    });
  }
  return statuses;
}

type BackgroundServiceState = 'stopped' | 'starting' | 'running' | 'stopping';
let backgroundServiceState: BackgroundServiceState = 'stopped';
let backgroundStartPromise: Promise<void> | null = null;
let backgroundStopPromise: Promise<void> | null = null;

export async function startBackgroundServices(): Promise<void> {
  if (backgroundServiceState === 'running') return;
  if (backgroundServiceState === 'starting') {
    await backgroundStartPromise;
    return;
  }
  if (backgroundServiceState === 'stopping') {
    await backgroundStopPromise;
    return startBackgroundServices();
  }

  backgroundServiceState = 'starting';
  backgroundStartPromise = (async () => {
    try {
      await workloadReconciler.start();
      monitors = [
        createMonitor(
          'provisioning-scheduler',
          PROVISIONING_SCHEDULER_INTERVAL_MS,
          () => runProvisioningSchedulerOnce(),
        ),
        createMonitor('catalog-refresh', CATALOG_REFRESH_INTERVAL_MS, () =>
          refreshCatalogs(),
        ),
        createMonitor('cost-calculation', COST_CALCULATION_INTERVAL_MS, () =>
          runCostCalculationOnce(),
        ),
        createMonitor(
          'notifications-digest',
          NOTIFICATIONS_DIGEST_INTERVAL_MS,
          () => runNotificationsDigestOnce(),
        ),
        createMonitor(
          'vm-release-notifications',
          VM_RELEASE_NOTIFICATION_INTERVAL_MS,
          () => runVmReleaseNotificationsOnce(),
        ),
        createMonitor(
          'update-notifications',
          UPDATE_NOTIFICATION_INTERVAL_MS,
          () => runUpdateNotificationOnce(),
        ),
        createMonitor('api-health', API_HEALTH_MONITOR_INTERVAL_MS, () =>
          runApiHealthMonitorOnce({
            monitorTicks: monitorTickStatuses,
            reconcileBacklog: () => workloadReconciler.backlogStatus(),
          }),
        ),
      ];
      startApiHealthWatchdog();
      monitors.forEach((monitor) => monitor.start());
      // Check once at boot without delaying API readiness. The scheduled
      // monitor handles later checks and logs any task failure centrally.
      void runUpdateNotificationOnce().catch((error) =>
        log.error('update-notifications failed', {
          id: 'system',
          error: error,
        }),
      );
      backgroundServiceState = 'running';
    } catch (error) {
      monitors.forEach((monitor) => monitor.stop());
      monitors = [];
      stopApiHealthWatchdog();
      await workloadReconciler.stop();
      backgroundServiceState = 'stopped';
      throw error;
    } finally {
      backgroundStartPromise = null;
    }
  })();
  await backgroundStartPromise;
}

export async function stopBackgroundServices(): Promise<void> {
  if (backgroundServiceState === 'stopped') return;
  if (backgroundServiceState === 'stopping') {
    await backgroundStopPromise;
    return;
  }
  if (backgroundServiceState === 'starting') {
    try {
      await backgroundStartPromise;
    } catch {
      return;
    }
    return stopBackgroundServices();
  }

  backgroundServiceState = 'stopping';
  backgroundStopPromise = (async () => {
    try {
      monitors.forEach((monitor) => monitor.stop());
      monitors = [];
      stopApiHealthWatchdog();
      await workloadReconciler.stop();
      const activeWorkCount = activeWorkloadWorkCount();
      if (activeWorkCount > 0) {
        log.info('Active workload work left for restart recovery', {
          id: 'system',
          count: activeWorkCount,
        });
      }
    } finally {
      backgroundServiceState = 'stopped';
      backgroundStopPromise = null;
    }
  })();
  await backgroundStopPromise;
}
