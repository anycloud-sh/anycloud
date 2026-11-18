import { describe, expect, it } from 'vitest';
import { toStatusVm } from '../../../src/api/services/status-vm.js';
import type { DbVM } from '../../../src/api/services/entities.js';

const vm = (overrides: Partial<DbVM> = {}): DbVM => ({
  ip: '10.0.0.7',
  cloudId: 'i-0abc',
  sshHost: '10.0.0.7',
  sshPort: 22,
  sshUsername: 'root',
  createdAt: 1,
  preempt: null,
  endedAt: null,
  region: 'us-east-2',
  availabilityZone: 'us-east-2b',
  inputHostPath: '/in',
  outputHostPath: '/out',
  checkpointHostPath: '/ckpt',
  ...overrides,
});

describe('toStatusVm', () => {
  it('reports where and as what type each VM launched', () => {
    expect(toStatusVm(vm({ vmType: 'm8i.xlarge' }), undefined, false)).toEqual({
      ip: '10.0.0.7',
      cloudId: 'i-0abc',
      endedAt: null,
      region: 'us-east-2',
      availabilityZone: 'us-east-2b',
      vmType: 'm8i.xlarge',
    });
    // A VM row from before 0056 records no type.
    expect(toStatusVm(vm(), undefined, false)).not.toHaveProperty('vmType');
  });
});
