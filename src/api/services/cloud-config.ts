/**
 * API-specific CloudConfig utilities.
 * This module wraps the shared CloudConfig type with API-specific functionality
 * that requires access to Cloud implementations (AWS, GCP, Azure).
 */

import type { CloudResourceSweeper } from './gateways/resource-sweeper.js';
import { createHash } from 'node:crypto';

import {
  type StoredWorkload,
  type ProvisioningIntent,
} from './workload-record.js';
import {
  type CloudConfig,
  type CloudCredentials,
  CloudType,
  type AzureConnectionCreds,
} from '../../shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../shared/workload.js';
import { toArray } from '../../shared/utils.js';
import {
  completeCloudConfig,
  type ResolvedCloudConfig,
  DEFAULT_DISK_TIER,
  extractCredentials,
  requiresExplicitCheckpointStorage,
  requiresComputeCredentials,
  resolveVMType,
  supportsDiskTier,
  validateBucketName,
} from '../../shared/cloud-config.js';
import {
  DeployError,
  InvalidAnycloudConfigError,
} from '../../shared/errors.js';
import {
  resolveProvisioningTarget,
  type ProvisioningResolution,
  type ProvisioningResolutionOptions,
  type ProvisioningTargetStore,
} from './optimizer.js';
import {
  canMintScopedStorageToken,
  canLaunchSpotPools,
  isPreemptible,
  type CloudCompute,
  type CloudStorage,
} from './gateways/cloud.js';
import { AWS } from './gateways/aws.js';
import { GCP } from './gateways/gcp.js';
import { Azure } from './gateways/azure.js';
import { Lambda } from './gateways/lambda.js';
import { Local } from './gateways/local.js';
import { createCloudflareStorage } from './gateways/cloudflare.js';
import type { CloudApiOwnership } from './gateways/api-ownership.js';
import type { CatalogOverlayProvider } from './catalog-overlay.js';
import { createAzureCatalogOverlayProvider } from './catalog-overlays/azure.js';
import * as catalogReadiness from './catalog-readiness.js';
import { hasCheckpointTarget } from '../../shared/checkpoint.js';
import {
  isComputeProvider,
  storageOnlyComputeMessage,
} from '../../shared/providers.js';
import {
  getCredentialSecretStore,
  getProvisioningAttemptStore,
  getWorkloadQueryStore,
} from './persistence.js';
import type { VmNeedingCost } from './repositories/billing.js';
import type { VmCostIdentity } from './cost-calculation/contracts.js';
import { secretboxDecrypt, secretboxEncrypt } from './secret-crypto.js';
import type { SavedCredential } from '../../shared/api-contract/credentials-schemas.js';

/**
 * Service-only half of the provider registry: how to construct runtime provider
 * roles for a CloudType. This imports the gateway classes (cloud SDKs) and must
 * never reach the CLI bundle — the CLI uses the inert PROVIDER_DATA half. A full
 * Record<CloudType, …>: adding a CloudType won't compile until it has an entry.
 *
 * (The inert data half — defaults + catalog filename — lives in
 * `shared/providers.ts` as PROVIDER_DATA.)
 */
const azureCatalogOverlayFactory = (
  config: ResolvedCloudConfig,
): CatalogOverlayProvider =>
  createAzureCatalogOverlayProvider(config.credentials as AzureConnectionCreds);

const PROVIDER_IMPL: Record<
  CloudType,
  {
    // Null for a storage-only provider (PROVIDER_DATA's `compute: null`).
    compute: ((config: ResolvedCloudConfig) => CloudCompute) | null;
    storage: ((config: ResolvedCloudConfig) => CloudStorage) | null;
    sweeper: ((config: ResolvedCloudConfig) => CloudResourceSweeper) | null;
    apiOwnership: ((config: ResolvedCloudConfig) => CloudApiOwnership) | null;
    catalogOverlay:
      | ((config: ResolvedCloudConfig) => CatalogOverlayProvider)
      | null;
    apiOwnershipRequiresRegion: boolean;
  }
> = {
  [CloudType.AWS]: {
    compute: (c) => new AWS(c).compute(),
    storage: (c) => new AWS(c).storage(),
    sweeper: (c) => new AWS(c).sweeper(),
    apiOwnership: (c) => new AWS(c).apiOwnership(),
    catalogOverlay: null,
    apiOwnershipRequiresRegion: true,
  },
  [CloudType.GCP]: {
    compute: (c) => new GCP(c).compute(),
    storage: (c) => new GCP(c).storage(),
    sweeper: (c) => new GCP(c).sweeper(),
    apiOwnership: (c) => new GCP(c).apiOwnership(),
    catalogOverlay: null,
    apiOwnershipRequiresRegion: true,
  },
  [CloudType.Azure]: {
    compute: (c) => new Azure(c, azureCatalogOverlayFactory(c)).compute(),
    storage: (c) => new Azure(c).storage(),
    sweeper: (c) => new Azure(c).sweeper(),
    apiOwnership: (c) => new Azure(c).apiOwnership(),
    catalogOverlay: azureCatalogOverlayFactory,
    apiOwnershipRequiresRegion: true,
  },
  [CloudType.Lambda]: {
    compute: (c) => new Lambda(c).compute(),
    storage: null,
    sweeper: (c) => new Lambda(c).sweeper(),
    // Lambda accepts tags only at launch; legacy instances stay protected by
    // the database binding and are excluded from owner-scoped sweeps.
    apiOwnership: null,
    catalogOverlay: null,
    apiOwnershipRequiresRegion: false,
  },
  [CloudType.Cloudflare]: {
    // Containers compute is not built yet.
    compute: null,
    storage: (c) => createCloudflareStorage(c),
    sweeper: null,
    apiOwnership: null,
    catalogOverlay: null,
    apiOwnershipRequiresRegion: false,
  },
  [CloudType.Local]: {
    compute: (c) => new Local(c).compute(),
    storage: (c) => new Local(c).storage(),
    sweeper: (c) => new Local(c).sweeper(),
    apiOwnership: null,
    catalogOverlay: null,
    apiOwnershipRequiresRegion: false,
  },
};

