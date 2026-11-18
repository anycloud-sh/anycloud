import type { ScopedStorageToken } from './gateways/cloud.js';
import type { DockerBucketMounts } from './docker.js';
import { DockerManager } from './docker.js';
import {
  canMintScopedStorageToken,
  type CloudStorage,
  VMReleaseState,
} from './gateways/cloud.js';
import { createTransport } from './gateways/transport.js';
import { loadWorkloadVmCompute } from './vm-compute.js';
import {
  resolveWorkloadStorage,
  type ResolvedWorkloadStorage,
} from './workload-storage.js';
import { getWorkloadEventStore, getWorkloadQueryStore } from './persistence.js';
import type { DbVM } from './entities.js';
import { log } from './logger.js';
import { SupervisorManager, type BucketConfigs } from './supervisor.js';
import { FINAL_SYNC_TIMEOUT_MS, RCLONE_INIT_TIMEOUT_MS } from '../config.js';
import {
  hasCheckpointTarget,
  resolveCheckpointTarget,
} from '../../shared/checkpoint.js';
import { DeployError } from '../../shared/errors.js';
import { PermissionDeniedError } from '../../shared/permission-denied.js';
import { extractErrorLines } from '../../shared/utils.js';
import {
  DEFAULT_BUCKET_HOST_PATHS,
  usesManagedBucketHostRoot,
  type BucketHostPaths,
} from '../../shared/providers.js';
import { type StoredWorkload } from './workload-record.js';
import {
  type CloudConfig,
  type CloudCredentials,
  type CloudType,
} from '../../shared/cloud.js';
import { WorkloadType } from '../../shared/workload.js';
import { ServiceState } from '../../shared/runtime.js';

export interface ConfigureVmStorageOptions {
  cloudConfig: CloudConfig;
  workload: StoredWorkload;
  vms: DbVM[];
  storage?: ResolvedWorkloadStorage;
  preserveLocalData?: boolean;
}

/** Whether a VM runtime has any storage transport work. */
export function hasVmRuntimeStorage(cloudConfig: CloudConfig): boolean {
  return !!(
    cloudConfig.inputBucket ||
    cloudConfig.outputBucket ||
    hasCheckpointTarget(cloudConfig)
  );
}

/** Input hydration is data-dependent; service-only setup keeps its deadline. */
export function vmStorageHydrationTimeoutMs(
  cloudConfig: CloudConfig,
): number | null {
  return cloudConfig.inputBucket ? null : RCLONE_INIT_TIMEOUT_MS;
}

function bucketHostPathsForVm(vm: DbVM): BucketHostPaths {
  return {
    input: vm.inputHostPath,
    output: vm.outputHostPath,
    checkpoint: vm.checkpointHostPath,
  };
}

function hasManagedBucketHostPaths(vm: DbVM): boolean {
  return (
    vm.inputHostPath !== DEFAULT_BUCKET_HOST_PATHS.input ||
    vm.outputHostPath !== DEFAULT_BUCKET_HOST_PATHS.output ||
    vm.checkpointHostPath !== DEFAULT_BUCKET_HOST_PATHS.checkpoint
  );
}

/** Preserve a retry's local data only for the generation that ran in place. */
export function shouldPreserveVmStorageForRetry(
  vms: DbVM[],
  pendingInPlaceRestart: boolean,
): boolean {
  return pendingInPlaceRestart && vms.some(hasManagedBucketHostPaths);
}

/** Decide whether a restarted VM's local storage remains authoritative. */
export async function shouldPreserveVmStorageOnResume(
  id: string,
  cloudConfig: CloudConfig,
): Promise<boolean> {
  const vms = await getWorkloadQueryStore().getVMs(id);
  // On providers whose default /mnt is ephemeral (for example Azure temporary
  // storage), legacy rows still on /mnt must hydrate again after deallocation.
  if (
    usesManagedBucketHostRoot(cloudConfig.cloudProvider) &&
    !vms.some(hasManagedBucketHostPaths)
  ) {
    return false;
  }
  return true;
}

/**
 * Whether a role syncs with a minted, bucket-scoped token: always for explicit
 * storage credentials, and otherwise whenever its storage can mint (RFC 0047:
 * no VM gets a storage identity). A long-lived credential is never written to
 * the VM.
 */
function syncsWithMintedToken(
  cloudConfig: CloudConfig,
  role: 'input' | 'output' | 'checkpoint',
  provider?: CloudStorage,
): boolean {
  const explicit = {
    input: cloudConfig.inputStorageCredentials,
    output: cloudConfig.outputStorageCredentials,
    checkpoint: cloudConfig.checkpointStorageCredentials,
  }[role];
  return Boolean(explicit) || !provider || canMintScopedStorageToken(provider);
}

