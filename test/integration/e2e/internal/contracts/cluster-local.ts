import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { FixtureNames } from '../names.js';
import type {
  ConcurrentTargetedJobSubmissionsObservation,
  NodePoolServiceTransport,
  ClusterNodePoolAdapter,
  NativeWrites,
} from '../targets/cluster-node-pool.js';
import type { StageProgress } from '../progress.js';
import type { NamedSecretProbeFixture } from '../probes/named-secret.js';
import {
  SERVICE_DWELL_TOLERANCE_MS,
  SERVICE_STARTUP_DWELL_MS,
} from './serve.js';
import type { Waiter } from '../wait.js';
import {
  createReadyNodePool,
  forcedCapacityFailureUnmet,
  proveCapacityReplacement,
  deleteNodePools,
  observeNodePoolIsolation,
  replaceClusterController,
  confirmClusterConnection,
  type NodePoolContractDependencies,
  type NodePoolContractRecord,
} from './node-pool.js';
import {
  createManagedDeployment,
  proveDeploymentIsolation,
  beginDeploymentRollout,
  finishDeploymentRollout,
  controlledReadinessProbe,
  qualifyDeploymentProbeChanges,
  qualifyDeploymentSecret,
  qualifyOwnedObjectRepair,
  proveHardenedReplica,
  proveReplicaReleased,
  replaceDeploymentPod,
  proveNodePoolDeletionFence,
  deleteDeployment,
  type DeploymentContractDependencies,
  type DeploymentContractRecord,
  type ManagedDeployment,
} from './deployment.js';
import {
  proveSubmissionResponseLoss,
  qualifyTargetedJobAdmission,
  qualifyConcurrentTargetedJobs,
  qualifyApplicationRetry,
  qualifyReplicaOomRetry,
  startTargetedJobRecovery,
  waitForTargetedJobRedelivery,
  completeTargetedJob,
  submitJob,
  qualifyNativeReadiness,
  queueTargetedJobDuringDrain,
  proveRemainingTargetedBlocker,
  qualifyReplacementGenerationJob,
  qualifyTargetedEnvironmentUpdate,
  startTargetedRuntimeLoss,
  finishTargetedRuntimeLoss,
  type TargetedJobDependencies,
  type TargetedJobContractRecord,
  type TargetedJobCompletion,
} from './targeted-job.js';

export interface ClusterLocalServiceRecord {
  readonly contract: 'node-pool-service';
  readonly workloadId: string;
  readonly nodePoolId: string;
  readonly ranOnNodePool: true;
  readonly cleanedAt: number;
  readonly namespaceAbsent: true;
}

/** A Helm-managed API installed with an older inline chart switched to its own OCI chart, once. */
export interface ClusterLocalHostedChartRecord {
  /** The digest-pinned chart the API image names. */
  readonly chart: string;
  readonly podLogPermitted: true;
  readonly apiPod: string;
  readonly apiRestarts: 0;
}

export interface ClusterLocalContractResult {
  readonly contract: 'e2e-cluster-local';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: 'e2e-cluster-local';
  readonly records: {
    readonly cluster: {
      readonly id: string;
      readonly kubernetesIdentity: string;
      readonly intactAfterNodePoolDeletion: true;
    };
    readonly nodePools: readonly NodePoolContractRecord[];
    readonly deployments: readonly DeploymentContractRecord[];
    readonly targetedJobs: readonly TargetedJobContractRecord[];
    readonly services: readonly ClusterLocalServiceRecord[];
    readonly asyncTransport: ConcurrentTargetedJobSubmissionsObservation;
    readonly hostedChart: ClusterLocalHostedChartRecord;
  };
}

export interface ClusterLocalContractPolicy {
  readonly nodePoolTimeoutMs: number;
  readonly serviceImage: string;
  /** The port `serviceImage` listens on; the product's readiness probe targets it. */
  readonly servicePort: number;
  /**
   * Budget for a Service's termination, native cleanup and namespace removal.
   * The product's cleanup lane retries a slow namespace deletion at 20 s,
   * then at the time already pending (capped at 5 min), each attempt bounded
   * at 60 s; two attempts fit in this budget.
   */
  readonly serviceCleanupTimeoutMs: number;
  readonly workloadImage: string;
  readonly workloadTimeoutMs: number;
}

export interface ClusterLocalRecordedCluster {
  readonly id: string;
  readonly kubernetesIdentity: string;
}

type ClusterLocalDependencies = Pick<
  NodePoolContractDependencies,
  'nodePools'
> &
  Pick<DeploymentContractDependencies, 'deployments'> &
  Pick<TargetedJobDependencies, 'jobs'> & {
    readonly names: Pick<FixtureNames, 'nodePool' | 'workload' | 'deployment'>;
    readonly namedSecret: Pick<NamedSecretProbeFixture, 'create'>;
    /**
     * Reads a token that reads `PRIVATE_REPO` at once, and returns the
     * call that saves it as a Secret's `GITHUB_TOKEN` (on the current controller).
     * `undefined` when the run may not read it: an untrusted pull request.
     */
    githubSecret():
      | (() => Promise<{ name: string; release(): Promise<void> }>)
      | undefined;
    /** A non-forced delete's declared status; `undefined` when it succeeds. */
    refuseSecretDeletion(name: string): Promise<number | undefined>;
    readonly policy: ClusterLocalContractPolicy;
    readonly cluster: {
      registered(): ClusterLocalRecordedCluster;
      intact(): Promise<ClusterLocalRecordedCluster>;
      /** The Helm-managed API applies its own chart over an older one. */
      hostedChartRepair(): Promise<ClusterLocalHostedChartRecord>;
      /** A pool Node's kubelet can't take another pool's or the API's place. */
      kubeletRestrictions(nodePoolId: string): Promise<void>;
      /** RFC 0049 C32's policy refuses a noncompliant Pod of the class. */
      userNamespacePolicy(): Promise<void>;
    };
    /** Stage timeline for the run log: a cancelled job still shows how far it got. */
    readonly progress: Pick<StageProgress, 'mark'>;
    readonly services: NodePoolServiceTransport;
    readonly target: ClusterNodePoolAdapter;
    readonly wait: Pick<Waiter, 'for'>;
  };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Local cluster contract: ${message}`);
}

/**
 * `anycloud service --node-pool`: the Service runs as Pods on the node pool
 * (no VM row is ever written), reaches Running, and its deletion removes the
 * namespace it owned on the cluster before the tracked reference is released.
 */
export async function qualifyNodePoolService(
  dependencies: ClusterLocalDependencies,
  nodePoolId: string,
  workloadId: string,
): Promise<ClusterLocalServiceRecord> {
  const services = dependencies.services;
  const ref = await services.reserve(
    workloadId,
    dependencies.policy.serviceCleanupTimeoutMs,
  );
  dependencies.progress.mark(`Service ${workloadId} admitted on ${nodePoolId}`);
  const running = await services.createAndAwaitRunning(
    ref,
    {
      image: dependencies.policy.serviceImage,
      port: dependencies.policy.servicePort,
      nodePoolId,
    },
    dependencies.policy.workloadTimeoutMs,
  );
  invariant(
    running.nodePoolId === nodePoolId && running.liveVmCount === 0,
    'node pool Service did not run on its node pool without a VM row',
  );
  // `running` follows Pod Ready by the `minReadySeconds` dwell (no endpoint reaches the pool from outside yet).
  const podReadyAt = await dependencies.target.servicePodReadyAt(
    nodePoolId,
    workloadId,
  );
  invariant(podReadyAt !== null, 'node pool Service has no Ready Pod');
  const dwellMs = running.runningEventAt - podReadyAt;
  invariant(
    dwellMs >= SERVICE_STARTUP_DWELL_MS - SERVICE_DWELL_TOLERANCE_MS,
    `node pool Service reached running ${String(dwellMs)}ms after its Pod was Ready; the dwell is ${String(SERVICE_STARTUP_DWELL_MS)}ms`,
  );
  // nginx's entrypoint prints this before the server starts.
  const logs = await services.logs(ref);
  invariant(
    logs.includes('Configuration complete; ready for start up'),
    `anycloud logs did not show the node pool Service's startup output: ${logs.slice(-500)}`,
  );
  dependencies.progress.mark(`Service ${workloadId} running; terminating`);
  const cleanup = await services.terminate(
    ref,
    dependencies.policy.serviceCleanupTimeoutMs,
  );
  dependencies.progress.mark(`Service ${workloadId} cleanup recorded`);
  const namespaceAbsent = await dependencies.wait.for(
    `node pool Service ${workloadId} namespace removal`,
    () => dependencies.target.serviceNamespaceAbsent(nodePoolId, workloadId),
    {
      timeoutMs: dependencies.policy.serviceCleanupTimeoutMs,
      intervalMs: 2_000,
      probeError: 'fail',
      unmet: (absent) => (absent ? undefined : 'namespace still present'),
    },
  );
  invariant(namespaceAbsent, 'node pool Service namespace remained');
  await services.release(ref, cleanup);
  return {
    contract: 'node-pool-service',
    workloadId,
    nodePoolId,
    ranOnNodePool: true,
    cleanedAt: cleanup.status.workload.cleanedAt ?? 0,
    namespaceAbsent: true,
  };
}

