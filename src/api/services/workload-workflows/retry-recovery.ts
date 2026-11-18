/**
 * Retry and recovery workflow: observe preemption and unreachable Job hosts,
 * claim Recovering, choose in-place resume or replacement, apply retry budgets
 * and VM reuse rules, and hand the reconciler-gated launch to the lifecycle.
 */

import { log } from '../logger.js';
import {
  loadWorkloadVmCompute,
  restartPreemptedVM,
  type VmCompute,
} from '../vm-compute.js';
import type {
  RetryAdmissionResult,
  RetryVMEligibility,
} from '../repositories/workload-lifecycle.js';
import type { RetryCandidate } from '../repositories/retry-candidates.js';
import { loadWorkloadConfigs } from '../cloud-config.js';
import { teardownVMs } from '../host-runtime/termination.js';
import { getDefaultServeRuntime } from '../serve/default-runtime.js';
import { getDefaultJobRuntime } from '../job/default-runtime.js';
import {
  pAllSettledLimit,
  VMReleaseState,
  vmReleaseUnknown,
  type VMReleaseStatus,
} from '../gateways/cloud.js';
import {
  checkVMRelease,
  clearVMReleaseTracking,
} from '../host-runtime/vm-release-observer.js';
import { FailureDisposition } from '../provisioning-failure.js';
import {
  FAILED_DEPLOY_MAX_ATTEMPTS,
  JOB_CHECK_TIMEOUT_THRESHOLD,
  PINNED_PROVISIONING_REJECTION_MAX_ATTEMPTS,
  TERMINATION_TIMEOUT_MS,
  UNUSABLE_GPU_MAX_RETRIES,
} from '../../config.js';
import {
  UNUSABLE_GPU_DIAGNOSIS,
  UNUSABLE_GPU_EXHAUSTED,
} from './missing-gpu.js';
import { errorForDiagnosticMetadata } from '../../../shared/log-diagnostics.js';
import type { WorkloadReconcileResult } from '../workload-reconciler.js';
import { withTimeout } from '../../../shared/utils.js';
import type { StoredWorkload } from '../workload-record.js';
import {
  CloudFailureDiagnosis,
  type CloudConfig,
} from '../../../shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
  type EndReason,
  type WorkloadTypeValue,
} from '../../../shared/workload.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
} from '../workload-work-registry.js';
import type { AddVMAttempt, DbVM, GatewayVM } from '../entities.js';
import type { WorkloadEventMetadataInput } from '../workload-event-metadata.js';
import { endAtMaxRetries, pastMaxRetries } from './vm-job-max-retries.js';

/** The workload reads this workflow uses. */
interface RetryRecoveryStore {
  getVMs(workloadId: string): Promise<DbVM[]>;
  lastVmPreempted(workloadId: string): Promise<boolean>;
  resolveActiveCredentialId(
    workload: StoredWorkload,
    computeCredIdOverride?: string,
  ): Promise<string | undefined>;
}

/** The attempt-ledger read that picks the retry's credential. */
interface RetryRecoveryAttempts {
  getUnresolvedProvisioningAttempts(
    workloadId: string,
  ): Promise<Array<{ credential_id: string | null }>>;
}
/** The event read that classifies the failure being retried. */
interface RetryRecoveryEvents {
  getLatestFailureClassification(
    workloadId: string,
  ): Promise<{ diagnosis: string | null } | null>;
  countFailureDiagnosis(workloadId: string, diagnosis: string): Promise<number>;
  countStateEvents(workloadId: string, state: WorkloadState): Promise<number>;
}