/** One location's resource sweeper; null for a provider without one. */
export function createSweeperProvider(
  cloudConfig: CloudConfig,
): CloudResourceSweeper | null {
  const config = completeCloudConfig(cloudConfig);
  return PROVIDER_IMPL[config.cloudProvider].sweeper?.(config) ?? null;
}

/** Create the optional account-scoped catalog augmentation role. */
export function createCatalogOverlayProvider(
  cloudConfig: CloudConfig,
): CatalogOverlayProvider | null {
  const factory = PROVIDER_IMPL[cloudConfig.cloudProvider].catalogOverlay;
  if (!factory) return null;
  return factory(completeCloudConfig(cloudConfig));
}

export function apiOwnershipRequiresRegion(cloudProvider: CloudType): boolean {
  return PROVIDER_IMPL[cloudProvider].apiOwnershipRequiresRegion;
}

/**
 * Create a compute provider from CloudConfig.
 */
export function createComputeProvider(
  cloudConfig: CloudConfig,
  purpose: 'provisioning' | 'observed-vm' = 'provisioning',
): CloudCompute {
  const config = resolveComputeConfig(cloudConfig, purpose);
  const compute = PROVIDER_IMPL[config.cloudProvider].compute;
  if (!compute) {
    throw new InvalidAnycloudConfigError(
      storageOnlyComputeMessage(config.cloudProvider),
    );
  }
  return compute(config);
}

/** Resolve lifecycle scope without allocating an SDK client or probing a cloud. */
export function resolveComputeConfig(
  cloudConfig: CloudConfig,
  purpose: 'provisioning' | 'observed-vm',
) {
  const completed = completeCloudConfig(cloudConfig);
  // A missing recorded zone cannot become today's provisioning default:
  // zonal not-found would otherwise masquerade as exact native absence.
  return purpose === 'observed-vm' && cloudConfig.availabilityZone === undefined
    ? { ...completed, availabilityZone: undefined }
    : completed;
}

/**
 * Create the provider role that can mark an exact, database-known legacy VM.
 * Null means the provider cannot mutate ownership metadata after creation.
 */
export function createApiOwnershipProvider(
  cloudConfig: CloudConfig,
): CloudApiOwnership | null {
  const completed = completeCloudConfig(cloudConfig);
  // Provisioning needs a catalog-selected default zone, but ownership repair
  // must preserve "zone unknown" so GCP can locate this exact database-known
  // instance authoritatively instead of looking only in today's default zone.
  const ownershipConfig =
    cloudConfig.availabilityZone === undefined
      ? { ...completed, availabilityZone: undefined }
      : completed;
  const factory = PROVIDER_IMPL[ownershipConfig.cloudProvider].apiOwnership;
  return factory?.(ownershipConfig) ?? null;
}

/**
 * Create a storage provider from credentials and region.
 * If storageCreds is provided, uses those (cross-cloud). Otherwise uses compute
 * credentials, but still honors storageRegion so same-cloud storage can stay in
 * the bucket's region after compute failover.
 */
function createStorageProviderFromCreds(
  cloudConfig: CloudConfig,
  storageCreds?: CloudCredentials,
  storageRegion?: string,
): CloudStorage {
  if (storageCreds && !storageRegion && hasStorageRegions(storageCreds)) {
    throw new Error(
      'storageRegion is required when using cross-cloud storage credentials',
    );
  }
  const storageCloudConfig: CloudConfig = storageCreds
    ? {
        cloudProvider: storageCreds.cloudProvider,
        credentials: storageCreds,
        region: storageRegion,
      }
    : {
        ...cloudConfig,
        region: storageRegion ?? cloudConfig.region,
      };
  const provider = PROVIDER_IMPL[storageCloudConfig.cloudProvider];
  if (!provider.storage) {
    throw new Error(
      `Unsupported storage provider: ${storageCloudConfig.cloudProvider}`,
    );
  }
  // Storage has no placement. A GCP zone comes from the VM catalog, which a
  // hosted API has not fetched yet when it builds its backup storage at
  // startup: resolving one there crashed every GCP cluster's API.
  return provider.storage(
    completeCloudConfig(storageCloudConfig, { zone: false }),
  );
}

/**
 * Create a storage provider for the input bucket.
 * Uses inputStorageCredentials if set, otherwise falls back to compute credentials.
 */
export function createInputStorageProvider(
  cloudConfig: CloudConfig,
): CloudStorage {
  return createStorageProviderFromCreds(
    cloudConfig,
    cloudConfig.inputStorageCredentials,
    cloudConfig.inputStorageRegion,
  );
}

