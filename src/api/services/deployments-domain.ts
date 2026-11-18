import { errorMessage } from '../../shared/log-diagnostics.js';
import type { DockerOptions } from '../../shared/runtime.js';
import type {
  DeploymentResponse,
  DeploymentSummary,
  CreateDeploymentRequest,
  ListDeploymentsResponse,
  UpdateDeploymentRequest,
} from '../../shared/api-contract/deployments-schemas.js';
import type { User } from './entities.js';
import { DeploymentDomainError } from './deployment-errors.js';
import { unclaimableWorkloadApiUrl } from './workload-api-url.js';
import type {
  DeploymentRepository,
  DeploymentTarget,
  StoredDeployment,
} from './deployment-store.js';
import type { NodePoolRepository, StoredNodePool } from './cluster-store.js';
import type { NodePoolCapacityObservation } from './node-pool-controller.js';
import {
  assertNodePoolImage,
  refusePrivilegedOnUserNamespacePool,
  resolveReadyNodePool,
  type NodePoolRefusal,
} from './node-pool-admission.js';
import { NodePoolState } from '../../shared/node-pools.js';
import type { ContainerSpec } from './container-spec.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import type { ImageInspection } from '../../shared/image-registry.js';
import { GHCR_TOKEN_USERNAME } from '../../shared/image.js';
import {
  nodePoolGpusPerNode,
  resolveKubernetesRuntimeClass,
  resolveNodePoolGpuCount,
  validateKubernetesDockerOptions,
} from './kubernetes/pod-options.js';
import { KubernetesRbacPreflightError } from './kubernetes/preflight.js';
import {
  deriveDeploymentStatus,
  type DeploymentObservation,
  type DeploymentRuntimeObservation,
} from './deployment-status.js';
import type { TargetedJobStatusSnapshot } from './repositories/deployment-executions.js';
import {
  assertRequestActive,
  awaitWithSignal,
  registerRequestDeadline,
} from './request-budget.js';

interface DeploymentJobCounts {
  queued: number;
  running: number;
  retrying: number;
  terminal: number;
  unreleased: number;
}

export interface DeploymentControl {
  schedule(id: string): void;
  validateTarget(target: DeploymentTarget, signal?: AbortSignal): Promise<void>;
  observe(
    deployment: StoredDeployment,
    signal?: AbortSignal,
  ): Promise<DeploymentRuntimeObservation>;
}

interface DeploymentJobs {
  counts(deploymentId: string): Promise<DeploymentJobCounts>;
  statusSnapshot(deploymentId: string): Promise<TargetedJobStatusSnapshot>;
  terminateUnassigned(deploymentId: string): Promise<void>;
}

export interface DeploymentsDomainDependencies {
  deployments: DeploymentRepository;
  nodePools: Pick<NodePoolRepository, 'getForScope' | 'getByNameForScope'>;
  jobs: DeploymentJobs;
  runtime: DeploymentControl;
  /** Live ready-Node count of a node pool, from its cluster. */
  observeNodePoolCapacity(
    nodePoolId: string,
  ): Promise<NodePoolCapacityObservation>;
  resolveScope(actor: User): Promise<OwnershipScope>;
  generateId(name: string): string;
  inspectImage(
    image: string,
    githubToken: string | null,
  ): Promise<ImageInspection>;
  /** Throws `InvalidAnycloudConfigError` for a name with no saved Secret. */
  preflightSecrets(secretNames: readonly string[]): Promise<void>;
  /** The origin replicas claim Jobs from (`getWorkloadApiUrl`). */
  workloadApiUrl(): string;
}

