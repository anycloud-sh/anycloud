/**
 * In-place restart of a Running persistent VM whose cloud stopped it (GCP host
 * maintenance on a GPU VM, an EC2 scheduled stop, an Azure deallocation). It is
 * consulted only after SSH failed and the cloud confirmed the host exists. A
 * start that fails, for example on a GPU stockout, is retried in place with
 * backoff and never replaces the VM, so its local /workspace is kept.
 */

import { log } from '../logger.js';
import { restartPreemptedVM, type VmCompute } from '../vm-compute.js';
import { WorkloadState } from '../../../shared/workload.js';
import type { CloudConfig } from '../../../shared/cloud.js';
import type { WorkloadReconcileResult } from '../workload-reconciler.js';
import type { StoredWorkload } from '../workload-record.js';
import type { AddVMAttempt, DbVM, GatewayVM } from '../entities.js';
import type { WorkloadEventMetadataInput } from '../workload-event-metadata.js';

export const VM_STOPPED_RESTARTED_REASON =
  'The cloud stopped this VM (for example for host maintenance); Anycloud started it again in place';
export const VM_STOPPED_WAITING_REASON =
  'The cloud stopped this VM (for example for host maintenance) and it could not be started again yet, for example while its zone lacks capacity; Anycloud keeps retrying in place';

/** The restart's two durable writes. */
export interface StoppedVmRestartLifecycle {
  restartVMInPlace(
    workloadId: string,
    state: WorkloadState.Running,
    previous: { cloudId: string; ip: string },
    restarted: { vm: GatewayVM; attempt: AddVMAttempt },
    reason: string,
  ): Promise<boolean>;
  updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

export const STOPPED_VM_RESTART_BACKOFF_MS = {
  first: 60_000,
  max: 15 * 60_000,
};

// Failed starts of a workload's VM since the stop was seen. In memory: an API
// restart only retries sooner. Keyed to the VM, so a resubmitted workload's
// next VM starts afresh.
const failedStarts = new Map<
  string,
  { cloudId: string; count: number; nextAt: number }
>();

export function resetStoppedVmRestartsForTests(): void {
  failedStarts.clear();
}

/** The host answered again: a later stop starts from a fresh backoff. */
export function forgetStoppedVmRestart(workloadId: string): void {
  failedStarts.delete(workloadId);
}

/**
 * Start a cloud-stopped VM in place and record its new address. Null when the
 * VM isn't stopped (or already runs at its recorded address), or its cloud
 * can't restart one, so the caller keeps its own policy.
 */
export async function restartStoppedVm(
  lifecycle: StoppedVmRestartLifecycle,
  workload: StoredWorkload,
  vm: DbVM,
  {
    vmCompute,
    cloudConfig,
  }: { vmCompute: VmCompute; cloudConfig: CloudConfig },
): Promise<WorkloadReconcileResult | null> {
  // The strict stopped read: Azure's restart read (`restart.observe`) also
  // counts a VM that is only rebooting, which its cloud brings back itself.
  const { preemption: restart, observeStopped } = vmCompute;
  if (!restart || !observeStopped) return null;
  const entry = failedStarts.get(workload.id);
  const failed = entry?.cloudId === vm.cloudId ? entry : undefined;
  if (failed && Date.now() < failed.nextAt) return { disposition: 'deferred' };
  // After a failed start, a running VM is read too: a start can complete
  // after its deadline, and its new address must still be recorded.
  const stopped = await observeStopped();
  if (!stopped && !failed) return null;

  log.warn('Cloud stopped the VM; starting it in place', {
    id: workload.id,
    cloudId: vm.cloudId,
  });
  const restarted = await restartPreemptedVM(restart, cloudConfig, vm).catch(
    (error: unknown) => {
      log.warn('Stopped VM start failed', { id: workload.id, error });
      return null;
    },
  );
  if (!restarted) {
    const count = (failed?.count ?? 0) + 1;
    const { first, max } = STOPPED_VM_RESTART_BACKOFF_MS;
    failedStarts.set(workload.id, {
      cloudId: vm.cloudId,
      count,
      nextAt: Date.now() + Math.min(first * 2 ** (count - 1), max),
    });
    // `startVM` reports a failure as null, having logged its cause (a
    // stockout, quota or credential error), so the event can't name it.
    if (count === 1) {
      await lifecycle.updateState(workload.id, WorkloadState.Running, {
        metadata: { reason: VM_STOPPED_WAITING_REASON, cloudId: vm.cloudId },
      });
    }
    log.warn('Stopped VM not started; retrying in place', {
      id: workload.id,
      cloudId: vm.cloudId,
      failedStarts: count,
    });
    return { disposition: 'deferred' };
  }

  failedStarts.delete(workload.id);
  if (!stopped && restarted.vm.ip === vm.ip) return null;
  const recorded = await lifecycle.restartVMInPlace(
    workload.id,
    WorkloadState.Running,
    vm,
    restarted,
    VM_STOPPED_RESTARTED_REASON,
  );
  log.info('Stopped VM started in place', {
    id: workload.id,
    newIp: restarted.vm.ip,
    recorded,
  });
  return { disposition: recorded ? 'completed' : 'stale' };
}
