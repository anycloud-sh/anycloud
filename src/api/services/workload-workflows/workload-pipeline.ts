/**
 * Dispatch and active-pipeline recovery: prepare the durable launch context,
 * select the runtime, distinguish defer/retry/no-op, register ownership before
 * preparation, and hand scheduler capacity back separately from completion.
 */

import { log } from '../logger.js';
import type { VMRow } from '../repositories/provisioning-attempts.js';
import { loadWorkloadConfigs } from '../cloud-config.js';
import { getDefaultServeRuntime } from '../serve/default-runtime.js';
import { getDefaultJobRuntime } from '../job/default-runtime.js';
import {
  errorForDiagnosticMetadata,
  errorMessage,
} from '../../../shared/log-diagnostics.js';
import { isUserError } from '../../../shared/error-formatter.js';
import { ResourceStateIndeterminateError } from '../../../shared/errors.js';
import { StateConflictError } from '../task.js';
import type { ProvisioningIntent, StoredWorkload } from '../workload-record.js';
import type { CloudConfig } from '../../../shared/cloud.js';
import {
  type DeployPipelineState,
  WorkloadState,
  WorkloadType,
  isDeployPipelineState,
} from '../../../shared/workload.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
} from '../workload-work-registry.js';
import type { DbVM, ProvisioningAttemptRef } from '../entities.js';
import type { WorkloadEventMetadataInput } from '../workload-event-metadata.js';

/** The workload, live-VM and credential reads the pipeline prepares from. */
interface PipelineStore {
  getWorkload(workloadId: string): Promise<StoredWorkload | null>;
  getVMs(workloadId: string): Promise<DbVM[]>;
  resolveActiveCredentialId(
    workload: StoredWorkload,
    computeCredIdOverride?: string,
  ): Promise<string | undefined>;
}
/** The unresolved provider attempts a Provisioning replay may adopt. */
interface PipelineAttempts {
  getUnresolvedProvisioningAttempts(workloadId: string): Promise<VMRow[]>;
}
/** The placement intent that bridges admission to attempt registration. */
interface PipelineEvents {
  getLatestProvisioningIntent(
    workloadId: string,
  ): Promise<ProvisioningIntent | null>;
}
/** The durable transitions dispatch and pipeline recovery publish. */
interface PipelineLifecycle {
  releaseEmptyProvisioningAdmission(workloadId: string): Promise<boolean>;
  updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}
