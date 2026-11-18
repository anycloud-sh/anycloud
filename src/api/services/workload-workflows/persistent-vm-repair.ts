/**
 * Persistent-VM repair: recreate a missing container on the original live
 * host, start a host its cloud stopped in place, and keep the distinct
 * terminal policy for a host the cloud confirms gone.
 */

import { log } from '../logger.js';
import { loadWorkloadVmCompute } from '../vm-compute.js';
import { reconcileRunningVmContainer } from '../host-runtime/vm-container-repair.js';
import {
  forgetStoppedVmRestart,
  restartStoppedVm,
  type StoppedVmRestartLifecycle,
} from './stopped-vm-restart.js';
import {
  checkVMRelease,
  clearVMReleaseTracking,
  isVmSshReachable,
} from '../host-runtime/vm-release-observer.js';
import { VMReleaseState } from '../gateways/cloud.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import type { WorkloadReconcileResult } from '../workload-reconciler.js';
import type { StoredWorkload } from '../workload-record.js';
import type { DbVM } from '../entities.js';

/** The live-VM read, in-place restart and host-loss outcome the repair uses. */
export interface PersistentVmRepairPersistence {
  store: { getVMs(workloadId: string): Promise<DbVM[]> };
  lifecycle: StoppedVmRestartLifecycle;
  outcomes: {
    failMissingVmHost(
      workloadId: string,
      vm: { cloudId: string; ip: string },
      options: { reason: string },
    ): Promise<boolean>;
  };
}

export const VM_HOST_MISSING_REASON =
  'Cloud provider confirms VM host no longer exists; Anycloud cannot recover its local /workspace.';

const VM_REPAIR_LOG_DEDUP_MS = 5 * 60_000;
const vmRepairLastLog = new Map<
  string,
  { message: string; loggedAt: number }
>();

function logVmRepairOutcome(
  workloadId: string,
  level: 'info' | 'warn',
  message: string,
  metadata: Record<string, unknown>,
): void {
  const now = Date.now();
  const previous = vmRepairLastLog.get(workloadId);
  if (
    previous?.message === message &&
    now - previous.loggedAt < VM_REPAIR_LOG_DEDUP_MS
  ) {
    return;
  }
  vmRepairLastLog.set(workloadId, { message, loggedAt: now });
  log[level](message, { id: workloadId, ...metadata });
}

export async function reconcileRunningVm(
  deps: PersistentVmRepairPersistence,
  workload: StoredWorkload,
): Promise<WorkloadReconcileResult> {
  const workloadId = workload.id;
  const startedAt = Date.now();
  const vms = await deps.store.getVMs(workloadId);
  if (vms.length !== 1) {
    logVmRepairOutcome(workloadId, 'warn', 'VM-container repair deferred', {
      reason: `expected one live VM ledger row, found ${vms.length}`,
      repairAttempted: false,
    });
    return { disposition: 'deferred' };
  }

  const vm = vms[0]!;
  const sshReachable = await isVmSshReachable(vm);
  if (!sshReachable) {
    return reconcileUnobservableRunningVmHost(
      deps,
      workload,
      vm,
      new Error('SSH endpoint is unreachable'),
    );
  }

  try {
    const result = await reconcileRunningVmContainer(workloadId);
    clearVMReleaseTracking(workloadId);
    forgetStoppedVmRestart(workloadId);
    // Whether this tick got past observation into repair preparation. The
    // ambiguous outcomes below can happen either way, so the log says which.
    const repairAttempted = result.repairAttempted === true;
    switch (result.outcome) {
      case 'healthy':
        vmRepairLastLog.delete(workloadId);
        return { disposition: 'completed' };
      case 'created':
        logVmRepairOutcome(
          workloadId,
          'info',
          'Recreated missing VM container',
          { durationMs: Date.now() - startedAt },
        );
        return { disposition: 'completed' };
      case 'converged':
        logVmRepairOutcome(
          workloadId,
          'info',
          'VM-container repair converged with another creator',
          { durationMs: Date.now() - startedAt },
        );
        return { disposition: 'completed' };
      case 'conflict':
        logVmRepairOutcome(
          workloadId,
          'warn',
          'VM-container repair found an ownership conflict',
          { containerState: result.state, repairAttempted },
        );
        return { disposition: 'completed' };
      case 'observed':
        logVmRepairOutcome(
          workloadId,
          'warn',
          'VM container is not running; leaving it unchanged',
          { containerState: result.state, repairAttempted },
        );
        return { disposition: 'completed' };
      case 'deferred':
        logVmRepairOutcome(workloadId, 'warn', 'VM-container repair deferred', {
          reason: result.reason,
          repairAttempted,
        });
        return { disposition: 'deferred' };
      case 'stale':
        return { disposition: 'stale' };
    }
  } catch (error) {
    return reconcileUnobservableRunningVmHost(deps, workload, vm, error, {
      durationMs: Date.now() - startedAt,
      repairAttempted:
        error instanceof Error &&
        (error as Error & { vmRepairAttempted?: boolean }).vmRepairAttempted ===
          true,
    });
  }
}

async function reconcileUnobservableRunningVmHost(
  { outcomes, lifecycle }: PersistentVmRepairPersistence,
  workload: StoredWorkload,
  vm: DbVM,
  observationError: unknown,
  metadata: Record<string, unknown> = {},
): Promise<WorkloadReconcileResult> {
  const observationMessage = errorMessage(observationError);
  const config = await loadWorkloadVmCompute(workload, vm, 'defer');
  const { vmCompute } = config;
  if (!vmCompute) {
    logVmRepairOutcome(workload.id, 'warn', 'VM host observation deferred', {
      cloudId: vm.cloudId,
      reason: config.reason,
      error: observationMessage,
      ...metadata,
    });
    return { disposition: 'deferred' };
  }

  const cloudStatus = await checkVMRelease(workload.id, vmCompute);

  if (cloudStatus.state === VMReleaseState.Released) {
    const failed = await outcomes.failMissingVmHost(
      workload.id,
      { cloudId: vm.cloudId, ip: vm.ip },
      { reason: VM_HOST_MISSING_REASON },
    );
    clearVMReleaseTracking(workload.id);
    vmRepairLastLog.delete(workload.id);
    if (!failed) {
      log.info('Skipping missing VM host failure: state or host changed', {
        id: workload.id,
        cloudId: vm.cloudId,
      });
      return { disposition: 'stale' };
    }
    log.error('Persistent VM host missing (cloud confirmed)', {
      id: workload.id,
      cloudId: vm.cloudId,
      error: VM_HOST_MISSING_REASON,
    });
    return { disposition: 'completed' };
  }

  if (cloudStatus.state === VMReleaseState.Present) {
    const restarted = await restartStoppedVm(lifecycle, workload, vm, config);
    if (restarted) return restarted;
  }

  if (
    cloudStatus.state === VMReleaseState.Present ||
    cloudStatus.state === VMReleaseState.Confirming
  ) {
    logVmRepairOutcome(
      workload.id,
      'warn',
      cloudStatus.state === VMReleaseState.Present
        ? 'VM observation failed but cloud confirms host exists — preserving'
        : 'VM observation failed while host release awaits confirmation — preserving',
      {
        cloudId: vm.cloudId,
        error: observationMessage,
        ...metadata,
      },
    );
    return { disposition: 'deferred' };
  }

  logVmRepairOutcome(
    workload.id,
    'warn',
    'VM observation failed and cloud host status is unknown',
    {
      cloudId: vm.cloudId,
      error: cloudStatus.error,
      observationError: observationMessage,
      ...metadata,
    },
  );
  return { disposition: 'deferred' };
}