/** The pool loop's default full resync interval (`resyncMs` in `pool-reconciler.ts`). */
const POOL_RESYNC_MS = 60_000;

function writesSince(
  before: NativeWrites,
  after: NativeWrites,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const resource of Object.keys({ ...before, ...after }).sort()) {
    const count = (after[resource] ?? 0) - (before[resource] ?? 0);
    if (count !== 0) delta[resource] = count;
  }
  return delta;
}

/**
 * Wait up to 20 s (a watch-driven repair, not a resync) until the
 * namespace has taken exactly `expected` writes since `before`, then hold
 * that count for a full resync. Any write beyond
 * `expected` fails at once. The hold's first probe runs at once and each
 * later one after a 5 s pause, so the last one is past the resync.
 */
async function writesSettleAt(
  dependencies: ClusterLocalDependencies,
  nodePoolId: string,
  label: string,
  before: NativeWrites,
  expected: Record<string, number>,
): Promise<void> {
  const want = JSON.stringify(writesSince({}, expected));
  const excess = (writes: NativeWrites) => {
    const delta = writesSince(before, writes);
    return Object.entries(delta).some(
      ([resource, count]) => count > (expected[resource] ?? 0),
    )
      ? `wrote ${JSON.stringify(delta)}, expected ${want}`
      : undefined;
  };
  const read = () => dependencies.target.nativeWrites(nodePoolId);
  await dependencies.wait.for(`${label}: expected writes`, read, {
    timeoutMs: 20_000,
    intervalMs: 1_000,
    probeError: 'fail',
    reject: excess,
    unmet: (writes) =>
      JSON.stringify(writesSince(before, writes)) === want
        ? undefined
        : `wrote ${JSON.stringify(writesSince(before, writes))}`,
  });
  const probes = (POOL_RESYNC_MS + 15_000) / 5_000;
  let probed = 0;
  await dependencies.wait.for(`${label}: quiet across a resync`, read, {
    timeoutMs: POOL_RESYNC_MS + 60_000,
    intervalMs: 5_000,
    probeError: 'fail',
    reject: (writes) =>
      JSON.stringify(writesSince(before, writes)) === want
        ? undefined
        : `wrote ${JSON.stringify(writesSince(before, writes))}, expected ${want}`,
    unmet: () => (++probed <= probes ? 'resync window open' : undefined),
  });
}

/**
 * RFC 0044 invariant 7 against a real API server: the node pool's converged
 * Deployments take no write, not even a no-op apply, across a full resync.
 * The count before the window includes their own creation, so the audit sees
 * the API's writes. Then a natively deleted Secret must be repaired with
 * exactly the repair's writes (only the missing object, RFC 0044 S16) and the
 * namespace go quiet again, so the pool loop was live while it wrote nothing.
 * The same holds for the namespace's natively deleted egress policy.
 */
async function proveConvergedDeploymentWritesNothing(
  dependencies: ClusterLocalDependencies,
  deployment: ManagedDeployment,
  nodePoolId: string,
): Promise<void> {
  const before = await dependencies.target.nativeWrites(nodePoolId);
  invariant(
    Object.values(before).some((count) => count > 0),
    'the audit log recorded none of the Deployment writes',
  );
  await writesSettleAt(
    dependencies,
    nodePoolId,
    'converged Deployments',
    before,
    {},
  );
  const deleted = (
    await dependencies.target.deploymentOwnedObjects(deployment.ref)
  ).secretUid;
  invariant(deleted, 'the converged Deployment has no Secret to delete');
  await dependencies.target.deleteDeploymentOwnedObject(
    deployment.ref,
    'Secret',
  );
  // The repair writes only the missing object: `secrets` is the harness's
  // delete and the API's create. `networkpolicies` is the namespace's egress
  // policy apply (K5), which `ensureNodePoolNamespace` makes before any
  // Deployment write. Nothing else changes, so deployments, serviceaccounts
  // and pods take no write.
  await writesSettleAt(
    dependencies,
    nodePoolId,
    'natively deleted Secret repair',
    before,
    { networkpolicies: 1, secrets: 2 },
  );
  const { secretUid } = await dependencies.target.deploymentOwnedObjects(
    deployment.ref,
  );
  invariant(
    secretUid && secretUid !== deleted,
    'the repair did not recreate the Secret',
  );
  // The pool loop watches the namespace's egress policy, so a native
  // delete is followed by exactly one re-apply and then quiet again.
  const repaired = await dependencies.target.nativeWrites(nodePoolId);
  await dependencies.target.deletePoolEgressPolicy(nodePoolId);
  await writesSettleAt(
    dependencies,
    nodePoolId,
    'natively deleted egress policy repair',
    repaired,
    { networkpolicies: 2 },
  );
}

/**
 * The node pool namespace's default egress policy: the cluster's Pods and
 * the metadata address are denied where an unrestricted
 * namespace reaches them, and DNS, the internet and a Pod on another Node of
 * the pool are allowed. The workload API stays reachable: every later stage
 * claims Jobs through it.
 */
async function qualifyPoolEgress(
  dependencies: ClusterLocalDependencies,
  nodePoolId: string,
): Promise<void> {
  const { pool, control } = await dependencies.target.poolEgress(nodePoolId);
  invariant(
    control.podIp && control.metadata && control.internet,
    `egress controls did not reach their targets: ${JSON.stringify(control)}`,
  );
  invariant(
    !pool.podIp && !pool.metadata && pool.internet && pool.crossNodePeer,
    `node pool egress policy was not enforced: ${JSON.stringify(pool)}`,
  );
}

/**
 * RA: one replica steps up to two on queued plus held claims; they claim
 * independently, drain together, recover one lost Pod, and scale back to
 * one without touching the replica that holds a Job.
 */
