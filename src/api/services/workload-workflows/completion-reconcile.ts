/**
 * Job completion and finalization handlers for the workload reconciler: poll a
 * Running Job through its runtime or escalate an unreachable host, and drive a
 * Finalizing Job's artifact sync. They live apart from `completion.ts` because
 * the Job runtime composes its poll from that module while these call the
 * runtime.
 */

import { log } from '../logger.js';
import { loadWorkloadConfigs } from '../cloud-config.js';
import { getDefaultJobRuntime } from '../job/default-runtime.js';
import { isVmSshReachable } from '../host-runtime/vm-release-observer.js';
import { VMReleaseState } from '../gateways/cloud.js';
import { restartIfPreempted, type RestartedVM } from '../vm-compute.js';
import {
  finalizeJobArtifacts,
  type CompletionLifecycle,
  type CompletionPersistence,
} from './completion.js';
import {
  forgetJobUnreachable,
  handleUnreachableJob,
  reconcilePreemptionCandidate,
  type RetryRecoveryLifecycle,
  type RetryRecoveryPersistence,
} from './retry-recovery.js';
import type { WorkloadReconcileResult } from '../workload-reconciler.js';
import { withTimeout } from '../../../shared/utils.js';
import type { StoredWorkload } from '../workload-record.js';
import { WorkloadState } from '../../../shared/workload.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
} from '../workload-work-registry.js';

/** The persistence the completion handlers receive from the monitor. */
export interface CompletionReconcilePersistence extends CompletionPersistence {
  store: CompletionPersistence['store'] & RetryRecoveryPersistence['store'];
  events: CompletionPersistence['events'] & RetryRecoveryPersistence['events'];
  resume: RetryRecoveryPersistence['resume'];
  lifecycle: CompletionLifecycle &
    RetryRecoveryLifecycle & {
      restartVMInPlace(
        workloadId: string,
        state: WorkloadState.Finalizing,
        previous: { cloudId: string; ip: string },
        restarted: RestartedVM,
        reason: string,
      ): Promise<boolean>;
    };
}

export async function reconcileRunningJobCompletion(
  persistence: CompletionReconcilePersistence,
  job: StoredWorkload,
): Promise<void> {
  const { store, lifecycle } = persistence;
  // A poll whose GPU probe outlived its 30 s wait still owns the Job, so the
  // next poll waits rather than classify the same exit twice.
  if (hasWorkloadWork(job.id)) return;
  try {
    const vms = await store.getVMs(job.id);

    const configs = await loadWorkloadConfigs(job);
    if (!configs) {
      log.warn('Skipping job completion check: no credentials', {
        id: job.id,
      });
      return;
    }

    const cloudConfig = configs;

    if (!job.sshPrivateKey) {
      log.warn('Skipping job completion check: no SSH key', { id: job.id });
      return;
    }

    // Fast fail: TCP ping the SSH endpoint before attempting SSH (5s vs 30s timeout).
    // sshHost/sshPort may differ from ip:22 for provider NAT/sidecar mappings.
    const activeVm = vms.find((vm) => vm.preempt !== 1 && vm.ip);
    const sshReachable = activeVm ? await isVmSshReachable(activeVm) : false;

    if (sshReachable) {
      const completion = getDefaultJobRuntime().poll({
        workload: job,
        placement: { cloudConfig },
      });
      trackWorkloadWork(job.id, completion);
      await withTimeout(completion, 30_000, `Job runtime poll for ${job.id}`);

      forgetJobUnreachable(job.id);
      return;
    }

    // TCP unreachable: check the cloud, then escalate. A present host may be
    // stopped (maintenance): restart it as a spot Job's poll does. Its loose
    // read counts an Azure reboot on purpose: `--restart no` Jobs don't
    // survive one either.
    const cloud = await handleUnreachableJob(lifecycle, job, cloudConfig, vms);
    if (cloud === VMReleaseState.Present && !job.spot)
      await reconcilePreemptionCandidate(persistence, job);
  } catch (error) {
    log.error('Error checking job completion', {
      id: job.id,
      error: error,
    });
  }
}

// ============================================================================
// Job finalization reconciliation
// ============================================================================

export async function reconcileFinalizingJob(
  persistence: CompletionReconcilePersistence,
  job: StoredWorkload,
): Promise<WorkloadReconcileResult> {
  if (job.cloudProvider === null) {
    const reason =
      'Job reached VM-host-only Finalizing without a resolved provider';
    const outcome = await persistence.outcomes.publishTerminalOutcome(
      job.id,
      WorkloadState.Failed,
      WorkloadState.Finalizing,
      { metadata: { reason } },
    );
    if (outcome) {
      log.error('Rejected invalid Job finalization state', {
        id: job.id,
        cloudProvider: job.cloudProvider,
        error: reason,
      });
    }
    return { disposition: outcome ? 'completed' : 'stale' };
  }

  try {
    const configs = await loadWorkloadConfigs(job);
    if (!configs) {
      log.warn('Skipping job finalization: no credentials', {
        id: job.id,
      });
      return { disposition: 'deferred' };
    }

    if (!job.sshPrivateKey) {
      log.warn('Skipping job finalization: no SSH key', { id: job.id });
      return { disposition: 'deferred' };
    }

    // A spot eviction stops the VM but keeps the disk holding its outputs, so
    // restart it in place rather than spend final-sync attempts on it.
    const [vm] = await persistence.store.getVMs(job.id);
    const restarted =
      job.spot && vm && (await restartIfPreempted(job, vm, configs));
    if (restarted) {
      await persistence.lifecycle.restartVMInPlace(
        job.id,
        WorkloadState.Finalizing,
        vm,
        restarted,
        'final-bucket-sync-vm-restarted',
      );
      return { disposition: 'completed' };
    }

    const finalization = finalizeJobArtifacts(
      persistence,
      job.id,
      job.sshPrivateKey,
      configs,
    );
    trackWorkloadWork(job.id, finalization);
    await finalization;
    return { disposition: 'completed' };
  } catch (error) {
    log.error('Error finalizing job artifacts', {
      id: job.id,
      error: error,
    });
    return { disposition: 'deferred' };
  }
}
