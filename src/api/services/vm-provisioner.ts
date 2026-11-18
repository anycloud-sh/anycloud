import { CloudCompute } from './gateways/cloud.js';
import { CloudConfig } from '../../shared/cloud.js';
import { WorkloadState } from '../../shared/workload.js';
import type { GpuRuntime } from '../../shared/cloud.js';
import {
  CloudVM,
  type AddVMAttempt,
  type GatewayVM,
  type IngressSpec,
  type NewVMsProps,
  type ProvisioningAttemptRef,
} from './entities.js';
import { log } from './logger.js';
import { PartialVMCreationError, VMCreationError } from './codes.js';
import { getProvisioningAttemptStore } from './persistence.js';
import { resolveWorkloadPrice } from '../../shared/catalog/index.js';
import {
  DeployError,
  ResourceOwnershipError,
  ResourceStateIndeterminateError,
} from '../../shared/errors.js';
import { buildJobIngressSpec, hasNonSshIngress } from './network.js';
import { bucketHostPathsForProvider } from '../../shared/providers.js';
import { StateConflictError } from './task.js';
import { generateStartupScript, type SSHKeys } from './vm-startup-script.js';
import { generateJobHostUserData, type JobHost } from './job-host.js';
import {
  ensureWorkloadOutputStorage,
  ensureManagedWorkloadCheckpoint,
  resolveWorkloadStorage,
  validateExistingWorkloadStorage,
  type WorkloadStorageMetadata,
  type WorkloadStorageProviderFactories,
  type ResolvedWorkloadStorage,
} from './workload-storage.js';

export interface ProvisionParams {
  cloudConfig: CloudConfig;
  workloadId: string;
  sshKeys: SSHKeys;
  ipWhitelist: string[];
  gpuRuntime?: GpuRuntime | null;
  version: string;
  startIndex?: number; // Starting index for VM naming (for upgrades)
  userId: string;
  credentialId?: string;
  ingressSpec?: IngressSpec;
  /**
   * A CPU VM Job host on AWS, GCP or Azure: Ubuntu minimal, prepared by its
   * user data, which also pulls `prePullImage` (a public image) while the API
   * waits for SSH.
   */
  jobHost?: JobHost;
  /**
   * Exact durable attempt selected by the caller for adoption. Omitting this
   * always allocates a fresh attempt.
   */
  existingAttempt?: ProvisioningAttemptRef;
  /** Receives the attempt's ledger row once it exists. */
  onAttempt?: (ref: ProvisioningAttemptRef) => void;
}

export interface ProvisionResult {
  vms: CloudVM[];
  storage: ResolvedWorkloadStorage;
}

/** The attempt-ledger writes that bracket each provider launch. */
interface VmProvisioningAttempts {
  beginProvisioningAttempt(
    workloadId: string,
    cloudId: string,
    attempt?: AddVMAttempt,
  ): Promise<ProvisioningAttemptRef | null>;
  completeProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
    vm: GatewayVM,
  ): Promise<ProvisioningAttemptRef>;
  retargetProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
    cloudId: string,
  ): Promise<ProvisioningAttemptRef>;
  endProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
  ): Promise<void>;
}

/**
 * Provision VMs with bucket and firewall setup.
 * Returns immutable VM objects with all properties set.
 *
 * Failed attempts remain in the durable VM ledger. Retry and terminal
 * reconciliation own cleanup so every provider deletion follows the same
 * removal-request stamping and retry path.
 */
