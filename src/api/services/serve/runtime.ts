import { type StoredWorkload } from '../workload-record.js';
import type { CloudConfig, CloudType } from '../../../shared/cloud.js';
import { type DeployPipelineState } from '../../../shared/workload.js';
import type { BeginServiceUpgradeInput } from '../repositories/workload-lifecycle.js';
import type { ProvisioningAttemptRef } from '../entities.js';
import { validatedRuntimePlacementProvider } from '../runtime-placement.js';

/** Placement already resolved by the existing compute scheduler. */
interface ServePlacement {
  cloudConfig: CloudConfig;
  selectedCredentialId?: string;
}

interface ServeDeployRequest {
  workload: StoredWorkload;
  placement: ServePlacement;
  resumeFrom?: DeployPipelineState;
  existingAttempt?: ProvisioningAttemptRef;
  replayActiveStep?: boolean;
}

export interface ServeUpdateRequest {
  workload: StoredWorkload;
  update: BeginServiceUpgradeInput;
}

interface ServeCleanupRequest {
  workload: StoredWorkload;
  placement: ServePlacement;
}

type ServeTeardownRequest = ServeCleanupRequest;

interface VmHostServeDeployOptions {
  resumeFrom?: DeployPipelineState;
  existingAttempt?: ProvisioningAttemptRef;
  replayActiveStep?: boolean;
}

/**
 * Owns the mutating lifecycle of one AnyCloud Serve workload. The API and
 * scheduler depend on this contract; substrate-specific provisioning stays in
 * the implementation selected by the composition root.
 *
 * Status remains the shared persisted workload projection. Capacity has no
 * runtime operation yet (v0 accepts exactly one replica), so neither is
 * represented here until an implementation can provide real behavior.
 */
export interface ServeRuntime {
  deploy(request: ServeDeployRequest): Promise<void>;
  update(request: ServeUpdateRequest): Promise<boolean>;
  /** Tear down workload capacity before replacement while preserving identity. */
  teardown(request: ServeTeardownRequest): Promise<void>;
  /** Tear down substrate resources for a terminal workload. */
  cleanup(request: ServeCleanupRequest): Promise<void>;
}

export interface VmHostServeRuntimeDeps {
  deploy(
    cloudConfig: CloudConfig,
    workload: StoredWorkload,
    selectedCredentialId?: string,
    options?: VmHostServeDeployOptions,
  ): Promise<void>;
  beginUpdate(input: BeginServiceUpgradeInput): Promise<boolean>;
  teardown(cloudConfig: CloudConfig, workloadId: string): Promise<void>;
  cleanup(cloudConfig: CloudConfig, workload: StoredWorkload): Promise<void>;
}

/**
 * Adapts the current VM-host lifecycle without changing
 * its state machine, retry behavior, or cleanup semantics.
 */
export function createVmHostServeRuntime(
  deps: VmHostServeRuntimeDeps,
): ServeRuntime {
  return {
    deploy({
      workload,
      placement,
      resumeFrom,
      existingAttempt,
      replayActiveStep,
    }): Promise<void> {
      if (!resumeFrom && !existingAttempt && !replayActiveStep) {
        return deps.deploy(
          placement.cloudConfig,
          workload,
          placement.selectedCredentialId,
        );
      }
      return deps.deploy(
        placement.cloudConfig,
        workload,
        placement.selectedCredentialId,
        {
          ...(resumeFrom ? { resumeFrom } : {}),
          ...(existingAttempt ? { existingAttempt } : {}),
          ...(replayActiveStep ? { replayActiveStep } : {}),
        },
      );
    },

    update({ update }): Promise<boolean> {
      return deps.beginUpdate(update);
    },

    teardown({ workload, placement }): Promise<void> {
      return deps.teardown(placement.cloudConfig, workload.id);
    },

    cleanup({ workload, placement }): Promise<void> {
      return deps.cleanup(placement.cloudConfig, workload);
    },
  };
}

export interface ServeRuntimeRouterDeps {
  vmHost: ServeRuntime;
}

/**
 * Selects a substrate only at the Serve composition boundary. API routes and
 * monitors keep one lifecycle contract and do not branch on Kubernetes.
 * cloudtype-boundary-ok: this is the composition root that selects the
 * provider-specific runtime implementation.
 */
export function createServeRuntimeRouter({
  vmHost,
}: ServeRuntimeRouterDeps): ServeRuntime {
  const forCloud = (
    cloudProvider: CloudType | null,
  ): ServeRuntime | Promise<ServeRuntime> => {
    if (cloudProvider === null) {
      throw new Error('Serve runtime requires a resolved cloud provider');
    }
    return vmHost;
  };

  const forRequest = (
    request: ServeCleanupRequest,
    allowUnresolvedVmHost = false,
  ): ServeRuntime | Promise<ServeRuntime> => {
    // Keep placement validation synchronous and fail-closed before crossing
    // the asynchronous runtime-resolution boundary.
    const provider = validatedRuntimePlacementProvider(
      'Serve',
      request.workload.cloudProvider,
      request.placement.cloudConfig.cloudProvider,
      allowUnresolvedVmHost,
    );
    return forCloud(provider);
  };

  const invoke = <Result>(
    runtime: ServeRuntime | Promise<ServeRuntime>,
    operation: (selected: ServeRuntime) => Promise<Result>,
  ): Promise<Result> =>
    runtime instanceof Promise ? runtime.then(operation) : operation(runtime);

  return {
    deploy(request): Promise<void> {
      const runtime = forRequest(request, true);
      return invoke(runtime, (selected) => selected.deploy(request));
    },

    update(request): Promise<boolean> {
      const runtime = forCloud(request.workload.cloudProvider);
      return invoke(runtime, (selected) => selected.update(request));
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
