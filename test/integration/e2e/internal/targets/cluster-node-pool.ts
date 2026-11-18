import type { WorkloadState } from '../../../../../src/shared/workload.js';

import type {
  NodePoolCreateTransport,
  NodePoolDeleteAttemptTransport,
  NodePoolDeleteTransport,
} from '../node-pool-mutations.js';
import type {
  DeploymentCreateInput,
  DeploymentCreateTransport,
  DeploymentDeleteTransport,
  DeploymentReadTransport,
  DeploymentUpdateInput,
  DeploymentUpdateTransport,
} from '../deployment-mutations.js';
import type { TrackedNodePoolRef } from '../node-pools.js';
import type { DeploymentKernel, TrackedDeploymentRef } from '../deployments.js';
import type { CleanupRecorded, TrackedWorkloadRef } from '../workloads.js';

export type ClusterNodePoolTarget = 'e2e-cluster-local';

/** A replica Pod's finalizers and hardening, read from its whole dump. */
export interface ReplicaPodFacts {
  readonly finalizers: readonly string[];
  readonly deleting: boolean;
  /** The workload container has terminated, or no longer shows running. */
  readonly containerStopped: boolean;
  readonly seccompProfile: string | null;
  readonly privilegeEscalation: boolean | null;
  readonly qosClass: string | null;
  readonly nodeName: string | null;
}

/** One attempt's stored log tail; null until the owner wrote it. */
export interface AttemptLogTail {
  readonly attempt: number;
  readonly logTailState: string | null;
  readonly logTail: string | null;
}

/** A Deployment's env Secret and ServiceAccount UIDs, when present. */
export interface KubernetesOwnedObjectUids {
  readonly secretUid: string | null;
  readonly serviceAccountUid: string | null;
}