async function bucketConfigForRole(
  storage: ResolvedWorkloadStorage,
  role: 'input' | 'output' | 'checkpoint',
): Promise<NonNullable<BucketConfigs[typeof role]> | undefined> {
  const target = storage.targets[role];
  if (!target) return undefined;
  const token = syncsWithMintedToken(storage.cloudConfig, role, target.provider)
    ? await mintBucketSyncCred(target.provider, target.name, target.mode).catch(
        (error: unknown) => {
          // The bucket's own credential was denied, not the compute one.
          if (
            error instanceof PermissionDeniedError &&
            storage.cloudConfig[`${role}StorageCredentials`]
          )
            error.credential = `the ${role} bucket's storage credential`;
          throw error;
        },
      )
    : undefined;
  return {
    name: target.name,
    cloudType: target.provider.type,
    region: target.provider.region,
    storageAccountName: target.provider.storageAccountName,
    endpoint: target.provider.s3Endpoint,
    credentials: token?.credentials,
    credentialExpiresAt: token?.expiresAt,
  };
}

async function mintBucketSyncCred(
  storage: CloudStorage,
  bucket: string,
  mode: 'read' | 'readwrite',
): Promise<ScopedStorageToken | undefined> {
  if (!canMintScopedStorageToken(storage)) {
    throw new DeployError(
      `Cross-cloud storage requires credentials that can mint scoped bucket-sync tokens (got ${storage.type}). ` +
        `Use a same-cloud bucket or storage credentials that can mint scoped bucket-sync tokens.`,
      400,
    );
  }
  return storage.mintScopedStorageToken([{ bucket, mode }]);
}

/** Minted tokens are renewed this long before their own expiry. */
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;
const RENEWAL_RETRY_MS = 60_000;

/**
 * When to renew the minted tokens in `buckets`: the earliest expiry less five
 * minutes, -Infinity when a minted token has no expiry, or undefined when no
 * bucket holds a minted token.
 */
export function renewAt(buckets: BucketConfigs): number | undefined {
  const minted = Object.values(buckets).filter((bucket) => bucket?.credentials);
  if (minted.length === 0) return undefined;
  return (
    Math.min(
      ...minted.map((bucket) => bucket?.credentialExpiresAt ?? -Infinity),
    ) - RENEW_BEFORE_EXPIRY_MS
  );
}

/**
 * Keep every minted token fresh while hydration runs. The input sync and the
 * checkpoint restore run inside the deploy step, where the background renewer
 * defers, and can outlive a GCP token's hour. Returns the function that stops
 * renewing and waits for a renewal in flight, so no token write outlives
 * hydration.
 */
function renewWhileHydrating(
  storage: ResolvedWorkloadStorage,
  buckets: BucketConfigs,
  supervisors: SupervisorManager[],
  workloadId: string,
): () => Promise<void> {
  const current = { ...buckets };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const schedule = (delayMs?: number) => {
    const at = renewAt(current);
    if (stopped || at === undefined) return;
    timer = setTimeout(
      () => (inFlight = renew()),
      delayMs ?? Math.max(0, at - Date.now()),
    );
  };
  const renew = async () => {
    try {
      for (const role of ['input', 'output', 'checkpoint'] as const) {
        if (!current[role]?.credentials) continue;
        const config = await bucketConfigForRole(storage, role);
        if (config) current[role] = config;
      }
      if (stopped) return;
      await Promise.all(
        supervisors.map((supervisor) =>
          supervisor.refreshRcloneCredentials(current),
        ),
      );
      schedule();
    } catch (error) {
      log.warn('Renewing bucket tokens during hydration failed', {
        id: workloadId,
        error,
      });
      schedule(RENEWAL_RETRY_MS);
    }
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    return inFlight;
  };
}

/** Resolve, configure, and hydrate storage for VM-hosted runtimes. */
export async function configureAndHydrateVmStorage(
  options: ConfigureVmStorageOptions,
): Promise<ResolvedWorkloadStorage> {
  const { workload, vms } = options;
  const storage =
    options.storage ??
    (await resolveWorkloadStorage(options.cloudConfig, workload.id));
  const buckets: BucketConfigs = {};

  for (const role of ['input', 'output', 'checkpoint'] as const) {
    const config = await bucketConfigForRole(storage, role);
    if (config) buckets[role] = config;
  }

  const supervisors = vms.map(
    (vm) =>
      new SupervisorManager(
        createTransport(
          vm.sshHost ?? vm.ip,
          workload.sshPrivateKey!,
          vm.sshPort,
        ),
      ),
  );
  const stopRenewal = renewWhileHydrating(
    storage,
    buckets,
    supervisors,
    workload.id,
  );
  try {
    await Promise.all(
      vms.map((vm, index) =>
        supervisors[index]!.initRclone(buckets, workload.id, vm.ip, {
          preserveLocalBuckets: options.preserveLocalData,
          bucketHostPaths: bucketHostPathsForVm(vm),
        }),
      ),
    );
  } finally {
    await stopRenewal();
  }

  return storage;
}