/**
 * Create a storage provider for the output bucket.
 * Uses outputStorageCredentials if set, otherwise falls back to compute credentials.
 */
export function createOutputStorageProvider(
  cloudConfig: CloudConfig,
): CloudStorage {
  return createStorageProviderFromCreds(
    cloudConfig,
    cloudConfig.outputStorageCredentials,
    cloudConfig.outputStorageRegion,
  );
}

/**
 * Create a storage provider for the checkpoint bucket.
 * Uses checkpointStorageCredentials if set, otherwise falls back to compute credentials.
 *
 * Invariant: for clouds without native storage, the compute-cred fallback
 * never fires — workload storage admission requires
 * checkpointStorageCredentials, and a cross-cloud checkpoint cred can never
 * hash-collide with a compute API key, so its id is always persisted and
 * reconstructed.
 */
export function createCheckpointStorageProvider(
  cloudConfig: CloudConfig,
): CloudStorage {
  return createStorageProviderFromCreds(
    cloudConfig,
    cloudConfig.checkpointStorageCredentials,
    cloudConfig.checkpointStorageRegion,
  );
}

export type RuntimeBucketStorageRole = 'input' | 'output' | 'checkpoint';

export interface RuntimeBucketStorageProviderFactories {
  input(cloudConfig: CloudConfig): CloudStorage;
  output(cloudConfig: CloudConfig): CloudStorage;
  checkpoint(cloudConfig: CloudConfig): CloudStorage;
}

async function resolveBucketRegion(
  storage: CloudStorage,
  bucketName: string,
): Promise<string | undefined> {
  return storage.getBucketRegion?.(bucketName);
}

/**
 * Resolve same-cloud bucket regions before constructing runtime storage
 * providers. This lets compute fail over to another region while bucket
 * preflight and rclone keep targeting the existing bucket's actual region.
 *
 * Explicit cross-cloud storage regions remain authoritative because they are
 * user config and already required by validation.
 */
export async function resolveRuntimeBucketStorageRegions(
  cloudConfig: CloudConfig,
  checkpointBucketName: string | undefined,
  roles: readonly RuntimeBucketStorageRole[],
  providers: RuntimeBucketStorageProviderFactories,
): Promise<CloudConfig> {
  const resolved: CloudConfig = { ...cloudConfig };
  const selected = new Set(roles);

  if (
    selected.has('input') &&
    resolved.inputBucket &&
    !resolved.inputStorageCredentials &&
    !resolved.inputStorageRegion
  ) {
    const region = await resolveBucketRegion(
      providers.input(resolved),
      resolved.inputBucket,
    );
    if (region) resolved.inputStorageRegion = region;
  }

  if (
    selected.has('output') &&
    resolved.outputBucket &&
    !resolved.outputStorageCredentials &&
    !resolved.outputStorageRegion
  ) {
    const region = await resolveBucketRegion(
      providers.output(resolved),
      resolved.outputBucket,
    );
    if (region) resolved.outputStorageRegion = region;
  }

  if (
    selected.has('checkpoint') &&
    checkpointBucketName &&
    !resolved.checkpointStorageCredentials &&
    !resolved.checkpointStorageRegion
  ) {
    const region = await resolveBucketRegion(
      providers.checkpoint(resolved),
      checkpointBucketName,
    );
    if (region) resolved.checkpointStorageRegion = region;
  }

  return resolved;
}

/** Validate compute-only provider capabilities for one VM candidate. */
export function validateComputeCapabilities(
  config: CloudConfig,
  suppliedGateway?: CloudCompute,
  supportsSpot: (gateway: CloudCompute) => boolean = isPreemptible,
): void {
  if (config.diskTier && !supportsDiskTier(config.cloudProvider)) {
    throw new InvalidAnycloudConfigError(
      `${config.cloudProvider} does not support --disk-tier`,
    );
  }

  // Constructing a gateway may itself validate provider-specific config. Keep
  // pure request-shape errors above that boundary so they retain HTTP 400
  // semantics instead of surfacing as an internal constructor error.
  const gateway = suppliedGateway ?? createComputeProvider(config);
  if (config.spot && !supportsSpot(gateway)) {
    throw new InvalidAnycloudConfigError(
      `${config.cloudProvider} does not support spot instances`,
    );
  }
}

/**
 * Validate storage request shape against the selected workload runtime.
 *
 * It deliberately does not construct a compute gateway.
 */
export function validateWorkloadStorageRequest(
  config: CloudConfig,
  checkSource = true,
): void {
  validateStorageRequestShape(config);
  validateStorageCapabilities(config, checkSource);

  if (config.inputBucket) {
    const cloud =
      config.inputStorageCredentials?.cloudProvider ?? config.cloudProvider;
    validateBucketName(cloud, config.inputBucket);
  }
  if (config.outputBucket) {
    const cloud =
      config.outputStorageCredentials?.cloudProvider ?? config.cloudProvider;
    validateBucketName(cloud, config.outputBucket);
  }
  if (config.checkpointBucket) {
    const cloud =
      config.checkpointStorageCredentials?.cloudProvider ??
      config.cloudProvider;
    validateBucketName(cloud, config.checkpointBucket);
  }
}

