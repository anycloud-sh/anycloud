import { describe, it, expect, beforeEach } from 'vitest';
import { type DbVM } from '../../../src/api/services/entities';
import { resetTestStore } from '../utils';
import { getWorkloadQueryStore as queries } from '../../../src/api/services/persistence.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import {
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';

describe('VM Type Safety and Null Handling', () => {
  beforeEach(async () => {
    await resetTestStore();
  });

  describe('DbVM type assertions', () => {
    it('should return VMs with createdAt and preempted from getVMs()', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.2.3.4',
        cloudId: 'vm-123',
        privateIp: '10.0.0.1',
      });

      const vms = await queries().getVMs(workloadId);

      expect(vms).toHaveLength(1);
      const vm = vms[0];

      expect(vm.createdAt).toBeDefined();
      expect(typeof vm.createdAt).toBe('number');
      expect(vm.createdAt).toBeGreaterThan(0);
    });

    it('should accept DbVM in operations requiring createdAt', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.2.3.4',
        cloudId: 'vm-123',
        privateIp: '10.0.0.1',
      });

      const vms: DbVM[] = await queries().getVMs(workloadId);
      const vm = vms[0];

      await releaseTestVms(workloadId, vm.cloudId);

      const activeVMs = await queries().getVMs(workloadId);
      expect(activeVMs).toHaveLength(0);
    });

    it('should maintain type safety across multiple VMs', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'vm-1',
        privateIp: '10.0.0.1',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'vm-2',
        privateIp: '10.0.0.2',
      });
      await provisionTestVm(workloadId, {
        ip: '3.3.3.3',
        cloudId: 'vm-3',
        privateIp: '10.0.0.3',
      });

      const vms = await queries().getVMs(workloadId);

      expect(vms).toHaveLength(3);

      vms.forEach((vm) => {
        expect(vm.createdAt).toBeDefined();
        expect(typeof vm.createdAt).toBe('number');
      });

      const createdAts = vms.map((vm) => vm.createdAt);
      expect(createdAts.every((t) => t > 0)).toBe(true);
    });
  });

  describe('privateIp null handling', () => {
    it('should store null privateIp when undefined is passed', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.2.3.4',
        cloudId: 'vm-123',
      });

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(1);
      expect(vms[0].privateIp).toBeUndefined();
    });

    it('should correctly store and retrieve null privateIp', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.2.3.4',
        cloudId: 'vm-123',
      });

      const vms = await queries().getVMs(workloadId);
      expect(vms[0].privateIp).toBeUndefined();
    });

    it('should correctly store and retrieve valid privateIp', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.2.3.4',
        cloudId: 'vm-123',
        privateIp: '10.0.0.1',
      });

      const vms = await queries().getVMs(workloadId);
      expect(vms[0].privateIp).toBe('10.0.0.1');
    });

    it('should distinguish between null and empty string privateIp', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'vm-1',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'vm-2',
        privateIp: '',
      });

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(2);

      const vm1 = vms.find((v) => v.ip === '1.1.1.1');
      const vm2 = vms.find((v) => v.ip === '2.2.2.2');

      expect(vm1?.privateIp).toBeUndefined();

      // Empty string is stored as-is (not converted to null/undefined)
      expect(vm2?.privateIp).toBe('');
    });

    it('should handle VMs with mixed privateIp values', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'vm-1',
        privateIp: '10.0.0.1',
      });
      await provisionTestVm(workloadId, {
        ip: '2.2.2.2',
        cloudId: 'vm-2',
      });
      await provisionTestVm(workloadId, {
        ip: '3.3.3.3',
        cloudId: 'vm-3',
        privateIp: '10.0.0.3',
      });

      const vms = await queries().getVMs(workloadId);
      expect(vms).toHaveLength(3);

      const vm1 = vms.find((v) => v.ip === '1.1.1.1');
      const vm2 = vms.find((v) => v.ip === '2.2.2.2');
      const vm3 = vms.find((v) => v.ip === '3.3.3.3');

      expect(vm1?.privateIp).toBe('10.0.0.1');
      expect(vm2?.privateIp).toBeUndefined();
      expect(vm3?.privateIp).toBe('10.0.0.3');
    });
  });

  describe('VM lifecycle with type safety', () => {
    it('should maintain createdAt across VM lifecycle', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.2.3.4',
        cloudId: 'vm-123',
        privateIp: '10.0.0.1',
      });

      const vmsAfterAdd = await queries().getVMs(workloadId);
      const vmFromD1 = vmsAfterAdd[0];

      await releaseTestVms(workloadId, vmFromD1.cloudId);

      const vmsAfterEnd = await queries().getVMs(workloadId);
      expect(vmsAfterEnd).toHaveLength(0);
    });

    it('should allow IP reuse with different createdAt timestamps', async () => {
      const workloadId = 'test-workload';

      await createWorkload(getDB(), {
        id: workloadId,
        userId: 'test-user',
        workloadType: 'job',
        image: 'test-image',
        dockerCommand: 'test-command',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'vm-old',
        privateIp: '10.0.0.1',
      });
      const oldVMs = await queries().getVMs(workloadId);
      const oldVM = oldVMs[0];

      await new Promise((resolve) => setTimeout(resolve, 10));

      await provisionTestVm(workloadId, {
        ip: '1.1.1.1',
        cloudId: 'vm-new',
        privateIp: '10.0.0.1',
      });

      const allVMs = await queries().getVMs(workloadId);
      expect(allVMs).toHaveLength(2);

      const createdAts = allVMs.map((vm) => vm.createdAt);
      expect(createdAts[0]).not.toBe(createdAts[1]);

      await releaseTestVms(workloadId, oldVM.cloudId);

      const remainingVMs = await queries().getVMs(workloadId);
      expect(remainingVMs).toHaveLength(1);
      expect(remainingVMs[0].cloudId).toBe('vm-new');
    });
  });
});
