import { gpuCapabilityForVMType } from '../../shared/cloud-config.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  NODE_POOL_WORKLOAD_STATE,
  NodePoolState,
} from '../../shared/node-pools.js';
import {
  isTerminalState,
  WorkloadState,
  WorkloadType,
} from '../../shared/workload.js';
import type { NodePoolCapabilityConstraint } from './kubernetes/node-pool-scheduling.js';
import type {
  ClusterRuntime,
  ClusterRuntimeResolver,
} from './kubernetes/cluster-runtime.js';
import {
  buildNodePoolServiceManifests,
  deleteNodePoolService,
  ensureNodePoolService,
  observeNodePoolService,
  assertServiceHostnameFree,
  ServiceHostnameTakenError,
  stopNodePoolService,
  type NodePoolServiceManifests,
  type NodePoolServiceObservation,
} from './kubernetes/service-workload.js';
import type { NodePoolRepository, StoredNodePool } from './cluster-store.js';
import { KubernetesResourceOwnershipError } from './kubernetes/managed-resources.js';
import { log } from './logger.js';
import type { NodePoolIngressStatus } from './node-pool-controller.js';
import { redactSecrets } from './redact.js';
import type {
  StoredWorkload,
  WorkloadPublicEndpoint,
} from './workload-record.js';
import type { WorkloadEventMetadataInput } from './workload-event-metadata.js';

/** Matches the VM-host container setup allowance. */
export const NODE_POOL_SERVICE_STARTUP_TIMEOUT_MS = 10 * 60_000;

export interface NodePoolServiceController {
  /** Drive one node-pool-targeted Service toward its desired state. */
  reconcile(workloadId: string): Promise<void>;
  /** Stop the application Pod but keep identity, Service and Secrets. */
  stop(workload: StoredWorkload): Promise<void>;
  /** Remove every native object the Service owns; throws while any remains. */
  remove(workload: StoredWorkload): Promise<void>;
}

/**
 * The DNS Worker as VM-host Services use it: an A record for
 * `<workload id>.anycloud.sh`, owned at the Worker by the GitHub account
 * whose token publishes it — the Service creator's stored token.
 */
interface NodePoolServicePublicEndpointPorts {
  /** Upsert and return the record id; the held `recordId` updates in place. */
  publish(
    workloadId: string,
    ip: string,
    githubToken: string | null,
    recordId: string | null,
  ): Promise<string>;
  waitForPublication(hostname: string): Promise<void>;
  remove(recordId: string, githubToken: string | null): Promise<void>;
}