export interface DeploymentsDomain {
  create(
    actor: User,
    input: CreateDeploymentRequest,
    signal?: AbortSignal,
  ): Promise<DeploymentResponse>;
  list(
    actor: User,
    filter?: { nodePool?: string },
    signal?: AbortSignal,
  ): Promise<ListDeploymentsResponse>;
  get(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<DeploymentResponse>;
  update(
    actor: User,
    identifier: string,
    input: UpdateDeploymentRequest,
    signal?: AbortSignal,
  ): Promise<DeploymentResponse>;
  delete(
    actor: User,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<DeploymentResponse>;
}

async function validateTarget(
  target: DeploymentTarget,
  dependencies: DeploymentsDomainDependencies,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await dependencies.runtime.validateTarget(target, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DeploymentDomainError) throw error;
    if (error instanceof KubernetesRbacPreflightError) {
      throw new DeploymentDomainError(error.message, 400);
    }
    throw new DeploymentDomainError(
      `Kubernetes Deployment validation failed: ${errorMessage(error)}`,
      503,
    );
  }
}

async function validateImage(
  image: string,
  githubToken: string | null,
  inspect: DeploymentsDomainDependencies['inspectImage'],
  nodePool: StoredNodePool,
): Promise<Pick<ContainerSpec, 'imageDigest'>> {
  const inspection = await inspect(image, githubToken);
  assertNodePoolImage(image, inspection, nodePool);
  return { imageDigest: inspection.amd64Digest ?? null };
}

const DEPLOYMENT_REFUSALS: Record<
  Exclude<NodePoolRefusal['kind'], 'missing'>,
  string
> = {
  [NodePoolState.Creating]: 'is provisioning; wait until it is running',
  [NodePoolState.Failed]: 'is failed and cannot accept Deployments',
  [NodePoolState.Deleting]: 'is terminated and cannot accept Deployments',
  [NodePoolState.Deleted]: 'is terminated and cannot accept Deployments',
};

function deploymentRefusal(identifier: string) {
  return ({ kind }: NodePoolRefusal): Error =>
    kind === 'missing'
      ? new DeploymentDomainError(
          `Node pool "${identifier}" was not found`,
          400,
        )
      : new DeploymentDomainError(
          `Node pool "${identifier}" ${DEPLOYMENT_REFUSALS[kind]}`,
          409,
        );
}

/**
 * Reserve against the node pool's ready Nodes: a Deployment needs at least
 * one ready Node, and a GPU Deployment needs its devices to fit alongside the
 * live reservations of its siblings. The bound is re-checked in the insert.
 */
async function reserveNodePoolCapacity(
  nodePool: StoredNodePool,
  gpuCount: number,
  dependencies: DeploymentsDomainDependencies,
  signal?: AbortSignal,
): Promise<{ maxGpus: number } | undefined> {
  let observed: NodePoolCapacityObservation;
  try {
    observed = await dependencies.observeNodePoolCapacity(nodePool.id);
  } catch (error) {
    signal?.throwIfAborted();
    // Fail closed with a named refusal: an unreachable cluster is not "no
    // ready Nodes", and the caller can retry once the cluster answers.
    throw new DeploymentDomainError(
      `Node pool "${nodePool.name}" ready capacity could not be observed on its cluster; retry when the cluster is reachable: ${errorMessage(error)}`,
      503,
    );
  }
  if (observed.readyVmCount === 0) {
    throw new DeploymentDomainError(
      `Node pool "${nodePool.name}" has no ready Nodes to run this Deployment`,
      409,
    );
  }
  if (gpuCount === 0) return undefined;
  const perNode = nodePoolGpusPerNode(nodePool);
  return { maxGpus: observed.readyVmCount * perNode };
}

async function targetNodePool(
  stored: StoredDeployment,
  dependencies: DeploymentsDomainDependencies,
): Promise<StoredNodePool> {
  const nodePool = await dependencies.nodePools.getForScope(stored.nodePoolId, {
    kind: 'api',
  });
  if (!nodePool) {
    throw new DeploymentDomainError(
      'GPU capacity cannot be verified because the node pool no longer exists',
      400,
    );
  }
  return nodePool;
}

function targetOf(stored: StoredDeployment): DeploymentTarget {
  return { kind: 'nodePool', nodePoolId: stored.nodePoolId };
}

function updatedDockerOptions(
  current: DockerOptions | null,
  input: UpdateDeploymentRequest,
): DockerOptions | null {
  if (input.dockerOptions === undefined) return current;
  if (input.dockerOptions === null) return null;
  const supplied = Object.fromEntries(
    Object.entries(input.dockerOptions).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return Object.fromEntries(
    Object.entries({ ...current, ...supplied }).filter(
      ([, value]) => value !== null,
    ),
  );
}

async function observeStatus(
  stored: StoredDeployment,
  dependencies: DeploymentsDomainDependencies,
  signal?: AbortSignal,
): Promise<DeploymentObservation> {
  assertRequestActive(signal);
  if (stored.deletedAt !== null) return { kind: 'not-requested' };
  const controller = new AbortController();
  const deadlineAt = performance.now() + 1_000;
  const expire = () =>
    controller.abort(
      new Error('Deployment observation exceeded its one-second deadline'),
    );
  const cancelled = () => controller.abort(signal?.reason);
  registerRequestDeadline(controller.signal, deadlineAt, expire);
  const timer = setTimeout(expire, Math.max(0, deadlineAt - performance.now()));
  timer.unref();
  signal?.addEventListener('abort', cancelled, { once: true });
  try {
    assertRequestActive(signal);
    const runtime = await awaitWithSignal(
      dependencies.runtime.observe(stored, controller.signal),
      controller.signal,
    );
    return { kind: 'observed', runtime };
  } catch (error) {
    assertRequestActive(signal);
    return { kind: 'unavailable', message: errorMessage(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
    // Release sibling Kubernetes reads on partial failure as well as timeout.
    controller.abort();
  }
}

async function summary(
  stored: StoredDeployment,
  dependencies: DeploymentsDomainDependencies,
  includeObservation: boolean,
  signal?: AbortSignal,
): Promise<DeploymentSummary> {
  assertRequestActive(signal);
  const [snapshot, observation, usage] = await Promise.all([
    includeObservation
      ? dependencies.jobs.statusSnapshot(stored.id)
      : dependencies.jobs
          .counts(stored.id)
          .then((counts) => ({ counts, blockers: [] })),
    includeObservation
      ? observeStatus(stored, dependencies, signal)
      : Promise.resolve<DeploymentObservation>({ kind: 'not-requested' }),
    includeObservation ? dependencies.deployments.getUsage(stored.id) : null,
  ]);
  assertRequestActive(signal);
  const jobs = snapshot.counts;
  const workload =
    observation.kind === 'observed' ? observation.runtime.workload : null;
  return {
    readinessProbe: stored.readinessProbe,
    gracePeriodSeconds: stored.gracePeriodSeconds,
    status: includeObservation
      ? deriveDeploymentStatus(stored, snapshot, observation)
      : null,
    id: stored.id,
    name: stored.name,
    nodePoolId: stored.nodePoolId,
    managed: stored.managed,
    privileged: stored.config.dockerOptions?.privileged === true,
    target: targetOf(stored),
    image: stored.config.image,
    command: stored.config.command,
    gpuCount: stored.gpuCount,
    envKeys: Object.keys(stored.config.env ?? {}).sort(),
    secretNames: stored.secretNames,
    maxConcurrentJobsPerReplica: stored.maxConcurrentJobsPerReplica,
    minReplicas: stored.minReplicas,
    maxReplicas: stored.maxReplicas,
    generation: stored.generation,
    deletionRequestedAt: stored.deletionRequestedAt,
    deletedAt: stored.deletedAt,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    jobs,
    workload,
    usage,
  };
}

/** anycloud owns a managed Deployment's lifetime and spec (decision 29). */
function assertUnmanaged(stored: StoredDeployment, verb: string): void {
  if (stored.managed) {
    throw new DeploymentDomainError(
      `Deployment ${stored.name} runs Jobs submitted with job --node-pool and can't be ${verb}; anycloud removes it after 24 h with no Job`,
      409,
    );
  }
}

/** A user Deployment's bounds: 1 ≤ min ≤ max, max defaulting to min. */
function replicaBounds(minReplicas = 1, maxReplicas = minReplicas) {
  if (maxReplicas < minReplicas) {
    throw new DeploymentDomainError(
      `--max-replicas (${maxReplicas}) must be at least --min-replicas (${minReplicas})`,
      400,
    );
  }
  return { minReplicas, maxReplicas };
}

export function createDeploymentsDomain(
  dependencies: DeploymentsDomainDependencies,
): DeploymentsDomain {
  return {
    async create(actor, input, signal) {
      signal?.throwIfAborted();
      const unclaimable = unclaimableWorkloadApiUrl(
        dependencies.workloadApiUrl(),
      );
      if (unclaimable) throw new DeploymentDomainError(unclaimable, 400);
      validateKubernetesDockerOptions(
        input.dockerOptions,
        'Kubernetes Deployment',
      );
      const scope = await dependencies.resolveScope(actor);
      const existing = await dependencies.deployments.getForScope(
        input.name,
        scope,
      );
      if (existing) {
        throw new DeploymentDomainError(
          `Deployment "${input.name}" already exists`,
          409,
        );
      }
      const nodePool = await resolveReadyNodePool(
        dependencies.nodePools,
        input.nodePool,
        scope,
        deploymentRefusal(input.nodePool),
      );
      const target: DeploymentTarget = {
        kind: 'nodePool',
        nodePoolId: nodePool.id,
      };
      // On NVIDIA capacity GPU access defaults to every device and `runc` is
      // refused, so a node pool handler always matches its node pool's kind
      // of capacity; the rendered template asserts the same rule.
      refusePrivilegedOnUserNamespacePool(
        input.dockerOptions,
        nodePool,
        'Deployments',
      );
      const gpuCount = resolveNodePoolGpuCount(
        input.dockerOptions,
        nodePool,
        'Kubernetes Deployments',
      );
      await dependencies.preflightSecrets(input.secrets ?? []);
      await validateTarget(target, dependencies, signal);
      const image = await validateImage(
        input.image,
        actor.token,
        dependencies.inspectImage,
        nodePool,
      );
      const reservation = await reserveNodePoolCapacity(
        nodePool,
        gpuCount,
        dependencies,
        signal,
      );
      const config: ContainerSpec = {
        image: input.image,
        ...image,
        command: input.command ?? null,
        env: input.env ?? null,
        registryUsername: GHCR_TOKEN_USERNAME,
        registryToken: actor.token || null,
        dockerOptions: input.dockerOptions ?? null,
      };
      const id = dependencies.generateId(input.name);
      signal?.throwIfAborted();
      try {
        const created = await dependencies.deployments.create(
          {
            id,
            ownerUserId: actor.id,
            name: input.name,
            nodePoolId: target.nodePoolId,
            reservation,
            config,
            readinessProbe: input.readinessProbe ?? null,
            gracePeriodSeconds: input.gracePeriodSeconds,
            secretNames: input.secrets ?? [],
            gpuCount,
            maxConcurrentJobsPerReplica: input.maxConcurrentJobsPerReplica,
            ...replicaBounds(input.minReplicas, input.maxReplicas),
          },
          scope,
        );
        if (!created) {
          throw new DeploymentDomainError(
            'Node pool changed or its ready GPU capacity was reserved before the Deployment was created',
            409,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('UNIQUE constraint failed') ||
            error.message.includes('Deployment identity already exists'))
        ) {
          throw new DeploymentDomainError(
            `Deployment "${input.name}" already exists`,
            409,
          );
        }
        throw error;
      }
      dependencies.runtime.schedule(id);
      const stored = await dependencies.deployments.getById(id);
      if (!stored) throw new Error(`Created Deployment ${id} is missing`);
      return { deployment: await summary(stored, dependencies, false, signal) };
    },

    async list(actor, filter, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      let listFilter: Parameters<DeploymentRepository['listForScope']>[1];
      if (filter?.nodePool !== undefined) {
        const identifier = filter.nodePool.trim();
        const stored =
          (await dependencies.nodePools.getForScope(identifier, scope)) ??
          (await dependencies.nodePools.getByNameForScope(identifier, scope));
        if (!stored) {
          throw new DeploymentDomainError('Node pool not found', 400);
        }
        listFilter = { nodePoolId: stored.id };
      }
      signal?.throwIfAborted();
      const rows = await dependencies.deployments.listForScope(
        scope,
        listFilter,
      );
      return {
        deployments: await Promise.all(
          rows.map((row) => summary(row, dependencies, false, signal)),
        ),
      };
    },

    async get(actor, identifier, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const stored = await dependencies.deployments.getForScope(
        identifier,
        scope,
        {
          includeDeleted: true,
        },
      );
      if (!stored) {
        throw new DeploymentDomainError('Deployment not found', 404);
      }
      return { deployment: await summary(stored, dependencies, true, signal) };
    },

    async update(actor, identifier, input, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const current = await dependencies.deployments.getForScope(
        identifier,
        scope,
      );
      if (!current) {
        throw new DeploymentDomainError('Deployment not found', 404);
      }
      assertUnmanaged(current, 'updated');
      if (current.deletionRequestedAt !== null) {
        throw new DeploymentDomainError(
          'Deployment deletion has already been requested',
          409,
        );
      }
      const nodePool = await targetNodePool(current, dependencies);
      const dockerOptions = updatedDockerOptions(
        current.config.dockerOptions,
        input,
      );
      validateKubernetesDockerOptions(dockerOptions, 'Kubernetes Deployment');
      refusePrivilegedOnUserNamespacePool(
        dockerOptions,
        nodePool,
        'Deployments',
      );
      const resolvedGpuCount = resolveNodePoolGpuCount(
        dockerOptions,
        nodePool,
        'Kubernetes Deployments',
      );
      const preserveGpuCount =
        input.dockerOptions !== null && input.dockerOptions?.gpus === undefined;
      const gpuCount = preserveGpuCount ? current.gpuCount : resolvedGpuCount;
      resolveKubernetesRuntimeClass(dockerOptions, gpuCount);
      if (preserveGpuCount && gpuCount > 0) {
        // Catalog corrections must not expand an admitted allocation or let it
        // exceed the capacity available to the replacement Pod.
        resolveNodePoolGpuCount(
          { ...dockerOptions, gpus: String(gpuCount) },
          nodePool,
          'Kubernetes Deployments',
        );
      }
      const secretNames =
        input.secrets === undefined
          ? current.secretNames
          : (input.secrets ?? []);
      await dependencies.preflightSecrets(secretNames);
      const imageName = input.image ?? current.config.image;
      const image = input.image
        ? await validateImage(
            input.image,
            actor.token,
            dependencies.inspectImage,
            nodePool,
          )
        : { imageDigest: current.config.imageDigest };
      await validateTarget(targetOf(current), dependencies, signal);
      const bounds = replicaBounds(
        input.minReplicas ?? current.minReplicas,
        input.maxReplicas ?? current.maxReplicas,
      );
      const replicas = bounds.maxReplicas;
      // Raising the GPUs held, per replica or by raising the maximum,
      // reserves the extra devices as create does.
      const reservation =
        gpuCount * replicas > current.gpuCount * current.maxReplicas
          ? await reserveNodePoolCapacity(
              nodePool,
              gpuCount,
              dependencies,
              signal,
            )
          : undefined;
      signal?.throwIfAborted();
      const generation = await dependencies.deployments.update(
        {
          id: current.id,
          expectedGeneration: current.generation,
          reservation,
          maxConcurrentJobsPerReplica:
            input.maxConcurrentJobsPerReplica ??
            current.maxConcurrentJobsPerReplica,
          gpuCount,
          ...bounds,
          readinessProbe:
            input.readinessProbe === undefined
              ? current.readinessProbe
              : input.readinessProbe,
          gracePeriodSeconds: input.gracePeriodSeconds,
          secretNames,
          config: {
            ...current.config,
            image: imageName,
            imageDigest: image.imageDigest,
            command:
              input.command === undefined
                ? current.config.command
                : input.command,
            env: input.env === undefined ? current.config.env : input.env,
            registryUsername: input.image
              ? GHCR_TOKEN_USERNAME
              : current.config.registryUsername,
            registryToken: input.image
              ? actor.token || null
              : current.config.registryToken,
            dockerOptions,
          },
        },
        scope,
      );
      if (generation === 'gpu-reserved') {
        throw new DeploymentDomainError(
          `Node pool "${nodePool.name}" ready GPU capacity is reserved by its Deployments and Services; this Deployment needs ${gpuCount * replicas} GPU(s)`,
          409,
        );
      }
      if (generation === null) {
        throw new DeploymentDomainError(
          'Deployment changed while it was being updated; retry the request',
          409,
        );
      }
      dependencies.runtime.schedule(current.id);
      const stored = await dependencies.deployments.getById(current.id);
      if (!stored)
        throw new Error(`Updated Deployment ${current.id} is missing`);
      return { deployment: await summary(stored, dependencies, false, signal) };
    },

    async delete(actor, identifier, signal) {
      signal?.throwIfAborted();
      const scope = await dependencies.resolveScope(actor);
      const current = await dependencies.deployments.getForScope(
        identifier,
        scope,
        { includeDeleted: true },
      );
      if (!current) {
        throw new DeploymentDomainError('Deployment not found', 404);
      }
      assertUnmanaged(current, 'deleted');
      const result = await dependencies.deployments.requestDeletion(
        current.id,
        scope,
      );
      if (result === 'not-found') {
        throw new DeploymentDomainError('Deployment not found', 404);
      }
      if (result !== 'already-deleted') {
        await dependencies.jobs.terminateUnassigned(current.id);
        dependencies.runtime.schedule(current.id);
      }
      const stored = await dependencies.deployments.getById(current.id);
      if (!stored)
        throw new Error(`Deleted Deployment ${current.id} is missing`);
      return { deployment: await summary(stored, dependencies, false, signal) };
    },
  };
}
