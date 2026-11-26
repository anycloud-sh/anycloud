import { createHash, createPrivateKey, randomUUID } from 'crypto';
import { JOB_HOST_DISK_GB } from '../job-host.js';
import type { ResolvedCloudConfig } from '../../../shared/cloud-config.js';
import https from 'https';
import http from 'http';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import type {
  InstancesClient,
  FirewallsClient,
  GlobalOperationsClient,
  ZoneOperationsClient,
  ImagesClient,
  DisksClient,
  MachineTypesClient,
  NetworksClient,
  protos,
} from '@google-cloud/compute';
type IOperation = protos.google.cloud.compute.v1.IOperation;
import type { Storage } from '@google-cloud/storage';

import {
  type CloudBaseImageResolver,
  createCloudBaseImageResolver,
} from './base-image.js';
import {
  CloudCompute,
  CloudStorage,
  deleteWithRetry,
  isTransientTransportError,
  CloudUploadSource,
  type CloudListPageOptions,
  type CloudObjectListOptions,
  type CloudStorageRetryPolicy,
  CandidateRegionAvailability,
  candidateRegionKey,
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
} from './cloud.js';
import {
  CloudType,
  CloudFailureDiagnosis,
  GCPCreds,
  type GCPInstanceCreds,
  type GCPRoleCreds,
  DiskTier,
  GpuRuntime,
} from '../../../shared/cloud.js';
import type { PermissionDenial } from '../../../shared/permission-denied.js';
import {
  type CloudResourceSweeper,
  createCloudResourceSweeper,
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
  BucketAccessDeniedError,
  BucketNameTakenError,
  InvalidAnycloudConfigError,
} from '../../../shared/errors.js';
import {
  type GatewayVM,
  type CloudResourceScope,
  type ResourceVM,
  type IngressSpec,
  type NewVMProps,
} from '../entities.js';
import { log } from '../logger.js';
import {
  DEFAULT_DISK_TIER,
  getZonesForVMType,
  validateGCPZoneSuffixSyntax,
  vmArchitecture,
} from '../../../shared/cloud-config.js';
import {
  memoizeAsyncTtl,
  type MemoizeAsyncTtlEntry,
  retryUntil,
  sleep,
  withRetry,
} from '../../../shared/utils.js';
import {
  diskMinimumSizeGb,
  type DiskPerformance,
  diskVolumePerformance,
  HYPERDISK_BALANCED_LIMITS,
} from '../../../shared/disk-performance.js';
import {
  GCP_BALANCED_PD_MEDIUM_SERIES,
  gcpBootsFromFastHyperdisk,
  gcpBootsFromHyperdisk,
  matchesGcpSeries,
} from '../../../shared/gcp-boot-disks.js';
import { gcpGpuMachineCapability } from '../../../shared/gcp-machine-capabilities.js';
import { gcpNestedMinCpuPlatform } from '../../../shared/catalog/nested-virtualization.js';
import { buildJobIngressSpec, isSharedJobIngress } from '../network.js';
import { numericRulePort, resolveFirewallPlan } from '../firewall-plan.js';
import {
  CandidatePreflightCache,
  runCandidatePreflightUnitSweep,
} from '../candidate-preflight-cache.js';
import { storageCoordinationKey } from './storage-coordinator.js';
import {
  VMRestartAttempt,
  VM_RESTART_CONSECUTIVE_OBSERVATIONS,
} from './vm-restart.js';
import { OWNER_API_TAG, getApiIdentity } from '../api-identity.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  createGcpGatewayClients,
  gcpProjectId,
  mintGcpDownscopedToken,
  readGcpProjectNumber,
} from '../provider-clients/gcp.js';

/** GCP VM instance statuses as returned by the Compute API */
const GcpInstanceStatus = {
  Provisioning: 'PROVISIONING',
  Staging: 'STAGING',
  Running: 'RUNNING',
  Stopping: 'STOPPING',
  Stopped: 'STOPPED',
  Terminated: 'TERMINATED',
  Suspended: 'SUSPENDED',
  Suspending: 'SUSPENDING',
  Repairing: 'REPAIRING',
  Deprovisioning: 'DEPROVISIONING',
} as const;

const GCP_VM_STATUS_REQUEST_TIMEOUT_MS = 25_000;
const GCP_SCOPE_ALLOW_PRIORITY = 0;
const GCP_SCOPE_DENY_PRIORITY = 1;
/** The network tag, and rule-name prefix, of the standing public-SSH rules every Job and VM shares. */
const GCP_SHARED_JOB_TAG = 'anycloud-shared-vm';
/**
 * VM Jobs' own network (RFC 0053), and the network tag and rule-name prefix
 * of its standing public-SSH rules: firewall names are project-wide. Auto
 * mode gives it a subnet in every region. A new network admits no ingress, so
 * a Job's VM reaches no other VM's internal address and takes only SSH.
 */
const GCP_JOBS_NETWORK = 'anycloud-jobs';
/**
 * The tag of VM Jobs launched into `default` before the Jobs network. Its
 * standing deny rules keep refusing those VMs their peers until they end, so
 * neither teardown nor the sweep takes them.
 */
const GCP_LEGACY_JOB_HOST_TAG = 'anycloud-job-host';
/**
 * One creation per project and region in this process: every `compute()` call builds a
 * new gateway, so a per-gateway memo wouldn't stop concurrent Jobs racing.
 * Rechecked every 15 minutes, so a deleted network is made again.
 */
const gcpJobsNetworks = new Map<string, MemoizeAsyncTtlEntry<void>>();

// Plan priority classes → GCP's flat allow space. `default` omits the field
// so ordinary workloads keep provider-default priority.
const GCP_PRIORITY_BY_CLASS = {
  'scope-allow': GCP_SCOPE_ALLOW_PRIORITY,
  'scope-deny': GCP_SCOPE_DENY_PRIORITY,
  default: undefined,
} as const;
const GCP_FIREWALL_TRAITS = {
  emitsScopeDeny: true,
  splitsSourceRangesByIpFamily: true,
} as const;

const GCP_ZONE_CAPACITY_CODES = new Set([
  'ZONE_RESOURCE_POOL_EXHAUSTED',
  'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS',
]);
const GCP_ZONE_CAPACITY_MESSAGE_PATTERN =
  /\bzone\b.*\bdoes not have enough resources available to fulfill the request\b/i;
const GCP_DISK_CONFIGURATION_CODES = new Set([
  'INVALID_FIELD_VALUE',
  'INVALID_RESOURCE_USAGE',
  'INVALID_ARGUMENT',
]);
const GCP_DISK_CONFIGURATION_MESSAGE_PATTERN =
  /(?:resource\.disks|initializeParams|diskType|provisionedIops|provisionedThroughput|boot disk|hyperdisk|persistent disk)/i;

type GcpBootDiskType = 'hyperdisk-balanced' | 'pd-balanced' | 'pd-ssd';

interface GcpBootDisk {
  readonly diskType: GcpBootDiskType | null;
  readonly diskSizeGb?: number;
  readonly provisionedIops?: number;
  readonly provisionedThroughput?: number;
}

function bootDiskFor(
  vmType: string,
  tier: DiskTier,
  requestedSizeGb: number | undefined,
  minimumDefaultSizeGb?: number,
  own: DiskPerformance = {},
): GcpBootDisk {
  const sizeGb = requestedSizeGb ?? minimumDefaultSizeGb;
  const diskSize = sizeGb === undefined ? {} : { diskSizeGb: sizeGb };
  const fastHyperdisk = gcpBootsFromFastHyperdisk(vmType);
  // A Job's own IOPS and MiB/s set Hyperdisk Balanced; a type booting from
  // Persistent Disk keeps its tier's disk, so a Job's fallback types may.
  const ownPerformance =
    fastHyperdisk &&
    (own.diskIops !== undefined || own.diskThroughputMibps !== undefined);

  if (tier === DiskTier.Medium && !ownPerformance) {
    if (gcpBootsFromHyperdisk(vmType)) {
      return { diskType: 'hyperdisk-balanced', ...diskSize };
    }
    return {
      diskType: matchesGcpSeries(vmType, GCP_BALANCED_PD_MEDIUM_SERIES)
        ? 'pd-balanced'
        : null,
      ...diskSize,
    };
  }

  if (!fastHyperdisk) return { diskType: 'pd-ssd', ...diskSize };

  // A VM Job's own IOPS and MiB/s override its tier's.
  const performance = diskVolumePerformance(
    HYPERDISK_BALANCED_LIMITS,
    tier,
    own,
  );
  const iops = performance.Iops!;
  const minimumSizeGb = diskMinimumSizeGb(iops);
  const diskSizeGb =
    requestedSizeGb ??
    Math.max(
      HYPERDISK_BALANCED_LIMITS.defaultSizeGb!,
      minimumDefaultSizeGb ?? 0,
    );
  // A Job's own IOPS never grow its disk: that would change its cost.
  if (diskSizeGb < minimumSizeGb) {
    throw new InvalidAnycloudConfigError(
      `GCP ${
        own.diskIops !== undefined
          ? `--disk-iops ${iops}`
          : `--disk-tier ${tier}`
      } on Hyperdisk Balanced requires ` +
        `--disk-size of at least ${minimumSizeGb} GB for VM type "${vmType}" ` +
        `(got ${diskSizeGb} GB).`,
    );
  }

  return {
    diskType: 'hyperdisk-balanced',
    diskSizeGb,
    provisionedIops: iops,
    provisionedThroughput: performance.Throughput!,
  };
}

function createGcpOperationFailure(
  operationError: NonNullable<IOperation['error']>,
): Error {
  const errors = operationError.errors ?? [];
  const errorMsg = errors
    .map((error) => error.message)
    .filter((message): message is string => typeof message === 'string')
    .join(', ');
  return Object.assign(
    new Error(
      `GCP operation failed: ${errorMsg || JSON.stringify(operationError)}`,
    ),
    { errors },
  );
}

function isGcpRestartRetryable(error: unknown): boolean {
  const value = error as {
    code?: number;
    statusCode?: number;
    errors?: { code?: string }[];
  } | null;
  const status = value?.statusCode ?? value?.code;
  return (
    isTransientTransportError(error) ||
    [4, 8, 10, 14, 429].includes(status ?? 0) ||
    (status !== undefined && status >= 500 && status < 600) ||
    (!!value?.errors?.length &&
      value.errors.every(
        ({ code }) =>
          code === 'RESOURCE_NOT_READY' ||
          code === 'RESOURCE_NOT_READY_WITH_DETAILS' ||
          GCP_ZONE_CAPACITY_CODES.has(code ?? ''),
      ))
  );
}

/** Check if GCP error means resource is already deleted */
export function isGCPNotFound(error: any): boolean {
  return !!(
    error.code === 5 || // gRPC NOT_FOUND status code
    error.code === 404 || // HTTP 404
    error.statusCode === 404 ||
    (error.message && error.message.includes('not found')) ||
    (error.message && error.message.includes('NotFound'))
  );
}

/**
 * Sanitize a string value for use as a GCP label value
 * GCP labels must be lowercase and can only contain alphanumeric chars, hyphens, and underscores
 * Invalid characters are replaced with underscores
 */
export function sanitizeGCPLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

/**
 * Generate a deterministic UUID v4 from a string
 * This ensures the same input always produces the same UUID for idempotency
 */
export function generateUUIDFromString(input: string): string {
  // Create SHA-256 hash of the input
  const hash = createHash('sha256').update(input).digest('hex');

  // Format as UUID v4 (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16), // Version 4
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      hash.substring(18, 20), // Variant bits
    hash.substring(20, 32),
  ].join('-');
}

// Shared HTTP agents for connection pooling across all GCP clients
// Prevents connection exhaustion under high concurrency (multiple tests, retries, concurrent ops)
// Reuses TCP connections which is faster and more reliable than opening new connections
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

// Cap concurrent in-flight GCP API calls per terminateVMs invocation.
// Same rationale as Azure: unbounded fan-out exhausts the container's
// ephemeral socket budget at 100s+ of vmIds.
const GCP_TERMINATE_CONCURRENCY = 20;

