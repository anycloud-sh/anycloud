import type {
  DedicatedWorkloadAdmissionInput,
  WorkloadAdmissionResponse,
} from '../../shared/api-contract/workload-admission-schemas.js';
import {
  GithubSignInRequiredError,
  InvalidAnycloudConfigError,
  SERVICE_URL_NEEDS,
  WorkloadIdExistsError,
} from '../../shared/errors.js';
import { isHostedApiImage } from '../../shared/hosted-api.js';
import { generateJobId } from '../../shared/id-generator.js';
import { NodePoolState } from '../../shared/node-pools.js';
import { toArray } from '../../shared/utils.js';
import { WorkloadType } from '../../shared/workload.js';
import type { User } from './entities.js';
import type { ImageInspection } from '../../shared/image-registry.js';
import {
  nodePoolGpusPerNode,
  resolveNodePoolGpuCount,
  validateKubernetesDockerOptions,
} from './kubernetes/pod-options.js';
import type { NodePoolRepository } from './cluster-store.js';
import {
  assertNodePoolImage,
  refusePrivilegedOnUserNamespacePool,
  resolveReadyNodePool,
  type NodePoolRefusal,
} from './node-pool-admission.js';
import { resolveServiceContainerPort } from './network.js';
import type { NodePoolCapacityObservation } from './node-pool-controller.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import { normalizeAttribution } from './workload-operation-helpers.js';
import type { CreateWorkloadInput } from './repositories/workload-creation.js';
import { serveUrl } from './serve.js';
import { assertDefaultJobSpec } from './job-spec-admission.js';

export interface NodePoolServiceAdmissionDependencies {
  nodePools: Pick<NodePoolRepository, 'getForScope' | 'getByNameForScope'>;
  resolveScope(actor: User): Promise<OwnershipScope>;
  /** Live capacity of the node pool; the Service needs one ready VM. */
  observeCapacity(nodePoolId: string): Promise<NodePoolCapacityObservation>;
  /** Fresh identity, permission and version check of the node pool's cluster. */
  assertClusterCompatible(
    clusterId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  inspectImage(image: string, token: string | null): Promise<ImageInspection>;
  preflightSecrets(secretNames: readonly string[] | undefined): Promise<void>;
  validateId(id: string): Promise<string>;
  /** Admission-only durable write; the plan is complete when it is called. */
  persist(workload: CreateWorkloadInput): Promise<void>;
}

export type NodePoolServiceAdmissionInput = DedicatedWorkloadAdmissionInput & {
  nodePool: string;
};

export function isWorkloadIdConstraint(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes('UNIQUE constraint failed: workloads.id') ||
      error.message.includes('workload identity already exists'))
  );
}

function isNodePoolAcceptanceConstraint(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.includes('node pool does not accept Services')
  );
}

/**
 * The first option a node pool workload may not select: a node pool owns
 * provider, credential, region, zone and VM type. Refusing them keeps a later
 * release from silently changing what an admitted workload means.
 */
export function nodePoolOwnedOption(
  input: NodePoolServiceAdmissionInput,
): string | undefined {
  const cloudConfig = input.cloudConfig;
  const rejected: Array<[boolean, string]> = [
    [
      Boolean(input.credentialName || cloudConfig.credentials),
      'compute credentials (the node pool owns its credential)',
    ],
    [Boolean(cloudConfig.cloudProvider), 'cloudProvider'],
    [Boolean(cloudConfig.region), '--region'],
    [toArray(cloudConfig.vmType).length > 0, '--vm-type'],
    [toArray(input.gpuType).length > 0, '--gpu-type'],
    [Boolean(cloudConfig.spot), '--spot'],
    [Boolean(cloudConfig.availabilityZone), '--zone'],
    [cloudConfig.diskSizeGb !== undefined, '--disk-size'],
    [cloudConfig.diskTier !== undefined, '--disk-tier'],
    [
      cloudConfig.minVmCount !== undefined ||
        cloudConfig.maxVmCount !== undefined,
      'VM counts',
    ],
  ];
  return rejected.find(([present]) => present)?.[1];
}

/**
 * Bucket and storage options, which a Service on a node pool never takes;
 * pool Jobs take buckets through RFC 0043.
 */
function nodePoolStorageOption(
  input: NodePoolServiceAdmissionInput,
): string | undefined {
  const cloudConfig = input.cloudConfig;
  const rejected: Array<[boolean, string]> = [
    [
      Boolean(cloudConfig.inputBucket || cloudConfig.outputBucket),
      'input/output buckets',
    ],
    [
      Boolean(
        input.inputStorageCredentialName ||
          input.outputStorageCredentialName ||
          cloudConfig.inputStorageCredentials ||
          cloudConfig.outputStorageCredentials ||
          cloudConfig.inputStorageRegion ||
          cloudConfig.outputStorageRegion,
      ),
      'input/output storage credentials',
    ],
    [
      Boolean(
        cloudConfig.checkpointBucket ||
          input.checkpointStorageCredentialName ||
          cloudConfig.checkpointStorageCredentials ||
          cloudConfig.checkpointStorageRegion,
      ),
      'checkpoint storage',
    ],
  ];
  return rejected.find(([present]) => present)?.[1];
}

