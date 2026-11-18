import { validateCredentials } from './workload-admission-checks.js';
import {
  createComputeProvider,
  validateComputeCapabilities,
  validateWorkloadStorageRequest,
} from './cloud-config.js';
import {
  extractCredentials,
  requiresComputeCredentials,
} from '../../shared/cloud-config.js';
import {
  CloudFailureDiagnosis,
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../shared/cloud.js';
import {
  DeployError,
  InvalidAnycloudConfigError,
  TransientInfraError,
} from '../../shared/errors.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { permissionDeniedMessage } from '../../shared/permission-denied.js';
import {
  canClassifyTerminalAuthError,
  canSupportIngress,
  isTransientTransportError,
  providerHttpStatus,
  type CloudCompute,
} from './gateways/cloud.js';
import type { DockerOptions } from '../../shared/runtime.js';
import type { IngressSpec } from './entities.js';
import { ingressUnsupportedMessage } from './network.js';
import * as catalogReadiness from './catalog-readiness.js';
import { computeProviderData } from '../../shared/providers.js';
import {
  validateProviderRequestShape,
  validateTargetAvailability,
  type ComputeTargetRequest,
} from './compute-candidates.js';

export interface ResolvedComputeCredential {
  id: string;
  name: string;
  creds: CloudCredentials;
  cloudProvider: CloudType;
}

export interface ComputeValidationTarget {
  name: string | null;
  config: CloudConfig;
}

// cloudtype-boundary-ok: this API-instance composition policy is the single
// place where an otherwise placementless workload may acquire a provider.
const IMPLICIT_CREDENTIALLESS_COMPUTE_PROVIDERS = [CloudType.Local] as const;

function credentialLabel(target: ComputeValidationTarget): string {
  return target.name ? `"${target.name}"` : '(inline)';
}

/**
 * A provider classifier's temporary-failure value is its conservative
 * fallback, so admission needs independent evidence before declaring a safe
 * 503. Otherwise programmer errors and malformed local material would become
 * endlessly retryable outages.
 */
function isExplicitlyRetryableValidationFailure(
  error: unknown,
  provider: CloudCompute,
): boolean {
  if (isTransientTransportError(error)) return true;
  if (provider.isCredentialValidationRetryable?.(error) === true) return true;
  const status = providerHttpStatus(error);
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

function invalidCredentialError(
  target: ComputeValidationTarget,
  error: unknown,
): InvalidAnycloudConfigError {
  return new InvalidAnycloudConfigError(
    `Cloud credential ${credentialLabel(target)} failed ${target.config.cloudProvider} validation: ${errorMessage(error)}`,
  );
}

function inconclusiveCredentialError(
  target: ComputeValidationTarget,
  error: unknown,
): TransientInfraError {
  return new TransientInfraError(
    `${target.config.cloudProvider} could not conclusively validate cloud credential ${credentialLabel(target)}: ${errorMessage(error)} Please retry.`,
  );
}

/**
 * Resolve the first healthy API-instance compute default.
 *
 * Provider validation is the capability probe: for Local it covers the fixed
 * smolvm endpoint and its cached boot/SSH smoke preflight. Errors are hidden
 * here because callers retain the ordinary credential-required rejection when
 * no implicit provider is available.
 */
export async function resolveAvailableImplicitComputeProvider(): Promise<
  CloudType | undefined
> {
  for (const cloudProvider of IMPLICIT_CREDENTIALLESS_COMPUTE_PROVIDERS) {
    const provider = computeProviderData(cloudProvider);
    try {
      await validateCredentials({
        cloudProvider,
        region: provider.defaultRegion,
        vmType: provider.defaultVmType,
      });
      return cloudProvider;
    } catch {
      // Try the next registered API-instance default, if one is added.
    }
  }
  return undefined;
}

export async function buildComputeValidationTargets(
  cloudConfig: CloudConfig,
  resolvedComputeCred: ResolvedComputeCredential | undefined,
  usingInlineCompute: boolean,
): Promise<ComputeValidationTarget[]> {
  if (resolvedComputeCred !== undefined) {
    return [
      {
        name: resolvedComputeCred.name,
        config: {
          ...cloudConfig,
          credentials: extractCredentials(resolvedComputeCred.creds),
          cloudProvider: resolvedComputeCred.cloudProvider,
        },
      },
    ];
  }

  if (usingInlineCompute) {
    return [
      {
        name: null,
        config: cloudConfig,
      },
    ];
  }

  if (
    cloudConfig.cloudProvider &&
    !requiresComputeCredentials(cloudConfig.cloudProvider)
  ) {
    return [
      {
        name: null,
        config: cloudConfig,
      },
    ];
  }

  throw new InvalidAnycloudConfigError(
    'Remote compute requires a selected credential. Pass --credentials or provide inline credentials.',
  );
}

async function validateComputeTargetLocally(
  target: ComputeValidationTarget,
): Promise<void> {
  let gateway;
  try {
    gateway = await validateCredentials(target.config);
  } catch (error) {
    // Preserve a provider's explicit Anycloud-domain decision, including
    // local credential-shape validation, before consulting its broad cloud
    // failure classifier.
    if (error instanceof DeployError) throw error;

    const classifier = createComputeProvider(target.config);
    const diagnosis = classifier.classifyError(error);
    if (diagnosis === CloudFailureDiagnosis.InvalidRequest) {
      throw invalidCredentialError(target, error);
    }
    if (diagnosis === CloudFailureDiagnosis.PermissionDenied) {
      throw new InvalidAnycloudConfigError(
        permissionDeniedMessage({
          cloud: target.config.cloudProvider,
          region: target.config.region,
          action: classifier.permissionDenial?.(error)?.action ?? null,
          credential: `credential ${credentialLabel(target)}`,
        }),
      );
    }
    if (diagnosis === CloudFailureDiagnosis.BadCredential) {
      // BadCredential also includes ambiguous responses such as AWS
      // AuthFailure and GCP UNAUTHENTICATED. Only a gateway's positive,
      // provider-specific terminal-secret signal makes this a user 400.
      if (
        canClassifyTerminalAuthError(classifier) &&
        classifier.isTerminalAuthError(error)
      ) {
        throw invalidCredentialError(target, error);
      }
      throw inconclusiveCredentialError(target, error);
    }
    // Transport evidence owns admission retryability even when a provider's
    // provisioning-oriented classifier gives the response a quota or capacity
    // diagnosis (for example Lambda's global/quota-exceeded body on HTTP 429).
    if (isExplicitlyRetryableValidationFailure(error, classifier)) {
      throw new TransientInfraError(
        `${target.config.cloudProvider} is temporarily unavailable while validating cloud credentials — please retry.`,
      );
    }
    throw error;
  }
  validateComputeCapabilities(target.config, gateway);
}

function assertIngressSupported(
  target: ComputeValidationTarget,
  ingressSpec: IngressSpec,
): void {
  const gateway = createComputeProvider(target.config);
  if (!canSupportIngress(gateway) || !gateway.supportsIngress(ingressSpec)) {
    throw new InvalidAnycloudConfigError(
      ingressUnsupportedMessage(target.config.cloudProvider),
    );
  }
}

export function selectIngressSupportedTargets(
  targets: ComputeValidationTarget[],
  ingressSpec: IngressSpec,
): ComputeValidationTarget[] {
  for (const target of targets) {
    assertIngressSupported(target, ingressSpec);
  }
  return targets;
}

/**
 * Whether every candidate target's substrate publishes a public endpoint for
 * service workloads. Drives the create response's `url`: the endpoint is
 * only advertised when it will actually exist once the server is Running.
 */
export function targetsPublishPublicEndpoint(
  targets: ComputeValidationTarget[],
): boolean {
  return (
    targets.length > 0 &&
    targets.every(
      (target) =>
        createComputeProvider(target.config).publishesPublicEndpoint?.() !==
        false,
    )
  );
}

export async function selectRequestShapeValidTargets(
  targets: ComputeValidationTarget[],
  targetRequest: ComputeTargetRequest,
  dockerOptions: DockerOptions | null | undefined,
): Promise<ComputeValidationTarget[]> {
  for (const target of targets) {
    await catalogReadiness.ensureCatalogReady(target.config.cloudProvider);
    validateTargetAvailability(target.config, targetRequest);
    validateProviderRequestShape(target.config, dockerOptions, targetRequest);
  }
  return targets;
}

export async function selectLocallyValidTargets(
  targets: ComputeValidationTarget[],
): Promise<ComputeValidationTarget[]> {
  for (const target of targets) {
    await validateComputeTargetLocally(target);
  }
  return targets;
}

/**
 * Validate storage against each selected workload target without constructing
 * its compute gateway.
 */
export function selectStorageValidTargets(
  targets: ComputeValidationTarget[],
): ComputeValidationTarget[] {
  for (const target of targets) {
    validateWorkloadStorageRequest(target.config);
  }
  return targets;
}