async function qualifyDeploymentReplicas(
  d: ClusterLocalDependencies & { completions: TargetedJobCompletion[] },
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<DeploymentContractRecord> {
  const deployment = await createManagedDeployment(
    d,
    pool.ref,
    d.names.deployment('replicas'),
    {
      image: d.policy.workloadImage,
      minReplicas: 1,
      maxReplicas: 2,
      maxConcurrentJobsPerReplica: 1,
    },
  );
  const ready = (generation: number, replicas = 2) =>
    d.wait.for(
      `${replicas} ready replicas`,
      () => d.deployments.status(deployment.ref),
      {
        timeoutMs: d.policy.workloadTimeoutMs,
        intervalMs: 1000,
        probeError: 'fail',
        unmet: (s) =>
          s.status?.readyReplicas === replicas &&
          s.status.appliedGeneration === generation
            ? undefined
            : JSON.stringify(s.status),
      },
    );
  await ready(deployment.generation, 1);
  const held = await Promise.all(
    ['replica-a', 'replica-b'].map((prefix) =>
      submitJob(d, deployment.ref, prefix, 'hold'),
    ),
  );
  for (const job of held)
    await d.jobs.kernel.waitForState(
      job,
      WorkloadState.Running,
      d.policy.workloadTimeoutMs,
    );
  const running = async (job: (typeof held)[number]) => {
    const status = await d.jobs.kernel.status(job, true);
    return status.events.filter((e) => e.state === WorkloadState.Running).at(-1)
      ?.metadata?.podUid;
  };
  const pods = await Promise.all(held.map(running));
  invariant(
    pods.every((p) => typeof p === 'string') && new Set(pods).size === 2,
    'two held Jobs must run on distinct replica Pods',
  );
  const desired = await d.target.updateDeployment(deployment.ref, {
    env: {
      RESERVATION_BASE_URL: d.target.reservationBaseUrl(),
      CONFIGURATION_MARKER: 'replicas-updated',
    },
  });
  await d.target.waitForReconcileOpportunity();
  invariant(
    (await d.deployments.status(deployment.ref)).status?.blockingJobs.total ===
      2,
    'both replica Jobs must block rollout',
  );
  await completeTargetedJob(d, deployment.ref, held[0]);
  await d.target.waitForReconcileOpportunity();
  const draining = await d.deployments.status(deployment.ref);
  invariant(
    draining.status?.blockingJobs.total === 1 &&
      draining.status.appliedGeneration === deployment.generation,
    'the second replica must keep the old generation until released',
  );
  await completeTargetedJob(d, deployment.ref, held[1]);
  await ready(desired.generation, 1);
  const next = { ...desired, ref: deployment.ref };
  const recovery = await submitJob(
    d,
    deployment.ref,
    'replica-recovery',
    'hold',
  );
  const survivor = await submitJob(
    d,
    deployment.ref,
    'replica-survivor',
    'hold',
  );
  for (const job of [recovery, survivor])
    await d.jobs.kernel.waitForState(
      job,
      WorkloadState.Running,
      d.policy.workloadTimeoutMs,
    );
  const [lostPod, survivorPod] = await Promise.all([
    running(recovery),
    running(survivor),
  ]);
  invariant(
    typeof lostPod === 'string' &&
      typeof survivorPod === 'string' &&
      lostPod !== survivorPod &&
      !pods.includes(lostPod) &&
      !pods.includes(survivorPod),
    'both new-generation Jobs need distinct replacement Pods',
  );
  await d.target.deleteDeploymentPod(deployment.ref, lostPod);
  await d.wait.for(
    'lost replica Job retried on a replacement',
    () => d.jobs.kernel.status(recovery, true),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (s) =>
        s.workload.state === WorkloadState.Running &&
        s.events.some((e) => e.state === WorkloadState.Retrying) &&
        s.events.filter((e) => e.state === WorkloadState.Running).at(-1)
          ?.metadata?.podUid !== lostPod
          ? undefined
          : s.workload.state,
    },
  );
  const surviving = await d.jobs.kernel.status(survivor, true);
  invariant(
    surviving.workload.state === WorkloadState.Running &&
      !surviving.events.some((e) => e.state === WorkloadState.Retrying) &&
      (await running(survivor)) === survivorPod,
    'the surviving replica must keep its session without retry',
  );
  await ready(desired.generation);
  // With one Job left the count falls to one, and the idle replica goes:
  // its Pod is deleted before the converged Deployment's writes are read.
  const idle = await running(recovery);
  invariant(typeof idle === 'string', 'the recovered Job has no replica Pod');
  await completeTargetedJob(d, deployment.ref, recovery);
  await ready(desired.generation, 1);
  await d.wait.for(
    'the idle replica removed',
    () => d.target.deploymentPod(deployment.ref, idle),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (pod) => (pod === null ? undefined : 'still present'),
    },
  );
  const kept = await d.jobs.kernel.status(survivor, true);
  invariant(
    kept.workload.state === WorkloadState.Running &&
      !kept.events.some((e) => e.state === WorkloadState.Retrying) &&
      (await running(survivor)) === survivorPod,
    'scaling down must keep the replica that holds a Job',
  );
  await completeTargetedJob(d, deployment.ref, survivor);
  await proveConvergedDeploymentWritesNothing(d, next, pool.id);
  return deleteDeployment(d, next);
}

/**
 * Pool Jobs (RFC 0044 decision 26, RT8-thin): `job IMAGE --node-pool P` runs
 * each Job through the runner on the pool's managed Deployment, which RA
 * scales from zero for them and back to zero once they end.
 */
async function qualifyPoolJobs(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  // A flag the pool refuses is refused with the pool named. (RFC 0044 S9's GPU
  // and privileged cases need a GPU pool; the unit tests cover them.)
  // `--bind` needs a privileged or `--user-namespace-jobs` pool (RFC 0049 C32).
  const refused = await d.target.submitPoolJob(pool.id, {
    id: d.names.workload('pool-refused'),
    script: 'true',
    bind: '/data',
  });
  invariant(
    refused.exitCode !== 0 &&
      refused.output.includes(`node pool "${pool.id}"`) &&
      refused.output.includes('--bind') &&
      refused.output.includes('--user-namespace-jobs'),
    `a pool Job with --bind must be refused naming the pool: ${refused.output}`,
  );
  // 0044/S1: one Job exits 0, the next 3, both on one managed Deployment.
  const ids = [d.names.workload('pool-ok'), d.names.workload('pool-exit')];
  for (const [id, script] of [
    [ids[0], 'echo pool-job-ok'],
    [ids[1], 'echo pool-job-exit; exit 3'],
  ] as const) {
    const submitted = await d.target.submitPoolJob(pool.id, { id, script });
    invariant(
      submitted.exitCode === 0,
      `pool Job ${id} was not admitted: ${submitted.output}`,
    );
  }
  const [ok, exited] = await Promise.all(
    ids.map((id) => d.target.poolJobOutcome(id)),
  );
  const listed = await d.target.deploymentList();
  invariant(
    listed.includes(`${ok.deploymentId} (managed)`),
    `deployment list must label the managed Deployment: ${listed}`,
  );
  invariant(
    ok.waitExit === 0 && ok.state === WorkloadState.Completed,
    `the pool Job exiting 0 must complete: ${JSON.stringify(ok)}`,
  );
  invariant(
    exited.waitExit === 1 &&
      exited.state === WorkloadState.Errored &&
      exited.message === 'Exited with code 3',
    `the pool Job exiting 3 must end errored: ${JSON.stringify(exited)}`,
  );
  const managed = ok.deploymentId;
  invariant(
    managed !== null &&
      exited.deploymentId === managed &&
      ok.nodePoolName === pool.ref.name &&
      ok.attempt === 1,
    `both pool Jobs must run on one managed Deployment of ${pool.ref.name}, at attempt 1: ${JSON.stringify(ok)}`,
  );
  await waitForZeroPods(d, pool.id, managed);
}

/**
 * A pool created with `--allow-privileged-jobs` admits `--privileged` and `--bind`:
 * the Job's bounding set holds CAP_SYS_ADMIN, which an unprivileged
 * container's lacks, and its `--bind` path is writable.
 */
async function qualifyPrivilegedPoolJob(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const id = d.names.workload('pool-privileged');
  const submitted = await d.target.submitPoolJob(pool.id, {
    id,
    privileged: true,
    bind: '/scratch',
    script:
      'while read k v; do [ "$k" = CapBnd: ] && b=$v; done < /proc/self/status; ' +
      '[ $((0x$b >> 21 & 1)) = 1 ] && touch /scratch/ok',
  });
  invariant(
    submitted.exitCode === 0,
    `the privileged pool Job was not admitted: ${submitted.output}`,
  );
  const outcome = await d.target.poolJobOutcome(id);
  invariant(
    outcome.waitExit === 0 && outcome.state === WorkloadState.Completed,
    `the privileged pool Job must complete: ${JSON.stringify(outcome)}`,
  );
  await waitForZeroPods(d, pool.id, outcome.deploymentId!);
}

