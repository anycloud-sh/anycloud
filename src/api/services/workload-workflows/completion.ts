/**
 * Job completion workflow: interpret a Job container's exit, keep the exit
 * evidence, retry final artifact sync while the VM stays live, and publish the
 * recorded outcome or Failed once preservation is impossible.
 */

import { log } from '../logger.js';
import { DockerManager } from '../docker.js';
import { terminate } from '../host-runtime/termination.js';
import {
  captureVmStorageDiagnostics,
  hasVmRuntimeStorage,
  needsVmHostFinalSync,
  syncFinalVmJobArtifacts,
} from '../vm-runtime-storage.js';
import type { StoredWorkload } from '../workload-record.js';
import type { DbVM } from '../entities.js';
import {
  GPU_RERUN_DIAGNOSIS,
  type WorkloadEventMetadataInput,
} from '../workload-event-metadata.js';
import { errorForDiagnosticMetadata } from '../../../shared/log-diagnostics.js';
import { CloudConfig, GpuRuntime } from '../../../shared/cloud.js';
import {
  confirmUnusableGpu,
  looksLikeMissingGPU,
  UNUSABLE_GPU_DIAGNOSIS,
} from './missing-gpu.js';
import { WorkloadState } from '../../../shared/workload.js';
import { ContainerState, isContainerHealthy } from '../../../shared/runtime.js';
import {
  gpuRuntimeForVMType,
  isGPUVMType,
} from '../../../shared/cloud-config.js';
import {
  spotNoReclaimNoticeCommand,
  supportsAcceleratorFailureRetry,
} from '../../../shared/providers.js';
import { DwellGate } from '../../../shared/utils.js';

/** The workload reads Job completion uses. */
interface CompletionStore {
  getWorkload(workloadId: string): Promise<StoredWorkload | null>;
  getVMs(workloadId: string): Promise<DbVM[]>;
}

/** The event read that recovers the final bucket sync's control metadata. */
interface CompletionEvents {
  getLatestFinalizationEventMetadata(
    workloadId: string,
  ): Promise<{ metadata: Record<string, unknown> | null } | null>;
  countFailureDiagnosis(workloadId: string, diagnosis: string): Promise<number>;
}