/** A storage-only provider (Cloudflare R2) has no regions to name. */
function hasStorageRegions(credentials: CloudCredentials): boolean {
  return isComputeProvider(credentials.cloudProvider);
}

/** Validate storage credential and region completeness before capability use. */
function validateStorageRequestShape(config: CloudConfig): void {
  const noNativeStorage = !PROVIDER_IMPL[config.cloudProvider].storage;

  if (
    config.inputBucket &&
    noNativeStorage &&
    !config.inputStorageCredentials
  ) {
    throw new InvalidAnycloudConfigError(
      `${config.cloudProvider} does not provide storage. Set inputStorageCredentials to use an input bucket.`,
    );
  }

  if (
    config.outputBucket &&
    noNativeStorage &&
    !config.outputStorageCredentials
  ) {
    throw new InvalidAnycloudConfigError(
      `${config.cloudProvider} does not provide storage. Set outputStorageCredentials to use an output bucket.`,
    );
  }

  if (
    hasCheckpointTarget(config) &&
    noNativeStorage &&
    !config.checkpointStorageCredentials
  ) {
    throw new InvalidAnycloudConfigError(
      `${config.cloudProvider} does not provide storage. Set checkpointStorageCredentials to use a checkpoint bucket.`,
    );
  }

  if (
    config.inputStorageCredentials &&
    !config.inputStorageRegion &&
    hasStorageRegions(config.inputStorageCredentials)
  ) {
    throw new InvalidAnycloudConfigError(
      'inputStorageRegion is required when using cross-cloud input storage credentials.',
    );
  }

  if (
    config.outputStorageCredentials &&
    !config.outputStorageRegion &&
    hasStorageRegions(config.outputStorageCredentials)
  ) {
    throw new InvalidAnycloudConfigError(
      'outputStorageRegion is required when using cross-cloud output storage credentials.',
    );
  }

  if (
    config.checkpointStorageCredentials &&
    !config.checkpointStorageRegion &&
    hasStorageRegions(config.checkpointStorageCredentials)
  ) {
    throw new InvalidAnycloudConfigError(
      'checkpointStorageRegion is required when using cross-cloud checkpoint storage credentials.',
    );
  }

  if (
    hasCheckpointTarget(config) &&
    requiresExplicitCheckpointStorage(config.cloudProvider) &&
    !config.checkpointStorageCredentials
  ) {
    const checkpointKind = config.checkpointBucket
      ? 'checkpoint storage'
      : 'spot';
    throw new InvalidAnycloudConfigError(
      `${config.cloudProvider} ${checkpointKind} requires checkpointStorageCredentials because ${config.cloudProvider} has no native storage identity.`,
    );
  }
}

/**
 * Validate scoped bucket-sync token minting at submit time (gateway-aware).
 *
 * The single source of truth for "can this storage mint scoped, short-lived
 * creds?" is the branded `CloudStorage` scoped-token capability
 * (`canMintScopedStorageToken`), determined by constructing the storage provider
 * — never a hardcoded cloud list or a parallel capability flag.
 * Every cloud requires them when the user supplies explicit storage
 * credentials. Throws DeployError(400) so the request fails fast at submit.
 *
 * Runs after storage request-shape validation, which already rejects missing
 * regions and same-cloud-no-storage cases with their own messages.
 *
 * `checkSource` false is a pool Job's admission, which proves its signing
 * credential with a trial mint instead of the provider's VM bucket-sync
 * source check (RFC 0043), and accepts an explicit GCP storage credential.
 */
export function validateStorageCapabilities(
  cloudConfig: CloudConfig,
  checkSource = true,
): void {
  const checks: Array<{
    label: 'input' | 'output' | 'checkpoint';
    creds: CloudCredentials | undefined;
    provider: () => CloudStorage;
  }> = [
    {
      label: 'input',
      creds: cloudConfig.inputStorageCredentials,
      provider: () => createInputStorageProvider(cloudConfig),
    },
    {
      label: 'output',
      creds: cloudConfig.outputStorageCredentials,
      provider: () => createOutputStorageProvider(cloudConfig),
    },
    {
      label: 'checkpoint',
      creds: cloudConfig.checkpointStorageCredentials,
      provider: () => createCheckpointStorageProvider(cloudConfig),
    },
  ];

  for (const { label, creds, provider } of checks) {
    if (!creds) continue;
    let storage: CloudStorage | undefined;
    try {
      storage = provider();
    } catch (error) {
      // A request the provider itself refuses, such as a region for R2,
      // reports why rather than a generic "can't mint".
      if (error instanceof InvalidAnycloudConfigError) throw error;
      storage = undefined;
    }

    // Any explicit cross-cloud storage cred must come from a provider that can
    // mint scoped, short-lived tokens through the branded CloudStorage surface.
    // GCP mints for its own VMs (RFC 0047) and for pool Jobs, whose trial mint
    // proves it (RFC 0043 D-s3gcs); widening explicit GCP storage credentials
    // to VM Jobs is a separate owner decision.
    if (
      !storage ||
      !canMintScopedStorageToken(storage) ||
      (creds.cloudProvider === CloudType.GCP && checkSource)
    ) {
      throw new DeployError(
        `Cross-cloud ${label} storage requires credentials that can mint scoped bucket-sync tokens (got ${creds.cloudProvider}). ` +
          `Use a same-cloud bucket or storage credentials that can mint scoped bucket-sync tokens.`,
        400,
      );
    }

    if (checkSource) storage.validateScopedStorageTokenSource();
  }
}