/**
 * RFC 0049 C32 on a pool of its own, which needs no user-namespace runtime:
 * the pool refuses `--cache`, and the API server's policy, installed with
 * it, refuses a Pod of the class without `hostUsers: false` or with a
 * privileged container.
 */
async function qualifyUserNamespaceAdmission(
  d: ClusterLocalDependencies,
): Promise<void> {
  const ref = await d.nodePools.reserve(
    d.names.nodePool('userns'),
    d.policy.nodePoolTimeoutMs,
  );
  const pool = await createReadyNodePool(d, ref, 1, 1, 'user-namespace');
  const refused = await d.target.submitPoolJob(pool.id, {
    id: d.names.workload('userns-cache'),
    script: 'true',
    cache: 'c32:/cache',
  });
  invariant(
    refused.exitCode !== 0 &&
      refused.output.includes(`node pool "${pool.id}"`) &&
      refused.output.includes('--cache'),
    `a user-namespace pool must refuse --cache: ${refused.output}`,
  );
  await d.cluster.userNamespacePolicy();
  await deleteNodePools(d, [pool]);
}

async function waitForZeroPods(
  d: ClusterLocalDependencies,
  nodePoolId: string,
  deploymentId: string,
): Promise<void> {
  await d.wait.for(
    'the idle managed Deployment back at zero Pods',
    () => d.target.deploymentPodCount(nodePoolId, deploymentId),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 2000,
      probeError: 'fail',
      unmet: (pods) => (pods === 0 ? undefined : `${String(pods)} Pods`),
    },
  );
}

/**
 * RFC 0044 § Logs on the one-Node pool: each Job asks for over half the
 * Node's free CPU, so both run on one replica, one after the other. The
 * first's `logs -f` attaches while it runs, and the second starts printing
 * as soon as the first ends, so its lines reach the replica's log while that
 * follow closes: the follow must still show only the first Job's lines, and
 * the second's stored tail only its own.
 */
async function qualifyPoolJobLogs(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const free = await d.target.poolNodeFreeMillicores(pool.id);
  const cpus = (Math.floor(free * 0.6) / 1000).toFixed(3);
  const ids = [d.names.workload('logs-first'), d.names.workload('logs-next')];
  for (const [id, script] of [
    [ids[0], 'echo pool-job-ok; sleep 20; echo pool-job-ok-end'],
    [
      ids[1],
      'for i in 1 2 3 4 5; do echo pool-job-exit; sleep 1; done; exit 3',
    ],
  ] as const) {
    const submitted = await d.target.submitPoolJob(pool.id, {
      id,
      script,
      cpus,
    });
    invariant(
      submitted.exitCode === 0,
      `pool Job ${id} was not admitted: ${submitted.output}`,
    );
  }
  await d.wait.for(
    'the first pool Job running',
    async () => (await d.target.poolJobStatus(ids[0])).workload.state,
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (state) => (state === WorkloadState.Running ? undefined : state),
    },
  );
  const liveFollow = d.target.poolJobLogs(ids[0], true);
  const [first, next] = await Promise.all(
    ids.map((id) => d.target.poolJobOutcome(id)),
  );
  const follow = await liveFollow;
  invariant(
    first.podUid !== null &&
      first.podUid === next.podUid &&
      follow.exitCode === 0 &&
      follow.stdout.includes('pool-job-ok') &&
      follow.stdout.includes('pool-job-ok-end') &&
      !follow.stdout.includes('pool-job-exit'),
    `a live logs -f must end with its Job and show only its lines: ${JSON.stringify({ first, next, follow })}`,
  );
  await waitForZeroPods(d, pool.id, first.deploymentId!);
  // The stored tail once the replica is gone: the second Job's lines
  // alone, though the first ran on the same replica just before.
  const tail = await d.target.poolJobLogs(ids[1], false);
  invariant(
    tail.exitCode === 0 &&
      tail.stdout.includes('pool-job-exit') &&
      !tail.stdout.includes('pool-job-ok'),
    `logs must serve the stored tail after the replica is gone: ${JSON.stringify(tail)}`,
  );
}

/**
 * EXEC on a Deployment: `exec` runs in its ready replica (a Pod's
 * hostname is its name) with the remote exit code, `--replica` names that
 * replica, and an unknown one is refused.
 */
async function qualifyDeploymentExec(
  d: ClusterLocalDependencies,
  deployment: ManagedDeployment,
): Promise<void> {
  const ready = await d.target.deploymentExec(deployment.ref, 'hostname');
  const replica = ready.stdout.trim();
  const named = await d.target.deploymentExec(
    deployment.ref,
    `test "$(hostname)" = ${replica} || exit 1; exit 5`,
    replica,
  );
  const unknown = await d.target.deploymentExec(
    deployment.ref,
    'true',
    'no-such-replica',
  );
  invariant(
    ready.exitCode === 0 &&
      replica.length > 0 &&
      named.exitCode === 5 &&
      unknown.exitCode !== 0 &&
      unknown.stderr.includes(replica),
    `exec must run in the ready replica, or the one --replica names: ${JSON.stringify({ ready, named, unknown })}`,
  );
}

/**
 * EXEC on pool Jobs: `exec` reaches a running Job's replica, with
 * the remote exit code, and is refused for a Job queued behind it and for
 * the Job once it has ended. Each Job asks for over half the Node's free
 * CPU, so the second waits for the first's replica, as in `qualifyTerminate`.
 * C30: with `--cpus`, the API server classes the replica Guaranteed.
 */
async function qualifyPoolJobExec(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const free = await d.target.poolNodeFreeMillicores(pool.id);
  const cpus = (Math.floor(free * 0.6) / 1000).toFixed(3);
  const [held, next] = [
    d.names.workload('exec-held'),
    d.names.workload('exec-next'),
  ];
  for (const [id, script] of [
    [held, 'echo exec-held > /tmp/exec-owner; echo exec-armed; sleep 600'],
    [next, 'test ! -e /tmp/exec-owner'],
  ] as const) {
    const submitted = await d.target.submitPoolJob(pool.id, {
      id,
      script,
      cpus,
    });
    invariant(submitted.exitCode === 0, `not admitted: ${submitted.output}`);
  }
  const pod = await d.wait.for(
    'the exec Job running',
    () => d.target.poolJobPod(pool.id, held, 'exec-armed'),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (found) => (found ? undefined : 'not running'),
    },
  );
  const replica = await d.target.poolJobReplica(
    pool.id,
    pod!.deploymentId,
    pod!.podUid,
  );
  invariant(
    replica?.qosClass === 'Guaranteed',
    `a pool Job with --cpus must be Guaranteed: ${JSON.stringify(replica)}`,
  );
  const running = await d.target.exec(held, 'cat /tmp/exec-owner; exit 7');
  const queued = await d.target.exec(next, 'true');
  invariant(
    running.exitCode === 7 &&
      running.stdout.trim() === 'exec-held' &&
      queued.exitCode !== 0 &&
      (await d.target.poolJobStatus(next)).workload.state ===
        WorkloadState.Queued,
    `exec must reach only the running pool Job: ${JSON.stringify({ running, queued })}`,
  );
  await d.target.terminatePoolJob(held);
  const after = await d.target.poolJobOutcome(next);
  const ended = await d.target.exec(held, 'true');
  invariant(
    ended.exitCode !== 0 &&
      after.state === WorkloadState.Completed &&
      after.podUid === pod!.podUid,
    `exec must be refused once the Job ended, and its replica run the next: ${JSON.stringify({ ended, after })}`,
  );
  await waitForZeroPods(d, pool.id, pod!.deploymentId);
}

/** A private fixture repository; `E2E_PRIVATE_REPO_TOKEN` reads it. */
const PRIVATE_REPO = 'https://github.com/anycloud-sh/private-fixture.git';

/**
 * OPTS: the replica options are part of a managed Deployment's shape.
 * `--ipc host` and `--shm-size` give the command a memory-backed `/dev/shm`
 * of the expected size, and `--secret github` lets it read a private repo
 * that the same Job without the Secret can't: `git ls-remote` and a
 * sparse, shallow clone through the documented `insteadOf` rewrite. Without
 * a Secret (an untrusted pull request) only the `/dev/shm` Jobs run.
 */
