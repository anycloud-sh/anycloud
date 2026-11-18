import { describe, expect, it, vi } from 'vitest';
import {
  createJobOperationsRouter,
  type JobOperations,
} from '../../../../src/api/services/job/operations';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadType } from '../../../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../../../src/shared/runtime.js';
import type { DbVM } from '../../../../src/api/services/entities';
import { makeStoredWorkload } from '../../helpers/fixtures';

function operations(): JobOperations {
  return {
    observeHealth: vi
      .fn()
      .mockResolvedValue({ status: WorkloadHealthStatus.Unknown }),
    prepareExec: vi.fn().mockResolvedValue({
      ok: true,
      run: vi.fn().mockResolvedValue(0),
    }),
    prepareLogs: vi.fn().mockResolvedValue({
      ok: true,
      probeCount: 1,
      targetContainerStatus: 'running',
      run: vi.fn().mockResolvedValue(0),
    }),
  };
}

describe('Job operations boundary', () => {
  it('passes already-loaded workload and VM data to VM-host operations', async () => {
    const vmHost = operations();
    const router = createJobOperationsRouter({
      vmHost,
      poolJobLogs: async () => null,
      poolJobExec: async () => null,
    });
    const workload = makeStoredWorkload({ cloudProvider: CloudType.AWS });
    const allVms = [{ cloudId: 'vm-1' }] as DbVM[];
    const request = { workload, allVms, command: 'echo ready' };

    await router.prepareExec(request);

    expect(vmHost.prepareExec).toHaveBeenCalledWith(request);
  });

  it('retains VM-host fallback only for an unresolved stored provider', async () => {
    const vmHost = operations();
    const router = createJobOperationsRouter({
      vmHost,
      poolJobLogs: async () => null,
      poolJobExec: async () => null,
    });
    const request = {
      workload: makeStoredWorkload({ cloudProvider: null }),
      allVms: [] as DbVM[],
      verbose: false,
    };

    await router.observeHealth(request);

    expect(vmHost.observeHealth).toHaveBeenCalledWith(request);
  });

  it('rejects a Deployment-targeted Job before VM-host operations', async () => {
    const vmHost = operations();
    const router = createJobOperationsRouter({
      vmHost,
      poolJobLogs: async () => null,
      poolJobExec: async () => null,
    });
    const workload = makeStoredWorkload({
      deploymentId: 'model-a',
      cloudProvider: null,
    });
    const allVms = [{ cloudId: 'legacy-vm' }] as DbVM[];
    const request = { workload, allVms, follow: true };

    await expect(router.prepareLogs(request)).resolves.toMatchObject({
      ok: false,
      status: 400,
      clientError: expect.stringContaining(
        'Per-Job health, exec, and logs are unavailable',
      ),
    });

    expect(vmHost.prepareLogs).not.toHaveBeenCalled();
  });

  it("sends a pool Job's exec to its replica, and refuses a Job on a user Deployment", async () => {
    const vmHost = operations();
    const pooled = { ok: true as const, run: async () => 0 };
    const poolJobExec = vi.fn(async (jobId: string) =>
      jobId === 'pool-job' ? pooled : null,
    );
    const router = createJobOperationsRouter({
      vmHost,
      poolJobLogs: async () => null,
      poolJobExec,
    });
    const request = (id: string) => ({
      workload: makeStoredWorkload({ id, deploymentId: 'd-1' }),
      allVms: [] as DbVM[],
      command: 'echo ok',
    });

    await expect(router.prepareExec(request('pool-job'))).resolves.toBe(pooled);
    expect(poolJobExec).toHaveBeenCalledWith('pool-job', 'echo ok');
    await expect(
      router.prepareExec(request('user-deployment-job')),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    expect(vmHost.prepareExec).not.toHaveBeenCalled();
  });

  it('rejects non-Job workloads before provider dispatch', async () => {
    const vmHost = operations();
    const router = createJobOperationsRouter({
      vmHost,
      poolJobLogs: async () => null,
      poolJobExec: async () => null,
    });
    const request = {
      workload: makeStoredWorkload({
        workloadType: WorkloadType.Service,
        cloudProvider: CloudType.AWS,
      }),
      allVms: [] as DbVM[],
      command: 'true',
    };

    await expect(router.prepareExec(request)).rejects.toThrow(
      'Job operations cannot manage service workload',
    );
    expect(vmHost.prepareExec).not.toHaveBeenCalled();
  });
});