const GCP_CANDIDATE_FILTER_CONCURRENCY = 8;
const GCP_CANDIDATE_FILTER_PER_UNIT_TIMEOUT_MS = 5_000;
interface GcpCandidateAvailabilitySnapshot {
  availability: Map<string, CandidateRegionAvailability>;
  complete: boolean;
}
const gcpCandidatePreflightCache =
  new CandidatePreflightCache<GcpCandidateAvailabilitySnapshot>();
const GCP_STORAGE_RETRY_POLICY: CloudStorageRetryPolicy = {
  maxAttempts: 4,
  waitMs: 500,
  maxWaitMs: 4000,
  shouldRetry: isTransientTransportError,
};

export interface ResolvedGcpBaseImage {
  readonly imageId: string;
  readonly imageName?: string;
  readonly family: string;
  readonly project: string;
}

/** GCP implementation of the provider-neutral base-image lookup capability. */
export function createGcpBaseImageResolver(
  imagesClient: ImagesClient,
): CloudBaseImageResolver<ResolvedGcpBaseImage> {
  return createCloudBaseImageResolver({
    type: CloudType.GCP,
    rawResolveBaseImage: async ({
      gpuRuntime,
      vmType,
      minimal,
      architecture = 'amd64',
    }) => {
      const gpuCapability =
        gpuRuntime === GpuRuntime.Cuda && vmType
          ? gcpGpuMachineCapability(vmType)
          : undefined;
      if (gpuCapability && !gpuCapability.launchQualified) {
        throw new Error(
          `GCP GPU machine series ${gpuCapability.series} is not supported: ${gpuCapability.reason}`,
        );
      }

      const family =
        gpuRuntime === GpuRuntime.Cuda
          ? gpuCapability?.launchQualified === true
            ? gpuCapability.image.family
            : 'common-cu129-ubuntu-2404-nvidia-580'
          : minimal
            ? `ubuntu-minimal-2404-lts-${architecture}`
            : `ubuntu-2404-lts-${architecture}`;
      const project =
        gpuRuntime === GpuRuntime.Cuda
          ? gpuCapability?.launchQualified === true
            ? gpuCapability.image.project
            : 'deeplearning-platform-release'
          : 'ubuntu-os-cloud';
      const [image] = await imagesClient.getFromFamily({ family, project });
      if (!image.selfLink) {
        throw new Error(
          `GCP image family ${project}/${family} resolved without a self link`,
        );
      }
      return {
        imageId: image.selfLink,
        ...(image.name ? { imageName: image.name } : {}),
        family,
        project,
      };
    },
  });
}

type GcpOperationScope = 'zone' | 'global';

/**
 * RFC 0038 S3: a new account or key can reach OAuth before it has propagated,
 * and Google may refuse it on one frontend after another accepted it. Retry
 * only these exact failures at the bucket and object calls a just-saved key
 * makes — both listings, the existence check, bucket creation and deletion,
 * and object upload, download and deletion — with six calls and 23 seconds of
 * backoff, preserving the last error, which the storage layer then reports as
 * not ready.
 */
function withFirstUseBucketAuthentication<T>(
  operation: () => Promise<T>,
  name: string,
  signal?: AbortSignal,
): Promise<T> {
  return withRetry(operation, name, {
    maxAttempts: 6,
    waitMs: 1_000,
    maxWaitMs: 8_000,
    jitter: false,
    signal,
    shouldRetry: isGCPBucketAuthenticationRetryable,
  });
}

/** What a Compute error carries across its REST, SDK and operation shapes. */
function gcpErrorParts(error: any) {
  const code = error.Code ?? error.code ?? error.name;
  const msg =
    error.message ??
    error.Message ??
    error.error?.message ??
    error.response?.data?.error?.message ??
    '';
  const entries = [
    error.errors,
    error.error?.errors,
    error.response?.data?.error?.errors,
  ].flatMap((list) => (Array.isArray(list) ? list : []));
  const strings = (values: unknown[]) =>
    values.filter((value): value is string => typeof value === 'string');
  return {
    code,
    msg,
    entries,
    statuses: [code, error.error?.status, error.response?.data?.error?.status],
    reasons: strings(
      entries.flatMap((entry: any) => [
        entry?.reason,
        entry?.code,
        ...(Array.isArray(entry?.errorDetails)
          ? entry.errorDetails.map((detail: any) => detail?.errorInfo?.reason)
          : []),
      ]),
    ),
    messages: strings([msg, ...entries.map((entry: any) => entry?.message)]),
  };
}

/** A disabled API or billing account is refused with 403 too. */
const GCP_NOT_PERMISSION =
  /accessNotConfigured|SERVICE_DISABLED|BILLING_DISABLED|billing to be enabled/i;

/**
 * Compute's refusal of an authenticated service account: status
 * PERMISSION_DENIED, or a 403 (gRPC 7 through the SDK, which keeps only the
 * message) naming the permission, as in "Required 'compute.instances.create'
 * permission for …". Region limits are not classified (RFC 0047 open
 * question).
 */
function gcpPermissionDenial(error: unknown): PermissionDenial | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, statuses, reasons, messages } = gcpErrorParts(error);
  const text = messages.join('\n');
  if (GCP_NOT_PERMISSION.test([...reasons, text].join('\n'))) return undefined;
  if (
    !statuses.includes('PERMISSION_DENIED') &&
    !(
      (code === 403 || code === 7) &&
      (reasons.includes('forbidden') || /permission/i.test(text))
    )
  )
    return undefined;
  const action =
    text.match(
      /(?:Required '|Permission '?)([a-z]\w*(?:\.\w+)+)'? (?:permission|denied)/,
    )?.[1] ?? null;
  return { action, regional: false };
}

function isGCPBucketAuthenticationRetryable(error: unknown): boolean {
  const response = (
    error as {
      response?: {
        status?: unknown;
        data?: { error?: unknown; error_description?: unknown };
      };
    } | null
  )?.response;
  return (
    response?.status === 400 &&
    response.data?.error === 'invalid_grant' &&
    (response.data.error_description === 'Invalid JWT Signature.' ||
      response.data.error_description === 'Invalid grant: account not found')
  );
}

/** Test-only: clear the process-wide GCP candidate preflight cache. */
export function resetGcpCandidatePreflightCache(): void {
  gcpCandidatePreflightCache.clear();
}

export class GCP {
  public instancesClient: InstancesClient;
  public firewallsClient: FirewallsClient;
  public globalOperationsClient: GlobalOperationsClient;
  public zoneOperationsClient: ZoneOperationsClient;
  public imagesClient: ImagesClient;
  public disksClient: DisksClient;
  public machineTypesClient: MachineTypesClient;
  public networksClient: NetworksClient;
  public storageClient: Storage;
  projectId: string;
  private readonly configuredZone?: string;
  type: CloudType;
  vmType: string;
  region: string;
  spot?: boolean;
  diskSizeGb?: number;
  minimumDiskSizeGb?: number;
  diskTier: DiskTier;
  private readonly diskPerformance: DiskPerformance;
  nestedVirtualization: boolean;
  private storageCoordinationPrefix: string;
  private readonly key: GCPCreds | GCPRoleCreds | GCPInstanceCreds;
  private computeProvider?: CloudCompute;
  private storageProvider?: CloudStorage;
  private sweeperProvider?: CloudResourceSweeper;
  private apiOwnershipProvider?: CloudApiOwnership;

  constructor(gcpConfig: ResolvedCloudConfig) {
    this.type = CloudType.GCP;
    // vmType is collapsed to a scalar by completeCloudConfig before construction.
    this.vmType = Array.isArray(gcpConfig.vmType)
      ? gcpConfig.vmType[0]!
      : gcpConfig.vmType!;
    this.spot = gcpConfig.spot;
    this.diskSizeGb = gcpConfig.diskSizeGb;
    this.minimumDiskSizeGb = gcpConfig.minimumDiskSizeGb;
    this.diskTier = gcpConfig.diskTier ?? DEFAULT_DISK_TIER;
    this.diskPerformance = {
      diskIops: gcpConfig.diskIops,
      diskThroughputMibps: gcpConfig.diskThroughputMibps,
    };
    this.nestedVirtualization = gcpConfig.nestedVirtualization ?? false;
    const credentials = gcpConfig.credentials as
      | GCPCreds
      | GCPRoleCreds
      | GCPInstanceCreds;

    this.projectId = gcpProjectId(credentials);
    this.key = credentials;
    this.storageCoordinationPrefix = storageCoordinationKey([
      'gcp',
      this.projectId,
      !('kind' in credentials)
        ? credentials.clientEmail
        : credentials.kind === 'instance'
          ? 'instance'
          : credentials.serviceAccountEmail,
    ]);

    if (!gcpConfig.region) {
      throw new Error('GCP region is required');
    }

    // Existing resources and GCS operations must remain addressable when the
    // current catalog no longer advertises their compute placement. Gateway
    // construction therefore validates only provider-level suffix syntax.
    const zoneSuffix = gcpConfig.availabilityZone;
    if (zoneSuffix) {
      validateGCPZoneSuffixSyntax(zoneSuffix);
      this.configuredZone = `${gcpConfig.region}-${zoneSuffix}`;
    }
    this.region = gcpConfig.region;

    const clientOptions = {
      // Override default retry behavior for all Compute API operations
      // By default, GCP Compute marks all operations as "non_idempotent" (no retries)
      // We enable retries for transient errors (timeouts, unavailable, rate limits)
      clientConfig: {
        interfaces: {
          'google.cloud.compute.v1.Instances': {
            retry_codes: {
              idempotent: [
                'DEADLINE_EXCEEDED', // Timeout - safe to retry
                'UNAVAILABLE', // Service unavailable - safe to retry
                'RESOURCE_EXHAUSTED', // Rate limits/quotas - retry with backoff
              ],
            },
            retry_params: {
              idempotent: {
                initial_retry_delay_millis: 1000, // Start with 1s
                retry_delay_multiplier: 2.0, // Exponential backoff
                max_retry_delay_millis: 3600000, // Effectively no cap (1 hour)
                initial_rpc_timeout_millis: 60000, // 60s per attempt
                rpc_timeout_multiplier: 1.0,
                max_rpc_timeout_millis: 60000,
                total_timeout_millis: 5400000, // 90 minutes (matches provisioning timeout)
              },
            },
            methods: {
              // Enable retries for all Instance operations
              // Safe because Insert uses requestId for idempotency
              Insert: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Delete: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Get: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              List: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              AggregatedList: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Start: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Stop: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Reset: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
            },
          },
          'google.cloud.compute.v1.Firewalls': {
            retry_codes: {
              idempotent: [
                'DEADLINE_EXCEEDED',
                'UNAVAILABLE',
                'RESOURCE_EXHAUSTED',
              ],
            },
            retry_params: {
              idempotent: {
                initial_retry_delay_millis: 1000,
                retry_delay_multiplier: 2.0,
                max_retry_delay_millis: 3600000,
                initial_rpc_timeout_millis: 60000,
                rpc_timeout_multiplier: 1.0,
                max_rpc_timeout_millis: 60000,
                total_timeout_millis: 5400000,
              },
            },
            methods: {
              Insert: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Delete: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Get: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              List: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
            },
          },
          'google.cloud.compute.v1.Images': {
            retry_codes: {
              idempotent: [
                'DEADLINE_EXCEEDED',
                'UNAVAILABLE',
                'RESOURCE_EXHAUSTED',
              ],
            },
            retry_params: {
              idempotent: {
                initial_retry_delay_millis: 1000,
                retry_delay_multiplier: 2.0,
                max_retry_delay_millis: 3600000,
                initial_rpc_timeout_millis: 60000,
                rpc_timeout_multiplier: 1.0,
                max_rpc_timeout_millis: 60000,
                total_timeout_millis: 5400000,
              },
            },
            methods: {
              GetFromFamily: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Get: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
            },
          },
          'google.cloud.compute.v1.Disks': {
            retry_codes: {
              idempotent: [
                'DEADLINE_EXCEEDED',
                'UNAVAILABLE',
                'RESOURCE_EXHAUSTED',
              ],
            },
            retry_params: {
              idempotent: {
                initial_retry_delay_millis: 1000,
                retry_delay_multiplier: 2.0,
                max_retry_delay_millis: 3600000,
                initial_rpc_timeout_millis: 60000,
                rpc_timeout_multiplier: 1.0,
                max_rpc_timeout_millis: 60000,
                total_timeout_millis: 5400000,
              },
            },
            methods: {
              Insert: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Delete: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              Get: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
              List: {
                retry_codes_name: 'idempotent',
                retry_params_name: 'idempotent',
              },
            },
          },
        },
      },
      // Add HTTP agents for connection pooling
      // This prevents ETIMEDOUT errors under high concurrency by reusing connections
      transportOptions: {
        agent: httpsAgent,
        http: httpAgent,
      },
    };

    const clients = createGcpGatewayClients(credentials, clientOptions);
    this.instancesClient = clients.instances;
    this.firewallsClient = clients.firewalls;
    this.globalOperationsClient = clients.globalOperations;
    this.zoneOperationsClient = clients.zoneOperations;
    this.imagesClient = clients.images;
    this.disksClient = clients.disks;
    this.machineTypesClient = clients.machineTypes;
    this.networksClient = clients.networks;
    this.storageClient = clients.storage;
  }