/** Reconstruct VM container mounts without requiring provider access. */
export function mountsForVmStorage(
  cloudConfig: CloudConfig,
  workloadId: string,
  vm: DbVM,
): DockerBucketMounts {
  const paths = bucketHostPathsForVm(vm);
  return {
    input: cloudConfig.inputBucket ? paths.input : undefined,
    output: cloudConfig.outputBucket ? paths.output : undefined,
    checkpoint: resolveCheckpointTarget(workloadId, cloudConfig)
      ? paths.checkpoint
      : undefined,
  };
}

/** Only VM hosts use Finalizing. */
export function needsVmHostFinalSync(
  id: string,
  cloudConfig: CloudConfig,
): boolean {
  return !!(
    cloudConfig.outputBucket || resolveCheckpointTarget(id, cloudConfig)
  );
}

/** Select the storage cloud for a VM-host rclone destination. */
export function resolveFinalSyncCloud(
  storageCreds: CloudCredentials | undefined,
  computeProvider: CloudType,
): CloudType {
  return storageCreds?.cloudProvider ?? computeProvider;
}

/** Freshly minted tokens for the upload roles whose sync uses one. */
export async function mintedUploadBuckets(
  cloudConfig: CloudConfig,
  workloadId: string,
  roles: readonly ('output' | 'checkpoint')[] = ['output', 'checkpoint'],
): Promise<Pick<BucketConfigs, 'output' | 'checkpoint'>> {
  const minted = roles.filter((role) =>
    syncsWithMintedToken(cloudConfig, role),
  );
  const buckets: Pick<BucketConfigs, 'output' | 'checkpoint'> = {};
  if (minted.length === 0) return buckets;
  const storage = await resolveWorkloadStorage(cloudConfig, workloadId, minted);
  for (const role of minted) {
    const config = await bucketConfigForRole(storage, role);
    if (config?.credentials) buckets[role] = config;
  }
  return buckets;
}

async function refreshFinalSyncCredentials(
  supervisor: SupervisorManager,
  cloudConfig: CloudConfig,
  workloadId: string,
  roles: readonly ('output' | 'checkpoint')[],
): Promise<void> {
  const buckets = await mintedUploadBuckets(cloudConfig, workloadId, roles);
  if (Object.keys(buckets).length === 0) return;
  await supervisor.refreshRcloneCredentials(buckets);
}

/** Flush output and checkpoint artifacts before a VM-hosted Job is deleted. */
export async function syncFinalVmJobArtifacts(
  id: string,
  sshPrivateKey: string,
  cloudConfig: CloudConfig,
  vm: DbVM,
): Promise<void> {
  const checkpoint = resolveCheckpointTarget(id, cloudConfig);
  const supervisor = new SupervisorManager(
    createTransport(vm.sshHost ?? vm.ip, sshPrivateKey, vm.sshPort),
  );

  await refreshFinalSyncCredentials(supervisor, cloudConfig, id, [
    'output',
    'checkpoint',
  ]);

  if (cloudConfig.outputBucket) {
    await supervisor.runFinalOutputSync(
      cloudConfig.outputBucket,
      resolveFinalSyncCloud(
        cloudConfig.outputStorageCredentials,
        cloudConfig.cloudProvider,
      ),
      id,
      vm.ip,
      FINAL_SYNC_TIMEOUT_MS,
      vm.outputHostPath,
    );
  }
  if (checkpoint) {
    await supervisor.runFinalCheckpointSync(
      checkpoint.name,
      resolveFinalSyncCloud(
        cloudConfig.checkpointStorageCredentials,
        cloudConfig.cloudProvider,
      ),
      id,
      vm.ip,
      FINAL_SYNC_TIMEOUT_MS,
      vm.checkpointHostPath,
    );
  }
}

