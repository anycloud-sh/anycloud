import { KubernetesApiReads } from './kubernetes-reads.js';
import type { KubernetesClients } from '../../../../src/api/services/kubernetes/client.js';
import { isKubernetesNotFoundError } from '../../../../src/api/services/kubernetes/managed-resources.js';
import { NODE_POOL_EGRESS_POLICY } from '../../../../src/api/services/kubernetes/node-pool-namespace.js';
import {
  ATTEMPT_NODE_LABEL,
  NODE_POOL_MEMBER_LABEL,
  nodePoolNamespace,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import {
  podRequests,
  quantity,
} from '../../../../src/api/services/pool-fit.js';
import type { DockerOptions } from '../../../../src/shared/runtime.js';
import {
  deploymentSummarySchema,
  type DeploymentSummary,
  type DeploymentReadinessProbe,
} from '../../../../src/shared/api-contract/deployments-schemas.js';
import type { NodePoolReadTransport } from './node-pool-mutations.js';
import type { TrackedWorkloadKernel, TrackedWorkloadRef } from './workloads.js';
import {
  KubernetesWorkloadObservations,
  type KubernetesDeploymentAbsenceFacts,
  type KubernetesDeploymentReadyFacts,
} from './kubernetes-observations.js';
import type {
  ConcurrentTargetedJobSubmissionsObservation,
  ReadinessWakeupEvidence,
  DeploymentDrainEvidence,
  KubernetesAdmissionRejection,
  KubernetesCapacityIdentity,
  KubernetesCapacityObservation,
  KubernetesConnectionObservation,
  KubernetesControllerReplacementObservation,
  KubernetesNodePoolStatusObservation,
  NativeWrites,
  NodePoolRequest,
  PoolEgressObservation,
  ClusterNodePoolWireTransport,
  ReservationBehavior,
  SubmissionResponseLossFault,
  SubmissionResponseLossWireEvidence,
  TargetedJobRejection,
  TargetedJobWireStatusObservation,
  TargetedJobSubmissionOptions,
  TargetedJobSubmissionObservation,
  AttemptLogTail,
  PoolJobAdmission,
  PoolJobOutcome,
  PoolJobSubmission,
  PoolVmRow,
} from './targets/cluster-node-pool.js';
import type { StatusResponse } from './types.js';
import type { ArtifactStore } from './artifacts.js';
import { probePoolEgress } from './probes/pool-egress.js';
import type { CliClient } from './cli.js';
import { cliArgs } from './cli-surface.js';
import type { WorkspacePythonSdk } from './python-sdk.js';
import { Waiter } from './wait.js';

export interface KubernetesQualificationEnvironment {
  prepare(): Promise<void>;
  nodePoolRequest(
    name: string,
    vmCount: number,
    maxVmCount?: number,
  ): NodePoolRequest;
  /** Every VM row of a pool (cluster-local). */
  poolVms?(nodePoolId: string): Promise<readonly PoolVmRow[]>;
  /** A deleted anycloud Pod its finalizer holds (cluster-local). */
  holdNodeWithFinalizer?(
    nodeName: string,
  ): Promise<{ release(): Promise<void> }>;
  recordNodePool(nodePoolId: string): void;
  capacity(nodePoolId: string): Promise<KubernetesCapacityObservation>;
  connection(nodePoolId: string): Promise<KubernetesConnectionObservation>;
  deleteOneCapacityHost(nodePoolId: string): Promise<string>;
  /** Delete the capacity VM of this row (cluster-local). */
  deleteCapacityHost?(nodePoolId: string, vmRowId: number): Promise<string>;
  workloadPersisted(workloadId: string): Promise<boolean>;
  replaceController(): Promise<KubernetesControllerReplacementObservation>;
  clients(nodePoolId: string): Promise<KubernetesClients>;
  nodePoolAbsent(nodePoolId: string): Promise<boolean>;
  reservationBaseUrl(): string;
  /** Audited writes to the node pool namespace's objects (local cluster). */
  nativeWrites?(nodePoolId: string): Promise<NativeWrites>;
  prepareWorkloadImage(nodePoolId: string): Promise<void>;
  /** The runner and workload images a pool Job needs (local cluster). */
  preparePoolJobImages?(nodePoolId: string): Promise<void>;
  putReservation(jobId: string, behavior: ReservationBehavior): Promise<void>;
  reservationLookups(jobId: string): Promise<number>;
  /** `api upgrade`'s drain: the pool Jobs it waits for (cluster-local). */
  drainPoolJobs?(force: boolean): Promise<readonly string[]>;
  /** The stored log tail of each of a Job's attempts (cluster-local only). */
  attemptLogTails(jobId: string): Promise<readonly AttemptLogTail[]>;
  workloadImage(): string;
  workloadEnvironment?(): Readonly<Record<string, string>>;
  capacityIdentities(
    nodePoolId: string,
  ): Promise<readonly KubernetesCapacityIdentity[]>;
}

function invariantPoolJobImages(
  environment: KubernetesQualificationEnvironment,
): asserts environment is KubernetesQualificationEnvironment &
  Required<Pick<KubernetesQualificationEnvironment, 'preparePoolJobImages'>> {
  if (!environment.preparePoolJobImages) {
    throw new Error('This substrate cannot run pool Jobs yet');
  }
}

function deploymentOutput(
  value: unknown,
  operation: string,
): DeploymentSummary {
  try {
    return deploymentSummarySchema.parse(value);
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

/** Shared qualification path; the environment supplies substrate-only facts. */
export class KubernetesQualificationTransport
  implements ClusterNodePoolWireTransport
{
  readonly #nodePools: NodePoolReadTransport;
  readonly #workloads: Pick<TrackedWorkloadKernel, 'authorizeMutation'>;
  readonly #environment: KubernetesQualificationEnvironment;
  readonly #observations: KubernetesWorkloadObservations;
  readonly #clients: (nodePoolId: string) => Promise<KubernetesClients>;
  readonly #wait: Waiter;
  readonly #sdk: Pick<
    WorkspacePythonSdk,
    | 'prepare'
    | 'artifactIdentity'
    | 'json'
    | 'run'
    | 'startSubmissionResponseLoss'
  >;
  readonly #artifacts: Pick<ArtifactStore, 'json'> | undefined;
  readonly #cli: Pick<CliClient, 'run'>;

  constructor(dependencies: {
    readonly nodePools: NodePoolReadTransport;
    readonly workloads: Pick<TrackedWorkloadKernel, 'authorizeMutation'>;
    readonly environment: KubernetesQualificationEnvironment;
    readonly sdk: Pick<
      WorkspacePythonSdk,
      | 'prepare'
      | 'artifactIdentity'
      | 'json'
      | 'run'
      | 'startSubmissionResponseLoss'
    >;
    readonly artifacts?: Pick<ArtifactStore, 'json'>;
    readonly cli: Pick<CliClient, 'run'>;
    readonly clients?: (nodePoolId: string) => Promise<KubernetesClients>;
    readonly signal?: AbortSignal;
    readonly readArtifactPrefix?: string;
  }) {
    this.#nodePools = dependencies.nodePools;
    this.#workloads = dependencies.workloads;
    this.#environment = dependencies.environment;
    this.#sdk = dependencies.sdk;
    this.#artifacts = dependencies.artifacts;
    this.#cli = dependencies.cli;
    const clients =
      dependencies.clients ??
      ((nodePoolId) => dependencies.environment.clients(nodePoolId));
    this.#clients = clients;
    this.#wait = new Waiter(
      dependencies.signal ?? new AbortController().signal,
    );
    this.#observations = new KubernetesWorkloadObservations(
      clients,
      new KubernetesApiReads({
        signal: dependencies.signal,
        artifacts: dependencies.artifacts,
        prefix: dependencies.readArtifactPrefix ?? 'foreground-observation',
      }),
    );
  }

  async prepare(): Promise<void> {
    await this.#sdk.prepare();
    await this.#artifacts?.json('kubernetes-python-sdk', {
      ...(await this.#sdk.artifactIdentity()),
      operator: 'AsyncClient',
    });
    await this.#environment.prepare();
  }

  nodePoolRequest(name: string, vmCount: number, maxVmCount?: number) {
    return this.#environment.nodePoolRequest(name, vmCount, maxVmCount);
  }

  poolVms(nodePoolId: string): Promise<readonly PoolVmRow[]> {
    if (!this.#environment.poolVms) {
      throw new Error('This substrate cannot list pool VM rows');
    }
    return this.#environment.poolVms(nodePoolId);
  }

  holdNodeWithFinalizer(nodeName: string) {
    if (!this.#environment.holdNodeWithFinalizer) {
      throw new Error('This substrate cannot hold a Node with a finalizer');
    }
    return this.#environment.holdNodeWithFinalizer(nodeName);
  }

  async accountBudget(usd: number | null): Promise<void> {
    const args =
      usd === null
        ? cliArgs('budget unset', { per: 'day' }, [])
        : cliArgs('budget set', { per: 'day' }, [String(usd)]);
    const result = await this.#cli.run(args, {
      timeoutMs: 60_000,
      label: 'account-budget',
    });
    if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
      throw new Error(`budget failed: ${result.combined}`);
    }
  }

  recordNodePool(nodePoolId: string): void {
    this.#environment.recordNodePool(nodePoolId);
  }

  capacity(nodePoolId: string) {
    return this.#environment.capacity(nodePoolId);
  }

  connection(nodePoolId: string) {
    return this.#environment.connection(nodePoolId);
  }

  deleteOneCapacityHost(nodePoolId: string, vmRowId?: number): Promise<string> {
    if (vmRowId === undefined) {
      return this.#environment.deleteOneCapacityHost(nodePoolId);
    }
    if (!this.#environment.deleteCapacityHost) {
      throw new Error('This substrate cannot delete a chosen capacity VM');
    }
    return this.#environment.deleteCapacityHost(nodePoolId, vmRowId);
  }

  async replicaNode(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
  ): Promise<{ name: string; vmRowId: number }> {
    const pod = await this.#observations.deploymentPod(
      nodePoolId,
      deploymentId,
      podUid,
    );
    if (!pod?.nodeName) throw new Error(`Replica ${podUid} has no Node`);
    const node = await (
      await this.#clients(nodePoolId)
    ).core.readNode({ name: pod.nodeName });
    const vmRowId = Number(node.metadata?.labels?.[ATTEMPT_NODE_LABEL]);
    if (!Number.isSafeInteger(vmRowId)) {
      throw new Error(`Node ${pod.nodeName} has no attempt label`);
    }
    return { name: pod.nodeName, vmRowId };
  }

  async nodePresent(nodePoolId: string, name: string): Promise<boolean> {
    const { core } = await this.#clients(nodePoolId);
    return core.readNode({ name }).then(
      () => true,
      (error: unknown) => {
        if (isKubernetesNotFoundError(error)) return false;
        throw error;
      },
    );
  }

  replaceController() {
    return this.#environment.replaceController();
  }

  reservationBaseUrl(): string {
    return this.#environment.reservationBaseUrl();
  }

  putReservation(jobId: string, behavior: ReservationBehavior): Promise<void> {
    return this.#environment.putReservation(jobId, behavior);
  }

  reservationLookups(jobId: string): Promise<number> {
    return this.#environment.reservationLookups(jobId);
  }

  attemptLogTails(jobId: string): Promise<readonly AttemptLogTail[]> {
    return this.#environment.attemptLogTails(jobId);
  }

  async activeNodePoolIds(): Promise<readonly string[]> {
    return (await this.#nodePools.list()).map((nodePool) => nodePool.id);
  }

  async nodePoolStatus(
    nodePoolId: string,
  ): Promise<KubernetesNodePoolStatusObservation> {
    const nodePool = await this.#nodePools.status(nodePoolId);
    return {
      id: nodePool.id,
      name: nodePool.name,
      readyVmCount: nodePool.capacity?.readyVmCount ?? null,
      state: nodePool.state,
      ingressEntryIp: nodePool.ingressEntryIp ?? null,
      ingress: nodePool.ingress ?? null,
    };
  }

  nodePoolAbsent(nodePoolId: string): Promise<boolean> {
    return this.#environment.nodePoolAbsent(nodePoolId);
  }

  #fixtureEnvironment(): Record<string, string> {
    return {
      RESERVATION_BASE_URL: this.#environment.reservationBaseUrl(),
      ...this.#environment.workloadEnvironment?.(),
    };
  }

  async createDeployment(input: {
    readonly readinessProbe?: DeploymentReadinessProbe | null;
    readonly nodePoolId: string;
    readonly dockerOptions?: DockerOptions;
    readonly image: string;
    readonly maxConcurrentJobsPerReplica?: number;
    readonly minReplicas?: number;
    readonly maxReplicas?: number;
    readonly name: string;
    readonly secrets?: readonly string[];
  }): Promise<DeploymentSummary> {
    await this.#environment.prepareWorkloadImage(input.nodePoolId);
    const request = {
      action: 'create_deployment',
      minReplicas: input.minReplicas,
      maxReplicas: input.maxReplicas,
      nodePool: input.nodePoolId,
      env: this.#fixtureEnvironment(),
      ...(input.dockerOptions === undefined
        ? {}
        : { dockerOptions: input.dockerOptions }),
      image: input.image,
      name: input.name,
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      ...(input.readinessProbe === undefined
        ? {}
        : { readinessProbe: input.readinessProbe }),
      ...(input.maxConcurrentJobsPerReplica === undefined
        ? {}
        : {
            maxConcurrentJobsPerReplica: input.maxConcurrentJobsPerReplica,
          }),
    };
    return deploymentOutput(
      await this.#sdk.json(request, 'kubernetes-deployment-create'),
      'Kubernetes Deployment create',
    );
  }

  async deploymentStatus(id: string): Promise<DeploymentSummary> {
    return deploymentOutput(
      await this.#sdk.json(
        { action: 'get_deployment', deployment: id },
        'kubernetes-deployment-status',
      ),
      'Kubernetes Deployment status',
    );
  }

  async listDeployments(): Promise<readonly DeploymentSummary[]> {
    const values = await this.#sdk.json<unknown[]>(
      { action: 'list_deployments' },
      'kubernetes-deployment-list',
    );
    return values.map((value) => deploymentOutput(value, 'Deployment list'));
  }

  async updateDeployment(
    id: string,
    input: {
      readonly image?: string;
      readonly env?: Record<string, string>;
      readonly readinessProbe?: DeploymentReadinessProbe | null;
    },
  ): Promise<DeploymentSummary> {
    return deploymentOutput(
      await this.#sdk.json(
        {
          action: 'update_deployment',
          deployment: id,
          ...(input.readinessProbe === undefined
            ? {}
            : { readinessProbe: input.readinessProbe }),
          ...(input.image ? { image: input.image } : {}),
          ...(input.env === undefined ? {} : { env: input.env }),
        },
        'kubernetes-deployment-update',
      ),
      'Kubernetes Deployment update',
    );
  }

  async deleteDeployment(id: string): Promise<DeploymentSummary> {
    return deploymentOutput(
      await this.#sdk.json(
        { action: 'delete_deployment', deployment: id },
        'kubernetes-deployment-delete',
      ),
      'Kubernetes Deployment delete',
    );
  }

  async waitForReconcileOpportunity(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 6_500));
  }

  async deploymentReady(
    nodePoolId: string,
    id: string,
  ): Promise<KubernetesDeploymentReadyFacts | null> {
    return this.#observations.deploymentReady(nodePoolId, id);
  }

  deploymentLogContains(
    nodePoolId: string,
    id: string,
    podUid: string,
    line: string,
  ): Promise<boolean> {
    return this.#observations.deploymentLogContains(
      nodePoolId,
      id,
      podUid,
      line,
    );
  }

  async submitPoolJob(
    nodePoolId: string,
    input: PoolJobSubmission,
  ): Promise<PoolJobAdmission> {
    invariantPoolJobImages(this.#environment);
    await this.#environment.preparePoolJobImages(nodePoolId);
    const args = cliArgs(
      'job',
      {
        id: input.id,
        'node-pool': nodePoolId,
        cpus: input.cpus ?? '0.1',
        bind: input.bind,
        privileged: input.privileged,
        memory: input.memory,
        'shm-size': input.shmSize,
        ipc: input.ipc,
        secret: input.secret,
        cache: input.cache,
        timeout: input.timeout,
      },
      [this.#environment.workloadImage()],
      ['sh', '-c', input.script],
    );
    const result = await this.#cli.run(args, {
      timeoutMs: 120_000,
      label: `pool-job-submit-${input.id}`,
    });
    return { exitCode: result.exitCode, output: result.combined };
  }

  /** `status --json` for a pool Job, which the tracked kernel doesn't own. */
  async poolJobStatus(id: string): Promise<StatusResponse> {
    const status = await this.#cli.run(
      cliArgs('status', { json: true }, [id]),
      {
        timeoutMs: 60_000,
        label: `pool-job-status-${id}`,
      },
    );
    if (status.exitCode !== 0 || status.timedOut || status.spawnError) {
      throw new Error(`Pool Job status failed: ${status.combined}`);
    }
    return JSON.parse(status.stdout) as StatusResponse;
  }

  async terminatePoolJob(id: string): Promise<void> {
    const result = await this.#cli.run(cliArgs('terminate', {}, [id]), {
      timeoutMs: 60_000,
      label: `pool-job-terminate-${id}`,
    });
    if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
      throw new Error(`Pool Job terminate failed: ${result.combined}`);
    }
  }

  /** `wait` and `status --json` for a pool Job, as its submitter sees them. */
  async poolJobOutcome(id: string): Promise<PoolJobOutcome> {
    const wait = await this.#cli.run(
      cliArgs('wait', { timeout: '300s' }, [id]),
      { timeoutMs: 360_000, label: `pool-job-wait-${id}` },
    );
    const { workload, attempt, events } = await this.poolJobStatus(id);
    const podUid = events.find((event) => event.state === WorkloadState.Syncing)
      ?.metadata?.podUid;
    const message = events.at(-1)?.metadata?.message;
    return {
      waitExit: wait.exitCode,
      state: workload.state,
      deploymentId: workload.deploymentId,
      nodePoolName: workload.nodePoolName ?? null,
      attempt: attempt ?? null,
      podUid: typeof podUid === 'string' ? podUid : null,
      message: typeof message === 'string' ? message : null,
    };
  }

  async poolJobPod(
    nodePoolId: string,
    id: string,
    line: string,
  ): Promise<{ deploymentId: string; podUid: string } | null> {
    const { workload, events } = await this.poolJobStatus(id);
    // The claim (`syncing`) names the replica; the runner's `running` doesn't.
    const podUid = events.findLast((event) => event.metadata?.podUid)?.metadata
      ?.podUid;
    const { deploymentId } = workload;
    return workload.state === WorkloadState.Running &&
      deploymentId &&
      typeof podUid === 'string' &&
      (await this.deploymentLogContains(nodePoolId, deploymentId, podUid, line))
      ? { deploymentId, podUid }
      : null;
  }

  /**
   * Delete a managed Deployment's replica Pod with no grace override, as an
   * eviction does, and return the ms until its container stopped.
   */
  async evictPoolJobReplica(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
  ): Promise<number> {
    const deletedAt = Date.now();
    await this.#observations.deleteReadyPod(nodePoolId, deploymentId, podUid);
    await this.#wait.for(
      'the evicted replica stopped',
      () => this.#observations.deploymentPod(nodePoolId, deploymentId, podUid),
      {
        timeoutMs: 180_000,
        intervalMs: 1000,
        probeError: 'fail',
        unmet: (pod) => (!pod || pod.containerStopped ? undefined : 'running'),
      },
    );
    return Date.now() - deletedAt;
  }

  drainPoolJobs(force: boolean): Promise<readonly string[]> {
    if (!this.#environment.drainPoolJobs) {
      throw new Error('This substrate has no pool Job drain');
    }
    return this.#environment.drainPoolJobs(force);
  }

  /** `anycloud logs [-f] <job>`'s output and exit code. */
  async poolJobLogs(
    id: string,
    follow: boolean,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const result = await this.#cli.run(cliArgs('logs', { follow }, [id]), {
      timeoutMs: 360_000,
      label: `pool-job-logs-${id}`,
    });
    if (result.timedOut || result.spawnError) {
      throw new Error(`Pool Job logs failed: ${result.combined}`);
    }
    return result;
  }

  /** `anycloud exec [--replica R] <id> <command>`'s output and exit code. */
  async exec(
    id: string,
    command: string,
    replica?: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const result = await this.#cli.run(
      cliArgs('exec', { replica }, [id, command]),
      { timeoutMs: 120_000, label: `exec-${id}` },
    );
    if (result.timedOut || result.spawnError) {
      throw new Error(`exec failed: ${result.combined}`);
    }
    return result;
  }

  /** `anycloud deployment list` as a user reads it. */
  async deploymentList(): Promise<string> {
    const result = await this.#cli.run(cliArgs('deployment list', {}), {
      timeoutMs: 60_000,
      label: 'deployment-list',
    });
    if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
      throw new Error(`Deployment list failed: ${result.combined}`);
    }
    return result.stdout;
  }

  deploymentPodCount(nodePoolId: string, id: string): Promise<number> {
    return this.#observations.deploymentPodCount(nodePoolId, id);
  }

  async deploymentCliLogs(id: string): Promise<string> {
    const result = await this.#cli.run(cliArgs('logs', {}, [id]), {
      timeoutMs: 60_000,
      label: 'kubernetes-deployment-logs',
    });
    if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
      throw new Error(`Deployment logs failed: ${result.combined}`);
    }
    return result.stdout;
  }

  deploymentReceive(
    nodePoolId: string,
    id: string,
    podUid: string,
    jobId?: string,
  ) {
    return this.#observations.deploymentReceive(nodePoolId, id, podUid, jobId);
  }

  async recordReadinessWakeup(
    evidence: ReadinessWakeupEvidence,
  ): Promise<void> {
    if (!this.#artifacts)
      throw new Error('Readiness qualification requires artifacts');
    await this.#artifacts.json(`readiness-wakeup-${evidence.jobId}`, evidence);
  }

  async releaseReadinessReservation(reservation: string): Promise<number> {
    const releasedAt = Date.now();
    await this.#environment.putReservation(reservation, 'complete');
    return releasedAt;
  }

  async recordDeploymentDrain(
    evidence: DeploymentDrainEvidence,
  ): Promise<void> {
    if (!this.#artifacts)
      throw new Error('Generation-drain qualification requires artifacts');
    await this.#artifacts.json(
      `deployment-drain-${evidence.deploymentId}`,
      evidence,
    );
  }

  async poolEgress(nodePoolId: string): Promise<PoolEgressObservation> {
    return probePoolEgress(
      await this.#clients(nodePoolId),
      this.#wait,
      nodePoolId,
    );
  }

  /**
   * Every Node of the pool is Ready, carries the membership label the API
   * sets, and runs its kubelet with the join script's drop-in: a
   * misplaced or misspelled one still lets it register.
   */
  async assertPoolNodes(nodePoolId: string): Promise<void> {
    const { core } = await this.#clients(nodePoolId);
    const nodes = await core.listNode({
      labelSelector: `anycloud.sh/node-pool=${nodePoolId}`,
    });
    if (nodes.items.length === 0) {
      throw new Error(`Node pool ${nodePoolId} has no Node to check`);
    }
    for (const node of nodes.items) {
      const name = node.metadata!.name!;
      const ready = node.status?.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      );
      if (!ready) throw new Error(`Node ${name} is not Ready`);
      if (node.metadata?.labels?.[NODE_POOL_MEMBER_LABEL] !== nodePoolId) {
        throw new Error(`Node ${name} is not a member of ${nodePoolId}`);
      }
      // Typed as a string, but the client parses the JSON body.
      const configz = (await core.connectGetNodeProxyWithPath({
        name,
        path: 'configz',
      })) as unknown as { kubeletconfig?: { singleProcessOOMKill?: boolean } };
      if (configz.kubeletconfig?.singleProcessOOMKill !== true) {
        throw new Error(`Node ${name} runs without singleProcessOOMKill`);
      }
    }
  }

  /** The pool's one Node's allocatable CPU less its Pods' requests. */
  async poolNodeFreeMillicores(nodePoolId: string): Promise<number> {
    const { core } = await this.#clients(nodePoolId);
    const nodes = await core.listNode({
      labelSelector: `anycloud.sh/node-pool=${nodePoolId}`,
    });
    const [node] = nodes.items;
    if (!node || nodes.items.length > 1) {
      throw new Error(
        `Node pool ${nodePoolId} must have one Node, not ${String(nodes.items.length)}`,
      );
    }
    const pods = await core.listPodForAllNamespaces({
      fieldSelector: `spec.nodeName=${node.metadata!.name!},status.phase!=Succeeded,status.phase!=Failed`,
    });
    const requested = pods.items.reduce(
      (sum, pod) => sum + podRequests(pod).cpu,
      0,
    );
    return quantity(node.status!.allocatable!.cpu, 1000) - requested;
  }

  /** Delete the node pool namespace's egress policy, as `kubectl delete` would. */
  async deletePoolEgressPolicy(nodePoolId: string): Promise<void> {
    const { objects } = await this.#clients(nodePoolId);
    await objects.delete({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: NODE_POOL_EGRESS_POLICY,
        namespace: nodePoolNamespace(nodePoolId),
      },
    });
  }

  nativeWrites(nodePoolId: string): Promise<NativeWrites> {
    if (!this.#environment.nativeWrites) {
      throw new Error('This substrate does not audit Kubernetes writes');
    }
    return this.#environment.nativeWrites(nodePoolId);
  }

  serviceNamespaceAbsent(nodePoolId: string, workloadId: string) {
    return this.#observations.serviceNamespaceAbsent(nodePoolId, workloadId);
  }

  servicePodReadyAt(nodePoolId: string, workloadId: string) {
    return this.#observations.servicePodReadyAt(nodePoolId, workloadId);
  }

  deploymentAbsent(
    nodePoolId: string,
    id: string,
  ): Promise<KubernetesDeploymentAbsenceFacts> {
    return this.#observations.deploymentAbsent(nodePoolId, id);
  }

  deleteDeploymentPod(
    nodePoolId: string,
    id: string,
    observedPodUid: string,
  ): Promise<string> {
    return this.#observations.deleteReadyPod(nodePoolId, id, observedPodUid);
  }

  deploymentOwnedObjects(nodePoolId: string, id: string) {
    return this.#observations.deploymentOwnedObjects(nodePoolId, id);
  }

  deploymentPod(nodePoolId: string, id: string, podUid: string) {
    return this.#observations.deploymentPod(nodePoolId, id, podUid);
  }

  deleteDeploymentOwnedObject(
    nodePoolId: string,
    id: string,
    kind: 'Secret' | 'ServiceAccount',
  ) {
    return this.#observations.deleteDeploymentOwnedObject(nodePoolId, id, kind);
  }

  capacityIdentities(nodePoolId: string) {
    return this.#environment.capacityIdentities(nodePoolId);
  }

  async submitTargetedJob(
    ref: TrackedWorkloadRef,
    deploymentId: string,
    options?: TargetedJobSubmissionOptions,
  ): Promise<TargetedJobSubmissionObservation> {
    this.#workloads.authorizeMutation(ref, ref.id);
    const response = await this.#sdk.json<TargetedJobSubmissionObservation>(
      {
        ...options,
        action: 'submit',
        deployment: deploymentId,
        workloadId: ref.id,
      },
      'kubernetes-targeted-job-submit',
    );
    if (response.id !== ref.id)
      throw new Error(`Targeted Job submission returned ${response.id}`);
    return response;
  }

  async submitConcurrentTargetedJobs(
    refs: readonly TrackedWorkloadRef[],
    deploymentId: string,
    options: TargetedJobSubmissionOptions,
  ): Promise<ConcurrentTargetedJobSubmissionsObservation> {
    const ids = refs.map((ref) => ref.id);
    if (ids.length < 2 || new Set(ids).size !== ids.length) {
      throw new Error('Concurrent submission requires distinct tracked Jobs');
    }
    for (const ref of refs) this.#workloads.authorizeMutation(ref, ref.id);
    const response =
      await this.#sdk.json<ConcurrentTargetedJobSubmissionsObservation>(
        {
          ...options,
          action: 'submit_concurrent',
          deployment: deploymentId,
          workloadIds: ids,
        },
        'kubernetes-async-concurrent-submissions',
      );
    if (
      response.jobs.length !== ids.length ||
      response.jobs.some((job, index) => job.id !== ids[index])
    ) {
      throw new Error('Concurrent submission returned different tracked Jobs');
    }
    await this.#artifacts?.json('kubernetes-async-submissions', response);
    return response;
  }

  targetedJobStatus(
    ref: TrackedWorkloadRef,
  ): Promise<TargetedJobWireStatusObservation> {
    return this.#sdk.json(
      { action: 'job_status', workloadId: ref.id },
      'kubernetes-targeted-job-status',
    );
  }

  startSubmissionResponseLoss(
    ref: TrackedWorkloadRef,
    deploymentId: string,
    fault: SubmissionResponseLossFault,
  ) {
    this.#workloads.authorizeMutation(ref, ref.id);
    return this.#sdk.startSubmissionResponseLoss({
      workloadId: ref.id,
      deployment: deploymentId,
      fault,
    });
  }

  deploymentWorkStarted(
    nodePoolId: string,
    deploymentId: string,
    jobId: string,
  ) {
    return this.#observations.deploymentWorkStarted(
      nodePoolId,
      deploymentId,
      jobId,
    );
  }

  async recordSubmissionResponseLoss(
    ref: TrackedWorkloadRef,
    evidence: SubmissionResponseLossWireEvidence,
  ): Promise<void> {
    if (!this.#artifacts)
      throw new Error('Response-loss evidence has no artifact store');
    await this.#artifacts.json(
      `kubernetes-response-loss-${evidence.fault}-${ref.id}`,
      {
        ...evidence,
        jobId: ref.id,
        workloadImage: this.#environment.workloadImage(),
      },
    );
  }

  async terminateTargetedJob(ref: TrackedWorkloadRef): Promise<void> {
    this.#workloads.authorizeMutation(ref, ref.id);
    const response = await this.#sdk.json<{ id: string }>(
      { action: 'terminate_job', workloadId: ref.id },
      'kubernetes-targeted-job-terminate',
    );
    if (response.id !== ref.id) {
      throw new Error(`Targeted Job termination returned ${response.id}`);
    }
  }

  async resubmitTargetedJob(
    ref: TrackedWorkloadRef,
    options?: TargetedJobSubmissionOptions,
  ): Promise<TargetedJobSubmissionObservation> {
    this.#workloads.authorizeMutation(ref, ref.id);
    const response = await this.#sdk.json<TargetedJobSubmissionObservation>(
      { ...options, action: 'resubmit_job', workloadId: ref.id },
      'kubernetes-targeted-job-resubmit',
    );
    if (response.id !== ref.id) {
      throw new Error(`Targeted Job resubmission returned ${response.id}`);
    }
    return response;
  }

  async duplicateTargetedJob(
    ref: TrackedWorkloadRef,
    deploymentId: string,
  ): Promise<TargetedJobRejection> {
    this.#workloads.authorizeMutation(ref, ref.id);
    const result = await this.#sdk.run(
      {
        action: 'submit',
        deployment: deploymentId,
        workloadId: ref.id,
      },
      'kubernetes-targeted-job-duplicate',
    );
    return {
      rejected: result.exitCode !== 0 && !result.timedOut,
      message: result.combined,
    };
  }

  async rejectTargetedBucket(
    ref: TrackedWorkloadRef,
    deploymentId: string,
  ): Promise<KubernetesAdmissionRejection> {
    this.#workloads.authorizeMutation(ref, ref.id);
    const result = await this.#sdk.run(
      {
        action: 'reject_targeted_bucket',
        deployment: deploymentId,
        workloadId: ref.id,
      },
      'kubernetes-targeted-bucket-rejection',
    );
    return {
      rejected: result.exitCode !== 0 && !result.timedOut,
      message: result.combined,
      persisted: await this.#environment.workloadPersisted(ref.id),
    };
  }
}