/** The durable retry and recovery transitions this workflow drives. */
export interface RetryRecoveryLifecycle {
  claimRecovery(
    workloadId: string,
    expectedState: WorkloadState,
    options?: {
      metadata?: WorkloadEventMetadataInput;
      vm?: {
        cloudId: string;
        ip: string;
        markPreempted?: boolean;
      };
    },
  ): Promise<boolean>;
  finishPreemptionRecovery(
    workloadId: string,
    workloadType: WorkloadTypeValue,
    previousCloudId: string,
    vm: GatewayVM,
    attempt?: AddVMAttempt,
  ): Promise<boolean>;
  getRetryVMEligibility(
    workloadId: string,
    expectedRevision: number,
  ): Promise<RetryVMEligibility>;
  /**
   * A `'reuse'` candidate is queued with its one open, IP'd VM kept. The
   * scheduler admits it like any Queued row, then `prepareWorkloadPipeline`
   * (`workload-pipeline.ts`) replays Provisioning through the runtime `deploy`,
   * whose `provisionStep` adopts the VM without a new attempt. Placement comes
   * from `loadWorkloadConfigs`. The scheduler's new intent is ignored while a
   * live VM exists, and no placement-mismatch check runs against the VM: that
   * check is only for IP-less attempts. More than one live VM, or one beside an
   * IP-less attempt, returns the workload to Retrying; a retry from
   * Provisioning is never `'reuse'`, so those VMs are released. The VM isn't
   * re-checked at the provider, and its local storage is kept only under
   * `InPlaceResume`'s rule. If its row ends before dispatch, Provisioning
   * creates a new VM from the scheduler's intent.
   */
  queueRetryCandidate(
    workloadId: string,
    expectedRevision: number,
  ): Promise<RetryAdmissionResult>;
}

/** The terminal outcome a retry publishes when it gives up. */
interface RetryRecoveryOutcomes {
  publishTerminalOutcome(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    options?: {
      metadata?: WorkloadEventMetadataInput;
      endReason?: EndReason;
      lastAttemptEndReason?: EndReason;
    },
  ): Promise<boolean>;
}

/**
 * Resumes a preempted Job on its restarted VM once `finishPreemptionRecovery`
 * marks the Recovering event `inPlaceRestartSucceeded`. A later `reuse` retry
 * (see `queueRetryCandidate`) keeps its VMs' local storage only with that mark
 * and managed bucket host paths (`shouldPreserveVmStorageForRetry`).
 */
interface InPlaceResume {
  resumeOnExistingVM(config: CloudConfig, job: StoredWorkload): Promise<void>;
}

export interface RetryRecoveryPersistence {
  store: RetryRecoveryStore;
  lifecycle: RetryRecoveryLifecycle;
  outcomes: RetryRecoveryOutcomes;
  attempts: RetryRecoveryAttempts;
  events: RetryRecoveryEvents;
  credentials: {
    isCredentialAuthFailed(credentialId: string): Promise<boolean>;
  };
  resume: InPlaceResume;
}

// --- Recovery claims ---

/**
 * Atomically claim a workload into Recovering from the state this reconciler
 * observed. If another actor advanced or terminated it first, the exact-state
 * CAS fails and that actor keeps ownership.
 */
async function claimRecovering(
  lifecycle: RetryRecoveryLifecycle,
  workloadId: string,
  reason: string,
  currentState: WorkloadState,
  metadata?: WorkloadEventMetadataInput,
  vm?: {
    cloudId: string;
    ip: string;
    markPreempted?: boolean;
  },
): Promise<boolean> {
  const transitioned = await lifecycle.claimRecovery(workloadId, currentState, {
    metadata: { ...metadata, reason },
    vm,
  });
  if (!transitioned) {
    log.info('Skipping recovery claim: state changed concurrently', {
      id: workloadId,
      state: currentState,
    });
    return false;
  }
  return true;
}