async function qualifyPoolJobOptions(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
  secret: { name: string } | undefined,
): Promise<void> {
  const shm = (bytes: number) =>
    `python3 -c "import os; s = os.statvfs('/dev/shm'); exit(s.f_blocks * s.f_frsize != ${bytes})"`;
  const git = [
    'set -e',
    'export GIT_TERMINAL_PROMPT=0',
    'rewrite="url.https://x-access-token:${GITHUB_TOKEN}@github.com/.insteadOf=https://github.com/"',
    `git -c "$rewrite" ls-remote ${PRIVATE_REPO} HEAD || exit 9`,
    `git -c "$rewrite" clone --depth 1 --filter=blob:none --sparse ${PRIVATE_REPO} /tmp/fixture`,
    'test -f /tmp/fixture/AGENTS.md && test ! -e /tmp/fixture/src',
  ].join('\n');
  // Each Job checks its own option; only the control fails, as it can't sign in.
  const jobs = [
    ['opts-ipc', { memory: '512m', ipc: 'host', script: shm(512 * 2 ** 20) }],
    ['opts-shm', { shmSize: '192m', script: shm(192 * 2 ** 20) }],
    ...(secret
      ? ([
          ['opts-git', { secret: secret.name, script: git }],
          ['opts-git-control', { script: git }],
        ] as const)
      : []),
  ] as const;
  const outcomes = [];
  for (const [name, options] of jobs) {
    const id = d.names.workload(name);
    const submitted = await d.target.submitPoolJob(pool.id, { id, ...options });
    invariant(
      submitted.exitCode === 0,
      `pool Job ${id} was not admitted: ${submitted.output}`,
    );
    outcomes.push(d.target.poolJobOutcome(id));
  }
  const ended = await Promise.all(outcomes);
  const control = secret ? ended.at(-1) : undefined;
  invariant(
    ended
      .slice(0, control ? -1 : undefined)
      .every((o) => o.state === WorkloadState.Completed) &&
      (!control ||
        (control.state === WorkloadState.Errored &&
          control.message === 'Exited with code 9')) &&
      // Jobs that differ in a replica option run on different Deployments.
      new Set(ended.map((o) => o.deploymentId)).size === jobs.length,
    `/dev/shm, the private clone, or its failing control was wrong: ${JSON.stringify(ended)}`,
  );
}

/**
 * 0044/S2: the Node under a running pool Job is lost. Its VM is deleted, so
 * the pool controller removes the Node through `deleteNodePoolNode` and
 * replaces the VM; the Job retries once, on a replica that claims it only
 * after the first execution's end is recorded, and each attempt keeps its
 * own stored tail. The checkpoint restore is 0043/S13's, in
 * `e2e-cluster-cloud`'s Azure spot stage.
 */
async function qualifyNodeLoss(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<Awaited<ReturnType<typeof createReadyNodePool>>> {
  const id = d.names.workload('node-loss');
  const submitted = await d.target.submitPoolJob(pool.id, {
    id,
    script: 'echo node-loss-started; sleep 45',
  });
  invariant(submitted.exitCode === 0, `not admitted: ${submitted.output}`);
  const held = await d.wait.for(
    'the node-loss Job running on a replica',
    () => d.target.poolJobPod(pool.id, id, 'node-loss-started'),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (pod) => (pod ? undefined : 'not running'),
    },
  );
  const node = await d.target.replicaNode(
    pool.id,
    held!.deploymentId,
    held!.podUid,
  );
  const replaced = await proveCapacityReplacement(d, pool, node.vmRowId);
  invariant(
    !(await d.target.nodePresent(pool.id, node.name)),
    `the lost Node ${node.name} must be deleted`,
  );
  const outcome = await d.target.poolJobOutcome(id);
  const { events } = await d.target.poolJobStatus(id);
  const states = events.map((event) => event.state);
  const claims = events.filter(
    (event) => event.state === String(WorkloadState.Syncing),
  );
  invariant(
    outcome.state === WorkloadState.Completed &&
      outcome.attempt === 2 &&
      states.filter((state) => state === String(WorkloadState.Retrying))
        .length === 1 &&
      claims.length === 2 &&
      typeof claims[1].metadata?.podUid === 'string' &&
      claims[1].metadata.podUid !== held!.podUid &&
      states.indexOf(String(WorkloadState.Retrying)) <
        states.lastIndexOf(String(WorkloadState.Syncing)),
    `the Job on the lost Node must retry once, on another replica, and complete: ${JSON.stringify({ outcome, states })}`,
  );
  const tails = await d.target.attemptLogTails(id);
  invariant(
    tails.length === 2 &&
      // Attempt 1's tail is either stored or says why it isn't.
      ((tails[0].logTailState === 'captured' &&
        tails[0].logTail?.includes('node-loss-started')) ||
        (tails[0].logTailState === 'unavailable' && !!tails[0].logTail)) &&
      tails[1].logTailState === 'captured' &&
      tails[1].logTail?.includes('node-loss-started'),
    `each attempt must keep its own stored tail: ${JSON.stringify(tails)}`,
  );
  return replaced;
}

/**
 * 0044/S8: `terminate` sends the running command SIGTERM within its grace,
 * and its replica resets and claims the next Job. Each Job requests over
 * half the pool's one Node's free CPU, so the replica RA adds for the second
 * stays Pending and the first's replica claims it, as in `qualifyReset`.
 * The final upload has no bucket here; the runner's S8 unit test covers it.
 */
async function qualifyTerminate(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const free = await d.target.poolNodeFreeMillicores(pool.id);
  const cpus = (Math.floor(free * 0.6) / 1000).toFixed(3);
  const [terminated, next] = [
    d.names.workload('terminate'),
    d.names.workload('terminate-next'),
  ];
  for (const [id, script] of [
    [
      terminated,
      "trap 'echo s8-sigterm; sleep 3; echo s8-stopped; exit 0' TERM; echo > /tmp/s8; echo s8-armed; sleep 600 & wait",
    ],
    [next, 'test ! -e /tmp/s8'],
  ] as const) {
    const submitted = await d.target.submitPoolJob(pool.id, {
      id,
      script,
      cpus,
    });
    invariant(submitted.exitCode === 0, `not admitted: ${submitted.output}`);
  }
  const held = await d.wait.for(
    'the terminate Job running, its handler set',
    () => d.target.poolJobPod(pool.id, terminated, 's8-armed'),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (pod) => (pod ? undefined : 'not running'),
    },
  );
  await d.target.terminatePoolJob(terminated);
  const after = await d.target.poolJobOutcome(next);
  const [tail] = await d.target.attemptLogTails(terminated);
  invariant(
    (await d.target.poolJobStatus(terminated)).workload.state ===
      WorkloadState.Terminated &&
      tail?.logTail?.includes('s8-stopped') &&
      after.state === WorkloadState.Completed &&
      after.podUid === held!.podUid,
    `the terminated Job's command must stop on SIGTERM within its grace, and its replica reset and run the next: ${JSON.stringify({ tail, after })}`,
  );
  await waitForZeroPods(d, pool.id, held!.deploymentId);
}

/**
 * 0044/S3: a pool Job whose replica can't be placed (it asks for more CPU
 * than the pool's Node has) stays queued, and `status` names the replica's
 * Pending reason, the pool's "fits no Node of pool P" (0048/S9); with
 * `--timeout` it expires unclaimed.
 */