export async function provisionVMs(
  compute: CloudCompute,
  params: ProvisionParams,
  storageProviders?: WorkloadStorageProviderFactories,
): Promise<ProvisionResult> {
  const {
    cloudConfig,
    workloadId,
    sshKeys,
    ipWhitelist,
    gpuRuntime,
    version,
    startIndex,
    userId,
    credentialId,
    ingressSpec = buildJobIngressSpec(ipWhitelist),
    existingAttempt,
    onAttempt,
    jobHost,
  } = params;
  const attempts: VmProvisioningAttempts = getProvisioningAttemptStore();
  let vms: CloudVM[] | undefined;
  let attemptRef: ProvisioningAttemptRef | undefined = existingAttempt;
  if (attemptRef) onAttempt?.(attemptRef);
  let attemptCompleted = false;
  let storage: ResolvedWorkloadStorage | undefined;

  try {
    const plannedCloudId =
      existingAttempt?.cloudId ?? `${workloadId}-${startIndex ?? 0}`;
    const attempt = {
      region: cloudConfig.region,
      vmType: cloudConfig.vmType,
      credentialId,
      availabilityZone: cloudConfig.availabilityZone,
      pricePerHour: resolveWorkloadPrice(
        cloudConfig.cloudProvider,
        cloudConfig.vmType,
        cloudConfig.region,
        !!cloudConfig.spot,
      ),
      bucketHostPaths: bucketHostPathsForProvider(cloudConfig.cloudProvider),
    };

    // A persisted unresolved row means the previous process may already have
    // mutated the provider. Inspect that identity before bucket, token, network,
    // or gateway setup can fail and incorrectly route the attempt through
    // placeholder cleanup. Null is authoritative absence; an inconclusive read
    // throws ResourceStateIndeterminateError and preserves the active row.
    if (existingAttempt && compute.adoptProvisioningAttempt) {
      const adopted = await compute.adoptProvisioningAttempt({
        workloadId,
        vmId: plannedCloudId,
        userId,
      });
      if (adopted) {
        vms = [adopted];
      }
    }

    // An unresolved provider identity must be inspected before any fallible
    // storage discovery or validation. The storage plan is operation-local and
    // can be reconstructed after a restart.
    storage = await resolveWorkloadStorage(
      cloudConfig,
      workloadId,
      undefined,
      storageProviders,
    );
    if (!compute.prepareNetwork && hasNonSshIngress(ingressSpec)) {
      throw new DeployError(
        `${compute.type} does not support the requested ingress rules`,
        400,
      );
    }

    // Read-only validation precedes fresh attempt admission. Adopted attempts
    // were already durable before this process resumed.
    await validateExistingWorkloadStorage(storage);

    if (!vms) {
      // Generate locally before recording a fresh attempt. Invalid keys cannot
      // leave provider resources and should not consume a VM name/index.
      const startupScript = jobHost
        ? generateJobHostUserData(sshKeys, jobHost)
        : generateStartupScript(sshKeys);

      // From this point onward every provider mutation has a durable cleanup
      // owner. The synthetic ID is the exact VM name/client token passed below.
      if (!attemptRef) {
        const registered = await attempts.beginProvisioningAttempt(
          workloadId,
          plannedCloudId,
          attempt,
        );
        if (!registered) {
          throw new StateConflictError(workloadId, WorkloadState.Provisioning);
        }
        attemptRef = registered;
        onAttempt?.(registered);
      }

      // Output mutation happens only after a durable attempt owns cleanup.
      await ensureWorkloadOutputStorage(storage, { version, userId });

      // 3. Prepare networking. A crash here is recoverable through attemptRef.
      let network;
      if (compute.prepareNetwork) {
        network = await compute.prepareNetwork(
          ingressSpec,
          workloadId,
          version,
          userId,
        );
      } else {
        await compute.upsertFirewall(ipWhitelist, workloadId, version, userId);
      }

      // 4. Create the VM. The gateway repeats its identity lookup immediately
      // before create, closing the race after an earlier authoritative absence.
      vms = await createVMs(
        compute,
        {
          workloadId,
          ipWhitelist,
          startupScript,
          gpuRuntime,
          version,
          startIndex,
          userId,
          adoptExistingAttempt: !!existingAttempt,
          network,
          ingressSpec,
          ...(jobHost && { jobHost: true }),
        },
        plannedCloudId,
      );
    }

    // Persist provider facts before any later operation can fail. There is no
    // insert-after-launch window: the existing attempt row becomes the VM row.
    const vm = vms[0];
    if (!vm) {
      throw new Error(`Workload ${workloadId}: provider returned no VM`);
    }
    if (!attemptRef) {
      throw new Error(
        `Workload ${workloadId}: provisioning attempt was not registered`,
      );
    }
    attemptRef = await attempts.completeProvisioningAttempt(
      workloadId,
      attemptRef,
      vm,
    );
    attemptCompleted = true;
  } catch (error: any) {
    // Observation failed while a provider resource may already exist. Preserve
    // the exact unresolved attempt; retrying or cleaning by its synthetic ID
    // could strand the real resource and permit a duplicate launch.
    if (error instanceof ResourceStateIndeterminateError) throw error;

    // Preserve provider identities even on total failure. Azure (and other
    // providers) may create partial resources (NIC, IP, disk) before the VM
    // itself fails (e.g. OverconstrainedAllocationRequest). The reconciler
    // needs the identity to remove those resources before retrying.
    const partialVMs =
      error instanceof PartialVMCreationError ? error.partialVMs : undefined;
    const createdVMs = vms || partialVMs;

    // Use known VM objects if available, otherwise use the attempted vmIds
    // from VMCreationError. This keeps an Azure Failed VM addressable even
    // when no VM completed provisioning.
    const providerIds = createdVMs
      ? createdVMs.map((vm) => vm.cloudId)
      : error instanceof VMCreationError
        ? error.attemptedVmIds
        : [];

    // An ownership conflict proves the deterministic provider identity is not
    // ours. Retire the ledger row without issuing a destructive delete.
    if (
      error instanceof ResourceOwnershipError &&
      attemptRef &&
      !attemptCompleted &&
      providerIds.length === 0
    ) {
      await attempts.endProvisioningAttempt(workloadId, attemptRef);
    }

    // A gateway may replace our synthetic name with a real provider ID before
    // failing a later readiness check. Retarget the already-durable row rather
    // than inserting a second, post-failure placeholder. If cleanup raced and
    // ended the synthetic row, retargeting reopens it for the reconciler.
    if (
      attemptRef &&
      !attemptCompleted &&
      providerIds.length > 0 &&
      providerIds[0] !== attemptRef.cloudId
    ) {
      attemptRef = await attempts.retargetProvisioningAttempt(
        workloadId,
        attemptRef,
        providerIds[0],
      );
    }

    // Retry and terminal reconciliation consume this durable attempt and own
    // provider cleanup. Keeping the firewall until then preserves stable
    // parameters across retries (avoiding IdempotentParameterMismatch).
    throw error;
  }

  if (!vms || !storage) {
    throw new Error(`Workload ${workloadId}: provisioning produced no result`);
  }

  // This postamble intentionally sits outside the provisioning catch. A
  // checkpoint failure after the attempt is complete must leave the VM durable
  // for idempotent replay instead of tearing it down as a launch failure.
  await ensureManagedWorkloadCheckpoint(storage, { version, userId });
  return { vms, storage };
}