/** Best-effort VM cleanup after Recovering has durably taken ownership. */
async function teardownForRecovery(
  cloudConfig: CloudConfig,
  workloadId: string,
  currentState: WorkloadState,
): Promise<void> {
  try {
    const teardown = teardownVMs(cloudConfig, workloadId);
    trackWorkloadWork(workloadId, teardown);
    await withTimeout(
      teardown,
      TERMINATION_TIMEOUT_MS,
      `teardownVMs for ${workloadId}`,
    );
  } catch (e) {
    log.warn('Pre-recovery teardownVMs failed; retry pipeline will clean up', {
      id: workloadId,
      error: e,
    });
  }
  log.info('Preempted VM queued for re-provisioning', {
    id: workloadId,
    state: currentState,
  });
}

/** Claim Recovering and immediately hand its VMs to the retry cleanup path. */
async function transitionToRecovering(
  lifecycle: RetryRecoveryLifecycle,
  cloudConfig: CloudConfig,
  workloadId: string,
  reason: string,
  currentState: WorkloadState,
): Promise<boolean> {
  if (!(await claimRecovering(lifecycle, workloadId, reason, currentState))) {
    return false;
  }
  await teardownForRecovery(cloudConfig, workloadId, currentState);
  return true;
}

// --- Preemption Monitor ---

export const PREEMPTION_POLL_INTERVAL_MS = 30_000; // 30 seconds
// Per-workload VM fanout remains independently bounded inside the aggregate
// workload reconciliation operation. A workload currently has one live VM,
// but the inner cap preserves safety if that changes.
const PREEMPTION_VM_CONCURRENCY = 20;

