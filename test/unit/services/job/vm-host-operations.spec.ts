import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbVM } from '../../../../src/api/services/entities.js';
import { createTransport } from '../../../../src/api/services/gateways/transport.js';
import { createVmHostJobOperations } from '../../../../src/api/services/job/vm-host-operations.js';
import {
  ContainerState,
  WorkloadHealthStatus,
} from '../../../../src/shared/runtime.js';
import { makeStoredWorkload } from '../../helpers/fixtures.js';
import { CloudType } from '../../../../src/shared/cloud.js';

const { fake } = await vi.hoisted(async () => {
  const { createFakeTransport } = await import(
    '../../helpers/mock-transport.js'
  );
  return { fake: createFakeTransport() };
});

vi.mock('../../../../src/api/services/gateways/transport.js', () => ({
  createTransport: vi.fn(() => fake),
}));

describe('VM-host Job operations', () => {
  beforeEach(() => {
    fake.reset();
    vi.mocked(createTransport).mockClear();
  });

  it('uses the VM SSH username for Docker and supervisor health probes', async () => {
    fake.on('docker inspect', {
      stdout: JSON.stringify({
        Status: ContainerState.Running,
        ExitCode: 0,
        StartedAt: '2026-08-18T00:00:00Z',
        OOMKilled: false,
        Error: '',
      }),
      code: 0,
    });
    fake.default({ stdout: 'unknown\n', stderr: '', code: 0 });

    const workload = makeStoredWorkload({
      id: 'non-root-health',
      sshPrivateKey: 'test-private-key',
    });
    const vm: DbVM = {
      cloudId: 'vm-1',
      ip: '203.0.113.10',
      createdAt: Date.now(),
      endedAt: null,
      preempt: null,
      sshHost: 'ssh.example.test',
      sshPort: 31022,
      sshUsername: 'vm-operator',
      inputHostPath: '/mnt/input',
      outputHostPath: '/mnt/output',
      checkpointHostPath: '/mnt/checkpoint',
    };

    await expect(
      createVmHostJobOperations().observeHealth({
        workload,
        allVms: [vm],
        verbose: false,
      }),
    ).resolves.toMatchObject({ status: WorkloadHealthStatus.Up });

    expect(vi.mocked(createTransport).mock.calls).toEqual([
      ['ssh.example.test', 'test-private-key', 31022, 'vm-operator'],
      ['ssh.example.test', 'test-private-key', 31022, 'vm-operator'],
    ]);
  });

  describe('GPU health on an NVIDIA GPU VM', () => {
    const vm: DbVM = {
      cloudId: 'vm-gpu',
      ip: '203.0.113.20',
      sshHost: '203.0.113.20',
      sshPort: 22,
      sshUsername: 'root',
      createdAt: Date.now(),
      endedAt: null,
      preempt: null,
      inputHostPath: '/mnt/input',
      outputHostPath: '/mnt/output',
      checkpointHostPath: '/mnt/checkpoint',
    };
    const running = () =>
      fake.on('docker inspect', {
        stdout: JSON.stringify({
          Status: ContainerState.Running,
          ExitCode: 0,
          StartedAt: '2026-08-18T00:00:00Z',
          OOMKilled: false,
          Error: '',
        }),
        code: 0,
      });
    const observe = (vmType: string) =>
      createVmHostJobOperations().observeHealth({
        workload: makeStoredWorkload({
          id: 'gpu-health',
          sshPrivateKey: 'k',
          cloudProvider: CloudType.AWS,
          vmType,
        }),
        allVms: [vm],
        verbose: false,
      });

    it('reads it beside the container, and an unhealthy GPU makes the workload down', async () => {
      running();
      fake.on('nvidia-smi', {
        stdout: [
          '--anycloud-gpu-smi 0',
          'GPU 00000000:00:1E.0',
          '    GPU Reset Status',
          '        Reset Required                    : Yes',
          '--anycloud-gpu-journal 0',
          '2026-11-08T01:02:03+0000 h kernel: NVRM: Xid (PCI:0000:00:1e): 154, pid=1, GPU recovery action changed to 0x1 (GPU Reset Required)',
          '',
        ].join('\n'),
        code: 0,
      });
      fake.default({ stdout: 'unknown\n', stderr: '', code: 0 });
      const observation = await observe('g4dn.xlarge');
      expect(observation.status).toBe(WorkloadHealthStatus.Down);
      expect(observation.vmHealth?.[0]?.gpu).toMatchObject({
        state: 'unhealthy',
        gpus: [{ index: 0, resetRequired: true, xids: [{ code: 154 }] }],
      });
    });

    it('reports a GPU read that fails as unknown, without marking the workload down', async () => {
      running();
      fake.on('nvidia-smi', { stdout: '', stderr: 'reset', code: 255 });
      fake.default({ stdout: 'unknown\n', stderr: '', code: 0 });
      const observation = await observe('g4dn.xlarge');
      expect(observation.status).toBe(WorkloadHealthStatus.Up);
      expect(observation.vmHealth?.[0]?.gpu?.state).toBe('unknown');
    });

    it('reads nothing on a CPU VM', async () => {
      running();
      fake.default({ stdout: 'unknown\n', stderr: '', code: 0 });
      const observation = await observe('t3.medium');
      expect(observation.vmHealth?.[0]).not.toHaveProperty('gpu');
    });
  });
});