/** The terminal outcomes dispatch and pipeline recovery publish. */
interface PipelineOutcomes {
  publishTerminalOutcome(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}
/**
 * The reconciler wake-ups the pipeline requests. The reconciler's
 * active-recovery work runs this pipeline, so composition passes it in rather
 * than the pipeline importing it.
 */
interface PipelineReconciler {
  deferActiveRecovery(workloadId: string): Promise<boolean>;
  enqueueCleanupNow(workloadId: string): Promise<boolean>;
  enqueueImmediateRetryNow(workloadId: string): Promise<boolean>;
}
export interface WorkloadPipelineDeps {
  store: PipelineStore;
  attempts: PipelineAttempts;
  events: PipelineEvents;
  lifecycle: PipelineLifecycle;
  outcomes: PipelineOutcomes;
  reconciler: PipelineReconciler;
  /** The API's own network check, cached and shared with the monitor's polls. */
  networkAvailable(): Promise<boolean>;
}

function provisioningAttemptRef(
  workloadId: string,
  attempt: VMRow,
): ProvisioningAttemptRef | null {
  if (!attempt.cloud_id.startsWith(`${workloadId}-`)) return null;
  const suffix = attempt.cloud_id.slice(workloadId.length + 1);
  if (!/^\d+$/.test(suffix)) return null;
  return {
    vmRowId: attempt.id,
    cloudId: attempt.cloud_id,
    createdAt: attempt.created_at,
  };
}

function provisioningAttemptPlacementMismatch(
  attempt: VMRow,
  cloudConfig: CloudConfig,
  credentialId: string | undefined,
): string | null {
  const expectedCredentialId = credentialId ?? null;
  if (attempt.credential_id !== expectedCredentialId) {
    return `credential ${attempt.credential_id ?? '<none>'} does not match ${expectedCredentialId ?? '<none>'}`;
  }

  const expectedRegion = cloudConfig.region ?? null;
  if ((attempt.region ?? null) !== expectedRegion) {
    return `region ${attempt.region ?? '<none>'} does not match ${expectedRegion ?? '<none>'}`;
  }

  const expectedVmType = Array.isArray(cloudConfig.vmType)
    ? cloudConfig.vmType[0]
    : (cloudConfig.vmType ?? null);
  if (attempt.vm_type !== expectedVmType) {
    return `VM type ${attempt.vm_type ?? '<none>'} does not match ${expectedVmType ?? '<none>'}`;
  }
  return null;
}

async function moveActivePipelineToRetry(
  lifecycle: PipelineLifecycle,
  id: string,
  state: WorkloadState,
  reason = `could not reconcile active ${state} step`,
  error?: unknown,
): Promise<void> {
  try {
    const transitioned = await lifecycle.updateState(
      id,
      WorkloadState.Retrying,
      {
        metadata: {
          reason,
          ...(error !== undefined
            ? { error: errorForDiagnosticMetadata(error) }
            : {}),
        },
      },
    );
    if (!transitioned) return;

    log.info('Active workload moved to Retrying', { id, state, reason });
  } catch (error) {
    log.error('Failed to move active workload to retry recovery', {
      id,
      state,
      error: error,
    });
  }
}

interface WorkloadPipelinePlan {
  workload: StoredWorkload;
  state: DeployPipelineState;
  cloudConfig: CloudConfig;
  credentialId?: string;
  existingAttempt?: ProvisioningAttemptRef;
}

type WorkloadPipelineOutcome =
  | { kind: 'defer'; reason: string; error?: unknown }
  | { kind: 'retry'; reason?: string; error?: unknown };

type WorkloadPipelinePreparation =
  | ({ kind: 'launch' } & WorkloadPipelinePlan)
  | WorkloadPipelineOutcome
  | { kind: 'noop' };

function applyProvisioningIntent(
  cloudConfig: CloudConfig,
  intent: ProvisioningIntent,
): string | null {
  if (cloudConfig.cloudProvider !== intent.cloudProvider) {
    return `resolved provider ${cloudConfig.cloudProvider} does not match durable provisioning intent ${intent.cloudProvider}`;
  }
  if (intent.region) cloudConfig.region = intent.region;
  if (intent.vmType) cloudConfig.vmType = intent.vmType;
  cloudConfig.availabilityZone = intent.availabilityZone ?? undefined;
  return null;
}

async function prepareWorkloadPipeline(
  deps: WorkloadPipelineDeps,
  workloadId: string,
): Promise<WorkloadPipelinePreparation> {
  const { store, attempts, events, lifecycle, networkAvailable } = deps;
  const workload = await store.getWorkload(workloadId);
  if (!workload || !isDeployPipelineState(workload.state)) {
    return { kind: 'noop' };
  }
  const state = workload.state;
  const [liveVMs, unresolvedAttempts, provisioningIntent] = await Promise.all([
    store.getVMs(workloadId),
    state === WorkloadState.Provisioning
      ? attempts.getUnresolvedProvisioningAttempts(workloadId)
      : Promise.resolve([]),
    state === WorkloadState.Provisioning
      ? events.getLatestProvisioningIntent(workloadId)
      : Promise.resolve(null),
  ]);

  if (
    state === WorkloadState.Provisioning &&
    liveVMs.length === 0 &&
    unresolvedAttempts.length === 0 &&
    !provisioningIntent
  ) {
    // Compatibility for admissions created before durable placement intents:
    // no provider work can have started, so let the canonical scheduler create
    // a fully reconstructible admission.
    const released =
      await lifecycle.releaseEmptyProvisioningAdmission(workloadId);
    if (released) {
      log.info('Released legacy empty provisioning admission', {
        id: workloadId,
      });
    }
    return { kind: 'noop' };
  }

  if (state !== WorkloadState.Provisioning && liveVMs.length !== 1) {
    const reason =
      liveVMs.length === 0
        ? `cannot reconcile ${state}: no live VM`
        : `cannot reconcile ${state}: ambiguous live VM count ${liveVMs.length}`;
    return { kind: 'retry', reason };
  }

  if (
    state === WorkloadState.Provisioning &&
    (unresolvedAttempts.length > 1 ||
      liveVMs.length > 1 ||
      (unresolvedAttempts.length > 0 && liveVMs.length > 0))
  ) {
    return {
      kind: 'retry',
      reason: `cannot reconcile provisioning: ${unresolvedAttempts.length} unresolved and ${liveVMs.length} live attempts`,
    };
  }

  const unresolvedAttempt = unresolvedAttempts[0];
  const existingAttempt = unresolvedAttempt
    ? (provisioningAttemptRef(workloadId, unresolvedAttempt) ?? undefined)
    : undefined;
  if (unresolvedAttempt && !existingAttempt) {
    return {
      kind: 'retry',
      reason: `cannot replay unresolved provider resource ${unresolvedAttempt.cloud_id}`,
    };
  }

  const placementCredentialId =
    unresolvedAttempt?.credential_id ??
    liveVMs[0]?.credentialId ??
    provisioningIntent?.credentialId;
  const credentialId = await store.resolveActiveCredentialId(
    workload,
    placementCredentialId ?? undefined,
  );
  const cloudConfig = await loadWorkloadConfigs(workload, credentialId);
  if (!cloudConfig) {
    return {
      kind: 'defer',
      reason: `credentials missing while preparing active ${state} pipeline`,
    };
  }
  // The event intent exists only to bridge admission → attempt registration.
  // Once a ledger row exists, loadWorkloadConfigs has already reconstructed
  // the authoritative placement from that row.
  if (provisioningIntent && !unresolvedAttempt && liveVMs.length === 0) {
    const mismatch = applyProvisioningIntent(cloudConfig, provisioningIntent);
    if (mismatch) return { kind: 'retry', reason: mismatch };
  }

  if (unresolvedAttempt) {
    const mismatch = provisioningAttemptPlacementMismatch(
      unresolvedAttempt,
      cloudConfig,
      credentialId,
    );
    if (mismatch) {
      return {
        kind: 'retry',
        reason: `cannot adopt unresolved provisioning attempt: ${mismatch}`,
      };
    }
  }

  if (credentialId && !(await networkAvailable())) {
    return {
      kind: 'defer',
      reason: `network unavailable while preparing active ${state} pipeline`,
    };
  }

  return {
    kind: 'launch',
    workload,
    state,
    cloudConfig,
    ...(credentialId ? { credentialId } : {}),
    ...(existingAttempt ? { existingAttempt } : {}),
  };
}

function launchWorkloadPipeline(plan: WorkloadPipelinePlan): Promise<void> {
  const options = {
    resumeFrom: plan.state,
    replayActiveStep: true,
    ...(plan.existingAttempt ? { existingAttempt: plan.existingAttempt } : {}),
  };
  if (plan.workload.workloadType === WorkloadType.Service) {
    return getDefaultServeRuntime().deploy({
      workload: plan.workload,
      placement: {
        cloudConfig: plan.cloudConfig,
        selectedCredentialId: plan.credentialId,
      },
      ...options,
    });
  }
  return getDefaultJobRuntime().deploy({
    workload: plan.workload,
    placement: {
      cloudConfig: plan.cloudConfig,
      selectedCredentialId: plan.credentialId,
    },
    ...options,
  });
}

async function applyWorkloadPipelineOutcome(
  { store, lifecycle, outcomes, reconciler }: WorkloadPipelineDeps,
  workloadId: string,
  outcome: WorkloadPipelineOutcome,
): Promise<void> {
  try {
    const current = await store.getWorkload(workloadId);
    if (!current || !isDeployPipelineState(current.state)) return;

    if (outcome.kind === 'defer') {
      log.warn('Workload pipeline observation deferred', {
        id: workloadId,
        state: current.state,
        error:
          outcome.error instanceof Error
            ? outcome.error.message
            : outcome.reason,
      });
      await reconciler.deferActiveRecovery(workloadId);
      return;
    }

    const reason =
      outcome.reason ?? `could not replay active ${current.state} step`;

    // runStep applies this rule inside the VM lifecycle, publishing the same
    // error-only metadata. Runtimes it does not wrap — the Kubernetes Serve
    // runtime — reach a terminal outcome only here, so a user-input error would
    // otherwise burn the whole retry budget. Every deploy-pipeline state is a
    // valid source for Invalid, so a rejected publish means another actor moved
    // first; retry recovery then decides.
    if (isUserError(outcome.error)) {
      const error = errorForDiagnosticMetadata(outcome.error);
      if (
        await outcomes.publishTerminalOutcome(
          workloadId,
          WorkloadState.Invalid,
          current.state,
          { metadata: { error } },
        )
      ) {
        log.warn('Workload pipeline rejected as invalid', {
          id: workloadId,
          state: current.state,
          error,
        });
        return;
      }
    }

    if (outcome.error !== undefined) {
      log.warn('Workload pipeline failed; falling back to retry recovery', {
        id: workloadId,
        state: current.state,
        error: errorMessage(outcome.error),
      });
    }
    await moveActivePipelineToRetry(
      lifecycle,
      workloadId,
      current.state,
      reason,
      outcome.error,
    );
  } catch (error) {
    log.warn('Failed to apply workload pipeline outcome', {
      id: workloadId,
      error: error,
    });
  }
}

function workloadPipelineFailureOutcome(
  error: unknown,
): WorkloadPipelineOutcome {
  return error instanceof ResourceStateIndeterminateError ||
    error instanceof StateConflictError
    ? { kind: 'defer', reason: error.message, error }
    : { kind: 'retry', error };
}

async function runWorkloadPipeline(
  deps: WorkloadPipelineDeps,
  workloadId: string,
  handoff: () => void,
): Promise<void> {
  try {
    let prepared: WorkloadPipelinePreparation;
    try {
      prepared = await prepareWorkloadPipeline(deps, workloadId);
    } catch (error) {
      await applyWorkloadPipelineOutcome(deps, workloadId, {
        kind: 'defer',
        reason: `could not prepare workload pipeline: ${errorMessage(error)}`,
        error,
      });
      return;
    }

    if (prepared.kind === 'noop') return;
    if (prepared.kind !== 'launch') {
      await applyWorkloadPipelineOutcome(deps, workloadId, prepared);
      return;
    }

    try {
      const completion = launchWorkloadPipeline(prepared);
      handoff();
      await completion;
    } catch (error) {
      await applyWorkloadPipelineOutcome(
        deps,
        workloadId,
        workloadPipelineFailureOutcome(error),
      );
      // The step, or the outcome handler above, may have published a terminal
      // Invalid/Failed outcome. Wake its first cleanup immediately; a retry
      // that needs no backoff starts at once too. Other rows return false.
      await deps.reconciler.enqueueCleanupNow(workloadId);
      await deps.reconciler.enqueueImmediateRetryNow(workloadId);
    }
  } finally {
    // Non-launch decisions hand back reconciler/scheduler capacity only after
    // their durable outcome has been applied. Runtime launches hand off above.
    handoff();
  }
}

/**
 * The sole entrypoint for fresh dispatch and restart recovery. The pipeline
 * itself shares the process-local work registry with its child operations;
 * durable state still owns admission and restart recovery.
 */
export async function wakeWorkloadPipeline(
  deps: WorkloadPipelineDeps,
  workloadId: string,
): Promise<void> {
  if (hasWorkloadWork(workloadId)) return;

  let resolveHandoff!: () => void;
  const handedOff = new Promise<void>((resolve) => {
    resolveHandoff = resolve;
  });

  // Defer the runner by one microtask so it is registered before preparation
  // begins. Child operations register themselves against the same workload,
  // so the in-flight guard outlives this entry without any separate drain.
  const pipeline = Promise.resolve().then(() =>
    runWorkloadPipeline(deps, workloadId, resolveHandoff),
  );
  trackWorkloadWork(workloadId, pipeline);
  void pipeline.catch((error) => {
    log.error('Workload pipeline runner failed', {
      id: workloadId,
      error: error,
    });
  });
  await handedOff;
}