/** Restart a cloud-stopped VM in place or hand it to the retry pipeline. */
export async function reconcilePreemptionCandidate(
  {
    store,
    lifecycle,
    resume,
    events,
  }: Pick<
    RetryRecoveryPersistence,
    'store' | 'lifecycle' | 'resume' | 'events'
  >,
  workload: StoredWorkload,
): Promise<boolean> {
  let didTransition = false;
  const cause = workload.spot ? 'preemption' : 'cloud stopped the VM';

  try {
    const vms = await store.getVMs(workload.id);
    if (vms.length === 0) return false;

    const configs = await loadWorkloadConfigs(workload);
    if (!configs) {
      log.warn('No credentials found for workload', {
        id: workload.id,
      });
      return false;
    }
    await pAllSettledLimit(
      vms.filter((vm) => vm.preempt !== 1),
      PREEMPTION_VM_CONCURRENCY,
      async (vm) => {
        let cloudConfig: CloudConfig;
        let preemption: VmCompute['preemption'];
        try {
          const resolved = await loadWorkloadVmCompute(workload, vm, {
            fallback: configs,
          });
          if (!resolved.vmCompute) {
            log.warn('VM preemption observation deferred', {
              id: workload.id,
              cloudId: vm.cloudId,
              reason: resolved.reason,
            });
            return;
          }
          cloudConfig = resolved.cloudConfig;
          const { vmCompute } = resolved;
          preemption = vmCompute.preemption;
          if (!preemption) {
            if (workload.spot)
              log.warn('Spot workload on a non-preemptible cloud; skipping', {
                id: workload.id,
              });
            return;
          }
        } catch (error) {
          log.warn('VM preemption observation deferred', {
            id: workload.id,
            cloudId: vm.cloudId,
            error,
          });
          return;
        }
        let ownsRecovery = false;
        try {
          const isPreempted = await preemption.observe();
          if (!isPreempted) return;

          log.warn(`VM stopped by its cloud (${cause})`, {
            id: workload.id,
            ip: vm.ip,
            cloudId: vm.cloudId,
          });

          const reason =
            workload.state === WorkloadState.Running
              ? `${cause}: attempting in-place VM restart`
              : `${cause} during ${workload.state}`;
          ownsRecovery = await claimRecovering(
            lifecycle,
            workload.id,
            reason,
            workload.state as WorkloadState,
            undefined,
            {
              cloudId: vm.cloudId,
              ip: vm.ip,
              markPreempted: true,
            },
          );
          if (!ownsRecovery) return;
          didTransition = true;

          // Partial setup can't resume, so recover from scratch; a Job past
          // its --max-retries isn't restarted, and the retry reconciler ends it.
          if (
            workload.state !== WorkloadState.Running ||
            (await pastMaxRetries(events, workload))
          ) {
            await teardownForRecovery(
              cloudConfig,
              workload.id,
              workload.state as WorkloadState,
            );
            return;
          }

          // Running: the durable state is already Recovering while the cloud
          // SDK's restart poll runs (which may take minutes or be interrupted).
          const restarted = await restartPreemptedVM(
            preemption,
            cloudConfig,
            vm,
          );
          if (!restarted) {
            await teardownForRecovery(
              cloudConfig,
              workload.id,
              WorkloadState.Running,
            );
            return;
          }

          // Atomically replace the tracked VM row and exit Recovering.
          // The exact-state commit fails without touching rows if termination
          // won during startVM.
          const resumed = await lifecycle.finishPreemptionRecovery(
            workload.id,
            workload.workloadType,
            vm.cloudId,
            restarted.vm,
            restarted.attempt,
          );
          if (!resumed) {
            log.info('Skipping in-place resume: state changed concurrently', {
              id: workload.id,
            });
            return;
          }

          if (workload.workloadType === WorkloadType.Job) {
            const recovery = resume
              .resumeOnExistingVM(cloudConfig, workload)
              .catch((err) => {
                log.error('In-place VM recovery failed', {
                  id: workload.id,
                  error: err,
                });
              });
            trackWorkloadWork(workload.id, recovery);
          }

          log.info('Preempted VM restarted successfully', {
            id: workload.id,
            newIp: restarted.vm.ip,
          });
        } catch (error) {
          log.error('Preemption recovery failed', {
            id: workload.id,
            ip: vm.ip,
            error: error,
          });

          // If the error happened before the normal claim, make one exact-state
          // best-effort claim. Once claimed, cleanup can fail safely because the
          // retry reconciler will continue from Recovering.
          try {
            if (!ownsRecovery) {
              ownsRecovery = await claimRecovering(
                lifecycle,
                workload.id,
                `${cause}: recovery error`,
                workload.state as WorkloadState,
                {
                  ip: vm.ip,
                  error: errorForDiagnosticMetadata(error),
                },
                { cloudId: vm.cloudId, ip: vm.ip },
              );
            }
            if (ownsRecovery) {
              didTransition = true;
              await teardownForRecovery(
                cloudConfig,
                workload.id,
                workload.state as WorkloadState,
              );
            }
          } catch {
            // ignore secondary failure
          }
        }
      },
    );
  } catch (error) {
    log.error('Error checking workload for preemption', {
      id: workload.id,
      error: error,
    });
  }

  return didTransition;
}

// --- Failed workload retry reconciliation ---

