import { type StoredWorkload } from '../workload-record.js';
import type { CloudConfig, CloudType } from '../../../shared/cloud.js';
import { type DeployPipelineState } from '../../../shared/workload.js';
import type { ProvisioningAttemptRef } from '../entities.js';
import { validatedRuntimePlacementProvider } from '../runtime-placement.js';

/** Placement already resolved by the existing compute scheduler. */
interface JobPlacement {
  cloudConfig: CloudConfig;
  selectedCredentialId?: string;
}

interface JobDeployRequest {
  workload: StoredWorkload;
  placement: JobPlacement;
  resumeFrom?: DeployPipelineState;
  existingAttempt?: ProvisioningAttemptRef;
  replayActiveStep?: boolean;
}

interface JobLifecycleRequest {
  workload: StoredWorkload;
  placement: JobPlacement;
}

type JobPollRequest = JobLifecycleRequest;
type JobTeardownRequest = JobLifecycleRequest;
type JobCleanupRequest = JobLifecycleRequest;

export interface VmHostJobRuntimeDeps {
  deploy(
    cloudConfig: CloudConfig,
    workload: StoredWorkload,
    selectedCredentialId?: string,
    options?: {
      resumeFrom?: DeployPipelineState;
      existingAttempt?: ProvisioningAttemptRef;
      replayActiveStep?: boolean;
    },
  ): Promise<void>;
  poll(
    id: string,
    sshPrivateKey: string,
    cloudConfig: CloudConfig,
  ): Promise<void>;
  teardown(cloudConfig: CloudConfig, workloadId: string): Promise<void>;
  cleanup(cloudConfig: CloudConfig, workloadId: string): Promise<void>;
}

/**
 * Owns the mutating and completion lifecycle of one Job. VM-host
 * providers use the VM-host adapter; scheduler-backed substrates can implement
 * this contract without pretending their workload is a VM.
 */
export interface JobRuntime {
  deploy(request: JobDeployRequest): Promise<void>;
  poll(request: JobPollRequest): Promise<void>;
  teardown(request: JobTeardownRequest): Promise<void>;
  cleanup(request: JobCleanupRequest): Promise<void>;
}

export function createVmHostJobRuntime(deps: VmHostJobRuntimeDeps): JobRuntime {
  return {
    deploy({
      workload,
      placement,
      resumeFrom,
      existingAttempt,
      replayActiveStep,
    }): Promise<void> {
      const options = {
        ...(resumeFrom ? { resumeFrom } : {}),
        ...(existingAttempt ? { existingAttempt } : {}),
        ...(replayActiveStep ? { replayActiveStep } : {}),
      };
      return deps.deploy(
        placement.cloudConfig,
        workload,
        placement.selectedCredentialId,
        Object.keys(options).length > 0 ? options : undefined,
      );
    },

    poll({ workload, placement }): Promise<void> {
      return deps.poll(
        workload.id,
        workload.sshPrivateKey,
        placement.cloudConfig,
      );
    },

    teardown({ workload, placement }): Promise<void> {
      return deps.teardown(placement.cloudConfig, workload.id);
    },

    cleanup({ workload, placement }): Promise<void> {
      return deps.cleanup(placement.cloudConfig, workload.id);
    },
  };
}

export interface JobRuntimeRouterDeps {
  vmHost: JobRuntime;
}

/**
 * Selects the substrate at the Job composition boundary so the scheduler and
 * reconciler retain one lifecycle contract.
 * cloudtype-boundary-ok: this is the composition root that selects the
 * provider-specific runtime implementation.
 */
export function createJobRuntimeRouter({
  vmHost,
}: JobRuntimeRouterDeps): JobRuntime {
  const forCloud = (
    cloudProvider: CloudType | null,
    workload: StoredWorkload,
  ): JobRuntime | Promise<JobRuntime> => {
    if (cloudProvider === null) {
      throw new Error('Job runtime requires a resolved cloud provider');
    }
    if (workload.deploymentId) {
      throw new Error(
        `Targeted Job ${workload.id} cannot enter the dedicated Job runtime`,
      );
    }
    return vmHost;
  };

  const forRequest = (
    request: JobLifecycleRequest,
    allowUnresolvedVmHost = false,
  ): JobRuntime | Promise<JobRuntime> => {
    // Keep placement validation synchronous and fail-closed before crossing
    // the asynchronous runtime-resolution boundary.
    const provider = validatedRuntimePlacementProvider(
      'Job',
      request.workload.cloudProvider,
      request.placement.cloudConfig.cloudProvider,
      allowUnresolvedVmHost,
    );
    return forCloud(provider, request.workload);
  };

  const invoke = <Result>(
    runtime: JobRuntime | Promise<JobRuntime>,
    operation: (selected: JobRuntime) => Promise<Result>,
  ): Promise<Result> =>
    runtime instanceof Promise ? runtime.then(operation) : operation(runtime);

  return {
    deploy(request): Promise<void> {
      const runtime = forRequest(request, true);
      return invoke(runtime, (selected) => selected.deploy(request));
    },

    poll(request): Promise<void> {
      const runtime = forRequest(request);
      return invoke(runtime, (selected) => selected.poll(request));
    },

    teardown(request): Promise<void> {
      const runtime = forRequest(request);
      return invoke(runtime, (selected) => selected.teardown(request));
    },

    cleanup(request): Promise<void> {
      const runtime = forRequest(request);
      return invoke(runtime, (selected) => selected.cleanup(request));
    },
  };
}
