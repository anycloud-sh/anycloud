/**
 * VM-host startup workflow: provision or reuse VMs, initialize them, pull the
 * image, hydrate optional storage, and start the workload until it is ready.
 * It also replays the persisted active step after a restart and resumes a Job
 * in place on a restarted VM.
 */

import { decodeWorkloadEventMetadata } from '../workload-event-metadata.js';
import type { WorkloadEventMetadataInput } from '../workload-event-metadata.js';
import type { CloudCompute } from '../gateways/cloud.js';
import {
  classifyComputeFailure,
  classifyStepFailure,
  FailureDisposition,
  type LaunchFailure,
} from '../provisioning-failure.js';
import { classifyDNSPublicationFailure } from '../dns-publication.js';
import {
  classifyLaunchFailure,
  markLaunchCredential,
} from '../launch-targets.js';
import { DockerManager } from '../docker.js';
import {
  assertVmHostContainerConfiguration,
  type StoredWorkload,
} from '../workload-record.js';
import { CloudConfig, GpuRuntime } from '../../../shared/cloud.js';
import { jobHostPrepare } from '../job-host.js';
import {
  DEPLOY_STEPS,
  WorkloadState,
  WorkloadType,
  type DeployPipelineState,
  type WorkloadTypeValue,
} from '../../../shared/workload.js';
import { ContainerState } from '../../../shared/runtime.js';
import {
  createComputeProvider,
  buildProvisioningIntent,
  resolveActiveComputeIdentity,
} from '../cloud-config.js';
import {
  gpuRuntimeForVMType,
  requiresComputeCredentials,
} from '../../../shared/cloud-config.js';
import type { DbVM, ProvisioningAttemptRef } from '../entities.js';
import { buildJobIngressSpec, buildServeIngressSpec } from '../network.js';
import { InvalidAnycloudConfigError } from '../../../shared/errors.js';
import { log } from '../logger.js';
import { publishServeEndpoint } from '../serve.js';
import type { ResolvedWorkloadStorage } from '../workload-storage.js';
import { teardownVMs } from '../host-runtime/termination.js';
import { classifyUnusableGpu } from './missing-gpu.js';
import {
  UnusableGpuError,
  waitForUsableGpus,
} from '../host-runtime/gpu-probe.js';
import {
  initializeAllVMs,
  pullImages,
  startContainers,
  writeAdoptedSecretFiles,
  waitForContainerHealth,
  waitForDockerReady,
  waitForSshReady,
} from '../host-runtime/host-startup.js';
import {
  configureAndHydrateVmStorage,
  hasVmRuntimeStorage,
  shouldPreserveVmStorageForRetry,
  shouldPreserveVmStorageOnResume,
  vmStorageHydrationTimeoutMs,
} from '../vm-runtime-storage.js';
import {
  workloadRequestsManagedHttpIngress,
  workloadRequiresRunningContainer,
} from '../../../shared/workload-behavior.js';
import type { RuntimeContainerStatus } from '../container-health.js';
import config, {
  PROVISIONING_TIMEOUT_MS,
  INITIALIZATION_TIMEOUT_MS,
  IMAGE_PULL_TIMEOUT_MS,
  CONTAINER_SETUP_TIMEOUT_MS,
} from '../../config.js';
import {
  prepareExistingVmWorkloadStorage,
  provisionVMs,
} from '../vm-provisioner.js';
import { runStep } from '../task.js';

/** The VM reads startup performs. */
interface StartupStore {
  getVMs(workloadId: string): Promise<DbVM[]>;
}
/** The auth-failed mark a successful start clears. */
interface StartupCredentials {
  clearCredentialAuthFailed(credentialId: string): Promise<void>;
}
/** The durable state transitions startup publishes. */
interface StartupLifecycle {
  updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean>;
}
/** The attempt count that gives each provisioning attempt a fresh VM index. */
interface StartupAttempts {
  countAllVMs(workloadId: string): Promise<number>;
  claimVmRemoval(workloadId: string, cloudIds: string[]): Promise<void>;
  recordLaunchFailure(
    workloadId: string,
    ref: ProvisioningAttemptRef,
    failure: LaunchFailure,
  ): Promise<void>;
}
/** The event history that shows whether a retry follows an in-place restart. */
interface StartupEvents {
  getWorkloadEvents(
    workloadId: string,
  ): Promise<Array<{ id: number; state: string; metadata: string | null }>>;
}