export async function reconcileRetryCandidate(
  persistence: RetryRecoveryPersistence,
  { id, state, retryCount, failedAtState, resubmitCount }: RetryCandidate,
  workload: StoredWorkload,
  options: { launch: boolean; expectedRevision: number },
): Promise<WorkloadReconcileResult> {
  const { store, lifecycle, outcomes, attempts, events, credentials } =
    persistence;
  try {
    if (hasWorkloadWork(id)) {
      log.info('Retry deferred — workload work still in flight', { id });
      return { disposition: 'deferred' };
    }

    // Pause the retry while the workload's active credential fails auth: the
    // pre-retry teardown and a re-provision need it, so an invalid secret
    // otherwise re-storms the provider every tick (e.g. AADSTS7000215). It
    // resumes once a valid secret is saved; an earlier containment, for retries.
    const unresolvedAttempts =
      await attempts.getUnresolvedProvisioningAttempts(id);
    const activeCredId = await store.resolveActiveCredentialId(
      workload,
      unresolvedAttempts.at(-1)?.credential_id ?? undefined,
    );
    if (
      activeCredId &&
      (await credentials.isCredentialAuthFailed(activeCredId))
    ) {
      log.warn('Retry paused — credential invalid; re-enter a valid secret', {
        id,
      });
      return { disposition: 'deferred' };
    }

    const latestFailure = await events.getLatestFailureClassification(id);

    // Load credentials — needed for terminateStep (and re-queue if not exhausted)
    const configs = await loadWorkloadConfigs(workload, activeCredId);
    if (!configs) {
      log.warn('Credentials missing — marking workload as failed', {
        id,
      });
      const outcome = await outcomes.publishTerminalOutcome(
        id,
        WorkloadState.Failed,
        state,
        { metadata: { reason: 'credentials not found' } },
      );
      return { disposition: outcome ? 'completed' : 'stale' };
    }
    const cloudConfig = configs;
    const capped = await endAtMaxRetries(persistence, workload, state);
    if (capped) return capped;
    /** The budget ran out: fail the Job, naming what ended its last attempt. */
    const exhaust = async (
      metadata: WorkloadEventMetadataInput,
      lastAttemptEndReason?: EndReason,
    ): Promise<WorkloadReconcileResult> => {
      const outcome = await outcomes.publishTerminalOutcome(
        id,
        WorkloadState.Failed,
        state,
        { endReason: 'retries-exhausted', lastAttemptEndReason, metadata },
      );
      return { disposition: outcome ? 'completed' : 'stale' };
    };

    if (
      failedAtState === WorkloadState.Provisioning &&
      workload.region &&
      latestFailure?.diagnosis === CloudFailureDiagnosis.ProvisioningRejected &&
      retryCount >=
        PINNED_PROVISIONING_REJECTION_MAX_ATTEMPTS * (resubmitCount + 1)
    ) {
      log.warn(
        'Pinned provisioning rejection retry budget exhausted — marking workload as failed',
        {
          id,
          retryCount,
          diagnosis: latestFailure.diagnosis,
        },
      );
      return exhaust({
        reason: 'pinned provisioning rejection retry attempts exhausted',
        diagnosis: latestFailure.diagnosis,
        disposition: FailureDisposition.TerminalFailed,
        errorKind: latestFailure.diagnosis,
      });
    }

    if (
      latestFailure?.diagnosis === UNUSABLE_GPU_DIAGNOSIS &&
      (await events.countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS)) >
        UNUSABLE_GPU_MAX_RETRIES * (resubmitCount + 1)
    ) {
      return exhaust({ reason: UNUSABLE_GPU_EXHAUSTED });
    }

    const maxAttempts = FAILED_DEPLOY_MAX_ATTEMPTS * (resubmitCount + 1);
    if (retryCount >= maxAttempts) {
      log.warn('Retry attempts exhausted — marking workload as failed', {
        id,
        retryCount,
      });
      // A host the cloud reclaimed or that went away mid-run, or a failed
      // deploy step before the program ran.
      return exhaust(
        { reason: 'retry attempts exhausted' },
        state !== WorkloadState.Recovering
          ? undefined
          : (await store.lastVmPreempted(id))
            ? 'reclaimed'
            : 'lost',
      );
    }

    // Preparation and the atomic queue claim use the same durable eligibility
    // rule. A fulfilled teardown can leave unconfirmed VM attempts open.
    const eligibility = await lifecycle.getRetryVMEligibility(
      id,
      options.expectedRevision,
    );
    if (eligibility === 'stale') return { disposition: 'stale' };
    if (eligibility === 'reuse') {
      // The next deploy adopts these VMs; see queueRetryCandidate.
      log.info('Keeping existing VMs for reuse on retry', {
        id,
        failedAtState,
      });
    } else if (eligibility === 'release-pending') {
      try {
        const teardown =
          workload.workloadType === WorkloadType.Service
            ? getDefaultServeRuntime().teardown({
                workload,
                placement: { cloudConfig },
              })
            : getDefaultJobRuntime().teardown({
                workload,
                placement: { cloudConfig },
              });
        trackWorkloadWork(id, teardown);
        await withTimeout(
          teardown,
          TERMINATION_TIMEOUT_MS,
          `workload teardown for ${id}`,
        );
      } catch (e) {
        log.warn('Pre-retry VM cleanup failed — will retry on next tick', {
          id,
          error: e,
        });
        return { disposition: 'deferred' };
      }

      const afterTeardown = await lifecycle.getRetryVMEligibility(
        id,
        options.expectedRevision,
      );
      if (afterTeardown === 'stale') return { disposition: 'stale' };
      if (afterTeardown === 'release-pending') {
        return { disposition: 'deferred', reason: 'release-pending' };
      }
    }

    // Preparation is admitted immediately so cleanup is not delayed by
    // backoff. Only the reconciler may admit the launch transition.
    if (!options.launch) {
      return { disposition: 'completed' };
    }

    log.info('Retrying failed workload', { id, retryCount, failedAtState });

    const queued = await lifecycle.queueRetryCandidate(
      id,
      options.expectedRevision,
    );
    if (queued === 'release-pending') {
      return { disposition: 'deferred', reason: 'release-pending' };
    }
    return { disposition: queued === 'queued' ? 'completed' : 'stale' };
  } catch (error) {
    log.error('Failed workload retry error', {
      id,
      error: error,
    });
    throw error;
  }
}