/** Capture VM storage transport failures for durable terminal diagnostics. */
export async function captureVmStorageDiagnostics(
  vm: Pick<DbVM, 'ip' | 'sshHost' | 'sshPort'>,
  sshPrivateKey: string,
  id: string,
): Promise<string | undefined> {
  try {
    const supervisor = new SupervisorManager(
      createTransport(vm.sshHost ?? vm.ip, sshPrivateKey, vm.sshPort),
    );
    const statusByRole = await supervisor.getRcloneStatus(true);
    const syncLines: string[] = [];
    for (const [role, status] of Object.entries(statusByRole)) {
      if (!status) continue;
      // structuredOnly: rclone tags every real failure ERROR/FATAL; the
      // unstructured keyword net turned benign journald lines ("Failed to
      // kill control group …") into false sync errors on healthy services.
      const errorLines = extractErrorLines(status.logs ?? '', {
        structuredOnly: true,
      });
      if (status.status !== ServiceState.Running || errorLines.length > 0) {
        syncLines.push(`${role}-sync: ${status.status}`);
        syncLines.push(...errorLines.map((line) => `  ${line}`));
      }
    }
    return syncLines.length > 0 ? syncLines.join('\n') : undefined;
  } catch (error) {
    log.warn('Failed to capture VM storage diagnostics', { id, error });
    return undefined;
  }
}

/** The event ids that show which VM generation owns the checkpoint. */
interface CheckpointGenerationEvents {
  getLatestRunningAndProvisioningEventIds(workloadId: string): Promise<{
    latestRunningEventId: number;
    latestProvisioningEventId: number;
  }>;
}

/**
 * Freeze a running Service's checkpoint writer and flush its last generation.
 * A partially hydrated replacement never overwrites the last good checkpoint.
 */
export async function quiesceVmServiceStorage(
  cloudConfig: CloudConfig,
  id: string,
  workloadSnapshot?: StoredWorkload,
): Promise<void> {
  const checkpoint = resolveCheckpointTarget(id, cloudConfig);
  if (!checkpoint) return;

  const store = getWorkloadQueryStore();
  const events: CheckpointGenerationEvents = getWorkloadEventStore();
  const [workload, vms, eventIds] = await Promise.all([
    workloadSnapshot ?? store.getWorkload(id),
    store.getVMs(id),
    events.getLatestRunningAndProvisioningEventIds(id),
  ]);
  if (!workload || workload.workloadType !== WorkloadType.Service) {
    return;
  }
  if (vms.length > 1) {
    throw new Error(
      `Refusing to checkpoint Service ${id}: expected at most one live VM, found ${vms.length}`,
    );
  }

  // Do not upload a partially-hydrated replacement VM over the last known-good
  // checkpoint. Only a generation that actually reached Running owns a final
  // flush; an upgrade's Recovering event still belongs to that generation.
  const { latestRunningEventId, latestProvisioningEventId } = eventIds;
  if (
    latestRunningEventId === 0 ||
    latestRunningEventId < latestProvisioningEventId
  ) {
    return;
  }

  await Promise.all(
    vms.map(async (vm) => {
      try {
        const sshHost = vm.sshHost ?? vm.ip;
        const docker = new DockerManager(
          sshHost,
          workload.sshPrivateKey,
          vm.sshPort,
        );
        const supervisor = new SupervisorManager(
          createTransport(sshHost, workload.sshPrivateKey, vm.sshPort),
        );
        await docker.stopContainerGracefully(id);
        await supervisor.stopRcloneServices();
        await refreshFinalSyncCredentials(supervisor, cloudConfig, id, [
          'checkpoint',
        ]);
        await supervisor.runFinalCheckpointSync(
          checkpoint.name,
          resolveFinalSyncCloud(
            cloudConfig.checkpointStorageCredentials,
            cloudConfig.cloudProvider,
          ),
          id,
          vm.ip,
          FINAL_SYNC_TIMEOUT_MS,
          vm.checkpointHostPath,
        );
      } catch (error) {
        // If the provider authoritatively says the VM is already gone, there is
        // nothing left to flush; the periodic checkpoint is the recovery point.
        // Alive or unknown VMs stay pending so a transient SSH/storage failure
        // cannot turn into silent state loss.
        try {
          const resolved = await loadWorkloadVmCompute(workload, vm, {
            fallback: cloudConfig,
          });
          if (
            resolved.vmCompute &&
            (await resolved.vmCompute.confirmRelease()).state ===
              VMReleaseState.Released
          ) {
            log.warn('Skipping final Service checkpoint flush; VM is gone', {
              id,
              cloudId: vm.cloudId,
              error,
            });
            return;
          }
        } catch (observationError) {
          log.warn(
            'Service VM release observation failed after checkpoint failure',
            {
              id,
              cloudId: vm.cloudId,
              error: observationError,
            },
          );
        }
        throw error;
      }
    }),
  );
}
