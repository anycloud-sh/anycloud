/**
 * Task runner with step-based execution.
 *
 * Each workload workflow is broken into steps that:
 * - Log start events to workload_events table (completion implicit from next step)
 * - Transition to Failed on error
 */

import { getWorkloadLifecycle, getWorkloadOutcomes } from './persistence.js';
import { WorkloadState, isTerminalState } from '../../shared/workload.js';
import { ContainerStatus } from '../../shared/runtime.js';
import { TimeoutError, withTimeout } from '../../shared/utils.js';
import { isUserError } from '../../shared/error-formatter.js';
import {
  FailureDisposition,
  type StepFailureClassification,
  classifyStepFailure,
} from './provisioning-failure.js';
import { CloudFailureDiagnosis } from '../../shared/cloud.js';
import { PartialVMCreationError, VMCreationError } from './codes.js';
import { ResourceStateIndeterminateError } from '../../shared/errors.js';
import { log } from './logger.js';
import { trackWorkloadWork } from './workload-work-registry.js';
import {
  errorForDiagnosticMetadata,
  MAX_PERSISTED_ERROR_MESSAGE_CHARS,
  type PersistedError,
} from '../../shared/log-diagnostics.js';
import type { WorkloadEventMetadataInput } from './workload-event-metadata.js';

// ============================================================================
// Container Exit Error
// ============================================================================

/**
 * Error thrown when container exits, carrying structured metadata.
 * runStep will use metadata directly instead of just error.message.
 */
export class ContainerExitError extends Error {
  constructor(
    message: string,
    public readonly metadata: ContainerStatus,
  ) {
    super(message);
    this.name = 'ContainerExitError';
  }
}

/**
 * Error thrown when a step cannot start because the FSM blocked the transition.
 * Another actor (termination, preemption recovery, etc.) already moved the
 * workload to a different state. No action needed — the other actor owns it.
 */
export class StateConflictError extends Error {
  constructor(id: string, targetState: WorkloadState) {
    super(
      `Workload ${id}: lost race to transition to ${targetState}, skipping — another actor owns this workload`,
    );
    this.name = 'StateConflictError';
  }
}

// ============================================================================
// Step Execution
// ============================================================================

interface RunStepOptions<T> {
  id: string;
  step: WorkloadState;
  fn: (eventId: number) => Promise<T>;
  /** Use null for work whose valid duration is data-dependent and has its own
   * failure policy (for example, hydrating an arbitrarily large input bucket). */
  timeoutMs: number | null;
  onErrorState: WorkloadState;
  onSuccessState?: WorkloadState;
  onError?: (error: Error) => Promise<void>;
  /** Durable failure bookkeeping, awaited before the failure state transition
   * even when a timeout defers `onError`. A throw is logged, never raised. */
  recordFailure?: () => Promise<void>;
  startMetadata?: WorkloadEventMetadataInput;
  /** Classify cloud SDK errors into a diagnosis plus scheduler disposition. */
  classifyError?: (
    error: unknown,
  ) => StepFailureClassification | CloudFailureDiagnosis;
}

function normalizeFailureClassification(
  classification: StepFailureClassification | CloudFailureDiagnosis,
): StepFailureClassification {
  if (typeof classification === 'string') {
    return classifyStepFailure(classification);
  }
  return classification;
}

function stateForDisposition(
  disposition: FailureDisposition,
  onErrorState: WorkloadState,
): WorkloadState {
  switch (disposition) {
    case FailureDisposition.TerminalInvalid:
      return WorkloadState.Invalid;
    case FailureDisposition.TerminalFailed:
      return WorkloadState.Failed;
    case FailureDisposition.FailoverTarget:
    case FailureDisposition.RetrySameTarget:
      return onErrorState;
    default:
      disposition satisfies never;
      return onErrorState;
  }
}

/**
 * VM creation wrappers retain the raw provider error for classification and
 * cleanup. Do not copy that SDK request/response graph into workload events.
 * Other Error types keep their existing structured diagnostic fields.
 */
function errorForWorkloadEvent(error: unknown): PersistedError | string {
  if (
    error instanceof VMCreationError ||
    error instanceof PartialVMCreationError
  ) {
    const fields: Record<string, unknown> = { ...error };
    delete fields.originalError;
    // The provider's status, not the wrapper's 500. Its code is left out: the
    // CLI would replace the provider's detailed message with a stock line.
    const provider: Record<string, unknown> = { ...error.originalError };
    return {
      ...fields,
      statusCode: provider.statusCode ?? fields.statusCode,
      message: error.message.slice(0, MAX_PERSISTED_ERROR_MESSAGE_CHARS),
    };
  }
  // Allow-list, not deny-list. A serializer that copies everything and then
  // strips the known-bad keys leaks again the moment an error class arrives
  // carrying a field nobody thought to strip; this copies only what it was
  // asked for, so a stack, a container status, or a future image manifest
  // cannot reach the row at all.
  return errorForDiagnosticMetadata(error);
}

