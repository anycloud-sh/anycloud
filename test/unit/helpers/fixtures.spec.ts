import { describe, expect, it, vi } from 'vitest';
import { VM_RELEASE_CANDIDATE } from '../../../src/api/services/gateways/cloud.js';
import {
  makeMockCloud,
  makeMockCloudCompute,
  makeMockVM,
  makeNewVMProps,
} from './fixtures.js';

const newVMProps = makeNewVMProps({
  workloadId: 'test-deploy',
  ipWhitelist: [],
  startupScript: '#!/bin/bash',
  version: '1.0.0',
  userId: 'test-user',
  vmId: 'test-deploy-0',
});

describe('mock cloud fixtures', () => {
  it('returns a VM from makeMockCloud().newVM()', async () => {
    const cloud = makeMockCloud();

    await expect(cloud.newVM(newVMProps)).resolves.toEqual({
      cloudId: 'vm-123',
      ip: '1.2.3.4',
      privateIp: '10.0.0.1',
      sshHost: '1.2.3.4',
      sshPort: 22,
      sshUsername: 'root',
    });
  });

  it('wires raw compute overrides through the public wrapper', async () => {
    const vm = makeMockVM({ cloudId: 'vm-override' });
    const rawNewVM = vi.fn().mockResolvedValue(vm);
    const observeVMReleaseOnce = vi
      .fn()
      .mockResolvedValue(VM_RELEASE_CANDIDATE);
    const compute = makeMockCloudCompute({
      rawNewVM,
      observeVMReleaseOnce,
    });

    await expect(compute.newVM(newVMProps)).resolves.toEqual(vm);
    await expect(compute.observeVMReleaseOnce('vm-override')).resolves.toBe(
      VM_RELEASE_CANDIDATE,
    );
    expect(rawNewVM).toHaveBeenCalledWith(newVMProps);
    expect(observeVMReleaseOnce).toHaveBeenCalledWith('vm-override', undefined);
  });
});