  private requireZone(operation: string): string {
    if (!this.configuredZone) {
      throw new Error(
        `GCP availability zone is required to ${operation}. ` +
          'Resolve an exact provisioning target before performing this operation.',
      );
    }
    return this.configuredZone;
  }

  private get zone(): string {
    return this.requireZone('perform this zonal operation');
  }

  compute(): CloudCompute {
    this.computeProvider ??= createCloudCompute({
      type: this.type,
      region: this.region,
      spot: this.spot,
      vmType: this.vmType,
      rawValidateCredentials: () => this.validateCredentials(),
      rawClassifyError: (error) => this.classifyError(error),
      permissionDenial: (error) => gcpPermissionDenial(error),
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
      terminateVMsConcurrency: GCP_TERMINATE_CONCURRENCY,
      stoppedVmObservation: {
        observeStoppedVm: (cloudId) => this.verifyVMPreemption(cloudId),
      },
      stoppedVmRestart: {
        verifyVMPreemption: (cloudId) => this.verifyVMPreemption(cloudId),
        startVM: (cloudId) => this.startVM(cloudId),
      },
      ingressSupport: {
        supportsIngress: () => true,
      },
      candidateRegionFilter: this.createCandidateRegionFilter(),
      resourceScoped: {
        prepareResourceNetwork: (spec, scope, version) =>
          this.prepareNetwork(
            spec,
            scope.id,
            version,
            scope.tags.anycloud_user ?? 'unknown',
          ),
        newResourceVM: ({ scope, ...params }) =>
          this.newVM({
            ...params,
            workloadId: scope.id,
            userId: scope.tags.anycloud_user ?? 'unknown',
            resourceScope: scope,
          }),
        listResourceVMs: (scope) => this.listResourceVMs(scope),
        terminateResourceNetwork: (scope) => this.terminateNetworking(scope.id),
      },
    });
    return this.computeProvider;
  }

  sweeper(): CloudResourceSweeper {
    this.sweeperProvider ??= createCloudResourceSweeper({
      type: this.type,
      region: this.region,
      rawSweepResources: (options) => this.sweepResources(options),
      rawSweepStorage: (options) =>
        this.sweepBuckets(options, {
          vmIds: [],
          otherResources: [],
          errors: [],
        }),
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
      retryPolicy: GCP_STORAGE_RETRY_POLICY,
      rawBucketCoordinationKey: (bucketName) =>
        this.bucketCoordinationKey(bucketName),
      rawHasBucket: (bucketName) =>
        withFirstUseBucketAuthentication(
          () => this.hasBucketUncoordinated(bucketName),
          'GCP bucket check authentication',
        ),
      rawGetBucketVersioning: async (bucketName) => {
        const [metadata] = await this.storageClient
          .bucket(bucketName)
          .getMetadata();
        return metadata.versioning?.enabled ? 'enabled' : 'disabled';
      },
      rawEnableBucketVersioning: async (bucketName) => {
        await this.storageClient
          .bucket(bucketName)
          .setMetadata({ versioning: { enabled: true } });
      },
      rawUpsertBucketUncoordinated: (bucketName, version, workloadId, userId) =>
        withFirstUseBucketAuthentication(
          () =>
            this.upsertBucketUncoordinated(
              bucketName,
              version,
              workloadId,
              userId,
            ),
          'GCP bucket creation authentication',
        ),
      rawCreateOwnedBucket: (bucketName, version, workloadId, userId) =>
        withFirstUseBucketAuthentication(
          () => this.createOwnedBucket(bucketName, version, workloadId, userId),
          'GCP bucket creation authentication',
        ),
      rawDeleteBucket: (bucketName) =>
        withFirstUseBucketAuthentication(
          () => this.deleteBucket(bucketName),
          'GCP bucket deletion authentication',
        ),
      rawDeleteObject: (bucketName, remotePath) =>
        withFirstUseBucketAuthentication(
          () => this.deleteObject(bucketName, remotePath),
          'GCP object deletion authentication',
        ),
      // Each attempt reopens the upload source, and the token exchange this
      // retries precedes any object bytes.
      rawUploadObject: ({ bucketName, remotePath, source }) =>
        withFirstUseBucketAuthentication(
          () => this.uploadObject(bucketName, remotePath, source),
          'GCP object upload authentication',
        ),
      rawDownloadObject: (bucketName, remotePath) =>
        withFirstUseBucketAuthentication(
          () => this.downloadObject(bucketName, remotePath),
          'GCP object download authentication',
        ),
      rawListBuckets: (options, signal) => this.listBuckets(options, signal),
      rawListObjects: (bucketName, options, signal) =>
        withFirstUseBucketAuthentication(
          () => this.listObjects(bucketName, options),
          'GCP object listing authentication',
          signal,
        ),
      // "Invalid grant: account not found" names the credential, not the
      // object: a delete must not read it as already gone.
      isNotFound: (error) =>
        !isGCPBucketAuthenticationRetryable(error) && isGCPNotFound(error),
      // A key Google still refuses after those retries answers 503
      // BUCKET_CREDENTIAL_NOT_READY, not an uncategorized 500.
      isCredentialNotReady: isGCPBucketAuthenticationRetryable,
      // VMs have no service account (RFC 0047): every bucket syncs with a
      // token downscoped from this key to that one bucket.
      validateScopedStorageTokenSource: () => undefined,
      mintScopedStorageToken: async (grants, options) => {
        if (grants.length === 0) return undefined;
        const { token, expiresAt } = await mintGcpDownscopedToken(
          this.key,
          grants,
          options?.lifetimeMs,
        );
        return {
          credentials: { cloudProvider: CloudType.GCP, accessToken: token },
          expiresAt,
        };
      },
      // Status only: isGCPNotFound's message match would also claim OAuth's
      // "Invalid grant: account not found". Without an object read a 404 can
      // only be the bucket; GCS answers a download's 404 for a missing bucket
      // and a missing object alike, so the bucket's existence decides.
      classifyStorageFailure: async (error, bucketName, remotePath) => {
        const failure = error as { code?: unknown; status?: unknown } | null;
        const status =
          typeof failure?.code === 'number' ? failure.code : failure?.status;
        const code = `HTTP ${status}`;
        if (status === 403) return { kind: 'denied', code };
        if (status === 429) return { kind: 'throttled', code };
        if (status !== 404 || bucketName === undefined) return undefined;
        if (remotePath === undefined) return { kind: 'bucket-missing', code };
        return (await this.hasBucketUncoordinated(bucketName))
          ? { kind: 'object-missing', code }
          : { kind: 'bucket-missing', code };
      },
    });
    return this.storageProvider;
  }

  /**
   * Report whether this project can see each exact machine-type/region pair.
   * Quota remains on the reactive classifier path because AnyCloud does not yet
   * have a GCP quota-status provider.
   */
  private createCandidateRegionFilter() {
    return createCandidateRegionFilter({
      cache: gcpCandidatePreflightCache,
      cacheKey: ({ candidates }) =>
        JSON.stringify([this.projectId, exactCandidatePairsKey(candidates)]),
      operationName: ({ workloadId }) =>
        `read GCP candidate availability for ${workloadId}`,
      assessLocalEligibility: (candidate) => {
        try {
          bootDiskFor(
            candidate.vmType,
            this.diskTier,
            this.diskSizeGb,
            this.minimumDiskSizeGb,
            this.diskPerformance,
          );
          return { eligible: true };
        } catch (error) {
          if (error instanceof InvalidAnycloudConfigError) {
            return { eligible: false, reason: error.message };
          }
          throw error;
        }
      },
      runPreflight: ({ candidates, workloadId, signal }) =>
        this.runCandidatePreflight(candidates, workloadId, signal),
      isComplete: (snapshot) => snapshot.complete,
      assess: (snapshot, candidate) =>
        snapshot.availability.get(candidateRegionKey(candidate)),
    });
  }

  private async runCandidatePreflight(
    candidates: CandidateRegion[],
    workloadId: string,
    signal: AbortSignal,
  ): Promise<GcpCandidateAvailabilitySnapshot> {
    // The filter already deduplicates exact targets. In normal optimizer use,
    // every GCP candidate carries a catalog-compatible zone, and preflight
    // verifies that exact placement rather than finding a zone and discarding
    // which one succeeded.
    const sweep = await runCandidatePreflightUnitSweep<
      CandidateRegion,
      boolean
    >({
      units: candidates,
      concurrency: GCP_CANDIDATE_FILTER_CONCURRENCY,
      perUnitTimeoutMs: GCP_CANDIDATE_FILTER_PER_UNIT_TIMEOUT_MS,
      signal,
      operationName: (unit) =>
        `GCP candidate machine type ${unit.region}${unit.availabilityZone ? `-${unit.availabilityZone}` : ''} ${unit.vmType}`,
      readUnit: (unit, unitSignal) =>
        this.isMachineTypeAvailableForTarget(
          unit.vmType,
          unit.region,
          unit.availabilityZone,
          unitSignal,
        ),
    });

    const availability = new Map<string, CandidateRegionAvailability>();
    for (const [unit, available] of sweep.values) {
      availability.set(
        candidateRegionKey(unit),
        available
          ? CandidateRegionAvailability.Verified
          : CandidateRegionAvailability.Unavailable,
      );
    }

    if (sweep.failures.length > 0) {
      log.warn('Failed to read GCP machine types for candidate regions', {
        id: workloadId,
        failedUnits: sweep.failures.length,
        units: sweep.failures
          .slice(0, 10)
          .map(
            (failure) =>
              `${failure.unit.vmType}:${failure.unit.region}${failure.unit.availabilityZone ? `-${failure.unit.availabilityZone}` : ''}`,
          )
          .join(','),
        durationMs: sweep.durationMs,
        error:
          sweep.failures[0]?.error instanceof Error
            ? sweep.failures[0].error.message
            : sweep.failures[0]?.error,
      });
    }

    for (const { unit } of sweep.failures) {
      availability.set(
        candidateRegionKey(unit),
        CandidateRegionAvailability.Unknown,
      );
    }

    return {
      availability,
      complete: sweep.failures.length === 0,
    };
  }

  private async isMachineTypeAvailableForTarget(
    vmType: string,
    region: string,
    availabilityZone?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Region-only candidates are retained for direct/backward-compatible use,
    // but even they search only zones where the exact type appears in the
    // published catalog.
    const suffixes = availabilityZone
      ? [availabilityZone]
      : getZonesForVMType(region, vmType);
    if (suffixes.length === 0) return false;

    for (const suffix of suffixes) {
      signal?.throwIfAborted();
      const zone = `${region}-${suffix}`;
      try {
        await this.machineTypesClient.get({
          project: this.projectId,
          zone,
          machineType: vmType,
        });
        return true;
      } catch (error) {
        if (isGCPNotFound(error)) continue;
        throw error;
      }
    }

    return false;
  }