/** Refuse what a Service on a node pool can't take, before any I/O. */
export function assertNodePoolServiceShape(
  input: NodePoolServiceAdmissionInput,
): void {
  if (input.workloadType !== WorkloadType.Service) {
    throw new InvalidAnycloudConfigError(
      'Only Services and Jobs can target a node pool.',
    );
  }
  if (isHostedApiImage(input.image)) {
    throw new InvalidAnycloudConfigError(
      'The hosted API is installed on the cluster as a system installation, not as a Service on a node pool.',
    );
  }
  const offending = nodePoolOwnedOption(input) ?? nodePoolStorageOption(input);
  if (offending) {
    throw new InvalidAnycloudConfigError(
      `A Service on a node pool does not accept ${offending}.`,
    );
  }
  assertDefaultJobSpec(input, 'A Service on a node pool');
  validateKubernetesDockerOptions(input.dockerOptions, 'Service');
  resolveServiceContainerPort(input.env);
}

/** Why a named node pool can't take `workloads`, worded for the caller. */
export function nodePoolRefusal(identifier: string, workloads: string) {
  return (refusal: NodePoolRefusal): Error => {
    if (refusal.kind === 'missing' || refusal.kind === NodePoolState.Deleted) {
      return new InvalidAnycloudConfigError(
        `Node pool "${identifier}" not found`,
      );
    }
    const { name, lastError } = refusal.nodePool;
    const why =
      refusal.kind === NodePoolState.Creating
        ? 'is still provisioning; retry once it is running'
        : refusal.kind === NodePoolState.Failed
          ? `has failed${lastError ? `: ${lastError}` : ''}`
          : `is terminated and does not accept ${workloads}`;
    return new InvalidAnycloudConfigError(`Node pool "${name}" ${why}`);
  };
}

/** Admit one ordinary Service Workload onto an explicit node pool. */
export async function submitNodePoolService(
  dependencies: NodePoolServiceAdmissionDependencies,
  actor: User,
  input: NodePoolServiceAdmissionInput,
  signal?: AbortSignal,
): Promise<WorkloadAdmissionResponse> {
  assertNodePoolServiceShape(input);
  if (!actor.token) throw GithubSignInRequiredError.needs(SERVICE_URL_NEEDS);
  signal?.throwIfAborted();

  const scope = await dependencies.resolveScope(actor);
  const nodePool = await resolveReadyNodePool(
    dependencies.nodePools,
    input.nodePool,
    scope,
    nodePoolRefusal(input.nodePool, 'Services'),
  );
  // As for a Deployment handler, a Service Pod on NVIDIA capacity requests
  // every GPU of one pool VM unless `--gpus N` takes fewer. The resolved
  // count is stored, so a catalog refresh never changes an admitted Service.
  refusePrivilegedOnUserNamespacePool(
    input.dockerOptions,
    nodePool,
    'Services',
  );
  const gpuCount = resolveNodePoolGpuCount(
    input.dockerOptions,
    nodePool,
    'Services on a node pool',
  );
  const dockerOptions =
    gpuCount > 0
      ? { ...input.dockerOptions, gpus: String(gpuCount) }
      : input.dockerOptions;
  const capacity = await dependencies.observeCapacity(nodePool.id);
  if (capacity.readyVmCount < 1) {
    throw new InvalidAnycloudConfigError(
      `Node pool "${nodePool.name}" has no ready capacity (${capacity.startingVmCount} VM(s) starting)`,
    );
  }
  try {
    await dependencies.assertClusterCompatible(nodePool.clusterId, signal);
  } catch {
    // The cluster diagnostic can name connection details; admission reports a
    // fixed message, as node pool creation does.
    signal?.throwIfAborted();
    throw new InvalidAnycloudConfigError(
      `Node pool "${nodePool.name}": its cluster could not be verified for Service admission`,
    );
  }

  await dependencies.preflightSecrets(input.secrets);
  signal?.throwIfAborted();
  const inspection = await dependencies.inspectImage(input.image, actor.token);
  assertNodePoolImage(input.image, inspection, nodePool);
  const { amd64Digest, imageRuntime } = inspection;

  const id = await dependencies.validateId(
    input.id || generateJobId(input.image),
  );
  signal?.throwIfAborted();
  try {
    await dependencies.persist({
      id,
      userId: actor.username,
      ownerUserId: actor.id,
      workloadType: WorkloadType.Service,
      image: input.image,
      // Native execution renders its Pod template from the container spec;
      // no Docker command or SSH key exists for a Service on a node pool. The
      // Workload's cloud is derived from the node pool's credential, so no
      // compute provider or credential is stored here.
      dockerCommand: '',
      sshPrivateKey: '',
      nodePoolId: nodePool.id,
      // Judged in the transaction that stores the Service, as for Deployments.
      nodePoolGpuBound:
        gpuCount > 0
          ? capacity.readyVmCount * nodePoolGpusPerNode(nodePool)
          : undefined,
      dockerOptions,
      env: input.env,
      githubToken: actor.token ?? undefined,
      command: input.command,
      imageDigest: amd64Digest ?? undefined,
      imageRuntime,
      secretNames: input.secrets,
      session: normalizeAttribution(input.session) ?? undefined,
      agent: normalizeAttribution(input.agent) ?? undefined,
      sessionLabel: normalizeAttribution(input.sessionLabel) ?? undefined,
    });
  } catch (error) {
    if (isWorkloadIdConstraint(error)) throw new WorkloadIdExistsError();
    if (String(error).includes('node pool GPU capacity is reserved')) {
      throw new InvalidAnycloudConfigError(
        `Node pool "${nodePool.name}" ready GPU capacity is reserved by its Deployments and Services; this Service needs ${gpuCount} GPU(s)`,
      );
    }
    if (isNodePoolAcceptanceConstraint(error)) {
      throw new InvalidAnycloudConfigError(
        `Node pool "${nodePool.name}" stopped accepting Services before the request was stored`,
      );
    }
    throw error;
  }
  // The public URL is the Service's from admission on, as for VM-host
  // Services; the record is published once the pool's ingress serves it.
  return { id, url: serveUrl(id) };
}
