import { WorkloadState } from '../../../../../src/shared/workload.js';

import type {
  WorkloadKernel,
  TrackedWorkloadRef,
  SubstrateAbsent,
} from '../workloads.js';
import type { Environment } from '../environment.js';
import type { FixtureNames } from '../names.js';
import type { SecretManager } from '../secrets.js';
import type { PersistentVmTargetFactory } from '../targets/persistent-vm.js';
import type {
  ContractQualification,
  PersistentVmRunningContext,
  PersistentVmRunningObservation,
  PersistentVmSubmission,
  PersistentVmTarget,
  PersistentVmTargetProfile,
  PersistentVmTerminatedObservation,
} from '../targets/persistent-vm-types.js';
import type {
  DeclaredApiError,
  LiveVmMetadata,
  SshAccessMode,
  SshAccessSummary,
  StatusResponse,
  WorkloadFixtureObservation,
  WorkloadInspection,
} from '../types.js';
import type { VmHarness } from '../vm.js';
import type { VmLedgerProbe, VmLedgerSnapshot } from '../vm-ledger.js';
import type { Waiter } from '../wait.js';
import {
  runningEvidence,
  terminatedEvidence,
  type PersistentVmContractPolicy,
} from './persistent-vm-policy.js';

export interface PersistentVmRunningDependencies {
  readonly kernel: Pick<WorkloadKernel, 'waitForState'>;
  /** The user's path to a ready VM: `anycloud wait`, then `anycloud exec`. */
  vmReadyByCli(
    id: string,
    timeoutMs: number,
  ): Promise<{ readonly waitReady: boolean; readonly execAfterWait: boolean }>;
  readonly nativeCleanup: {
    reserve(
      target: PersistentVmTarget,
      id: string,
      timeoutMs: number,
    ): Promise<TrackedWorkloadRef>;
    capture(ref: TrackedWorkloadRef, status?: StatusResponse): Promise<void>;
    verify(
      ref: TrackedWorkloadRef,
      timeoutMs: number,
    ): Promise<SubstrateAbsent>;
  };
  readonly targets: Pick<
    PersistentVmTargetFactory,
    'observeRunning' | 'profile'
  >;
  policy(target: PersistentVmTarget): PersistentVmContractPolicy;
  submitPersistentVm(
    target: PersistentVmTarget,
    request: PersistentVmSubmission,
  ): Promise<void>;
  readonly sshAccess: {
    summary(id: string, mode: SshAccessMode): Promise<SshAccessSummary>;
    rejection(id: string, mode: SshAccessMode): Promise<DeclaredApiError>;
  };
  readonly vmLedger: Pick<
    VmLedgerProbe,
    | 'credentialName'
    | 'liveEntries'
    | 'liveVmCount'
    | 'liveVmMetadata'
    | 'snapshot'
  >;
  readonly environment: Pick<Environment, 'optional'>;
  readonly secrets: Pick<SecretManager, 'create'>;
  readonly vm: Pick<
    VmHarness,
    | 'inspectWorkload'
    | 'probeWorkloadFixture'
    | 'verifyHostDocker'
    | 'writeWorkspaceMarker'
  >;
  readonly names: Pick<FixtureNames, 'workload' | 'secret'>;
  readonly wait: Pick<Waiter, 'for'>;
  sha256(value: string): string;
}

export interface ProvisionedPersistentVm {
  readonly ref: TrackedWorkloadRef;
  readonly environmentMarker: string;
  readonly fixtureObservation: WorkloadFixtureObservation;
  readonly policy: PersistentVmContractPolicy;
  readonly profile: PersistentVmTargetProfile;
  readonly runningContext: PersistentVmRunningContext;
  readonly runningLedger: VmLedgerSnapshot;
  readonly runningStatus: StatusResponse;
  readonly secretDigest: string;
  readonly secretName: string;
  readonly target: PersistentVmTarget;
  readonly workload: WorkloadInspection;
  readonly workspaceMarker: string;
  readonly workspaceMarkerFile: string;
}

export function persistentVmInvariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`Persistent VM contract: ${message}`);
}

/** Fresh DB evidence is checked separately from the identity retained for cleanup. */
export function persistentVmObservationContext(
  target: PersistentVmTarget,
  context: PersistentVmRunningContext,
  metadata: LiveVmMetadata,
): PersistentVmRunningContext {
  const kind = runningEvidence(target)?.kind;
  if (kind !== 'local-smolvm') return context;
  persistentVmInvariant(
    metadata.sshHost === context.sshHost &&
      metadata.sshPort === context.sshPort &&
      metadata.sshUsername === context.sshUsername,
    'live VM database SSH metadata must match current status',
  );
  return { ...context, baseImageId: metadata.baseImageId ?? '' };
}

