import type { WorkloadAdmissionResponse } from '../../shared/api-contract/workload-admission-schemas.js';
import { getDiskForVMType } from '../../shared/catalog/queries.js';
import { resolveCheckpointTarget } from '../../shared/checkpoint.js';
import {
  cloudCredentialIdentityKey,
  validateNewBucketName,
  vmArchitecture,
} from '../../shared/cloud-config.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { archMismatchMessage } from '../../shared/error-formatter.js';
import {
  GithubSignInRequiredError,
  InvalidAnycloudConfigError,
  SERVICE_URL_NEEDS,
} from '../../shared/errors.js';
import { generateJobId } from '../../shared/id-generator.js';
import {
  bucketHostPathsForProvider,
  type BucketHostPaths,
} from '../../shared/providers.js';
import { type CloudConfig, type CloudCredentials } from '../../shared/cloud.js';
import { WorkloadType } from '../../shared/workload.js';
import {
  type ImageArchitecture,
  ImageInspectionFailureReason,
  ImageVerdict,
} from '../../shared/image.js';
import { toArray } from '../../shared/utils.js';
import { validateId } from './workload-admission-checks.js';
import {
  createCheckpointStorageProvider,
  createInputStorageProvider,
  createOutputStorageProvider,
} from './cloud-config.js';
import {
  buildComputeValidationTargets,
  selectIngressSupportedTargets,
  selectLocallyValidTargets,
  selectRequestShapeValidTargets,
  selectStorageValidTargets,
  targetsPublishPublicEndpoint,
  type ComputeValidationTarget,
} from './compute-validation.js';
import type { ResolvedWorkloadAdmission } from './workload-admission-resolution.js';
import {
  validateImplicitCheckpointName,
  validateWorkloadBucketRoles,
} from './workload-bucket-validation.js';
import {
  bucketExistsForRequest,
  normalizeAttribution,
  preflightRuntimeSecrets,
} from './workload-operation-helpers.js';
import type { CreateWorkloadInput } from './repositories/workload-creation.js';
import { DockerManager } from './docker.js';
import { SSHManager } from './gateways/ssh.js';
import { inspectImage } from '../../shared/image-registry.js';
import { GHCR_TOKEN_USERNAME } from '../../shared/image.js';
import { buildServeIngressSpec } from './network.js';
import { serveUrl } from './serve.js';
import { privateImageMessage } from './image-manifest.js';

const DISK_SIZE_GB_BYTES = 1_000_000_000;
const requestShapeValidatedTargetsBrand: unique symbol = Symbol(
  'RequestShapeValidatedTargets',
);
const computeValidatedTargetsBrand: unique symbol = Symbol(
  'ComputeValidatedTargets',
);
const storageValidatedTargetsBrand: unique symbol = Symbol(
  'StorageValidatedTargets',
);
const workloadCreationPlanBrand: unique symbol = Symbol('WorkloadCreationPlan');

type ImageDiskLimit =
  | { source: 'explicit'; sizeGb: number }
  | { source: 'catalog'; sizeGb: number; vmType: string };

interface RequestShapeValidatedTargets {
  readonly [requestShapeValidatedTargetsBrand]: true;
  readonly values: ComputeValidationTarget[];
}

interface ComputeValidatedTargets {
  readonly [computeValidatedTargetsBrand]: true;
  readonly values: ComputeValidationTarget[];
}

interface StorageValidatedTargets {
  readonly [storageValidatedTargetsBrand]: true;
  readonly values: ComputeValidationTarget[];
}

type PreparedWorkloadInput = Omit<
  CreateWorkloadInput,
  | 'credentialId'
  | 'inputStorageCredentialId'
  | 'outputStorageCredentialId'
  | 'checkpointStorageCredentialId'
>;

export interface AdmissionProgress {
  finalId?: string;
}

/**
 * A fully admitted workload. Only this module can construct the private
 * brand, and only the persistence stage may consume the resulting plan.
 */