// --- Unreachable Job recovery ---

export const JOB_COMPLETION_POLL_INTERVAL_MS = 30_000; // 30 seconds
export const JOB_UNREACHABLE_RECOVERY_MS =
  JOB_CHECK_TIMEOUT_THRESHOLD * JOB_COMPLETION_POLL_INTERVAL_MS;

interface JobUnreachableState {
  count: number;
  since: number;
  cloudUnknownSince?: number;
}

// SSH-unreachable duration and cloud evidence per job. Cleared on success or
// escalation. Duration, rather than count × nominal interval, remains accurate
// when a cloud check itself consumes part of the monitor cycle.
const jobUnreachableStates = new Map<string, JobUnreachableState>();

export function resetRetryRecoveryStateForTests(): void {
  jobUnreachableStates.clear();
}

/** Forget a Job's unreachable window and its pending VM release checks. */
export function forgetJobUnreachable(jobId: string): void {
  jobUnreachableStates.delete(jobId);
  clearVMReleaseTracking(jobId);
}

/**
 * The SSH endpoint is unreachable (TCP ping failed). Ask the cloud whether the VM
 * is actually terminated: if so, recover now. If the provider confirms that the
 * VM still exists, preserve it rather than turning a control-plane reachability
 * failure into destructive recovery. A continuously unknown provider status keeps
 * the bounded fallback so an unobservable, genuinely gone VM is not stranded.
 * Returns the cloud's answer.
 */
