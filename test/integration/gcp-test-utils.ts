/**
 * Shared test utilities for GCP integration tests
 */
import { expect } from 'vitest';
import { GCP } from '../../src/api/services/gateways/gcp';

/**
 * Helper to verify VM and associated resources are deleted
 */
export async function ensureVMTerminated(gcp: GCP, vmId: string) {
  // Get all VMs and check if this one exists
  const vms = await gcp.compute().getAllVMs();
  const foundVM = vms.find((vm) => vm.cloudId === vmId);

  if (foundVM) {
    expect.fail(`VM ${vmId} should be terminated but was found`);
  }

  // Success: VM not found (terminated)
}