export interface WorkloadCreationPlan {
  readonly [workloadCreationPlanBrand]: true;
  readonly workload: PreparedWorkloadInput;
  readonly response: WorkloadAdmissionResponse;
  readonly resolvedComputeCredentialId?: string;
  readonly inlineComputeCredentials?: CloudCredentials;
  readonly inputStorageCredentials?: CloudCredentials;
  readonly outputStorageCredentials?: CloudCredentials;
  readonly checkpointStorageCredentials?: CloudCredentials;
}

type StorageValidationTarget = Pick<ComputeValidationTarget, 'name' | 'config'>;

function resolveImageDiskLimit(
  cloudConfig: Partial<
    Pick<CloudConfig, 'cloudProvider' | 'diskSizeGb' | 'vmType'>
  >,
): ImageDiskLimit | null {
  if (typeof cloudConfig.diskSizeGb === 'number') {
    return { source: 'explicit', sizeGb: cloudConfig.diskSizeGb };
  }
  if (
    typeof cloudConfig.cloudProvider !== 'string' ||
    typeof cloudConfig.vmType !== 'string'
  ) {
    return null;
  }
  const catalogDisk = getDiskForVMType(
    cloudConfig.cloudProvider,
    cloudConfig.vmType,
  );
  if (
    !catalogDisk ||
    !Number.isFinite(catalogDisk.totalGb) ||
    catalogDisk.totalGb <= 0
  ) {
    return null;
  }
  return {
    source: 'catalog',
    sizeGb: catalogDisk.totalGb,
    vmType: cloudConfig.vmType,
  };
}

function imageDiskLimitMessage(limit: ImageDiskLimit): string {
  if (limit.source === 'explicit') {
    return `which exceeds the requested ${limit.sizeGb} GB disk. Increase --disk-size.`;
  }
  return (
    `which exceeds the ${limit.sizeGb} GB catalog disk for VM type "${limit.vmType}". ` +
    'Choose a VM type with a larger disk or pass --disk-size.'
  );
}

function imageAccessMessage(
  image: string,
  failureReason?: ImageInspectionFailureReason,
): string {
  if (failureReason === ImageInspectionFailureReason.GhcrTokenExchangeFailed) {
    return (
      `Can't access image "${image}". anycloud authenticated to GitHub, but GHCR rejected the package pull token request. ` +
      'To sign in again, run `anycloud login` (`anycloud login <api-url>` on a hosted API), and verify the token has read access to this GHCR package.'
    );
  }
  return privateImageMessage(image);
}

function outputStorageIdentityKey({
  name,
  config,
}: StorageValidationTarget): string {
  return cloudCredentialIdentityKey(
    config.cloudProvider,
    config.credentials as Record<string, string> | undefined,
    name ?? 'inline',
  );
}

export function selectOutputStorageValidationTargets<
  T extends StorageValidationTarget,
