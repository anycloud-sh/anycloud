import { type CloudType } from '../../shared/cloud.js';

type RuntimeName = 'Job' | 'Serve';

/**
 * Validate the persisted and resolved sides of a runtime request before the
 * substrate adapter is selected. VM-host providers may fail over among clouds,
 * so only a missing provider is rejected.
 */
export function validatedRuntimePlacementProvider(
  runtimeName: RuntimeName,
  workloadProvider: CloudType | null,
  placementProvider: CloudType | null,
  allowUnresolvedVmHost = false,
): CloudType {
  if (placementProvider === null) {
    throw new Error(
      `${runtimeName} runtime requires a resolved cloud provider`,
    );
  }
  if (workloadProvider === null && !allowUnresolvedVmHost) {
    throw new Error(
      `${runtimeName} runtime requires a persisted cloud provider for ${placementProvider} placement`,
    );
  }
  return placementProvider;
}