async function qualifyUnplaceable(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const free = await d.target.poolNodeFreeMillicores(pool.id);
  const cpus = String(Math.ceil(free / 1000) * 4);
  const [queued, expiring] = [
    d.names.workload('unplaceable'),
    d.names.workload('unplaceable-timeout'),
  ];
  for (const [id, timeout] of [
    [queued, undefined],
    [expiring, '30s'],
  ] as const) {
    const submitted = await d.target.submitPoolJob(pool.id, {
      id,
      script: 'true',
      cpus,
      timeout,
    });
    invariant(submitted.exitCode === 0, `not admitted: ${submitted.output}`);
  }
  // The queued Job holds the pool until it ends, so a failed check ends it too.
  let deploymentId: string | null | undefined;
  try {
    await d.wait.for(
      "the unplaceable Job's Pending reason",
      () => d.target.poolJobStatus(queued),
      {
        timeoutMs: d.policy.workloadTimeoutMs,
        intervalMs: 2000,
        probeError: 'fail',
        unmet: (status) =>
          status.workload.state === WorkloadState.Queued &&
          status.waiting ===
            `its replica is Pending: fits no Node of pool ${pool.ref.name}`
            ? undefined
            : `${status.workload.state}: ${status.waiting ?? 'no reason'}`,
      },
    );
    const expired = await d.wait.for(
      'the unplaceable Job with --timeout expired',
      () => d.target.poolJobStatus(expiring),
      {
        timeoutMs: d.policy.workloadTimeoutMs,
        intervalMs: 2000,
        probeError: 'fail',
        unmet: (status) =>
          status.workload.state === WorkloadState.Terminated
            ? undefined
            : status.workload.state,
      },
    );
    invariant(
      expired.events.at(-1)?.metadata?.reason === 'claim-deadline-expired' &&
        !expired.events.some(
          (event) => event.state === String(WorkloadState.Syncing),
        ) &&
        (await d.target.poolJobStatus(queued)).workload.state ===
          WorkloadState.Queued,
      `the Job with --timeout must expire unclaimed, the other stay queued: ${JSON.stringify(expired.events)}`,
    );
    ({ deploymentId } = await d.target.poolJobOutcome(expiring));
  } finally {
    await d.target.terminatePoolJob(queued);
  }
  await waitForZeroPods(d, pool.id, deploymentId!);
}

/**
 * Decision 30, `api upgrade`'s drain, last of the pool-Job stages because its
 * hold stops claims for ten minutes: it lists the running Job and holds a
 * new one queued; `force` stops the running one, which retries, never
 * running twice at once.
 */
async function qualifyDrain(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const [running, held] = [
    d.names.workload('drain-running'),
    d.names.workload('drain-held'),
  ];
  const submitted = await d.target.submitPoolJob(pool.id, {
    id: running,
    script: 'echo drain-started; sleep 600',
  });
  invariant(submitted.exitCode === 0, `not admitted: ${submitted.output}`);
  await d.wait.for(
    'the drain stage Job running',
    async () => (await d.target.poolJobStatus(running)).workload.state,
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 2000,
      probeError: 'fail',
      unmet: (state) => (state === WorkloadState.Running ? undefined : state),
    },
  );
  const waiting = await d.target.drainPoolJobs(false);
  invariant(
    waiting.length === 1 && waiting[0] === running,
    `the drain must list the running pool Job: ${JSON.stringify(waiting)}`,
  );
  const queued = await d.target.submitPoolJob(pool.id, {
    id: held,
    script: 'true',
  });
  invariant(queued.exitCode === 0, `not admitted: ${queued.output}`);
  await d.target.drainPoolJobs(true);
  // The execution fence keeps the retry from running beside the stopped one.
  await d.wait.for(
    'the forced Job retried',
    () => d.target.poolJobStatus(running),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 2000,
      probeError: 'fail',
      unmet: (status) =>
        status.workload.state === WorkloadState.Queued &&
        status.events.some(
          (event) => event.state === String(WorkloadState.Retrying),
        )
          ? undefined
          : status.workload.state,
    },
  );
  const other = await d.target.poolJobStatus(held);
  invariant(
    other.workload.state === WorkloadState.Queued &&
      (await d.target.drainPoolJobs(false)).length === 0,
    `the drain must hold new claims and leave nothing running: ${JSON.stringify(other)}`,
  );
  for (const id of [running, held]) await d.target.terminatePoolJob(id);
}

/**
 * 0044/S19: a pool Job's files in the fixed paths, `/tmp`, `/dev/shm` and the
 * working directory, and its background process, are gone for the next Job
 * on its replica (staging empties `/mnt/input` for a Job without an input
 * bucket). Each Job requests over half the pool's one Node's free CPU, so the
 * replica RA adds for the second stays Pending and is the one scaled away
 * when the first ends; the first's replica resets and claims the second. A
 * marker outside the working directory, which the reset keeps, proves it.
 */
async function qualifyReset(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const free = await d.target.poolNodeFreeMillicores(pool.id);
  const cpus = (Math.floor(free * 0.6) / 1000).toFixed(3);
  const leaks =
    '/mnt/input/s19 /mnt/output/s19 /mnt/checkpoint/s19 /tmp/s19 /dev/shm/s19 ./s19';
  const jobs = [
    [
      d.names.workload('reset-dirty'),
      `echo s19 > /var/tmp/s19-replica && for p in ${leaks}; do echo leak > "$p" || exit 7; done; nohup sleep 3600 >/dev/null 2>&1 & sleep 30`,
    ],
    [
      d.names.workload('reset-clean'),
      [
        'test -f /var/tmp/s19-replica || exit 4',
        `for p in ${leaks}; do if [ -e "$p" ]; then exit 5; fi; done`,
        `for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f"; echo; done 2>/dev/null | grep -q '^sleep 3600' && exit 6`,
        'exit 0',
      ].join('\n'),
    ],
  ] as const;
  for (const [id, script] of jobs) {
    const submitted = await d.target.submitPoolJob(pool.id, {
      id,
      script,
      cpus,
    });
    invariant(
      submitted.exitCode === 0,
      `pool Job ${id} was not admitted: ${submitted.output}`,
    );
  }
  const [dirty, clean] = await Promise.all(
    jobs.map(([id]) => d.target.poolJobOutcome(id)),
  );
  invariant(
    dirty.state === WorkloadState.Completed &&
      clean.deploymentId === dirty.deploymentId,
    `the first S19 Job must complete on the second's managed Deployment: ${JSON.stringify(dirty)}`,
  );
  // The second exits 4 if another replica ran it, 5 if a file survived and
  // 6 if the process did.
  invariant(
    clean.state === WorkloadState.Completed,
    `the next Job on the replica must see none of the last one's files or processes: ${JSON.stringify(clean)}`,
  );
  await d.wait.for(
    'the idle S19 managed Deployment back at zero Pods',
    () => d.target.deploymentPodCount(pool.id, dirty.deploymentId!),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 2000,
      probeError: 'fail',
      unmet: (pods) => (pods === 0 ? undefined : `${String(pods)} Pods`),
    },
  );
}

/**
 * RFC 0049 C12: a `--cache` directory outlives its Job and is shared by the
 * pool's Jobs on the Node. A Job writes it as an unprivileged user, and a Job
 * of another shape, so another replica on the pool's one Node, reads it.
 */
async function qualifyNodeCache(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const cache = 'c12:/var/cache/c12';
  const jobs = [
    [
      d.names.workload('cache-write'),
      '0.1',
      `python3 -c "import os; os.setgid(65534); os.setuid(65534); open('/var/cache/c12/hit', 'w').write('c12')"`,
    ],
    [
      d.names.workload('cache-read'),
      '0.2',
      'test "$(cat /var/cache/c12/hit)" = c12 || exit 3',
    ],
  ] as const;
  const ended = [];
  for (const [id, cpus, script] of jobs) {
    const submitted = await d.target.submitPoolJob(pool.id, {
      id,
      script,
      cpus,
      cache,
    });
    invariant(
      submitted.exitCode === 0,
      `pool Job ${id} was not admitted: ${submitted.output}`,
    );
    // The reader starts only after the writer ends.
    ended.push(await d.target.poolJobOutcome(id));
  }
  invariant(
    ended.every((o) => o.state === WorkloadState.Completed) &&
      ended[0].deploymentId !== ended[1].deploymentId,
    `a second replica must read what the first Job wrote to the cache: ${JSON.stringify(ended)}`,
  );
}