export function validateComputeCandidateConfig(
  cloudConfig: CloudConfig,
  gateway: CloudCompute,
): void {
  validateComputeCapabilities(cloudConfig, gateway, canLaunchSpotPools);
  validateWorkloadStorageRequest(cloudConfig);
}

/**
 * Encrypt credential using libsodium XSalsa20-Poly1305 (crypto_secretbox_easy).
 * Only credentials are encrypted - workload info is stored in SQLite.
 */
export async function encryptCredential(
  credential: SavedCredential,
): Promise<string> {
  return secretboxEncrypt(JSON.stringify(credential));
}

/**
 * Deterministic hash of plaintext credentials for deduplication.
 * Hashing plaintext (not ciphertext) ensures the same credentials always
 * produce the same ID, regardless of the random nonce used during encryption.
 */
export function hashCredential(credential: SavedCredential): string {
  return createHash('sha256').update(JSON.stringify(credential)).digest('hex');
}

/** A stored credential: a key or a role connection. */
export async function decryptCredential(
  token: string,
): Promise<CloudCredentials> {
  return JSON.parse(await secretboxDecrypt(token));
}

/**
 * Look up a named credential, decrypt it, and return the raw credentials along
 * with provider + DB id. Returns null if no credential with that name exists.
 */
export async function resolveCredentialByName(name: string): Promise<{
  id: string;
  cloudProvider: CloudType;
  creds: CloudCredentials;
} | null> {
  const credentials: CredentialReads = getCredentialSecretStore();
  const row = await credentials.getNamedCredential(name);
  if (!row) return null;
  const creds = await decryptCredential(row.encryptedData);
  return { id: row.id, cloudProvider: row.cloudProvider, creds };
}

/** A saved storage credential by name, as VM and pool Jobs name it. */
export async function resolveStorageCredential(
  name: string,
  role: 'Input' | 'Output' | 'Checkpoint',
): Promise<{ id: string; creds: CloudCredentials }> {
  const resolved = await resolveCredentialByName(name);
  if (!resolved) {
    throw new InvalidAnycloudConfigError(
      `${role} storage credential "${name}" not found`,
    );
  }
  return resolved;
}

/**
 * Create a storage provider for ad-hoc bucket access. Mirrors
 * createComputeProvider for use cases that need only CloudStorage (e.g. the
 * bucket I/O routes).
 */
export function createStorageProvider(cloudConfig: CloudConfig): CloudStorage {
  return createStorageProviderFromCreds(cloudConfig);
}

/**
 * Build CloudConfig from a stored workload + matching credentials.
 * The workload from SQLite has all the config data, just needs credentials.
 *
 * Return type is Required<CloudConfig> (all keys present, values may be
 * undefined). This is a compile-time guard: adding a new optional field to
 * CloudConfig causes a type error here until it is explicitly handled,
 * preventing the "field added to type but never persisted to DB" bug.
 */
function buildCloudConfig(
  workload: StoredWorkload,
  cloudProvider: CloudType,
  credentials: CloudCredentials,
  inputStorageCredentials?: CloudCredentials,
  outputStorageCredentials?: CloudCredentials,
  checkpointStorageCredentials?: CloudCredentials,
): Required<CloudConfig> {
  // Reduce vmType/gpuType to a single primary string for gateway-facing code.
  // The full array (if any) is still readable from `workload.*` and gets
  // expanded into a candidate pool by `resolveProvisioningConfig`.
  //
  // For gpuType arrays we walk to the first *resolvable* alias — picking
  // gpuType[0] blindly would leave vmType undefined when the user fronts the
  // list with an alias unknown to this cloud (e.g. `['fake', 'h100']`), which
  // resolveProvisioningConfig step 2 would then mark Invalid before the
  // candidate expansion ever runs.
  let vmType: string | undefined = toArray(workload.vmType)[0];
  if (!vmType) {
    for (const gpu of toArray(workload.gpuType)) {
      const resolved = resolveVMType(gpu, cloudProvider);
      if (resolved !== gpu) {
        vmType = resolved;
        break;
      }
    }
  }
  const config = {
    cloudProvider,
    region: workload.region ?? undefined,
    vmType: vmType ?? undefined,
    spot: workload.spot,
    diskSizeGb: workload.diskSizeGb ?? undefined,
    minimumDiskSizeGb: undefined,
    diskTier: workload.diskTier ?? undefined,
    diskIops: workload.diskIops ?? undefined,
    diskThroughputMibps: workload.diskThroughputMibps ?? undefined,
    regions: workload.regions ?? undefined,
    // Workloads follow the catalog on AWS; on GCP a node pool or a VM Job asks.
    nestedVirtualization: workload.requireNestedVirtualization || undefined,
    availabilityZone: workload.availabilityZone ?? undefined,
    credentials: extractCredentials(credentials),
    inputStorageCredentials: inputStorageCredentials ?? undefined,
    inputStorageRegion: workload.inputStorageRegion ?? undefined,
    outputStorageCredentials: outputStorageCredentials ?? undefined,
    outputStorageRegion: workload.outputStorageRegion ?? undefined,
    checkpointStorageCredentials: checkpointStorageCredentials ?? undefined,
    checkpointStorageRegion: workload.checkpointStorageRegion ?? undefined,
    inputBucket: workload.inputBucket ?? undefined,
    outputBucket: workload.outputBucket ?? undefined,
    checkpointBucket: workload.checkpointBucket ?? undefined,
    noCheckpoint: workload.noCheckpoint || undefined,
    minVmCount: undefined,
    maxVmCount: undefined,
  } satisfies AllKeysOf<CloudConfig>;
  return config as unknown as Required<CloudConfig>;
}

