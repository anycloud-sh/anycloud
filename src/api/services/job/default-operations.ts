import type { JobOperations } from './operations.js';
import { createVmHostJobOperations } from './vm-host-operations.js';

let defaultVmHostOperations: JobOperations | undefined;

/**
 * Operational transport for any workload: every Job, Service and VM runs on
 * a VM host. Routes select transport through here so that rule lives in one
 * place.
 */
export function getDefaultWorkloadOperations(): JobOperations {
  defaultVmHostOperations ??= createVmHostJobOperations();
  return defaultVmHostOperations;
}
