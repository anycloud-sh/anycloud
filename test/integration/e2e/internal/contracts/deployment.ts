import type { TrackedNodePoolRef } from '../node-pools.js';
import {
  deploymentSubstrateAbsenceUnmet,
  type DeploymentKernel,
  type TrackedDeploymentRef,
} from '../deployments.js';
import type {
  KubernetesDeploymentReadyObservation,
  ClusterNodePoolAdapter,
  ManagedKubernetesDeploymentSummary,
} from '../targets/cluster-node-pool.js';
import type { Waiter } from '../wait.js';
import {
  NAMED_SECRET_PROBE_KEY,
  type NamedSecretProbe,
} from '../probes/named-secret.js';
import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { CleanupRecorded, TrackedWorkloadRef } from '../workloads.js';

type DeploymentCreateInput = Parameters<
  ClusterNodePoolAdapter['createDeployment']
>[1];
type DeploymentUpdateInput = Parameters<
  ClusterNodePoolAdapter['updateDeployment']
>[1];

export interface DeploymentContractDependencies {
  readonly deployments: Pick<
    DeploymentKernel,
    | 'recordSubstrateAbsence'
    | 'release'
    | 'reserve'
    | 'status'
    | 'waitForDeletionRecorded'
  >;
  readonly policy: { readonly workloadTimeoutMs: number };
  readonly target: Pick<
    ClusterNodePoolAdapter,
    | 'createDeployment'
    | 'deploymentReady'
    | 'deploymentReadyByCli'
    | 'deleteDeployment'
    | 'deploymentAbsent'
    | 'deploymentAbsentInNodePool'
    | 'updateDeployment'
    | 'waitForReconcileOpportunity'
    | 'deploymentLogContains'
    | 'deleteDeploymentPod'
    | 'deploymentOwnedObjects'
    | 'deleteDeploymentOwnedObject'
    | 'deploymentPod'
    | 'attemptDelete'
  >;
  readonly wait: Pick<Waiter, 'for'>;
}

export interface ManagedDeployment extends ManagedKubernetesDeploymentSummary {
  readonly ref: TrackedDeploymentRef;
}

export interface DeploymentContractRecord {
  readonly contract: 'deployment';
  readonly deploymentId: string;
  readonly name: string;
  readonly nodePoolId: string;
  readonly generation: number;
  readonly deletedAt: number;
  readonly nativeAbsence: readonly {
    readonly kind:
      | 'KubernetesDeployment'
      | 'Pod'
      | 'ReplicaSet'
      | 'Secret'
      | 'ServiceAccount';
    readonly count: number;
  }[];
}

export interface DrainingDeployment {
  readonly desired: ManagedDeployment;
  readonly previous: ManagedDeployment;
  readonly draining: KubernetesDeploymentReadyObservation;
  readonly activeJob: TrackedWorkloadRef;
}