/** Exact scalar placement persisted on Provisioning claims and replays. */
export function buildProvisioningIntent(
  cloudConfig: CloudConfig,
  credentialId?: string,
): ProvisioningIntent {
  const vmType = Array.isArray(cloudConfig.vmType)
    ? cloudConfig.vmType[0]
    : cloudConfig.vmType;
  return {
    cloudProvider: cloudConfig.cloudProvider,
    availabilityZone: cloudConfig.availabilityZone ?? null,
    ...(cloudConfig.region ? { region: cloudConfig.region } : {}),
    ...(vmType ? { vmType } : {}),
    ...(credentialId ? { credentialId } : {}),
  };
}

// Compile-time guard: forces every CloudConfig key to appear in the literal,
// while still allowing undefined values. `Required<T>` strips undefined; the
// naive `[K in keyof T]-?` does too. Iterating over `keyof Required<T>` keeps
// every key required and re-adds `undefined` to the value type explicitly.
type AllKeysOf<T> = {
  [K in keyof Required<T>]: K extends keyof T ? T[K] | undefined : never;
};

export interface ActiveComputeIdentity {
  credentialId: string;
  cloudProvider: CloudType;
  credentials: CloudCredentials;
}

/** The stored-credential read that loads per-bucket storage credentials. */
export interface StorageCredentialReads {
  getCredential(credentialId: string): Promise<string | null>;
}

/** The saved-credential reads that build a workload's cloud configuration. */
interface CredentialReads extends StorageCredentialReads {
  getCredentialWithCloudProvider(credentialId: string): Promise<{
    encryptedData: string;
    cloudProvider: CloudType;
  } | null>;
  getNamedCredential(name: string): Promise<{
    id: string;
    encryptedData: string;
    cloudProvider: CloudType;
  } | null>;
}

export interface WorkloadConfigStore extends ProvisioningTargetStore {
  resolveActiveCredentialId(
    workload: StoredWorkload,
    computeCredIdOverride?: string,
  ): Promise<string | undefined>;
}

export async function loadWorkloadStorageCredentials(
  workload: StoredWorkload,
  credentials: StorageCredentialReads,
  activeCredentialId?: string,
): Promise<{
  inputStorageCredentials?: CloudCredentials;
  outputStorageCredentials?: CloudCredentials;
  checkpointStorageCredentials?: CloudCredentials;
}> {
  let inputStorageCredentials: CloudCredentials | undefined;
  if (
    workload.inputStorageCredentialId &&
    workload.inputStorageCredentialId !== activeCredentialId
  ) {
    const data = await credentials.getCredential(
      workload.inputStorageCredentialId,
    );
    if (data) {
      inputStorageCredentials = await decryptCredential(data);
    }
  }

  let outputStorageCredentials: CloudCredentials | undefined;
  if (
    workload.outputStorageCredentialId &&
    workload.outputStorageCredentialId !== activeCredentialId
  ) {
    const data = await credentials.getCredential(
      workload.outputStorageCredentialId,
    );
    if (data) {
      outputStorageCredentials = await decryptCredential(data);
    }
  }

  let checkpointStorageCredentials: CloudCredentials | undefined;
  if (
    workload.checkpointStorageCredentialId &&
    workload.checkpointStorageCredentialId !== activeCredentialId
  ) {
    const data = await credentials.getCredential(
      workload.checkpointStorageCredentialId,
    );
    if (data) {
      checkpointStorageCredentials = await decryptCredential(data);
    }
  }

  return {
    inputStorageCredentials,
    outputStorageCredentials,
    checkpointStorageCredentials,
  };
}

async function buildCredentiallessCloudConfigForProvider(
  workload: StoredWorkload,
  credentials: StorageCredentialReads,
  cloudProvider: CloudType,
): Promise<Required<CloudConfig>> {
  const {
    inputStorageCredentials,
    outputStorageCredentials,
    checkpointStorageCredentials,
  } = await loadWorkloadStorageCredentials(workload, credentials);
  const config = {
    cloudProvider,
    region: workload.region ?? undefined,
    vmType: toArray(workload.vmType)[0] ?? undefined,
    spot: workload.spot,
    diskSizeGb: workload.diskSizeGb ?? undefined,
    minimumDiskSizeGb: undefined,
    diskTier: workload.diskTier ?? undefined,
    diskIops: workload.diskIops ?? undefined,
    diskThroughputMibps: workload.diskThroughputMibps ?? undefined,
    regions: workload.regions ?? undefined,
    // Workloads follow the catalog on AWS; on GCP a node pool or a VM Job asks.
    nestedVirtualization: workload.requireNestedVirtualization || undefined,
    availabilityZone: workload.availabilityZone ?? undefined,
    credentials: undefined,
    inputStorageCredentials: inputStorageCredentials ?? undefined,
    inputStorageRegion: workload.inputStorageRegion ?? undefined,
    outputStorageCredentials: outputStorageCredentials ?? undefined,
    outputStorageRegion: workload.outputStorageRegion ?? undefined,
    checkpointStorageCredentials: checkpointStorageCredentials ?? undefined,
    checkpointStorageRegion: workload.checkpointStorageRegion ?? undefined,
    inputBucket: workload.inputBucket ?? undefined,
    outputBucket: workload.outputBucket ?? undefined,
    checkpointBucket: workload.checkpointBucket ?? undefined,
    noCheckpoint: workload.noCheckpoint || undefined,
    minVmCount: undefined,
    maxVmCount: undefined,
  } satisfies AllKeysOf<CloudConfig>;
  return config as unknown as Required<CloudConfig>;
}