>(targets: T[]): T[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = outputStorageIdentityKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function validateRequestShapeTargets(
  resolved: ResolvedWorkloadAdmission,
): Promise<{
  targets: RequestShapeValidatedTargets;
  ingressSpec: ReturnType<typeof buildServeIngressSpec> | undefined;
}> {
  const { cloudConfig, input, requestedWorkloadType } = resolved;
  let validationTargets = await buildComputeValidationTargets(
    cloudConfig,
    resolved.resolvedComputeCredential,
    resolved.usingInlineCompute,
  );
  const ingressSpec =
    requestedWorkloadType === WorkloadType.Service
      ? buildServeIngressSpec()
      : undefined;
  if (ingressSpec) {
    validationTargets = selectIngressSupportedTargets(
      validationTargets,
      ingressSpec,
    );
  }

  const gpuTypes = toArray(input.gpuType);
  const vmTypes = toArray(cloudConfig.vmType);
  if (gpuTypes.length > 0 && vmTypes.length > 0) {
    throw new InvalidAnycloudConfigError(
      'Cannot specify both gpuType and vmType. Use one or the other.',
    );
  }
  if (vmTypes.length === 0 && gpuTypes.length === 0) {
    throw new InvalidAnycloudConfigError(
      'A VM type or GPU type is required. Specify vmType or gpuType in your cloud config.',
    );
  }

  const values = await selectRequestShapeValidTargets(
    validationTargets,
    { gpuTypes, vmTypes },
    input.dockerOptions,
  );

  return {
    targets: { [requestShapeValidatedTargetsBrand]: true, values },
    ingressSpec,
  };
}

async function validateComputeTargets(
  resolved: ResolvedWorkloadAdmission,
  targets: RequestShapeValidatedTargets,
): Promise<ComputeValidatedTargets> {
  const values = await selectLocallyValidTargets(targets.values);
  return { [computeValidatedTargetsBrand]: true, values };
}

function validateStorageTargets(
  targets: ComputeValidatedTargets,
): StorageValidatedTargets {
  return {
    [storageValidatedTargetsBrand]: true,
    values: selectStorageValidTargets(targets.values),
  };
}

async function validateRemoteBuckets(
  cloudConfig: CloudConfig,
  targets: StorageValidatedTargets,
): Promise<void> {
  if (cloudConfig.inputBucket && !cloudConfig.inputStorageCredentials) {
    for (const { name, config } of targets.values) {
      if (
        !(await bucketExistsForRequest(
          createInputStorageProvider(config),
          cloudConfig.inputBucket,
        ))
      ) {
        throw new InvalidAnycloudConfigError(
          `Input bucket "${cloudConfig.inputBucket}" not found in credential "${name ?? 'inline'}" (${config.cloudProvider}). Create the bucket there or choose another credential.`,
        );
      }
    }
  }

  if (cloudConfig.outputBucket && !cloudConfig.outputStorageCredentials) {
    const outputBucket = cloudConfig.outputBucket;
    const outputTargets = selectOutputStorageValidationTargets(targets.values);
    if (outputTargets.length > 1) {
      const presence = await Promise.all(
        outputTargets.map(async ({ name, config }) => ({
          name: name ?? 'inline',
          cloud: config.cloudProvider,
          exists: await bucketExistsForRequest(
            createOutputStorageProvider(config),
            outputBucket,
          ),
        })),
      );
      const present = presence.filter((entry) => entry.exists);
      if (present.length > 0 && present.length < presence.length) {
        const format = (entry: (typeof presence)[number]) =>
          `${entry.name} (${entry.cloud})`;
        throw new InvalidAnycloudConfigError(
          `Output bucket "${outputBucket}" must exist in every selected credential or none. Present in: ${present
            .map(format)
            .join(', ')}. Missing in: ${presence
            .filter((entry) => !entry.exists)
            .map(format)
            .join(', ')}.`,
        );
      }
    }
  }

  // A missing output bucket is created, so its name must be creatable too.
  if (cloudConfig.outputBucket) {
    const outputBucket = cloudConfig.outputBucket;
    const configs = cloudConfig.outputStorageCredentials
      ? [cloudConfig]
      : selectOutputStorageValidationTargets(targets.values).map(
          (target) => target.config,
        );
    for (const config of configs) {
      try {
        validateNewBucketName(
          config.outputStorageCredentials?.cloudProvider ??
            config.cloudProvider,
          outputBucket,
        );
      } catch (error) {
        if (
          await bucketExistsForRequest(
            createOutputStorageProvider(config),
            outputBucket,
          )
        ) {
          continue;
        }
        throw new InvalidAnycloudConfigError(
          `Output bucket "${outputBucket}" does not exist, and Anycloud cannot create it. ${errorMessage(error)}`,
        );
      }
    }
  }

  if (cloudConfig.checkpointBucket) {
    const storage = createCheckpointStorageProvider(cloudConfig);
    if (
      !(await bucketExistsForRequest(storage, cloudConfig.checkpointBucket))
    ) {
      throw new InvalidAnycloudConfigError(
        `Checkpoint bucket "${cloudConfig.checkpointBucket}" not found. Create it before deploying.`,
      );
    }
  }
}

function workloadBucketHostPaths(
  finalId: string,
  cloudConfig: CloudConfig,
): Partial<BucketHostPaths> {
  const bucketHostPaths = bucketHostPathsForProvider(cloudConfig.cloudProvider);
  return {
    input: cloudConfig.inputBucket ? bucketHostPaths.input : undefined,
    output: cloudConfig.outputBucket ? bucketHostPaths.output : undefined,
    checkpoint: resolveCheckpointTarget(finalId, cloudConfig)
      ? bucketHostPaths.checkpoint
      : undefined,
  };
}

/**
 * The CPU architecture the requested VM types share; a GPU request runs on
 * amd64. A Job pins one image build, so a list can't mix architectures.
 */
function requestedArchitecture(
  vmTypes: string[],
  targets: readonly ComputeValidationTarget[],
): ImageArchitecture {
  const arm64 = vmTypes.filter((vmType) =>
    targets.some(
      ({ config }) => vmArchitecture(config.cloudProvider, vmType) === 'arm64',
    ),
  );
  if (arm64.length === 0) return 'amd64';
  const amd64 = vmTypes.filter((vmType) => !arm64.includes(vmType));
  if (amd64.length > 0) {
    throw new InvalidAnycloudConfigError(
      `The VM type list mixes arm64 (${arm64.join(', ')}) and amd64 (${amd64.join(', ')}); list types of one architecture.`,
    );
  }
  return 'arm64';
}

/** Run every semantic admission check and produce the only persistable value. */
export async function prepareWorkloadCreation(args: {
  resolved: ResolvedWorkloadAdmission;
  progress: AdmissionProgress;
  signal?: AbortSignal;
}): Promise<WorkloadCreationPlan> {
  const { resolved, progress, signal } = args;
  const { actor, input, cloudConfig, requestedWorkloadType } = resolved;

  const { targets: requestShapeTargets, ingressSpec } =
    await validateRequestShapeTargets(resolved);
  // Before any cloud call: a public URL needs the caller's GitHub sign-in.
  if (
    ingressSpec !== undefined &&
    !actor.token &&
    targetsPublishPublicEndpoint(requestShapeTargets.values)
  ) {
    throw GithubSignInRequiredError.needs(SERVICE_URL_NEEDS);
  }
  const architecture = requestedArchitecture(
    toArray(cloudConfig.vmType),
    requestShapeTargets.values,
  );
  await preflightRuntimeSecrets(input.secrets);
  signal?.throwIfAborted();

  const {
    verdict: imageVerdict,
    digest,
    imageRuntime,
    compressedLayerBytes,
    failureReason: imageFailureReason,
  } = await inspectImage(input.image, actor.token, architecture);
  if (imageVerdict === ImageVerdict.NoPlatform) {
    throw new InvalidAnycloudConfigError(
      archMismatchMessage(input.image, architecture),
    );
  }
  if (imageVerdict === ImageVerdict.NotFound) {
    throw new InvalidAnycloudConfigError(
      `Image "${input.image}" not found — check the reference and that it's pushed.`,
    );
  }
  if (imageVerdict === ImageVerdict.Unauthorized) {
    throw new InvalidAnycloudConfigError(
      imageAccessMessage(input.image, imageFailureReason),
    );
  }
  const imageDiskLimit = resolveImageDiskLimit(cloudConfig);
  if (
    imageDiskLimit &&
    compressedLayerBytes !== null &&
    compressedLayerBytes > imageDiskLimit.sizeGb * DISK_SIZE_GB_BYTES
  ) {
    throw new InvalidAnycloudConfigError(
      `Image "${input.image}" has at least ${Math.ceil(
        compressedLayerBytes / DISK_SIZE_GB_BYTES,
      )} GB of compressed layers, ${imageDiskLimitMessage(imageDiskLimit)}`,
    );
  }

  const imageDigest = digest ?? undefined;
  const finalId = await validateId(input.id || generateJobId(input.image));
  validateImplicitCheckpointName(finalId, cloudConfig);
  progress.finalId = finalId;
  const { privateKey: sshPrivateKey } = await SSHManager.generateKeypair();

  const computeTargets = await validateComputeTargets(
    resolved,
    requestShapeTargets,
  );
  // Storage admission is deliberately outside the placement branch: cluster
  // workloads skip local compute validation, but never storage validation.
  const admittedTargets = validateStorageTargets(computeTargets);
  const publishesPublicEndpoint =
    ingressSpec !== undefined &&
    targetsPublishPublicEndpoint(admittedTargets.values);

  await validateRemoteBuckets(cloudConfig, admittedTargets);

  const effectiveCommand = input.command;
  const effectiveEnv = input.env;
  const dockerCommand = DockerManager.getCommand(
    {
      id: finalId,
      workloadType: requestedWorkloadType,
      image: input.image,
      registryUsername: GHCR_TOKEN_USERNAME,
      userId: actor.username,
      env: effectiveEnv ?? null,
      dockerOptions: input.dockerOptions ?? null,
      command: effectiveCommand ?? null,
      secretNames: input.secrets ?? null,
      imageDigest: imageDigest ?? null,
      hostDocker: input.hostDocker === true,
      requireNestedVirtualization: input.requireNestedVirtualization === true,
    },
    workloadBucketHostPaths(finalId, cloudConfig),
    true,
  );

  const workload: PreparedWorkloadInput = {
    id: finalId,
    userId: actor.username,
    ownerUserId: actor.id,
    workloadType: requestedWorkloadType,
    image: input.image,
    region: cloudConfig.region,
    vmType: cloudConfig.vmType,
    gpuType: input.gpuType,
    spot: cloudConfig.spot,
    dockerCommand,
    inputBucket: cloudConfig.inputBucket,
    outputBucket: cloudConfig.outputBucket,
    checkpointBucket: cloudConfig.checkpointBucket,
    diskSizeGb: cloudConfig.diskSizeGb,
    diskTier: cloudConfig.diskTier,
    diskIops: cloudConfig.diskIops,
    diskThroughputMibps: cloudConfig.diskThroughputMibps,
    regions: cloudConfig.regions,
    dockerOptions: input.dockerOptions,
    availabilityZone: cloudConfig.availabilityZone,
    env: effectiveEnv,
    githubToken: actor.token ?? undefined,
    sshPrivateKey,
    requestedComputeProvider: resolved.requestedCredentiallessCompute,
    inputStorageRegion: cloudConfig.inputStorageRegion,
    outputStorageRegion: cloudConfig.outputStorageRegion,
    checkpointStorageRegion: cloudConfig.checkpointStorageRegion,
    command: effectiveCommand,
    imageDigest,
    imageRuntime,
    secretNames: input.secrets,
    session: normalizeAttribution(input.session) ?? undefined,
    agent: normalizeAttribution(input.agent) ?? undefined,
    sessionLabel: normalizeAttribution(input.sessionLabel) ?? undefined,
    maxRetries: input.maxRetries,
    noCheckpoint: input.noCheckpoint || undefined,
    requireNestedVirtualization: input.requireNestedVirtualization || undefined,
    hostDocker: input.hostDocker || undefined,
  };

  signal?.throwIfAborted();
  // Keep the store's defensive check too, but reject here before credential
  // upserts so every semantic failure is side-effect free.
  validateWorkloadBucketRoles(workload);

  return {
    [workloadCreationPlanBrand]: true,
    workload,
    response: {
      id: finalId,
      ...(publishesPublicEndpoint ? { url: serveUrl(finalId) } : {}),
    },
    resolvedComputeCredentialId: resolved.resolvedComputeCredential?.id,
    inlineComputeCredentials: resolved.inlineComputeCredentials,
    inputStorageCredentials: cloudConfig.inputStorageCredentials,
    outputStorageCredentials: cloudConfig.outputStorageCredentials,
    checkpointStorageCredentials: cloudConfig.checkpointStorageCredentials,
  };
}
