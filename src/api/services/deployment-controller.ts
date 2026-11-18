import {
  setHeaderOptions,
  type KubernetesObject,
  type V1Deployment as KubernetesDeployment,
  type V1Node,
  type V1Pod,
} from '@kubernetes/client-node';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  LIVE_EXECUTION_STATES,
  WorkloadState,
  isTerminalState,
} from '../../shared/workload.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import { getWorkloadApiUrl } from '../config.js';
import { inClientWindow } from './api-version.js';
import type { DeploymentControl } from './deployments-domain.js';
import {
  deploymentTarget,
  type DeploymentRepository,
  type DeploymentTarget,
} from './deployment-store.js';
import type {
  TargetedExecutionIdentity,
  TargetedJobCounts,
} from './repositories/deployment-executions.js';
import {
  getCredentialSecretStore,
  getDeploymentExecutionStore,
  getDeploymentStore,
  getPersistence,
  getReplicaDemandStore,
} from './persistence.js';
import {
  getDefaultClusterRuntimeResolver,
  getDefaultDeploymentRuntimeResolver,
} from './kubernetes/default-runtime.js';
import type { ClusterKubernetesClient } from './kubernetes/cluster-client.js';
import {
  KUBERNETES_DEPLOYMENT_COMPONENT,
  KUBERNETES_TEMPLATE_ANNOTATION,
} from './kubernetes/identity.js';
import type { DeploymentRuntimeResolver } from './kubernetes/deployment-runtime.js';
import {
  egressPolicyDiffers,
  ensureNodePoolNamespace,
  NODE_POOL_EGRESS_POLICY,
  NodePoolNamespaceOwnershipError,
  NodePoolNamespaceTerminatingError,
} from './kubernetes/node-pool-namespace.js';
import {
  deleteKubernetesResourcePlan,
  KubernetesResourceOwnershipError,
  kubernetesWorkloadOwner,
} from './kubernetes/managed-resources.js';
import {
  attemptEndOf,
  DEPLOYMENT_POLICY,
  RUNNER_REPLICA_POLICY,
  type OutcomePolicy,
} from './job-outcome.js';
import { preflightKubernetesDeployment } from './kubernetes/preflight.js';
import {
  classify,
  terminationEvidence,
  type PodEvidence,
} from './kubernetes/pod-termination.js';
import { captureTail, type CapturedTail } from './kubernetes/pod-logs.js';
import {
  KUBERNETES_DEPLOYMENT_CONTAINER,
  releasePodFinalizer,
} from './kubernetes/pool-objects.js';
import { podShare } from './pool-fit.js';
import {
  ATTEMPT_NODE_LABEL,
  isNodePoolAttemptId,
} from './kubernetes/node-pool-scheduling.js';
import { awaitWithSignal } from './request-budget.js';
import { createSpendAdmission, findReplicaCapBlock } from './spend-controls.js';
import {
  createReplicaPolicy,
  drainReplica,
  type ReplicaPolicyDependencies,
} from './deployment-replicas.js';
import {
  applyDiffering,
  appliedGenerationOf,
  deleteCached,
  observeDeployment,
  ownedHere,
  ownedResources,
  renderDeploymentObjects,
  replicaCannotRun,
} from './deployment-objects.js';
import {
  createPoolReconciler,
  type PoolOwner,
  type PoolView,
} from './pool-reconciler.js';

/**
 * A replica outlives its executions: one ends when its container stops, or
 * when its Pod is over, as Pod GC marks one whose Node is gone while its
 * container still shows running. An eviction's `DisruptionTarget` alone
 * isn't an end: the container runs out its grace period first.
 */
const attemptEnds = (evidence: PodEvidence | null) =>
  evidence?.main.kind !== 'running' ||
  evidence.phase === 'Failed' ||
  evidence.phase === 'Succeeded';

/**
 * One execution's verdict, or null while its container instance runs. A
 * managed Deployment's pool Jobs end as batch Jobs do (RFC 0044 § Outcomes).
 */