export async function handleUnreachableJob(
  lifecycle: RetryRecoveryLifecycle,
  job: StoredWorkload,
  cloudConfig: CloudConfig,
  vms: DbVM[],
): Promise<VMReleaseStatus['state']> {
  const unreachableObservedAt = Date.now();
  let cloudStatus: VMReleaseStatus = vmReleaseUnknown(
    'No cloud VM id available',
  );

  // If cloud confirms the VM is gone, recover immediately.
  const cloudVm = vms.find((vm) => vm.preempt !== 1 && vm.cloudId);
  if (cloudVm?.cloudId) {
    try {
      const resolved = await loadWorkloadVmCompute(job, cloudVm, {
        fallback: cloudConfig,
      });
      cloudStatus = resolved.vmCompute
        ? await checkVMRelease(job.id, resolved.vmCompute)
        : vmReleaseUnknown(resolved.reason);
    } catch (error) {
      cloudStatus = vmReleaseUnknown(error);
    }
    if (cloudStatus.state === VMReleaseState.Released) {
      log.warn('VM terminated (cloud confirmed) — recovering', {
        id: job.id,
        cloudId: cloudVm.cloudId,
      });
      forgetJobUnreachable(job.id);
      await transitionToRecovering(
        lifecycle,
        cloudConfig,
        job.id,
        'VM terminated (cloud confirmed)',
        job.state,
      );
      return cloudStatus.state;
    }
    if (cloudStatus.state === VMReleaseState.Unknown) {
      log.warn('Cloud VM status unknown', {
        id: job.id,
        cloudId: cloudVm.cloudId,
        error: cloudStatus.error,
      });
    } else if (cloudStatus.state === VMReleaseState.Confirming) {
      log.info('Cloud VM release awaiting stable confirmation', {
        id: job.id,
        cloudId: cloudVm.cloudId,
      });
    }
  }

  const now = Date.now();
  const previous = jobUnreachableStates.get(job.id);
  const unreachable: JobUnreachableState = {
    count: (previous?.count ?? 0) + 1,
    since: previous?.since ?? unreachableObservedAt,
    ...(cloudStatus.state === VMReleaseState.Unknown && {
      cloudUnknownSince: previous?.cloudUnknownSince ?? unreachableObservedAt,
    }),
  };
  jobUnreachableStates.set(job.id, unreachable);
  const unreachableMs = now - unreachable.since;

  log.error('Job SSH unreachable', {
    id: job.id,
    error: `${unreachable.count} consecutive failures over ${Math.round(unreachableMs / 1000)}s; cloud=${cloudStatus.state}`,
  });

  if (unreachableMs < JOB_UNREACHABLE_RECOVERY_MS) return cloudStatus.state;

  // Cloud existence is authoritative for resource retention, even though it
  // does not prove guest or workload health. A saturated VM can stop servicing
  // SSH while continuing useful work; recycling it here destroys that work and
  // local checkpoints. Keep monitoring until SSH returns, cloud termination is
  // confirmed, or the user explicitly terminates the workload.
  if (
    cloudStatus.state === VMReleaseState.Present ||
    cloudStatus.state === VMReleaseState.Confirming
  ) {
    log.warn(
      cloudStatus.state === VMReleaseState.Present
        ? 'Job SSH unreachable but cloud confirms VM exists — preserving'
        : 'Job SSH unreachable while VM release awaits confirmation — preserving',
      {
        id: job.id,
        cloudId: cloudVm?.cloudId,
        unreachableMs,
        consecutiveFailures: unreachable.count,
      },
    );
    return cloudStatus.state;
  }

  // A single provider API failure after positive existence evidence must not
  // immediately recycle the VM. Require a full unknown-status window; any
  // later Alive result resets this independent fallback clock.
  const cloudUnknownMs =
    now - (unreachable.cloudUnknownSince ?? unreachableObservedAt);
  if (cloudUnknownMs < JOB_UNREACHABLE_RECOVERY_MS) return cloudStatus.state;

  // Duration thresholds reached with no authoritative cloud result — recover
  // conservatively, preserving the missing evidence in the diagnostic.
  forgetJobUnreachable(job.id);

  const ranForMs = Date.now() - unreachableMs - job.startedAt;
  const ranForMin = Math.round(ranForMs / 60_000);
  const unreachableMin = Math.round(unreachableMs / 60_000);
  const cloudEvidence = `cloud status unknown: ${cloudStatus.error}`;
  const reason = `SSH unreachable for ${unreachableMin} min (${unreachable.count} consecutive checks, ${cloudEvidence}). Job ran for ${ranForMin} min before becoming unreachable.`;
  log.error('Job unreachable — recovering', {
    id: job.id,
    error: reason,
  });

  await transitionToRecovering(
    lifecycle,
    cloudConfig,
    job.id,
    reason,
    job.state,
  );
  return cloudStatus.state;
}
