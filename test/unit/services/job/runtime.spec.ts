import { describe, expect, it, vi } from 'vitest';
import {
  createJobRuntimeRouter,
  createVmHostJobRuntime,
  type JobRuntime,
} from '../../../../src/api/services/job/runtime';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { makeStoredWorkload } from '../../helpers/fixtures';

function runtime(): JobRuntime {
  return {
    deploy: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Job runtime contract', () => {
  it('adapts the existing VM lifecycle to the shared runtime contract', async () => {
    const deps = {
      deploy: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createVmHostJobRuntime(deps);
    const workload = makeStoredWorkload({
      id: 'vm-host-job',
      sshPrivateKey: 'private-key',
    });
    const placement = {
      cloudConfig: {
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'n2-standard-4',
      },
      selectedCredentialId: 'credential-id',
    };

    await adapter.deploy({
      workload,
      placement,
      resumeFrom: WorkloadState.Provisioning,
      replayActiveStep: true,
    });
    await adapter.poll({ workload, placement });
    await adapter.teardown({ workload, placement });
    await adapter.cleanup({ workload, placement });

    expect(deps.deploy).toHaveBeenCalledWith(
      placement.cloudConfig,
      workload,
      'credential-id',
      {
        resumeFrom: WorkloadState.Provisioning,
        replayActiveStep: true,
      },
    );
    expect(deps.poll).toHaveBeenCalledWith(
      'vm-host-job',
      'private-key',
      placement.cloudConfig,
    );
    expect(deps.teardown).toHaveBeenCalledWith(
      placement.cloudConfig,
      'vm-host-job',
    );
    expect(deps.cleanup).toHaveBeenCalledWith(
      placement.cloudConfig,
      'vm-host-job',
    );
  });

  it('0029/S1 routes dedicated provider Jobs to the VM-host runtime', async () => {
    const vmHost = runtime();
    const router = createJobRuntimeRouter({ vmHost });
    const workload = makeStoredWorkload();
    const request = {
      workload,
      placement: {
        cloudConfig: {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.micro',
        },
      },
    };

    await router.deploy(request);
    expect(vmHost.deploy).toHaveBeenCalledWith(request);
  });

  it('rejects an unresolved placement instead of defaulting to VM-host', () => {
    const router = createJobRuntimeRouter({
      vmHost: runtime(),
    });
    const workload = makeStoredWorkload();
    const request = {
      workload,
      placement: {
        cloudConfig: {
          cloudProvider: null,
          region: 'us-east-1',
          vmType: 't3.micro',
        },
      },
    };

    expect(() =>
      router.deploy(request as unknown as Parameters<JobRuntime['deploy']>[0]),
    ).toThrow('Job runtime requires a resolved cloud provider');
  });

  it('0029/S14 rejects Deployment-targeted Jobs before dedicated runtime dispatch', () => {
    const router = createJobRuntimeRouter({ vmHost: runtime() });
    const workload = makeStoredWorkload({
      deploymentId: 'model-a',
      cloudProvider: null,
    });
    const request = {
      workload,
      placement: {
        cloudConfig: {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.micro',
        },
      },
    };

    expect(() => router.deploy(request)).toThrow(
      'Targeted Job test-deploy cannot enter the dedicated Job runtime',
    );
  });

  it('allows VM-host provider failover without changing runtime ownership', async () => {
    const vmHost = runtime();
    const router = createJobRuntimeRouter({ vmHost });
    const request = {
      workload: makeStoredWorkload({ cloudProvider: CloudType.AWS }),
      placement: {
        cloudConfig: {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          vmType: 'n2-standard-4',
        },
      },
    };

    await router.cleanup(request);

    expect(vmHost.cleanup).toHaveBeenCalledWith(request);
  });

  it('allows an unresolved provider only for initial VM-host workload', async () => {
    const vmHost = runtime();
    const router = createJobRuntimeRouter({ vmHost });
    const request = {
      workload: makeStoredWorkload({ cloudProvider: null }),
      placement: {
        cloudConfig: {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.micro',
        },
      },
    };

    await router.deploy(request);
    expect(vmHost.deploy).toHaveBeenCalledWith(request);
    expect(() => router.cleanup(request)).toThrow(
      'Job runtime requires a persisted cloud provider',
    );
  });
});
