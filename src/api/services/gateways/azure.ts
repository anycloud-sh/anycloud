import { createHash, generateKeyPairSync, KeyPairSyncResult } from 'crypto';
import type { ResolvedCloudConfig } from '../../../shared/cloud-config.js';
import { Readable } from 'stream';

import type {
  ComputeManagementClient,
  VirtualMachine,
} from '@azure/arm-compute';
import type {
  NetworkManagementClient,
  NetworkSecurityGroup,
  SecurityRule,
  Subnet,
  PublicIPAddress,
  NetworkInterfaceIPConfiguration,
} from '@azure/arm-network';
import type { ResourceManagementClient } from '@azure/arm-resources';
import type {
  StorageManagementClient,
  StorageAccount,
} from '@azure/arm-storage';
import type { BlobServiceClient } from '@azure/storage-blob';
import type { TokenCredential } from '@azure/identity';
import forge from 'node-forge';
const { pki, ssh } = forge;

import {
  CloudCompute,
  CloudStorage,
  deleteWithRetry,
  isTransientTransportError,
  CloudUploadSource,
  type CloudListPageOptions,
  type CloudObjectListOptions,
  CandidateRegionAvailability,
  createCandidateRegionFilter,
  createCloudCompute,
  createCloudStorage,
  exactCandidatePairsKey,
  openCloudUploadSource,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  vmReleaseUnknown,
  type VMReleaseObservation,
  type VMReleaseObservationOptions,
  type CandidateRegion,
  type ScopedStorageGrant,
  type ScopedStorageToken,
  type StorageFailure,
} from './cloud.js';
import {
  CloudType,
  CloudFailureDiagnosis,
  AzureConnectionCreds,
  DiskTier,
  GpuRuntime,
} from '../../../shared/cloud.js';
import type { PermissionDenial } from '../../../shared/permission-denied.js';
import {
  type CloudResourceSweeper,
  createCloudResourceSweeper,
  isOlderThan,
  isResourceSweepCandidate,
  sweepOwner,
  type ResourceSweepOptions,
  type ResourceSweepResult,
} from './resource-sweeper.js';
import {
  type CloudApiOwnership,
  ApiOwnershipBackfillResult,
  apiOwnershipTagDecision,
  createCloudApiOwnership,
  type ExactVmApiOwnership,
} from './api-ownership.js';
import type {
  BucketEntryPage,
  BucketListPage,
} from '../../../shared/api-contract/bucket-metadata-schemas.js';
import {
  getVCPUsForVMType,
  gpuAcceleratorName,
  diskTierRequiresPremiumStorage,
  vmArchitecture,
} from '../../../shared/cloud-config.js';
import { getAzureQuotaResourceKeyForVMType } from '../../../shared/quota-resolvers/azure.js';
import {
  AZURE_GPU_COMMUNITY_IMAGE_REGIONS,
  normalizeAzureRegionName,
  selectAzureGpuImageId,
} from '../../../shared/catalog/azure-gpu-map.js';
import { DeployError } from '../../../shared/errors.js';
import {
  type GatewayVM,
  type CloudResourceScope,
  type ResourceVM,
  type IngressSpec,
  type NewVMProps,
} from '../entities.js';
import { log } from '../logger.js';
import { buildJobIngressSpec, isSharedJobIngress } from '../network.js';
import { resolveFirewallPlan } from '../firewall-plan.js';

const AZURE_FIREWALL_TRAITS = {
  emitsScopeDeny: false,
  splitsSourceRangesByIpFamily: true,
} as const;
import {
  retryUntil,
  withRetry,
  withTimeout,
  memoizeAsync,
  memoizeAsyncTtl,
  type MemoizeAsyncTtlEntry,
} from '../../../shared/utils.js';
import { AzureQuotaProvider } from '../quota/azure.js';
import type { PipelinePolicy } from '@azure/core-rest-pipeline';
import { armClientOptions } from '../azure-client-options.js';
import { retryAfterMs } from '../../../shared/retry-after.js';
import { CandidatePreflightCache } from '../candidate-preflight-cache.js';
import { storageCoordinationKey } from './storage-coordinator.js';
import {
  VMRestartAttempt,
  VM_RESTART_CONSECUTIVE_OBSERVATIONS,
} from './vm-restart.js';
import { OWNER_API_TAG, getApiIdentity } from '../api-identity.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import type {
  CatalogOverlayProvider,
  CatalogOverlaySnapshot,
} from '../catalog-overlay.js';
import { createAzureCatalogOverlayProvider } from '../catalog-overlays/azure.js';
import {
  azureContainerSas,
  azureDirectorySas,
  createAzureBlobServiceClient,
  createAzureCredential,
  createAzureComputeManagementClient,
  createAzureNetworkManagementClient,
  createAzureResourceManagementClient,
  createAzureStorageManagementClient,
} from '../provider-clients/azure.js';

// Azure VM power states as returned by the Azure API (PowerState/<value>)
// Full list: running, starting, stopping, stopped, deallocating, deallocated, unknown
const AzurePowerState = {
  Running: 'running',
  Starting: 'starting',
  Stopping: 'stopping',
  Stopped: 'stopped',
  Deallocating: 'deallocating',
  Deallocated: 'deallocated',
} as const;

const AZURE_STOPPED_POWER_STATES = new Set<string>([
  AzurePowerState.Stopping,
  AzurePowerState.Stopped,
  AzurePowerState.Deallocating,
  AzurePowerState.Deallocated,
]);

const AZURE_RESTART_SETTLE_MS = 3 * 60_000;
const AZURE_RESTARTABLE_ALLOCATION_ERRORS = new Set([
  'allocationfailed',
  'overconstrainedallocationrequest',
  'zonalallocationfailed',
  'overconstrainedzonalallocationrequest',
]);

// Consolidated VM status derived from both ProvisioningState and PowerState axes.
// Azure reports these independently in instanceView.statuses — checking only one
// axis leaves blind spots (e.g. OverconstrainedAllocationRequest sets
// ProvisioningState/failed but never assigns a PowerState).
enum VMStatus {
  Ready = 'ready', // ProvisioningState/succeeded + PowerState/running
  Waiting = 'waiting', // Still provisioning or booting (no terminal state yet)
  Stopped = 'stopped', // Provisioned successfully but not running (preempted) — restartable
  Failed = 'failed', // ProvisioningState/failed or unrecoverable
}

type ParsedVMStatus = {
  status: VMStatus;
  message: string | null;
  powerState: string | null;
  provisioningState: string | null;
  provisioningErrorCode: string | null;
};

class AzureVMStatusError extends Error {
  code = 'AzureVMStatusError';
  vmId: string;
  vmStatus: VMStatus;
  powerState: string | null;
  provisioningState: string | null;
  provisioningErrorCode: string | null;
  statusMessage: string | null;

  constructor(
    vmId: string,
    action: string,
    parsed: ParsedVMStatus,
    reason: string,
  ) {
    super(`VM ${vmId} ${action}: ${reason}`);
    this.name = 'AzureVMStatusError';
    this.vmId = vmId;
    this.vmStatus = parsed.status;
    this.powerState = parsed.powerState;
    this.provisioningState = parsed.provisioningState;
    this.provisioningErrorCode = parsed.provisioningErrorCode;
    this.statusMessage = parsed.message;
  }
}

function isStoppedOrDeallocatedPowerState(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase().replace(/^powerstate\//, '');
  return (
    normalized === AzurePowerState.Stopped ||
    normalized === AzurePowerState.Deallocated
  );
}

function parseVMStatus(
  statuses: { code?: string; message?: string }[] | undefined,
  resourceProvisioningState?: string,
): ParsedVMStatus {
  let powerState: string | null = null;
  let provisioningState = resourceProvisioningState?.toLowerCase() ?? null;
  let provisioningErrorCode: string | null = null;
  let provisioningMessage: string | null = null;

  if (statuses) {
    for (const s of statuses) {
      const [kind, rawState, ...details] = s.code?.split('/') ?? [];
      const state = rawState?.toLowerCase();
      if (kind?.toLowerCase() === 'powerstate' && state) {
        powerState = state;
      } else if (kind?.toLowerCase() === 'provisioningstate' && state) {
        // Azure may append the provider failure code, for example
        // ProvisioningState/failed/OverconstrainedAllocationRequest. Treat the
        // second path component as the state instead of comparing the entire
        // suffix to "failed". Either resource-level or instance-view failure
        // is terminal; do not let a stale non-failed view override it.
        if (state === 'failed' || provisioningState !== 'failed') {
          provisioningState = state;
          provisioningErrorCode = details[0] ?? null;
          provisioningMessage = s.message ?? null;
        }
      }
    }
  }

  // Initial provisioning must surface the failed operation. Recovery reads
  // the separate power state and failure code before deciding whether to start.
  if (provisioningState === 'failed') {
    return {
      status: VMStatus.Failed,
      message: provisioningMessage,
      powerState,
      provisioningState,
      provisioningErrorCode,
    };
  }

  // PowerState/running — VM is up (with or without explicit ProvisioningState/succeeded,
  // since Azure ARM doesn't always include provisioning state in instanceView)
  if (powerState === AzurePowerState.Running) {
    return {
      status: VMStatus.Ready,
      message: null,
      powerState,
      provisioningState,
      provisioningErrorCode,
    };
  }

  // Transient power states — VM is transitioning (booting, shutting down, etc).
  // Poll through these and let the VM reach a stable state (running/stopped/deallocated).
  const transientStates = new Set([
    AzurePowerState.Starting,
    AzurePowerState.Stopping,
    AzurePowerState.Deallocating,
    'unknown',
  ]);
  if (powerState !== null && transientStates.has(powerState)) {
    return {
      status: VMStatus.Waiting,
      message: null,
      powerState,
      provisioningState,
      provisioningErrorCode,
    };
  }

  // Provisioned but not running — stopped/preempted, restartable
  if (provisioningState === 'succeeded' && powerState !== null) {
    return {
      status: VMStatus.Stopped,
      message: `powerState=${powerState}`,
      powerState,
      provisioningState,
      provisioningErrorCode,
    };
  }

  // Stable non-running power state without provisioning info — terminal
  if (powerState !== null) {
    return {
      status: VMStatus.Failed,
      message: `powerState=${powerState}`,
      powerState,
      provisioningState,
      provisioningErrorCode,
    };
  }

  // Still waiting — no terminal state observed yet
  return {
    status: VMStatus.Waiting,
    message: null,
    powerState,
    provisioningState,
    provisioningErrorCode,
  };
}

// Base name for Azure resource groups (will be suffixed with region)
const RESOURCE_GROUP_BASE = 'anycloud';

/** The subscription's one storage account for buckets, and its group. */
export function azureStorageAccount(subscriptionId: string): {
  account: string;
  resourceGroup: string;
} {
  // Globally unique, lowercase, 3-24 alphanumeric characters.
  const subPrefix = subscriptionId.replace(/-/g, '').substring(0, 8);
  return {
    account: `${RESOURCE_GROUP_BASE}${subPrefix}`.substring(0, 24),
    resourceGroup: `${RESOURCE_GROUP_BASE}-storage`,
  };
}
// Bounds how long the process trusts a cached storage account and key.
const AZURE_STORAGE_ACCOUNT_TTL_MS = 15 * 60 * 1000;
// The Storage resource provider throttles getProperties and listKeys per
// subscription, and the SDK waits out each 429. The API builds a
// gateway per bucket request, so the account and key are cached per credential
// for the process. A rejected Shared Key forgets both; the key is never
// logged. After a key rotation, a SAS minted from the cached key within the
// TTL is signed with the old key, so rotation can invalidate SAS tokens for up
// to 15 min longer than it did when every request read the key.
const storageAccountLookups = new Map<
  string,
  MemoizeAsyncTtlEntry<{
    resourceGroup: string;
    account: StorageAccount;
  } | null>
>();
const storageAccountKeys = new Map<string, MemoizeAsyncTtlEntry<string>>();

/** Test-only: clear the process-wide storage account cache. */
export function resetAzureStorageAccountCacheForTests(): void {
  storageAccountLookups.clear();
  storageAccountKeys.clear();
}
const AZURE_SHARED_KEY_DISABLED = 'AZURE_SHARED_KEY_DISABLED';

function azureSharedKeyDisabledError(
  storageAccountName: string,
): Error & { code: string } {
  const error = new Error(
    `Azure storage account ${storageAccountName} has Shared Key authorization disabled. ` +
      'The Anycloud controller model requires Shared Key for bucket operations and retrieves a current account key through ARM; enable "Allow storage account key access" on this Anycloud-managed account and retry.',
  ) as Error & { code: string };
  error.code = AZURE_SHARED_KEY_DISABLED;
  return error;
}

type AzureMarketplaceImageProps = {
  publisher: string;
  offer: string;
  sku: string;
};

type AzureCommunityGalleryImageProps = {
  communityGalleryImageId: string;
};

type AzureBaseImageProps =
  | AzureMarketplaceImageProps
  | AzureCommunityGalleryImageProps;

function isAzureCommunityGalleryImage(
  image: AzureBaseImageProps,
): image is AzureCommunityGalleryImageProps {
  return 'communityGalleryImageId' in image;
}

function azureBaseImageKey(image: AzureBaseImageProps): string {
  return isAzureCommunityGalleryImage(image)
    ? image.communityGalleryImageId
    : `${image.publisher}:${image.offer}:${image.sku}`;
}

/**
 * Convert PEM format public key to OpenSSH format (ssh-rsa AAA...)
 * Required for Azure authorized_keys files.
 */
function pemToOpenSSH(pemPublicKey: string): string {
  return ssh.publicKeyToOpenSSH(pki.publicKeyFromPem(pemPublicKey));
}

/** Check if Azure error means resource is already deleted */
export const isAzureNotFound = (error: any): boolean =>
  error?.statusCode === 404 ||
  error?.code === 'ResourceNotFound' ||
  error?.code === 'ResourceGroupNotFound';

/**
 * ARM can return AuthorizationFailed while a newly assigned management-plane
 * role is still propagating. The cache is not monotonic, so a preceding
 * successful probe does not prove that the next ARM frontend has the grant.
 * Match only Azure's specific shape: an unrelated 403 remains terminal.
 */
export function isAzureAuthorizationPropagationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    Code?: unknown;
    code?: unknown;
    name?: unknown;
    Message?: unknown;
    message?: unknown;
    statusCode?: unknown;
  };
  const code = err.Code ?? err.code ?? err.name;
  if (
    code === 'AuthorizationFailed' &&
    (err.statusCode === undefined || err.statusCode === 403)
  ) {
    return true;
  }
  const rawMessage = err.message ?? err.Message;
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  return (
    err.statusCode === 403 &&
    /does not have authorization to perform action/i.test(message)
  );
}

/**
 * From Azure's status and error code only. Missing targets need the exact blob
 * service codes: another 404, such as one from an ARM call, proves nothing.
 * An ARM AuthorizationFailed reaching this has outlasted the propagation
 * retries, so it is denied, not still propagating.
 */
function classifyAzureStorageFailure(
  error: unknown,
): StorageFailure | undefined {
  const { code, statusCode } = (error ?? {}) as {
    code?: unknown;
    statusCode?: unknown;
  };
  const reported = typeof code === 'string' ? code : `HTTP ${statusCode}`;
  if (code === 'ContainerNotFound') {
    return { kind: 'bucket-missing', code: reported };
  }
  if (code === 'BlobNotFound') {
    return { kind: 'object-missing', code: reported };
  }
  if (statusCode === 403 || code === 'AuthorizationFailed') {
    return { kind: 'denied', code: reported };
  }
  if (statusCode === 429 || code === 'ServerBusy') {
    return { kind: 'throttled', code: reported };
  }
  return undefined;
}

/**
 * ARM error codes for a removed/incorrect management-plane role or a stale
 * token. classifyError reports AuthorizationFailed as PermissionDenied and the
 * rest as BadCredential; isAzureTerminalAuthError treats all as terminal.
 */
const AZURE_AUTH_ERROR_CODES = new Set([
  'AuthorizationFailed',
  'InvalidAuthenticationToken',
  'InvalidAuthenticationTokenTenant',
  'ExpiredAuthenticationToken',
]);

/**
 * ARM's refusal of an authenticated service principal, naming the action:
 * "… does not have authorization to perform action
 * 'Microsoft.Compute/virtualMachines/write' over scope …". Region limits are
 * not classified (RFC 0047 open question), so no denial is regional.
 */
function azurePermissionDenial(error: unknown): PermissionDenial | undefined {
  const err = (error ?? {}) as any;
  // As classifyError reads it, an instance-view code first.
  const code = err.provisioningErrorCode ?? err.Code ?? err.code ?? err.name;
  if (code !== 'AuthorizationFailed' && code !== 'LinkedAuthorizationFailed')
    return undefined;
  const message = err.message ?? err.Message;
  const action =
    typeof message === 'string'
      ? (message.match(/perform action '([\w./-]+)'/)?.[1] ?? null)
      : null;
  return { action, regional: false };
}

/**
 * How @azure/identity ordinarily surfaces a rotated, expired, or wrong
 * service-principal secret: AADSTS7000215 (invalid), AADSTS7000222 (expired),
 * or the OAuth `invalid_client` error. The thrown error's code/name isn't an
 * ARM error code here, so match the message.
 */
const AZURE_BAD_SECRET_MESSAGE_RE =
  /AADSTS7000215|AADSTS7000222|invalid_client/i;

/** A typo or nonexistent configured Entra directory cannot succeed on retry. */
const AZURE_INVALID_TENANT_MESSAGE_RE = /\bAADSTS90002\b/i;

/**
 * Entra can briefly return AADSTS7000215 for a newly added client secret even
 * after that exact secret authenticated through another frontend. Keep this
 * narrower than AZURE_BAD_SECRET_MESSAGE_RE: expired and generically invalid
 * secrets remain terminal.
 */
function isAzureClientSecretPropagationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { message?: unknown; Message?: unknown };
  const message = candidate.message ?? candidate.Message;
  return typeof message === 'string' && /AADSTS7000215\b/i.test(message);
}

/**
 * Azure auth/permission failures that ordinarily re-fail until a human fixes
 * the credential: a bad/expired/rotated service-principal secret, a removed
 * management-plane RBAC role, or a missing storage data-plane role
 * (AuthorizationPermissionMismatch). Consumers may give the narrower
 * AADSTS7000215 shape a bounded recovery attempt before treating it as terminal.
 * Other callers use this to avoid 30-180 futile retries, and classifyError maps
 * the same shapes to terminal provisioning dispositions.
 */
export function isAzureTerminalAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as any;
  const code = err.Code ?? err.code ?? err.name;
  const msg = err.message ?? err.Message ?? '';
  if (typeof code === 'string') {
    if (AZURE_AUTH_ERROR_CODES.has(code)) return true;
    if (code === 'AuthorizationPermissionMismatch') return true;
  }
  if (typeof msg === 'string') {
    if (AZURE_BAD_SECRET_MESSAGE_RE.test(msg)) return true;
    if (/AuthorizationPermissionMismatch/i.test(msg)) return true;
  }
  return false;
}

/**
 * deleteWithRetry preset for Azure: treats 404/ResourceNotFound as done and
 * gives up immediately on terminal auth/permission errors instead of retrying
 * 30-180× a delete that can never succeed with the current credential.
 */
function deleteAzureResource(
  deleteFn: () => Promise<any>,
  resourceName: string,
  maxAttempts = 30,
  waitMs = 10000,
): Promise<void> {
  return deleteWithRetry(
    deleteFn,
    resourceName,
    isAzureNotFound,
    maxAttempts,
    waitMs,
    (e) => !isAzureTerminalAuthError(e),
  );
}

// Cap concurrent in-flight Azure ARM calls per terminateVMs invocation.
// Above ~100 vmIds, unbounded fan-out exhausts the container's ephemeral
// socket budget (EADDRNOTAVAIL) before any terminateStep can return; below
// Azure ARM's per-subscription-per-region write rate so it doesn't 429.
const AZURE_TERMINATE_CONCURRENCY = 20;

/** The region's standing public-SSH NSG, shared by every Job's and VM's NIC. */
const AZURE_SHARED_VM_NSG_NAME = 'anycloud-shared-vm';

// Same lifetime as AWS and R2 tokens; the API renews it before expiry.
const AZURE_SAS_TTL_MS = 36 * 60 * 60_000;
// Starts early so a VM clock behind Azure's still accepts a fresh SAS.
const AZURE_SAS_CLOCK_SKEW_MS = 5 * 60_000;
const AZURE_CREDENTIAL_PROPAGATION_RETRY_TIMING = {
  maxAttempts: 9,
  waitMs: 500,
  maxWaitMs: 8000,
} as const;

interface PreflightSweep {
  insufficientByVmType: Map<string, Set<string>>;
  unknownByVmType: Map<string, Set<string>>;
  complete: boolean;
}

const PREFLIGHT_REGISTRATION_WAIT_TIMEOUT_MS = 5_000;
const preflightSweepCache =
  new CandidatePreflightCache<PreflightSweep | null>();

/** Test-only: clear the process-wide preflight-sweep cache. */
export function resetAzurePreflightSweeps(): void {
  preflightSweepCache.clear();
}

/**
 * Map the requested disk performance tier to an Azure managed-disk
 * storageAccountType for the OS disk. `medium` or an unresolved gateway input
 * uses `Standard_LRS`; `high` and `ultra` request `Premium_LRS`. `ultra` collapses
 * onto `Premium_LRS` because UltraSSD_LRS / PremiumV2_LRS are data-disk-only and
 * cannot back an OS disk — Premium_LRS is the OS-disk ceiling. The
 * high/ultra → premium decision lives in `diskTierRequiresPremiumStorage` so the
 * gateway and the optimizer's premium-capable candidate filter can't diverge.
 * Premium_LRS requires a premium-capable ('s'-suffix, e.g. NCadsH100v5) VM size;
 * the optimizer normally drops non-capable candidates before provisioning, and
 * classifyError terminates any that slip through.
 */
function storageAccountTypeForDiskTier(
  diskTier: DiskTier | undefined,
): 'Standard_LRS' | 'Premium_LRS' {
  return diskTierRequiresPremiumStorage(diskTier)
    ? 'Premium_LRS'
    : 'Standard_LRS';
}

export class Azure {
  type: CloudType;
  /** The region's shared public-SSH NSG, made once per gateway. */
  private sharedNsgReady = new Map<string, Promise<NetworkSecurityGroup>>();
  vmType: string;
  region: string;
  spot?: boolean;
  diskSizeGb?: number;
  diskTier?: DiskTier;
  availabilityZone?: string;
  // Public for integration testing
  computeClient!: ComputeManagementClient;
  networkClient!: NetworkManagementClient;
  storageClient!: StorageManagementClient;
  readonly resourceGroup: string; // Region-specific resource group name
  readonly storageResourceGroup: string; // Resource group for storage
  readonly storageAccountName: string; // Storage account for buckets
  private resourcesClient!: ResourceManagementClient;
  private azConfig: any;
  private storageCoordinationPrefix: string;
  private computeProvider?: CloudCompute;
  private storageProvider?: CloudStorage;
  private sweeperProvider?: CloudResourceSweeper;
  private apiOwnershipProvider?: CloudApiOwnership;
  private catalogOverlay: CatalogOverlayProvider | null | undefined;
  private initializationInFlight = new Map<
    'regional' | 'storage',
    Promise<void>
  >();

  constructor(
    azConfig: ResolvedCloudConfig,
    catalogOverlay?: CatalogOverlayProvider | null,
  ) {
    this.region = azConfig.region!;
    this.azConfig = azConfig;
    this.type = CloudType.Azure;
    this.vmType = this.azConfig.vmType;
    // Use region-specific resource group to avoid conflicts when using multiple regions
    this.resourceGroup = `${RESOURCE_GROUP_BASE}-${this.region.replace(/\s+/g, '-').toLowerCase()}`;
    const azCreds = azConfig.credentials as AzureConnectionCreds;
    const storage = azureStorageAccount(azCreds.subscriptionId);
    this.storageResourceGroup = storage.resourceGroup;
    this.storageAccountName = storage.account;
    this.storageCoordinationPrefix = storageCoordinationKey([
      'azure',
      azCreds.subscriptionId,
      this.storageAccountName,
    ]);
    this.spot = azConfig.spot;
    this.diskSizeGb = azConfig.diskSizeGb;
    this.diskTier = azConfig.diskTier;
    this.availabilityZone = azConfig.availabilityZone;
    this.catalogOverlay = catalogOverlay;
  }

  private isCredentialPropagationError(error: unknown): boolean {
    return (
      isAzureAuthorizationPropagationError(error) ||
      isAzureClientSecretPropagationError(error)
    );
  }

  compute(): CloudCompute {
    this.computeProvider ??= createCloudCompute({
      type: this.type,
      region: this.region,
      spot: this.spot,
      vmType: this.vmType,
      rawValidateCredentials: () => this.validateCredentials(),
      credentialValidationRetryPolicy: {
        ...AZURE_CREDENTIAL_PROPAGATION_RETRY_TIMING,
        shouldRetry: (error) => this.isCredentialPropagationError(error),
      },
      rawClassifyError: (error) => this.classifyError(error),
      permissionDenial: (error) => azurePermissionDenial(error),
      rawNewVM: (params) => this.newVM(params),
      rawRequestVMTermination: (vmId) => this.terminateVM(vmId),
      rawTerminateNetworking: (workloadId) =>
        this.terminateNetworking(workloadId),
      rawGetAllVMs: () => this.getAllVMs(),
      rawUpsertFirewall: (ipWhiteList, workloadId, version, userId) =>
        this.upsertFirewall(ipWhiteList, workloadId, version, userId),
      rawPrepareNetwork: (spec, workloadId, version, userId) =>
        this.prepareNetwork(spec, workloadId, version, userId),
      observeVMReleaseOnce: (cloudId, options) =>
        this.observeVMReleaseOnce(cloudId, options),
      terminateVMsConcurrency: AZURE_TERMINATE_CONCURRENCY,
      stoppedVmObservation: {
        observeStoppedVm: (cloudId) => this.observeStoppedVm(cloudId),
      },
      stoppedVmRestart: {
        verifyVMPreemption: (cloudId) => this.verifyVMPreemption(cloudId),
        startVM: (cloudId) => this.startVM(cloudId),
      },
      ingressSupport: {
        supportsIngress: () => true,
      },
      candidateRegionFilter: this.createCandidateRegionFilter(),
      terminalAuthErrorClassifier: {
        isTerminalAuthError: (error) => this.isTerminalAuthError(error),
      },
      resourceScoped: {
        prepareResourceNetwork: (spec, scope, version) =>
          this.prepareNetwork(
            spec,
            scope.id,
            version,
            scope.tags.anycloud_user ?? 'unknown',
            scope,
          ),
        newResourceVM: ({ scope, ...params }) =>
          this.newVM({
            ...params,
            workloadId: scope.id,
            userId: scope.tags.anycloud_user ?? 'unknown',
            resourceScope: scope,
          }),
        listResourceVMs: (scope) => this.listResourceVMs(scope),
        terminateResourceNetwork: (scope) =>
          this.terminateResourceNetworking(scope),
        // Azure deletes a VM's disks and NIC with it (deleteOption) but not
        // the public IP the NIC held, which we created separately.
        terminateResourceVMLeftovers: (cloudId) =>
          this.deleteNICAndPublicIP(cloudId),
      },
    });
    return this.computeProvider;
  }

  sweeper(): CloudResourceSweeper {
    this.sweeperProvider ??= createCloudResourceSweeper({
      type: this.type,
      region: this.region,
      rawSweepResources: (options) => this.sweepResources(options),
      rawSweepStorage: (options) => this.sweepStorage(options),
      rawSweepLocations: () => this.sweepLocations(),
    });
    return this.sweeperProvider;
  }

  apiOwnership(): CloudApiOwnership {
    this.apiOwnershipProvider ??= createCloudApiOwnership({
      type: this.type,
      region: this.region,
      rawBackfillExactVM: (target) => this.backfillExactVmApiOwnership(target),
    });
    return this.apiOwnershipProvider;
  }

  storage(): CloudStorage {
    this.storageProvider ??= createCloudStorage({
      type: this.type,
      region: this.region,
      storageAccountName: this.storageAccountName,
      retryPolicy: {
        ...AZURE_CREDENTIAL_PROPAGATION_RETRY_TIMING,
        // Authentication and authorization propagation use deterministic
        // waits. Ordinary transport retries retain jitter so concurrent calls
        // de-correlate.
        jitter: (error) => !this.isCredentialPropagationError(error),
        shouldRetry: (error) =>
          isTransientTransportError(error) ||
          this.isCredentialPropagationError(error),
        beforeRetry: (error) => {
          if (this.isCredentialPropagationError(error)) {
            this.refreshStorageAuthentication();
          }
        },
        // A new secret signs in on some Entra replicas before others. Once an
        // attempt has reached ARM and been refused, a later AADSTS7000215 is
        // replication noise: report the ARM refusal, not "still propagating".
        reportedError: (final, earlier) =>
          isAzureClientSecretPropagationError(final)
            ? ([...earlier]
                .reverse()
                .find(isAzureAuthorizationPropagationError) ?? final)
            : final,
      },
      // Coordinated upserts retain their long transport-recovery session, but
      // AuthorizationFailed must use the bounded operation policy above.
      coordinatedUpsertShouldRetry: isTransientTransportError,
      rawBucketCoordinationKey: (bucketName) =>
        this.bucketCoordinationKey(bucketName),
      rawHasBucket: (bucketName) =>
        this.withAccountKey(() => this.hasBucketUncoordinated(bucketName)),
      // Versioning is a storage-account (blob service) property on Azure.
      rawGetBucketVersioning: async () => {
        const storageInfo = await this.findStorageAccount();
        if (!storageInfo) return 'disabled';
        const properties =
          await this.storageClient.blobServices.getServiceProperties(
            storageInfo.resourceGroup,
            storageInfo.account.name!,
          );
        return properties.isVersioningEnabled ? 'enabled' : 'disabled';
      },
      rawEnableBucketVersioning: async () => {
        const storageInfo = await this.findStorageAccount();
        if (!storageInfo) throw new Error('Azure storage account is missing');
        await this.storageClient.blobServices.setServiceProperties(
          storageInfo.resourceGroup,
          storageInfo.account.name!,
          { isVersioningEnabled: true },
        );
      },
      // Only the compute credential mints, for its own storage account; a
      // separate Azure storage credential stays unsupported.
      validateScopedStorageTokenSource: () => {
        throw new DeployError(
          'Cross-cloud storage requires credentials that can mint scoped bucket-sync tokens (got Azure). ' +
            'Use an Azure bucket from the Azure compute credential instead.',
          400,
        );
      },
      mintScopedStorageToken: (grants, options) =>
        this.mintSas(grants, options?.lifetimeMs),
      rawUpsertBucketUncoordinated: (bucketName, version, workloadId, userId) =>
        this.withAccountKey(() =>
          this.upsertBucketUncoordinated(
            bucketName,
            version,
            workloadId,
            userId,
          ),
        ),
      rawDeleteBucket: (bucketName) =>
        this.withAccountKey(() => this.deleteBucket(bucketName)),
      rawDeleteObject: (bucketName, remotePath) =>
        this.withAccountKey(() => this.deleteObject(bucketName, remotePath)),
      rawUploadObject: ({ bucketName, remotePath, source }) =>
        this.withAccountKey(() =>
          this.uploadObject(bucketName, remotePath, source),
        ),
      rawDownloadObject: (bucketName, remotePath) =>
        this.withAccountKey(() => this.downloadObject(bucketName, remotePath)),
      rawListBuckets: (options) =>
        this.withAccountKey(() => this.listBuckets(options)),
      rawListObjects: (bucketName, options, signal) =>
        this.withAccountKey(() =>
          this.listObjects(bucketName, options, signal),
        ),
      isNotFound: (error) =>
        isAzureNotFound(error) ||
        (error as { code?: string; statusCode?: number })?.code ===
          'ContainerNotFound' ||
        (error as { code?: string; statusCode?: number })?.statusCode === 404,
      classifyStorageFailure: async (error) =>
        classifyAzureStorageFailure(error),
      isCredentialNotReady: (error) => this.isCredentialPropagationError(error),
    });
    return this.storageProvider;
  }

  /**
   * Filter exact candidate pairs from one subscription SKU/quota snapshot.
   */
  private createCandidateRegionFilter() {
    return createCandidateRegionFilter({
      cache: preflightSweepCache,
      cacheKey: ({ candidates, spot }) => {
        this.refreshCatalogOverlay('candidate-filter');
        return JSON.stringify([
          (this.azConfig.credentials as AzureConnectionCreds).subscriptionId,
          spot,
          exactCandidatePairsKey(candidates),
        ]);
      },
      operationName: ({ workloadId }) =>
        `read Azure candidate availability for ${workloadId}`,
      runPreflight: ({ candidates, spot, workloadId, signal, deadlineAt }) =>
        this.runPreflightSweep(
          candidates,
          spot,
          workloadId,
          signal,
          deadlineAt,
        ),
      isComplete: (sweep) => sweep?.complete ?? false,
      createAssessmentContext: () =>
        this.readCatalogOverlay('candidate-assessment'),
      assess: (sweep, candidate, _input, catalogOverlay) => {
        if (sweep === null) return CandidateRegionAvailability.Unknown;
        if (
          sweep.insufficientByVmType
            .get(candidate.vmType)
            ?.has(candidate.region)
        ) {
          return CandidateRegionAvailability.Unavailable;
        }
        if (
          sweep.unknownByVmType.get(candidate.vmType)?.has(candidate.region)
        ) {
          return CandidateRegionAvailability.Unknown;
        }
        return (
          catalogOverlay?.assessCandidate(candidate) ??
          CandidateRegionAvailability.Unknown
        );
      },
    });
  }

  private getCatalogOverlay(): CatalogOverlayProvider | null {
    if (this.catalogOverlay === undefined) {
      this.catalogOverlay = createAzureCatalogOverlayProvider(
        this.azConfig.credentials as AzureConnectionCreds,
      );
    }
    return this.catalogOverlay;
  }

  private readCatalogOverlay(
    reason: string,
  ): CatalogOverlaySnapshot | undefined {
    this.refreshCatalogOverlay(reason);
    return this.getCatalogOverlay()?.read();
  }

  private refreshCatalogOverlay(reason: string): void {
    const overlay = this.getCatalogOverlay();
    if (!overlay) return;
    void overlay.refresh(reason).catch(() => {});
  }

  private invalidateCatalogOverlay(reason: string, region?: string): void {
    this.getCatalogOverlay()?.invalidate(reason, region);
  }