/** What VM-host startup receives from its composition root. */
export interface VmHostStartupDeps {
  store: StartupStore;
  lifecycle: StartupLifecycle;
  attempts: StartupAttempts;
  events: StartupEvents;
  credentials: StartupCredentials;
  /** Derive the OpenSSH public key installed on newly provisioned VMs. */
  derivePublicKey(privateKey: string): Promise<string>;
}

/** Context needed for deploy steps */
interface DeployContext {
  deps: VmHostStartupDeps;
  cloudConfig: CloudConfig;
  props: StoredWorkload;
  credentialId?: string;
  compute: CloudCompute;
  storage?: ResolvedWorkloadStorage;
  preserveVmStorage?: boolean;
  /** The ledger row of this launch, once one exists. */
  attempt?: ProvisioningAttemptRef;
  launchFailure?: LaunchFailure;
}

export interface DeployOptions {
  /** Re-enter the existing pipeline at the currently persisted step. */
  resumeFrom?: DeployPipelineState;
  /** Exact unresolved provisioning attempt to adopt instead of allocating one. */
  existingAttempt?: ProvisioningAttemptRef;
  /**
   * The persisted active step may already have side effects. Replay behavior is
   * scoped to resumeFrom; later steps still run fresh so stale containers and
   * secrets are replaced.
   */
  replayActiveStep?: boolean;
}

function shouldRunDeployStep(
  resumeFrom: DeployPipelineState,
  step: DeployPipelineState,
): boolean {
  return DEPLOY_STEPS.indexOf(step) >= DEPLOY_STEPS.indexOf(resumeFrom);
}

async function runResumableDeployStep(
  resumeFrom: DeployPipelineState,
  replayActiveStep: boolean,
  options: Parameters<typeof runStep<void>>[0] & {
    step: DeployPipelineState;
  },
): Promise<boolean> {
  if (!shouldRunDeployStep(resumeFrom, options.step)) {
    return false;
  }
  const replayThisStep = replayActiveStep && options.step === resumeFrom;
  await runStep({
    ...options,
    ...(replayThisStep
      ? {
          startMetadata: {
            ...options.startMetadata,
            reason: 'active-step-replay',
            resumeFrom,
          },
        }
      : {}),
  });
  return true;
}

function marksSuccessfulInPlaceRestart(metadata: string | null): boolean {
  return decodeWorkloadEventMetadata(metadata)?.inPlaceRestartSucceeded === 1;
}

/**
 * Deploy new VMs for a workload.
 * Handles the full lifecycle: provision → initialize → download → [sync] → start → running
 */