async function buildCloudConfigForIdentity(
  workload: StoredWorkload,
  credentials: CredentialReads,
  active: ActiveComputeIdentity,
): Promise<Required<CloudConfig>> {
  // Load per-bucket storage credentials if they differ from compute.
  const {
    inputStorageCredentials,
    outputStorageCredentials,
    checkpointStorageCredentials,
  } = await loadWorkloadStorageCredentials(
    workload,
    credentials,
    active.credentialId,
  );

  return buildCloudConfig(
    workload,
    active.cloudProvider,
    active.credentials,
    inputStorageCredentials,
    outputStorageCredentials,
    checkpointStorageCredentials,
  );
}

/**
 * Resolve the one compute identity that should be used for the current attempt.
 * Runtime stays scalar: one credential, one cloud, one gateway. Before a VM
 * exists, remote workloads use workloads.credential_id. After a VM exists,
 * status/cleanup/completion paths prefer that VM's credential so they keep
 * talking to the cloud that actually owns it.
 */
export async function resolveActiveComputeIdentity(
  workload: StoredWorkload,
  computeCredIdOverride?: string,
): Promise<ActiveComputeIdentity | null> {
  const store = getWorkloadQueryStore();
  const credentialId = await store.resolveActiveCredentialId(
    workload,
    computeCredIdOverride,
  );
  if (!credentialId) return null;

  const saved: CredentialReads = getCredentialSecretStore();
  const row = await saved.getCredentialWithCloudProvider(credentialId);
  if (!row) return null;
  const credentials = await decryptCredential(row.encryptedData);
  return { credentialId, cloudProvider: row.cloudProvider, credentials };
}

interface BillingIdentity {
  cloudProvider: CloudType | null;
  encryptedData: string | null;
}

/** The attempt-ledger read that finds a Workload VM's billing identity. */
interface WorkloadBillingIdentities {
  getWorkloadBillingIdentity(
    workloadId: string,
    credentialId: string | null,
  ): Promise<BillingIdentity | null>;
}

/**
 * Resolve the identity that owns an ended VM's provider bill. Billing does not
 * need container payloads, SSH/storage secrets, or requested placement, so
 * damage to those unrelated fields must not prevent cost reconciliation.
 * Repository owner/spec guards and compute credential failures still apply.
 */
export async function loadBillingIdentity(
  firstVm: Pick<
    VmNeedingCost,
    'workload_id' | 'credential_id' | 'region' | 'vm_type'
  > &
    Partial<Pick<VmNeedingCost, 'node_pool_id' | 'cluster_id'>>,
): Promise<VmCostIdentity | null> {
  let stored: BillingIdentity | null;
  if (firstVm.workload_id) {
    const attempts: WorkloadBillingIdentities = getProvisioningAttemptStore();
    stored = await attempts.getWorkloadBillingIdentity(
      firstVm.workload_id,
      firstVm.credential_id,
    );
  } else if (
    (firstVm.node_pool_id || firstVm.cluster_id) &&
    firstVm.region &&
    firstVm.vm_type &&
    firstVm.credential_id
  ) {
    // Discovery already checked the deleted owner. Preserve the node pool
    // guard and exact attempt credential without re-reading that parent.
    const credentials: CredentialReads = getCredentialSecretStore();
    stored = await credentials.getCredentialWithCloudProvider(
      firstVm.credential_id,
    );
  } else {
    return null;
  }
  if (!stored || stored.cloudProvider === null) return null;
  if (stored.encryptedData === null) {
    return requiresComputeCredentials(stored.cloudProvider)
      ? null
      : { cloudProvider: stored.cloudProvider, credentials: undefined };
  }
  return {
    cloudProvider: stored.cloudProvider,
    credentials: extractCredentials(
      await decryptCredential(stored.encryptedData),
    ),
  };
}

/**
 * Load and decrypt configs for a workload.
 * Returns null if compute credentials are missing.
 * Per-bucket storage credentials are included when they differ from compute.
 *
 * `computeCredIdOverride` forces a specific compute credential id. Used by
 * cleanup/status callers that already know which attempt credential owns the
 * cloud resources they are touching.
 *
 * Placement starts from the request. When the latest provisioning attempt used
 * the same credential (or recorded none), its VM type and zone replace the
 * request's, and its region fills an unset one. Credentialless providers load
 * without a compute credential.
 */