/** The durable recovery and step transitions Job completion publishes. */
export interface CompletionLifecycle {
  claimRecovery(
    workloadId: string,
    expectedState: WorkloadState,
    options?: {
      metadata?: WorkloadEventMetadataInput;
      vm?: { cloudId: string; ip: string };
    },
  ): Promise<boolean>;
  updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

/** The terminal outcomes Job completion publishes. */
interface CompletionOutcomes {
  publishTerminalOutcome(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

/** The persistence Job completion receives from its composition. */
export interface CompletionPersistence {
  store: CompletionStore;
  lifecycle: CompletionLifecycle;
  outcomes: CompletionOutcomes;
  events: CompletionEvents;
}

// Tracks the first time we observed a container exit on a running spot VM.
// Rather than blocking inside checkJobCompletion (which races with resumeOnExistingVM),
// we spread the confirmation window across monitor cycles: workload-reconcile gets
// its normal 30 s cadence to detect any actual preemption and trigger recovery, and we
// only act once SPOT_EXIT_CONFIRM_MS has elapsed without intervention (a
// `--max-retries 0` Job's clean exit can end at once: see checkJobCompletion).
// 150 s = 5 workload-reconcile cycles — comfortably beyond the AWS ~2 min SIGTERM window.
// Cleared whenever the container is healthy again (i.e. after in-place recovery restarts it).
// In-memory is intentional: an API restart simply resets the clock, which is safe —
// the outcome is always correct, just takes up to 150 s longer to confirm after a restart.
const pendingSpotExits = new DwellGate<string>();
const SPOT_EXIT_CONFIRM_MS = 150_000; // 5 × 30 s workload-reconcile cycles
const RECLAIM_NOTICE_TIMEOUT_MS = 15_000;
export const FINAL_SYNC_MAX_ATTEMPTS = 20;

type FinalSyncTargetState = WorkloadState.Completed | WorkloadState.Errored;

interface FinalizationMetadata {
  targetState: FinalSyncTargetState;
  workloadExitCode: number;
  attempt: number;
  maxAttempts: number;
  exitMetadata: Record<string, unknown>;
}

export function classifyJobExit(
  workload: StoredWorkload | null,
  containerStatus: { exitCode: number; logs?: string },
  gpuTarget: boolean,
  runtime: GpuRuntime | null,
): WorkloadState {
  if (containerStatus.exitCode === 0) return WorkloadState.Completed;

  if (gpuTarget && looksLikeMissingGPU(containerStatus.logs, runtime)) {
    return WorkloadState.Retrying;
  }

  return WorkloadState.Errored;
}

/**
 * Check if a job has completed and update state accordingly.
 * Idempotent - only acts if container exited and not already in terminal/terminating state.
 * If the container exited with final artifact work, transitions through Finalizing
 * before publishing Completed (exit 0) or Errored (non-zero). Final sync
 * exhaustion is Failed because anycloud could not preserve the run artifacts.
 * Auto-terminates the VM once the workload reaches a terminal state.
 */

function isFinalSyncTargetState(value: unknown): value is FinalSyncTargetState {
  return value === WorkloadState.Completed || value === WorkloadState.Errored;
}

function parseFinalizationMetadata(
  metadata: Record<string, unknown> | null | undefined,
): FinalizationMetadata | null {
  if (!metadata) return null;
  if (!isFinalSyncTargetState(metadata.targetState)) return null;
  if (typeof metadata.workloadExitCode !== 'number') return null;
  return {
    targetState: metadata.targetState,
    workloadExitCode: metadata.workloadExitCode,
    attempt: typeof metadata.attempt === 'number' ? metadata.attempt : 0,
    maxAttempts:
      typeof metadata.maxAttempts === 'number'
        ? metadata.maxAttempts
        : FINAL_SYNC_MAX_ATTEMPTS,
    exitMetadata: extractFinalizationExitMetadata(metadata),
  };
}

const FINALIZATION_CONTROL_METADATA_KEYS = new Set([
  'exitMetadata',
  'targetState',
  'workloadExitCode',
  'attempt',
  'maxAttempts',
  'reason',
  'error',
  'finalSyncAttempts',
  'phase',
]);

function extractFinalizationExitMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const exitMetadata = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !FINALIZATION_CONTROL_METADATA_KEYS.has(key),
    ),
  );

  if (
    typeof exitMetadata.exitCode !== 'number' &&
    typeof metadata.workloadExitCode === 'number'
  ) {
    exitMetadata.exitCode = metadata.workloadExitCode;
  }

  return exitMetadata;
}

function finalizationStateMetadata(
  finalSync: FinalizationMetadata,
  attempt = finalSync.attempt,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...finalSync.exitMetadata,
    targetState: finalSync.targetState,
    workloadExitCode: finalSync.workloadExitCode,
    attempt,
    maxAttempts: finalSync.maxAttempts,
    ...extra,
  };
}