function validateLocalRunning(
  context: PersistentVmRunningContext,
  observation: PersistentVmRunningObservation,
): void {
  persistentVmInvariant(
    observation.kind === 'local-smolvm',
    'local smolvm must return its substrate running observation',
  );
  const expectedMachine = `ac-local-${context.ref.id}-0`;
  persistentVmInvariant(
    observation.machineCount === 1,
    'Local must own exactly one machine',
  );
  persistentVmInvariant(
    observation.machineName === expectedMachine,
    `Local machine must be ${expectedMachine}`,
  );
  persistentVmInvariant(
    observation.machineState === 'running',
    'Local machine must be running',
  );
  persistentVmInvariant(
    observation.portCount === 1,
    'Local must expose exactly one port',
  );
  persistentVmInvariant(
    observation.sshGuestPort === 22,
    'Local must map only SSH port 22',
  );
  persistentVmInvariant(
    observation.sshHostPort > 0,
    'Local SSH host port must be positive',
  );
  persistentVmInvariant(
    context.cloudId === expectedMachine,
    'Local ledger cloud ID must match the smolvm machine',
  );
  persistentVmInvariant(
    context.sshHost === 'localhost',
    'Local SSH host must resolve to localhost',
  );
  persistentVmInvariant(
    observation.sshHostPort === context.sshPort,
    'Local effective SSH port must match the smolvm mapping',
  );
  persistentVmInvariant(
    context.sshUsername === 'root',
    'Local effective SSH username must be root',
  );
}

function validateAwsRunning(observation: PersistentVmRunningObservation): void {
  persistentVmInvariant(
    observation.kind === 'aws',
    'AWS must return its cluster-volume observation',
  );
  persistentVmInvariant(
    observation.rootVolumeType === 'gp3',
    'AWS root volume must use gp3',
  );
  persistentVmInvariant(
    observation.rootVolumeIops === 8_000,
    'AWS default-tier root volume must provide 8000 IOPS',
  );
  persistentVmInvariant(
    observation.rootVolumeThroughput === 1_000,
    'AWS default-tier root volume must provide 1000 MiB/s throughput',
  );
}

/**
 * Keyed on the observation rather than the target: the caller has already
 * required the observation to be the kind the target's class declares, and
 * reading a variant's own fields is what makes an unrecognised variant a
 * compile error here without a second table.
 */
export function validatePersistentVmRunningObservation(
  context: PersistentVmRunningContext,
  observation: PersistentVmRunningObservation,
): void {
  switch (observation.kind) {
    case 'aws':
      validateAwsRunning(observation);
      return;
    case 'local-smolvm':
      validateLocalRunning(context, observation);
      return;
    default:
      observation satisfies never;
      persistentVmInvariant(false, 'unrecognised running observation');
  }
}

export function validatePersistentVmTerminatedObservation(
  target: PersistentVmTarget,
  observation: PersistentVmTerminatedObservation,
): ContractQualification {
  const evidence = terminatedEvidence(target);
  if (evidence.kind === 'local-smolvm') {
    persistentVmInvariant(
      observation.kind === 'local-smolvm',
      'local smolvm must return its substrate termination observation',
    );
    persistentVmInvariant(
      observation.remainingMachineCount === 0,
      'Local termination must remove every owned smolvm machine',
    );
    return 'conclusive';
  }
  persistentVmInvariant(
    observation.kind === 'provider-api',
    `${target} must return an independent provider termination observation`,
  );
  persistentVmInvariant(
    observation.provider === evidence.provider,
    `${target} termination observation identified the wrong provider`,
  );
  persistentVmInvariant(
    observation.outcome === 'terminated' ||
      observation.outcome === 'inconclusive',
    `${target} termination observation had an invalid outcome`,
  );
  return observation.outcome === 'terminated' ? 'conclusive' : 'inconclusive';
}

export async function observePersistentVmRunning(
  dependencies: {
    readonly targets: Pick<PersistentVmTargetFactory, 'observeRunning'>;
  },
  target: PersistentVmTarget,
  context: PersistentVmRunningContext,
): Promise<void> {
  const evidence = runningEvidence(target);
  const attempt = await dependencies.targets.observeRunning(target, context);
  if (evidence) {
    persistentVmInvariant(
      attempt.kind === 'observed',
      `${target} did not return its required running observation`,
    );
    persistentVmInvariant(
      attempt.observation.kind === evidence.kind,
      `${target} returned ${attempt.observation.kind} running evidence, expected ${evidence.kind}`,
    );
    validatePersistentVmRunningObservation(context, attempt.observation);
    return;
  }
  persistentVmInvariant(
    attempt.kind === 'not-required',
    `${target} returned undeclared running evidence`,
  );
}