/** Replay the managed-checkpoint postamble for an already durable VM. */
export async function prepareExistingVmWorkloadStorage(
  cloudConfig: CloudConfig,
  workloadId: string,
  metadata: WorkloadStorageMetadata,
  storageProviders?: WorkloadStorageProviderFactories,
): Promise<ResolvedWorkloadStorage> {
  const storage = await resolveWorkloadStorage(
    cloudConfig,
    workloadId,
    undefined,
    storageProviders,
  );
  await ensureManagedWorkloadCheckpoint(storage, metadata);
  return storage;
}

/**
 * Create a VM. Errors preserve enough identity for reconciler-owned cleanup.
 */
async function createVMs(
  cloud: CloudCompute,
  params: NewVMsProps,
  vmId: string,
): Promise<CloudVM[]> {
  const { workloadId } = params;
  // One VM per workload. Fresh attempts still advance their vmId across
  // retries; recovery passes an explicitly selected ledger identity here.
  const vmIds = [vmId];

  log.info('Creating VM', {
    id: workloadId,
    vmId,
    vmType: cloud.vmType,
    cloud: cloud.type,
    region: cloud.region,
    gpuRuntime: params.gpuRuntime,
  });
  const promises: Promise<CloudVM>[] = [cloud.newVM({ ...params, vmId })];

  const results = await Promise.allSettled(promises);

  // Separate successful and failed VMs
  const successful = results
    .filter(
      (r): r is PromiseFulfilledResult<CloudVM> => r.status === 'fulfilled',
    )
    .map((r) => r.value);

  const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);

  // If any failures, throw error with partial VMs if applicable
  // Don't log here - persistence will log when error is caught by runStep
  if (failed.length > 0) {
    const error = failed[0];

    if (successful.length > 0) {
      log.warn('Partial VM creation - some succeeded before failure', {
        id: workloadId,
        successfulCount: successful.length,
        totalAttempted: results.length,
      });
      throw new PartialVMCreationError(error, successful);
    }

    // A gateway may have received a real provider ID before failing a later
    // readiness step. Preserve that identity instead of replacing it with the
    // synthetic workload vmId below; provisionVMs will persist it for the
    // reconciler.
    if (error instanceof VMCreationError) throw error;
    if (error instanceof ResourceOwnershipError) throw error;
    if (error instanceof ResourceStateIndeterminateError) throw error;

    // Wrap with the attempted vmId so reconciliation can clean up Azure
    // resources even when no VM succeeded (for example, an allocation error
    // can leave a Failed VM resource that blocks future retries).
    throw new VMCreationError(error, vmIds);
  }

  return successful;
}
