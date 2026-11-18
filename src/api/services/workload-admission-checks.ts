/**
 * Workload admission checks: workload ID format and uniqueness, and credential
 * validation with a lightweight provider call.
 */

import { getWorkloadQueryStore } from './persistence.js';
import {
  canClassifyTerminalAuthError,
  CloudCompute,
} from './gateways/cloud.js';
import { CloudConfig, CloudFailureDiagnosis } from '../../shared/cloud.js';
import { createComputeProvider } from './cloud-config.js';
import { requiresComputeCredentials } from '../../shared/cloud-config.js';
import {
  InvalidAnycloudConfigError,
  InvalidWorkloadIdError,
  WorkloadIdExistsError,
} from '../../shared/errors.js';
import { log } from './logger.js';
import { sleep } from '../../shared/utils.js';
import { workloadIdProblem } from '../../shared/workload-id.js';

/** Validate workload ID format and uniqueness. */
export async function validateId(id: string): Promise<string> {
  const problem = workloadIdProblem(id);
  if (problem) {
    throw new InvalidWorkloadIdError(id, problem);
  }
  const exists = await getWorkloadQueryStore().workloadExists(id);
  if (exists) {
    throw new WorkloadIdExistsError();
  }
  return id;
}

/**
 * Validate credentials by making a lightweight API call.
 * Wrapped with retry to handle network-level failures (DNS, connection refused, etc.)
 * that cloud provider clients may not retry automatically.
 */
export async function validateCredentials(
  cloudConfig: CloudConfig,
): Promise<CloudCompute> {
  const compute = createComputeProvider(cloudConfig);
  if (!requiresComputeCredentials(cloudConfig.cloudProvider)) {
    await compute.validateCredentials();
    return compute;
  }
  try {
    const standardMaxAttempts = 3;
    const standardWaitMs = 2_000;
    const recovery = compute.credentialValidationRetryPolicy;
    const overallMaxAttempts = Math.max(
      standardMaxAttempts,
      recovery?.maxAttempts ?? standardMaxAttempts,
    );
    for (let attempt = 1; attempt <= overallMaxAttempts; attempt += 1) {
      try {
        await compute.validateCredentials();
        break;
      } catch (error) {
        const usesRecovery = recovery?.shouldRetry(error) === true;
        const diagnosis =
          error instanceof InvalidAnycloudConfigError
            ? CloudFailureDiagnosis.InvalidRequest
            : compute.classifyError(error);
        const isDeterministicFailure =
          error instanceof InvalidAnycloudConfigError ||
          diagnosis === CloudFailureDiagnosis.InvalidRequest ||
          diagnosis === CloudFailureDiagnosis.PermissionDenied ||
          (diagnosis === CloudFailureDiagnosis.BadCredential &&
            canClassifyTerminalAuthError(compute) &&
            compute.isTerminalAuthError(error));
        // A provider recovery policy owns known propagation windows. Outside
        // that window, deterministic input and terminal-secret failures cannot
        // improve by repeating the same request.
        if (!usesRecovery && isDeterministicFailure) throw error;
        const failureMaxAttempts = usesRecovery
          ? recovery.maxAttempts
          : standardMaxAttempts;
        if (attempt >= failureMaxAttempts) throw error;

        log.info(
          `Retrying credential validation for ${compute.type} (${attempt}/${failureMaxAttempts})...`,
        );
        if (usesRecovery) {
          recovery.beforeRetry?.(error, attempt, failureMaxAttempts);
        }
        const exponentialBackoff =
          usesRecovery && (recovery.exponentialBackoff ?? true);
        const baseWaitMs = usesRecovery ? recovery.waitMs : standardWaitMs;
        const waitMs = exponentialBackoff
          ? baseWaitMs * Math.pow(2, attempt - 1)
          : baseWaitMs;
        const cappedWaitMs = Math.min(
          waitMs,
          usesRecovery ? (recovery.maxWaitMs ?? Infinity) : waitMs,
        );
        await sleep(usesRecovery ? cappedWaitMs : cappedWaitMs * Math.random());
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      const contextualMessage = `Invalid ${compute.type} credentials for region ${compute.region}: ${error.message}`;
      try {
        error.message = contextualMessage;
      } catch {
        // DOMException.message is getter-only in Node. Keep the original as a
        // cause so transport classifiers can still inspect its TimeoutError
        // name without replacing it with the assignment TypeError.
        const contextualError = new Error(contextualMessage);
        Object.defineProperty(contextualError, 'cause', {
          value: error,
          configurable: true,
          writable: true,
        });
        throw contextualError;
      }
    }
    throw error;
  }
  // Return the validated compute provider so callers can reuse it for compute
  // checks instead of constructing a second one.
  return compute;
}
