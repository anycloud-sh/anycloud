import { createHash } from 'node:crypto';
import packageJson from '../../../package.json' with { type: 'json' };
import type { WorkloadAdmissionResponse } from '../../shared/api-contract/workload-admission-schemas.js';
import { MANAGED_DEPLOYMENT_GRACE_PERIOD_SECONDS } from '../../shared/api-contract/deployments-schemas.js';
import {
  InvalidAnycloudConfigError,
  WorkloadIdExistsError,
} from '../../shared/errors.js';
import {
  generateDeploymentId,
  generateJobId,
} from '../../shared/id-generator.js';
import {
  parseDockerSize,
  parseNodeCache,
} from '../../shared/docker-options.js';
import { GHCR_TOKEN_USERNAME } from '../../shared/image.js';
import type { NodePoolRepository, StoredNodePool } from './cluster-store.js';
import type { User } from './entities.js';
import type { ImageInspection } from '../../shared/image-registry.js';
import { assertDefaultJobSpec } from './job-spec-admission.js';
import {
  nodePoolNodeSize,
  nodePoolGpusPerNode,
  normalizeKubernetesCpus,
  normalizeKubernetesMemory,
  normalizeKubernetesShmSize,
  replicaMemoryCapMi,
  replicaSize,
  resolveNodePoolGpuCount,
  validateKubernetesDockerOptions,
} from './kubernetes/pod-options.js';
import { GHCR_REGISTRY, imageRegistry } from './kubernetes/pod-parts.js';
import { USER_NAMESPACE_POD_OVERHEAD_MI } from './kubernetes/user-namespace.js';
import {
  assertNodePoolImage,
  resolveReadyNodePool,
} from './node-pool-admission.js';
import {
  isWorkloadIdConstraint,
  nodePoolOwnedOption,
  nodePoolRefusal,
  type NodePoolServiceAdmissionInput,
} from './node-pool-service-admission.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import type {
  CreatePoolJobInput,
  PoolJobStorageColumns,
} from './repositories/targeted-job-creation.js';
import { normalizeAttribution } from './workload-operation-helpers.js';

const MI = 1024n * 1024n;

export interface PoolJobAdmissionDependencies {
  nodePools: Pick<NodePoolRepository, 'getForScope' | 'getByNameForScope'>;
  resolveScope(actor: User): Promise<OwnershipScope>;
  inspectImage(image: string, token: string | null): Promise<ImageInspection>;
  validateId(id: string): Promise<string>;
  /** Throws `InvalidAnycloudConfigError` for a name with no saved Secret. */
  preflightSecrets(secretNames: readonly string[]): Promise<void>;
  /**
   * The Job's buckets checked against the node pool (RFC 0043 § Admission),
   * a missing output bucket created, and the columns its row keeps.
   */
  admitStorage(
    nodePool: StoredNodePool,
    input: NodePoolServiceAdmissionInput,
    id: string,
    userId: string,
  ): Promise<PoolJobStorageColumns>;
  /** The managed Deployment's ID, or null if the pool stopped accepting. */
  persist(input: CreatePoolJobInput): Promise<string | null>;
  /** Wake the Deployment owner for the managed Deployment. */
  schedule(deploymentId: string): void;
}

/**
 * Admit `job IMAGE --node-pool P` as a targeted Job on the pool's managed
 * Deployment for the image digest and replica shape (RFC 0044 decision 26),
 * which is created with the Job if none is live. The replica options
 * `--shm-size`, `--ipc host`, `--secret` and `--cache` are part of the
 * shape, so a Job never lands on a replica without its `/dev/shm`, its
 * Secrets or its caches, and so are `--bind` volumes, which only a
 * `userNamespaceJobs` pool admits: every Job there runs as root of its own
 * user namespace, and its engine keeps its data in one (RFC 0049 C32). Its
 * buckets are its own, not the shape's: each execution mints credentials
 * for them (RFC 0043).
 */
