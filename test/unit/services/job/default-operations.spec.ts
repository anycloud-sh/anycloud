import { describe, expect, it } from 'vitest';
import { getDefaultWorkloadOperations } from '../../../../src/api/services/job/default-operations';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadType } from '../../../../src/shared/workload.js';
import type { DbVM } from '../../../../src/api/services/entities';
import { makeStoredWorkload } from '../../helpers/fixtures';

describe('default workload operations', () => {
  it.each([WorkloadType.Job, WorkloadType.Service, WorkloadType.Vm])(
    'routes %s workloads to VM-host operations',
    async (workloadType) => {
      const workload = makeStoredWorkload({
        workloadType,
        cloudProvider: CloudType.AWS,
      });

      await expect(
        getDefaultWorkloadOperations().prepareExec({
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
});