/**
 * A replica deleted without a grace override (as an eviction, a drain
 * or `kubectl delete` does) gets its managed Deployment's 120 s grace, so a
 * command whose SIGTERM handler needs 40 s, past Kubernetes's 30 s default,
 * finishes it: the replica's container runs at least 40 s past the delete,
 * where the runner's old 10 s or the kubelet's default would have stopped it.
 * The attempt is retried, and the next runs to completion.
 */
async function qualifyGrace(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const id = d.names.workload('grace');
  const submitted = await d.target.submitPoolJob(pool.id, {
    id,
    script: "trap 'sleep 40; exit 0' TERM; echo grace-armed; sleep 60 & wait",
  });
  invariant(
    submitted.exitCode === 0,
    `pool Job ${id} was not admitted: ${submitted.output}`,
  );
  const held = await d.wait.for(
    'the grace Job running on a replica, its handler set',
    () => d.target.poolJobPod(pool.id, id, 'grace-armed'),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (pod) => (pod ? undefined : 'not running'),
    },
  );
  const { deploymentId, podUid } = held!;
  const ran = await d.target.evictPoolJobReplica(pool.id, deploymentId, podUid);
  invariant(
    ran >= 40_000,
    `the evicted replica must finish its 40 s SIGTERM handler, not stop after ${String(ran)} ms`,
  );
  const outcome = await d.target.poolJobOutcome(id);
  invariant(
    outcome.state === WorkloadState.Completed && outcome.attempt === 2,
    `the evicted grace Job must retry and complete: ${JSON.stringify(outcome)}`,
  );
}

/**
 * 0043/S12: a pool Job writing past its replica's `ephemeral-storage` limit
 * (its CPU fraction of the pool's one Node, from the pool's 40 GB disk) is
 * evicted and ends `invalid` naming the limit. Neighbours on the Node are
 * EX4's: the runner's disk never reaches DiskPressure here. `oflag=direct`
 * bypasses the page cache, which cgroup v2 charges to the memory limit, so
 * the write tests the disk limit, not reclaim racing the OOM killer.
 */
async function qualifyEphemeralStorageLimit(
  d: ClusterLocalDependencies,
  pool: Awaited<ReturnType<typeof createReadyNodePool>>,
): Promise<void> {
  const id = d.names.workload('disk-over');
  const submitted = await d.target.submitPoolJob(pool.id, {
    id,
    script:
      'dd if=/dev/zero of=/mnt/output/fill bs=1M count=2048 oflag=direct && sleep 600',
  });
  invariant(
    submitted.exitCode === 0,
    `pool Job ${id} was not admitted: ${submitted.output}`,
  );
  const over = await d.target.poolJobOutcome(id);
  // A Job still live on a managed Deployment holds its node pool.
  if (over.state !== WorkloadState.Invalid) await d.target.terminatePoolJob(id);
  invariant(
    over.state === WorkloadState.Invalid &&
      /ephemeral.*\d+Mi/.test(over.message ?? ''),
    `the Job past its ephemeral-storage limit must end invalid naming the limit: ${JSON.stringify(over)}`,
  );
}

/**
 * Cluster + node pool composition: the runner's K3s is registered as the cluster,
 * node pools join it through the production bootstrap-token path, and the
 * Deployment / targeted-Job / Service stages run against that cluster. Node
 * pool deletion must leave the cluster intact.
 */
export class ClusterLocalContract {
  readonly #dependencies: ClusterLocalDependencies;

  constructor(dependencies: ClusterLocalDependencies) {
    this.#dependencies = dependencies;
  }

