/**
 * Shared test utilities for Azure integration tests
 */
import { expect } from 'vitest';
import { Azure, isAzureNotFound } from '../../src/api/services/gateways/azure';

/**
 * Helper to verify VM and associated resources (NIC, Public IP) are deleted
 */
export async function ensureVMTerminated(azure: Azure, vmId: string) {
  await azure.initializeAzure();
  const resourceGroup = azure.resourceGroup;

  // VM should not exist (404)
  try {
    await azure.computeClient.virtualMachines.get(resourceGroup, vmId);
    expect.fail('VM should have been deleted');
  } catch (error) {
    expect(isAzureNotFound(error)).toBe(true);
  }

  // NIC should not exist (404)
  try {
    await azure.networkClient.networkInterfaces.get(resourceGroup, vmId);
    expect.fail('NIC should have been deleted');
  } catch (error) {
    expect(isAzureNotFound(error)).toBe(true);
  }

  // Public IP should not exist (404)
  try {
    await azure.networkClient.publicIPAddresses.get(resourceGroup, vmId);
    expect.fail('Public IP should have been deleted');
  } catch (error) {
    expect(isAzureNotFound(error)).toBe(true);
  }
}