export async function submitPoolJob(
  dependencies: PoolJobAdmissionDependencies,
  actor: User,
  input: NodePoolServiceAdmissionInput,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<WorkloadAdmissionResponse> {
  // `--timeout` bounds the wait for the first claim, as on targeted Jobs.
  const claimDeadlineAt =
    input.timeout === undefined ? null : now + Math.floor(input.timeout * 1000);
  const subject = `A Job on node pool "${input.nodePool}"`;
  const { ipc, ...options } = input.dockerOptions ?? {};
  const offending =
    nodePoolOwnedOption(input) ??
    [
      // The pool's GPUs select the runtime; nothing else is dropped silently.
      [options.runtime, '--runtime'] as const,
      // `--ipc host` is a replica's own `/dev/shm`, never the Node's IPC.
      [ipc !== undefined && ipc !== 'host', `--ipc ${ipc}`] as const,
    ].find(([present]) => present)?.[1];
  if (offending) {
    throw new InvalidAnycloudConfigError(
      `${subject} does not accept ${offending}.`,
    );
  }
  assertDefaultJobSpec(input, subject);
  signal?.throwIfAborted();

  const secretNames = [...new Set(input.secrets)].sort();
  await dependencies.preflightSecrets(secretNames);
  const scope = await dependencies.resolveScope(actor);
  const nodePool = await resolveReadyNodePool(
    dependencies.nodePools,
    input.nodePool,
    scope,
    nodePoolRefusal(input.nodePool, 'Jobs'),
  );
  // A privileged Job is root on its Node: only a pool created for that
  // (deprecated). RFC 0049 C32: on a user-namespace pool the pool decides;
  // its Jobs run in their own user namespace (its CPU types take no
  // `--gpus`), with `--bind` for an engine's data, and without caches until
  // one is proven between them (ID-mapped mounts).
  const userNamespace = nodePool.userNamespaceJobs;
  const { privileged = false, binds = [] } = options;
  const refused = [
    [privileged && !nodePool.allowPrivilegedJobs, '--privileged'],
    [
      binds.length > 0 && !nodePool.allowPrivilegedJobs && !userNamespace,
      '--bind',
    ],
    [userNamespace && (input.caches?.length ?? 0) > 0, '--cache'],
  ].find(([present]) => present)?.[1];
  if (refused) {
    throw new InvalidAnycloudConfigError(
      `${subject} does not accept ${refused}${userNamespace ? ': its Jobs run in a user namespace' : refused === '--bind' ? '; create a pool with --user-namespace-jobs' : ''}.`,
    );
  }
  // Any pool admits caches: the pool is their trust boundary (RFC 0049 C12).
  validateKubernetesDockerOptions(
    { ...options, ...(input.caches && { caches: input.caches }) },
    subject,
  );
  const caches = (input.caches ?? [])
    .map((cache) => {
      const { name, target } = parseNodeCache(cache)!;
      return `${name}:${target}`;
    })
    .sort();
  const gpusPerNode = nodePoolGpusPerNode(nodePool);
  if (gpusPerNode > 0 && options.gpus === undefined) {
    throw new InvalidAnycloudConfigError(
      `Jobs on node pool "${nodePool.name}" need --gpus N (1 to ${gpusPerNode}).`,
    );
  }
  const gpuCount = resolveNodePoolGpuCount(
    options,
    nodePool,
    'Jobs on a node pool',
  );
  signal?.throwIfAborted();
  const inspection = await dependencies.inspectImage(input.image, actor.token);
  assertNodePoolImage(input.image, inspection, nodePool);
  const { amd64Digest: digest, entrypoint, cmd } = inspection;
  if (!digest || !entrypoint || !cmd) {
    throw new InvalidAnycloudConfigError(
      `${subject} needs the registry's verified linux/amd64 digest and config for ${input.image}.`,
    );
  }
  const { cpus, memory } = options;
  const overheadMi = userNamespace ? USER_NAMESPACE_POD_OVERHEAD_MI : 0;
  const nodeSize = nodePoolNodeSize(nodePool);
  // The runtime class's Pod overhead comes on top: a larger `--memory`
  // never fits.
  if (userNamespace && memory && nodeSize) {
    const largestMi = replicaMemoryCapMi(nodeSize, overheadMi);
    if (parseDockerSize(memory, '--memory').bytes > BigInt(largestMi) * MI) {
      throw new InvalidAnycloudConfigError(
        `${subject} admits --memory up to ${largestMi}m: its smallest VM type's allocatable memory less a user-namespace Pod's ${overheadMi} MiB overhead.`,
      );
    }
  }
  // Both are a memory-backed `/dev/shm`, counted against the replica's memory;
  // `--ipc host` alone takes the replica's whole memory request.
  const shmSize =
    options.shmSize ??
    (ipc === 'host'
      ? (memory ??
        replicaSize(nodeSize, gpusPerNode, gpuCount, cpus, overheadMi).memory)
      : undefined);
  // One managed Deployment serves every Job with this digest and shape, in
  // the render's units, so `8g` and `8192m` share one. The release keys it
  // too: Jobs admitted after an upgrade get this release's runner, while an
  // older Deployment finishes its own (RFC 0049 C27). A `ghcr.io` Job from
  // a submitter without a GitHub sign-in, such as a registered Deployment
  // (RFC 0049 C29), gets its own, whose replicas hold no member's pull
  // Secret; every other key is unchanged.
  const managedKey = createHash('sha256')
    .update(
      JSON.stringify([
        packageJson.version,
        digest,
        gpuCount,
        normalizeKubernetesCpus(cpus),
        normalizeKubernetesMemory(memory),
        normalizeKubernetesShmSize(shmSize),
        secretNames,
        privileged,
        binds,
        caches,
        ...(userNamespace ? ['user-namespace'] : []),
        ...(imageRegistry(input.image) === GHCR_REGISTRY && !actor.token
          ? ['no-pull-token']
          : []),
      ]),
    )
    .digest('hex');
  const registry = {
    image: input.image,
    imageDigest: digest,
    registryUsername: GHCR_TOKEN_USERNAME,
    registryToken: actor.token || null,
  };
  const deploymentId = generateDeploymentId(input.image);
  const id = await dependencies.validateId(
    input.id || generateJobId(input.image),
  );
  signal?.throwIfAborted();
  const storage = await dependencies.admitStorage(
    nodePool,
    input,
    id,
    actor.username,
  );
  signal?.throwIfAborted();
  let deployment;
  try {
    deployment = await dependencies.persist({
      id,
      userId: actor.username,
      ownerUserId: actor.id,
      claimDeadlineAt,
      maxRetries: input.maxRetries,
      storage,
      session: normalizeAttribution(input.session) ?? undefined,
      agent: normalizeAttribution(input.agent) ?? undefined,
      sessionLabel: normalizeAttribution(input.sessionLabel) ?? undefined,
      spec: {
        ...registry,
        command: input.command ?? null,
        env: input.env ?? null,
        dockerOptions: null,
      },
      scope,
      deployment: {
        id: deploymentId,
        ownerUserId: actor.id,
        name: deploymentId,
        nodePoolId: nodePool.id,
        config: {
          ...registry,
          command: cmd,
          entrypoint,
          env: null,
          dockerOptions: {
            ...(gpuCount > 0 && { gpus: String(gpuCount) }),
            ...(cpus && { cpus }),
            ...(memory && { memory }),
            ...(shmSize && { shmSize }),
            ...(privileged && { privileged }),
            ...(userNamespace && { userNamespace }),
            ...(binds.length > 0 && { binds }),
            ...(caches.length > 0 && { caches }),
          },
        },
        secretNames,
        gpuCount,
        maxConcurrentJobsPerReplica: 1,
        // RA scales a managed Deployment from zero on its queued Jobs.
        minReplicas: 0,
        gracePeriodSeconds: MANAGED_DEPLOYMENT_GRACE_PERIOD_SECONDS,
        managedKey,
        runnerRelease: packageJson.version,
      },
    });
  } catch (error) {
    if (isWorkloadIdConstraint(error)) throw new WorkloadIdExistsError();
    throw error;
  }
  if (!deployment) {
    throw new InvalidAnycloudConfigError(
      `Node pool "${nodePool.name}" stopped accepting Jobs before the request was stored`,
    );
  }
  dependencies.schedule(deployment);
  return { id, submissionRevision: 0, claimDeadlineAt };
}
