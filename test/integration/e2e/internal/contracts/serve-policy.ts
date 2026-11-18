import type { Environment } from '../environment.js';
import type { ServeStageBudget } from './serve.js';

export interface ServeContractPolicy {
  readonly cleanupTimeoutMs: number;
  /** How long the published endpoint has to answer once Running is recorded. */
  readonly endpointTimeoutMs: number;
  readonly image: string;
  readonly runningTimeoutMs: number;
  /** Replacing backing capacity adds a teardown to the provisioning wait. */
  readonly upgradeTimeoutMs: number;
}

/**
 * Reads the same budgets as the Bash leg so the two implementations cannot be
 * tuned apart while both run the target in CI.
 */
export function serveContractPolicy(
  environment: Pick<Environment, 'milliseconds' | 'optional'>,
): ServeContractPolicy {
  return {
    cleanupTimeoutMs: environment.milliseconds(
      'SERVE_SMOKE_CLEANUP_TIMEOUT_SECONDS',
      2_700,
    ),
    endpointTimeoutMs: environment.milliseconds(
      'SERVE_HTTP_TIMEOUT_SECONDS',
      300,
    ),
    image: environment.optional('SERVE_SMOKE_IMAGE', 'python:3.12-alpine'),
    runningTimeoutMs: environment.milliseconds(
      'SERVE_SMOKE_RUNNING_TIMEOUT_SECONDS',
      1_200,
    ),
    upgradeTimeoutMs: environment.milliseconds(
      'SERVE_UPGRADE_RUNNING_TIMEOUT_SECONDS',
      1_800,
    ),
  };
}

/** The budget a member spends provisioning and terminating one Service. */
export function serveStageBudget(
  policy: ServeContractPolicy,
  runningMs: number = policy.runningTimeoutMs,
): ServeStageBudget {
  return {
    cleanupMs: policy.cleanupTimeoutMs,
    endpointMs: policy.endpointTimeoutMs,
    runningMs,
  };
}

/**
 * The Local substrate boots a microVM on the developer's own machine, so its
 * budgets are unrelated to the cloud ones and must not be tuned with them.
 * `checkpointTimeoutMs` bounds the window in which the workload is already
 * serving but the control plane has not yet recorded `Running` — the only
 * window in which the restart fault proves anything.
 */
export interface ServeLocalRecoveryPolicy extends ServeContractPolicy {
  readonly checkpointTimeoutMs: number;
}

export function serveLocalRecoveryPolicy(
  environment: Pick<Environment, 'milliseconds' | 'optional'>,
): ServeLocalRecoveryPolicy {
  return {
    checkpointTimeoutMs: environment.milliseconds(
      'LOCAL_SERVE_CHECKPOINT_TIMEOUT_SECONDS',
      300,
    ),
    cleanupTimeoutMs: environment.milliseconds(
      'LOCAL_SERVE_CLEANUP_TIMEOUT_SECONDS',
      300,
    ),
    endpointTimeoutMs: environment.milliseconds(
      'LOCAL_SERVE_HTTP_TIMEOUT_SECONDS',
      120,
    ),
    image: environment.optional('LOCAL_SERVE_IMAGE', 'busybox:1.36'),
    runningTimeoutMs: environment.milliseconds(
      'LOCAL_SERVE_RUNNING_TIMEOUT_SECONDS',
      600,
    ),
    upgradeTimeoutMs: environment.milliseconds(
      'LOCAL_SERVE_UPGRADE_TIMEOUT_SECONDS',
      600,
    ),
  };
}