async function finishExitedJob(args: {
  lifecycle: CompletionLifecycle;
  outcomes: CompletionOutcomes;
  id: string;
  cloudConfig: CloudConfig;
  targetState: FinalSyncTargetState;
  workloadExitCode: number;
  exitMetadata: Record<string, unknown>;
}): Promise<void> {
  const { lifecycle, outcomes, id, cloudConfig, targetState } = args;
  const { workloadExitCode, exitMetadata } = args;

  if (!needsVmHostFinalSync(id, cloudConfig)) {
    const outcome = await outcomes.publishTerminalOutcome(
      id,
      targetState,
      WorkloadState.Running,
      { metadata: exitMetadata },
    );
    if (!outcome) {
      log.info('Job completion skipped — state changed concurrently', {
        id,
        attemptedState: targetState,
      });
      return;
    }
    await terminate(cloudConfig, id);
    return;
  }

  const finalizingMetadata = finalizationStateMetadata({
    exitMetadata,
    targetState,
    workloadExitCode,
    attempt: 0,
    maxAttempts: FINAL_SYNC_MAX_ATTEMPTS,
  });

  const finalizing = await lifecycle.updateState(id, WorkloadState.Finalizing, {
    metadata: finalizingMetadata,
  });
  if (!finalizing) {
    log.info('Finalization skipped — state changed concurrently', {
      id,
      attemptedState: WorkloadState.Finalizing,
    });
    return;
  }
}

export async function finalizeJobArtifacts(
  { store, lifecycle, outcomes, events }: CompletionPersistence,
  id: string,
  sshPrivateKey: string,
  cloudConfig: CloudConfig,
): Promise<void> {
  const workload = await store.getWorkload(id);
  if (!workload || workload.state !== WorkloadState.Finalizing) return;

  const latestMetadata = await events.getLatestFinalizationEventMetadata(id);
  const finalSync = parseFinalizationMetadata(latestMetadata?.metadata);
  if (!finalSync) {
    const outcome = await outcomes.publishTerminalOutcome(
      id,
      WorkloadState.Failed,
      WorkloadState.Finalizing,
      { metadata: { reason: 'final-bucket-sync-metadata-missing' } },
    );
    if (outcome) {
      await terminate(cloudConfig, id);
    }
    return;
  }

  const vms = await store.getVMs(id);
  if (vms.length === 0) {
    const outcome = await outcomes.publishTerminalOutcome(
      id,
      WorkloadState.Failed,
      WorkloadState.Finalizing,
      {
        metadata: finalizationStateMetadata(finalSync, finalSync.attempt, {
          reason: 'final-bucket-sync-vm-missing',
        }),
      },
    );
    if (outcome) {
      await terminate(cloudConfig, id);
    }
    return;
  }
  if (vms.length > 1) {
    throw new Error(`Job ${id} has ${vms.length} VMs, expected 1`);
  }

  const attempt = finalSync.attempt + 1;
  const syncMetadata = finalizationStateMetadata(finalSync, attempt);

  try {
    await syncFinalVmJobArtifacts(id, sshPrivateKey, cloudConfig, vms[0]);
  } catch (error) {
    const failureMetadata = {
      ...syncMetadata,
      reason: 'final-bucket-sync-failed',
      error: errorForDiagnosticMetadata(error),
    };
    if (attempt >= finalSync.maxAttempts) {
      const outcome = await outcomes.publishTerminalOutcome(
        id,
        WorkloadState.Failed,
        WorkloadState.Finalizing,
        { metadata: failureMetadata },
      );
      if (outcome) {
        await terminate(cloudConfig, id);
      }
      return;
    }

    await lifecycle.updateState(id, WorkloadState.Finalizing, {
      metadata: failureMetadata,
    });
    log.warn('Final bucket sync failed; will retry while VM remains live', {
      id,
      attempt,
      maxAttempts: finalSync.maxAttempts,
      error,
    });
    return;
  }

  const outcome = await outcomes.publishTerminalOutcome(
    id,
    finalSync.targetState,
    WorkloadState.Finalizing,
    {
      metadata: {
        ...finalSync.exitMetadata,
        workloadExitCode: finalSync.workloadExitCode,
        finalSyncAttempts: attempt,
      },
    },
  );
  if (!outcome) {
    log.info('Job completion skipped — state changed concurrently', {
      id,
      attemptedState: finalSync.targetState,
    });
    return;
  }

  await terminate(cloudConfig, id);
}

