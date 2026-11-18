import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import config from '../../../src/api/config';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  getDeploymentExecutionStore as executions,
  getWorkloadQueryStore as queries,
  resetPersistence,
  getWorkloadOutcomes as outcomes,
} from '../../../src/api/services/persistence.js';
import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor.js';
import {
  claimInput,
  createTarget,
  createTargetedJob,
  firstExecution,
} from '../helpers/targeted-jobs.js';

const { schedule } = vi.hoisted(() => ({ schedule: vi.fn() }));

vi.mock('../../../src/api/services/deployment-controller.js', () => ({
  getDefaultDeploymentControl: () => ({ schedule }),
}));

describe('monitor routing of Deployment-targeted Jobs', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    schedule.mockClear();
  });

  it('hands targeted cleanup to its workflow with the execution store and Deployment control', async () => {
    await createTarget();
    await createTargetedJob('job');
    await executions().claimTargetedJob(claimInput('job', firstExecution));
    await outcomes().requestTermination('job', { kind: 'api' });

    await runWorkloadReconcileOnce();

    // The live execution holds its cleanup fence until the in-Pod
    // acknowledgement, and the Deployment controller is asked to observe it.
    expect(schedule).toHaveBeenCalledWith('target');
    await expect(queries().getWorkload('job')).resolves.toMatchObject({
      state: WorkloadState.Terminated,
      cleanedAt: null,
    });
  });
});