const completedRollouts = new WeakSet<DrainingDeployment>();

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Managed Kubernetes contract: ${message}`);
}

export async function waitForDeploymentReady(
  dependencies: Pick<DeploymentContractDependencies, 'policy' | 'wait'> & {
    readonly target: Pick<ClusterNodePoolAdapter, 'deploymentReady'>;
  },
  deployment: ManagedDeployment,
): Promise<KubernetesDeploymentReadyObservation> {
  const ready = await dependencies.wait.for(
    `Deployment ${deployment.ref.name} generation ${deployment.generation} readiness`,
    () => dependencies.target.deploymentReady(deployment.ref),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (ready) =>
        ready?.generation === deployment.generation
          ? undefined
          : ready
            ? `observed generation ${ready.generation}`
            : 'no Ready Pod',
    },
  );
  invariant(
    ready,
    `Deployment ${deployment.ref.name} did not produce a Ready Pod`,
  );
  return ready;
}

type DeploymentReadinessProbe = NonNullable<
  ManagedKubernetesDeploymentSummary['readinessProbe']
>;
type DeploymentStatus = NonNullable<
  ManagedKubernetesDeploymentSummary['status']
>;

export function controlledReadinessProbe(
  reservation: string,
): DeploymentReadinessProbe {
  // Only this fixture reservation changes. No Job mutation wakes the receiver.
  return {
    exec: {
      command: [
        'python3',
        '-c',
        [
          'import httpx, json, os, sys, time',
          'from pathlib import Path',
          'try:',
          `    url = os.environ["RESERVATION_BASE_URL"].rstrip("/") + "/${encodeURIComponent(reservation)}"`,
          '    with httpx.Client(timeout=1) as client:',
          '        response = client.get(url)',
          '        response.raise_for_status()',
          '        ready = response.json()["behavior"] == "complete"',
          'except Exception as error:',
          '    response = getattr(error, "response", None)',
          '    print(json.dumps({"probeError": type(error).__name__, "reason": str(getattr(response, "reason_phrase", ""))[:240], "status": getattr(response, "status_code", None)}), file=sys.stderr, flush=True)',
          '    sys.exit(1)',
          'marker = Path("/tmp/anycloud-readiness-success-ms")',
          'if ready:',
          '    if not marker.exists(): marker.write_text(str(time.time_ns() // 1_000_000))',
          'else: marker.unlink(missing_ok=True)',
          'sys.exit(0 if ready else 1)',
        ].join('\n'),
      ],
    },
    periodSeconds: 1,
    // Python start-up plus the HTTP round trip exceeded 2 s on a loaded runner
    // often enough to flap readiness (kubelet `ExecSync … context canceled`).
    timeoutSeconds: 5,
    failureThreshold: 1,
    successThreshold: 1,
  };
}

/**
 * What a wait expects of a Deployment's status. `ready` is `running`, ready,
 * and with no upgrade still starting: an upgrade, and a readiness loss after
 * a rollout, both leave the Deployment `running`.
 */
const DEPLOYMENT_EXPECTATIONS = {
  ready: (status: DeploymentStatus) =>
    status.state === WorkloadState.Running &&
    status.ready &&
    status.upgrade?.state !== WorkloadState.Starting,
  'probe failing': (status: DeploymentStatus) =>
    status.applicationReady === false,
  'waiting on Jobs': (status: DeploymentStatus) =>
    status.blockingJobs.total > 0,
};

export async function waitForDeploymentStatus(
  dependencies: Pick<DeploymentContractDependencies, 'policy' | 'wait'> & {
    readonly target: Pick<
      ClusterNodePoolAdapter,
      'deploymentStatus' | 'deploymentReadyByCli'
    >;
  },
  deployment: TrackedDeploymentRef,
  expectation: keyof typeof DEPLOYMENT_EXPECTATIONS,
): Promise<ManagedKubernetesDeploymentSummary & { status: DeploymentStatus }> {
  const summary = await dependencies.wait.for(
    `Deployment ${deployment.name} ${expectation}`,
    () => dependencies.target.deploymentStatus(deployment),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 250,
      probeError: 'fail',
      unmet: (summary) =>
        summary.status && DEPLOYMENT_EXPECTATIONS[expectation](summary.status)
          ? undefined
          : JSON.stringify(summary.status),
    },
  );
  invariant(summary.status, 'individual status omitted its observation');
  if (expectation === 'ready') {
    invariant(
      await dependencies.target.deploymentReadyByCli(deployment),
      `anycloud wait did not report Deployment ${deployment.name} ready`,
    );
  }
  return { ...summary, status: summary.status };
}

export async function qualifyDeploymentProbeChanges(
  dependencies: DeploymentContractDependencies & {
    readonly target: Pick<ClusterNodePoolAdapter, 'deploymentStatus'>;
  },
  deployment: ManagedDeployment,
  readinessProbe: DeploymentReadinessProbe,
): Promise<{
  deployment: ManagedDeployment;
  ready: KubernetesDeploymentReadyObservation;
}> {
  const unconfigured = await waitForDeploymentStatus(
    dependencies,
    deployment.ref,
    'ready',
  );
  invariant(
    unconfigured.readinessProbe === null &&
      unconfigured.status.applicationReady === null,
    'unconfigured application readiness was reported as known',
  );
  const configured = {
    ref: deployment.ref,
    ...(await dependencies.target.updateDeployment(deployment.ref, {
      readinessProbe: { ...readinessProbe, periodSeconds: 2 },
    })),
  };
  await waitForDeploymentReady(dependencies, configured);
  invariant(
    (await waitForDeploymentStatus(dependencies, configured.ref, 'ready'))
      .readinessProbe?.periodSeconds === 2,
    'probe-only update did not apply native readiness',
  );
  const clearedDeployment = {
    ref: configured.ref,
    ...(await dependencies.target.updateDeployment(configured.ref, {
      readinessProbe: null,
    })),
  };
  invariant(
    clearedDeployment.generation === configured.generation + 1,
    'removing the probe did not advance generation',
  );
  const ready = await waitForDeploymentReady(dependencies, clearedDeployment);
  const cleared = await waitForDeploymentStatus(
    dependencies,
    clearedDeployment.ref,
    'ready',
  );
  invariant(
    cleared.status.probeConfigured === false &&
      cleared.status.applicationReady === null,
    'clearing readiness left a native probe on the replacement Pod',
  );
  return { deployment: clearedDeployment, ready };
}

export async function deleteDeployment(
  dependencies: DeploymentContractDependencies,
  deployment: ManagedDeployment,
): Promise<DeploymentContractRecord> {
  await dependencies.target.deleteDeployment(deployment.ref);
  const deletion = await dependencies.deployments.waitForDeletionRecorded(
    deployment.ref,
    dependencies.policy.workloadTimeoutMs,
  );
  const resources = await dependencies.wait.for(
    `Deployment ${deployment.ref.name} native absence`,
    () => dependencies.target.deploymentAbsent(deployment.ref),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: deploymentSubstrateAbsenceUnmet,
    },
  );
  invariant(
    typeof deletion.deployment.deletedAt === 'number' &&
      Number.isFinite(deletion.deployment.deletedAt),
    'Deployment cleanup omitted durable deletion',
  );
  await dependencies.deployments.release({
    deletion,
    substrate: dependencies.deployments.recordSubstrateAbsence(
      deployment.ref,
      resources,
    ),
  });
  return {
    contract: 'deployment',
    deploymentId: deletion.deployment.id,
    name: deployment.ref.name,
    nodePoolId: deletion.deployment.nodePoolId ?? '',
    generation: deletion.deployment.generation,
    deletedAt: deletion.deployment.deletedAt,
    nativeAbsence: [
      { kind: 'KubernetesDeployment', count: resources.workloads },
      { kind: 'Pod', count: resources.pods },
      { kind: 'ReplicaSet', count: resources.replicaSets },
      { kind: 'Secret', count: resources.secrets },
      { kind: 'ServiceAccount', count: resources.serviceAccounts },
    ],
  };
}

export async function waitForDeploymentLog(
  dependencies: Pick<DeploymentContractDependencies, 'policy' | 'wait'> & {
    readonly target: Pick<ClusterNodePoolAdapter, 'deploymentLogContains'>;
  },
  deployment: TrackedDeploymentRef,
  podUid: string,
  line: string,
): Promise<void> {
  await dependencies.wait.for(
    `Deployment ${deployment.name} to report ${line}`,
    () => dependencies.target.deploymentLogContains(deployment, podUid, line),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1000,
      probeError: 'fail',
      unmet: (observed) => (observed ? undefined : `not observed: ${line}`),
    },
  );
}

/**
 * A named Secret reaches the replica (its digest in the Pod's log), its
 * Deployment shows the Secret's name but never its value, and a non-forced
 * delete of the Secret is refused while the Deployment exists.
 */
export async function qualifyDeploymentSecret(
  dependencies: Pick<
    DeploymentContractDependencies,
    'deployments' | 'policy' | 'wait'
  > & {
    readonly target: Pick<ClusterNodePoolAdapter, 'deploymentLogContains'>;
    refuseSecretDeletion(name: string): Promise<number | undefined>;
  },
  deployment: ManagedDeployment,
  ready: KubernetesDeploymentReadyObservation,
  secret: Pick<NamedSecretProbe, 'appearsIn' | 'digest' | 'name'>,
): Promise<void> {
  await waitForDeploymentLog(
    dependencies,
    deployment.ref,
    ready.podUid,
    `SECRET_SHA256 ${secret.digest}`,
  );
  const shown = await dependencies.deployments.status(deployment.ref);
  invariant(
    shown.secretNames.length === 1 &&
      shown.secretNames[0] === secret.name &&
      !shown.envKeys.includes(NAMED_SECRET_PROBE_KEY),
    `Deployment shows Secrets ${JSON.stringify(shown.secretNames)} and env ${JSON.stringify(shown.envKeys)}`,
  );
  invariant(
    !secret.appearsIn(JSON.stringify(shown)),
    'Deployment status exposed a Secret value',
  );
  const refused = await dependencies.refuseSecretDeletion(secret.name);
  invariant(refused === 409, `in-use Secret delete returned ${refused}`);
}

/**
 * 0044/S16: a natively deleted ServiceAccount is repaired through the pool
 * loop's owned-object watch, well inside its 60 s resync. The recreated
 * ServiceAccount has a new UID that the replica's bound token doesn't carry,
 * so the replica is replaced. Returns the replacement, which the caller
 * proves can claim. The env Secret's repair (which restarts nothing) is
 * proven write for write by `proveConvergedDeploymentWritesNothing` in the
 * cluster-local contract.
 */
export async function qualifyOwnedObjectRepair(
  dependencies: DeploymentContractDependencies,
  deployment: ManagedDeployment,
): Promise<KubernetesDeploymentReadyObservation> {
  // The Secret's repair is proven, write for write, by the cluster-local
  // converged-Deployment stage.
  const before = await waitForDeploymentReady(dependencies, deployment);
  const deleted = (
    await dependencies.target.deploymentOwnedObjects(deployment.ref)
  ).serviceAccountUid;
  invariant(deleted, 'Deployment had no owned ServiceAccount to delete');
  await dependencies.target.deleteDeploymentOwnedObject(
    deployment.ref,
    'ServiceAccount',
  );
  await dependencies.wait.for(
    `Deployment ${deployment.ref.name} ServiceAccount repair`,
    () => dependencies.target.deploymentOwnedObjects(deployment.ref),
    {
      timeoutMs: 20_000,
      intervalMs: 500,
      probeError: 'fail',
      unmet: ({ serviceAccountUid }) =>
        serviceAccountUid && serviceAccountUid !== deleted
          ? undefined
          : 'ServiceAccount not recreated',
    },
  );
  const replaced = await dependencies.wait.for(
    `Deployment ${deployment.ref.name} replica after ServiceAccount repair`,
    () => dependencies.target.deploymentReady(deployment.ref),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (ready) =>
        ready && ready.podUid !== before.podUid
          ? undefined
          : 'no Ready replacement replica',
    },
  );
  invariant(replaced, 'ServiceAccount repair left no Ready replica');
  return replaced;
}

const FINALIZER = 'anycloud.sh/outcome';

/**
 * RT10, K6 and K9: a running replica, read whole from the API, carries the
 * anycloud finalizer, runs the existing image under `RuntimeDefault`
 * seccomp without privilege escalation, and isn't BestEffort.
 */
export async function proveHardenedReplica(
  dependencies: DeploymentContractDependencies,
  deployment: TrackedDeploymentRef,
  podUid: string,
): Promise<void> {
  const pod = await dependencies.target.deploymentPod(deployment, podUid);
  invariant(
    pod?.finalizers.includes(FINALIZER) &&
      pod.seccompProfile === 'RuntimeDefault' &&
      pod.privilegeEscalation === false &&
      pod.qosClass !== 'BestEffort',
    `replica Pod ${podUid} is not hardened: ${JSON.stringify(pod)}`,
  );
}

/**
 * 0044/S18: once its sessions drained, a rollout's replaced replica is
 * deleted at once and released as soon as its container stops, each well
 * inside the loop's 60 s resync: the finalizer doesn't delay the rollout.
 */
export async function proveReplicaReleased(
  dependencies: DeploymentContractDependencies,
  deployment: TrackedDeploymentRef,
  podUid: string,
): Promise<void> {
  const observe = () => dependencies.target.deploymentPod(deployment, podUid);
  // The drained replica is deleted on the release's event, not a resync.
  await dependencies.wait.for(`replaced replica ${podUid} deleted`, observe, {
    timeoutMs: 20_000,
    intervalMs: 500,
    probeError: 'fail',
    unmet: (pod) => (!pod || pod.deleting ? undefined : 'not yet deleted'),
  });
  // Its container stops within Kubernetes' 30 s default grace period.
  await dependencies.wait.for(`replaced replica ${podUid} stopped`, observe, {
    timeoutMs: 45_000,
    intervalMs: 500,
    probeError: 'fail',
    unmet: (pod) =>
      !pod || (pod.deleting && pod.containerStopped)
        ? undefined
        : 'not yet deleted and stopped',
  });
  await dependencies.wait.for(`replaced replica ${podUid} released`, observe, {
    timeoutMs: 20_000,
    intervalMs: 500,
    probeError: 'fail',
    unmet: (pod) =>
      !pod || !pod.finalizers.includes(FINALIZER)
        ? undefined
        : 'still held by the anycloud finalizer',
  });
}

export async function createManagedDeployment(
  dependencies: DeploymentContractDependencies,
  nodePool: TrackedNodePoolRef,
  name: string,
  input: DeploymentCreateInput,
): Promise<ManagedDeployment> {
  const ref = await dependencies.deployments.reserve(
    nodePool,
    name,
    dependencies.policy.workloadTimeoutMs,
  );
  const deployment = {
    ...(await dependencies.target.createDeployment(ref, input)),
    ref,
  };
  if (input.maxConcurrentJobsPerReplica === undefined) {
    invariant(
      deployment.maxConcurrentJobsPerReplica === 1,
      'omitted concurrency did not default to one',
    );
  }
  return deployment;
}

export async function proveDeploymentIsolation(
  dependencies: DeploymentContractDependencies,
  deployment: ManagedDeployment,
  siblingNodePoolId: string,
): Promise<void> {
  const isolated = await dependencies.target.deploymentAbsentInNodePool(
    deployment.ref,
    siblingNodePoolId,
  );
  invariant(
    deploymentSubstrateAbsenceUnmet(isolated) === undefined,
    'persistent Deployment crossed its node pool boundary',
  );
}

export async function beginDeploymentRollout(
  dependencies: DeploymentContractDependencies,
  deployment: ManagedDeployment,
  activePod: KubernetesDeploymentReadyObservation,
  activeJob: TrackedWorkloadRef,
  input: DeploymentUpdateInput,
): Promise<DrainingDeployment> {
  const update = await dependencies.target.updateDeployment(
    deployment.ref,
    input,
  );
  invariant(
    update.generation === deployment.generation + 1,
    'environment update did not advance desired generation',
  );
  await dependencies.target.waitForReconcileOpportunity();
  const draining = await dependencies.target.deploymentReady(deployment.ref);
  invariant(
    draining !== null &&
      draining.podUid === activePod.podUid &&
      draining.generation === deployment.generation,
    'rollout replaced the Pod before its active Job drained',
  );
  return {
    desired: { ...update, ref: deployment.ref },
    previous: deployment,
    draining,
    activeJob,
  };
}

export async function finishDeploymentRollout(
  dependencies: DeploymentContractDependencies,
  rollout: DrainingDeployment,
  cleanup: CleanupRecorded,
): Promise<KubernetesDeploymentReadyObservation> {
  invariant(
    !completedRollouts.has(rollout),
    'Deployment rollout was already completed',
  );
  invariant(
    cleanup.ref === rollout.activeJob &&
      cleanup.status.workload.id === rollout.activeJob.id &&
      cleanup.status.workload.state === WorkloadState.Completed &&
      typeof cleanup.status.workload.cleanedAt === 'number' &&
      Number.isFinite(cleanup.status.workload.cleanedAt),
    'Deployment rollout requires cleanup of its active Job',
  );
  const ready = await waitForDeploymentReady(dependencies, rollout.desired);
  invariant(
    ready.podUid !== rollout.draining.podUid,
    'new generation reused the drained Pod',
  );
  completedRollouts.add(rollout);
  return ready;
}

export async function replaceDeploymentPod(
  dependencies: DeploymentContractDependencies,
  deployment: ManagedDeployment,
): Promise<KubernetesDeploymentReadyObservation> {
  const before = await waitForDeploymentReady(dependencies, deployment);
  await dependencies.target.deleteDeploymentPod(deployment.ref, before.podUid);
  const after = await dependencies.wait.for(
    `Deployment ${deployment.ref.name} replacement Pod`,
    () => dependencies.target.deploymentReady(deployment.ref),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (ready) =>
        ready &&
        ready.generation === deployment.generation &&
        ready.podUid !== before.podUid
          ? undefined
          : 'no Ready replacement Pod at the current generation',
    },
  );
  invariant(after, 'runtime replacement omitted a Ready Pod');
  return after;
}

export async function proveNodePoolDeletionFence(
  dependencies: DeploymentContractDependencies,
  nodePool: TrackedNodePoolRef,
): Promise<void> {
  const deletionAttempt = await dependencies.target.attemptDelete(nodePool);
  invariant(
    deletionAttempt.kind === 'rejected' &&
      deletionAttempt.code === 'NODE_POOL_REFERENCED',
    'node pool deletion ignored persistent Deployments',
  );
}