export async function deploy(
  deps: VmHostStartupDeps,
  cloudConfig: CloudConfig,
  props: StoredWorkload,
  selectedCredentialId?: string,
  options: DeployOptions = {},
): Promise<void> {
  assertVmHostContainerConfiguration(props);
  const resumeFrom = options.resumeFrom ?? WorkloadState.Provisioning;
  const needsComputeCredentials = requiresComputeCredentials(
    cloudConfig.cloudProvider,
  );
  const active = needsComputeCredentials
    ? selectedCredentialId
      ? await resolveActiveComputeIdentity(props, selectedCredentialId)
      : await resolveActiveComputeIdentity(props)
    : null;
  if (needsComputeCredentials && !active) {
    throw new InvalidAnycloudConfigError('Missing credentials for workload');
  }
  const compute = createComputeProvider(cloudConfig);

  const ctx: DeployContext = {
    deps,
    cloudConfig,
    props,
    credentialId: active?.credentialId,
    compute,
  };
  // resolveProvisioningConfig narrows the selected target to a scalar before
  // deploy(). Keep it with the failure event so status hints do not fall back
  // to the first item in the workload's original VM-type preference list.
  const targetVmType = Array.isArray(ctx.cloudConfig.vmType)
    ? ctx.cloudConfig.vmType[0]
    : ctx.cloudConfig.vmType;
  const provisioningIntent = buildProvisioningIntent(
    ctx.cloudConfig,
    ctx.credentialId,
  );

  // Provisioning → Retrying on error. provisionStep records an attempt before
  // provider mutation and completes that same row after cloud creation, so
  // terminateStep always has a durable cleanup target.
  const ranProvisioning = await runResumableDeployStep(
    resumeFrom,
    options.replayActiveStep === true,
    {
      id: props.id,
      step: WorkloadState.Provisioning,
      fn: () => provisionStep(ctx, options.existingAttempt),
      timeoutMs: PROVISIONING_TIMEOUT_MS,
      onErrorState: WorkloadState.Retrying,
      startMetadata: { provisioningIntent },
      classifyError: (e) => {
        const failure = classifyLaunchFailure(ctx.compute, ctx.cloudConfig, e, {
          region: props.region,
          availabilityZone: props.availabilityZone,
          // A pinned region still offers the Job's other VM types.
          otherVmTypes: Array.isArray(props.vmType) && props.vmType.length > 1,
        });
        ctx.launchFailure = failure;
        const targetMetadata = {
          ...failure.metadata,
          ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
          ...(targetVmType ? { targetVmType } : {}),
          ...(ctx.cloudConfig.region
            ? { targetRegion: ctx.cloudConfig.region }
            : {}),
          ...(ctx.cloudConfig.availabilityZone
            ? {
                targetAvailabilityZone: ctx.cloudConfig.availabilityZone,
              }
            : {}),
          targetSpot: ctx.cloudConfig.spot ?? false,
          // Recorded against the attempt, so the next claim skips its target.
          ...(ctx.attempt &&
            failure.disposition === FailureDisposition.FailoverTarget && {
              launchFailover: true,
            }),
        };
        return classifyStepFailure(
          failure.diagnosis,
          failure.disposition,
          targetMetadata,
        );
      },
      onError: async (error) => {
        if (ctx.credentialId) {
          await markLaunchCredential(
            ctx.compute,
            ctx.cloudConfig.cloudProvider,
            ctx.credentialId,
            error,
          );
        }
      },
      // The picker reads this row before the workload leaves Provisioning.
      // A failure before the attempt row exists made no provider launch.
      recordFailure: async () => {
        if (ctx.attempt && ctx.launchFailure) {
          await deps.attempts.recordLaunchFailure(
            props.id,
            ctx.attempt,
            ctx.launchFailure,
          );
        }
      },
    },
  );

  // Provisioning authenticated successfully — clear any stale auth-failed mark
  // on this credential so a recovered or re-entered secret resumes normally.
  if (ranProvisioning && ctx.credentialId) {
    await deps.credentials.clearCredentialAuthFailed(ctx.credentialId);
  }

  // Initializing → Retrying on error, cleanup VMs to prevent zombies
  await runResumableDeployStep(resumeFrom, options.replayActiveStep === true, {
    id: props.id,
    step: WorkloadState.Initializing,
    fn: () => initializeStep(ctx),
    timeoutMs: INITIALIZATION_TIMEOUT_MS,
    onErrorState: WorkloadState.Retrying,
    onSuccessState: WorkloadState.Initializing,
    classifyError: (e) => classifyComputeFailure(ctx, e),
    onError: async () => {
      // Cleanup VMs but keep NSG/VNet for retry reuse
      await teardownVMs(cloudConfig, props.id);
    },
  });

  // Downloading → Retrying on error (image pull failed)
  await runResumableDeployStep(resumeFrom, options.replayActiveStep === true, {
    id: props.id,
    step: WorkloadState.Downloading,
    fn: (eventId) => downloadStep(ctx, eventId),
    timeoutMs: IMAGE_PULL_TIMEOUT_MS,
    onErrorState: WorkloadState.Retrying,
    classifyError: (e) => classifyComputeFailure(ctx, e),
  });

  // Syncing → Retrying on error (optional step, runs before container starts)
  if (hasVmRuntimeStorage(cloudConfig)) {
    await runResumableDeployStep(
      resumeFrom,
      options.replayActiveStep === true,
      {
        id: props.id,
        step: WorkloadState.Syncing,
        fn: () => syncStep(ctx),
        // Full input hydration is data-dependent and reports its own failures.
        timeoutMs: vmStorageHydrationTimeoutMs(cloudConfig),
        onErrorState: WorkloadState.Retrying,
        classifyError: (e) => classifyComputeFailure(ctx, e),
      },
    );
  }

  // Starting → Retrying on error (infra/SSH/container crash before Running)
  await runResumableDeployStep(resumeFrom, options.replayActiveStep === true, {
    id: props.id,
    step: WorkloadState.Starting,
    fn: () => {
      const adoptExistingWorkload =
        options.replayActiveStep === true &&
        resumeFrom === WorkloadState.Starting;
      if (props.workloadType === WorkloadType.Service) {
        return startServeStep(ctx, adoptExistingWorkload);
      }
      return startStep(ctx, adoptExistingWorkload);
    },
    timeoutMs: CONTAINER_SETUP_TIMEOUT_MS,
    onErrorState: WorkloadState.Retrying,
    classifyError: (e) =>
      classifyDNSPublicationFailure(e) ?? classifyComputeFailure(ctx, e),
  });

  await deps.lifecycle.updateState(props.id, WorkloadState.Running);
}