/** What a node pool Service contract may do with a tracked Service Workload. */
export interface NodePoolServiceTransport {
  reserve(workloadId: string, timeoutMs: number): Promise<TrackedWorkloadRef>;
  /**
   * `anycloud service <image> --node-pool <id> --id <workload> --env
   * PORT=<port>`; Running once the product's readiness probe on `port` passes.
   */
  createAndAwaitRunning(
    ref: TrackedWorkloadRef,
    input: {
      readonly image: string;
      readonly port: number;
      readonly nodePoolId: string;
    },
    timeoutMs: number,
  ): Promise<{
    readonly nodePoolId: string | null;
    readonly liveVmCount: number;
    readonly runningEventAt: number;
  }>;
  /** `anycloud status --json`: the Service's state, latest message, public URL and the record's state. */
  publicEndpoint(ref: TrackedWorkloadRef): Promise<{
    /** Whether the product exposes `publicEndpoint` at all (Services slice 2b). */
    readonly supported: boolean;
    readonly state: string;
    readonly message: string | null;
    readonly url: string | null;
    readonly endpoint: {
      readonly ip: string | null;
      readonly state: 'published' | 'repointing' | 'stale';
      readonly error: string | null;
    } | null;
  }>;
  /** `anycloud logs <workload>`: the container log so far. */
  logs(ref: TrackedWorkloadRef): Promise<string>;
  terminate(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<CleanupRecorded>;
  release(ref: TrackedWorkloadRef, cleanup: CleanupRecorded): Promise<void>;
}

export type ReservationBehavior =
  | 'hold'
  | 'hold-no-cancel'
  | 'complete'
  | 'error'
  | 'retry'
  | 'oom';

export interface NodePoolRequest {
  readonly credentialName: string;
  readonly maxVmCount: number;
  readonly minVmCount: number;
  readonly name: string;
  /** Absent for an unpinned pool. */
  readonly region?: string;
  readonly vmTypes: string[];
  readonly spot?: boolean;
  readonly osDiskSizeGb?: number;
  readonly privilegedJobs?: boolean;
  readonly userNamespaceJobs?: boolean;
}

export interface KubernetesCapacityObservation {
  readonly nodePoolId: string;
  readonly liveVmCount: number;
  readonly totalVmCount: number;
  /** Ledger rows whose launch failed, with the recorded diagnosis. */
  readonly failedLaunches: readonly LaunchFailureRecord[];
}

export interface LaunchFailureRecord {
  readonly vmRowId: number;
  readonly region: string;
  readonly diagnosis: string;
}

export interface KubernetesCreatedNodePool {
  readonly id: string;
  readonly name: string;
}

export interface KubernetesNodePoolStatusObservation {
  readonly id: string;
  readonly name: string;
  readonly readyVmCount: number | null;
  readonly state: WorkloadState;
  /** Public IP of the pool's ingress entry Node once one is elected. */
  readonly ingressEntryIp?: string | null;
  /** The installer's view of the pool's ingress release, as `node-pool status --json` reports it. */
  readonly ingress?: KubernetesNodePoolIngressObservation | null;
}

export interface KubernetesNodePoolIngressObservation {
  readonly entryIp: string | null;
  readonly release: {
    readonly state: string;
    readonly helmJob: {
      readonly phase: string;
      readonly message: string | null;
    } | null;
    readonly daemonSet: {
      readonly desired: number;
      readonly ready: number;
      readonly entryNodeReady: boolean;
    } | null;
    readonly lastEvent: string | null;
  } | null;
}

export type KubernetesNodePoolDeletionAttempt =
  | { readonly kind: 'deleted' }
  | {
      readonly kind: 'rejected';
      readonly code: 'NODE_POOL_REFERENCED';
      readonly message: string;
    };

export interface KubernetesConnectionObservation {
  readonly nodePoolId: string;
  readonly connectionRevision: number;
  readonly kubernetesIdentity: string;
}

/** Contract-facing projection; the transport owns production DTO parsing. */
export interface ManagedKubernetesDeploymentSummary {
  readonly readinessProbe: Awaited<
    ReturnType<DeploymentReadTransport['status']>
  >['readinessProbe'];
  readonly status: Awaited<
    ReturnType<DeploymentReadTransport['status']>
  >['status'];
  readonly generation: number;
  readonly jobs: {
    readonly queued: number;
    readonly running: number;
    readonly unreleased: number;
  };
  readonly maxConcurrentJobsPerReplica: number;
}

export interface KubernetesCapacityIdentity {
  readonly vmRowId: number;
  readonly cloudId: string;
}

export interface KubernetesDeploymentReadyObservation {
  readonly generation: number;
  readonly podUid: string;
  /** Changes when kubelet restarts the container in place. */
  readonly containerId: string;
  readonly nodeName?: string;
}

export interface DeploymentReceiveObservation {
  readonly sequence: number;
  readonly startedAt: number;
  readonly returnedAt: number | null;
  readonly jobId: string | null;
  readonly probeSucceededAt: number | null;
  readonly observedAt: number;
}

export interface ReadinessWakeupEvidence {
  readonly phase: 'warmup' | 'recovery';
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly generation: number;
  readonly jobId: string;
  readonly podUid: string;
  readonly waitingSequence: number;
  readonly returnedSequence: number;
  readonly receiveStartedAt: number;
  readonly releasedAt: number;
  readonly probeSucceededAt: number;
  readonly returnedAt: number;
  readonly probeDetectionMs: number;
  readonly probeToReceiveMs: number;
}

export interface DeploymentDrainEvidence {
  readonly deploymentId: string;
  readonly previousGeneration: number;
  readonly requestedGeneration: number;
  readonly firstReleasedJobId: string;
  readonly lastReleasedJobId: string;
  readonly queuedJobId: string;
  readonly bothBlocked: {
    readonly unreleasedJobs: number;
    readonly status: NonNullable<ManagedKubernetesDeploymentSummary['status']>;
  };
  readonly oneBlocked: {
    readonly unreleasedJobs: number;
    readonly status: NonNullable<ManagedKubernetesDeploymentSummary['status']>;
    readonly queuedJobState: WorkloadState;
  };
  readonly replacement: NonNullable<
    ManagedKubernetesDeploymentSummary['status']
  >;
  readonly claim: {
    readonly generation: number;
    readonly podUid: string;
    readonly containerId: string;
  };
}

export interface KubernetesDeploymentAbsenceObservation {
  readonly workloads: number;
  readonly pods: number;
  readonly replicaSets: number;
  readonly secrets: number;
  readonly serviceAccounts: number;
}

export interface KubernetesAdmissionRejection {
  readonly message: string;
  readonly persisted: boolean;
  readonly rejected: boolean;
}

export interface KubernetesControllerReplacementObservation {
  readonly afterControllerInstance: string;
  readonly beforeControllerInstance: string;
  readonly endpoint: string;
  readonly scope: 'api-host' | 'api-process';
}

export interface TargetedJobRejection {
  readonly message: string;
  readonly rejected: boolean;
}

export interface TargetedJobSubmissionOptions {
  readonly timeout?: number;
  readonly wait?: boolean;
}

export interface TargetedJobSubmissionObservation {
  readonly id: string;
  readonly outcome: 'admitted' | 'claimed' | 'expired';
  readonly claimed: boolean;
  readonly submissionRevision: number;
  readonly claimDeadlineAt: number | null;
}

export interface ConcurrentTargetedJobSubmissionsObservation {
  readonly client: 'AsyncClient';
  readonly jobs: readonly TargetedJobSubmissionObservation[];
  readonly pendingTasks: number;
  readonly transportClosed: boolean;
}

export interface TargetedJobStatusObservation {
  readonly claimed: boolean;
  readonly submissionRevision: number;
  readonly claimDeadlineAt: number | null;
  readonly id: string;
  readonly state: WorkloadState;
  readonly targetsDeployment: true;
}

export interface TargetedJobWireStatusObservation {
  readonly claimed: boolean;
  readonly submissionRevision: number;
  readonly claimDeadlineAt: number | null;
  readonly deploymentId: string | null;
  readonly id: string;
  readonly state: WorkloadState;
}

export type SubmissionResponseLossFault = 'admission' | 'observation';

export interface SubmissionResponseLossCapture {
  readonly fault: SubmissionResponseLossFault;
  readonly jobId: string;
  readonly submissionRevision: number;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly outcome: string;
}

export interface SubmissionResponseLossObservation {
  readonly id: string;
  readonly uncertain: boolean;
  readonly outcome: string;
  readonly submissionRevision: number;
  readonly capture: SubmissionResponseLossCapture;
  readonly admissions: number;
  readonly resubmissions: number;
  readonly losses: number;
  readonly observations: readonly {
    readonly jobId: string;
    readonly submissionRevision: number;
    readonly afterLoss: boolean;
  }[];
  readonly client: string;
  readonly transportClosed: boolean;
  readonly pendingTasks: number;
}

export interface SubmissionResponseLossWireSession {
  readonly identity: {
    readonly sourceSha: string;
    readonly sourceStatus: string;
    readonly sourceChangesSha256: string;
    readonly sdkVersion: string;
    readonly sdkSha256: string;
    readonly apiVersion: string;
    readonly apiUrl: string;
    readonly apiGeneration: number;
  };
  captured(): Promise<SubmissionResponseLossCapture | null>;
  release(): Promise<void>;
  recovered(): Promise<SubmissionResponseLossObservation>;
  close(): Promise<void>;
}

export interface SubmissionResponseLossSession
  extends SubmissionResponseLossWireSession {
  readonly deployment: TrackedDeploymentRef;
  readonly job: TrackedWorkloadRef;
}

export interface DeploymentWorkObservation {
  readonly generation: number;
  readonly podUid: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly executionIds: readonly string[];
}

export interface SubmissionResponseLossEvidence {
  readonly fault: SubmissionResponseLossFault;
  readonly qualified: boolean;
  readonly identity: SubmissionResponseLossWireSession['identity'];
  readonly capture: SubmissionResponseLossCapture | null;
  readonly recovery?: SubmissionResponseLossObservation;
  readonly before?: DeploymentWorkObservation;
  readonly after?: DeploymentWorkObservation;
  readonly completed?: DeploymentWorkObservation;
  readonly cleanedAt?: number | null;
}

export interface SubmissionResponseLossWireEvidence
  extends SubmissionResponseLossEvidence {
  readonly deploymentId: string;
}

/** Each probe's outcome: `true` when its HTTP request succeeded. */
export interface PoolEgressObservation {
  /** From the node pool namespace, under its default egress policy. */
  readonly pool: {
    readonly podIp: boolean;
    readonly metadata: boolean;
    readonly internet: boolean;
    readonly crossNodePeer: boolean;
  };
  /** The same targets from a namespace without a policy. */
  readonly control: {
    readonly podIp: boolean;
    readonly metadata: boolean;
    readonly internet: boolean;
  };
}

export interface PoolVmRow {
  readonly id: number;
  readonly cloudId: string;
  readonly endedAt: number | null;
  readonly ip: string | null;
}

/** Audited writes so far, per resource (`secrets`, `deployments`, ...). */
export type NativeWrites = Readonly<Record<string, number>>;

export interface PoolJobSubmission {
  readonly id: string;
  readonly script: string;
  /** Refused unless the pool admits privileged or user-namespace Jobs. */
  readonly bind?: string;
  readonly privileged?: boolean;
  readonly cpus?: string;
  /** Replica options (OPTS): part of the managed Deployment's shape. */
  readonly memory?: string;
  readonly shmSize?: string;
  readonly ipc?: string;
  readonly secret?: string;
  /** `name:/path`, a Node cache shared by the pool's Jobs (RFC 0049 C12). */
  readonly cache?: string;
  /** Bounds the wait for the first claim (0044/S3). */
  readonly timeout?: string;
}

/** What a pool Job's submitter sees through `wait` and `status --json`. */
export interface PoolJobOutcome {
  readonly waitExit: number | null;
  readonly state: WorkloadState;
  readonly deploymentId: string | null;
  readonly nodePoolName: string | null;
  readonly attempt: number | null;
  /** The replica that claimed it, from its claim event. */
  readonly podUid: string | null;
  /** The last event's message, such as how an errored Job exited. */
  readonly message: string | null;
}

/** `anycloud job … --node-pool P`: its exit code and combined output. */
export interface PoolJobAdmission {
  readonly exitCode: number | null;
  readonly output: string;
}

export interface ClusterNodePoolWireTransport {
  /** Local Nodes only: the probe adds the metadata address to a Node. */
  poolEgress(nodePoolId: string): Promise<PoolEgressObservation>;
  /** Audited writes to the node pool namespace's objects, from any client. */
  nativeWrites(nodePoolId: string): Promise<NativeWrites>;
  deletePoolEgressPolicy(nodePoolId: string): Promise<void>;
  assertPoolNodes(nodePoolId: string): Promise<void>;
  activeNodePoolIds(): Promise<readonly string[]>;
  capacityIdentities(
    nodePoolId: string,
  ): Promise<readonly KubernetesCapacityIdentity[]>;
  capacity(nodePoolId: string): Promise<KubernetesCapacityObservation>;
  nodePoolAbsent(nodePoolId: string): Promise<boolean>;
  /** A `maxVmCount` above `vmCount` makes a scaling pool. */
  nodePoolRequest(
    name: string,
    vmCount: number,
    maxVmCount?: number,
  ): NodePoolRequest;
  /** Every VM row of a local pool (RFC 0048's launched and removed VMs). */
  poolVms(nodePoolId: string): Promise<readonly PoolVmRow[]>;
  /** A deleted local anycloud Pod its finalizer holds on the Node. */
  holdNodeWithFinalizer(
    nodeName: string,
  ): Promise<{ release(): Promise<void> }>;
  /** `budget set USD --per day`, or `budget unset --per day` for null. */
  accountBudget(usd: number | null): Promise<void>;
  nodePoolStatus(
    nodePoolId: string,
  ): Promise<KubernetesNodePoolStatusObservation>;
  connection(nodePoolId: string): Promise<KubernetesConnectionObservation>;
  deleteDeploymentPod(
    nodePoolId: string,
    id: string,
    observedPodUid: string,
  ): Promise<string>;
  deploymentOwnedObjects(
    nodePoolId: string,
    id: string,
  ): Promise<KubernetesOwnedObjectUids>;
  deploymentPod(
    nodePoolId: string,
    id: string,
    podUid: string,
  ): Promise<ReplicaPodFacts | null>;
  deleteDeploymentOwnedObject(
    nodePoolId: string,
    id: string,
    kind: 'Secret' | 'ServiceAccount',
  ): Promise<void>;
  deleteOneCapacityHost(nodePoolId: string, vmRowId?: number): Promise<string>;
  /** The Node a replica runs on, and its VM row from its attempt label. */
  replicaNode(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
  ): Promise<{ name: string; vmRowId: number }>;
  nodePresent(nodePoolId: string, name: string): Promise<boolean>;
  serviceNamespaceAbsent(
    nodePoolId: string,
    workloadId: string,
  ): Promise<boolean>;
  servicePodReadyAt(
    nodePoolId: string,
    workloadId: string,
  ): Promise<number | null>;
  deploymentAbsent(
    nodePoolId: string,
    id: string,
  ): Promise<KubernetesDeploymentAbsenceObservation>;
  deploymentReady(
    nodePoolId: string,
    id: string,
  ): Promise<KubernetesDeploymentReadyObservation | null>;
  deploymentLogContains(
    nodePoolId: string,
    id: string,
    podUid: string,
    line: string,
  ): Promise<boolean>;
  /** `anycloud logs <deployment>`: its newest Pod's log so far. */
  deploymentCliLogs(id: string): Promise<string>;
  /** Pods a Deployment's selector matches; a managed one has no tracked ref. */
  deploymentPodCount(nodePoolId: string, id: string): Promise<number>;
  poolJobOutcome(id: string): Promise<PoolJobOutcome>;
  /** The replica Pod running a pool Job once its log has `line`, or null. */
  poolJobPod(
    nodePoolId: string,
    id: string,
    line: string,
  ): Promise<{ deploymentId: string; podUid: string } | null>;
  /** ms from a no-override delete until the replica's container stopped. */
  evictPoolJobReplica(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
  ): Promise<number>;
  poolJobLogs(
    id: string,
    follow: boolean,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** `anycloud exec [--replica R] <id> <command>` for a Job or Deployment. */
  exec(
    id: string,
    command: string,
    replica?: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  deploymentList(): Promise<string>;
  drainPoolJobs(force: boolean): Promise<readonly string[]>;
  /** `status --json` of a pool Job: its state, events and wait reason. */
  poolJobStatus(id: string): Promise<{
    readonly workload: { readonly state: WorkloadState };
    readonly events: readonly {
      readonly state: string;
      readonly metadata?: Readonly<Record<string, unknown>> | null;
    }[];
    readonly waiting?: string;
  }>;
  terminatePoolJob(id: string): Promise<void>;
  poolNodeFreeMillicores(nodePoolId: string): Promise<number>;
  /** `anycloud job IMAGE --node-pool P -- sh -c SCRIPT` (RFC 0044 decision 26). */
  submitPoolJob(
    nodePoolId: string,
    input: PoolJobSubmission,
  ): Promise<PoolJobAdmission>;
  deploymentReceive(
    nodePoolId: string,
    id: string,
    podUid: string,
    jobId?: string,
  ): Promise<DeploymentReceiveObservation | null>;
  recordReadinessWakeup(evidence: ReadinessWakeupEvidence): Promise<void>;
  recordDeploymentDrain(evidence: DeploymentDrainEvidence): Promise<void>;
  duplicateTargetedJob(
    ref: TrackedWorkloadRef,
    deploymentId: string,
  ): Promise<TargetedJobRejection>;
  prepare(): Promise<void>;
  putReservation(jobId: string, behavior: ReservationBehavior): Promise<void>;
  releaseReadinessReservation(reservation: string): Promise<number>;
  recordNodePool(nodePoolId: string): void;
  rejectTargetedBucket(
    ref: TrackedWorkloadRef,
    deploymentId: string,
  ): Promise<KubernetesAdmissionRejection>;
  replaceController(): Promise<KubernetesControllerReplacementObservation>;
  reservationBaseUrl(): string;
  reservationLookups(jobId: string): Promise<number>;
  attemptLogTails(jobId: string): Promise<readonly AttemptLogTail[]>;
  submitTargetedJob(
    ref: TrackedWorkloadRef,
    deploymentId: string,
    options?: TargetedJobSubmissionOptions,
  ): Promise<TargetedJobSubmissionObservation>;
  submitConcurrentTargetedJobs(
    refs: readonly TrackedWorkloadRef[],
    deploymentId: string,
    options: TargetedJobSubmissionOptions,
  ): Promise<ConcurrentTargetedJobSubmissionsObservation>;
  startSubmissionResponseLoss(
    ref: TrackedWorkloadRef,
    deploymentId: string,
    fault: SubmissionResponseLossFault,
  ): Promise<SubmissionResponseLossWireSession>;
  deploymentWorkStarted(
    nodePoolId: string,
    deploymentId: string,
    jobId: string,
  ): Promise<DeploymentWorkObservation | null>;
  recordSubmissionResponseLoss(
    ref: TrackedWorkloadRef,
    evidence: SubmissionResponseLossWireEvidence,
  ): Promise<void>;
  targetedJobStatus(
    ref: TrackedWorkloadRef,
  ): Promise<TargetedJobWireStatusObservation>;
  terminateTargetedJob(ref: TrackedWorkloadRef): Promise<void>;
  resubmitTargetedJob(
    ref: TrackedWorkloadRef,
    options?: TargetedJobSubmissionOptions,
  ): Promise<TargetedJobSubmissionObservation>;
  waitForReconcileOpportunity(): Promise<void>;
}

function deploymentSummary(
  deployment: ManagedKubernetesDeploymentSummary,
): ManagedKubernetesDeploymentSummary {
  return {
    readinessProbe: deployment.readinessProbe,
    status: deployment.status,
    generation: deployment.generation,
    jobs: deployment.jobs,
    maxConcurrentJobsPerReplica: deployment.maxConcurrentJobsPerReplica,
  };
}

export class ClusterNodePoolAdapter {
  readonly #deleteAttempts: NodePoolDeleteAttemptTransport;
  readonly #deploymentMutations: DeploymentCreateTransport &
    DeploymentDeleteTransport &
    DeploymentReadTransport &
    DeploymentUpdateTransport;
  readonly #deployments: Pick<DeploymentKernel, 'coordinates'>;
  readonly #mutations: NodePoolCreateTransport & NodePoolDeleteTransport;
  readonly #transport: ClusterNodePoolWireTransport;
  readonly #readyByCli: (
    reference: string,
    timeoutMs: number,
  ) => Promise<boolean>;

  constructor(
    transport: ClusterNodePoolWireTransport,
    mutations: NodePoolCreateTransport & NodePoolDeleteTransport,
    deleteAttempts: NodePoolDeleteAttemptTransport,
    deployments: Pick<DeploymentKernel, 'coordinates'>,
    deploymentMutations: DeploymentCreateTransport &
      DeploymentDeleteTransport &
      DeploymentReadTransport &
      DeploymentUpdateTransport,
    readyByCli: (reference: string, timeoutMs: number) => Promise<boolean>,
  ) {
    this.#readyByCli = readyByCli;
    this.#transport = transport;
    this.#mutations = mutations;
    this.#deleteAttempts = deleteAttempts;
    this.#deployments = deployments;
    this.#deploymentMutations = deploymentMutations;
  }

  prepare(): Promise<void> {
    return this.#transport.prepare();
  }

  /** `anycloud wait node-pool/<id>` reports the node pool ready. */
  nodePoolReadyByCli(id: string, timeoutMs: number): Promise<boolean> {
    return this.#readyByCli(`node-pool/${id}`, timeoutMs);
  }

  /** `anycloud wait deployment/<id>` reports the Deployment ready. */
  deploymentReadyByCli(ref: TrackedDeploymentRef): Promise<boolean> {
    return this.#readyByCli(
      `deployment/${this.#deployments.coordinates(ref).id}`,
      60_000,
    );
  }