  private async runPreflightSweep(
    candidates: CandidateRegion[],
    spot: boolean,
    workloadId: string,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<PreflightSweep | null> {
    const provider = new AzureQuotaProvider(
      this.azConfig.credentials as AzureConnectionCreds,
      () => this.getCatalogOverlay()?.invalidate('compute-registration'),
    );
    const insufficientByVmType = new Map<string, Set<string>>();
    const unknownByVmType = new Map<string, Set<string>>();
    let complete = true;

    const regionsByVmType = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      let regions = regionsByVmType.get(candidate.vmType);
      if (!regions) {
        regions = new Set<string>();
        regionsByVmType.set(candidate.vmType, regions);
      }
      regions.add(candidate.region);
    }
    const boundedTimeoutMs = (maximumMs: number): number =>
      Math.max(1, Math.min(maximumMs, deadlineAt - Date.now()));

    try {
      const registrationController = new AbortController();
      const registrationSignal = AbortSignal.any([
        signal,
        registrationController.signal,
      ]);
      let registered: boolean;
      try {
        registered = await withTimeout(
          provider.ensureProviderRegistered(
            'Microsoft.Compute',
            registrationSignal,
          ),
          boundedTimeoutMs(PREFLIGHT_REGISTRATION_WAIT_TIMEOUT_MS),
          'check Azure Microsoft.Compute registration for candidate preflight',
        );
      } catch (error) {
        registrationController.abort(error);
        throw error;
      }
      if (!registered) {
        log.warn(
          'Skipping Azure quota prefilter until Microsoft.Compute is registered',
          { id: workloadId },
        );
        return null;
      }
    } catch (err) {
      log.warn('Failed to prepare Azure candidate availability probe', {
        id: workloadId,
        error: err,
      });
      return null;
    }

    await Promise.all(
      [...regionsByVmType].map(async ([vt, regionSet]) => {
        const regionsInUse = [...regionSet];
        try {
          const vCPUs = getVCPUsForVMType(vt, CloudType.Azure);
          const unknown = new Set<string>();
          let insufficient = new Set<string>();
          if (vCPUs !== undefined && regionsInUse.length > 0) {
            const familyResourceKey = getAzureQuotaResourceKeyForVMType(vt);
            if (familyResourceKey) {
              const insufficientResult = await withRetry(
                () =>
                  provider.getInsufficientQuotaRegions(
                    familyResourceKey,
                    vCPUs,
                    spot,
                    regionsInUse,
                    signal,
                  ),
                `list Azure insufficient-quota regions for ${vt}`,
                {
                  maxAttempts: 3,
                  waitMs: 1000,
                  exponentialBackoff: false,
                  signal,
                },
              );
              if (!insufficientResult.complete) complete = false;
              insufficient = insufficientResult.insufficientRegions;
              for (const region of insufficientResult.unknownRegions ?? []) {
                unknown.add(region);
              }
            } else {
              complete = false;
              for (const region of regionsInUse) unknown.add(region);
            }
          } else if (regionsInUse.length > 0) {
            complete = false;
            for (const region of regionsInUse) unknown.add(region);
          }
          insufficientByVmType.set(vt, insufficient);
          unknownByVmType.set(vt, unknown);
        } catch (err) {
          complete = false;
          insufficientByVmType.set(vt, new Set());
          unknownByVmType.set(vt, new Set(regionsInUse));
          log.warn('Failed to query Azure candidate availability for VM type', {
            id: workloadId,
            vmType: vt,
            error: err,
          });
        }
      }),
    );

    return {
      insufficientByVmType,
      unknownByVmType,
      complete,
    };
  }

  /**
   * Generate resource tags in Azure format
   */
  private getResourceTags(
    workloadId: string,
    version: string,
    userId: string,
    endedAt?: number,
    resourceScope?: CloudResourceScope,
  ): { [key: string]: string } {
    const tags: { [key: string]: string } = resourceScope
      ? {
          ...resourceScope.tags,
          anycloud_resource: resourceScope.id,
          anycloud_version: version,
          anycloud_created_at: Date.now().toString(),
          [OWNER_API_TAG]: getApiIdentity(),
        }
      : {
          anycloud_deployment: workloadId,
          anycloud_version: version,
          anycloud_user: userId,
          anycloud_created_at: Date.now().toString(),
          [OWNER_API_TAG]: getApiIdentity(),
        };
    if (endedAt !== undefined) {
      tags.anycloud_ended_at = endedAt.toString();
    }
    return tags;
  }

