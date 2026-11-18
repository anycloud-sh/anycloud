import { type CloudConfig } from '../../shared/cloud.js';
import { type DockerOptions } from '../../shared/runtime.js';
import {
  getRegionsForVMType,
  resolveVMType,
} from '../../shared/cloud-config.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import {
  validateDockerOptionsRequest,
  validateDockerOptionsForResolvedTarget,
} from '../../shared/docker-options.js';

export interface ComputeTargetRequest {
  gpuTypes: string[];
  vmTypes: string[];
}

function computeTargetMatchesRequest(
  config: CloudConfig,
  { gpuTypes, vmTypes }: ComputeTargetRequest,
): boolean {
  if (gpuTypes.length > 0) {
    return gpuTypes.some((gpu) => {
      try {
        return resolveVMType(gpu, config.cloudProvider) !== gpu;
      } catch {
        return false;
      }
    });
  }

  return vmTypes.some((vmType) => {
    try {
      return (
        getRegionsForVMType(vmType, config.cloudProvider, config.spot).length >
        0
      );
    } catch {
      return false;
    }
  });
}

function targetUnavailableMessage(
  config: CloudConfig,
  { gpuTypes, vmTypes }: ComputeTargetRequest,
): string {
  if (gpuTypes.length > 0) {
    return `GPU type "${gpuTypes.join(', ')}" is not available on ${config.cloudProvider}`;
  }
  return `VM type "${vmTypes.join(', ')}" is not available on ${config.cloudProvider}`;
}

export function validateTargetAvailability(
  config: CloudConfig,
  request: ComputeTargetRequest,
): void {
  if (!computeTargetMatchesRequest(config, request)) {
    throw new InvalidAnycloudConfigError(
      targetUnavailableMessage(config, request),
    );
  }
}

export function validateProviderRequestShape(
  config: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
  dockerOptions: DockerOptions | null | undefined,
  targetRequest: ComputeTargetRequest,
): void {
  // config.vmType is only the RESOLVED target when the request named exactly one
  // concrete VM type. Runtime configs reduce a fallback list (and a gpuType
  // alias) to a single head for gateway-facing code, and rejecting on that head
  // would fail a request the optimizer can still place on a compatible sibling.
  const resolvedVmType =
    typeof config.vmType === 'string' &&
    targetRequest.gpuTypes.length === 0 &&
    targetRequest.vmTypes.length === 1
      ? config.vmType
      : undefined;
  if (resolvedVmType !== undefined) {
    validateDockerOptionsForResolvedTarget(dockerOptions, {
      cloudProvider: config.cloudProvider,
      vmType: resolvedVmType,
    });
  } else {
    validateDockerOptionsRequest(dockerOptions);
  }
}