/**
 * Resume a workload on an existing (restarted) VM, skipping provisioning.
 * Used for in-place spot instance recovery after startVM() returns a new IP.
 * Re-pulls the image (idempotent — cached layers are skipped), then runs
 * sync/start.
 */
export async function resumeOnExistingVM(
  deps: VmHostStartupDeps,
  cloudConfig: CloudConfig,
  props: StoredWorkload,
): Promise<void> {
  assertVmHostContainerConfiguration(props);
  const active = await resolveActiveComputeIdentity(props);
  if (!active) {
    throw new InvalidAnycloudConfigError('Missing credentials for workload');
  }
  const compute = createComputeProvider(cloudConfig);

  const ctx: DeployContext = {
    deps,
    cloudConfig,
    props,
    credentialId: active.credentialId,
    compute,
    preserveVmStorage: await shouldPreserveVmStorageOnResume(
      props.id,
      cloudConfig,
    ),
  };

  // Re-pull image after VM restart. Cached layers make this fast when the image
  // is already present, but this keeps the path robust across reboot quirks.
  await runStep({
    id: props.id,
    step: WorkloadState.Downloading,
    fn: async (eventId) => {
      // Cloud APIs report a restarted VM as running before sshd is necessarily
      // ready. Establish the same authenticated SSH and Docker readiness
      // guarantees as a fresh workload before attempting the resumed image
      // download. In particular, docker info must be authoritative before the
      // pull resolves a relocated Docker root.
      const vms = await deps.store.getVMs(props.id);
      await waitForSshReady(vms, props);
      await waitForDockerReady(vms, props);
      await waitForUsableGpus(vms, props, vmGpuRuntime(ctx));
      await downloadStep(ctx, eventId);
    },
    timeoutMs: IMAGE_PULL_TIMEOUT_MS,
    onErrorState: WorkloadState.Retrying,
    classifyError: (e) =>
      classifyUnusableGpu(e) ?? classifyComputeFailure(ctx, e),
    onError: async (e) => {
      if (!(e instanceof UnusableGpuError)) return;
      // Claim first, so a teardown that throws still leaves no VM to reuse.
      const vms = await deps.store.getVMs(props.id);
      await deps.attempts.claimVmRemoval(
        props.id,
        vms.map((vm) => vm.cloudId),
      );
      await teardownVMs(cloudConfig, props.id);
    },
  });

  if (hasVmRuntimeStorage(cloudConfig)) {
    await runStep({
      id: props.id,
      step: WorkloadState.Syncing,
      fn: () => syncStep(ctx),
      timeoutMs: vmStorageHydrationTimeoutMs(cloudConfig),
      onErrorState: WorkloadState.Retrying,
      classifyError: (e) => classifyComputeFailure(ctx, e),
    });
  }

  await runStep({
    id: props.id,
    step: WorkloadState.Starting,
    fn: () => startStep(ctx, true),
    timeoutMs: CONTAINER_SETUP_TIMEOUT_MS,
    onErrorState: WorkloadState.Retrying,
    classifyError: (e) => classifyComputeFailure(ctx, e),
  });

  await deps.lifecycle.updateState(props.id, WorkloadState.Running);
}