export async function loadWorkloadConfigs(
  workload: StoredWorkload,
  computeCredIdOverride?: string,
): Promise<CloudConfig | null> {
  const store = getWorkloadQueryStore();
  const credentials: CredentialReads = getCredentialSecretStore();
  const active = await resolveActiveComputeIdentity(
    workload,
    computeCredIdOverride,
  );
  let config: Required<CloudConfig>;
  if (!active) {
    if (
      workload.cloudProvider &&
      !requiresComputeCredentials(workload.cloudProvider)
    ) {
      config = await buildCredentiallessCloudConfigForProvider(
        workload,
        credentials,
        workload.cloudProvider,
      );
    } else {
      return null;
    }
  } else {
    config = await buildCloudConfigForIdentity(workload, credentials, active);
  }

  // Recover concrete details from the latest provisioning attempt:
  // - region: only when the user omitted it.
  // - availabilityZone: prefer the concrete attempt when one was recorded.
  // - vmType: always prefer the actual resolved type over the request-array
  //   head, which may be a fake/unavailable ordered-fallback entry. This must
  //   NOT be gated on `!config.vmType` — buildCloudConfig always sets vmType,
  //   so that would never fire. Safe to override: latest.vmType is always one
  //   of this (immutable) workload's own candidates, so it's a no-op for a
  //   scalar/pinned deploy and the actual type for a fallback-array deploy.
  const latest = await store.getLatestProvisioningConfig(workload.id);
  const latestMatchesActive =
    !latest?.credentialId || latest.credentialId === active?.credentialId;
  if (latestMatchesActive && !config.region && latest?.region) {
    config.region = latest.region;
  }
  if (latestMatchesActive && latest?.vmType) {
    config.vmType = latest.vmType;
  }
  if (latestMatchesActive && latest?.availabilityZone) {
    config.availabilityZone = latest.availabilityZone;
  }

  return config;
}

export const PROVISIONING_CONFIG_RESOLUTION_TIMEOUT_MS = 30_000;

/**
 * Resolve all pre-deploy config: credentials, gpuType→vmType, region.
 * Returns a disposition that maps directly to the next WorkloadState.
 * This prepares a new placement: `Provisioning` carries the admitted target.
 */
export async function resolveProvisioningConfig(
  workload: StoredWorkload,
  store: WorkloadConfigStore,
  credentials: StorageCredentialReads,
  options: ProvisioningResolutionOptions = {},
): Promise<ProvisioningResolution> {
  const resolutionOptions: ProvisioningResolutionOptions = {
    ...options,
    deadlineAt:
      options.deadlineAt ??
      Date.now() + PROVISIONING_CONFIG_RESOLUTION_TIMEOUT_MS,
  };

  if (
    workload.cloudProvider &&
    !requiresComputeCredentials(workload.cloudProvider) &&
    !workload.credentialId
  ) {
    const cloudConfig = await buildCredentiallessCloudConfigForProvider(
      workload,
      credentials,
      workload.cloudProvider,
    );
    if (!cloudConfig.vmType) {
      return {
        state: WorkloadState.Invalid,
        message: 'Workload missing VM type',
      };
    }
    const result = await resolveProvisioningTarget(
      workload,
      cloudConfig,
      store,
      (vmType, region, availabilityZone) =>
        createComputeProvider({
          ...cloudConfig,
          vmType,
          region,
          availabilityZone,
        }),
      null,
      resolutionOptions,
    );
    return result;
  }

  if (!workload.credentialId) {
    return {
      state: WorkloadState.Invalid,
      message: 'Missing credentials for remote workload',
    };
  }

  const active = await resolveActiveComputeIdentity(workload);
  if (!active) {
    return {
      state: WorkloadState.Invalid,
      message: 'Missing credentials for workload',
    };
  }
  try {
    await catalogReadiness.ensureCatalogReady(active.cloudProvider);
  } catch (err) {
    if (catalogReadiness.isCatalogUnavailableError(err)) {
      return {
        state: WorkloadState.Queued,
        message: err.message,
      };
    }
    throw err;
  }

  // Step 1: Load and decrypt credentials, build CloudConfig
  const cloudConfig = await loadWorkloadConfigs(workload);
  if (!cloudConfig) {
    return {
      state: WorkloadState.Invalid,
      message: 'Missing credentials for workload',
    };
  }

  if (supportsDiskTier(cloudConfig.cloudProvider)) {
    cloudConfig.diskTier ??= DEFAULT_DISK_TIER;
  }

  // Step 2: vmType must be resolved after gpuType→vmType in buildCloudConfig
  if (!cloudConfig.vmType) {
    const gpuLabel = toArray(workload.gpuType).join(', ');
    const message = gpuLabel
      ? `GPU type "${gpuLabel}" is not available on ${cloudConfig.cloudProvider}`
      : 'Workload missing VM type';
    return { state: WorkloadState.Invalid, message };
  }

  // Steps 3+: resolving the (vmType, region) target — candidate expansion,
  // current account availability, workload-local failure rotation, and target
  // selection — is optimizer work. The gateway is constructed lazily (only past
  // the region-pinned fast paths) to keep pinned workloads from building one
  // needlessly.
  const result = await resolveProvisioningTarget(
    workload,
    cloudConfig,
    store,
    (vmType, region, availabilityZone) =>
      createComputeProvider({
        ...cloudConfig,
        vmType,
        region,
        availabilityZone,
      }),
    active.credentialId,
    resolutionOptions,
  );
  if (result.state !== WorkloadState.Provisioning) return result;

  return { ...result, credentialId: active?.credentialId };
}