/** The state transitions a step runner claims and publishes. */
interface StepTransitions {
  claimStep(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<number | null>;
  updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

interface StepOutcomes {
  publishTerminalOutcome(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

/**
 * Run a step with logging.
 * Logs start event, transitions to onErrorState on error.
 * Optionally transitions to onSuccessState on success.
 */
export async function runStep<T>(opts: RunStepOptions<T>): Promise<T> {
  const {
    id,
    step,
    fn,
    timeoutMs,
    onErrorState,
    onSuccessState,
    onError,
    recordFailure,
    startMetadata,
    classifyError,
  } = opts;
  const lifecycle: StepTransitions = getWorkloadLifecycle();
  const outcomes: StepOutcomes = getWorkloadOutcomes();

  // Log step start — bail if FSM blocks (workload was claimed by another actor)
  const eventId = await lifecycle.claimStep(
    id,
    step,
    startMetadata ? { metadata: startMetadata } : undefined,
  );
  if (eventId === null) {
    throw new StateConflictError(id, step);
  }

  let rawOperation: Promise<T> | undefined;
  let operationSettled = false;

  try {
    // Invoke the step exactly once and register the raw promise before giving
    // the foreground wait a deadline. withTimeout cannot cancel this work.
    rawOperation = fn(eventId);
    trackWorkloadWork(id, rawOperation);
    void rawOperation.then(
      () => {
        operationSettled = true;
      },
      () => {
        operationSettled = true;
      },
    );

    const result =
      timeoutMs === null
        ? await rawOperation
        : await withTimeout(rawOperation, timeoutMs, step);

    // Transition to success state if provided
    if (onSuccessState && onSuccessState !== step) {
      await lifecycle.updateState(id, onSuccessState);
    }

    return result;
  } catch (error) {
    // The provider may already contain the resource behind this durable
    // attempt. Keep the active step unchanged so reconciliation can retry the
    // observation instead of routing through destructive retry cleanup.
    if (
      error instanceof ResourceStateIndeterminateError ||
      error instanceof StateConflictError
    ) {
      throw error;
    }

    const runErrorCallback = async () => {
      if (!onError) return;
      try {
        await onError(error as Error);
      } catch (callbackError) {
        // Log callback errors but don't override original error
        // Original error is more important for debugging root cause
        console.error('Error callback failed:', callbackError);
      }
    };

    // Application/user errors are authoritative even when a step also has a
    // provider classifier. Classification controls state routing and metadata;
    // error callbacks run below, after any terminal outcome is durable.
    //
    // Otherwise classify cloud SDK errors into a diagnosis plus disposition.
    // The diagnosis is preserved in metadata; disposition decides whether this
    // step retries, failovers, or terminates.
    //
    // VMCreationError / PartialVMCreationError wrap the original cloud SDK error,
    // stripping the code/Code properties that classifyError needs. Unwrap to the
    // originalError before checking domain errors too: the wrapper's 500 status
    // must not turn a terminal configuration error into a retry.
    const classifiable =
      error instanceof VMCreationError ||
      error instanceof PartialVMCreationError
        ? error.originalError
        : error;
    let failure: StepFailureClassification | undefined;
    if (isUserError(error) || isUserError(classifiable)) {
      failure = classifyStepFailure(
        CloudFailureDiagnosis.InvalidRequest,
        FailureDisposition.TerminalInvalid,
      );
    } else if (classifyError) {
      failure = normalizeFailureClassification(classifyError(classifiable));
    }

    // User-input errors (invalid bucket name, etc.) go to Invalid — never retried.
    // Infrastructure errors use the caller's onErrorState (usually Retrying).
    // The state CAS prevents detached work from overwriting a concurrent
    // transition.
    const effectiveErrorState = failure
      ? stateForDisposition(failure.disposition, onErrorState)
      : isUserError(error)
        ? WorkloadState.Invalid
        : onErrorState;

    const failureMetadata = {
      error: errorForWorkloadEvent(error),
      // A container that dies during a step carries its own account of why —
      // exit code, OOM kill, log tail. That detail adds to the standard shape
      // rather than replacing it: replacing it dropped the message and the
      // classification, leaving a workload cycling through Retrying with
      // nothing an operator could read.
      ...(error instanceof ContainerExitError ? error.metadata : {}),
      ...(failure && {
        diagnosis: failure.diagnosis,
        disposition: failure.disposition,
        // Backward-compatible key for old status/log consumers.
        errorKind: failure.diagnosis,
        ...failure.metadata,
      }),
    };

    const handleErrorCallback = async () => {
      // When the deadline wins, do not let destructive error handling race the
      // abandoned operation, including its cleanup callback.
      if (error instanceof TimeoutError && rawOperation && !operationSettled) {
        const delayedErrorHandling = rawOperation
          .then(
            () => undefined,
            (lateError) => {
              log.warn('Workload step rejected after its timeout', {
                id,
                step,
                error: lateError,
              });
            },
          )
          .then(runErrorCallback);
        trackWorkloadWork(id, delayedErrorHandling);
      } else {
        await runErrorCallback();
      }
    };

    if (recordFailure) {
      await recordFailure().catch((recordError: unknown) => {
        log.error('Failed to record step failure', {
          id,
          step,
          error: recordError,
        });
      });
    }

    if (isTerminalState(effectiveErrorState)) {
      const outcome = await outcomes.publishTerminalOutcome(
        id,
        effectiveErrorState,
        step,
        { metadata: { ...failureMetadata } },
      );
      if (outcome) await handleErrorCallback();
    } else {
      // Publish retry state only after step-local failure bookkeeping. The
      // reconciler owns provider teardown before it launches another attempt.
      await handleErrorCallback();
      await lifecycle.updateState(id, effectiveErrorState, {
        metadata: failureMetadata,
      });
    }
    throw error;
  }
}

// ============================================================================
// Background Execution
// ============================================================================

/**
 * Fire and forget - execute without awaiting.
 * Errors are expected to be handled internally (e.g., via runStep).
 * This just prevents unhandled rejection warnings.
 */
export function fireAndForget(promise: Promise<void>): void {
  promise.catch(() => {});
}