function settle(
  evidence: PodEvidence | null,
  policy: OutcomePolicy,
): ReturnType<typeof attemptEndOf> | null {
  if (!attemptEnds(evidence)) return null;
  const cause = classify(evidence);
  if (policy !== RUNNER_REPLICA_POLICY || cause.kind !== 'exit' || cause.oom) {
    return attemptEndOf(policy, cause);
  }
  // The runner reports nothing on a replica SIGTERM, so a deleted replica's
  // plain exit is anycloud's drain, Node removal or rollout, not the Job's.
  // Any other exit the kubelet hasn't restarted in place, on a Pod that
  // hasn't ended, waits for it to write why: an eviction at the limit gives
  // the runner 2 s, so it exits 143 or is killed (RFC 0043 S12).
  if (evidence?.deleting) {
    return attemptEndOf(policy, {
      kind: 'disrupted',
      detail: 'replica stopped: its Pod was deleted',
    });
  }
  if (
    evidence?.main.kind === 'ended' &&
    !evidence.main.restarted &&
    !['Failed', 'Succeeded'].includes(evidence.phase)
  ) {
    return null;
  }
  return attemptEndOf(policy, cause);
}

/**
 * Kubelet refreshes a projected token within its one-hour lifetime, for the
 * ServiceAccount's current UID, so a replica older than a recreated
 * ServiceAccount holds a stale token only for this long after it.
 */
const TOKEN_REFRESH_MS = 3_600_000;

/**
 * Twice kubelet's longest image pull back-off (5 min): a token stored this
 * long ago has been tried, as kubelet retries only at the next Pod sync
 * after the back-off and the owner writes the pull Secret after admission.
 */
const PULL_BACK_OFF_MS = 2 * 5 * 60_000;

/** A managed Deployment with no Job for this long is deleted. */
const MANAGED_IDLE_MS = 24 * 3_600_000;

