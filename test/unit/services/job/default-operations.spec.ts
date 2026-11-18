import { describe, expect, it } from 'vitest';
import { getDefaultWorkloadOperations } from '../../../../src/api/services/job/default-operations';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadType } from '../../../../src/shared/workload.js';
import type { DbVM } from '../../../../src/api/services/entities';
import { makeStoredWorkload } from '../../helpers/fixtures';

// The Job router fails closed on a non-Job workload, so routes must not reach
// it for Services and VMs. Selecting transport here instead of at each route
// keeps that rule from being re-derived per call site.
describe('default workload operations', () => {
  it.each([WorkloadType.Service, WorkloadType.Vm])(
    'routes %s workloads to VM-host operations',
    async (workloadType) => {
      const workload = makeStoredWorkload({
        workloadType,
        cloudProvider: CloudType.AWS,
      });

      await expect(
        getDefaultWorkloadOperations(workload).prepareExec({
          workload,
          allVms: [] as DbVM[],
          command: 'true',
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 400,
        telemetryError: 'No live VMs',
      });
    },
  );

  it('returns a typed rejection for Deployment-targeted operations', async () => {
    const workload = makeStoredWorkload({
      workloadType: WorkloadType.Job,
      cloudProvider: null,
      deploymentId: 'model-a',
    });

    await expect(
      getDefaultWorkloadOperations(workload).prepareExec({
        workload,
        allVms: [] as DbVM[],
        command: 'true',
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      clientError:
        'Per-Job health, exec, and logs are unavailable for Deployment-targeted Job test-deploy',
    });
  });

  it('never resolves Kubernetes operations for a VM-host Job', async () => {
    const workload = makeStoredWorkload({
      workloadType: WorkloadType.Job,
      cloudProvider: CloudType.AWS,
    });

    await expect(
      getDefaultWorkloadOperations(workload).prepareExec({
        workload,
        allVms: [] as DbVM[],
        command: 'true',
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      telemetryError: 'No live VMs',
    });
  });
});
