import { describe, expect, it, vi } from 'vitest';
import {
  createVmHostServeRuntime,
  createServeRuntimeRouter,
  type VmHostServeRuntimeDeps,
  type ServeRuntime,
} from '../../../../src/api/services/serve/runtime';
import type { ProvisioningAttemptRef } from '../../../../src/api/services/entities';
import { CloudType, type CloudConfig } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { makeStoredWorkload } from '../../helpers/fixtures';

const cloudConfig: CloudConfig = {
  cloudProvider: CloudType.AWS,
  region: 'us-east-1',
  vmType: 'g6e.xlarge',
};

function createDeps(): VmHostServeRuntimeDeps {
  return {
    deploy: vi.fn().mockResolvedValue(undefined),
    beginUpdate: vi.fn().mockResolvedValue(true),
    teardown: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

function createRuntime(): ServeRuntime {
  return {
    deploy: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(true),
    teardown: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe('VM-host Serve runtime', () => {
  it('delegates workload with the resolved placement unchanged', async () => {
    const deps = createDeps();
    const runtime = createVmHostServeRuntime(deps);
    const workload = makeStoredWorkload({
      id: 'serve-deploy',
      workloadType: WorkloadType.Service,
    });

    await runtime.deploy({
      workload,
      placement: { cloudConfig, selectedCredentialId: 'credential-1' },
    });

    expect(deps.deploy).toHaveBeenCalledWith(
      cloudConfig,
      workload,
      'credential-1',
    );
  });

  it('preserves the existing atomic upgrade result', async () => {
    const deps = createDeps();
    vi.mocked(deps.beginUpdate).mockResolvedValue(false);
    const runtime = createVmHostServeRuntime(deps);
    const workload = makeStoredWorkload({
      id: 'serve-update',
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
    });
    const update = {
      id: workload.id,
      image: 'nginx:v2',
      scope: { kind: 'api' } as const,
      previousImage: 'nginx:v1',
      dockerCommand: 'docker run nginx:v2',
      command: ['nginx', '-g', 'daemon off;'],
      env: { RELEASE: 'v2' },
      imageDigest: 'sha256:test',
      githubToken: 'token',
    };

    await expect(runtime.update({ workload, update })).resolves.toBe(false);
    expect(deps.beginUpdate).toHaveBeenCalledWith(update);
  });

  it('forwards active replay state and the exact VM attempt', async () => {
    const deps = createDeps();
    const runtime = createVmHostServeRuntime(deps);
    const workload = makeStoredWorkload({
      workloadType: WorkloadType.Service,
    });
    const existingAttempt = {
      vmRowId: 42,
      cloudId: `${workload.id}-0`,
      createdAt: 123,
    } satisfies ProvisioningAttemptRef;

    await runtime.deploy({
      workload,
      placement: { cloudConfig },
      resumeFrom: WorkloadState.Provisioning,
      existingAttempt,
      replayActiveStep: true,
    });

    expect(deps.deploy).toHaveBeenCalledWith(cloudConfig, workload, undefined, {
      resumeFrom: WorkloadState.Provisioning,
      existingAttempt,
      replayActiveStep: true,
    });
  });

  it('delegates cleanup and replacement teardown', async () => {
    const deps = createDeps();
    const runtime = createVmHostServeRuntime(deps);
    const workload = makeStoredWorkload({
      id: 'serve-cleanup',
      workloadType: WorkloadType.Service,
    });

    await runtime.teardown({ workload, placement: { cloudConfig } });
    await runtime.cleanup({ workload, placement: { cloudConfig } });

    expect(deps.teardown).toHaveBeenCalledWith(cloudConfig, workload.id);
    expect(deps.cleanup).toHaveBeenCalledWith(cloudConfig, workload);
  });

  it('does not replace lifecycle errors', async () => {
    const deps = createDeps();
    const lifecycleError = new Error('VM-host workload failed');
    vi.mocked(deps.deploy).mockRejectedValue(lifecycleError);
    const runtime = createVmHostServeRuntime(deps);
    const workload = makeStoredWorkload({
      workloadType: WorkloadType.Service,
    });

    await expect(
      runtime.deploy({ workload, placement: { cloudConfig } }),
    ).rejects.toThrow(lifecycleError);
  });
});

describe('Serve runtime router', () => {
  it('routes direct-provider lifecycle operations to VM-host machinery', async () => {
    const vmHost = createRuntime();
    const runtime = createServeRuntimeRouter({ vmHost });
    const workload = makeStoredWorkload({
      workloadType: WorkloadType.Service,
      cloudProvider: CloudType.AWS,
    });
    const request = { workload, placement: { cloudConfig } };

    await runtime.deploy(request);
    await runtime.cleanup(request);

    expect(vmHost.deploy).toHaveBeenCalledWith(request);
    expect(vmHost.cleanup).toHaveBeenCalledWith(request);
  });

  it('allows VM-host provider failover without changing runtime ownership', async () => {
    const vmHost = createRuntime();
    const runtime = createServeRuntimeRouter({ vmHost });
    const request = {
      workload: makeStoredWorkload({
        workloadType: WorkloadType.Service,
        cloudProvider: CloudType.AWS,
      }),
      placement: {
        cloudConfig: {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          vmType: 'n2-standard-4',
        },
      },
    };

    await runtime.cleanup(request);
    expect(vmHost.cleanup).toHaveBeenCalledWith(request);
  });
});