  /**
   * Generate resource tags in GCP label format
   * GCP labels must be lowercase and can only contain alphanumeric chars, hyphens, and underscores
   * All invalid characters are replaced with underscores
   */
  private getResourceTags(
    workloadId: string,
    version: string,
    userId: string,
    endedAt?: number,
    resourceScope?: CloudResourceScope,
  ): { [key: string]: string } {
    const labels: { [key: string]: string } = resourceScope
      ? {
          ...Object.fromEntries(
            Object.entries(resourceScope.tags).map(([key, value]) => [
              sanitizeGCPLabel(key),
              sanitizeGCPLabel(value),
            ]),
          ),
          anycloud_resource: sanitizeGCPLabel(resourceScope.id),
          anycloud_version: sanitizeGCPLabel(version),
          [OWNER_API_TAG]: getApiIdentity(),
        }
      : {
          anycloud_deployment: sanitizeGCPLabel(workloadId),
          anycloud_version: sanitizeGCPLabel(version),
          anycloud_user: sanitizeGCPLabel(userId),
          [OWNER_API_TAG]: getApiIdentity(),
          // Note: anycloud_created_at intentionally omitted from labels to ensure idempotency
          // when retrying VM creation. GCP automatically tracks creation time via the
          // resource's creationTimestamp. Including Date.now() here would cause issues
          // on retries since the timestamp changes between attempts.
        };
    if (endedAt !== undefined) {
      labels.anycloud_ended_at = endedAt.toString();
    }
    return labels;
  }

  private async backfillExactVmApiOwnership(
    target: ExactVmApiOwnership,
  ): Promise<ApiOwnershipBackfillResult> {
    const zone =
      this.configuredZone ?? (await this.discoverInstanceZone(target.cloudId));
    if (!zone) return ApiOwnershipBackfillResult.Missing;
    let instance: protos.google.cloud.compute.v1.IInstance;
    try {
      [instance] = await this.instancesClient.get({
        project: this.projectId,
        zone,
        instance: target.cloudId,
      });
    } catch (error) {
      if (isGCPNotFound(error)) {
        return ApiOwnershipBackfillResult.Missing;
      }
      throw error;
    }

    const labels = instance.labels ?? {};
    const decision = apiOwnershipTagDecision(labels, {
      ...target,
      ownerId: sanitizeGCPLabel(target.ownerId),
      userId: sanitizeGCPLabel(target.userId),
    });
    if (decision === 'already-owned') {
      return ApiOwnershipBackfillResult.AlreadyOwned;
    }
    const [operation] = await this.instancesClient.setLabels({
      project: this.projectId,
      zone,
      instance: target.cloudId,
      instancesSetLabelsRequestResource: {
        labels: {
          ...labels,
          [OWNER_API_TAG]: target.apiIdentity,
        },
        labelFingerprint: instance.labelFingerprint,
      },
    });
    await this.waitForOperation(operation, 'zone', zone);
    return ApiOwnershipBackfillResult.Updated;
  }

  /**
   * Wait for a zone operation to complete
   * Throws an error if the operation fails
   */
  // The GCP compute SDK returns LROperation<IOperation, null> from mutating
  // methods. At runtime it carries the same name/status/error fields as
  // IOperation, but the TS types diverge on `error`. We accept those fields
  // (never `unknown`, which would hide the SDK value from the drift scan) and
  // cast once here so every call site stays clean.
  async waitForOperation(
    rawOperation:
      | { name?: string | null; status?: unknown; error?: unknown }
      | null
      | undefined,
    scope: GcpOperationScope = 'zone',
    zoneOverride?: string,
    restart?: VMRestartAttempt,
  ): Promise<void> {
    const operation = rawOperation as IOperation | undefined;
    if (!operation) {
      throw new Error('GCP operation returned undefined');
    }
    // If operation is already done, check for errors
    if (operation.status === 'DONE') {
      if (operation.error) {
        throw createGcpOperationFailure(operation.error);
      }
      return;
    }

    // The operation name might be a full URL like:
    // "https://www.googleapis.com/compute/v1/projects/PROJECT/zones/ZONE/operations/OPERATION_ID"
    // or just the operation ID
    let operationName = operation.name;
    if (typeof operationName === 'string' && operationName.includes('/')) {
      operationName = operationName.split('/').pop();
    }

    let currentOp = operation;

    const client =
      scope === 'global'
        ? this.globalOperationsClient
        : this.zoneOperationsClient;
    const request = {
      operation: operationName,
      project: this.projectId,
      ...(scope === 'zone' ? { zone: zoneOverride ?? this.zone } : {}),
    };
    while (currentOp.status !== 'DONE') {
      try {
        [currentOp] = restart
          ? await client.wait(request, { retry: null })
          : await client.wait(request);
      } catch (error: any) {
        // If operation not found, it may have completed already
        if (isGCPNotFound(error)) {
          break;
        }
        if (restart && isGcpRestartRetryable(error)) {
          // Keep observing this accepted operation after a failed read; a
          // transport failure is not evidence that another start is needed.
          await sleep(5000, restart.signal);
          continue;
        }
        throw error;
      }
      if (restart && currentOp.status !== 'DONE')
        await sleep(5000, restart.signal);
    }

    // Check if the final operation has an error
    if (currentOp.error) {
      throw createGcpOperationFailure(currentOp.error);
    }
  }