// ============================================================================
// Deploy step implementations
// ============================================================================

// The GPU runtime the base image must provide, from the RESOLVED vmType; a
// non-catalog `--gpus` type maps to 'cuda'.
function vmGpuRuntime({ cloudConfig, props }: DeployContext) {
  return (
    (typeof cloudConfig.vmType === 'string'
      ? gpuRuntimeForVMType(cloudConfig.cloudProvider, cloudConfig.vmType)
      : null) ?? (props.dockerOptions?.gpus ? GpuRuntime.Cuda : null)
  );
}

/** A CPU VM Job host: Docker 29 on a containerd that unpacks in parallel. */
function isJobHost(ctx: DeployContext): boolean {
  return (
    jobHostPrepare(ctx.props, ctx.cloudConfig, vmGpuRuntime(ctx)) !== undefined
  );
}

async function provisionStep(
  ctx: DeployContext,
  existingAttempt?: ProvisioningAttemptRef,
): Promise<void> {
  const { cloudConfig, props, compute } = ctx;
  const { id, sshPrivateKey } = props;
  const sshPublicKey = await ctx.deps.derivePublicKey(sshPrivateKey);
  const store = ctx.deps.store;
  const workloadEvents = ctx.deps.events;

  // Reuse existing VMs from a previous attempt (e.g., post-provisioning retry
  // where monitor kept VMs alive to preserve cached docker layers).
  const existingVMs = await store.getVMs(id);
  if (existingVMs.length > 0) {
    // Trust local storage writes only while retrying an in-place restart. A
    // pre-Running retry may contain only a partial remote hydrate.
    const events = await workloadEvents.getWorkloadEvents(id);
    const lastRunningEventId = events.reduce(
      (latest, event) =>
        event.state === WorkloadState.Running
          ? Math.max(latest, event.id)
          : latest,
      0,
    );
    const pendingInPlaceRestart = events.some(
      (event) =>
        event.id > lastRunningEventId &&
        event.state === WorkloadState.Recovering &&
        marksSuccessfulInPlaceRestart(event.metadata),
    );
    ctx.preserveVmStorage = shouldPreserveVmStorageForRetry(
      existingVMs,
      pendingInPlaceRestart,
    );
    log.info('Reusing existing VMs — skipping provisioning', {
      id,
      vmCount: existingVMs.length,
    });
    // The next workload event is the completion cursor. Until it exists,
    // replay the same idempotent storage setup as fresh/adopted
    // provisioning.
    const storage = await prepareExistingVmWorkloadStorage(cloudConfig, id, {
      // Resource tags carry the version of the software doing the setup.
      version: config.currVersion,
      userId: props.userId,
    });
    ctx.cloudConfig = storage.cloudConfig;
    ctx.storage = storage;
    return;
  }

  // Use the total count of VMs ever created (including terminated) as the startIndex.
  // This ensures each provisioning attempt uses a unique vmId/ClientToken, avoiding
  // AWS IdempotentParameterMismatch when retrying after a terminated instance.
  const attempts = ctx.deps.attempts;
  const vmsCreated = await attempts.countAllVMs(id);

  const result = await provisionVMs(compute, {
    cloudConfig,
    workloadId: id,
    sshKeys: { publicKey: sshPublicKey, privateKey: sshPrivateKey },
    ipWhitelist: [],
    gpuRuntime: vmGpuRuntime(ctx),
    version: config.currVersion,
    startIndex: vmsCreated,
    userId: props.userId,
    credentialId: ctx.credentialId,
    existingAttempt,
    onAttempt: (ref) => {
      ctx.attempt = ref;
    },
    ingressSpec: workloadRequestsManagedHttpIngress(props.workloadType)
      ? buildServeIngressSpec()
      : // A VM Job's VM refuses its network's peers; a dev box's doesn't.
        buildJobIngressSpec([], props.workloadType === WorkloadType.Job),
    jobHost: jobHostPrepare(props, cloudConfig, vmGpuRuntime(ctx)),
  });
  ctx.cloudConfig = result.storage.cloudConfig;
  ctx.storage = result.storage;
}