  nodePoolRequest(name: string, vmCount: number, maxVmCount?: number) {
    return this.#transport.nodePoolRequest(name, vmCount, maxVmCount);
  }

  poolVms(nodePoolId: string) {
    return this.#transport.poolVms(nodePoolId);
  }

  holdNodeWithFinalizer(nodeName: string) {
    return this.#transport.holdNodeWithFinalizer(nodeName);
  }

  accountBudget(usd: number | null) {
    return this.#transport.accountBudget(usd);
  }

  /** RFC 0048's last buying pass in a pool's status: when, and what it bought. */
  scaleOutPass(status: {
    readonly capacity?: {
      readonly lastScaleOut?: { readonly at: number; readonly vms: number };
    } | null;
  }): { readonly at: number; readonly bought: number } | null {
    const pass = status.capacity?.lastScaleOut;
    return pass ? { at: pass.at, bought: pass.vms } : null;
  }

  async create(
    ref: TrackedNodePoolRef,
    { privilegedJobs, ...request }: NodePoolRequest,
  ) {
    const nodePool = await this.#mutations.create(ref, {
      ...request,
      allowPrivilegedJobs: privilegedJobs,
    });
    return { id: nodePool.id, name: nodePool.name };
  }

  async delete(ref: TrackedNodePoolRef): Promise<void> {
    await this.#mutations.delete(ref);
  }

  async attemptDelete(ref: TrackedNodePoolRef) {
    const attempt = await this.#deleteAttempts.attemptDelete(ref);
    return attempt.kind === 'deleted'
      ? ({ kind: 'deleted' } as const)
      : ({
          kind: 'rejected',
          code: attempt.code,
          message: attempt.message,
        } as const);
  }

  recordNodePool(nodePoolId: string): void {
    this.#transport.recordNodePool(nodePoolId);
  }

  capacityIdentities(nodePoolId: string) {
    return this.#transport.capacityIdentities(nodePoolId);
  }

  activeNodePoolIds(): Promise<readonly string[]> {
    return this.#transport.activeNodePoolIds();
  }

  nodePoolStatus(nodePoolId: string) {
    return this.#transport.nodePoolStatus(nodePoolId);
  }

  nodePoolAbsent(nodePoolId: string): Promise<boolean> {
    return this.#transport.nodePoolAbsent(nodePoolId);
  }

  capacity(nodePoolId: string) {
    return this.#transport.capacity(nodePoolId);
  }

  connection(nodePoolId: string) {
    return this.#transport.connection(nodePoolId);
  }

  deleteOneCapacityHost(nodePoolId: string, vmRowId?: number): Promise<string> {
    return this.#transport.deleteOneCapacityHost(nodePoolId, vmRowId);
  }

  replicaNode(nodePoolId: string, deploymentId: string, podUid: string) {
    return this.#transport.replicaNode(nodePoolId, deploymentId, podUid);
  }

  nodePresent(nodePoolId: string, name: string) {
    return this.#transport.nodePresent(nodePoolId, name);
  }

  replaceController() {
    return this.#transport.replaceController();
  }

  createDeployment(
    ref: TrackedDeploymentRef,
    input: DeploymentCreateInput,
  ): Promise<ManagedKubernetesDeploymentSummary> {
    return this.#deploymentMutations.create(ref, input).then(deploymentSummary);
  }

  waitForReconcileOpportunity(): Promise<void> {
    return this.#transport.waitForReconcileOpportunity();
  }

  async deploymentStatus(
    ref: TrackedDeploymentRef,
  ): Promise<ManagedKubernetesDeploymentSummary> {
    return deploymentSummary(await this.#deploymentMutations.status(ref));
  }

  updateDeployment(
    ref: TrackedDeploymentRef,
    input: DeploymentUpdateInput,
  ): Promise<ManagedKubernetesDeploymentSummary> {
    return this.#deploymentMutations.update(ref, input).then(deploymentSummary);
  }

  async deleteDeployment(ref: TrackedDeploymentRef): Promise<void> {
    await this.#deploymentMutations.delete(ref);
  }

  deploymentReady(ref: TrackedDeploymentRef) {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deploymentReady(nodePoolId, id);
  }

  deploymentLogContains(
    ref: TrackedDeploymentRef,
    podUid: string,
    line: string,
  ): Promise<boolean> {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deploymentLogContains(nodePoolId, id, podUid, line);
  }

  submitPoolJob(nodePoolId: string, input: PoolJobSubmission) {
    return this.#transport.submitPoolJob(nodePoolId, input);
  }

  deploymentPodCount(nodePoolId: string, id: string) {
    return this.#transport.deploymentPodCount(nodePoolId, id);
  }

  poolJobOutcome(id: string) {
    return this.#transport.poolJobOutcome(id);
  }

  poolJobPod(nodePoolId: string, id: string, line: string) {
    return this.#transport.poolJobPod(nodePoolId, id, line);
  }

  /** A pool Job's replica Pod as the API serves it, or null. */
  poolJobReplica(nodePoolId: string, deploymentId: string, podUid: string) {
    return this.#transport.deploymentPod(nodePoolId, deploymentId, podUid);
  }

  evictPoolJobReplica(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
  ) {
    return this.#transport.evictPoolJobReplica(
      nodePoolId,
      deploymentId,
      podUid,
    );
  }

  poolJobLogs(id: string, follow: boolean) {
    return this.#transport.poolJobLogs(id, follow);
  }

  exec(id: string, command: string, replica?: string) {
    return this.#transport.exec(id, command, replica);
  }

  deploymentExec(ref: TrackedDeploymentRef, command: string, replica?: string) {
    return this.#transport.exec(
      this.#deployments.coordinates(ref).id,
      command,
      replica,
    );
  }

  deploymentList() {
    return this.#transport.deploymentList();
  }

  drainPoolJobs(force: boolean) {
    return this.#transport.drainPoolJobs(force);
  }

  poolJobStatus(id: string) {
    return this.#transport.poolJobStatus(id);
  }

  terminatePoolJob(id: string) {
    return this.#transport.terminatePoolJob(id);
  }

  poolNodeFreeMillicores(nodePoolId: string) {
    return this.#transport.poolNodeFreeMillicores(nodePoolId);
  }

  deploymentCliLogs(ref: TrackedDeploymentRef): Promise<string> {
    return this.#transport.deploymentCliLogs(
      this.#deployments.coordinates(ref).id,
    );
  }

  deploymentReceive(
    ref: TrackedDeploymentRef,
    podUid: string,
    jobId?: string,
  ): Promise<DeploymentReceiveObservation | null> {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deploymentReceive(nodePoolId, id, podUid, jobId);
  }

  recordReadinessWakeup(
    ref: TrackedDeploymentRef,
    evidence: Omit<ReadinessWakeupEvidence, 'deploymentId' | 'deploymentName'>,
  ): Promise<void> {
    return this.#transport.recordReadinessWakeup({
      ...evidence,
      deploymentId: this.#deployments.coordinates(ref).id,
      deploymentName: ref.name,
    });
  }

  releaseReadinessReservation(reservation: string): Promise<number> {
    return this.#transport.releaseReadinessReservation(reservation);
  }

  poolEgress(nodePoolId: string) {
    return this.#transport.poolEgress(nodePoolId);
  }

  nativeWrites(nodePoolId: string) {
    return this.#transport.nativeWrites(nodePoolId);
  }

  deletePoolEgressPolicy(nodePoolId: string) {
    return this.#transport.deletePoolEgressPolicy(nodePoolId);
  }

  assertPoolNodes(nodePoolId: string) {
    return this.#transport.assertPoolNodes(nodePoolId);
  }

  serviceNamespaceAbsent(nodePoolId: string, workloadId: string) {
    return this.#transport.serviceNamespaceAbsent(nodePoolId, workloadId);
  }

  servicePodReadyAt(nodePoolId: string, workloadId: string) {
    return this.#transport.servicePodReadyAt(nodePoolId, workloadId);
  }

  deploymentAbsent(ref: TrackedDeploymentRef) {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deploymentAbsent(nodePoolId, id);
  }

  deploymentAbsentInNodePool(ref: TrackedDeploymentRef, nodePoolId: string) {
    return this.#transport.deploymentAbsent(
      nodePoolId,
      this.#deployments.coordinates(ref).id,
    );
  }

  deleteDeploymentPod(
    ref: TrackedDeploymentRef,
    observedPodUid: string,
  ): Promise<string> {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deleteDeploymentPod(nodePoolId, id, observedPodUid);
  }

  deploymentOwnedObjects(ref: TrackedDeploymentRef) {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deploymentOwnedObjects(nodePoolId, id);
  }

  /** One replica Pod as the API serves it (`kubectl get pod -o json`), or null. */
  deploymentPod(
    ref: TrackedDeploymentRef,
    podUid: string,
  ): Promise<ReplicaPodFacts | null> {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deploymentPod(nodePoolId, id, podUid);
  }

  deleteDeploymentOwnedObject(
    ref: TrackedDeploymentRef,
    kind: 'Secret' | 'ServiceAccount',
  ) {
    const { nodePoolId, id } = this.#deployments.coordinates(ref);
    return this.#transport.deleteDeploymentOwnedObject(nodePoolId, id, kind);
  }

  reservationBaseUrl(): string {
    return this.#transport.reservationBaseUrl();
  }

  putReservation(jobId: string, behavior: ReservationBehavior): Promise<void> {
    return this.#transport.putReservation(jobId, behavior);
  }

  reservationLookups(jobId: string): Promise<number> {
    return this.#transport.reservationLookups(jobId);
  }

  attemptLogTails(jobId: string): Promise<readonly AttemptLogTail[]> {
    return this.#transport.attemptLogTails(jobId);
  }

  submitTargetedJob(
    ref: TrackedWorkloadRef,
    deployment: TrackedDeploymentRef,
    options?: TargetedJobSubmissionOptions,
  ) {
    return this.#transport.submitTargetedJob(
      ref,
      this.#deployments.coordinates(deployment).id,
      options,
    );
  }

  submitConcurrentTargetedJobs(
    refs: readonly TrackedWorkloadRef[],
    deployment: TrackedDeploymentRef,
    options: TargetedJobSubmissionOptions,
  ) {
    return this.#transport.submitConcurrentTargetedJobs(
      refs,
      this.#deployments.coordinates(deployment).id,
      options,
    );
  }

  async targetedJobStatus(
    ref: TrackedWorkloadRef,
    deployment: TrackedDeploymentRef,
  ): Promise<TargetedJobStatusObservation> {
    const status = await this.#transport.targetedJobStatus(ref);
    if (status.id !== ref.id) {
      throw new Error(
        `Targeted Job status identified ${status.id}, expected ${ref.id}`,
      );
    }
    const { id } = this.#deployments.coordinates(deployment);
    if (status.deploymentId !== id) {
      throw new Error(
        `Targeted Job ${ref.id} identified Deployment ${status.deploymentId ?? 'none'}, expected the tracked Deployment`,
      );
    }
    const { deploymentId: _deploymentId, ...observation } = status;
    return { ...observation, targetsDeployment: true };
  }

  async startSubmissionResponseLoss(
    ref: TrackedWorkloadRef,
    deployment: TrackedDeploymentRef,
    fault: SubmissionResponseLossFault,
  ): Promise<SubmissionResponseLossSession> {
    const expected = this.#deployments.coordinates(deployment);
    const wire = await this.#transport.startSubmissionResponseLoss(
      ref,
      expected.id,
      fault,
    );
    const assertBinding = (): void => {
      const current = this.#deployments.coordinates(deployment);
      if (
        current.id !== expected.id ||
        current.nodePoolId !== expected.nodePoolId
      ) {
        throw new Error('Response-loss session changed its tracked Deployment');
      }
    };
    return Object.freeze({
      deployment,
      job: ref,
      identity: Object.freeze({ ...wire.identity }),
      captured: async () => {
        assertBinding();
        const capture = await wire.captured();
        if (capture && capture.jobId !== ref.id) {
          throw new Error(
            `Response-loss session captured Job ${capture.jobId}, expected ${ref.id}`,
          );
        }
        return capture;
      },
      release: async () => {
        assertBinding();
        await wire.release();
      },
      recovered: async () => {
        assertBinding();
        const recovery = await wire.recovered();
        if (recovery.id !== ref.id) {
          throw new Error(
            `Response-loss session recovered Job ${recovery.id}, expected ${ref.id}`,
          );
        }
        return recovery;
      },
      close: () => wire.close(),
    });
  }

  deploymentWorkStarted(
    deployment: TrackedDeploymentRef,
    job: TrackedWorkloadRef,
  ) {
    const { nodePoolId, id } = this.#deployments.coordinates(deployment);
    return this.#transport.deploymentWorkStarted(nodePoolId, id, job.id);
  }

  recordSubmissionResponseLoss(
    ref: TrackedWorkloadRef,
    deployment: TrackedDeploymentRef,
    evidence: SubmissionResponseLossEvidence,
  ) {
    const { id } = this.#deployments.coordinates(deployment);
    return this.#transport.recordSubmissionResponseLoss(ref, {
      ...evidence,
      deploymentId: id,
    });
  }

  terminateTargetedJob(ref: TrackedWorkloadRef): Promise<void> {
    return this.#transport.terminateTargetedJob(ref);
  }

  resubmitTargetedJob(
    ref: TrackedWorkloadRef,
    options?: TargetedJobSubmissionOptions,
  ) {
    return this.#transport.resubmitTargetedJob(ref, options);
  }

  recordDeploymentDrain(
    ref: TrackedDeploymentRef,
    evidence: Omit<DeploymentDrainEvidence, 'deploymentId'>,
  ): Promise<void> {
    const { id } = this.#deployments.coordinates(ref);
    return this.#transport.recordDeploymentDrain({
      ...evidence,
      deploymentId: id,
    });
  }

  duplicateTargetedJob(
    ref: TrackedWorkloadRef,
    deployment: TrackedDeploymentRef,
  ) {
    return this.#transport.duplicateTargetedJob(
      ref,
      this.#deployments.coordinates(deployment).id,
    );
  }

  rejectTargetedBucket(
    ref: TrackedWorkloadRef,
    deployment: TrackedDeploymentRef,
  ) {
    return this.#transport.rejectTargetedBucket(
      ref,
      this.#deployments.coordinates(deployment).id,
    );
  }
}