  private async backfillExactVmApiOwnership(
    target: ExactVmApiOwnership,
  ): Promise<ApiOwnershipBackfillResult> {
    this.initializeClients();
    let vm: VirtualMachine;
    try {
      vm = await this.computeClient.virtualMachines.get(
        this.resourceGroup,
        target.cloudId,
      );
    } catch (error) {
      if (isAzureNotFound(error)) {
        return ApiOwnershipBackfillResult.Missing;
      }
      throw error;
    }

    const decision = apiOwnershipTagDecision(vm.tags ?? {}, target);
    if (decision === 'already-owned') {
      return ApiOwnershipBackfillResult.AlreadyOwned;
    }
    const poller = await this.computeClient.virtualMachines.beginUpdate(
      this.resourceGroup,
      target.cloudId,
      {
        tags: {
          ...vm.tags,
          [OWNER_API_TAG]: target.apiIdentity,
        },
      },
    );
    await withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `backfill controller ownership on Azure VM ${target.cloudId}`,
    );
    return ApiOwnershipBackfillResult.Updated;
  }

  private async readVMInstanceStatus(
    vmId: string,
    signal?: AbortSignal,
  ): Promise<{ parsed: ParsedVMStatus; createdAt?: number }> {
    this.initializeClients();
    const vm = await this.computeClient.virtualMachines.get(
      this.resourceGroup,
      vmId,
      { expand: 'instanceView', ...(signal && { abortSignal: signal }) },
    );
    const parsed = parseVMStatus(
      vm.instanceView?.statuses,
      vm.provisioningState,
    );
    const createdAt =
      vm.timeCreated instanceof Date ? vm.timeCreated.getTime() : Number.NaN;
    return {
      parsed,
      ...(Number.isFinite(createdAt) && { createdAt }),
    };
  }

  /**
   * Fetch VM instance view + public IP and return consolidated status.
   * Throws immediately on Failed status with a descriptive error message.
   */
  async checkVMStatus(
    vmId: string,
  ): Promise<{ ip: string | null; status: VMStatus; createdAt?: number }> {
    this.initializeClients();
    const publicIPInfo = await this.networkClient.publicIPAddresses.get(
      this.resourceGroup,
      vmId,
    );
    const { parsed, createdAt } = await this.readVMInstanceStatus(vmId);
    const { status, message } = parsed;

    if (status === VMStatus.Failed) {
      throw new AzureVMStatusError(
        vmId,
        'provisioning failed',
        parsed,
        message ?? 'unknown reason',
      );
    }
    // A stopped VM during provisioning means preemption (spot) or a rare cloud
    // platform issue (non-spot). The VM provisioned successfully but won't restart
    // by itself — someone must call beginStart. Preemption reconciliation does
    // not act while the workload is still Provisioning. Throwing lets the
    // retry pipeline (provisionVMs → Retrying → re-provision) handle it, with
    // the attempt ledger identifying resources for cleanup. Potentially the
    // provisioner could try startVM() before tearing down to avoid a full
    // re-provision cycle.
    if (status === VMStatus.Stopped) {
      throw new AzureVMStatusError(
        vmId,
        'stopped during provisioning',
        parsed,
        message ?? 'unknown reason',
      );
    }

    return {
      ip: publicIPInfo.ipAddress ?? null,
      status,
      ...(createdAt !== undefined && { createdAt }),
    };
  }

  private async newVM(params: NewVMProps): Promise<GatewayVM> {
    const {
      startupScript,
      ipWhitelist,
      vmId,
      workloadId,
      gpuRuntime,
      version,
      userId,
    } = params;
    const spot = this.spot;

    const vmStartTime = Date.now();
    this.initializeClients();
    // VMs get no identity: same-account Buckets sync with minted container
    // SAS tokens (RFC 0047), so a VM needs only compute and network setup.
    await this.ensureRegionalInfrastructure();

    // createCloudCompute enforces Azure's accelerator-runtime capability before
    // raw provider code runs, so this path receives CUDA or CPU only.
    const wantsNvidiaImage = gpuRuntime === GpuRuntime.Cuda;
    const region = normalizeAzureRegionName(this.azConfig.region);
    if (wantsNvidiaImage && !AZURE_GPU_COMMUNITY_IMAGE_REGIONS.has(region)) {
      throw new DeployError(
        `Azure GPU workloads are not supported in region "${this.azConfig.region}" because the GPU base image is not replicated there. Choose one of: ${[
          ...AZURE_GPU_COMMUNITY_IMAGE_REGIONS,
        ].join(', ')}.`,
        400,
      );
    }

    // Select the base image. NVIDIA GPU deploys use a dstack community-gallery
    // image chosen by GPU model (selectAzureGpuImageId): NV-series → GRID,
    // pre-Turing V100 → proprietary-modules 0.10, Turing+ → 0.14. These images
    // boot final (no first-boot self-upgrade + reboot that SIGKILLed workloads
    // mid-run). The accelerator name is resolved from the catalog — the gateway
    // already does catalog lookups here (getVCPUsForVMType). CPU uses the
    // canonical Ubuntu marketplace image.
    let baseImageProps: AzureBaseImageProps;
    if (wantsNvidiaImage) {
      const acceleratorName = gpuAcceleratorName(CloudType.Azure, this.vmType);
      const imageId = selectAzureGpuImageId(this.vmType, acceleratorName);
      if (!imageId) {
        // NC/ND CUDA target whose GPU model we can't resolve — refuse to guess
        // an image (open-module 0.14 fails terminally on a pre-Turing GPU).
        throw new DeployError(
          `Cannot determine the GPU model for "${this.vmType}" to select a compatible Azure base image.`,
          400,
        );
      }
      baseImageProps = { communityGalleryImageId: imageId };
    } else {
      baseImageProps = {
        publisher: 'canonical',
        // service-terminology-ok: Azure owns this marketplace SKU spelling
        // Ubuntu 24.04 LTS (noble). The `server` SKU of the newer
        // `ubuntu-24_04-lts` offer resolves as Hyper-V Gen2 (`server-gen1` is
        // the Gen1 variant; `-arm64` the Arm build, for Cobalt and Ampere).
        offer: 'ubuntu-24_04-lts',
        // A Job host's user data prepares Ubuntu minimal.
        sku: `${params.jobHost ? 'minimal' : 'server'}${
          vmArchitecture(CloudType.Azure, this.vmType) === 'arm64'
            ? '-arm64'
            : ''
        }`,
      };
    }

    const baseImageKey = azureBaseImageKey(baseImageProps);

    // Get image ID and VNet info in parallel. Community-gallery images have no
    // marketplace image version to list, so imageId is null for them.
    const prepStartTime = Date.now();
    const [imageId, vnetInfo] = await Promise.all([
      isAzureCommunityGalleryImage(baseImageProps)
        ? Promise.resolve(null)
        : this.getImageId(baseImageProps),
      this.getVnetInfo(workloadId),
    ]);
    log.info(
      `[${vmId}] Image + VNet lookup took ${((Date.now() - prepStartTime) / 60000).toFixed(2)}min`,
    );

    const vmNetwork = await this.upsertVMNetwork(
      vmId,
      ipWhitelist,
      workloadId,
      vnetInfo.subnet,
      version,
      userId,
      params.resourceScope,
      params.ingressSpec,
    );
    const { publicKey } = this.generateSSHKeyPair();
    const vmParameters = this.getVmParams(
      vmId,
      startupScript,
      baseImageProps,
      imageId,
      { ...vnetInfo, ...vmNetwork },
      publicKey,
      workloadId,
      version,
      userId,
      spot,
      params.resourceScope,
    );
    log.info(
      `[${vmId}] Starting VM creation (spot=${spot || false}, gpu=${wantsNvidiaImage || false})...`,
    );

    // Fire-and-forget: kick off VM creation but don't block on pollUntilDone().
    // Azure's pollUntilDone() can hang indefinitely on spot VMs. Instead, we
    // poll VM status ourselves (same pattern as AWS/GCP) via checkVMStatus below.
    try {
      await this.computeClient.virtualMachines.beginCreateOrUpdate(
        this.resourceGroup,
        vmId,
        vmParameters,
      );
    } catch (error: any) {
      // PropertyChangeNotAllowed = concurrent creation — another attempt is
      // already creating this VM. Fall through to polling loop which will pick
      // it up. Other 409s (quota, "previous order being canceled", etc.) should
      // fail fast rather than polling 10 min for a VM that was never created.
      if (error.code !== 'PropertyChangeNotAllowed') {
        throw error;
      }
      log.info('Concurrent VM creation detected — polling for existing VM', {
        vmId,
        workloadId,
        errorCode: error.code,
        errorMessage: error.message?.slice(0, 200),
      });
    }

    // Poll for VM to be running with a public IP (same pattern as AWS/GCP).
    // checkVMStatus throws on Failed/Stopped (e.g. OverconstrainedAllocationRequest).
    // Resources may not exist yet while ARM operation is in flight — treat
    // not-found errors as transient and keep polling.
    const ipPollStartTime = Date.now();
    let lastStatus: VMStatus | null = null;
    let lastIp: string | null = null;
    let result;
    try {
      result = await retryUntil(
        async () => {
          try {
            const r = await this.checkVMStatus(vmId);
            lastStatus = r.status;
            lastIp = r.ip;
            return r;
          } catch (error: any) {
            // Resource not found yet — ARM operation still in flight
            if (error.code === 'ResourceNotFound' || error.statusCode === 404) {
              return { ip: null, status: VMStatus.Waiting };
            }
            throw error;
          }
        },
        (r) => !!(r.ip && r.status === VMStatus.Ready),
        `VM ${vmId} to be running with IP address`,
        { maxAttempts: 120, waitMs: 5000 },
      );
    } catch (error: any) {
      if (error.message?.includes('failed after')) {
        throw new Error(
          `VM ${vmId} failed to start: status=${lastStatus ?? 'unknown'}, hasIp=${!!lastIp}`,
        );
      }
      throw error;
    }

    log.info(
      `[${vmId}] VM creation (Azure API) took ${((Date.now() - ipPollStartTime) / 60000).toFixed(2)}min`,
    );
    log.info(
      `[${vmId}] VM ready polling took ${((Date.now() - ipPollStartTime) / 60000).toFixed(2)}min`,
    );
    log.info(
      `[${vmId}] Total newVM time: ${((Date.now() - vmStartTime) / 60000).toFixed(2)}min`,
    );
    await this.tagOsDisk(vmId, vmParameters.tags);
    const publicIpAddress = result.ip!;
    const privateIpAddress =
      vmNetwork.nic.ipConfigurations?.[0]?.privateIPAddress;
    return {
      cloudId: vmId,
      ip: publicIpAddress,
      privateIp: privateIpAddress,
      baseImageId: baseImageKey,
      availabilityZone: this.availabilityZone,
      ...(result.createdAt !== undefined && { createdAt: result.createdAt }),
    };
  }

  /**
   * An OS disk takes no tags from its VM. It goes with the VM
   * (`deleteOption: Delete`), so tags matter only when a VM delete fails and
   * a sweep must still find it. Best effort: the VM is already running.
   */
  private async tagOsDisk(vmId: string, tags: Record<string, string>) {
    try {
      const vm = await this.computeClient.virtualMachines.get(
        this.resourceGroup,
        vmId,
      );
      const diskName = vm.storageProfile?.osDisk?.name;
      if (!diskName) return;
      // Accepted is enough; the tag write needs no wait.
      await this.computeClient.disks.beginUpdate(this.resourceGroup, diskName, {
        tags,
      });
    } catch (error) {
      log.warn(`[${vmId}] Could not tag the OS disk`, {
        vmId,
        error: errorMessage(error),
      });
    }
  }

  private async terminateNetworking(workloadId: string) {
    this.initializeClients();
    // A workload named like the shared NSG (`--id`) must not take it.
    if (workloadId === AZURE_SHARED_VM_NSG_NAME) return;

    // Tag networking resources for orphan detection before deletion.
    await Promise.all([
      this.tagNSGForDeletion(workloadId),
      this.tagVNetForDeletion(workloadId),
    ]);

    // Delete NSG first, then VNet (sequential, not parallel)
    // NSG can be attached to NICs/subnets, so must be deleted before VNet
    // VNet contains subnets which may have dependencies, so delete last
    await deleteAzureResource(
      () => this.removeFirewalls(workloadId),
      `firewall ${workloadId}`,
      180,
      10000,
    );

    await deleteAzureResource(
      () => this.removeVirtualNetwork(workloadId),
      `virtual network ${workloadId}`,
      180,
      10000,
    );
  }

  /**
   * A scope VM's NIC and public IP, both named after it, outlive it when
   * terminateVM fails partway or the VM vanished outside it; a public IP is
   * never deleted with its VM. The NIC holds the scope's NSG, so it goes
   * first. A public IP whose NIC is already gone (terminateVM failed after
   * the NIC) is deleted on its own.
   */
  private async terminateResourceNetworking(scope: CloudResourceScope) {
    this.initializeClients();
    const tagged = async (
      list: AsyncIterable<{ name?: string; tags?: Record<string, string> }>,
    ) => {
      const names: string[] = [];
      try {
        for await (const resource of list) {
          if (resource.name && resource.tags?.anycloud_resource === scope.id)
            names.push(resource.name);
        }
      } catch (error) {
        if (!isAzureNotFound(error)) throw error;
      }
      return names;
    };
    const network = this.networkClient;
    for (const nic of await tagged(
      network.networkInterfaces.list(this.resourceGroup),
    ))
      await this.deleteNICAndPublicIP(nic);
    for (const ip of await tagged(
      network.publicIPAddresses.list(this.resourceGroup),
    ))
      await deleteAzureResource(
        () => this.deletePublicIP(ip),
        `public IP ${ip}`,
        30,
        10000,
      );
    await this.terminateNetworking(scope.id);
  }

  /** Scope-tagged VMs in the subscription; a deallocated one still exists. */
  private async listResourceVMs(
    scope: CloudResourceScope,
  ): Promise<ResourceVM[]> {
    this.initializeClients();
    const vms: ResourceVM[] = [];
    for await (const vm of this.computeClient.virtualMachines.listAll()) {
      if (!vm.name || vm.tags?.anycloud_resource !== scope.id) continue;
      const view = await this.vmInstanceView(
        vm.id?.split('/')[4] ?? this.resourceGroup,
        vm.name,
      );
      vms.push({
        id: vm.name,
        stopped: !!view.statuses?.some(
          (status) => status.code === 'PowerState/deallocated',
        ),
      });
    }
    return vms;
  }

  private async getAllVMs(): Promise<GatewayVM[]> {
    this.initializeClients();
    const vms: VirtualMachine[] = [];
    const iterator = this.computeClient.virtualMachines.list(
      this.resourceGroup,
    );
    for await (const vm of iterator) {
      vms.push(vm);
    }

    const metadatas = await Promise.all(vms.map((vm) => this.getMetadata(vm)));
    return vms.map((vm, i) => {
      const privateIp =
        metadatas[i].networkInterfaceInfo.ipConfigurations?.[0]
          ?.privateIPAddress;
      const publiclIp = metadatas[i].publicIpInfo.ipAddress;
      return {
        cloudId: vm.name!,
        ip: publiclIp!,
        privateIp,
      };
    });
  }

  private async upsertFirewall(
    ipWhiteList: string[],
    id: string,
    version: string,
    userId: string,
  ): Promise<void> {
    await this.prepareNetwork(
      buildJobIngressSpec(ipWhiteList),
      id,
      version,
      userId,
    );
  }

  private async prepareNetwork(
    spec: IngressSpec,
    id: string,
    version: string,
    userId: string,
    resourceScope?: CloudResourceScope,
  ): Promise<undefined> {
    await this.upsertNetworkSecurityGroup(
      [],
      id,
      version,
      userId,
      spec,
      resourceScope,
    );
    await this.upsertVNet(id, version, userId, resourceScope);
    return undefined;
  }

  private async hasBucketUncoordinated(bucketName: string): Promise<boolean> {
    this.initializeClients();
    const storageInfo = await this.findStorageAccount();
    if (!storageInfo) return false;

    const blobServiceClient = await this.getBlobServiceClient(storageInfo);
    const containerClient = blobServiceClient.getContainerClient(bucketName);
    return containerClient.exists();
  }

  private async listBuckets(
    options: CloudListPageOptions,
  ): Promise<BucketListPage> {
    this.initializeClients();
    const storageInfo = await this.findStorageAccount();
    if (!storageInfo) return { buckets: [], nextCursor: null };

    const client = await this.getBlobServiceClient(storageInfo);
    const page = await client
      .listContainers({ includeMetadata: true })
      .byPage({
        continuationToken: options.cursor,
        maxPageSize: options.pageSize,
      })
      .next();
    if (page.done || !page.value) {
      return { buckets: [], nextCursor: null };
    }
    return {
      buckets: page.value.containerItems.map((container) => {
        const rawCreatedAt = container.metadata?.anycloud_created_at;
        const createdAt = rawCreatedAt ? Number(rawCreatedAt) : NaN;
        return {
          name: container.name,
          region: storageInfo.account.location ?? null,
          createdAt: Number.isFinite(createdAt) ? createdAt : null,
        };
      }),
      // Azure signals "no more pages" with an empty NextMarker, which the SDK
      // surfaces as '' rather than undefined — normalize it to null so the
      // cursor stays nullable across providers.
      nextCursor: page.value.continuationToken || null,
    };
  }

  private async listObjects(
    bucketName: string,
    options: CloudObjectListOptions,
    signal?: AbortSignal,
  ): Promise<BucketEntryPage> {
    this.initializeClients();
    const storageInfo = await this.findStorageAccount();
    if (!storageInfo) {
      throw new Error(
        `Storage account ${this.storageAccountName} not found; cannot list ${bucketName}`,
      );
    }
    const client = await this.getBlobServiceClient(storageInfo);
    const container = client.getContainerClient(bucketName);
    const listOptions = {
      prefix: options.prefix || undefined,
      abortSignal: signal,
    };
    const iterator = options.recursive
      ? container.listBlobsFlat(listOptions)
      : container.listBlobsByHierarchy('/', listOptions);
    const page = await iterator
      .byPage({
        continuationToken: options.cursor,
        maxPageSize: options.pageSize,
      })
      .next();
    if (page.done || !page.value) {
      return { entries: [], nextCursor: null };
    }

    const entries: BucketEntryPage['entries'] = [];
    const segment = page.value.segment as {
      blobPrefixes?: Array<{ name: string }>;
      blobItems: Array<{
        name: string;
        properties: { contentLength?: number; lastModified?: Date };
      }>;
    };
    for (const prefix of segment.blobPrefixes ?? []) {
      entries.push({ kind: 'prefix', key: prefix.name });
    }
    for (const blob of segment.blobItems) {
      entries.push({
        kind: 'object',
        key: blob.name,
        sizeBytes: blob.properties.contentLength ?? null,
        lastModifiedAt: blob.properties.lastModified?.getTime() ?? null,
      });
    }
    // Entries stay in provider order here; the route sorts each page once.
    return {
      entries,
      // Empty NextMarker means the listing is exhausted — see listBuckets.
      nextCursor: page.value.continuationToken || null,
    };
  }

  private bucketCoordinationKey(bucketName: string): string {
    return storageCoordinationKey([this.storageCoordinationPrefix, bucketName]);
  }

  private async upsertBucketUncoordinated(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
  ): Promise<void> {
    await this.ensureStorageInfrastructure();

    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(bucketName);
      const exists = await containerClient.exists();

      if (exists) {
        log.info(`Container ${bucketName} already exists, skipping creation`);
        return;
      }

      log.info(`Creating Azure container: ${bucketName}`);
      try {
        await containerClient.create({
          metadata: {
            ...this.getResourceTags(workloadId, version, userId),
            anycloud_created_at: Date.now().toString(),
          },
        });
        log.info(`Container ${bucketName} created successfully`);
      } catch (createErr) {
        // Many deploys share one output bucket and race between exists() and
        // create(); the losers get ContainerAlreadyExists (409). For an upsert
        // that's success — another deploy just created it. Without this, a burst
        // of concurrent jobs fails to deploy and churns in Retrying forever.
        // Match only the explicit already-exists code: 409 also covers
        // ContainerBeingDeleted, where the container is unusable and sync fails.
        const code = (createErr as { code?: string }).code;
        if (
          code === 'ContainerAlreadyExists' ||
          /already exists/i.test((createErr as Error)?.message ?? '')
        ) {
          log.info(`Container ${bucketName} created concurrently, skipping`);
        } else {
          throw createErr;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        error.message = `Failed to create Azure container ${bucketName}: ${error.message}`;
      }
      throw error;
    }
  }

  private async deleteBucket(
    bucketName: string,
    options: {
      storageInfo?: { resourceGroup: string; account: StorageAccount };
    } = {},
  ): Promise<void> {
    this.initializeClients();

    // Deletes are idempotent across the entire storage hierarchy. If either
    // the shared resource group or account is already gone, the container is
    // necessarily gone too. Probe through ARM before touching the data plane so
    // we do not retry DNS calls against a nonexistent account endpoint.
    const storageInfo =
      options.storageInfo ?? (await this.findStorageAccount());
    if (!storageInfo) return;

    // Tag container with ended_at before deletion
    await this.tagContainerForDeletion(bucketName, storageInfo);

    try {
      const blobServiceClient = await this.getBlobServiceClient(storageInfo);
      const containerClient = blobServiceClient.getContainerClient(bucketName);

      // Delete the container (this deletes all blobs within it)
      await containerClient.delete();
      log.info(`Azure container ${bucketName} deleted successfully`);

      // Wait for deletion to propagate
      await retryUntil(
        async () => {
          try {
            const exists = await containerClient.exists();
            if (exists) {
              throw new Error('Container still exists');
            }
            return { deleted: true };
          } catch (error: any) {
            // 404 means deletion propagated
            if (
              error.statusCode === 404 ||
              error.code === 'ContainerNotFound'
            ) {
              return { deleted: true };
            }
            throw error;
          }
        },
        (result) => result.deleted === true,
        `Azure container ${bucketName} deletion propagation`,
        { maxAttempts: 10, waitMs: 1000 }, // 10 seconds max
      );
      log.info(`Azure container ${bucketName} deletion confirmed`);
    } catch (error: any) {
      // Idempotent - if container doesn't exist, that's fine
      if (await this.isStorageDeletionSatisfied(error)) {
        log.info(
          `Azure container ${bucketName} already deleted or doesn't exist`,
        );
        return;
      }
      if (error instanceof Error) {
        error.message = `Failed to delete Azure container ${bucketName}: ${error.message}`;
      }
      throw error;
    }
  }

  // Data-plane blob I/O against this.storageAccountName. The service principal
  // has management-plane access, including listKeys, but no Blob data-plane
  // role. The controller therefore retrieves a current account key through ARM
  // and uses Shared Key for all container/object operations and to sign VM
  // container SAS tokens. The key grants broad account data access and must
  // never be persisted or logged.
  private async getBlobServiceClient(storageInfo?: {
    resourceGroup: string;
    account: StorageAccount;
  }): Promise<BlobServiceClient> {
    return createAzureBlobServiceClient(
      this.storageAccountName,
      await this.accountKey(storageInfo),
    );
  }

  private accountKey(storageInfo?: {
    resourceGroup: string;
    account: StorageAccount;
  }): Promise<string> {
    return memoizeAsyncTtl(
      storageAccountKeys,
      this.storageAccountCacheKey(),
      () => this.listAccountKey(storageInfo),
      { ttlMs: AZURE_STORAGE_ACCOUNT_TTL_MS },
    );
  }

  private async listAccountKey(storageInfo?: {
    resourceGroup: string;
    account: StorageAccount;
  }): Promise<string> {
    const found = storageInfo ?? (await this.findStorageAccount());
    if (!found) {
      throw new Error(
        `Storage account ${this.storageAccountName} not found; cannot fetch keys`,
      );
    }
    if (found.account.allowSharedKeyAccess === false) {
      throw azureSharedKeyDisabledError(this.storageAccountName);
    }
    const keysResponse = await this.storageClient.storageAccounts.listKeys(
      found.resourceGroup,
      this.storageAccountName,
    );
    const key = keysResponse.keys?.[0]?.value;
    if (!key) {
      throw new Error(
        `No access keys returned for storage account ${this.storageAccountName}`,
      );
    }
    return key;
  }

  /**
   * A container SAS for VM bucket sync (RFC 0047): read and list for input,
   * full access for output and checkpoints. A prefix grant gets a directory
   * SAS that creates and writes but never deletes (RFC 0043). Signed with the
   * account key, so neither a VM nor a replica needs an identity; its expiry
   * drives renewal. It lasts `lifetimeMs` exactly, else 36 hours.
   */
  private async mintSas(
    grants: ScopedStorageGrant[],
    lifetimeMs = AZURE_SAS_TTL_MS,
  ): Promise<ScopedStorageToken | undefined> {
    if (grants.length === 0) return undefined;
    const scopes = new Set(grants.map((g) => `${g.bucket}/${g.prefix ?? ''}`));
    if (scopes.size !== 1) {
      throw new Error(
        `An Azure SAS covers one container or directory; got ${scopes.size}`,
      );
    }
    const { bucket, prefix } = grants[0]!;
    const readwrite = grants.some((grant) => grant.mode === 'readwrite');
    const noDelete = grants.every((grant) => grant.noDelete);
    const now = Date.now();
    // The SAS carries whole seconds.
    const expiresAt = Math.floor((now + lifetimeMs) / 1000) * 1000;
    const grant = {
      startsOn: new Date(now - AZURE_SAS_CLOCK_SKEW_MS),
      expiresOn: new Date(expiresAt),
    };
    const key = await this.accountKey();
    const sasToken =
      prefix === undefined
        ? azureContainerSas(this.storageAccountName, key, bucket, {
            ...grant,
            permissions: readwrite ? (noDelete ? 'rcwl' : 'racwdl') : 'rl',
          })
        : azureDirectorySas(this.storageAccountName, key, bucket, prefix, {
            ...grant,
            // rclone lists and reads beside creating and writing.
            permissions: readwrite ? 'rcwl' : 'rl',
          });
    return {
      credentials: { cloudProvider: CloudType.Azure, sasToken },
      expiresAt,
    };
  }

  private async uploadObject(
    bucketName: string,
    remotePath: string,
    source: CloudUploadSource,
  ): Promise<void> {
    await this.ensureStorageInfrastructure();
    const client = await this.getBlobServiceClient();
    const containerClient = client.getContainerClient(bucketName);
    const blockBlobClient = containerClient.getBlockBlobClient(remotePath);
    await blockBlobClient.uploadStream(openCloudUploadSource(source));
  }

  private async deleteObject(
    bucketName: string,
    remotePath: string,
  ): Promise<void> {
    this.initializeClients();
    const storageInfo = await this.findStorageAccount();
    if (!storageInfo) return;

    try {
      const client = await this.getBlobServiceClient(storageInfo);
      const containerClient = client.getContainerClient(bucketName);
      const blockBlobClient = containerClient.getBlockBlobClient(remotePath);
      await blockBlobClient.deleteIfExists();
    } catch (error) {
      if (await this.isStorageDeletionSatisfied(error)) return;
      throw error;
    }
  }

  private async downloadObject(
    bucketName: string,
    remotePath: string,
  ): Promise<{ stream: Readable; contentLength?: number }> {
    this.initializeClients();
    const client = await this.getBlobServiceClient();
    const containerClient = client.getContainerClient(bucketName);
    const blockBlobClient = containerClient.getBlockBlobClient(remotePath);
    const response = await blockBlobClient.download();
    if (!response.readableStreamBody) {
      throw new Error(
        `Empty response body for azure://${bucketName}/${remotePath}`,
      );
    }
    return {
      stream: response.readableStreamBody as Readable,
      contentLength: response.contentLength,
    };
  }

  /**
   * Validate Azure credentials by attempting to list resource groups.
   * This is a lightweight API call that will fail fast if credentials are invalid.
   */
  private async validateCredentials(): Promise<void> {
    const credentials = this.createManagementCredential();

    const resourcesClient = createAzureResourceManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      armClientOptions(),
    );

    // Try to list resource groups - this will fail if credentials are invalid
    const iterator = resourcesClient.resourceGroups.list();
    // Just get the first one to validate credentials work
    await iterator.next();
  }

  // After bounded consumer recovery is exhausted, an invalid/expired/wrong
  // service-principal secret (AADSTS7000215/7000222/invalid_client) warrants the
  // durable invalid mark. Deliberately narrower than isAzureTerminalAuthError:
  // this excludes ARM stale-token codes (ExpiredAuthenticationToken etc.) and
  // AuthorizationPermissionMismatch, which must follow their ordinary retry or
  // request-classification paths instead of durably stranding a credential.
  isTerminalAuthError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as { message?: unknown; Message?: unknown };
    const msg = err.message ?? err.Message ?? '';
    return typeof msg === 'string' && AZURE_BAD_SECRET_MESSAGE_RE.test(msg);
  }

  /**
   * Account-wide container cleanup. Unlike VMs/disks/NICs (which are
   * resource-group-scoped), containers all live in the single shared
   * storage account in RESOURCE_GROUP_BASE. Calling listContainers once
   * per region against the same storage account is 20× redundant, so this
   * runs once globally from ci/cleanup/azure.ts after the per-region
   * fan-out.
   */
  private async sweepStorage(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult> {
    this.initializeClients();

    const dryRun = options.dryRun ?? false;
    const result: ResourceSweepResult = {
      vmIds: [],
      otherResources: [],
      errors: [],
    };

    let storageInfo: {
      resourceGroup: string;
      account: StorageAccount;
    } | null;
    try {
      storageInfo = await this.findStorageAccount();
      if (!storageInfo) return result;
    } catch (error) {
      result.errors.push({
        resourceType: 'container',
        resourceId: 'storage-account',
        error: (error as Error).message,
      });
      return result;
    }

    try {
      const blobServiceClient = await this.getBlobServiceClient(storageInfo);

      for await (const container of blobServiceClient.listContainers({
        includeMetadata: true,
      })) {
        if (!container.name) continue;

        const metadata = container.metadata || {};
        if (
          !metadata.anycloud_deployment &&
          container.name !== options.policy.installation?.clusterId
        )
          continue;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(metadata),
            endedAt: metadata.anycloud_ended_at,
            createdAt:
              metadata.anycloud_created_at ??
              container.properties?.lastModified,
            name: container.name,
            spare: { into: result, type: 'container', id: container.name },
          },
          options.policy,
        );
        if (!isOrphaned) continue;

        if (dryRun) {
          result.otherResources.push({
            type: 'container',
            id: container.name,
          });
          continue;
        }

        try {
          await this.deleteBucket(container.name, {
            storageInfo,
          });
          result.otherResources.push({
            type: 'container',
            id: container.name,
          });
          log.info('Cleaned up orphaned Azure container', {
            containerName: container.name,
            workload: metadata.anycloud_deployment,
          });
        } catch (error) {
          result.errors.push({
            resourceType: 'container',
            resourceId: container.name,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      if (await this.isStorageDeletionSatisfied(error)) return result;
      log.error('Error listing Azure containers for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'container',
        resourceId: 'list-containers',
        error: (error as Error).message,
      });
    }

    return result;
  }

  /** Regions with an `anycloud-<region>` group; the storage group is separate. */
  private async sweepLocations(): Promise<string[]> {
    this.initializeClients();
    const regions: string[] = [];
    for await (const group of this.resourcesClient.resourceGroups.list()) {
      // Only the group this gateway would name for the region, never a
      // user's own `anycloud-*` group.
      if (
        group.location &&
        group.name === `${RESOURCE_GROUP_BASE}-${group.location}`
      ) {
        regions.push(group.location);
      }
    }
    return [...new Set(regions)];
  }

  /**
   * The power state is only in the instance view. Expanding a GET needs only
   * `virtualMachines/read`, which the published role grants.
   */
  private async vmInstanceView(resourceGroup: string, name: string) {
    const vm = await this.computeClient.virtualMachines.get(
      resourceGroup,
      name,
      { expand: 'instanceView' },
    );
    return { statuses: vm.instanceView?.statuses };
  }

  /** Whether a VM-host workload's VM is running, for an installation sweep. */
  private async sweptVmRunning(
    vm: VirtualMachine,
    options: ResourceSweepOptions,
  ): Promise<boolean | undefined> {
    const tags = vm.tags ?? {};
    if (
      !options.policy.installation?.spareRunningWorkloads ||
      !tags.anycloud_deployment ||
      tags.anycloud_resource ||
      !vm.name
    ) {
      return undefined;
    }
    // Unknown or unreadable counts as running, so a sweep never takes a live
    // workload.
    const view = await this.vmInstanceView(this.resourceGroup, vm.name).catch(
      () => ({ statuses: undefined }),
    );
    return !view.statuses?.some((status) =>
      ['PowerState/deallocated', 'PowerState/stopped'].includes(
        status.code ?? '',
      ),
    );
  }

  private async sweepResources(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult> {
    this.initializeClients();

    const dryRun = options.dryRun ?? false;
    const result: ResourceSweepResult = {
      vmIds: [],
      otherResources: [],
      errors: [],
    };

    try {
      if (!(await this.regionalResourceGroupExists())) return result;
    } catch (error) {
      result.errors.push({
        resourceType: 'resourceGroup',
        resourceId: this.resourceGroup,
        error: (error as Error).message,
      });
      return result;
    }

    // 1. Find and cleanup orphaned VMs (including their disks, NICs, and public IPs)
    try {
      const vms: VirtualMachine[] = [];
      const iterator = this.computeClient.virtualMachines.list(
        this.resourceGroup,
      );
      for await (const vm of iterator) {
        vms.push(vm);
      }

      // Delete VMs in parallel (each VM's resources are deleted sequentially)
      const vmDeletions = vms.map(async (vm) => {
        const tags = vm.tags || {};

        const resourceOwner =
          tags.anycloud_resource ?? tags.anycloud_deployment;
        if (!resourceOwner) return;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(tags),
            endedAt: tags.anycloud_ended_at,
            createdAt: tags.anycloud_created_at ?? vm.timeCreated,
            running: await this.sweptVmRunning(vm, options),
            spare: { into: result, type: 'vm', id: vm.name },
          },
          options.policy,
        );

        if (isOrphaned && vm.name) {
          if (dryRun) {
            result.vmIds.push(vm.name);
          } else {
            try {
              // Get disk name before deleting VM
              let diskName: string | undefined;
              try {
                diskName = vm.storageProfile?.osDisk?.name;
              } catch {
                // VM may not have disk info
              }

              // Delete VM
              await deleteAzureResource(
                () => this.deleteVirtualMachine(vm.name!),
                `virtual machine ${vm.name}`,
                180,
                10000,
              );
              result.vmIds.push(vm.name);
              log.info('Cleaned up orphaned VM', {
                vmName: vm.name,
                resourceOwner,
              });

              // Delete disk if exists
              if (diskName) {
                try {
                  await deleteAzureResource(
                    () => this.deleteDisk(diskName!),
                    `disk ${diskName}`,
                    180,
                    10000,
                  );
                  result.otherResources.push({
                    type: 'disk',
                    id: diskName,
                  });
                  log.info('Cleaned up orphaned disk', { diskName });
                } catch (error) {
                  result.errors.push({
                    resourceType: 'disk',
                    resourceId: diskName,
                    error: (error as Error).message,
                  });
                }
              }

              // Delete NIC and Public IP in correct order
              try {
                await this.deleteNICAndPublicIP(vm.name!);
                result.otherResources.push({
                  type: 'nic',
                  id: vm.name,
                });
                result.otherResources.push({
                  type: 'publicIp',
                  id: vm.name,
                });
                log.info('Cleaned up orphaned NIC', { nicName: vm.name });
                log.info('Cleaned up orphaned public IP', {
                  publicIpName: vm.name,
                });
              } catch (error) {
                result.errors.push({
                  resourceType: 'nic/publicIp',
                  resourceId: vm.name,
                  error: (error as Error).message,
                });
              }
            } catch (error) {
              result.errors.push({
                resourceType: 'vm',
                resourceId: vm.name,
                error: (error as Error).message,
              });
            }
          }
        }
      });

      await Promise.allSettled(vmDeletions);
    } catch (error) {
      if (isAzureNotFound(error)) return result;
      log.error('Error listing VMs for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'vm',
        resourceId: 'list-vms',
        error: (error as Error).message,
      });
    }

    // 2. Find and cleanup orphaned Public IPs (must delete before NICs since Public IPs are attached to NICs)
    try {
      const publicIps = [];
      const iterator = this.networkClient.publicIPAddresses.list(
        this.resourceGroup,
      );
      for await (const publicIp of iterator) {
        publicIps.push(publicIp);
      }

      // Delete public IPs in parallel
      const publicIpDeletions = publicIps.map(async (publicIp) => {
        const tags = publicIp.tags || {};

        const resourceOwner =
          tags.anycloud_resource ?? tags.anycloud_deployment;
        if (!resourceOwner) return;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(tags),
            endedAt: tags.anycloud_ended_at,
            createdAt: tags.anycloud_created_at,
            detached: !publicIp.ipConfiguration, // Not attached to any NIC
            spare: { into: result, type: 'publicIp', id: publicIp.name },
          },
          options.policy,
        );

        if (isOrphaned && publicIp.name) {
          if (dryRun) {
            result.otherResources.push({
              type: 'publicIp',
              id: publicIp.name,
            });
          } else {
            try {
              await deleteAzureResource(
                () => this.deletePublicIP(publicIp.name!),
                `public IP ${publicIp.name}`,
                30,
                10000,
              );
              result.otherResources.push({
                type: 'publicIp',
                id: publicIp.name,
              });
              log.info('Cleaned up orphaned public IP', {
                publicIpName: publicIp.name,
                resourceOwner,
              });
            } catch (error) {
              result.errors.push({
                resourceType: 'publicIp',
                resourceId: publicIp.name,
                error: (error as Error).message,
              });
            }
          }
        }
      });

      await Promise.allSettled(publicIpDeletions);
    } catch (error) {
      if (isAzureNotFound(error)) return result;
      log.error('Error listing public IPs for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'publicIp',
        resourceId: 'list-publicips',
        error: (error as Error).message,
      });
    }

    // 3. Find and cleanup orphaned NICs (that aren't attached to VMs)
    // This must happen after Public IP cleanup and before NSG cleanup
    try {
      const nics = [];
      const iterator = this.networkClient.networkInterfaces.list(
        this.resourceGroup,
      );
      for await (const nic of iterator) {
        nics.push(nic);
      }

      // Delete NICs in parallel
      const nicDeletions = nics.map(async (nic) => {
        const tags = nic.tags || {};

        const resourceOwner =
          tags.anycloud_resource ?? tags.anycloud_deployment;
        if (!resourceOwner) return;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(tags),
            endedAt: tags.anycloud_ended_at,
            createdAt: tags.anycloud_created_at,
            detached: !nic.virtualMachine, // Not attached to any VM
            spare: { into: result, type: 'nic', id: nic.name },
          },
          options.policy,
        );

        if (isOrphaned && nic.name) {
          if (dryRun) {
            result.otherResources.push({
              type: 'nic',
              id: nic.name,
            });
          } else {
            try {
              await deleteAzureResource(
                () => this.deleteNetworkInterfaces(nic.name!),
                `network interface ${nic.name}`,
                30, // 30 attempts × 10s = 5 min
                10000,
              );
              result.otherResources.push({
                type: 'nic',
                id: nic.name,
              });
              log.info('Cleaned up orphaned NIC', {
                nicName: nic.name,
                resourceOwner,
              });
            } catch (error) {
              log.error('Failed to delete orphaned NIC', {
                id: 'system',
                nicName: nic.name,
                error,
              });
              result.errors.push({
                resourceType: 'nic',
                resourceId: nic.name,
                error: (error as Error).message,
              });
            }
          }
        }
      });

      await Promise.allSettled(nicDeletions);
    } catch (error) {
      if (isAzureNotFound(error)) return result;
      log.error('Error listing NICs for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'nic',
        resourceId: 'list-nics',
        error: (error as Error).message,
      });
    }

    // 4. Find and cleanup orphaned NSGs
    try {
      const nsgs: NetworkSecurityGroup[] = [];
      const iterator = this.networkClient.networkSecurityGroups.list(
        this.resourceGroup,
      );
      for await (const nsg of iterator) {
        nsgs.push(nsg);
      }

      // Delete NSGs in parallel
      const nsgDeletions = nsgs.map(async (nsg) => {
        const tags = nsg.tags || {};

        const resourceOwner =
          tags.anycloud_resource ?? tags.anycloud_deployment;
        if (!resourceOwner) return;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(tags),
            endedAt: tags.anycloud_ended_at,
            createdAt: tags.anycloud_created_at,
            // Idle and past the minimum age, so a concurrent launch can't race it.
            detached:
              !nsg.networkInterfaces?.length &&
              !nsg.subnets?.length &&
              isOlderThan(tags.anycloud_created_at, options.policy.minAgeMs),
            spare: { into: result, type: 'nsg', id: nsg.name },
          },
          options.policy,
        );

        if (isOrphaned && nsg.name) {
          if (dryRun) {
            result.otherResources.push({
              type: 'nsg',
              id: nsg.name,
            });
          } else {
            try {
              // Tag NSG before deletion (idempotent - resources already tagged as orphaned)
              await this.tagNSGForDeletion(nsg.name);

              await deleteAzureResource(
                () => this.removeFirewalls(nsg.name!),
                `network security group ${nsg.name}`,
                180,
                10000,
              );
              result.otherResources.push({
                type: 'nsg',
                id: nsg.name,
              });
              log.info('Cleaned up orphaned NSG', {
                nsgName: nsg.name,
                resourceOwner,
              });
            } catch (error) {
              result.errors.push({
                resourceType: 'nsg',
                resourceId: nsg.name,
                error: (error as Error).message,
              });
            }
          }
        }
      });

      await Promise.allSettled(nsgDeletions);
    } catch (error) {
      if (isAzureNotFound(error)) return result;
      log.error('Error listing NSGs for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'nsg',
        resourceId: 'list-nsgs',
        error: (error as Error).message,
      });
    }

    // 5. Find and cleanup orphaned VNets
    try {
      const vnets = [];
      const iterator = this.networkClient.virtualNetworks.list(
        this.resourceGroup,
      );
      for await (const vnet of iterator) {
        vnets.push(vnet);
      }

      for (const vnet of vnets) {
        const tags = vnet.tags || {};

        const resourceOwner =
          tags.anycloud_resource ?? tags.anycloud_deployment;
        if (!resourceOwner) continue;

        const hasAttachedResources = vnet.subnets?.some(
          (s) => s.ipConfigurations?.length,
        );
        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(tags),
            endedAt: tags.anycloud_ended_at,
            createdAt: tags.anycloud_created_at,
            detached:
              !hasAttachedResources &&
              isOlderThan(tags.anycloud_created_at, options.policy.minAgeMs),
            spare: { into: result, type: 'vnet', id: vnet.name },
          },
          options.policy,
        );

        if (isOrphaned && vnet.name) {
          if (dryRun) {
            result.otherResources.push({
              type: 'vnet',
              id: vnet.name,
            });
          } else {
            try {
              // Tag VNet before deletion (idempotent - resources already tagged as orphaned)
              await this.tagVNetForDeletion(vnet.name);

              await deleteAzureResource(
                () => this.removeVirtualNetwork(vnet.name!),
                `virtual network ${vnet.name}`,
                180,
                10000,
              );
              result.otherResources.push({
                type: 'vnet',
                id: vnet.name,
              });
              log.info('Cleaned up orphaned VNet', {
                vnetName: vnet.name,
                resourceOwner,
              });
            } catch (error) {
              result.errors.push({
                resourceType: 'vnet',
                resourceId: vnet.name,
                error: (error as Error).message,
              });
            }
          }
        }
      }
    } catch (error) {
      if (isAzureNotFound(error)) return result;
      log.error('Error listing VNets for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'vnet',
        resourceId: 'list-vnets',
        error: (error as Error).message,
      });
    }

    // Container cleanup is handled by the account-wide storage sweep
    // pass (called once from ci/cleanup/azure.ts), not per-region. Azure
    // containers live in a single shared storage account, so a per-region
    // fan-out would run the same `listContainers` 20× against the same
    // endpoint for no benefit.

    // 7. Find and cleanup orphaned standalone disks (not already deleted with their VMs)
    try {
      const diskDeletions = [];
      for await (const disk of this.computeClient.disks.listByResourceGroup(
        this.resourceGroup,
      )) {
        const tags = disk.tags || {};

        const resourceOwner =
          tags.anycloud_resource ?? tags.anycloud_deployment;
        if (!resourceOwner) continue;

        const owner = sweepOwner(tags);
        const isOrphaned =
          isResourceSweepCandidate(
            {
              ...owner,
              endedAt: tags.anycloud_ended_at,
              spare: { into: result, type: 'disk', id: disk.name },
            },
            options.policy,
          ) ||
          (disk.diskState === 'Unattached' &&
            isResourceSweepCandidate(
              {
                ...owner,
                createdAt: tags.anycloud_created_at ?? disk.timeCreated,
              },
              options.policy,
            ));

        if (isOrphaned && disk.name) {
          if (dryRun) {
            result.otherResources.push({
              type: 'disk',
              id: disk.name,
            });
          } else {
            diskDeletions.push(
              (async () => {
                try {
                  await deleteAzureResource(
                    () => this.deleteDisk(disk.name!),
                    `standalone disk ${disk.name}`,
                    30,
                    10000,
                  );
                  result.otherResources.push({
                    type: 'disk',
                    id: disk.name!,
                  });
                  log.info('Cleaned up orphaned standalone disk', {
                    diskName: disk.name,
                  });
                } catch (error) {
                  result.errors.push({
                    resourceType: 'disk',
                    resourceId: disk.name!,
                    error: (error as Error).message,
                  });
                }
              })(),
            );
          }
        }
      }

      await Promise.allSettled(diskDeletions);
    } catch (error) {
      if (isAzureNotFound(error)) return result;
      log.error('Error listing disks for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'disk',
        resourceId: 'list-disks',
        error: (error as Error).message,
      });
    }

    return result;
  }

  // Private methods

  /** Read-only existence probe; this must never create the regional group. */
  private async regionalResourceGroupExists(): Promise<boolean> {
    this.initializeClients();
    try {
      await this.resourcesClient.resourceGroups.get(this.resourceGroup);
      return true;
    } catch (error) {
      if (isAzureNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * A delete is complete when Azure reports the target missing, or when a
   * follow-up management-plane probe confirms that the whole shared storage
   * account disappeared during the data-plane operation. The follow-up probe
   * keeps transient DNS/auth failures visible while making deletion races safe.
   */
  private async isStorageDeletionSatisfied(error: unknown): Promise<boolean> {
    const code = (error as { code?: string })?.code;
    if (
      isAzureNotFound(error) ||
      code === 'ContainerNotFound' ||
      code === 'BlobNotFound'
    ) {
      return true;
    }

    this.forgetStorageAccount();
    try {
      return (await this.findStorageAccount()) === null;
    } catch {
      return false;
    }
  }

  /** Build the credential shared by one generation of Azure ARM clients. */
  private createManagementCredential(): TokenCredential {
    return createAzureCredential(this.azConfig.credentials);
  }

  private managementClientOptions() {
    return {
      ...armClientOptions(),
      retryOptions: {
        maxRetries: 10,
        retryDelayInMs: 1000,
      },
    };
  }

  /** Management client options that log each Storage RP 429 the SDK retries. */
  private storageClientOptions() {
    const options = this.managementClientOptions();
    const throttleLog: PipelinePolicy = {
      name: 'anycloudStorageRpThrottleLog',
      sendRequest: async (request, next) => {
        const response = await next(request);
        if (response.status === 429) {
          log.warn(
            `Azure Storage resource provider throttled a request for storage account ${this.storageAccountName}`,
            {
              code: 'AZURE_STORAGE_RP_THROTTLED',
              retryAfterMs: retryAfterMs(response.headers, Date.now()),
            },
          );
        }
        return response;
      },
    };
    return {
      ...options,
      additionalPolicies: [
        ...(options.additionalPolicies ?? []),
        { policy: throttleLog, position: 'perRetry' as const },
      ],
    };
  }

  /**
   * Recreate the ARM clients used by storage so the next recovery attempt gets
   * a fresh access token. Compute and network clients are unrelated to the
   * failed storage operation and keep their existing sessions.
   */
  private refreshStorageAuthentication(): void {
    this.forgetStorageAccount();
    const credentials = this.createManagementCredential();
    const clientOptions = this.managementClientOptions();
    this.resourcesClient = createAzureResourceManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      clientOptions,
    );
    this.storageClient = createAzureStorageManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      this.storageClientOptions(),
    );
  }

  /** Construct Azure SDK clients without making any Azure API calls. */
  private initializeClients(): void {
    if (
      this.computeClient &&
      this.resourcesClient &&
      this.networkClient &&
      this.storageClient
    ) {
      return;
    }

    const credentials = this.createManagementCredential();

    // Configure aggressive retries for transient errors
    // Azure SDK uses @azure/core-rest-pipeline with built-in retry policy
    const clientOptions = this.managementClientOptions();

    this.computeClient ??= createAzureComputeManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      clientOptions,
    );
    this.resourcesClient ??= createAzureResourceManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      clientOptions,
    );
    this.networkClient ??= createAzureNetworkManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      clientOptions,
    );
    this.storageClient ??= createAzureStorageManagementClient(
      credentials,
      this.azConfig.credentials.subscriptionId,
      this.storageClientOptions(),
    );
  }

  private ensureRegionalInfrastructure(): Promise<void> {
    this.initializeClients();
    return memoizeAsync(this.initializationInFlight, 'regional', async () => {
      await this.upsertResourceGroup();
      await this.registerResourceProviders([
        'Microsoft.Compute',
        'Microsoft.Network',
      ]);
    });
  }

  private ensureStorageInfrastructure(): Promise<void> {
    this.initializeClients();
    return memoizeAsync(this.initializationInFlight, 'storage', async () => {
      await this.registerResourceProviders(['Microsoft.Storage']);
      await this.ensureStorageAccount();
    });
  }

  /** Integration tests' full setup: regional and storage infrastructure. */
  async initializeAzure(): Promise<void> {
    await Promise.all([
      this.ensureRegionalInfrastructure(),
      this.ensureStorageInfrastructure(),
    ]);
  }

  private async terminateVM(vmId: string) {
    this.initializeClients();

    // New VMs delete their OS disk with them (deleteOption: Delete); a VM
    // created before that detaches it, so read the name while the VM exists.
    let vm: VirtualMachine | undefined;
    try {
      vm = await this.getVirtualMachine(vmId);
    } catch (error) {
      if (!isAzureNotFound(error)) throw error;
    }
    const diskName = vm?.storageProfile?.osDisk?.name;

    // Tag directly-attached resources before destructive substeps so cleanup can
    // recover if VM deletion fails before deleteNICAndPublicIP runs.
    await this.tagVMForDeletion(vmId);
    await this.tagNICForDeletion(vmId);

    if (vm) await this.shutDownGuest(vmId);

    // Delete VM with retry
    await deleteAzureResource(
      () => this.deleteVirtualMachine(vmId),
      `virtual machine ${vmId}`,
      180,
      10000,
    );

    // NotFound, the usual answer for a new VM, counts as deleted.
    if (diskName) {
      try {
        await deleteAzureResource(
          () => this.deleteDisk(diskName),
          `disk ${diskName}`,
          180,
          10000,
        );
      } catch (error) {
        // The VM is gone, so a retry can no longer name this disk.
        log.error('Azure OS disk outlived its deleted VM', {
          id: 'system',
          vmName: vmId,
          diskName,
          error,
        });
        throw error;
      }
    }

    // Delete NIC and Public IP in correct order
    await this.deleteNICAndPublicIP(vmId);
  }

  private async deleteNICAndPublicIP(vmId: string): Promise<void> {
    // Tag NIC before deletion
    await this.tagNICForDeletion(vmId);

    // Delete NIC first (Public IP is attached to NIC, Azure requires this order)
    await deleteAzureResource(
      () => this.deleteNetworkInterfaces(vmId),
      `network interface ${vmId}`,
      30, // 30 attempts × 10s = 5 minutes (handles 180s NIC reservation)
      10000,
    );

    // Tag Public IP before deletion
    await this.tagPublicIPForDeletion(vmId);

    // Delete Public IP after NIC is freed
    await deleteAzureResource(
      () => this.deletePublicIP(vmId),
      `public IP ${vmId}`,
      30,
      10000,
    );
  }

  private async getVirtualMachine(name: string) {
    return this.computeClient.virtualMachines.get(this.resourceGroup, name);
  }

  // Azure's pollUntilDone() can hang indefinitely (see VM creation comment).
  // Cap each deletion poll so deleteWithRetry can actually retry on the next attempt.
  private static POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  // Tagging a healthy VM takes seconds; past this, delete it untagged.
  private static TAG_TIMEOUT_MS = 60 * 1000;

  // Azure's delete powers the VM off without a guest shutdown. AWS and GCP
  // shut the guest down first, so systemd stops Docker and each container gets
  // SIGTERM. A graceful power-off gives the guest the same stop; a guest that
  // has not stopped within the bound is deleted anyway.
  private static GUEST_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

  private async shutDownGuest(name: string): Promise<void> {
    try {
      await withTimeout(
        (async () => {
          const poller = await this.computeClient.virtualMachines.beginPowerOff(
            this.resourceGroup,
            name,
            { skipShutdown: false },
          );
          await poller.pollUntilDone();
        })(),
        Azure.GUEST_SHUTDOWN_TIMEOUT_MS,
        `powerOffVM ${name}`,
      );
    } catch (error) {
      // Termination proceeds whatever the power-off's outcome. A 409 is
      // routine: an evicted spot VM is already deallocated.
      if (!isAzureNotFound(error) && (error as any)?.statusCode !== 409) {
        log.warn(`[${name}] Graceful power-off failed; deleting the VM`, {
          id: 'system',
          vmName: name,
          error,
        });
      }
    }
  }

  private async deleteVirtualMachine(name: string) {
    const poller = await this.computeClient.virtualMachines.beginDelete(
      this.resourceGroup,
      name,
    );
    return withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `deleteVM ${name}`,
    );
  }

  private async deleteNetworkInterfaces(name: string) {
    const poller = await this.networkClient.networkInterfaces.beginDelete(
      this.resourceGroup,
      name,
    );
    return withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `deleteNIC ${name}`,
    );
  }

  private async deleteDisk(name: string) {
    const poller = await this.computeClient.disks.beginDelete(
      this.resourceGroup,
      name,
    );
    return withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `deleteDisk ${name}`,
    );
  }

  private async deletePublicIP(name: string) {
    const poller = await this.networkClient.publicIPAddresses.beginDelete(
      this.resourceGroup,
      name,
    );
    return withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `deleteIP ${name}`,
    );
  }

  private async getMetadata(vm: VirtualMachine) {
    if (!vm.name) {
      throw new Error('VM has no name — cannot fetch metadata');
    }
    const networkInterfaceInfo = await this.networkClient.networkInterfaces.get(
      this.resourceGroup,
      vm.name,
    );
    const publicIpInfo = await this.networkClient.publicIPAddresses.get(
      this.resourceGroup,
      vm.name,
    );

    const firewalls: NetworkSecurityGroup[] = [];
    const firewallIterator = this.networkClient.networkSecurityGroups.list(
      this.resourceGroup,
    );
    for await (const firewall of firewallIterator) {
      firewalls.push(firewall);
    }

    const possibleFirewall = firewalls
      .filter((f) => f.id == networkInterfaceInfo.networkSecurityGroup?.id)
      .pop();
    const firewallName = possibleFirewall ? possibleFirewall.name : undefined;
    return {
      networkInterfaceInfo,
      publicIpInfo,
      firewallName,
    };
  }

  private async getImageId(baseImageProps: AzureMarketplaceImageProps) {
    const imageInfo = await this.computeClient.virtualMachineImages.list(
      this.azConfig.region,
      baseImageProps.publisher,
      baseImageProps.offer,
      baseImageProps.sku,
      { orderby: 'name' },
    );
    // Get the most recent image
    return imageInfo.pop()!.name;
  }

  private async upsertResourceGroup() {
    try {
      await this.resourcesClient.resourceGroups.get(this.resourceGroup);
      return;
    } catch (error: any) {
      if (error?.statusCode !== 404 && error?.code !== 'ResourceNotFound') {
        throw error;
      }
    }
    await this.resourcesClient.resourceGroups.createOrUpdate(
      this.resourceGroup,
      {
        location: this.azConfig.region,
        tags: { managed_by: 'anycloud' },
      },
    );
  }

  private async registerResourceProviders(
    requiredProviders = [
      'Microsoft.Compute',
      'Microsoft.Network',
      'Microsoft.Storage',
    ],
  ) {
    // Register required Azure resource providers for the subscription
    // This is needed before creating VMs, networks, or storage resources
    for (const providerNamespace of requiredProviders) {
      try {
        // Check current registration state
        const provider =
          await this.resourcesClient.providers.get(providerNamespace);

        if (provider.registrationState === 'Registered') {
          // Already registered, skip
          continue;
        }

        // Register the provider (this is idempotent)
        await this.resourcesClient.providers.register(providerNamespace);
        if (providerNamespace === 'Microsoft.Compute') {
          this.invalidateCatalogOverlay('compute-registration-started');
        }

        // Note: Registration happens asynchronously on Azure's side
        // We don't wait for it to complete - subsequent API calls will queue until ready
      } catch (error) {
        // Log but don't fail - the provider might already be registered
        // or the error might be transient
        log.info(
          `Note: Could not register provider ${providerNamespace}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Find the storage account by direct lookup in the known resource group.
   * Returns the resource group and account if found, null otherwise.
   */
  async findStorageAccount(): Promise<{
    resourceGroup: string;
    account: StorageAccount;
  } | null> {
    this.initializeClients();
    return memoizeAsyncTtl(
      storageAccountLookups,
      this.storageAccountCacheKey(),
      () => this.lookupStorageAccount(),
      {
        ttlMs: AZURE_STORAGE_ACCOUNT_TTL_MS,
        // A missing account may be created next, so only a found one is kept.
        shouldCache: (found) => found !== null,
      },
    );
  }

  /** Forget the cached account and key when the data plane rejects the key. */
  private async withAccountKey<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const { statusCode, code } = (error ?? {}) as {
        statusCode?: number;
        code?: string;
      };
      // A rotated key, or shared-key access turned off: the next call reads
      // the account and key again and reports which.
      if (
        statusCode === 403 &&
        (code === 'AuthenticationFailed' ||
          code === 'KeyBasedAuthenticationNotPermitted')
      ) {
        this.forgetStorageAccount();
      }
      throw error;
    }
  }

  /** The credential's key into the process-wide storage account cache. */
  private storageAccountCacheKey(): string {
    const creds = this.azConfig.credentials as AzureConnectionCreds;
    // The VM's own identity is one per subscription's management VM.
    if ('kind' in creds && creds.kind === 'instance')
      return storageCoordinationKey([
        this.storageCoordinationPrefix,
        creds.directoryId,
        'instance',
      ]);
    return storageCoordinationKey([
      this.storageCoordinationPrefix,
      creds.directoryId,
      creds.applicationId,
      // Only the secret, or a role's trust, proves the credential: another
      // entry with the same IDs but a wrong secret or issuer must not reuse
      // this key.
      'kind' in creds
        ? JSON.stringify([creds.issuer, creds.audience, creds.subject])
        : createHash('sha256').update(creds.secret).digest('hex'),
    ]);
  }

  private forgetStorageAccount(): void {
    storageAccountLookups.delete(this.storageAccountCacheKey());
    storageAccountKeys.delete(this.storageAccountCacheKey());
  }

  private async lookupStorageAccount(): Promise<{
    resourceGroup: string;
    account: StorageAccount;
  } | null> {
    try {
      const account = await this.storageClient.storageAccounts.getProperties(
        this.storageResourceGroup,
        this.storageAccountName,
      );
      return { resourceGroup: this.storageResourceGroup, account };
    } catch (error: any) {
      if (isAzureNotFound(error)) return null;
      throw error;
    }
  }

  private async ensureStorageResourceGroup(): Promise<void> {
    // Create storage resource group if it doesn't exist
    const groupParameters = {
      location: this.region,
      tags: { managed_by: 'anycloud' },
    };
    try {
      await this.resourcesClient.resourceGroups.createOrUpdate(
        this.storageResourceGroup,
        groupParameters,
      );
    } catch (error: any) {
      // Resource group already exists in a different region — that's fine,
      // storage resources are subscription-scoped and any region works.
      if (error.code === 'InvalidResourceGroupLocation') {
        log.info(
          `Storage resource group ${this.storageResourceGroup} already exists in a different region, reusing`,
        );
        return;
      }
      throw error;
    }
  }

  private async ensureStorageAccount(): Promise<void> {
    try {
      // Check if storage account exists anywhere in the subscription
      const existing = await this.findStorageAccount();
      if (existing) {
        log.info(
          `Storage account ${this.storageAccountName} found in ${existing.resourceGroup}`,
        );
        return;
      }

      // Ensure storage resource group exists
      await this.ensureStorageResourceGroup();

      // Create storage account in storage resource group
      log.info(
        `Creating storage account: ${this.storageAccountName} in ${this.storageResourceGroup} (${this.region})`,
      );
      // Bound the create LRO: an un-timed-out beginCreateAndWait can hang the
      // provisioning task silently. On timeout, throw — classifyError maps the
      // TimeoutError to TemporaryProviderFailure (retryable), so the workload
      // leaves `provisioning` for `retrying` instead of wedging.
      await withTimeout(
        this.storageClient.storageAccounts.beginCreateAndWait(
          this.storageResourceGroup,
          this.storageAccountName,
          {
            sku: {
              name: 'Standard_LRS', // Locally redundant storage
            },
            kind: 'StorageV2',
            location: this.region,
            accessTier: 'Hot',
            allowSharedKeyAccess: true,
            allowBlobPublicAccess: false,
            minimumTlsVersion: 'TLS1_2',
            tags: { managed_by: 'anycloud' },
          },
        ),
        Azure.POLL_TIMEOUT_MS,
        `create storage account ${this.storageAccountName}`,
      );
      log.info(`Storage account ${this.storageAccountName} created`);
    } catch (error: any) {
      // Race condition: another process may have created it
      if (error.code === 'StorageAccountAlreadyTaken') {
        const found = await this.findStorageAccount();
        if (found) {
          log.info(
            `Storage account created by another process in ${found.resourceGroup}`,
          );
          return;
        }
      }
      // Enhance error with context before throwing
      if (error instanceof Error) {
        error.message = `Failed to ensure storage account ${this.storageAccountName}: ${error.message}`;
      }
      throw error;
    }
  }

  private async upsertVNet(
    workloadId: string,
    version: string,
    userId: string,
    resourceScope?: CloudResourceScope,
  ) {
    await this.ensureRegionalInfrastructure();
    try {
      return await this.networkClient.virtualNetworks.get(
        this.resourceGroup,
        workloadId,
      );
    } catch {
      const vnetParameters = {
        location: this.azConfig.region,
        addressSpace: {
          addressPrefixes: ['10.0.0.0/16'],
        },
        subnets: [{ name: workloadId, addressPrefix: '10.0.0.0/16' }],
        tags: this.getResourceTags(
          workloadId,
          version,
          userId,
          undefined,
          resourceScope,
        ),
      };
      const poller =
        await this.networkClient.virtualNetworks.beginCreateOrUpdate(
          this.resourceGroup,
          workloadId,
          vnetParameters,
        );
      await poller.pollUntilDone();
      await this.networkClient.subnets.get(
        this.resourceGroup,
        workloadId,
        workloadId,
      );
    }
  }

  private async upsertVMNetwork(
    vmId: string,
    ipWhiteList: string[],
    id: string,
    subnetInfo: Subnet,
    version: string,
    userId: string,
    resourceScope?: CloudResourceScope,
    ingressSpec?: IngressSpec,
  ) {
    const startTime = Date.now();
    // Create Public IP and get NSG in parallel (NSG should already exist from
    // upsertFirewall / prepareNetwork). Pass the caller's exact ingress intent:
    // a resource-scoped NSG reconciles its rule set here, so re-deriving the
    // default job spec would append a public SSH rule that the prepared NSG
    // never asked for — and renumber it onto an already-used priority.
    const [publicIPInfo, networkSecurityGroupInfo] = await Promise.all([
      this.upsertPublicIP(
        vmId,
        this.resourceGroup,
        id,
        version,
        userId,
        resourceScope,
      ),
      this.upsertNetworkSecurityGroup(
        ipWhiteList,
        id,
        version,
        userId,
        ingressSpec,
        resourceScope,
      ),
    ]);
    log.info(
      `[${vmId}] Public IP + NSG lookup took ${((Date.now() - startTime) / 60000).toFixed(2)}min`,
    );
    // NIC depends on both Public IP and NSG
    const nicStartTime = Date.now();
    const nicInfo = await this.upsertNIC(
      vmId,
      subnetInfo,
      publicIPInfo,
      networkSecurityGroupInfo,
      id,
      version,
      userId,
      resourceScope,
    );
    log.info(
      `[${vmId}] NIC creation took ${((Date.now() - nicStartTime) / 60000).toFixed(2)}min`,
    );
    return {
      publicIPInfo: publicIPInfo,
      nic: nicInfo,
    };
  }

  private async upsertPublicIP(
    vmId: string,
    resourceGroup: string,
    workloadId: string,
    version: string,
    userId: string,
    resourceScope?: CloudResourceScope,
  ) {
    const publicIPParameters: PublicIPAddress = {
      location: this.azConfig.region,
      publicIPAllocationMethod: 'Static', // Standard SKU requires Static allocation
      sku: {
        name: 'Standard', // Use Standard SKU instead of Basic (Basic is deprecated and has quota limits)
      },
      dnsSettings: {
        domainNameLabel: vmId,
      },
      tags: this.getResourceTags(
        workloadId,
        version,
        userId,
        undefined,
        resourceScope,
      ),
    };
    const poller =
      await this.networkClient.publicIPAddresses.beginCreateOrUpdate(
        resourceGroup,
        vmId,
        publicIPParameters,
      );
    try {
      return await poller.pollUntilDone();
    } catch (error: any) {
      if (isAzureNotFound(error)) {
        log.warn(
          `Azure PublicIP poller returned not-found for ${vmId} — Azure likely aborted the in-flight resource`,
          { vmId, code: error.code, statusCode: error.statusCode },
        );
      }
      throw error;
    }
  }

  private async upsertNIC(
    vmId: string,
    subnetInfo: Subnet,
    publicIPInfo: PublicIPAddress,
    nsgInfo: NetworkSecurityGroup,
    workloadId: string,
    version: string,
    userId: string,
    resourceScope?: CloudResourceScope,
  ) {
    const nicParameters = {
      location: this.azConfig.region,
      networkSecurityGroup: nsgInfo,
      ipConfigurations: [
        {
          name: vmId,
          privateIPAllocationMethod: 'Dynamic',
          subnet: subnetInfo,
          publicIPAddress: publicIPInfo,
        },
      ] as NetworkInterfaceIPConfiguration[],
      tags: this.getResourceTags(
        workloadId,
        version,
        userId,
        undefined,
        resourceScope,
      ),
    };
    const poller =
      await this.networkClient.networkInterfaces.beginCreateOrUpdate(
        this.resourceGroup,
        vmId,
        nicParameters,
      );
    try {
      return await poller.pollUntilDone();
    } catch (error: any) {
      if (isAzureNotFound(error)) {
        log.warn(
          `Azure NIC poller returned not-found for ${vmId} — Azure likely aborted the in-flight resource`,
          { vmId, code: error.code, statusCode: error.statusCode },
        );
      }
      throw error;
    }
  }

  getVmParams(
    vmId: string,
    startupScript: string,
    baseImageProps: AzureBaseImageProps,
    imageId: string | null,
    networkInfo: any,
    publicKey: string,
    workloadId: string,
    version: string,
    userId: string,
    spot?: boolean,
    resourceScope?: CloudResourceScope,
  ) {
    const adminUser = 'anycloud'; // Fixed username to satisfy Azure requirement (we SSH as root)
    const vmParams: any = {
      location: this.azConfig.region,
      osProfile: {
        computerName: vmId,
        customData: Buffer.from(startupScript).toString('base64'),
        // Azure needs ssh credentials, either username/password or username/ssh key pair
        adminUsername: adminUser,
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          ssh: {
            publicKeys: [
              {
                path: `/home/${adminUser}/.ssh/authorized_keys`,
                // This step is needed since Azure expects an OpenSSH `ssh-rsa ...` format
                keyData: pemToOpenSSH(publicKey),
              },
            ],
          },
        },
      },
      hardwareProfile: {
        vmSize: this.vmType,
      },
      storageProfile: {
        imageReference: isAzureCommunityGalleryImage(baseImageProps)
          ? {
              communityGalleryImageId: baseImageProps.communityGalleryImageId,
            }
          : {
              ...baseImageProps,
              version: imageId!, // Non-null: getImageId always called for marketplace images
            },
        osDisk: {
          createOption: 'FromImage',
          // Azure removes the disk with the VM, however the VM is deleted.
          deleteOption: 'Delete',
          ...(this.diskSizeGb && { diskSizeGB: this.diskSizeGb }),
          managedDisk: {
            storageAccountType: storageAccountTypeForDiskTier(this.diskTier),
          },
        },
      },
      networkProfile: {
        networkInterfaces: [
          {
            id: networkInfo.nic.id,
            primary: true,
            // A resource-scoped VM (a node pool's or a cluster's) can vanish
            // outside terminateVM (spot eviction, a native delete); its NIC
            // goes with it, and its owner deletes the public IP.
            ...(resourceScope && { deleteOption: 'Delete' }),
          },
        ],
      },
      // Enable boot diagnostics (managed - no storage account needed)
      diagnosticsProfile: {
        bootDiagnostics: {
          enabled: true,
        },
      },
      tags: this.getResourceTags(
        workloadId,
        version,
        userId,
        undefined,
        resourceScope,
      ),
      ...(this.availabilityZone && { zones: [this.availabilityZone] }),
    };

    // Add Spot VM configuration if requested. A Job's evicted VM is
    // deallocated and restarted in place; a node pool's is deleted and
    // replaced by its pool.
    if (spot) {
      vmParams.priority = 'Spot';
      vmParams.evictionPolicy = resourceScope ? 'Delete' : 'Deallocate';
      vmParams.billingProfile = {
        maxPrice: -1, // -1 means pay up to on-demand price
      };
    }

    // Azure GPU deploys use dstack community-gallery images, which are not
    // marketplace offers and carry no purchase plan — so no vmParams.plan.

    return vmParams;
  }

  private generateSSHKeyPair(): KeyPairSyncResult<string, string> {
    return generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });
  }

  async upsertNetworkSecurityGroup(
    ipWhiteList: string[],
    id: string,
    version: string,
    userId: string,
    spec: IngressSpec = buildJobIngressSpec(ipWhiteList),
    resourceScope?: CloudResourceScope,
  ): Promise<NetworkSecurityGroup> {
    // Concurrent first launches in a region make the shared NSG once.
    if (!resourceScope && isSharedJobIngress(spec)) {
      return memoizeAsync(this.sharedNsgReady, this.resourceGroup, () =>
        this.upsertNsg(ipWhiteList, id, version, userId, spec),
      );
    }
    return this.upsertNsg(
      ipWhiteList,
      id,
      version,
      userId,
      spec,
      resourceScope,
    );
  }

  private async upsertNsg(
    ipWhiteList: string[],
    id: string,
    version: string,
    userId: string,
    spec: IngressSpec,
    resourceScope?: CloudResourceScope,
  ): Promise<NetworkSecurityGroup> {
    await this.ensureRegionalInfrastructure();
    // Public SSH alone is one standing NSG in the region's group, which every
    // such VM's NIC shares; each keeps its own VNet. Teardown and the sweep
    // delete by the workload's name and ownership tags, so they leave it.
    const shared = !resourceScope && isSharedJobIngress(spec);
    const name = shared ? AZURE_SHARED_VM_NSG_NAME : id;
    let existing: NetworkSecurityGroup | undefined;
    try {
      existing = await this.networkClient.networkSecurityGroups.get(
        this.resourceGroup,
        name,
      );
    } catch {
      existing = undefined;
    }
    // Preserve the workload-scoped gateway's established create-once
    // behavior. Resource-scoped networking reconciles the rule list after an
    // interrupted prepare.
    if (existing && !resourceScope) return existing;

    // Transcribe the shared plan rule-for-rule; composition (IP-family
    // splits) is resolveFirewallPlan's job. The NSG substrate denies public
    // ingress by default, so the plan emits no scope-deny pair here — an NSG
    // with no allow rules is Azure "no public ingress" — and rule priorities
    // are positional rather than class-mapped. That default stops at the VNet
    // boundary: Azure's built-in AllowVNetInBound rule keeps VMs in the scope
    // VNet mutually reachable, so RFC 0033 tier-`none` capacity is
    // unprovisioned here, not physically blocked.
    const desiredRules: SecurityRule[] = [];
    for (const rule of resolveFirewallPlan(spec, AZURE_FIREWALL_TRAITS)) {
      desiredRules.push(
        this.generateFirewallRule(
          `Allow${rule.port}InBound${rule.nameSuffix === '-ipv6' ? 'Ipv6' : ''}`,
          rule.description
            ? `Allow ${rule.description} inbound traffic`
            : `Allow port ${rule.port} inbound traffic`,
          101 + desiredRules.length,
          [...rule.sourceRanges],
          String(rule.port),
        ),
      );
    }

    const existingRules = existing?.securityRules ?? [];
    const existingNames = new Set(existingRules.map((rule) => rule.name));
    // Positional priorities hold only for a new NSG. A rule added to an
    // existing one (443 on a resumed management VM's scope) takes the lowest
    // inbound priority still free, or Azure refuses the clash.
    const taken = new Set(
      existingRules
        .filter((rule) => rule.direction === 'Inbound')
        .map((rule) => rule.priority),
    );
    const freePriority = () => {
      for (let priority = 101; priority <= 4096; priority++) {
        if (!taken.has(priority)) {
          taken.add(priority);
          return priority;
        }
      }
      throw new Error(
        `NSG ${name} has no free inbound priority between 101 and 4096`,
      );
    };
    const missingRules = desiredRules
      .filter((rule) => !existingNames.has(rule.name))
      .map((rule) => (existing ? { ...rule, priority: freePriority() } : rule));
    if (existing && missingRules.length === 0) return existing;

    const nsgParams: NetworkSecurityGroup = {
      location: this.azConfig.region,
      securityRules: [...(existing?.securityRules ?? []), ...missingRules],
      tags:
        existing?.tags ??
        (shared
          ? { anycloud_managed: 'shared' }
          : this.getResourceTags(
              id,
              version,
              userId,
              undefined,
              resourceScope,
            )),
    };
    const poller =
      await this.networkClient.networkSecurityGroups.beginCreateOrUpdate(
        this.resourceGroup,
        name,
        nsgParams,
      );
    return poller.pollUntilDone();
  }

  private generateFirewallRule(
    name: string,
    desc: string,
    priority: number,
    sourceRanges: string[],
    port: string,
    protocol: 'Tcp' | 'Udp' | 'Icmp' | 'Esp' | 'Ah' | '*' = 'Tcp',
    direction: 'Inbound' | 'Outbound' = 'Inbound',
    access: 'Allow' | 'Deny' = 'Allow',
  ): SecurityRule {
    const source =
      sourceRanges.length === 1
        ? { sourceAddressPrefix: sourceRanges[0] }
        : { sourceAddressPrefixes: sourceRanges };
    return {
      description: desc,
      protocol,
      sourcePortRange: '*',
      destinationPortRange: port,
      ...source,
      destinationAddressPrefix: '*',
      access,
      priority,
      direction,
      name,
    };
  }

  private async getVnetInfo(name: string) {
    const [vnetInfo, subnetInfo] = await Promise.all([
      this.networkClient.virtualNetworks.get(this.resourceGroup, name),
      this.networkClient.subnets.get(this.resourceGroup, name, name),
    ]);
    return {
      vnet: vnetInfo,
      subnet: subnetInfo,
    };
  }

  private async removeFirewalls(id: string): Promise<any> {
    const poller = await this.networkClient.networkSecurityGroups.beginDelete(
      this.resourceGroup,
      id,
    );
    return withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `deleteNSG ${id}`,
    );
  }

  /**
   * Delete all subnets in a VNet before deleting the VNet itself.
   * Azure can refuse to delete a VNet if subnets still have lingering references.
   */
  private async removeVirtualNetwork(virtualNetworkName: string): Promise<any> {
    const poller = await this.networkClient.virtualNetworks.beginDelete(
      this.resourceGroup,
      virtualNetworkName,
    );
    return withTimeout(
      poller.pollUntilDone(),
      Azure.POLL_TIMEOUT_MS,
      `deleteVNet ${virtualNetworkName}`,
    );
  }

  /**
   * Tag Azure container with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagContainerForDeletion(
    containerName: string,
    storageInfo?: { resourceGroup: string; account: StorageAccount },
  ): Promise<void> {
    try {
      const blobServiceClient = await this.getBlobServiceClient(storageInfo);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Check if container exists before trying to tag it
      const exists = await containerClient.exists();
      if (!exists) {
        log.info(
          `Skipping tagging - container ${containerName} already deleted`,
        );
        return;
      }

      await withRetry(
        async () => {
          // Get existing metadata
          const properties = await containerClient.getProperties();
          const existingMetadata = properties.metadata || {};

          // Add ended_at to metadata
          await containerClient.setMetadata({
            ...existingMetadata,
            anycloud_ended_at: Date.now().toString(),
          });
        },
        `Tag Azure container ${containerName}`,
        {
          maxAttempts: 5,
          waitMs: 1000,
        },
      );
      log.info(`Tagged Azure container ${containerName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag Azure container ${containerName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', containerName, error },
      );
    }
  }

  /**
   * Tag VM with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagVMForDeletion(vmName: string): Promise<void> {
    // Azure holds the PATCH behind a stuck create, which once kept the delete
    // from being sent for over an hour; the tag never blocks deletion.
    const tagging = new AbortController();
    const abortSignal = tagging.signal;
    try {
      const tag = withRetry(
        async () => {
          let vm;
          try {
            vm = await this.computeClient.virtualMachines.get(
              this.resourceGroup,
              vmName,
              { abortSignal },
            );
          } catch (e) {
            if (isAzureNotFound(e)) return;
            throw e;
          }
          const existingTags = vm.tags || {};
          if (existingTags.anycloud_ended_at) return;
          // Use beginUpdate (PATCH) instead of beginCreateOrUpdate (PUT).
          // PUT fails on VMs in Failed provisioning state because Azure
          // tries to re-provision; PATCH only updates the specified fields.
          const poller = await this.computeClient.virtualMachines.beginUpdate(
            this.resourceGroup,
            vmName,
            {
              tags: {
                ...existingTags,
                anycloud_ended_at: Date.now().toString(),
              },
            },
            { abortSignal },
          );
          await poller.pollUntilDone({ abortSignal });
        },
        `tag VM ${vmName}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          signal: abortSignal,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying VM tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      await withTimeout(tag, Azure.TAG_TIMEOUT_MS, `tag VM ${vmName}`);
      log.info(`Tagged VM ${vmName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag VM ${vmName} (non-blocking): ${errorMessage(error)}`,
        { id: 'system', vmName, error },
      );
    } finally {
      tagging.abort();
    }
  }

  /**
   * Tag NIC with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagNICForDeletion(nicName: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          let nic;
          try {
            nic = await this.networkClient.networkInterfaces.get(
              this.resourceGroup,
              nicName,
            );
          } catch (e) {
            if (isAzureNotFound(e)) return;
            throw e;
          }
          const existingTags = nic.tags || {};
          if (existingTags.anycloud_ended_at) return;
          // Use updateTags (PATCH) instead of beginCreateOrUpdate (PUT).
          // PUT replaces the entire resource and conflicts with parallel
          // operations on linked resources (VM, NSG, subnet).
          await this.networkClient.networkInterfaces.updateTags(
            this.resourceGroup,
            nicName,
            {
              tags: {
                ...existingTags,
                anycloud_ended_at: Date.now().toString(),
              },
            },
          );
        },
        `tag NIC ${nicName}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying NIC tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged NIC ${nicName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag NIC ${nicName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', nicName, error },
      );
    }
  }

  /**
   * Tag Public IP with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagPublicIPForDeletion(publicIPName: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          let pip;
          try {
            pip = await this.networkClient.publicIPAddresses.get(
              this.resourceGroup,
              publicIPName,
            );
          } catch (e) {
            if (isAzureNotFound(e)) return;
            throw e;
          }
          const existingTags = pip.tags || {};
          if (existingTags.anycloud_ended_at) return;
          await this.networkClient.publicIPAddresses.updateTags(
            this.resourceGroup,
            publicIPName,
            {
              tags: {
                ...existingTags,
                anycloud_ended_at: Date.now().toString(),
              },
            },
          );
        },
        `tag Public IP ${publicIPName}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying Public IP tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged Public IP ${publicIPName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag Public IP ${publicIPName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', publicIPName, error },
      );
    }
  }

  /**
   * Tag VNet with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagVNetForDeletion(vnetName: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          let vnet;
          try {
            vnet = await this.networkClient.virtualNetworks.get(
              this.resourceGroup,
              vnetName,
            );
          } catch (e) {
            if (isAzureNotFound(e)) return;
            throw e;
          }
          const existingTags = vnet.tags || {};
          if (existingTags.anycloud_ended_at) return;
          await this.networkClient.virtualNetworks.updateTags(
            this.resourceGroup,
            vnetName,
            {
              tags: {
                ...existingTags,
                anycloud_ended_at: Date.now().toString(),
              },
            },
          );
        },
        `tag VNet ${vnetName}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying VNet tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged VNet ${vnetName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag VNet ${vnetName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', vnetName, error },
      );
    }
  }

  /**
   * Tag NSG with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagNSGForDeletion(nsgName: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          let nsg;
          try {
            nsg = await this.networkClient.networkSecurityGroups.get(
              this.resourceGroup,
              nsgName,
            );
          } catch (e) {
            if (isAzureNotFound(e)) return;
            throw e;
          }
          const existingTags = nsg.tags || {};
          if (existingTags.anycloud_ended_at) return;
          await this.networkClient.networkSecurityGroups.updateTags(
            this.resourceGroup,
            nsgName,
            {
              tags: {
                ...existingTags,
                anycloud_ended_at: Date.now().toString(),
              },
            },
          );
        },
        `tag NSG ${nsgName}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying NSG tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged NSG ${nsgName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag NSG ${nsgName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', nsgName, error },
      );
    }
  }

  /**
   * A pool's read: true only while the VM is stopped, deallocated or on its
   * way there. Starting, unknown and failed provisioning wait out the Node
   * grace instead, and an error or a missing VM reads false.
   */
  private async observeStoppedVm(cloudId: string): Promise<boolean> {
    try {
      const { parsed } = await this.readVMInstanceStatus(cloudId);
      return AZURE_STOPPED_POWER_STATES.has(parsed.powerState ?? '');
    } catch (error) {
      if (!isAzureNotFound(error)) {
        log.warn('Azure stopped VM read failed', { cloudId, error });
      }
      return false;
    }
  }

  /**
   * Check if VM is no longer running (stopped, stopping, deallocated, or deallocating).
   * Makes a single API call and returns the current state immediately.
   * The reconciler's preemption path calls this from its 30s poll lane.
   */
  private async verifyVMPreemption(cloudId: string): Promise<boolean> {
    try {
      const result = await withRetry(
        async () => {
          this.initializeClients();

          try {
            const vm = await this.computeClient.virtualMachines.get(
              this.resourceGroup,
              cloudId,
              { expand: 'instanceView' },
            );
            const vmStatus = parseVMStatus(
              vm.instanceView?.statuses,
              vm.provisioningState,
            );
            log.debug('Azure VM state check', {
              cloudId,
              status: vmStatus.status,
              message: vmStatus.message,
            });
            return { found: true, vmStatus };
          } catch (error) {
            if (isAzureNotFound(error)) {
              log.debug('Azure VM not found during preemption check', {
                cloudId,
              });
              return { found: false, vmStatus: null };
            }
            throw error;
          }
        },
        `Azure VM preemption check for ${cloudId}`,
        { maxAttempts: 3, waitMs: 2000, exponentialBackoff: false },
      );

      if (!result.found) {
        log.warn('Azure VM not found (cannot verify preemption)', {
          cloudId,
        });
        return false;
      }

      if (result.vmStatus!.status !== VMStatus.Ready) {
        log.info('Azure VM is not running', {
          cloudId,
          status: result.vmStatus!.status,
          message: result.vmStatus!.message,
        });
        return true;
      }

      log.info('Azure VM is running', { cloudId });
      return false;
    } catch (error) {
      log.error('Azure VM state check failed', {
        id: cloudId,
        error: error,
      });
      return false;
    }
  }

  private async observeVMReleaseOnce(
    cloudId: string,
    options: VMReleaseObservationOptions = {},
  ): Promise<VMReleaseObservation> {
    // On Azure, only "not found" means the VM is irrecoverably gone.
    // Stopped/deallocated VMs still exist and can be restarted.
    let terminationObserved = false;
    try {
      const result = await withRetry(
        async () => {
          this.initializeClients();
          try {
            await this.computeClient.virtualMachines.get(
              this.resourceGroup,
              cloudId,
              { abortSignal: options.signal },
            );
            return { found: true };
          } catch (error) {
            if (isAzureNotFound(error)) {
              terminationObserved = true;
              return { found: false };
            }
            throw error;
          }
        },
        `Azure VM terminated check for ${cloudId}`,
        {
          maxAttempts: 3,
          waitMs: 2000,
          exponentialBackoff: false,
          signal: options.signal,
        },
      );

      if (!result.found) {
        log.info('Azure VM not found (terminated)', { cloudId });
        return VM_RELEASE_CANDIDATE;
      }

      return VM_PRESENT;
    } catch (error) {
      // Some SDK work cannot be interrupted immediately. Preserve definitive,
      // irreversible evidence returned just after the caller's deadline.
      if (terminationObserved) return VM_RELEASE_CANDIDATE;
      log.error('Azure VM terminated check failed', {
        id: cloudId,
        error: error,
      });
      return vmReleaseUnknown(error);
    }
  }

  private async startVM(cloudId: string): Promise<string | null> {
    const attempt = new VMRestartAttempt(`Azure VM restart for ${cloudId}`);
    const { startedAt, deadlineAt: deadline, signal } = attempt;
    let phase: 'settle' | 'start' | 'ready' = 'settle';
    let phaseDeadline = Math.min(deadline, startedAt + AZURE_RESTART_SETTLE_MS);
    let consecutiveSettled = 0;
    let consecutiveReady = 0;
    let lastStatus: ParsedVMStatus | null = null;
    let lastIp: string | null = null;

    const remainingMs = () => attempt.remainingMs(phaseDeadline);
    const bounded = <T>(operation: () => Promise<T>): Promise<T> =>
      attempt.run(operation, phaseDeadline);
    const wait = () => attempt.wait(phaseDeadline);

    try {
      log.info('Attempting to start stopped Azure VM', { cloudId });
      this.initializeClients();

      while (Date.now() < phaseDeadline) {
        let parsed: ParsedVMStatus;
        lastIp = null;
        try {
          ({ parsed } = await bounded(() =>
            this.readVMInstanceStatus(cloudId, signal),
          ));
          lastStatus = parsed;
          if (parsed.status === VMStatus.Ready) {
            const publicIP = await bounded(() =>
              this.networkClient.publicIPAddresses.get(
                this.resourceGroup,
                cloudId,
                { abortSignal: signal },
              ),
            );
            lastIp = publicIP.ipAddress ?? null;
          }
        } catch (error) {
          remainingMs();
          const statusCode = (error as { statusCode?: number } | null)
            ?.statusCode;
          if (
            isAzureNotFound(error) ||
            isAzureTerminalAuthError(error) ||
            !(
              isTransientTransportError(error) ||
              statusCode === 429 ||
              (statusCode !== undefined &&
                statusCode >= 500 &&
                statusCode < 600)
            )
          )
            throw error;
          consecutiveSettled = 0;
          consecutiveReady = 0;
          log.info('Retrying Azure VM restart observation', {
            cloudId,
            phase,
            elapsedMs: Date.now() - startedAt,
            error: errorMessage(error),
          });
          await wait();
          continue;
        }

        consecutiveReady =
          parsed.status === VMStatus.Ready && lastIp ? consecutiveReady + 1 : 0;
        // Failed describes the previous control-plane operation, not whether
        // the existing VM can ever start. The probe recovered AllocationFailed
        // with no PowerState. Require repeated evidence of that specific case;
        // an unexplained missing state or a transition never authorizes a start.
        const failedAllocation =
          parsed.provisioningState === 'failed' &&
          AZURE_RESTARTABLE_ALLOCATION_ERRORS.has(
            parsed.provisioningErrorCode?.toLowerCase() ?? '',
          );
        const settled =
          (isStoppedOrDeallocatedPowerState(parsed.powerState) &&
            (parsed.provisioningState !== 'failed' || failedAllocation)) ||
          (parsed.powerState === null && failedAllocation);
        consecutiveSettled = settled ? consecutiveSettled + 1 : 0;
        log.info('Azure VM restart observation', {
          cloudId,
          phase,
          elapsedMs: Date.now() - startedAt,
          observedStatus: parsed,
          hasIp: !!lastIp,
          consecutiveSettled,
          consecutiveReady,
        });
        remainingMs();

        if (consecutiveReady >= VM_RESTART_CONSECUTIVE_OBSERVATIONS) {
          log.info('Azure VM restart recovery completed', {
            cloudId,
            phase,
            elapsedMs: Date.now() - startedAt,
            newIp: lastIp,
          });
          return lastIp;
        }

        if (
          phase === 'settle' &&
          consecutiveSettled >= VM_RESTART_CONSECUTIVE_OBSERVATIONS
        ) {
          // Azure can accept and then lose a start that races spot eviction.
          // Three settled reads at the production cadence gate the single start.
          phase = 'start';
          phaseDeadline = deadline;
          log.info('Starting settled Azure VM', {
            cloudId,
            elapsedMs: Date.now() - startedAt,
            observedStatus: parsed,
          });
          const poller = await bounded(() =>
            this.computeClient.virtualMachines.beginStart(
              this.resourceGroup,
              cloudId,
              { abortSignal: signal },
            ),
          );
          await bounded(() => poller.pollUntilDone({ abortSignal: signal }));
          phase = 'ready';
          consecutiveSettled = 0;
          log.info('Azure VM start operation completed; awaiting readiness', {
            cloudId,
            elapsedMs: Date.now() - startedAt,
          });
          // Stopped or stale provisioning reads after an accepted operation
          // are observations, not start refusals. Only readiness completes it.
          continue;
        }
        await wait();
      }
      throw new Error(`Azure VM restart ${phase} deadline exceeded`);
    } catch (error) {
      log.warn('Failed to start Azure VM', {
        cloudId,
        phase,
        elapsedMs: Date.now() - startedAt,
        lastStatus,
        hasIp: !!lastIp,
        error,
      });
      return null;
    } finally {
      attempt.abort();
    }
  }

  private classifyError(error: unknown): CloudFailureDiagnosis {
    if (!error || typeof error !== 'object')
      return CloudFailureDiagnosis.TemporaryProviderFailure;
    const err = error as any;
    if (isStoppedOrDeallocatedPowerState(err.powerState)) {
      return CloudFailureDiagnosis.CapacityExhausted;
    }

    // Instance-view provisioning failures can carry the actionable Azure code
    // as a third status path component while the thrown error retains the
    // stable AzureVMStatusError code for diagnostics.
    const code = err.provisioningErrorCode ?? err.Code ?? err.code ?? err.name;
    if (typeof code !== 'string')
      return CloudFailureDiagnosis.TemporaryProviderFailure;
    const errMsg = err.message ?? err.Message ?? '';

    // Docker/NVIDIA runtime rejected the workload before it could start. This
    // is deterministic for the selected host image + container image pair, so
    // retrying the same target only burns the whole retry budget.
    if (
      /nvidia-container-cli: requirement error|Guest driver is incompatible with host driver/i.test(
        errMsg,
      )
    )
      return CloudFailureDiagnosis.InvalidRequest;

    // Target-specific: VM type / resource not available in region
    if (code === 'LocationNotAvailableForResourceType') {
      this.invalidateCatalogOverlay(code, this.region);
      return CloudFailureDiagnosis.InvalidTarget;
    }
    if (code === 'NotFound') return CloudFailureDiagnosis.InvalidTarget;
    if (code === 'SkuNotAvailable') {
      if (/capacity/i.test(errMsg))
        return CloudFailureDiagnosis.CapacityExhausted;
      this.invalidateCatalogOverlay(code, this.region);
      return CloudFailureDiagnosis.InvalidTarget;
    }

    // Subscription can't deploy in this region (sponsorship/student/MPN offers,
    // reserved-access regions like Jio India that require a support ticket,
    // Azure Policy, RG location constraints). Durable per-region per-subscription
    // — 6h block, not a temporary provider retry. RequestDisallowedByAzure is
    // scoped by message because the same code also fires for non-region policy
    // denials.
    if (
      code === 'ProvisioningDisabled' ||
      code === 'LocationIsOfferRestricted' ||
      code === 'SubscriptionNotAllowedForAccessInLocation' ||
      code === 'DisallowedLocation' ||
      code === 'LocationNotAvailableForResourceGroup' ||
      (code === 'RequestDisallowedByAzure' && /region|location/i.test(errMsg))
    ) {
      this.invalidateCatalogOverlay(code, this.region);
      return CloudFailureDiagnosis.InvalidTarget;
    }

    // Account-level quota errors — `anycloud quota` CLI is the right next step.
    // Quota literally = 0 is ~permanent until the user files an increase, so
    // route those to InvalidTarget (6h) instead of the 30-min generic quota
    // block. Azure surfaces the limit in the message, e.g. "Current Limit: 0".
    const isQuotaCode =
      code === 'QuotaExceeded' ||
      (code === 'OperationNotAllowed' && /quota|limit exceeded/i.test(errMsg));
    const isQuotaShaped =
      isQuotaCode || /exceeding approved.*quota/i.test(errMsg);
    // LowPriorityCores is one subscription-level Spot pool per region.
    if (isQuotaShaped && /low.?priority.?cores/i.test(errMsg)) {
      if (/current limit[:\s]+0\b/i.test(errMsg))
        return CloudFailureDiagnosis.InvalidTarget;
      return CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted;
    }
    if (isQuotaCode) {
      if (/current limit[:\s]+0\b/i.test(errMsg))
        return CloudFailureDiagnosis.InvalidTarget;
      return CloudFailureDiagnosis.QuotaExhaustedRegion;
    }
    if (/exceeding approved.*quota/i.test(errMsg))
      return CloudFailureDiagnosis.QuotaExhaustedRegion;

    // Public IP exhaustion is a per-region Network quota (one IP per VM), not a
    // compute-vCPU limit, and Azure surfaces it without the words "quota" or
    // "limit exceeded" — e.g. "Cannot create more than 100 public IP addresses
    // for this subscription in this region." Without this it falls through to
    // Transient and retries forever instead of blocking the region and pointing
    // at `anycloud quota`. Anchored on the message (verbatim from logs) since
    // the error code varies across the create paths that hit this limit.
    if (/cannot create more than \d+ public ip addresses/i.test(errMsg))
      return CloudFailureDiagnosis.QuotaExhaustedRegion;

    // Capacity errors — Azure has no spare hardware in this region right now.
    // Distinct from QuotaExhaustedRegion so the status hint doesn't mislead.
    if (
      code === 'AllocationFailed' ||
      code === 'OverconstrainedAllocationRequest'
    )
      return CloudFailureDiagnosis.CapacityExhausted;

    // Region/SKU mismatch: Azure returns this under various codes
    // (InvalidParameter, BadRequest) with the same semantic message as
    // SkuNotAvailable. Match on message so code-alone misclassification
    // (e.g. InvalidParameter → invalid-request → terminal Invalid) doesn't skip
    // the optimizer's region-retry path.
    //
    // Tight pattern (phrase must be immediately before "in <zone>") — the
    // real strings to stay compatible with when editing:
    //   "The requested VM size Standard_NC40ads_H100_v5 is not available in the current region."
    //   "This SKU is not supported in this region."
    //   "SKU X is not available in location eastus."
    //   "Size X is not supported in zone 2."
    //
    // Deliberately NOT matched:
    //   - "Service temporarily unavailable" / "currently unavailable"
    //     (temporary provider failure — retry with backoff)
    //   - Any message without the "in <region|location|zone>" suffix
    if (
      /(?:not available|not supported) in (?:the current |this )?(?:region|location|zone)/i.test(
        errMsg,
      )
    ) {
      this.invalidateCatalogOverlay(`target-rejection:${code}`, this.region);
      return CloudFailureDiagnosis.InvalidTarget;
    }

    // A nonexistent/typo'd VM size comes back under a generic InvalidParameter /
    // BadRequest with a distinct "...is not valid" shape (separate from the
    // "not available in <region>" SKU-mismatch above). Treat as a target
    // constraint — like AWS InstanceType / GCP machineType — so a pinned region
    // escalates to terminal Invalid instead of retrying until timeout.
    //   "The value Standard_FOO provided for the VM size is not valid. The valid sizes in the current region are: ..."
    if (errMsg.includes('provided for the VM size is not valid'))
      return CloudFailureDiagnosis.InvalidTarget;

    // A premium OS-disk SKU (Premium_LRS, from --disk-tier high/ultra) on a
    // non-premium-capable VM size comes back as a generic BadRequest whose
    // message names the storage account type and the VM size. Anchor on the
    // message (never the code — Azure reuses BadRequest for region/SKU-mismatch
    // too). This is a region-INVARIANT config mismatch (a VM size supports
    // Premium storage or it doesn't, everywhere), so route it to InvalidRequest
    // (terminal Invalid, no target block) rather than InvalidTarget: InvalidTarget
    // with an unpinned region becomes FailoverTarget and would region-walk the
    // deterministic failure across every region AND — because the block key omits
    // diskTier — suppress valid medium/unresolved-tier workloads on the same
    // VM+region.
    // The catalog premium-capability filter (optimizer) normally drops the bad
    // candidate before we ever provision; this branch is the backstop for the
    // catalog-refresh lag and unknown SKUs. NOTE: exact wording validated live —
    //   "Storage account type 'Premium_LRS' is not supported for VM size 'X'."
    if (
      /storage account type .*(?:not supported for|not compatible with).*vm size/i.test(
        errMsg,
      )
    )
      return CloudFailureDiagnosis.InvalidRequest;

    // A nonexistent configured Entra directory is a deterministic request
    // error, not evidence that the saved client secret itself is unhealthy.
    if (AZURE_INVALID_TENANT_MESSAGE_RE.test(errMsg))
      return CloudFailureDiagnosis.InvalidRequest;

    if (azurePermissionDenial(error))
      return CloudFailureDiagnosis.PermissionDenied;

    // Auth-class errors terminate the workload as Invalid. The AADSTS /
    // invalid_client
    // shapes are how @azure/identity surfaces a rotated/expired/wrong service-
    // principal secret; `code` there is the error name, not an ARM code, so the
    // message carries the signal.
    if (
      AZURE_AUTH_ERROR_CODES.has(code) ||
      AZURE_BAD_SECRET_MESSAGE_RE.test(errMsg)
    )
      return CloudFailureDiagnosis.BadCredential;

    // Storage data-plane RBAC: the service principal lacks a Blob Data role on
    // the storage account, so bucket connectivity (the rclone `.rclone-keep`
    // touch) returns AuthorizationPermissionMismatch. Terminal config problem —
    // re-provisioning or rotating the COMPUTE credential won't grant the storage
    // role, so route to InvalidRequest (terminal Invalid, no compute-credential
    // health mark). rclone's own --retries 30 (~7.5m) already
    // absorbs the ~5m role-propagation window, so a mismatch that reaches here is
    // a durable permission gap, not propagation lag.
    if (
      code === 'AuthorizationPermissionMismatch' ||
      /AuthorizationPermissionMismatch/i.test(errMsg)
    )
      return CloudFailureDiagnosis.InvalidRequest;

    // Config user errors — each code here must be UNAMBIGUOUSLY a caller/config
    // problem that cannot be fixed by retrying in another region or rotating
    // creds. Do NOT add generic codes like 'InvalidParameter' or 'BadRequest'
    // — Azure reuses those for region/SKU-mismatch errors too, and
    // misclassifying one of those as invalid-request sends the workload to
    // terminal Invalid on the first attempt instead of letting the optimizer
    // rotate regions. If in doubt, leave the code out of this set —
    // temporary-provider-failure (the default) will retry with bounded attempts
    // and surface a clearer exhaustion error.
    const userErrors = new Set([
      'InvalidSubscriptionId',
      'SubscriptionNotFound',
      'InvalidStorageAccountName',
      'StorageAccountAlreadyExists',
      'InvalidResourceName',
      'ReadOnlyDisabledSubscription',
    ]);
    if (userErrors.has(code)) return CloudFailureDiagnosis.InvalidRequest;

    // Azure sometimes returns input-validation errors as HTTP 500 (e.g. invalid
    // domain name labels). Catch them by recognizing validation-style messages.
    if (/is invalid\b.*must conform to/i.test(errMsg))
      return CloudFailureDiagnosis.InvalidRequest;

    return CloudFailureDiagnosis.TemporaryProviderFailure;
  }
}