async function initializeStep(ctx: DeployContext): Promise<void> {
  const { props } = ctx;
  const vms = await ctx.deps.store.getVMs(props.id);

  await waitForSshReady(vms, props);

  // Initialize all VMs, including container and transfer tooling.
  // This is idempotent — safe to re-run on reused VMs from a previous attempt.
  await initializeAllVMs(vms, props, vmGpuRuntime(ctx), isJobHost(ctx));

  await waitForDockerReady(vms, props);
}

async function downloadStep(
  ctx: DeployContext,
  eventId: number,
): Promise<void> {
  const { props } = ctx;
  const vms = await ctx.deps.store.getVMs(props.id);
  const transfer = vmGpuRuntime(ctx) !== null || isJobHost(ctx);
  await pullImages(vms, props, transfer, eventId);
}

async function startStep(
  ctx: DeployContext,
  adoptExistingWorkload = false,
): Promise<void> {
  const { cloudConfig, props } = ctx;
  const vms = await ctx.deps.store.getVMs(props.id);
  if (!adoptExistingWorkload) {
    await startContainers(vms, props, cloudConfig);
    await waitForContainerHealth(vms, props);
    return;
  }

  const statuses = await Promise.all(
    vms.map(async (vm) => ({
      vm,
      status: await new DockerManager(
        vm.sshHost ?? vm.ip,
        props.sshPrivateKey!,
        vm.sshPort,
      ).getContainerStatus(props.id),
    })),
  );
  const vmsToStart = statuses
    .filter(({ status }) =>
      shouldStartWorkloadContainer(status, props.workloadType),
    )
    .map(({ vm }) => vm);
  log.info('Reconciled workload container presence', {
    id: props.id,
    adopted: vms.length - vmsToStart.length,
    createOrRecreate: vmsToStart.length,
  });
  await writeAdoptedSecretFiles(
    vms.filter((vm) => !vmsToStart.includes(vm)),
    props,
    cloudConfig,
  );
  await startContainers(vmsToStart, props, cloudConfig);
  await waitForContainerHealth(vms, props);
}

function shouldStartWorkloadContainer(
  status: RuntimeContainerStatus,
  workloadType: WorkloadTypeValue,
): boolean {
  switch (status.state) {
    case ContainerState.Running:
      return false;
    case ContainerState.Exited:
      // A fast, successful Job may complete before the API records Running.
      // Re-running it would duplicate user work; startup health recognizes it
      // as ready and the completion monitor will persist Completed.
      return !(workloadType === WorkloadType.Job && status.exitCode === 0);
    case ContainerState.Restarting:
      // A Job may still settle into Running. Long-running workloads that
      // restart during startup are unhealthy and use the fresh retry path.
      return workloadRequiresRunningContainer(workloadType);
    case ContainerState.NotFound:
    case ContainerState.Created:
    case ContainerState.Paused:
    case ContainerState.Dead:
      return true;
    default:
      status.state satisfies never;
      return true;
  }
}

async function startServeStep(
  ctx: DeployContext,
  adoptExistingWorkload = false,
): Promise<void> {
  await startStep(ctx, adoptExistingWorkload);
  // Substrates without public endpoints (per the compute capability) get no
  // DNS record. With none published, dnsRecordId stays null, which is what
  // the URL surfaces and the DNS cleanup path key off.
  if (ctx.compute.publishesPublicEndpoint?.() === false) return;
  await publishServeEndpoint(ctx.props.id, ctx.props.githubToken);
}

async function syncStep(ctx: DeployContext): Promise<void> {
  const { props } = ctx;
  const vms = await ctx.deps.store.getVMs(props.id);
  const storage = await configureAndHydrateVmStorage({
    cloudConfig: ctx.cloudConfig,
    workload: props,
    vms,
    storage: ctx.storage,
    preserveLocalData: ctx.preserveVmStorage,
  });
  ctx.cloudConfig = storage.cloudConfig;
  ctx.storage = storage;
}