  async run(target: 'e2e-cluster-local'): Promise<ClusterLocalContractResult> {
    invariant(target === 'e2e-cluster-local', `unsupported target ${target}`);
    const completions: TargetedJobCompletion[] = [];
    const dependencies = { ...this.#dependencies, completions };
    const at = (stage: string) => dependencies.progress.mark(stage);
    // First, so a run without the token fails before the cluster work.
    const createGithubSecret = dependencies.githubSecret();
    await dependencies.target.prepare();
    const cluster = dependencies.cluster.registered();
    at('cluster registered; creating node pools');

    const [poolARef, poolBRef] = await Promise.all([
      dependencies.nodePools.reserve(
        dependencies.names.nodePool('pool-a'),
        dependencies.policy.nodePoolTimeoutMs,
      ),
      dependencies.nodePools.reserve(
        dependencies.names.nodePool('pool-b'),
        dependencies.policy.nodePoolTimeoutMs,
      ),
    ]);
    const creations = [
      createReadyNodePool(dependencies, poolARef, 2),
      // Pool B admits privileged Jobs; pool A refuses them.
      createReadyNodePool(dependencies, poolBRef, 1, 1, 'privileged'),
    ];
    const nodePools = await Promise.all(creations).catch(
      async (error: unknown) => {
        await Promise.allSettled(creations);
        throw error;
      },
    );
    // Each unpinned pool's first region is full: it moved on without failing.
    for (const pool of nodePools) {
      const unrecovered = forcedCapacityFailureUnmet(pool.failedLaunches);
      invariant(
        !unrecovered,
        `node pool ${pool.id} did not move past its full first region: ${unrecovered}`,
      );
    }
    for (const pool of nodePools) {
      await dependencies.target.assertPoolNodes(pool.id);
    }
    at('node pools ready');
    const [, connectionB] = await observeNodePoolIsolation(dependencies, [
      nodePools[0],
      nodePools[1],
    ]);
    // Pool B admits privileged Jobs, whose Node's credential this uses.
    await dependencies.cluster.kubeletRestrictions(nodePools[1].id);
    at(
      "pool Node credentials refused protected labels, other Node names and other Nodes' status",
    );

    const readinessReservation = dependencies.names.workload('readiness');
    await dependencies.target.putReservation(readinessReservation, 'hold');
    const readinessProbe = controlledReadinessProbe(readinessReservation);
    let deployment = await createManagedDeployment(
      dependencies,
      nodePools[0].ref,
      dependencies.names.deployment('deployment'),
      {
        image: dependencies.policy.workloadImage,
        maxConcurrentJobsPerReplica: 2,
        readinessProbe,
      },
    );
    at('Deployment created');
    const initialReady = await qualifyNativeReadiness(
      dependencies,
      deployment,
      readinessReservation,
    );
    at('Deployment ready through the controlled probe');
    await qualifyDeploymentExec(dependencies, deployment);
    at('exec ran in the ready replica and in the one --replica named');
    await proveDeploymentIsolation(dependencies, deployment, nodePools[1].id);
    await qualifyPoolEgress(dependencies, nodePools[0].id);
    at('node pool egress policy enforced');
    await qualifyTargetedJobAdmission(dependencies, deployment.ref);
    await qualifyApplicationRetry(dependencies, deployment.ref);
    const asyncTransport = await qualifyConcurrentTargetedJobs(
      dependencies,
      deployment.ref,
      initialReady,
    );
    for (const fault of ['admission', 'observation'] as const) {
      await proveSubmissionResponseLoss(dependencies, deployment.ref, fault);
    }
    at('targeted Job admission, retry, concurrency and response loss proven');

    // Hold one active Job across API replacement, Pod replacement, and the
    // environment rollout. Each owner returns the evidence for the next stage.
    const recovery = await startTargetedJobRecovery(
      dependencies,
      deployment.ref,
    );
    const beforeConnection = await dependencies.target.connection(
      nodePools[0].id,
    );
    await replaceClusterController(
      dependencies,
      nodePools[0],
      beforeConnection,
    );
    await confirmClusterConnection(dependencies, nodePools[1], connectionB);
    at('API controller replaced');
    const recoveredPod = await replaceDeploymentPod(dependencies, deployment);
    await waitForTargetedJobRedelivery(dependencies, recovery, recoveredPod);
    at('Deployment Pod replaced; Job redelivered');

    const secondBlocker = await submitJob(
      dependencies,
      deployment.ref,
      'drain-second',
      'hold',
    );
    await dependencies.jobs.kernel.waitForState(
      secondBlocker,
      WorkloadState.Running,
      dependencies.policy.workloadTimeoutMs,
    );
    const idleStopKey = dependencies.names.workload('idle-stop');
    const rollout = await beginDeploymentRollout(
      dependencies,
      deployment,
      recoveredPod,
      recovery,
      {
        env: {
          RESERVATION_BASE_URL: dependencies.target.reservationBaseUrl(),
          CONFIGURATION_MARKER: 'updated',
          IDLE_STOP_RESERVATION: idleStopKey,
        },
      },
    );
    await proveHardenedReplica(
      dependencies,
      deployment.ref,
      rollout.draining.podUid,
    );
    const { job: nextGenerationJob, bothBlocked } =
      await queueTargetedJobDuringDrain(dependencies, deployment.ref, [
        recovery,
        secondBlocker,
      ]);
    const drained = await completeTargetedJob(
      dependencies,
      deployment.ref,
      recovery,
    );
    const oneBlocked = await proveRemainingTargetedBlocker(
      dependencies,
      deployment.ref,
      secondBlocker,
      nextGenerationJob,
      rollout.draining.podUid,
    );
    await completeTargetedJob(dependencies, deployment.ref, secondBlocker);
    await proveReplicaReleased(
      dependencies,
      deployment.ref,
      rollout.draining.podUid,
    );
    const rolledOut = await finishDeploymentRollout(
      dependencies,
      rollout,
      drained,
    );
    at('Deployment rollout drained and finished');
    deployment = rollout.desired;
    const replacement = await qualifyReplacementGenerationJob(
      dependencies,
      deployment,
      rolledOut,
      nextGenerationJob,
    );
    await dependencies.target.recordDeploymentDrain(deployment.ref, {
      previousGeneration: rollout.previous.generation,
      requestedGeneration: deployment.generation,
      firstReleasedJobId: recovery.id,
      lastReleasedJobId: secondBlocker.id,
      queuedJobId: nextGenerationJob.id,
      bothBlocked,
      oneBlocked,
      ...replacement,
    });
    await qualifyTargetedEnvironmentUpdate(
      dependencies,
      deployment.ref,
      rolledOut,
      idleStopKey,
    );

    const secret = await dependencies.namedSecret.create('deployment');
    const unconfiguredOneSlot = await createManagedDeployment(
      dependencies,
      nodePools[0].ref,
      dependencies.names.deployment('one-slot'),
      // S17's handler allocates past this limit.
      {
        image: dependencies.policy.workloadImage,
        dockerOptions: { memory: '256m' },
        secrets: [secret.name],
      },
    );
    const { deployment: oneSlot, ready: oneSlotReady } =
      await qualifyDeploymentProbeChanges(
        dependencies,
        unconfiguredOneSlot,
        readinessProbe,
      );
    await qualifyDeploymentSecret(dependencies, oneSlot, oneSlotReady, secret);
    await proveConvergedDeploymentWritesNothing(
      dependencies,
      oneSlot,
      nodePools[0].id,
    );
    at('converged Deployments wrote nothing across a resync; repair was exact');
    const runtimeLoss = await startTargetedRuntimeLoss(
      dependencies,
      oneSlot.ref,
    );
    await replaceDeploymentPod(dependencies, oneSlot);
    await finishTargetedRuntimeLoss(dependencies, runtimeLoss);
    await qualifyReplicaOomRetry(dependencies, oneSlot.ref);
    await qualifyOwnedObjectRepair(dependencies, oneSlot);
    // The replacement replica's token authenticates: it claims and completes.
    await completeTargetedJob(
      dependencies,
      oneSlot.ref,
      await submitJob(dependencies, oneSlot.ref, 'owned-repair', 'hold'),
    );
    at(
      'second Deployment probe changes, runtime loss, replica OOM and owned-object repair proven',
    );

    const replicasRecord = await qualifyDeploymentReplicas(
      dependencies,
      nodePools[0],
    );
    at(
      'replicas scaled 1 → 2 on queued plus held claims, drained, recovered and scaled back',
    );

    await qualifyPoolJobs(dependencies, nodePools[0]);
    at('pool Jobs ran through the runner on one managed Deployment, 0 → 1 → 0');

    // Saved after the controller replacement, as SecretManager requires.
    const githubSecret = await createGithubSecret?.();
    await qualifyPoolJobOptions(dependencies, nodePools[0], githubSecret);
    at(
      githubSecret
        ? 'replica options gave pool Jobs their /dev/shm and their Secret'
        : 'replica options gave pool Jobs their /dev/shm; private clone skipped',
    );

    nodePools[0] = await qualifyNodeLoss(dependencies, nodePools[0]);
    at(
      'node pool capacity replaced; a pool Job on the lost Node retried once and kept each attempt tail',
    );

    await qualifyPoolJobLogs(dependencies, nodePools[1]);
    at(
      "a followed pool Job log and its stored tail held only that Job's lines",
    );

    await qualifyPoolJobExec(dependencies, nodePools[1]);
    at('exec reached only the running pool Job, not the queued or ended one');

    await qualifyPrivilegedPoolJob(dependencies, nodePools[1]);
    at('a privileged pool Job had CAP_SYS_ADMIN and its --bind volume');

    await qualifyUserNamespaceAdmission(dependencies);
    at('a user-namespace pool refused --cache, and the policy held');

    await qualifyReset(dependencies, nodePools[1]);
    at("the next pool Job on a replica saw none of the last one's state");

    await qualifyNodeCache(dependencies, nodePools[1]);
    at("a pool Job on another replica read the last one's --cache");

    await qualifyTerminate(dependencies, nodePools[1]);
    at('a terminated pool Job got SIGTERM; its replica reset and ran the next');

    await qualifyUnplaceable(dependencies, nodePools[1]);
    at('an unplaceable pool Job stayed queued with its reason, or expired');

    await qualifyGrace(dependencies, nodePools[1]);
    at('an evicted pool Job replica got its grace past the 30 s default');

    await qualifyEphemeralStorageLimit(dependencies, nodePools[1]);
    at(
      'a pool Job past its ephemeral-storage limit was evicted and ended invalid',
    );

    await qualifyDrain(dependencies, nodePools[1]);
    at('api upgrade drained pool Jobs, and --force retried the running one');

    const service = await qualifyNodePoolService(
      dependencies,
      nodePools[1].id,
      dependencies.names.workload('service'),
    );

    await proveNodePoolDeletionFence(dependencies, nodePools[0].ref);
    const deploymentRecords = await Promise.all([
      deleteDeployment(dependencies, deployment),
      deleteDeployment(dependencies, oneSlot),
      Promise.resolve(replicasRecord),
    ]);
    at('Deployments deleted');
    await secret.release();
    await githubSecret?.release();
    const nodePoolRecords = await deleteNodePools(dependencies, nodePools);
    at('node pools deleted');
    const intact = await dependencies.cluster.intact();
    invariant(
      intact.id === cluster.id &&
        intact.kubernetesIdentity === cluster.kubernetesIdentity,
      'node pool deletion changed the cluster',
    );
    const hostedChart = await dependencies.cluster.hostedChartRepair();
    at('hosted API applied its own chart');
    const jobRecords = completions.map((completion) => completion.record);
    invariant(
      jobRecords.length === 24 &&
        new Set(jobRecords.map((record) => record.jobId)).size ===
          jobRecords.length,
      'composition omitted or duplicated targeted Job completion records',
    );
    invariant(
      jobRecords.every((record) =>
        deploymentRecords.some(
          (entry) =>
            entry.deploymentId === record.deploymentId &&
            entry.name === record.deploymentName,
        ),
      ),
      'targeted Job record escaped the composed Deployments',
    );
    return {
      contract: 'e2e-cluster-local',
      records: {
        cluster: {
          id: cluster.id,
          kubernetesIdentity: cluster.kubernetesIdentity,
          intactAfterNodePoolDeletion: true,
        },
        nodePools: nodePoolRecords,
        deployments: deploymentRecords,
        targetedJobs: jobRecords,
        services: [service],
        asyncTransport,
        hostedChart,
      },
      qualification: 'conclusive',
      target: 'e2e-cluster-local',
      satisfied: true,
    };
  }
}