export async function provisionRunningPersistentVm(
  dependencies: PersistentVmRunningDependencies,
  target: PersistentVmTarget,
  workloadPrefix: string,
): Promise<ProvisionedPersistentVm> {
  const profile = dependencies.targets.profile(target);
  const policy = dependencies.policy(target);
  persistentVmInvariant(
    profile.target === target,
    'target fixture returned the wrong profile',
  );

  const workloadId = dependencies.names.workload(workloadPrefix);
  const secretName = dependencies.names.secret(workloadPrefix);
  const secretValue = `anycloud-vm-secret-${workloadId}`;
  const environmentMarker = `anycloud-vm-env-${workloadId}`;
  const workspaceMarker = `anycloud-vm-workspace-${workloadId}`;
  const workspaceMarkerFile = '.anycloud-vm-smoke-marker';
  const hostMarker = `anycloud-vm-host-${workloadId}`;
  // e2e-vm.yml sets this empty unless it runs the private GHCR image.
  const workloadImage =
    dependencies.environment.optional('VM_SMOKE_IMAGE') || 'alpine:3.20';

  await dependencies.secrets.create(secretName, {
    VM_SMOKE_SECRET_TOKEN: secretValue,
  });
  const ref = await dependencies.nativeCleanup.reserve(
    target,
    workloadId,
    policy.cleanupTimeoutMs,
  );
  await dependencies.submitPersistentVm(target, {
    environmentMarker,
    image: workloadImage,
    ref,
    secretName,
  });

  if (profile.credentialName) {
    persistentVmInvariant(
      (await dependencies.vmLedger.credentialName(ref)) ===
        profile.credentialName,
      `${profile.provider} workload did not use ${profile.credentialName}`,
    );
  }

  // RFC 0041: `wait` returns at Running, and Running means `exec` works at once.
  const ready = await dependencies.vmReadyByCli(
    ref.id,
    policy.runningTimeoutMs,
  );
  // Once `wait` saw Running, the API agrees almost at once; otherwise the
  // full budget still applies, so a CLI fault never hides a slow start.
  const runningStatus = await dependencies.kernel.waitForState(
    ref,
    WorkloadState.Running,
    ready.waitReady
      ? Math.min(120_000, policy.runningTimeoutMs)
      : policy.runningTimeoutMs,
  );
  await dependencies.nativeCleanup.capture(ref, runningStatus);
  persistentVmInvariant(
    dependencies.environment.optional('E2E_VM_FORCE_FAILURE_AFTER_RUNNING') !==
      '1',
    'forced failure after Running for native cleanup evidence',
  );
  persistentVmInvariant(
    ready.waitReady,
    'anycloud wait did not report the VM ready',
  );
  persistentVmInvariant(
    ready.execAfterWait,
    'anycloud exec failed right after anycloud wait returned',
  );
  persistentVmInvariant(
    runningStatus.workload.workloadType === 'vm',
    'workload type must be vm',
  );
  persistentVmInvariant(
    runningStatus.workload.cloudProvider === profile.provider,
    `status must report ${profile.provider}`,
  );
  persistentVmInvariant(
    runningStatus.workload.state === WorkloadState.Running,
    'workload must be running',
  );
  persistentVmInvariant(
    runningStatus.workload.dnsRecordId === null,
    'persistent VM must not have a DNS record',
  );
  const runningLedger = dependencies.vmLedger.snapshot(ref, runningStatus);
  const liveVms = dependencies.vmLedger.liveEntries(runningLedger);
  persistentVmInvariant(
    liveVms.length === 1,
    'workload must have exactly one live VM',
  );
  const activeVm = liveVms[0];
  persistentVmInvariant(activeVm, 'running workload did not expose a live VM');
  const cloudId = activeVm.cloudId ?? '';
  const liveVmMetadata = await dependencies.vmLedger.liveVmMetadata(ref);
  const baseImageId = liveVmMetadata.baseImageId ?? '';
  const sshHost = activeVm.sshHost ?? activeVm.ip;
  const sshPort = activeVm.sshPort ?? 22;
  const sshUsername = activeVm.sshUsername ?? 'root';
  persistentVmInvariant(cloudId.length > 0, 'live VM cloud ID is missing');
  persistentVmInvariant(
    String(liveVmMetadata.cloudId ?? '') === cloudId,
    'live VM metadata must identify the active VM',
  );
  persistentVmInvariant(sshHost.length > 0, 'live VM SSH host is missing');
  persistentVmInvariant(
    Number.isSafeInteger(sshPort) && sshPort > 0,
    'live VM SSH port is invalid',
  );
  persistentVmInvariant(
    sshUsername.length > 0,
    'live VM SSH username is invalid',
  );
  persistentVmInvariant(
    (await dependencies.vmLedger.liveVmCount(ref)) === 1,
    'running workload must have one live VM row',
  );

  const runningContext: PersistentVmRunningContext = {
    availabilityZone:
      activeVm.availabilityZone ?? runningStatus.workload.availabilityZone,
    baseImageId,
    cloudId,
    ref,
    region: activeVm.region ?? runningStatus.workload.region,
    sshHost,
    sshPort,
    sshUsername,
  };
  await observePersistentVmRunning(
    dependencies,
    target,
    persistentVmObservationContext(target, runningContext, liveVmMetadata),
  );

  const workload = await dependencies.vm.inspectWorkload(workloadId);
  persistentVmInvariant(
    workload.name === `/${workloadId}`,
    'workload name is incorrect',
  );
  persistentVmInvariant(workload.running, 'workload container is not running');
  persistentVmInvariant(
    workload.path === '/bin/sh' &&
      JSON.stringify(workload.args) ===
        JSON.stringify(['-c', 'while :; do sleep 3600; done']),
    'workload entrypoint and arguments are incorrect',
  );
  persistentVmInvariant(
    workload.user === '',
    'workload must use the image-default user',
  );
  persistentVmInvariant(
    workload.workingDirectory === '/workspace',
    'workload directory must be /workspace',
  );
  persistentVmInvariant(
    workload.workspaceMode === '777',
    'VM workspace mode must be 777',
  );
  persistentVmInvariant(
    /^\d+$/u.test(workload.dockerSocketGid) && workload.dockerSocketGroupAdded,
    'workload must join the numeric Docker socket group',
  );
  persistentVmInvariant(
    workload.initEnabled,
    'workload container init must be enabled',
  );
  persistentVmInvariant(
    workload.restartPolicy === 'unless-stopped',
    'workload restart policy must be unless-stopped',
  );
  persistentVmInvariant(
    workload.publishedPortCount === 0,
    'VM must publish no workload ports',
  );
  persistentVmInvariant(
    workload.writableWorkspaceMountCount === 1,
    'workload must have exactly one writable workspace mount',
  );
  persistentVmInvariant(
    workload.writableDockerSocketMountCount === 1,
    'workload must have exactly one writable Docker socket mount',
  );
  persistentVmInvariant(
    workload.runtimePathsAccessible,
    'VM runtime paths are inaccessible',
  );
  persistentVmInvariant(
    workload.managedLabel === 'true' &&
      workload.roleLabel === 'workload' &&
      workload.workloadIdLabel === workloadId,
    'workload ownership labels are incorrect',
  );

  const containerAccess = await dependencies.sshAccess.summary(
    workloadId,
    'container',
  );
  persistentVmInvariant(
    containerAccess.workloadId === workloadId &&
      containerAccess.host === sshHost &&
      (containerAccess.port ?? 22) === sshPort &&
      containerAccess.hasPrivateKey &&
      (containerAccess.username ?? 'root') === sshUsername,
    'container SSH material does not match the live VM',
  );

  const secretDigest = dependencies.sha256(secretValue);
  const fixtureObservation = await dependencies.vm.probeWorkloadFixture(
    workloadId,
    environmentMarker,
    secretDigest,
  );
  persistentVmInvariant(
    fixtureObservation.workingDirectoryMatches &&
      fixtureObservation.environmentPresent &&
      fixtureObservation.environmentMatches &&
      fixtureObservation.secretPresent &&
      fixtureObservation.secretDigestMatches,
    'workload did not preserve its environment and named secret',
  );
  persistentVmInvariant(
    (await dependencies.vm.verifyHostDocker(workloadId, hostMarker)) ===
      hostMarker,
    'host SSH did not reach a working Docker daemon',
  );

  const snapshotRejection = await dependencies.sshAccess.rejection(
    workloadId,
    'snapshot',
  );
  persistentVmInvariant(
    snapshotRejection.status === 400 &&
      snapshotRejection.code === 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
    'snapshot SSH must return HTTP 400',
  );
  persistentVmInvariant(
    snapshotRejection.message ===
      'VMs do not support snapshot SSH; use container or host access.',
    'snapshot SSH returned the wrong rejection',
  );

  await dependencies.vm.writeWorkspaceMarker(
    workloadId,
    workspaceMarkerFile,
    workspaceMarker,
  );

  return {
    environmentMarker,
    fixtureObservation,
    policy,
    profile,
    ref,
    runningContext,
    runningLedger,
    runningStatus,
    secretDigest,
    secretName,
    target,
    workload,
    workspaceMarker,
    workspaceMarkerFile,
  };
}