export interface DeploymentController extends DeploymentControl {
  /** A cluster's anycloud Pods in the loop's watch cache; throws until synced. */
  pods(clusterId: string): V1Pod[];
  /** The pool's Pending Pods that no empty Node of it holds (RFC 0048 S9). */
  unfit(nodePoolId: string, reason: string, podUids: ReadonlySet<string>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The Deployment execution operations rollout, drain and recovery use. */
interface DeploymentControllerJobs {
  countTargetedJobs(deploymentId: string): Promise<TargetedJobCounts>;
  listTargetedExecutions(
    deploymentId: string,
  ): Promise<TargetedExecutionIdentity[]>;
  reportTargetedJobExecution(
    jobId: string,
    executionId: string,
    end: ReturnType<typeof attemptEndOf>,
  ): Promise<boolean>;
  recordPodNode(executionId: string, node: string): Promise<void>;
  recordAttemptLogTail(executionId: string, tail: CapturedTail): Promise<void>;
  /** Whether `api upgrade --force` stopped this execution's replica. */
  wasForcedStop(executionId: string): boolean;
  /** Refuse every later claim on a replica that is about to be released. */
  closeReplica(podUid: string): void;
  completeTargetedJobCleanup(
    jobId: string,
    executionId: string,
  ): Promise<boolean>;
  terminateUnassignedTargetedJobs(
    deploymentId: string,
    invalid?: { message: string; before: number },
  ): Promise<void>;
}

interface DeploymentOwnerInput {
  deployments: Pick<
    DeploymentRepository,
    | 'getById'
    | 'listForReconciliation'
    | 'markDeleted'
    | 'advanceGeneration'
    | 'recordRunnerRelease'
    | 'recordOccupancy'
    | 'requestIdleDeletion'
  >;
  jobs: DeploymentControllerJobs;
  replicas: ReplicaPolicyDependencies;
  secrets: {
    getSecretValues(name: string): Promise<Record<string, string> | null>;
  };
  runtimes: DeploymentRuntimeResolver;
  workloadApiUrl: string;
  /** Wakes the claim queue's waits on any change to a Deployment's objects. */
  changed?: (id: string) => void;
  now?: () => number;
}

/** The Deployment record's owner on the pool loop. */
export function createDeploymentOwner(input: DeploymentOwnerInput): PoolOwner {
  const now = input.now ?? Date.now;
  const replicas = createReplicaPolicy(input.replicas);

  /**
   * Settle every execution whose container instance has ended: a running
   * one's tail, then its outcome, so a crash between them can't lose the
   * tail; a terminal one's cleanup. The tails are read at once, so a lost
   * Node's unreachable kubelet delays its retries by one read's timeout,
   * not one per execution. A failed write throws, which keeps the
   * replica's finalizer until a later pass succeeds.
   */
  async function recoverExecutions(
    cluster: ClusterKubernetesClient,
    executions: TargetedExecutionIdentity[],
    pods: V1Pod[],
    policy: OutcomePolicy,
  ): Promise<void> {
    const ended = executions.flatMap((execution) => {
      const pod = pods.find((item) => item.metadata?.uid === execution.podUid);
      const evidence = pod
        ? terminationEvidence(
            pod,
            KUBERNETES_DEPLOYMENT_CONTAINER,
            execution.containerId,
          )
        : null;
      // Decision 30: a forced upgrade's stop retries the Job, whatever the
      // replica's exit says, without waiting for the kubelet to say why.
      const end =
        input.jobs.wasForcedStop(execution.executionId) && attemptEnds(evidence)
          ? attemptEndOf(policy, {
              kind: 'disrupted',
              detail:
                'forced upgrade: the replica stopped before its runner reported',
            })
          : settle(evidence, policy);
      if (!end) return [];
      // captureTail never rejects, so a write failing below strands none.
      const tail = LIVE_EXECUTION_STATES.includes(execution.state)
        ? captureTail(
            cluster,
            pod,
            KUBERNETES_DEPLOYMENT_CONTAINER,
            execution.containerId,
            policy === RUNNER_REPLICA_POLICY
              ? { from: execution.openedAt }
              : undefined,
          )
        : undefined;
      return [{ execution, evidence, end, tail }];
    });
    for (const { execution, evidence, end, tail } of ended) {
      if (isTerminalState(execution.state)) {
        await input.jobs.completeTargetedJobCleanup(
          execution.jobId,
          execution.executionId,
        );
      } else if (tail) {
        if (evidence?.node) {
          await input.jobs.recordPodNode(execution.executionId, evidence.node);
        }
        await input.jobs.recordAttemptLogTail(
          execution.executionId,
          await tail,
        );
        await input.jobs.reportTargetedJobExecution(
          execution.jobId,
          execution.executionId,
          end,
        );
      }
    }
  }

  /** Later names win a duplicate key, as on VM hosts and pool Services. */
  async function resolveSecretsEnv(
    secretNames: readonly string[],
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const name of secretNames) {
      const secret = await input.secrets.getSecretValues(name);
      if (secret === null) {
        throw new InvalidAnycloudConfigError(`Secret "${name}" not found`);
      }
      Object.assign(values, secret);
    }
    return values;
  }

  async function reconcile(id: string, view: PoolView): Promise<void> {
    const deployment = await input.deployments.getById(id);
    if (!deployment || deployment.deletedAt !== null) return;
    const runtime = await input.runtimes.resolve(deploymentTarget(deployment));
    const { cluster } = runtime;
    const cache = view.cache(runtime.nodePool.clusterId);
    const objects = renderDeploymentObjects(
      deployment,
      runtime.config.namespace,
      input.workloadApiUrl,
      runtime.nodePool,
    );
    const { namespace, name } = objects;
    const cached = (kind: string, object: string) =>
      cache.get<KubernetesObject>(kind as 'Secret', namespace, object);
    const current = cached('Deployment', name) as
      | KubernetesDeployment
      | undefined;
    const applied = appliedGenerationOf(current);
    // Establish the execution boundary first. Work selected after this read
    // belongs to the next recovery pass.
    const executions = await input.jobs.listTargetedExecutions(deployment.id);
    const [label, hash] = objects.podSelector.split('=');
    let pods = cache
      .pods({ namespace })
      .filter((pod) => pod.metadata?.labels?.[label!] === hash);
    // The cache may lag a Pod an execution was just claimed by, so one
    // direct read confirms a missing Pod is gone (RFC 0044 invariant 7).
    // A successful empty read is runtime-loss evidence even when the native
    // Kubernetes Deployment was deleted; a transport failure throws first.
    if (
      executions.some(
        (execution) =>
          !pods.some((pod) => pod.metadata?.uid === execution.podUid),
      )
    ) {
      ({ items: pods } = await cluster.core.listNamespacedPod({
        namespace,
        labelSelector: objects.podSelector,
      }));
    }
    const policy = deployment.managed
      ? RUNNER_REPLICA_POLICY
      : DEPLOYMENT_POLICY;
    await recoverExecutions(cluster, executions, pods, policy);
    // A replica that can't run fails the queued Jobs: every one when the
    // runner can't execute, and for a refused pull each whose token kubelet
    // has retried with, since each admitted Job renews it.
    for (const pod of deployment.managed ? pods : []) {
      const cannot = replicaCannotRun(pod);
      if (cannot) {
        await input.jobs.terminateUnassignedTargetedJobs(deployment.id, {
          message: cannot.message,
          before: now() - (cannot.pull ? PULL_BACK_OFF_MS : 0),
        });
      }
    }
    // R3T-b: a deleted replica is held until its container has stopped.
    // Recovery above has then settled every execution on it (it throws
    // first otherwise), so no open attempt it listed names it. A claim may
    // have committed since that list, so the replica is closed to
    // claims first, and any execution claimed on it in between is settled,
    // tail from the held Pod, before the release. A rollout after the drain
    // waits on nothing more than the stop.
    const releasable = pods.filter(
      (pod) =>
        pod.metadata?.deletionTimestamp &&
        attemptEnds(terminationEvidence(pod, KUBERNETES_DEPLOYMENT_CONTAINER)),
    );
    if (releasable.length > 0) {
      for (const pod of releasable) input.jobs.closeReplica(pod.metadata!.uid!);
      // Only executions claimed on a closed replica since the list above;
      // one claimed on a live replica meanwhile is the next pass's.
      const closed = new Set(releasable.map((pod) => pod.metadata!.uid!));
      const listed = new Set(
        executions.map((execution) => execution.executionId),
      );
      const late = (
        await input.jobs.listTargetedExecutions(deployment.id)
      ).filter(
        (execution) =>
          closed.has(execution.podUid) && !listed.has(execution.executionId),
      );
      await recoverExecutions(cluster, late, releasable, policy);
      for (const pod of releasable) {
        await releasePodFinalizer(cluster.core, pod);
      }
    }
    // SPEND's bind hook: a replica holds its share of its Node, priced from
    // the Node's VM, from the first pass that sees it bound until it is over
    // or gone; a Node missing from the cache for a pass ends nothing.
    const live = pods.filter(
      (pod) => !['Succeeded', 'Failed'].includes(pod.status?.phase ?? ''),
    );
    const held = live.flatMap((pod) => {
      const node = pod.spec?.nodeName
        ? cache.get<V1Node>('Node', '', pod.spec.nodeName)
        : undefined;
      const vmId = Number(node?.metadata?.labels?.[ATTEMPT_NODE_LABEL]);
      return node && isNodePoolAttemptId(vmId)
        ? [{ podUid: pod.metadata!.uid!, vmId, ...podShare(pod, node) }]
        : [];
    });
    await input.deployments.recordOccupancy(
      deployment.id,
      held,
      live.map((pod) => pod.metadata!.uid!),
    );
    // The namespace's egress policy is repaired on every pass that may still
    // have replicas, as a drain or a rollout below may return before
    // the owned objects are. A deletion never waits on the namespace: one
    // that is foreign or terminating is left to the deletion below.
    const deleting = deployment.deletionRequestedAt !== null;
    const ensured =
      (!deleting || ownedHere(current, objects) || pods.length > 0) &&
      egressPolicyDiffers(
        cached('NetworkPolicy', NODE_POOL_EGRESS_POLICY),
        runtime.nodePool,
      );
    if (ensured) {
      await ensureNodePoolNamespace(cluster, runtime.nodePool).catch(
        (error: unknown) => {
          if (
            !deleting ||
            !(
              error instanceof NodePoolNamespaceOwnershipError ||
              error instanceof NodePoolNamespaceTerminatingError
            )
          ) {
            throw error;
          }
        },
      );
    }
    const jobs = await input.jobs.countTargetedJobs(deployment.id);
    // RFC 0044: a managed Deployment idle for a day goes; the pool loop's
    // resync brings the pass that sees it.
    if (
      deployment.managed &&
      deployment.deletionRequestedAt === null &&
      jobs.queued + jobs.running + jobs.retrying + jobs.unreleased === 0 &&
      (await input.deployments.requestIdleDeletion(
        deployment.id,
        now() - MANAGED_IDLE_MS,
      ))
    ) {
      return;
    }

    if (deployment.deletionRequestedAt !== null) {
      // A running execution can enter retrying after deletion was first
      // requested. Resolve unassigned work on every pass, not only in the
      // operator request that began the drain.
      await input.jobs.terminateUnassignedTargetedJobs(deployment.id);
      const remaining = await input.jobs.countTargetedJobs(deployment.id);
      if (
        remaining.queued > 0 ||
        remaining.retrying > 0 ||
        remaining.unreleased > 0
      ) {
        return;
      }
      // Each step waits for the watch: replicas go with the native
      // Deployment, then the plan confirms every owned object is gone.
      // A same-named object that isn't this record's is left to the plan,
      // which skips it.
      if (ownedHere(current, objects)) {
        if (!current.metadata?.deletionTimestamp) {
          await deleteCached(
            (body) =>
              cluster.apps.deleteNamespacedDeployment({
                namespace,
                name,
                body,
              }),
            current,
            'Foreground',
          );
        }
        return;
      }
      if (pods.length > 0) return;
      await deleteKubernetesResourcePlan(
        ownedResources(cluster, objects),
        kubernetesWorkloadOwner(objects),
        { timeoutMs: 60_000 },
      );
      await input.deployments.markDeleted(deployment.id);
      return;
    }

    // RFC 0044 S16: a replica's projected token is bound to its
    // ServiceAccount's UID, so a replica older than a recreated
    // ServiceAccount needs a restart, but only while kubelet may not yet
    // have refreshed its token. A recreated Secret restarts nothing.
    const account = cached('ServiceAccount', name)?.metadata?.creationTimestamp;
    const since = account ? new Date(account).getTime() : 0;
    const staleToken =
      !!account &&
      now() - since < TOKEN_REFRESH_MS &&
      pods.some(
        (pod) =>
          !pod.metadata?.deletionTimestamp &&
          // An unknown creation time is never older.
          new Date(pod.metadata?.creationTimestamp ?? NaN).getTime() < since,
      );

    // Resolve before any write: a missing Secret leaves the running Pod and
    // its last applied values in place instead of replacing them.
    const desired = renderDeploymentObjects(
      deployment,
      namespace,
      input.workloadApiUrl,
      runtime.nodePool,
      await resolveSecretsEnv(deployment.secretNames),
    );
    const drained = jobs.unreleased === 0;
    if (applied !== null && applied !== deployment.generation) {
      // Drain before replacing an older generation: its native Deployment
      // is deleted by the cached UID, and the DELETED event recreates it.
      if (!ownedHere(current, objects)) {
        throw new KubernetesResourceOwnershipError(
          'Kubernetes Deployment is owned by another workload',
        );
      }
      if (drained && !current.metadata?.deletionTimestamp) {
        await deleteCached(
          (body) =>
            cluster.apps.deleteNamespacedDeployment({ namespace, name, body }),
          current,
          'Foreground',
        );
      }
      return;
    }
    const templateChanged =
      current?.metadata?.annotations?.[KUBERNETES_TEMPLATE_ANNOTATION] !==
      desired.kubernetesDeployment.metadata!.annotations![
        KUBERNETES_TEMPLATE_ANNOTATION
      ];
    // RFC 0049 C27: the API accepts the runner of this release and the
    // previous one, so a managed Deployment running either keeps its replicas
    // through an upgrade, and they finish and claim its Jobs.
    const keepRunner =
      deployment.managed &&
      applied !== null &&
      ownedHere(current, objects) &&
      inClientWindow(deployment.runnerRelease);
    if (applied !== null && (staleToken || (templateChanged && !keepRunner))) {
      // A replica restart, for a Pod template the API now renders
      // differently (an upgrade's) or a stale token, is rolled out as the
      // next generation: older replicas stop claiming and drain first, and
      // no Pod is deleted directly. Drift made in the cluster keeps the hash
      // and is repaired below at once (RFC 0036 S15).
      await input.deployments.advanceGeneration(
        deployment.id,
        deployment.generation,
      );
      return;
    }
    desired.kubernetesDeployment.spec!.replicas = await replicas({
      deployment,
      current,
      pods,
      jobs,
      template: desired.kubernetesDeployment.spec!.template,
      nodePool: runtime.nodePool,
      cluster,
    });
    if (keepRunner && templateChanged) {
      // Only the replica count follows; drift waits for the next roll.
      await applyDiffering(
        cluster,
        desired,
        cached,
        runtime.nodePool,
        false,
        ensured,
      );
      const count = desired.kubernetesDeployment.spec!.replicas;
      if (current!.spec?.replicas !== count) {
        await cluster.apps.patchNamespacedDeployment(
          {
            namespace,
            name,
            body: [
              {
                op: 'test',
                path: '/metadata/uid',
                value: current!.metadata!.uid,
              },
              { op: 'replace', path: '/spec/replicas', value: count },
            ],
          },
          setHeaderOptions('Content-Type', 'application/json-patch+json'),
        );
      }
      return;
    }
    // A missing native Deployment is created once nothing older still runs.
    const rollout = applied !== null || drained;
    await applyDiffering(
      cluster,
      desired,
      cached,
      runtime.nodePool,
      rollout,
      ensured,
    );
    // The applied native Deployment renders this release's runner.
    if (
      deployment.managed &&
      rollout &&
      deployment.runnerRelease !== packageJson.version
    ) {
      await input.deployments.recordRunnerRelease(
        deployment.id,
        packageJson.version,
      );
    }
  }

  return {
    component: KUBERNETES_DEPLOYMENT_COMPONENT,
    discover: () => input.deployments.listForReconciliation(),
    reconcile,
    observed: input.changed,
  };
}

export function createDeploymentController(
  input: DeploymentOwnerInput & {
    /** The cluster connection the pool loop lists and watches through. */
    clusters: {
      resolve(
        clusterId: string,
        signal: AbortSignal,
      ): Promise<{ cluster: ClusterKubernetesClient }>;
    };
    loop?: Pick<
      Parameters<typeof createPoolReconciler>[0],
      'resyncMs' | 'tickMs'
    >;
  },
): DeploymentController {
  const owner = createDeploymentOwner(input);
  const unfit = new Map<
    string,
    { reason: string; podUids: ReadonlySet<string> }
  >();
  const loop = createPoolReconciler({
    ...input.loop,
    owner,
    cluster: async (clusterId, signal) =>
      (await input.clusters.resolve(clusterId, signal)).cluster,
  });
  return {
    schedule: loop.schedule,
    async validateTarget(target: DeploymentTarget, signal) {
      const runtime = await awaitWithSignal(
        input.runtimes.resolve(target, signal),
        signal,
      );
      // The RBAC preflight reads the namespace first; the node pool namespace
      // is Anycloud's own object and may not exist yet.
      await ensureNodePoolNamespace(runtime.cluster, runtime.nodePool, signal);
      await preflightKubernetesDeployment(runtime.config, runtime.cluster);
    },
    async observe(deployment, signal) {
      const runtime = await awaitWithSignal(
        input.runtimes.resolve(deploymentTarget(deployment), signal),
        signal,
      );
      return observeDeployment(
        runtime.cluster,
        renderDeploymentObjects(
          deployment,
          runtime.config.namespace,
          input.workloadApiUrl,
          runtime.nodePool,
        ),
        signal,
        async (pod) => {
          const pool = unfit.get(deployment.nodePoolId);
          return (
            (await findReplicaCapBlock(deployment.nodePoolId)) ??
            (pool?.podUids.has(pod.metadata?.uid ?? '') ? pool.reason : null)
          );
        },
      );
    },
    pods: (clusterId) => loop.cache(clusterId).pods({}),
    unfit: (nodePoolId, reason, podUids) =>
      void unfit.set(nodePoolId, { reason, podUids }),
    start: () => loop.start(),
    stop: () => loop.stop(),
  };
}

let defaultController: DeploymentController | undefined;

export function getDefaultDeploymentControl(): DeploymentController {
  defaultController ??= createDeploymentController({
    // Resolve repositories per call: resetPersistence() replaces the shared DB
    // connection in tests and recovery tools while this process-level
    // controller intentionally remains a singleton.
    deployments: {
      getById: (id) => getDeploymentStore().getById(id),
      listForReconciliation: () => getDeploymentStore().listForReconciliation(),
      markDeleted: (id) => getDeploymentStore().markDeleted(id),
      advanceGeneration: (id, generation) =>
        getDeploymentStore().advanceGeneration(id, generation),
      recordRunnerRelease: (id, release) =>
        getDeploymentStore().recordRunnerRelease(id, release),
      recordOccupancy: (id, held, live) =>
        getDeploymentStore().recordOccupancy(id, held, live),
      requestIdleDeletion: (id, before) =>
        getDeploymentStore().requestIdleDeletion(id, before),
    },
    jobs: {
      countTargetedJobs: (id) =>
        getDeploymentExecutionStore().countTargetedJobs(id),
      listTargetedExecutions: (id) =>
        getDeploymentExecutionStore().listTargetedExecutions(id),
      reportTargetedJobExecution: (jobId, executionId, end) =>
        getDeploymentExecutionStore().reportTargetedJobExecution(
          jobId,
          executionId,
          end,
        ),
      recordPodNode: (executionId, node) =>
        getDeploymentExecutionStore().recordPodNode(executionId, node),
      closeReplica: (podUid) =>
        getDeploymentExecutionStore().closeReplica(podUid),
      wasForcedStop: (executionId) =>
        getDeploymentExecutionStore().wasForcedStop(executionId),
      recordAttemptLogTail: (executionId, tail) =>
        getDeploymentExecutionStore().recordAttemptLogTail(executionId, tail),
      completeTargetedJobCleanup: (jobId, executionId) =>
        getDeploymentExecutionStore().completeTargetedJobCleanup(
          jobId,
          executionId,
        ),
      terminateUnassignedTargetedJobs: (id, invalid) =>
        getDeploymentExecutionStore().terminateUnassignedTargetedJobs(
          id,
          invalid,
        ),
    },
    replicas: {
      drainReplica: (id, podUid) =>
        drainReplica(getDeploymentExecutionStore(), id, podUid),
      reopenReplica: (podUid) =>
        getDeploymentExecutionStore().reopenReplica(podUid),
      listManagedDemand: (clusterId) =>
        getReplicaDemandStore().listManagedDemand(clusterId),
      managedRoom: (nodePoolId) =>
        getReplicaDemandStore().managedRoom(nodePoolId),
      capBlocked: async (nodePoolId) =>
        (await findReplicaCapBlock(nodePoolId)) !== null,
      demandAdmission: async () => {
        const admit = await createSpendAdmission();
        return (session, hourlyUsd) =>
          admit({ session, hourlyUsd, onExistingNode: true });
      },
    },
    secrets: {
      getSecretValues: (name) =>
        getCredentialSecretStore().getSecretValues(name),
    },
    runtimes: getDefaultDeploymentRuntimeResolver(),
    clusters: getDefaultClusterRuntimeResolver(),
    workloadApiUrl: getWorkloadApiUrl(),
    changed: (id) => getPersistence().jobChanges.notifyDeployment(id),
  });
  return defaultController;
}