/** The step claims and state transitions the controller publishes. */
interface NodePoolServiceTransitions {
  claimStep(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<number | null>;
  updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

/** The terminal outcomes the controller publishes. */
interface NodePoolServiceOutcomes {
  publishTerminalOutcome(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}

/** The block reasons the controller records and the state entry it times. */
interface NodePoolServiceEvents {
  recordBlockReason(
    workloadId: string,
    state: WorkloadState.Queued | WorkloadState.Provisioning,
    message: string,
  ): Promise<void>;
  getStateEnteredAt(
    workloadId: string,
    state: WorkloadState,
  ): Promise<number | null>;
}

/** The DNS record and public endpoint the controller keeps on the Workload. */
interface NodePoolServiceEndpoints {
  updateDnsRecordId(
    workloadId: string,
    dnsRecordId: string | null,
  ): Promise<void>;
  updatePublicEndpoint(
    workloadId: string,
    endpoint: WorkloadPublicEndpoint | null,
  ): Promise<void>;
}

/** The hydrated Workload the controller reconciles. */
interface NodePoolServiceWorkloads {
  getWorkload(workloadId: string): Promise<StoredWorkload | null>;
}

/** The named-secret values a Service's container environment receives. */
interface NodePoolServiceSecrets {
  getSecretValues(name: string): Promise<Record<string, string> | null>;
}

export interface NodePoolServiceControllerDependencies {
  workloads: NodePoolServiceWorkloads;
  secrets: NodePoolServiceSecrets;
  transitions: NodePoolServiceTransitions;
  outcomes: NodePoolServiceOutcomes;
  events: NodePoolServiceEvents;
  endpoints: NodePoolServiceEndpoints;
  nodePools: Pick<NodePoolRepository, 'getForScope'>;
  clusterRuntime: ClusterRuntimeResolver;
  /** The pool's ingress entry and Traefik release, as `node-pool status` reports them. */
  poolIngress: (nodePoolId: string) => Promise<NodePoolIngressStatus>;
  publicEndpoint: NodePoolServicePublicEndpointPorts;
  now?: () => number;
}

/** Worker verdicts that no retry will change: wrong owner, no auth, conflict. */
const DEFINITIVE_DNS_FAILURE = /\((401|403|409)\)/;

/** Every row, regardless of owner: the controller acts for the installation. */
const CONTROLLER_SCOPE = { kind: 'api' } as const;

class NodePoolServiceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodePoolServiceTargetError';
  }
}

function assertNodePoolService(
  workload: StoredWorkload,
): asserts workload is StoredWorkload & {
  nodePoolId: string;
  image: string;
  registryUsername: string;
} {
  if (
    workload.workloadType !== WorkloadType.Service ||
    workload.nodePoolId === null ||
    workload.image === null ||
    workload.registryUsername === null
  ) {
    throw new Error(
      `Workload ${workload.id} is not a node-pool-targeted Service with its container configuration`,
    );
  }
}

export function createNodePoolServiceController(
  deps: NodePoolServiceControllerDependencies,
): NodePoolServiceController {
  const now = deps.now ?? Date.now;

  async function loadNodePool(
    workload: StoredWorkload & { nodePoolId: string },
  ): Promise<StoredNodePool> {
    const nodePool = await deps.nodePools.getForScope(
      workload.nodePoolId,
      CONTROLLER_SCOPE,
    );
    if (!nodePool) {
      throw new NodePoolServiceTargetError(
        `Node pool ${workload.nodePoolId} no longer exists`,
      );
    }
    if (
      nodePool.state === NodePoolState.Deleting ||
      nodePool.state === NodePoolState.Deleted
    ) {
      throw new NodePoolServiceTargetError(
        `Node pool ${nodePool.name} is terminated`,
      );
    }
    return nodePool;
  }

  async function resolveSecretsEnv(
    workload: StoredWorkload,
  ): Promise<Record<string, string> | null> {
    if (!workload.secretNames || workload.secretNames.length === 0) return null;
    const values: Record<string, string> = {};
    for (const name of workload.secretNames) {
      const secret = await deps.secrets.getSecretValues(name);
      if (secret === null) {
        throw new InvalidAnycloudConfigError(`Secret "${name}" not found`);
      }
      Object.assign(values, secret);
    }
    return values;
  }

  /**
   * The node pool's advertised devices, from the same catalog fact the
   * node pool controller uses for readiness. Admission admits CPU and
   * verified NVIDIA node pools only; anything else changed under the Service.
   */
  function capabilityOf(
    nodePool: Pick<StoredNodePool, 'cloudProvider' | 'vmTypes' | 'name'>,
  ): NodePoolCapabilityConstraint {
    // Every type in the pool's list shares one capability.
    const capability = gpuCapabilityForVMType(
      nodePool.cloudProvider,
      nodePool.vmTypes[0]!,
    );
    if (capability.kind === 'cpu') return { nvidiaGpus: 0 };
    if (capability.kind === 'nvidia' && capability.count !== undefined) {
      return { nvidiaGpus: capability.count };
    }
    throw new Error(
      `Node pool ${nodePool.name} VM type ${nodePool.vmTypes.join(', ')} has no verified capability for a Service Pod`,
    );
  }

  async function manifestsFor(
    workload: StoredWorkload & {
      nodePoolId: string;
      image: string;
      registryUsername: string;
    },
    nodePool: Pick<
      StoredNodePool,
      'id' | 'clusterId' | 'cloudProvider' | 'vmTypes' | 'name'
    >,
  ): Promise<NodePoolServiceManifests> {
    return buildNodePoolServiceManifests({
      workloadId: workload.id,
      userId: workload.userId,
      registryUsername: workload.registryUsername,
      clusterId: nodePool.clusterId,
      nodePoolId: nodePool.id,
      capability: capabilityOf(nodePool),
      image: workload.image,
      imageDigest: workload.imageDigest,
      command: workload.command,
      env: workload.env,
      registryToken: workload.githubToken,
      dockerOptions: workload.dockerOptions,
      secretsEnv: await resolveSecretsEnv(workload),
    });
  }

  /**
   * Publish an infrastructure failure through the FSM: a Running Service
   * fails directly; a Provisioning one passes through Retrying, whose only
   * consumer for node pool Services is this terminal write.
   */
  async function fail(
    workload: StoredWorkload,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const metadata = { message: reason, reason, ...extra };
    if (workload.state === WorkloadState.Running) {
      await deps.outcomes.publishTerminalOutcome(
        workload.id,
        WorkloadState.Failed,
        WorkloadState.Running,
        { metadata },
      );
      return;
    }
    if (workload.state === WorkloadState.Provisioning) {
      const retrying = await deps.transitions.updateState(
        workload.id,
        WorkloadState.Retrying,
        { metadata },
      );
      if (!retrying) return;
    }
    await deps.outcomes.publishTerminalOutcome(
      workload.id,
      WorkloadState.Failed,
      WorkloadState.Retrying,
      { metadata },
    );
  }

  async function invalid(
    workload: StoredWorkload,
    reason: string,
  ): Promise<void> {
    if (
      workload.state !== WorkloadState.Queued &&
      workload.state !== WorkloadState.Provisioning
    ) {
      await fail(workload, reason);
      return;
    }
    await deps.outcomes.publishTerminalOutcome(
      workload.id,
      WorkloadState.Invalid,
      workload.state,
      { metadata: { message: reason, reason } },
    );
  }

  async function connect(nodePool: StoredNodePool): Promise<ClusterRuntime> {
    return deps.clusterRuntime.resolve(nodePool.clusterId);
  }

  async function reconcileActive(
    workload: StoredWorkload & {
      nodePoolId: string;
      image: string;
      registryUsername: string;
    },
  ): Promise<void> {
    let nodePool: StoredNodePool;
    try {
      nodePool = await loadNodePool(workload);
    } catch (error) {
      if (error instanceof NodePoolServiceTargetError) {
        if (workload.state === WorkloadState.Queued) {
          await invalid(workload, error.message);
        } else {
          await fail(workload, error.message);
        }
        return;
      }
      throw error;
    }

    if (nodePool.state !== NodePoolState.Ready) {
      const reason = `Node pool ${nodePool.name} is ${NODE_POOL_WORKLOAD_STATE[nodePool.state]}${
        nodePool.lastError ? `: ${nodePool.lastError}` : ''
      }`;
      if (
        workload.state === WorkloadState.Queued ||
        workload.state === WorkloadState.Provisioning
      ) {
        await deps.events.recordBlockReason(
          workload.id,
          workload.state,
          reason,
        );
      }
      // A Running Service keeps running: Kubernetes owns its Pod while the
      // node pool recovers, and nothing here can improve on that.
      return;
    }

    let manifests: NodePoolServiceManifests;
    try {
      manifests = await manifestsFor(workload, nodePool);
    } catch (error) {
      if (error instanceof InvalidAnycloudConfigError) {
        await invalid(workload, error.message);
        return;
      }
      throw error;
    }

    let current = workload;
    if (current.state === WorkloadState.Queued) {
      const claimed = await deps.transitions.claimStep(
        current.id,
        WorkloadState.Provisioning,
        {
          metadata: {
            nodePoolId: nodePool.id,
            clusterId: nodePool.clusterId,
            namespace: manifests.namespace,
          },
        },
      );
      if (claimed === null) return;
      current = { ...current, state: WorkloadState.Provisioning };
    }

    if (current.state === WorkloadState.Running) {
      // Once Running, restarts and rescheduling are Kubernetes' to resolve, as
      // a VM-host Service's container restarts are Docker's. Steady state is
      // one observation per pass; desired state is re-applied only when the
      // native Deployment itself has gone missing.
      const runtime = await connect(nodePool);
      const observation = await observeNodePoolService(
        runtime.cluster,
        manifests,
      );
      if (observation.phase === 'absent') {
        await ensureNodePoolService(runtime.cluster, manifests);
      }
      await reconcilePublicEndpoint(current, nodePool);
      return;
    }

    let observation: NodePoolServiceObservation;
    try {
      const runtime = await connect(nodePool);
      await assertServiceHostnameFree(runtime.cluster, manifests);
      await ensureNodePoolService(runtime.cluster, manifests);
      observation = await observeNodePoolService(runtime.cluster, manifests);
    } catch (error) {
      // A starting Service must not wait forever on a cluster or apply error.
      await settleStartupError(current, error);
      return;
    }
    await settleStartup(current, manifests, observation);
  }

  /**
   * Keep `<id>.anycloud.sh` pointing at the pool's ingress entry: publish once
   * the pool's Traefik is ready (never at a port nothing listens on), re-point
   * whenever the entry moved (the node-pool controller signals `entryChanged`
   * and every pass re-checks, so a missed signal heals). A refused Worker
   * verdict reads `stale`; anything transient stays `repointing` and is retried
   * each pass. The Service itself keeps running throughout.
   */
  async function reconcilePublicEndpoint(
    workload: StoredWorkload,
    nodePool: StoredNodePool,
  ): Promise<void> {
    const ingress = await deps.poolIngress(nodePool.id);
    const entryIp = ingress.entryIp;
    const traefikReady = (ingress.release?.daemonSet?.ready ?? 0) >= 1;
    const current = workload.publicEndpoint;
    if (!entryIp || !traefikReady) {
      const error = entryIp
        ? 'pool ingress is not serving yet'
        : 'pool ingress entry lost';
      // Entry lost with a live record: the record is stale until 2a elects a
      // replacement; before any record exists there is nothing stale yet.
      const state = workload.dnsRecordId && !entryIp ? 'stale' : 'repointing';
      if (current?.state !== state || current.error !== error) {
        await deps.endpoints.updatePublicEndpoint(workload.id, {
          ip: current?.ip ?? null,
          state,
          error,
        });
      }
      return;
    }
    if (
      workload.dnsRecordId &&
      current?.state === 'published' &&
      current.ip === entryIp
    ) {
      return;
    }
    try {
      const recordId = await deps.publicEndpoint.publish(
        workload.id,
        entryIp,
        workload.githubToken,
        workload.dnsRecordId,
      );
      await deps.endpoints.updateDnsRecordId(workload.id, recordId);
      // Keep the owned identity durable even when propagation times out.
      await deps.publicEndpoint.waitForPublication(
        `${workload.id}.anycloud.sh`,
      );
      await deps.endpoints.updatePublicEndpoint(workload.id, {
        ip: entryIp,
        state: 'published',
        error: null,
      });
      log.info('Node pool Service endpoint published', {
        id: workload.id,
        ip: entryIp,
        recordId,
      });
    } catch (error) {
      const message = redactSecrets(errorMessage(error));
      await deps.endpoints.updatePublicEndpoint(workload.id, {
        ip: current?.ip ?? null,
        state: DEFINITIVE_DNS_FAILURE.test(message) ? 'stale' : 'repointing',
        error: message,
      });
      log.warn('Node pool Service endpoint publish deferred', {
        id: workload.id,
        error: message,
      });
    }
  }

  async function startupAllowanceExpired(workloadId: string): Promise<boolean> {
    const enteredAt = await deps.events.getStateEnteredAt(
      workloadId,
      WorkloadState.Provisioning,
    );
    return now() - (enteredAt ?? now()) >= NODE_POOL_SERVICE_STARTUP_TIMEOUT_MS;
  }

  function startupTimeoutReason(reason: string): string {
    return `Service did not become ready within ${Math.round(NODE_POOL_SERVICE_STARTUP_TIMEOUT_MS / 60_000)} minutes (${reason})`;
  }

  /**
   * Cluster connection, permission and apply errors while starting are recorded
   * where the user can see them and consume the same allowance a slow start
   * does. An ownership conflict cannot heal by retrying and fails at once.
   */
  async function settleStartupError(
    workload: StoredWorkload,
    error: unknown,
  ): Promise<void> {
    if (error instanceof KubernetesResourceOwnershipError) {
      await fail(workload, error.message, { cause: 'native-ownership' });
      return;
    }
    if (error instanceof ServiceHostnameTakenError) {
      await fail(workload, error.message, { cause: 'hostname-taken' });
      return;
    }
    const reason = `cluster error: ${redactSecrets(errorMessage(error))}`;
    if (await startupAllowanceExpired(workload.id)) {
      await fail(workload, startupTimeoutReason(reason), {
        cause: 'cluster-error',
      });
      return;
    }
    log.warn('Node pool Service start deferred by a cluster error', {
      id: workload.id,
      error: errorMessage(error),
    });
    await deps.events.recordBlockReason(
      workload.id,
      WorkloadState.Provisioning,
      reason,
    );
  }

  async function settleStartup(
    workload: StoredWorkload,
    manifests: NodePoolServiceManifests,
    observation: NodePoolServiceObservation,
  ): Promise<void> {
    if (observation.phase === 'serving') {
      await deps.transitions.updateState(workload.id, WorkloadState.Running, {
        metadata: {
          namespace: manifests.namespace,
          podName: observation.podName,
          podUid: observation.podUid,
          containerPort: manifests.containerPort,
        },
      });
      return;
    }
    const detail = observation.reason ? `: ${observation.reason}` : '';
    // Kubernetes restarts a crashed container itself, so a crash during
    // startup consumes the same allowance a slow start does instead of
    // failing on the first exit.
    const reason =
      observation.phase === 'scheduling'
        ? `Waiting for node pool capacity${detail}`
        : observation.phase === 'crashed'
          ? `Service container is restarting${detail}`
          : `Starting${detail}`;
    if (await startupAllowanceExpired(workload.id)) {
      await fail(workload, startupTimeoutReason(reason), {
        podName: observation.podName,
        phase: observation.phase,
        restartCount: observation.restartCount,
      });
      return;
    }
    await deps.events.recordBlockReason(
      workload.id,
      WorkloadState.Provisioning,
      reason,
    );
  }

  return {
    async reconcile(workloadId) {
      const workload = await deps.workloads.getWorkload(workloadId);
      if (!workload || workload.nodePoolId === null) return;
      if (isTerminalState(workload.state)) return;
      assertNodePoolService(workload);
      if (workload.state === WorkloadState.Retrying) {
        // Only `fail` writes Retrying for a node pool Service, and it finishes
        // the terminal write in the same pass; finding it here means that
        // pass was interrupted, so complete it instead of re-applying.
        await deps.outcomes.publishTerminalOutcome(
          workload.id,
          WorkloadState.Failed,
          WorkloadState.Retrying,
          {
            metadata: {
              message: 'Service failure was interrupted before it was recorded',
              reason: 'Service failure was interrupted before it was recorded',
            },
          },
        );
        return;
      }
      try {
        await reconcileActive(workload);
      } catch (error) {
        log.warn('Node pool Service reconciliation failed', {
          id: workloadId,
          error: errorMessage(error),
        });
        throw error;
      }
    },

    async stop(workload) {
      assertNodePoolService(workload);
      const nodePool = await loadNodePool(workload);
      const runtime = await connect(nodePool);
      await stopNodePoolService(
        runtime.cluster,
        await manifestsFor(workload, nodePool),
      );
    },

    async remove(workload) {
      assertNodePoolService(workload);
      // Cleanup must still succeed once the node pool is deleting, so only a
      // missing node pool row is fatal here: without its cluster there is no
      // connection through which the native objects could be removed.
      const nodePool = await deps.nodePools.getForScope(
        workload.nodePoolId,
        CONTROLLER_SCOPE,
      );
      if (!nodePool) {
        throw new Error(
          `Node pool ${workload.nodePoolId} no longer exists; cannot confirm native cleanup for Service ${workload.id}`,
        );
      }
      const runtime = await connect(nodePool);
      await deleteNodePoolService(
        runtime.cluster,
        buildNodePoolServiceManifests({
          workloadId: workload.id,
          userId: workload.userId,
          registryUsername: workload.registryUsername,
          clusterId: nodePool.clusterId,
          nodePoolId: nodePool.id,
          // Deletion needs identity only: no catalog fact or GPU request may
          // block removing objects that exist, and no named Secret is read.
          capability: { nvidiaGpus: 0 },
          image: workload.image,
          imageDigest: workload.imageDigest,
          command: workload.command,
          env: workload.env,
          registryToken: workload.githubToken,
          dockerOptions: null,
          secretsEnv: null,
        }),
      );
      // The record goes after the objects, as for VM-host Services: routing
      // is already dead, and a Worker outage must never hold native cleanup.
      if (workload.dnsRecordId) {
        await deps.publicEndpoint.remove(
          workload.dnsRecordId,
          workload.githubToken,
        );
        await deps.endpoints.updateDnsRecordId(workload.id, null);
        await deps.endpoints.updatePublicEndpoint(workload.id, null);
      }
    },
  };
}
