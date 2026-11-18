/**
 * API-specific error classes and constants.
 * Shared error classes live in src/shared/errors.ts.
 */

import { DeployError } from '../../shared/errors.js';

export class PartialVMCreationError extends DeployError {
  readonly partialVMs: any[];
  readonly originalError: Error;

  constructor(originalError: Error, partialVMs: any[]) {
    super(originalError.message, 500);
    this.originalError = originalError;
    this.partialVMs = partialVMs;
  }
}

export class VMCreationError extends DeployError {
  /**
   * Cleanup targets retained from the failed creation. Usually these are the
   * orchestrator's attempted VM names; a gateway that received a provider ID
   * before a later readiness failure may supply that real ID instead.
   */
  readonly attemptedVmIds: string[];
  readonly originalError: Error;

  constructor(originalError: Error, attemptedVmIds: string[]) {
    super(originalError.message, 500);
    this.originalError = originalError;
    this.attemptedVmIds = attemptedVmIds;
  }
}

export enum WORKLOAD_ACTION {
  STARTING = 'starting',
  TERMINATING = 'terminating',
}