export async function checkJobCompletion(
  { store, lifecycle, outcomes, events }: CompletionPersistence,
  id: string,
  sshPrivateKey: string,
  cloudConfig: CloudConfig,
): Promise<void> {
  const workload = await store.getWorkload(id);
  if (!workload || workload.state !== WorkloadState.Running) return;

  const vms = await store.getVMs(id);
  if (vms.length === 0) {
    return;
  }
  if (vms.length > 1) {
    throw new Error(`Job ${id} has ${vms.length} VMs, expected 1`);
  }

  const vm = vms[0];
  const ip = vm.ip;
  // SSH endpoint may differ from ip:22 for provider NAT/sidecar mappings.
  const sshHost = vm.sshHost ?? ip;
  const sshPort = vm.sshPort;

  if (workload?.state !== WorkloadState.Running) {
    return;
  }

  const docker = new DockerManager(sshHost, sshPrivateKey, sshPort);
  const containerStatus = await docker.getContainerStatus(id);

  log.info('Container state check', {
    id,
    ip,
    state: containerStatus.state,
    exitCode: containerStatus.exitCode,
  });

  if (isContainerHealthy(containerStatus)) {
    // Container is running — clear any stale pending-exit entry so a future
    // genuine exit (e.g. after in-place recovery restarts the container) starts
    // a fresh confirmation window.
    pendingSpotExits.reset(id);
    return;
  }

  // NotFound (container removed) or Dead (Docker failed to remove it, so its
  // ExitCode can't be trusted) both mean the workload is gone — recover rather
  // than finalize on a bogus exit code.
  if (
    containerStatus.state === ContainerState.NotFound ||
    containerStatus.state === ContainerState.Dead
  ) {
    pendingSpotExits.reset(id);
    await lifecycle.claimRecovery(id, WorkloadState.Running, {
      metadata: { reason: `workload container ${containerStatus.state}` },
      vm: {
        cloudId: vm.cloudId,
        ip: vm.ip,
      },
    });
    return;
  }

  if (containerStatus.exitCode === undefined) {
    return; // unknown state, wait for next cycle
  }

  // Container has exited. For spot VMs we don't act immediately — some clouds
  // send SIGTERM before reclaiming the VM (AWS: up to ~2 min before actual
  // reclaim; Azure: nearly instant on deallocation). Acting right away would
  // race with preemption reconciliation and prevent recovery.
  //
  // Instead we let the reconciler's 30 s poll lane detect the preemption and
  // transition the workload out of Running. We only mark terminal once
  // SPOT_EXIT_CONFIRM_MS (5 cycles × 30 s = 150 s) have elapsed without
  // intervention. If preemption occurred the workload leaves Running before
  // the window expires, dropping it from the "running jobs" candidates;
  // pendingSpotExits is cleared when the recovered container becomes healthy
  // again.
  //
  // A clean exit of a Job that can't restart in place (`--max-retries 0`) is
  // final when, at its first sight, its host isn't shutting down and the VM's
  // metadata says it isn't being reclaimed: the grace would only delay its
  // end. A reclaim stops dockerd in the host's shutdown, so a container that
  // traps the SIGTERM and exits 0 finds systemd `stopping`, even when AWS's
  // best-effort notice is missing. Azure, any failed read, a later sight and a
  // non-zero exit keep the grace.
  const noticeCommand = spotNoReclaimNoticeCommand(cloudConfig.cloudProvider);
  const finalCleanExit =
    cloudConfig.spot &&
    noticeCommand !== undefined &&
    containerStatus.exitCode === 0 &&
    workload.maxRetries === 0 &&
    pendingSpotExits.observedAt(id) === undefined &&
    (await docker
      .execResult(noticeCommand, RECLAIM_NOTICE_TIMEOUT_MS)
      .then(({ stdout }) => stdout.trim() === 'no-notice')
      .catch(() => false));
  if (cloudConfig.spot && !finalCleanExit) {
    const firstSeen = pendingSpotExits.observedAt(id);
    if (firstSeen === undefined) {
      pendingSpotExits.markObserved(id);
      log.info(
        'Spot VM container exit observed — deferring to preemption reconciliation',
        {
          id,
          ip,
          exitCode: containerStatus.exitCode,
          confirmAfterMs: SPOT_EXIT_CONFIRM_MS,
        },
      );
      return;
    }
    const elapsed = pendingSpotExits.observedForMs(id) ?? 0;
    if (!pendingSpotExits.isMature(id, SPOT_EXIT_CONFIRM_MS)) {
      log.info('Spot VM container exit pending confirmation', {
        id,
        ip,
        exitCode: containerStatus.exitCode,
        elapsedMs: elapsed,
        confirmAfterMs: SPOT_EXIT_CONFIRM_MS,
      });
      return;
    }
    // Window elapsed with no preemption intervention — genuine job exit.
    pendingSpotExits.reset(id);
    log.info('Spot VM container exit confirmed as genuine', {
      id,
      ip,
      exitCode: containerStatus.exitCode,
    });
  }

  // The workload row keeps the request vmType (possibly a fallback list); use the
  // resolved cloudConfig to tell whether this was a GPU target, so a
  // missing-GPU exit retries only for GPU jobs (auto-defaulted or explicit --gpus).
  // Fixed CPU-only harnesses cannot recover a missing-GPU failure by selecting
  // replacement accelerator capacity.
  const gpuTarget =
    supportsAcceleratorFailureRetry(cloudConfig.cloudProvider) &&
    (!!workload?.dockerOptions?.gpus ||
      (typeof cloudConfig.vmType === 'string' &&
        isGPUVMType(cloudConfig.cloudProvider, cloudConfig.vmType)));
  // Resolved GPU runtime of THIS attempt's accelerator (truth, not the requested
  // type) — gates the ROCm missing-device patterns so they never fire on a CUDA job.
  const resolvedRuntime: GpuRuntime | null =
    typeof cloudConfig.vmType === 'string'
      ? gpuRuntimeForVMType(cloudConfig.cloudProvider, cloudConfig.vmType)
      : null;
  let newState = classifyJobExit(
    workload ?? null,
    { exitCode: containerStatus.exitCode, logs: containerStatus.logs },
    gpuTarget,
    resolvedRuntime,
  );
  const metadata: any = { ...containerStatus };
  if (newState === WorkloadState.Retrying) {
    const { state, ...evidence } = await confirmUnusableGpu(
      vm,
      sshPrivateKey,
      resolvedRuntime,
      containerStatus.logs,
      (await events.countFailureDiagnosis(id, GPU_RERUN_DIAGNOSIS)) > 0,
    );
    newState = state;
    Object.assign(metadata, evidence);
  }

  // Capture VM storage diagnostics when a failed workload has transfer work.
  const shouldCollectStorageDiagnostics =
    hasVmRuntimeStorage(cloudConfig) && newState === WorkloadState.Errored;

  if (shouldCollectStorageDiagnostics) {
    const storageDiagnostics = await captureVmStorageDiagnostics(
      vm,
      sshPrivateKey,
      id,
    );
    if (storageDiagnostics) {
      metadata.logs = metadata.logs
        ? `${metadata.logs}\n${storageDiagnostics}`
        : storageDiagnostics;
    }
  }

  if (newState === WorkloadState.Retrying) {
    metadata.diagnosis ??= UNUSABLE_GPU_DIAGNOSIS;
    await lifecycle.updateState(id, newState, { metadata });
    return;
  }

  if (
    newState !== WorkloadState.Completed &&
    newState !== WorkloadState.Errored
  ) {
    return;
  }

  await finishExitedJob({
    lifecycle,
    outcomes,
    id,
    cloudConfig,
    targetState: newState,
    workloadExitCode: containerStatus.exitCode,
    exitMetadata: metadata,
  });
}