  private async newVM(params: NewVMProps): Promise<GatewayVM> {
    const zone = this.requireZone('create a new VM');
    const { startupScript, vmId, workloadId, version, gpuRuntime, userId } =
      params;
    // Firewall rules should already exist from upsertFirewall() called by provisionVMs()
    // No need to call again - GCP firewall rules are idempotent by name

    const gpuCapability =
      gpuRuntime === GpuRuntime.Cuda
        ? gcpGpuMachineCapability(this.vmType)
        : undefined;
    // createCloudCompute enforces GCP's accelerator-runtime capability before
    // raw provider code runs, so image selection receives CUDA or CPU only.
    const { imageId: sourceImage } = await createGcpBaseImageResolver(
      this.imagesClient,
    ).resolveBaseImage({
      gpuRuntime,
      vmType: this.vmType,
      minimal: params.jobHost,
      architecture: vmArchitecture(CloudType.GCP, this.vmType),
    });

    // Translate the effective tier only after the optimizer selects a target.
    const bootDisk = bootDiskFor(
      this.vmType,
      this.diskTier,
      this.diskSizeGb,
      params.jobHost
        ? Math.max(JOB_HOST_DISK_GB, this.minimumDiskSizeGb ?? 0)
        : this.minimumDiskSizeGb,
      this.diskPerformance,
    );
    log.info('Resolved GCP boot disk', {
      id: workloadId,
      vmType: this.vmType,
      diskTier: this.diskTier,
      requestedDiskSizeGb: this.diskSizeGb ?? null,
      resolvedDiskType: bootDisk.diskType,
      resolvedDiskSizeGb: bootDisk.diskSizeGb ?? null,
      resolvedProvisionedIops: bootDisk.provisionedIops ?? null,
      resolvedProvisionedThroughput: bootDisk.provisionedThroughput ?? null,
    });
    const instanceResource: any = {
      name: vmId,
      machineType: `zones/${zone}/machineTypes/${this.vmType}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage,
            ...(bootDisk.diskSizeGb !== undefined && {
              diskSizeGb: bootDisk.diskSizeGb,
            }),
            ...(bootDisk.diskType && {
              diskType: `zones/${zone}/diskTypes/${bootDisk.diskType}`,
            }),
            ...(bootDisk.provisionedIops !== undefined && {
              provisionedIops: String(bootDisk.provisionedIops),
            }),
            ...(bootDisk.provisionedThroughput !== undefined && {
              provisionedThroughput: String(bootDisk.provisionedThroughput),
            }),
            labels: this.getResourceTags(
              workloadId,
              version,
              userId,
              undefined,
              params.resourceScope,
            ),
          },
        },
      ],
      networkInterfaces: [
        {
          ...(gpuCapability?.launchQualified === true &&
            gpuCapability.networkInterfaceType && {
              nicType: gpuCapability.networkInterfaceType,
            }),
          ...(params.ingressSpec?.jobNetwork && {
            network: `projects/${this.projectId}/global/networks/${GCP_JOBS_NETWORK}`,
          }),
          accessConfigs: [
            {
              type: 'ONE_TO_ONE_NAT',
              name: 'External NAT',
            },
          ],
        },
      ],
      metadata: {
        items: [
          {
            // A Job host's cloud-config is cloud-init's, which runs it early;
            // the guest agent runs a startup script late in boot.
            key: params.jobHost ? 'user-data' : 'startup-script',
            value: startupScript,
          },
        ],
      },
      tags: {
        items: [
          workloadId,
          ...(isSharedJobIngress(
            params.ingressSpec ?? buildJobIngressSpec(params.ipWhitelist),
          )
            ? [
                params.ingressSpec?.jobNetwork
                  ? GCP_JOBS_NETWORK
                  : GCP_SHARED_JOB_TAG,
              ]
            : []),
        ],
      },
      // A node pool or a VM Job asks for it: an organization policy can
      // forbid it, and the insert then fails.
      ...(this.nestedVirtualization && {
        advancedMachineFeatures: { enableNestedVirtualization: true },
        minCpuPlatform: gcpNestedMinCpuPlatform(this.vmType),
      }),
      labels: this.getResourceTags(
        workloadId,
        version,
        userId,
        undefined,
        params.resourceScope,
      ),
    };

    // Accelerator-optimized catalog machine types include their GPUs. --gpus
    // selects the container runtime; it must not mutate the VM's hardware by
    // silently attaching an unrelated T4 accelerator.
    if (gpuRuntime === GpuRuntime.Cuda) {
      // GPU instances require onHostMaintenance to be TERMINATE
      instanceResource.scheduling = {
        onHostMaintenance: 'TERMINATE',
        automaticRestart: false,
      };
    }

    // Add spot configuration if requested.
    // Uses the Spot VM API (provisioningModel: SPOT). A Job's preempted VM is
    // stopped (TERMINATED state) rather than deleted, enabling restart; a node
    // pool's (resource-scoped) is deleted and replaced by its pool.
    if (this.spot) {
      if (!instanceResource.scheduling) {
        instanceResource.scheduling = {};
      }
      instanceResource.scheduling.provisioningModel = 'SPOT';
      instanceResource.scheduling.instanceTerminationAction =
        params.resourceScope ? 'DELETE' : 'STOP';
      instanceResource.scheduling.automaticRestart = false;
      instanceResource.scheduling.onHostMaintenance = 'TERMINATE';
    }

    // Use UUID generated from vmId as idempotency key (GCP requires UUID format)
    // Since vmId increments on upgrade (panic-test-123-0 → panic-test-123-1),
    // each upgrade gets a unique UUID, ensuring new VMs are created instead of
    // GCP idempotency returning old VMs. Retries of same vmId get same UUID.
    let operation;
    try {
      [operation] = await this.instancesClient.insert({
        project: this.projectId,
        zone,
        instanceResource,
        requestId: generateUUIDFromString(vmId),
      });

      // Wait for operation to complete
      await this.waitForOperation(operation);
    } catch (error: any) {
      // Handle concurrent VM creation: another upgrade attempt succeeded with same requestId
      // GCP returns 409 Conflict if operation with same requestId already exists
      if (error.code === 409 || error.message?.includes('already exists')) {
        log.info('Concurrent VM creation detected - VM already exists', {
          vmId,
          workloadId,
        });
        // Continue to the polling step below - the VM should exist
      } else {
        throw error;
      }
    }

    // Poll for instance to have IP addresses assigned AND be in RUNNING state
    // Public IPs are assigned asynchronously after VM creation
    // SSH won't be available until status is RUNNING
    let lastStatus: string | undefined;
    let lastHasPublicIp = false;
    let lastHasPrivateIp = false;
    let result;
    try {
      result = await retryUntil(
        async () => {
          let instance, privateIp, publicIp, status;
          try {
            [instance] = await this.instancesClient.get({
              project: this.projectId,
              zone,
              instance: vmId,
            });

            privateIp = instance.networkInterfaces?.[0]?.networkIP;
            publicIp =
              instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
            status = instance.status;
          } catch (error: any) {
            // If instance not found yet, return empty result (continue polling)
            // This can happen immediately after creation due to eventual consistency
            if (isGCPNotFound(error)) {
              return {
                instance: null,
                privateIp: undefined,
                publicIp: undefined,
                status: undefined,
              };
            }
            // Handle 409 conflict during concurrent VM creation - treat as "not ready yet"
            // Can occur when multiple upgrade attempts query the same VM simultaneously
            if (
              error.code === 409 ||
              error.message?.includes('already exists')
            ) {
              return {
                instance: null,
                privateIp: undefined,
                publicIp: undefined,
                status: undefined,
              };
            }
            throw error; // Re-throw if it's not a transient error
          }

          lastStatus = status ?? undefined;
          lastHasPublicIp = !!publicIp;
          lastHasPrivateIp = !!privateIp;

          // A stopped/terminated VM during provisioning means preemption (spot)
          // or a rare cloud platform issue (non-spot). The VM won't restart by
          // itself. Preemption reconciliation does not act while the workload
          // is still Provisioning; throwing lets the retry pipeline
          // (provisionVMs → Retrying → re-provision) handle it. The attempt
          // ledger already identifies any provider resources that cleanup must
          // remove.
          // Potentially the provisioner could try startVM() before tearing down
          // to avoid a full re-provision cycle.
          if (
            status === GcpInstanceStatus.Terminated ||
            status === GcpInstanceStatus.Stopped ||
            status === GcpInstanceStatus.Suspended
          ) {
            throw new Error(
              `VM ${vmId} entered ${status} during provisioning: ${instance.statusMessage || 'no details available'}`,
            );
          }

          return { instance, privateIp, publicIp, status };
        },
        (result) =>
          !!(
            result.publicIp &&
            result.privateIp &&
            result.status === GcpInstanceStatus.Running
          ),
        `VM ${vmId} to be RUNNING with IP addresses`,
        { maxAttempts: 150, waitMs: 2000 }, // 5 minutes max
      );
    } catch (error: any) {
      // Replace generic "failed after N attempts" with actionable info
      if (error.message?.includes('failed after')) {
        throw new Error(
          `VM ${vmId} failed to start: status=${lastStatus ?? 'unknown'}, publicIp=${lastHasPublicIp}, privateIp=${lastHasPrivateIp}`,
        );
      }
      throw error;
    }

    const instance = result.instance;
    const publicIp = result.publicIp;
    const privateIp = result.privateIp;

    // Extract availability zone suffix from instance zone URL
    // Format: https://www.googleapis.com/compute/v1/projects/{project}/zones/{zone}
    // Returns just the suffix (e.g., "a") to match Azure's format
    const fullZone = instance!.zone?.split('/').pop();
    const availabilityZone = fullZone?.split('-').pop();
    const creationTimestamp = instance!.creationTimestamp;
    const createdAt =
      typeof creationTimestamp === 'string'
        ? Date.parse(creationTimestamp)
        : Number.NaN;

    return {
      cloudId: vmId,
      ip: publicIp!,
      privateIp: privateIp!,
      availabilityZone,
      ...(Number.isFinite(createdAt) && { createdAt }),
    };
  }

  private async terminateNetworking(workloadId: string) {
    await this.removeFirewalls(workloadId);
  }

  private async getAllVMs(): Promise<GatewayVM[]> {
    const vms: GatewayVM[] = [];
    const aggReq = this.instancesClient.aggregatedListAsync({
      project: this.projectId,
    });

    for await (const [_zoneName, instanceList] of aggReq) {
      if (instanceList.instances) {
        for (const instance of instanceList.instances) {
          if (instance.name && instance.zone?.includes(this.zone)) {
            const privateIp = instance.networkInterfaces?.[0]?.networkIP || '';
            const publicIp =
              instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || '';

            vms.push({
              cloudId: instance.name,
              ip: publicIp,
              privateIp,
            });
          }
        }
      }
    }

    return vms;
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
    _version: string,
    _userId: string,
  ): Promise<undefined> {
    // A VM Job's rules and VM go into the Jobs network; failing to make it
    // fails the Job rather than falling back to `default`.
    const network = spec.jobNetwork ? GCP_JOBS_NETWORK : undefined;
    if (network) await this.ensureJobsNetwork();
    // Transcribe the shared plan rule-for-rule; composition (priorities,
    // IP-family splits, the scope-deny pair) is resolveFirewallPlan's job.
    // Public SSH alone is one standing rule set per network for every such
    // VM; its creation is a 409 after the first. Teardown deletes by the
    // workload's own tag, so it leaves these.
    const target = isSharedJobIngress(spec)
      ? (network ?? GCP_SHARED_JOB_TAG)
      : id;
    try {
      for (const rule of resolveFirewallPlan(spec, GCP_FIREWALL_TRAITS)) {
        try {
          if (rule.kind === 'deny') {
            // The legacy `-peer-deny` name is retained so re-preparation of
            // scopes created before peer rules were removed stays idempotent.
            await this.createScopeIngressDenyRule(
              `${target}-peer-deny${rule.nameSuffix}`,
              target,
              [...rule.sourceRanges],
              network,
            );
          } else {
            await this.createFirewallRule(
              `${target}${rule.port}${rule.nameSuffix}`,
              target,
              [...rule.sourceRanges],
              numericRulePort(rule.port),
              rule.protocol,
              GCP_PRIORITY_BY_CLASS[rule.priorityClass],
              network,
            );
          }
        } catch (err: any) {
          // If the firewall already exists (HTTP 409 / gRPC 6), that's okay.
          if (err.code === 6 || err.code === 409) continue;
          throw err;
        }
      }
    } catch (err: any) {
      // Other rules and VMs name no network, so GCP places them in
      // `default`. The CLI shows `errors[0].message` when present, so hint
      // both.
      if (
        !network &&
        typeof err?.message === 'string' &&
        /networks\/default|network resource/.test(err.message) &&
        /not found|cannot be found/i.test(err.message)
      ) {
        const hint = ` GCP project ${this.projectId} has no \`default\` network, which Anycloud uses for VMs and firewall rules; create one with \`gcloud compute networks create default --subnet-mode=auto --project ${this.projectId}\`.`;
        err.message += hint;
        if (typeof err.errors?.[0]?.message === 'string')
          err.errors[0].message += hint;
      }
      throw err;
    }
    return undefined;
  }

  private ensureJobsNetwork(): Promise<void> {
    // Readable with this region's auto-mode subnet: a network another API
    // process is still making may have neither yet.
    const ready = async () => {
      const [network] = await this.networksClient.get({
        project: this.projectId,
        network: GCP_JOBS_NETWORK,
      });
      if (
        !network.subnetworks?.some((url) =>
          url.includes(`/regions/${this.region}/`),
        )
      )
        throw Object.assign(
          new Error(`${GCP_JOBS_NETWORK} has no subnet in ${this.region} yet`),
          { code: 404 },
        );
    };
    const create = async () => {
      try {
        await ready();
        return;
      } catch (err) {
        if (!isGCPNotFound(err)) throw err;
      }
      try {
        const [operation] = await this.networksClient.insert({
          project: this.projectId,
          networkResource: {
            name: GCP_JOBS_NETWORK,
            description: 'anycloud VM Jobs',
            autoCreateSubnetworks: true,
          },
        });
        await this.waitForOperation(operation, 'global');
      } catch (err: any) {
        if (err.code !== 6 && err.code !== 409) throw err;
      }
      await withRetry(ready, 'GCP Jobs network', {
        maxAttempts: 12,
        waitMs: 5_000,
        exponentialBackoff: false,
        shouldRetry: isGCPNotFound,
      });
    };
    return memoizeAsyncTtl(
      gcpJobsNetworks,
      `${this.projectId}:${this.region}`,
      create,
      { ttlMs: 15 * 60_000 },
    );
  }

  /**
   * Validate GCP credentials by attempting to list instances.
   * This is a lightweight API call that will fail fast if credentials are invalid.
   */
  private async validateCredentials(): Promise<void> {
    if (!('kind' in this.key))
      try {
        // The Google auth client otherwise surfaces malformed PEM through
        // OpenSSL (for example ERR_OSSL_UNSUPPORTED), which looks identical to
        // an unclassified provider failure. Reject it locally as user input
        // before any provider request or retry.
        createPrivateKey(this.key.privateKey);
      } catch {
        throw new InvalidAnycloudConfigError(
          'GCP service-account private key is not a valid PEM private key.',
        );
      }
    // Try to list instances in the zone - this validates both credentials and project/zone access
    // (validateCredentials in workload-admission-checks already retries this on any error, including
    // transport drops, so no gateway-level transient retry is needed here.)
    const iterator = this.instancesClient.listAsync({
      project: this.projectId,
      zone: this.zone,
    });
    // Just iterate once to validate credentials work
    for await (const _instance of iterator) {
      break; // Only need to check if we can make the API call
    }
  }

  private async sweepResources(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult> {
    const dryRun = options.dryRun ?? false;
    const result: ResourceSweepResult = {
      vmIds: [],
      otherResources: [],
      errors: [],
    };

    // Firewall target tags use the same opaque owner id as instances.
    const orphanedResourceOwners = new Set<string>();
    const activeResourceOwners = new Set<string>();

    // An installation sweep covers every zone in one pass (RFC 0049 C26 (c)).
    const installation = options.policy.installation;
    const inZones = async function* <T>(
      zone: string,
      list: () => AsyncIterable<T>,
      aggregated: () => AsyncIterable<
        [string, Record<string, T[] | null | undefined>]
      >,
      key: string,
    ): AsyncGenerator<{ item: T; zone: string }> {
      if (!installation) {
        for await (const item of list()) yield { item, zone };
        return;
      }
      for await (const [zonePath, scoped] of aggregated()) {
        for (const item of scoped[key] ?? []) {
          yield { item, zone: zonePath.split('/').pop()! };
        }
      }
    };

    // 1. Find and cleanup orphaned instances
    try {
      const iterator = inZones(
        this.zone,
        () =>
          this.instancesClient.listAsync({
            project: this.projectId,
            zone: this.zone,
          }),
        () =>
          this.instancesClient.aggregatedListAsync({
            project: this.projectId,
            returnPartialSuccess: false,
          }) as AsyncIterable<[string, Record<string, any>]>,
        'instances',
      );

      // Collect all instances to delete
      const instanceDeletions = [];
      for await (const { item: instance, zone } of iterator) {
        const labels = instance.labels || {};

        const resourceOwner =
          labels.anycloud_resource ?? labels.anycloud_deployment;
        if (!resourceOwner) continue;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(labels),
            endedAt: labels.anycloud_ended_at,
            createdAt: instance.creationTimestamp,
            running: !['TERMINATED', 'STOPPED', 'SUSPENDED'].includes(
              instance.status ?? '',
            ),
            spare: { into: result, type: 'vm', id: instance.name },
          },
          options.policy,
        );

        if (isOrphaned) {
          orphanedResourceOwners.add(resourceOwner);
        } else {
          activeResourceOwners.add(resourceOwner);
        }

        if (isOrphaned && instance.name) {
          if (dryRun) {
            result.vmIds.push(instance.name);
          } else {
            instanceDeletions.push(
              (async () => {
                try {
                  await deleteWithRetry(
                    () => this.deleteInstanceInZone(instance.name!, zone),
                    `GCP instance ${instance.name}`,
                    isGCPNotFound,
                    30,
                    10000,
                  );
                  result.vmIds.push(instance.name!);
                  log.info('Cleaned up orphaned GCP instance', {
                    instanceName: instance.name!,
                    resourceOwner,
                  });
                } catch (error) {
                  result.errors.push({
                    resourceType: 'vm',
                    resourceId: instance.name!,
                    error: (error as Error).message,
                  });
                }
              })(),
            );
          }
        }
      }

      // Delete all instances in parallel
      await Promise.allSettled(instanceDeletions);
    } catch (error) {
      log.error('Error listing GCP instances for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'vm',
        resourceId: 'list-instances',
        error: (error as Error).message,
      });
    }

    // 2. Find and cleanup orphaned firewalls
    // GCP firewall rules support no labels, so a firewall names its workload
    // only by its targetTags (the workload ID). It is reclaimed only when the
    // policy reclaimed an instance of that workload in this sweep. Age alone
    // can't prove ownership: the project holds other installations' and
    // non-anycloud firewalls, and this zone's sweep can't see live instances
    // in other zones.
    try {
      const firewallIterator = this.firewallsClient.listAsync({
        project: this.projectId,
      });

      // An installation's rules are named for, and target, its scope IDs.
      for (const owner of installation?.resourceOwnerIds ?? []) {
        orphanedResourceOwners.add(owner);
      }
      const firewallDeletions = [];
      for await (const firewall of firewallIterator) {
        if (!firewall.name || !firewall.targetTags?.length) continue;

        const resourceOwner = firewall.targetTags[0];
        // The standing public-SSH rules belong to no workload.
        if (
          resourceOwner === GCP_SHARED_JOB_TAG ||
          resourceOwner === GCP_JOBS_NETWORK ||
          resourceOwner === GCP_LEGACY_JOB_HOST_TAG
        )
          continue;

        if (installation?.spareWorkloadIds.includes(resourceOwner)) {
          (result.spared ??= []).push({
            type: 'firewall',
            id: firewall.name,
            workloadId: resourceOwner,
          });
          continue;
        }
        if (
          !orphanedResourceOwners.has(resourceOwner) ||
          activeResourceOwners.has(resourceOwner) ||
          !firewall.name.startsWith(resourceOwner)
        )
          continue;

        if (dryRun) {
          result.otherResources.push({
            type: 'firewall',
            id: firewall.name,
          });
        } else {
          firewallDeletions.push(
            (async () => {
              try {
                await deleteWithRetry(
                  async () => {
                    const [operation] = await this.firewallsClient.delete({
                      project: this.projectId,
                      firewall: firewall.name!,
                    });
                    await this.waitForOperation(operation, 'global');
                  },
                  `GCP firewall ${firewall.name}`,
                  isGCPNotFound,
                  30,
                  10000,
                );
                result.otherResources.push({
                  type: 'firewall',
                  id: firewall.name!,
                });
                log.info('Cleaned up orphaned GCP firewall', {
                  firewallName: firewall.name!,
                  resourceOwner,
                });
              } catch (error) {
                result.errors.push({
                  resourceType: 'firewall',
                  resourceId: firewall.name!,
                  error: (error as Error).message,
                });
              }
            })(),
          );
        }
      }

      await Promise.allSettled(firewallDeletions);
    } catch (error) {
      log.error('Error cleaning up GCP firewalls', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'firewall',
        resourceId: 'cleanup-firewalls',
        error: (error as Error).message,
      });
    }

    // 3. Find and cleanup orphaned disks
    try {
      const iterator = inZones(
        this.zone,
        () =>
          this.disksClient.listAsync({
            project: this.projectId,
            zone: this.zone,
          }),
        () =>
          this.disksClient.aggregatedListAsync({
            project: this.projectId,
            returnPartialSuccess: false,
          }) as AsyncIterable<[string, Record<string, any>]>,
        'disks',
      );

      // Collect all disks to delete
      const diskDeletions = [];
      for await (const { item: disk, zone } of iterator) {
        const labels = disk.labels || {};

        const resourceOwner =
          labels.anycloud_resource ?? labels.anycloud_deployment;
        if (!resourceOwner) continue;

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(labels),
            endedAt: labels.anycloud_ended_at,
            createdAt: disk.creationTimestamp,
            detached: !disk.users?.length, // Not attached to any instance
            spare: { into: result, type: 'disk', id: disk.name },
          },
          options.policy,
        );

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
                  await deleteWithRetry(
                    async () => {
                      const [operation] = await this.disksClient.delete({
                        project: this.projectId,
                        zone,
                        disk: disk.name!,
                      });
                      await this.waitForOperation(operation, 'zone', zone);
                    },
                    `GCP disk ${disk.name}`,
                    isGCPNotFound,
                    30,
                    10000,
                  );
                  result.otherResources.push({
                    type: 'disk',
                    id: disk.name!,
                  });
                  log.info('Cleaned up orphaned GCP disk', {
                    diskName: disk.name!,
                    resourceOwner,
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

      // Delete all disks in parallel
      await Promise.allSettled(diskDeletions);
    } catch (error) {
      log.error('Error listing GCP disks for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'disk',
        resourceId: 'list-disks',
        error: (error as Error).message,
      });
    }

    // An installation sweep deletes buckets in its own, later pass.
    if (!installation) await this.sweepBuckets(options, result);

    return result;
  }

  private async sweepBuckets(
    options: ResourceSweepOptions,
    result: ResourceSweepResult,
  ): Promise<ResourceSweepResult> {
    const dryRun = options.dryRun ?? false;
    // Find and cleanup orphaned GCS buckets
    try {
      const [buckets] = await this.storageClient.getBuckets();

      for (const bucket of buckets) {
        try {
          // Get bucket metadata
          const [metadata] = await bucket.getMetadata();
          const labels = metadata.labels || {};

          // Only check buckets with anycloud labels, or the one named for
          // the installation being swept.
          if (
            !labels.anycloud_deployment &&
            bucket.name !== options.policy.installation?.clusterId
          )
            continue;

          const isOrphaned = isResourceSweepCandidate(
            {
              ...sweepOwner(labels),
              endedAt: labels.anycloud_ended_at,
              createdAt: labels.anycloud_created_at ?? metadata.timeCreated,
              name: bucket.name,
              spare: { into: result, type: 'bucket', id: bucket.name },
            },
            options.policy,
          );

          if (isOrphaned) {
            if (dryRun) {
              result.otherResources.push({
                type: 'bucket',
                id: bucket.name,
              });
            } else {
              try {
                await this.deleteBucket(bucket.name);
                result.otherResources.push({
                  type: 'bucket',
                  id: bucket.name,
                });
                log.info('Cleaned up orphaned GCS bucket', {
                  bucketName: bucket.name,
                  workload: labels.anycloud_deployment,
                });
              } catch (error) {
                result.errors.push({
                  resourceType: 'bucket',
                  resourceId: bucket.name,
                  error: (error as Error).message,
                });
              }
            }
          }
        } catch (error) {
          log.error(`Error checking bucket ${bucket.name} for cleanup`, {
            id: 'system',
            bucketName: bucket.name,
            error,
          });
        }
      }
    } catch (error) {
      log.error('Error listing GCS buckets for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'bucket',
        resourceId: 'list-buckets',
        error: (error as Error).message,
      });
    }

    return result;
  }

  private async hasBucketUncoordinated(bucketName: string): Promise<boolean> {
    const bucket = this.storageClient.bucket(bucketName);
    const [exists] = await bucket.exists();
    return exists;
  }

  private async listBuckets(
    options: CloudListPageOptions,
    signal?: AbortSignal,
  ): Promise<BucketListPage> {
    const [buckets, nextQuery] = await withFirstUseBucketAuthentication(
      () =>
        this.storageClient.getBuckets({
          autoPaginate: false,
          maxResults: options.pageSize,
          pageToken: options.cursor,
        }),
      'GCP bucket listing authentication',
      signal,
    );
    return {
      buckets: buckets.map((bucket) => {
        const created = bucket.metadata.timeCreated
          ? new Date(bucket.metadata.timeCreated).getTime()
          : NaN;
        return {
          name: bucket.name,
          region: bucket.metadata.location ?? null,
          createdAt: Number.isFinite(created) ? created : null,
        };
      }),
      nextCursor:
        (nextQuery as { pageToken?: string } | null)?.pageToken ?? null,
    };
  }

  private async listObjects(
    bucketName: string,
    options: CloudObjectListOptions,
  ): Promise<BucketEntryPage> {
    const [files, nextQuery, apiResponse] = await this.storageClient
      .bucket(bucketName)
      .getFiles({
        autoPaginate: false,
        prefix: options.prefix || undefined,
        delimiter: options.recursive ? undefined : '/',
        maxResults: options.pageSize,
        pageToken: options.cursor,
      });
    const entries: BucketEntryPage['entries'] = [];
    const prefixes = (apiResponse as { prefixes?: string[] } | null)?.prefixes;
    for (const prefix of prefixes ?? []) {
      entries.push({ kind: 'prefix', key: prefix });
    }
    for (const file of files) {
      const size = Number(file.metadata.size);
      const lastModified = file.metadata.updated
        ? new Date(file.metadata.updated).getTime()
        : NaN;
      entries.push({
        kind: 'object',
        key: file.name,
        sizeBytes: Number.isFinite(size) ? size : null,
        lastModifiedAt: Number.isFinite(lastModified) ? lastModified : null,
      });
    }
    // Entries stay in provider order here; the route sorts each page once.
    return {
      entries,
      nextCursor:
        (nextQuery as { pageToken?: string } | null)?.pageToken ?? null,
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
    // RFC 0043 D-managed: create first, without soft-deleted copies.
    owned = false,
  ): Promise<void> {
    try {
      const bucket = this.storageClient.bucket(bucketName);
      const [exists] = owned ? [false] : await bucket.exists();
      if (exists) {
        log.info(`GCS bucket ${bucketName} already exists, skipping creation`);
        return;
      }

      log.info(`Creating GCS bucket: ${bucketName} in ${this.region}`);
      try {
        await this.storageClient.createBucket(bucketName, {
          location: this.region,
          storageClass: 'STANDARD',
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: true },
            publicAccessPrevention: 'enforced',
          },
          labels: {
            ...this.getResourceTags(workloadId, version, userId),
            anycloud_created_at: Date.now().toString(),
          },
          ...(owned && { softDeletePolicy: { retentionDurationSeconds: 0 } }),
        });
        log.info(`GCS bucket ${bucketName} created successfully`);
      } catch (createErr) {
        // Many deploys share one output bucket and race exists()/createBucket();
        // the loser gets 409 "you already own this bucket" — success for an upsert.
        // Without this, a burst of concurrent jobs fails to deploy and churns in
        // Retrying forever. Require BOTH the 409 and the ownership message: GCS
        // also returns 409 "that name is not available" when another project owns
        // the global name, which must throw rather than deploy to an unusable bucket.
        const code = (createErr as { code?: number }).code;
        const message = (createErr as Error)?.message ?? '';
        if (code === 409 && /already (own|exist)/i.test(message)) {
          log.info(`GCS bucket ${bucketName} created concurrently, skipping`);
        } else {
          throw createErr;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        error.message = `Failed to create GCS bucket ${bucketName}: ${error.message}`;
      }
      throw error;
    }
  }

  /**
   * RFC 0043 D-managed: create first. GCS answers 409 both to a name this
   * project holds ("you already own"), which the upsert reuses, and to
   * another's ("not available", observed, not documented), so a reused bucket
   * is ours only when its metadata names this key's project number; what
   * can't be read is refused. Soft delete is off: a checkpoint is rewritten
   * every minute, and each replaced copy would stay billed for 7 days.
   */
  private async createOwnedBucket(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
  ): Promise<string> {
    try {
      await this.upsertBucketUncoordinated(
        bucketName,
        version,
        workloadId,
        userId,
        true,
      );
    } catch (error) {
      const status = (error as { code?: unknown }).code;
      if (status === 409) throw new BucketNameTakenError(bucketName, error);
      if (status === 403) {
        throw new BucketAccessDeniedError(
          `Creating it needs storage.buckets.create: ${errorMessage(error)}`,
          error,
        );
      }
      throw error;
    }
    const [[metadata], projectNumber] = await Promise.all([
      this.storageClient.bucket(bucketName).getMetadata(),
      // A role from before RFC 0043 lacks this permission.
      readGcpProjectNumber(this.key).catch((error: unknown) => {
        if ((error as { status?: number }).status !== 403) throw error;
        throw new BucketAccessDeniedError(
          `Checking its owner needs resourcemanager.projects.get (update the Anycloud role from gcp-anycloud-role.json): ${errorMessage(error)}`,
          error,
        );
      }),
    ]);
    if (String(metadata.projectNumber) !== projectNumber) {
      throw new BucketNameTakenError(bucketName, null);
    }
    return this.region;
  }

  private async deleteBucket(bucketName: string): Promise<void> {
    // Tag bucket with ended_at before deletion
    await this.tagBucketForDeletion(bucketName);

    try {
      const bucket = this.storageClient.bucket(bucketName);

      // Delete all files in the bucket
      // Every version: a versioned bucket keeps noncurrent objects.
      await bucket.deleteFiles({ force: true, versions: true });
      log.info(`Deleted all files from GCS bucket ${bucketName}`);

      // Delete the bucket itself
      log.info(`Deleting GCS bucket ${bucketName}`);
      await bucket.delete();
      log.info(`GCS bucket ${bucketName} deleted successfully`);

      // Wait for deletion to propagate
      await retryUntil(
        async () => {
          try {
            const [exists] = await bucket.exists();
            if (exists) {
              throw new Error('Bucket still exists');
            }
            return { deleted: true };
          } catch (error: any) {
            // 404 means deletion propagated
            if (error.code === 404) {
              return { deleted: true };
            }
            throw error;
          }
        },
        (result) => result.deleted === true,
        `GCS bucket ${bucketName} deletion propagation`,
        { maxAttempts: 10, waitMs: 1000 }, // 10 seconds max
      );
      log.info(`GCS bucket ${bucketName} deletion confirmed`);
    } catch (error: any) {
      // Idempotent - if bucket doesn't exist, that's fine
      if (error.code === 404) {
        log.info(`GCS bucket ${bucketName} already deleted or doesn't exist`);
        return;
      }
      log.warn(`GCS bucket ${bucketName} deletion failed`, {
        error: error,
      });
      if (error instanceof Error) {
        error.message = `Failed to delete GCS bucket ${bucketName}: ${error.message}`;
      }
      throw error;
    }
  }

  private async uploadObject(
    bucketName: string,
    remotePath: string,
    source: CloudUploadSource,
  ): Promise<void> {
    const file = this.storageClient.bucket(bucketName).file(remotePath);
    // pipeline closes the source when the write fails, so a retried attempt
    // does not leave the previous one's file open.
    await pipeline(
      openCloudUploadSource(source),
      file.createWriteStream({ resumable: true }),
    );
  }

  private async deleteObject(
    bucketName: string,
    remotePath: string,
  ): Promise<void> {
    const file = this.storageClient.bucket(bucketName).file(remotePath);
    try {
      await file.delete();
    } catch (error: any) {
      if (error.code === 404) return;
      throw error;
    }
  }

  private async downloadObject(
    bucketName: string,
    remotePath: string,
  ): Promise<{ stream: Readable; contentLength?: number }> {
    const file = this.storageClient.bucket(bucketName).file(remotePath);
    const [metadata] = await file.getMetadata();
    const size = metadata.size ? Number(metadata.size) : undefined;
    return {
      stream: file.createReadStream(),
      contentLength: size,
    };
  }

  // Private methods

  /** Scope-labelled instances in any zone; a stopped (TERMINATED) one still exists. */
  private async listResourceVMs(
    scope: CloudResourceScope,
  ): Promise<ResourceVM[]> {
    const label = sanitizeGCPLabel(scope.id);
    const vms: ResourceVM[] = [];
    const iterator = this.instancesClient.aggregatedListAsync({
      project: this.projectId,
      filter: `labels.anycloud_resource = "${label}"`,
      returnPartialSuccess: false,
    });
    for await (const [, scoped] of iterator) {
      for (const instance of scoped.instances ?? []) {
        if (instance.name && instance.labels?.anycloud_resource === label) {
          vms.push({
            id: instance.name,
            stopped: instance.status === 'TERMINATED',
          });
        }
      }
    }
    return vms;
  }

  /**
   * Resolve a legacy instance name across the whole project when its durable
   * attempt predates availability-zone persistence. `returnPartialSuccess` is
   * deliberately false: an empty partial response is not authoritative absence.
   */
  private async discoverInstanceZone(
    instanceName: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      if (signal.reason instanceof Error) throw signal.reason;
      throw new DOMException('The operation was aborted', 'AbortError');
    };
    throwIfAborted();

    const escapedName = instanceName
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    const zones = new Set<string>();
    const iterator = this.instancesClient.aggregatedListAsync({
      project: this.projectId,
      filter: `name = "${escapedName}"`,
      returnPartialSuccess: false,
    });

    for await (const [scope, scopedList] of iterator) {
      throwIfAborted();
      for (const instance of scopedList.instances ?? []) {
        if (instance.name !== instanceName) continue;
        const zoneFromResource = instance.zone?.split('/').pop();
        const zoneFromScope = scope.startsWith('zones/')
          ? scope.slice('zones/'.length)
          : undefined;
        const zone = zoneFromResource || zoneFromScope;
        if (!zone) {
          throw new Error(
            `Project-wide GCP lookup found instance "${instanceName}" without an authoritative zone`,
          );
        }
        zones.add(zone);
      }
    }
    throwIfAborted();

    if (zones.size > 1) {
      throw new Error(
        `Project-wide GCP lookup found instance "${instanceName}" in multiple zones: ${[...zones].sort().join(', ')}`,
      );
    }
    return zones.values().next().value ?? null;
  }

  private async deleteInstanceInZone(
    vmId: string,
    zone: string,
  ): Promise<void> {
    const [operation] = await this.instancesClient.delete({
      project: this.projectId,
      zone,
      instance: vmId,
    });
    await this.waitForOperation(operation, 'zone', zone);
  }

  private async terminateVM(vmId: string) {
    const discoveredZone = this.configuredZone
      ? undefined
      : await this.discoverInstanceZone(vmId);
    const zone = this.configuredZone ?? discoveredZone;
    if (!zone) {
      log.info('GCP instance is authoritatively absent from the project', {
        vmId,
        projectId: this.projectId,
      });
      return;
    }

    // Tag instance with ended_at before deletion
    if (this.configuredZone) {
      await this.tagInstanceForDeletion(vmId);
    } else {
      await this.tagInstanceForDeletion(vmId, zone);
    }

    // Use retry logic for VM deletion to handle temporary failures
    // (matching AWS/Azure pattern)
    await deleteWithRetry(
      () => this.deleteInstanceInZone(vmId, zone),
      `GCP instance ${vmId}`,
      isGCPNotFound,
      30, // 30 attempts × 10s = 5 min (matching firewall deletion timeout)
      10000,
      // A denied delete re-fails every attempt; report it now.
      (error) => !gcpPermissionDenial(error),
    );
  }

  private async createFirewallRule(
    name: string,
    targetTag: string,
    sourceRanges: string[],
    port: number,
    protocol: string,
    priority: number | undefined,
    network?: string,
  ) {
    const firewallResource = {
      name,
      ...(network && { network: `global/networks/${network}` }),
      targetTags: [targetTag],
      sourceRanges,
      ...(priority !== undefined ? { priority } : {}),
      allowed: [
        {
          IPProtocol: protocol,
          ports: [port.toString()],
        },
      ],
    };

    const [operation] = await this.firewallsClient.insert({
      project: this.projectId,
      firewallResource,
    });

    await this.waitForOperation(operation, 'global');
  }

  private async createScopeIngressDenyRule(
    name: string,
    targetTag: string,
    sourceRanges: string[],
    network?: string,
  ) {
    const [operation] = await this.firewallsClient.insert({
      project: this.projectId,
      firewallResource: {
        name,
        ...(network && { network: `global/networks/${network}` }),
        targetTags: [targetTag],
        sourceRanges,
        priority: GCP_SCOPE_DENY_PRIORITY,
        denied: [{ IPProtocol: 'all' }],
      },
    });
    await this.waitForOperation(operation, 'global');
  }

  private async removeFirewalls(id: string) {
    // A workload named like the shared rules (`--id`) must not take them.
    if (
      id === GCP_SHARED_JOB_TAG ||
      id === GCP_JOBS_NETWORK ||
      id === GCP_LEGACY_JOB_HOST_TAG
    )
      return;
    // Delete every firewall rule this workload created, matched by targetTags
    // (set to the workload id at creation — see createFirewallRule) rather than
    // by reconstructed names. This keeps teardown symmetric with setup: it reaps
    // all rules regardless of the port-suffix naming (`${id}22`, `${id}80`, …) and
    // also catches legacy `${id}ssh`/`${id}http` rules from older workloads,
    // which carry the same targetTags. GCP firewall rules support no labels, so we
    // scan and filter by targetTags — the same approach as the resource sweep.
    const firewallIterator = this.firewallsClient.listAsync({
      project: this.projectId,
    });

    const names: string[] = [];
    for await (const firewall of firewallIterator) {
      if (firewall.name && firewall.targetTags?.[0] === id) {
        names.push(firewall.name);
      }
    }

    const deletePromises = names.map(async (name) => {
      await deleteWithRetry(
        async () => {
          const [operation] = await this.firewallsClient.delete({
            project: this.projectId,
            firewall: name,
          });
          await this.waitForOperation(operation, 'global');
        },
        `GCP firewall ${name}`,
        isGCPNotFound,
        30, // 30 attempts × 10s = 5 min (conservative buffer for firewall readiness)
        10000,
      );
    });

    await Promise.all(deletePromises);
  }

  /**
   * Tag GCS bucket with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagBucketForDeletion(bucketName: string): Promise<void> {
    try {
      const bucket = this.storageClient.bucket(bucketName);

      // Check if bucket exists before trying to tag it
      const [exists] = await bucket.exists();
      if (!exists) {
        log.info(`Skipping tagging - bucket ${bucketName} already deleted`);
        return;
      }

      await withRetry(
        async () => {
          // Get existing labels
          const [metadata] = await bucket.getMetadata();
          const existingLabels = metadata.labels || {};

          // Add ended_at label
          await bucket.setMetadata({
            labels: {
              ...existingLabels,
              anycloud_ended_at: Date.now().toString(),
            },
          });
        },
        `Tag GCS bucket ${bucketName}`,
        {
          maxAttempts: 5,
          waitMs: 1000,
        },
      );
      log.info(`Tagged GCS bucket ${bucketName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag GCS bucket ${bucketName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', bucketName, error },
      );
    }
  }

  /**
   * Tag GCP instance with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagInstanceForDeletion(
    instanceName: string,
    zone = this.zone,
  ): Promise<void> {
    try {
      await withRetry(
        async () => {
          let instance;
          try {
            [instance] = await this.instancesClient.get({
              project: this.projectId,
              zone,
              instance: instanceName,
            });
          } catch (err: any) {
            if (err?.code === 404 || err?.status === 404) {
              log.info(
                `Instance ${instanceName} already deleted, skipping tagging`,
              );
              return;
            }
            throw err;
          }

          const existingLabels = instance.labels || {};
          const labelFingerprint = instance.labelFingerprint;

          const [operation] = await this.instancesClient.setLabels({
            project: this.projectId,
            zone,
            instance: instanceName,
            instancesSetLabelsRequestResource: {
              labels: {
                ...existingLabels,
                anycloud_ended_at: Date.now().toString(),
              },
              labelFingerprint,
            },
          });

          await this.waitForOperation(operation, 'zone', zone);
        },
        `tag GCP instance ${instanceName}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying GCP instance tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged GCP instance ${instanceName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag GCP instance ${instanceName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', instanceName, error },
      );
    }
  }

  private async active_vms(id: string): Promise<boolean> {
    const [instances] = await this.instancesClient.list({
      project: this.projectId,
      zone: this.zone,
    });

    return instances.some((vm) => vm.tags?.items?.includes(id));
  }

  /**
   * Check if VM is in a stopped state
   * Returns true if VM is stopped, false if still running, stopping or not found
   * Retries to handle API propagation delays when VM is being preempted
   */
  private async verifyVMPreemption(cloudId: string): Promise<boolean> {
    // GCP spot preemption (instanceTerminationAction: STOP) and `gcloud instances stop` both
    // produce TERMINATED — they are indistinguishable by status alone. As a result:
    //   - Real preemption → TERMINATED → revival triggered ✓
    //   - User manually stops instance via gcloud/console → TERMINATED → revival triggered
    //     (accepted trade-off; use `anycloud terminate` to properly decommission)
    //   - Instance not found (deleted from console) → revival triggered ✓
    //     (use `anycloud terminate` to properly decommission without re-provisioning)
    // States checked:
    //   TERMINATED - final state for both preemption and manual stop
    //   STOPPED    - included defensively; listed in GCP proto but TERMINATED is observed in practice
    // STOPPING is not a stop yet: a delete passes through it too, and only a
    // later observation tells a stop (TERMINATED) from a delete (not found).
    // See: https://cloud.google.com/compute/docs/instances/spot#preemption-process
    const isNotRunning = (status: string | null | undefined) =>
      status === GcpInstanceStatus.Stopped ||
      status === GcpInstanceStatus.Terminated;

    try {
      const zone =
        this.configuredZone ?? (await this.discoverInstanceZone(cloudId));
      if (!zone) return false;
      const result = await withRetry(
        async () => {
          try {
            const [instance] = await this.instancesClient.get({
              project: this.projectId,
              zone,
              instance: cloudId,
            });

            const status = instance.status;
            return { found: true, status };
          } catch (error) {
            if (isGCPNotFound(error)) {
              return { found: false, status: null };
            }
            throw error;
          }
        },
        `GCP VM preemption check for ${cloudId}`,
        { maxAttempts: 3, waitMs: 2000, exponentialBackoff: false },
      );

      if (!result.found) {
        log.warn('GCP instance not found (cannot verify preemption)', {
          cloudId,
        });
        return false;
      }

      if (isNotRunning(result.status)) {
        log.info('GCP VM is not running (preempted or stopped)', {
          cloudId,
          status: result.status,
        });
        return true;
      }

      log.info('GCP VM is running', {
        cloudId,
        status: result.status,
      });
      return false;
    } catch (error) {
      log.error('GCP VM state check failed', {
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
    // On GCP, TERMINATED/STOPPED instances still exist and can be restarted.
    // Only "not found" means the VM is irrecoverably gone.
    if (!this.configuredZone) {
      try {
        const discoveredZone = await this.discoverInstanceZone(
          cloudId,
          options.signal,
        );
        if (discoveredZone) return VM_PRESENT;
        log.info('GCP instance absent from authoritative project-wide lookup', {
          cloudId,
        });
        return VM_RELEASE_CANDIDATE;
      } catch (error) {
        log.error('GCP project-wide VM terminated check failed', {
          id: cloudId,
          error: error,
        });
        return vmReleaseUnknown(error);
      }
    }

    let terminationObserved = false;
    try {
      const result = await withRetry(
        async () => {
          try {
            await this.instancesClient.get(
              {
                project: this.projectId,
                zone: this.zone,
                instance: cloudId,
              },
              {
                // Status reads must not inherit the provisioning client's 60s per
                // attempt / 90-minute total retry budget.
                timeout: GCP_VM_STATUS_REQUEST_TIMEOUT_MS,
              },
            );
            return { found: true };
          } catch (error) {
            if (isGCPNotFound(error)) {
              terminationObserved = true;
              return { found: false };
            }
            throw error;
          }
        },
        `GCP VM terminated check for ${cloudId}`,
        {
          maxAttempts: 3,
          waitMs: 2000,
          exponentialBackoff: false,
          signal: options.signal,
        },
      );

      if (!result.found) {
        log.info('GCP instance not found (terminated)', { cloudId });
        return VM_RELEASE_CANDIDATE;
      }

      return VM_PRESENT;
    } catch (error) {
      // gRPC work may outlive AbortSignal cancellation. Preserve definitive,
      // irreversible evidence returned just after the caller's deadline.
      if (terminationObserved) return VM_RELEASE_CANDIDATE;
      log.error('GCP VM terminated check failed', {
        id: cloudId,
        error: error,
      });
      return vmReleaseUnknown(error);
    }
  }

  private async startVM(cloudId: string): Promise<string | null> {
    const attempt = new VMRestartAttempt(`GCP VM restart for ${cloudId}`);
    let startAccepted = false;
    let requestId = randomUUID();
    let consecutiveSettled = 0;
    let consecutiveReady = 0;
    let originalId: string | undefined;
    let lastStatus: string | null = null;
    try {
      const zone =
        this.configuredZone ??
        (await attempt.run(() =>
          this.discoverInstanceZone(cloudId, attempt.signal),
        ));
      if (!zone) return null;
      const request = {
        project: this.projectId,
        zone,
        instance: cloudId,
      };
      log.info('Attempting to start stopped GCP VM', { cloudId });
      while (Date.now() < attempt.deadlineAt) {
        try {
          const [instance] = await attempt.run(() =>
            this.instancesClient.get(request, {
              timeout: attempt.remainingMs(),
              retry: null,
            }),
          );
          const id = String(instance.id ?? '');
          if (originalId && id && id !== originalId) {
            throw new Error(`GCP VM ${cloudId} was replaced during restart`);
          }
          if (id) originalId ??= id;
          lastStatus = instance.status ?? null;
          const ip = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
          consecutiveReady =
            id && lastStatus === GcpInstanceStatus.Running && ip
              ? consecutiveReady + 1
              : 0;
          const settled =
            id &&
            !startAccepted &&
            (lastStatus === GcpInstanceStatus.Terminated ||
              lastStatus === GcpInstanceStatus.Stopped);
          consecutiveSettled = settled ? consecutiveSettled + 1 : 0;
          log.info('GCP VM restart observation', {
            cloudId,
            elapsedMs: Date.now() - attempt.startedAt,
            status: lastStatus,
            startAccepted,
            consecutiveSettled,
            consecutiveReady,
          });
          attempt.remainingMs();
          if (consecutiveReady >= VM_RESTART_CONSECUTIVE_OBSERVATIONS) {
            return ip!;
          }
          if (consecutiveSettled >= VM_RESTART_CONSECUTIVE_OBSERVATIONS) {
            // The Compute REST transport ignores this attempt's deadline.
            // Await the start and its operation before allowing cleanup;
            // pending work can outlive the budget for new starts and reads.
            const [operation] = await this.instancesClient.start(
              { ...request, requestId },
              { retry: null },
            );
            try {
              await this.waitForOperation(
                operation,
                'zone',
                request.zone,
                attempt,
              );
            } catch (error) {
              // A completed failed operation requires a new idempotency key.
              // Ambiguous transport retries keep the key for the same start.
              if ((error as { errors?: unknown } | null)?.errors)
                requestId = randomUUID();
              throw error;
            }
            startAccepted = true;
            consecutiveSettled = 0;
            // TERMINATED means stopped, not deleted. Stale reads after a
            // completed start remain observations within the original budget.
          }
        } catch (error) {
          attempt.remainingMs();
          if (isGCPNotFound(error) || !isGcpRestartRetryable(error))
            throw error;
          consecutiveSettled = 0;
          consecutiveReady = 0;
          log.info('Retrying GCP VM restart recovery', {
            cloudId,
            elapsedMs: Date.now() - attempt.startedAt,
            error: errorMessage(error),
          });
        }
        await attempt.wait();
      }
      throw new Error(`GCP VM restart for ${cloudId} deadline exceeded`);
    } catch (error) {
      log.warn('Failed to start GCP VM', {
        cloudId,
        elapsedMs: Date.now() - attempt.startedAt,
        status: lastStatus,
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
    if (error instanceof InvalidAnycloudConfigError)
      return CloudFailureDiagnosis.InvalidRequest;
    const {
      code,
      msg,
      entries: errorEntries,
      statuses,
      reasons,
      messages: errorMessages,
    } = gcpErrorParts(error);

    // Target-specific
    if (
      typeof msg === 'string' &&
      msg.includes("Invalid value for field 'resource.machineType'")
    )
      return CloudFailureDiagnosis.InvalidTarget;

    // Quota errors. Distinguish account-wide quotas (e.g. CPUS_ALL_REGIONS,
    // reported "globally") from per-region ones: rotating regions can't escape
    // an account-wide cap, so it gets a distinct kind that backs off / rotates
    // accounts instead.
    if (
      code === 'RESOURCE_EXHAUSTED' ||
      (typeof msg === 'string' && /quota/i.test(msg))
    ) {
      if (
        typeof msg === 'string' &&
        (/ALL_REGIONS/i.test(msg) || /\bglobally\b/i.test(msg))
      )
        return CloudFailureDiagnosis.QuotaExhaustedAccount;
      return CloudFailureDiagnosis.QuotaExhaustedRegion;
    }
    // GCP zone-level capacity exhaustion. REST errors use errors[].reason,
    // while Compute operations use errors[].code. Keep the narrow provider
    // message as a fallback because older call paths flattened operation errors
    // into a plain Error and persisted only this canonical text.
    // Distinct from quota: this is GCP running out of hardware, not the user's
    // quota.
    if (
      reasons.some((reason) => GCP_ZONE_CAPACITY_CODES.has(reason)) ||
      errorMessages.some(
        (message) =>
          GCP_ZONE_CAPACITY_MESSAGE_PATTERN.test(message) ||
          /\bZONE_RESOURCE_POOL_EXHAUSTED(?:_WITH_DETAILS)?\b/.test(message),
      )
    )
      return CloudFailureDiagnosis.CapacityExhausted;

    // A bad disk policy is deterministic and rotating zones cannot repair it.
    // Keep this narrow: Compute's field/resource codes and gRPC
    // INVALID_ARGUMENT envelope are broad, so require the provider message to
    // identify a disk field.
    if (
      ((typeof code === 'string' && GCP_DISK_CONFIGURATION_CODES.has(code)) ||
        code === 3 ||
        code === 400 ||
        (error as any).statusCode === 400 ||
        reasons.some((reason) => GCP_DISK_CONFIGURATION_CODES.has(reason))) &&
      errorMessages.some((message) =>
        GCP_DISK_CONFIGURATION_MESSAGE_PATTERN.test(message),
      )
    )
      return CloudFailureDiagnosis.InvalidRequest;

    // VPC/subnet errors: we don't manage VPCs so these indicate transient cloud-side
    // issues rather than user misconfiguration. Retry in a different region.
    if (
      (typeof msg === 'string' &&
        (/VPC_NOT_FOUND/i.test(msg) || /SUBNET_NOT_FOUND/i.test(msg))) ||
      reasons.includes('VPC_NOT_FOUND') ||
      reasons.includes('SUBNET_NOT_FOUND_FOR_VPC')
    )
      return CloudFailureDiagnosis.TemporaryProviderFailure;

    // A disabled API or billing account needs the project fixed, not a retry.
    if (GCP_NOT_PERMISSION.test([...reasons, ...errorMessages].join('\n')))
      return CloudFailureDiagnosis.InvalidRequest;
    if (gcpPermissionDenial(error))
      return CloudFailureDiagnosis.PermissionDenied;

    // An unrecognized credential: BadCredential. The workload terminates as
    // Invalid (same as UserError downstream).
    //
    // GCP deliberately does NOT implement isTerminalAuthError (no durable
    // credential mark): UNAUTHENTICATED is a broad gRPC envelope that also fires
    // transiently for a valid key (clock skew in the JWT→token exchange, new
    // service-account-key propagation, transient OAuth/metadata failures), so
    // it is not an unambiguous invalid-secret signal and follows the ordinary
    // retry policy (mirrors Azure excluding its stale-token codes). The REST
    // transport can retain only the numeric 401 plus errors[].reason or the
    // serialized body text.
    if (
      statuses.includes('UNAUTHENTICATED') ||
      (code === 401 &&
        (reasons.includes('unauthorized') ||
          (typeof msg === 'string' && msg.includes('UNAUTHENTICATED'))))
    )
      return CloudFailureDiagnosis.BadCredential;

    // GCP Storage errors: reason in errors array.
    // 'invalid' is GCP's reason code for malformed resource names (e.g. invalid bucket
    // names, invalid object paths). It's broad in the GCP error schema, but in practice
    // we only hit it on Storage creation calls where the input is user-supplied.
    if (errorEntries.some((entry: any) => entry?.reason === 'invalid'))
      return CloudFailureDiagnosis.InvalidRequest;

    return CloudFailureDiagnosis.TemporaryProviderFailure;
  }
}
