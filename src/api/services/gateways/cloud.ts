import { createReadStream } from 'fs';
import { Readable } from 'stream';
import {
  resolveGatewayVM,
  type CloudVM,
  type CloudNetworkHandle,
  type CloudResourceScope,
  type ResourceVM,
  type GatewayVM,
  type IngressSpec,
  type NewVMProps,
  type ProvisioningAttemptIdentity,
} from '../entities.js';
import {
  CloudFailureDiagnosis,
  CloudType,
  type ScopedStorageCredentials,
} from '../../../shared/cloud.js';
import type { PermissionDenial } from '../../../shared/permission-denied.js';
import type {
  BucketEntryPage,
  BucketListPage,
} from '../../../shared/api-contract/bucket-metadata-schemas.js';
import { retryUntil, sleep, withRetry } from '../../../shared/utils.js';
import {
  BucketNotFoundError,
  DeployError,
  ObjectNotFoundError,
} from '../../../shared/errors.js';
import {
  acceleratorRuntimeRejectionMessage,
  PROVIDER_DATA,
} from '../../../shared/providers.js';
import type { CandidatePreflightCache } from '../candidate-preflight-cache.js';
import { log } from '../logger.js';
import {
  coordinatedBucketExists,
  coordinatedBucketTransientRetryOptions,
  coordinatedBucketUpsert,
  invalidateBucketExists,
} from './storage-coordinator.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';

/**
 * Run `fn` across `items` with at most `limit` in flight. Always settles every
 * item (mirrors Promise.allSettled). Apply it wherever one admitted item can
 * still fan out over N cloud/SSH targets, and in independent periodic services
 * such as billing reconciliation. Workload-state fan-out is bounded by the
 * shared reconciler before handlers run.
 *
 * Why the cap matters — the ephemeral socket budget:
 * Every outbound connection (a cloud-API HTTPS call, an SSH to a VM) needs a
 * local source port from the OS ephemeral range (~28k ports on Linux,
 * 32768–60999). Closed connections linger in TIME_WAIT (~60s) before the port
 * frees, and Node's HTTPS agent has no default cap (maxSockets = Infinity), so
 * an unbounded Promise.allSettled over 100s+ items opens every connection at
 * once. The OS — not Node — pushes back: connect() fails with EADDRNOTAVAIL
 * ("cannot assign requested address") once the range is exhausted (or EMFILE if
 * the file-descriptor ulimit is hit first). Inside our single-process API
 * container that ceiling is reached fast, and *every* in-flight item fails
 * before any can complete. Bounding to `limit` keeps peak sockets ≈ limit
 * regardless of N.
 */
export async function pAllSettledLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      let idx: number;
      while ((idx = cursor++) < items.length) {
        try {
          results[idx] = {
            status: 'fulfilled',
            value: await fn(items[idx]!, idx),
          };
        } catch (reason) {
          results[idx] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return results;
}

/**
 * Retry delete operations, treating "not found" as success because the
 * resource has already reached the desired state.
 */
export async function deleteWithRetry(
  deleteFn: () => Promise<any>,
  resourceName: string,
  isNotFound: (error: any) => boolean,
  maxAttempts = 30,
  waitMs = 10000,
  // Gate retries: return false to give up immediately on an error that will
  // re-fail identically every attempt (e.g. a rotated/expired cloud credential),
  // instead of burning the full maxAttempts × waitMs chain. Defaults to always
  // retrying (prior behavior).
  shouldRetry?: (error: unknown) => boolean,
): Promise<void> {
  await withRetry(
    async () => {
      try {
        await deleteFn();
      } catch (error) {
        if (isNotFound(error)) {
          log.debug(`Resource ${resourceName} already deleted`);
          return;
        }
        throw error;
      }
    },
    `deletion of ${resourceName}`,
    {
      maxAttempts,
      waitMs,
      exponentialBackoff: false, // Use linear backoff for deletions (waiting for resource release, not transient errors)
      shouldRetry,
      onRetry: (attempt, max, error) =>
        log.info(
          `Retrying deletion of ${resourceName} (${attempt}/${max}): ${errorMessage(error)}`,
        ),
    },
  );
}

/**
 * Transport-level failures reaching a cloud's API or token endpoint — most often
 * a "Premature close" (the socket is severed before the response body arrives),
 * or ECONNRESET / socket hang up — happen below the application layer, so the
 * request never reached a decision on the server and is safe to retry. They bite
 * the OAuth token exchange GCP (gtoken) and Azure (ClientSecretCredential)
 * perform on the first authenticated storage call. A genuinely bad/rotated key
 * returns invalid_grant / 401 (an application response, not a transport drop)
 * and is deliberately NOT matched here, so an invalid credential still fails
 * fast.
 */
const TRANSIENT_TRANSPORT_CODES = new Set([
  'EADDRNOTAVAIL',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_TRANSPORT_RE =
  /premature close|eaddrnotavail|eai_again|econnaborted|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|etimedout|esockettimedout|socket hang up|epipe|und_err_connect_timeout|und_err_socket|fetch failed|other side closed|network socket disconnected/i;

/** The HTTP status a provider SDK error carries, wherever its SDK puts it. */
export function providerHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    response?: { status?: unknown; statusCode?: unknown };
  };
  const values = [
    candidate.status,
    candidate.statusCode,
    candidate.$metadata?.httpStatusCode,
    candidate.response?.status,
    candidate.response?.statusCode,
    candidate.code,
  ];
  return values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isInteger(value),
  );
}

/** @internal — exported for testing */
export function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // SDKs commonly wrap the socket error (and its structured `code`) in one or
  // more generic request errors. Walk that cause chain while retaining the
  // Error-only public contract so arbitrary response bodies cannot opt into a
  // retry by containing one of these strings.
  const seen = new Set<object>();
  let candidate: unknown = error;
  while (candidate && typeof candidate === 'object') {
    if (seen.has(candidate)) return false;
    seen.add(candidate);

    const transportError = candidate as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    // AbortSignal.timeout() and undici surface an elapsed fetch deadline as a
    // DOMException named TimeoutError. Do not match AbortError here: callers
    // use that distinct name for intentional cancellation.
    if (transportError.name === 'TimeoutError') return true;
    if (
      typeof transportError.code === 'string' &&
      TRANSIENT_TRANSPORT_CODES.has(transportError.code.toUpperCase())
    ) {
      return true;
    }
    if (
      typeof transportError.message === 'string' &&
      TRANSIENT_TRANSPORT_RE.test(transportError.message)
    ) {
      return true;
    }
    candidate = transportError.cause;
  }
  return false;
}

// Members shared by every cloud provider regardless of how it runs workloads
// (VMs, containers, etc.). The VM-host surface lives on CloudCompute below.
interface CloudBase {
  readonly type: CloudType;
  readonly region: string;
  readonly spot?: boolean;
  // Validate credentials by making a lightweight API call
  // Throws an error with details if credentials are invalid
  validateCredentials(): Promise<void>;
  /** Optional bounded recovery for provider-specific propagation failures. */
  readonly credentialValidationRetryPolicy?: CredentialValidationRetryPolicy;
  /** Positive provider-specific evidence that validation can be retried. */
  isCredentialValidationRetryable?(error: unknown): boolean;
  // Classify a provisioning/cloud error. provisioning-failure.ts/task.ts decide the
  // scheduler disposition separately from this diagnosis.
  classifyError(error: unknown): CloudFailureDiagnosis;
  /**
   * The action an authenticated credential was refused, when classifyError
   * says PermissionDenied. A regional denial blocks only that region for an
   * unpinned Job; any other denial ends the Workload invalid.
   */
  permissionDenial?(error: unknown): PermissionDenial | undefined;
}

interface CredentialValidationRetryPolicy {
  maxAttempts: number;
  waitMs: number;
  maxWaitMs?: number;
  exponentialBackoff?: boolean;
  shouldRetry(error: unknown): boolean;
  beforeRetry?(error: unknown, attempt: number, maxAttempts: number): void;
}

const cloudComputeBrand: unique symbol = Symbol('CloudCompute');

export const VMReleaseState = {
  Present: 'present',
  Candidate: 'release-candidate',
  Confirming: 'confirming-release',
  Released: 'released',
  Unknown: 'unknown',
} as const;

export type VMReleasePresent = { state: typeof VMReleaseState.Present };
export type VMReleaseCandidate = { state: typeof VMReleaseState.Candidate };
export type VMReleaseUnknown = {
  state: typeof VMReleaseState.Unknown;
  error: string;
};

/** One provider observation. A candidate is evidence, not final confirmation. */
export type VMReleaseObservation =
  | VMReleasePresent
  | VMReleaseCandidate
  | VMReleaseUnknown;

/** The result after applying the provider's release-confirmation policy. */
export type VMReleaseStatus =
  | VMReleasePresent
  | { state: typeof VMReleaseState.Confirming }
  | { state: typeof VMReleaseState.Released }
  | VMReleaseUnknown;

export interface VMReleaseObservationOptions {
  signal?: AbortSignal;
}

export interface VMReleaseConfirmationPolicy {
  /** Successful release observations required before a VM is declared gone. */
  readonly requiredReleaseObservations: number;
  /** Minimum time between completion of successful observations. */
  readonly minObservationIntervalMs: number;
}

const DEFAULT_VM_RELEASE_CONFIRMATION_POLICY: VMReleaseConfirmationPolicy =
  Object.freeze({
    requiredReleaseObservations: 1,
    minObservationIntervalMs: 0,
  });

export const VM_PRESENT: VMReleasePresent = Object.freeze({
  state: VMReleaseState.Present,
});

export const VM_RELEASE_CANDIDATE: VMReleaseCandidate = Object.freeze({
  state: VMReleaseState.Candidate,
});

export const VM_RELEASE_CONFIRMING: VMReleaseStatus = Object.freeze({
  state: VMReleaseState.Confirming,
});

export const VM_RELEASED: VMReleaseStatus = Object.freeze({
  state: VMReleaseState.Released,
});

export function vmReleaseUnknown(error: unknown): VMReleaseUnknown {
  return {
    state: VMReleaseState.Unknown,
    error: errorMessage(error),
  };
}

export interface VMReleaseConfirmer {
  /** Apply stable-release policy to exactly one provider observation. */
  observe(
    observeOnce: () => Promise<VMReleaseObservation>,
  ): Promise<VMReleaseStatus>;
  /** Time remaining before another successful observation can count. */
  nextObservationDelayMs(): number;
  reset(): void;
}

function normalizeVMReleaseConfirmationPolicy(
  policy: VMReleaseConfirmationPolicy | undefined,
): VMReleaseConfirmationPolicy {
  const normalized = policy ?? DEFAULT_VM_RELEASE_CONFIRMATION_POLICY;
  if (
    !Number.isSafeInteger(normalized.requiredReleaseObservations) ||
    normalized.requiredReleaseObservations < 1
  ) {
    throw new Error('requiredReleaseObservations must be a positive integer');
  }
  if (
    !Number.isFinite(normalized.minObservationIntervalMs) ||
    normalized.minObservationIntervalMs < 0
  ) {
    throw new Error('minObservationIntervalMs must be non-negative');
  }
  return Object.freeze({ ...normalized });
}

/**
 * Turn provider observations into confirmed release state. The clock is read
 * after each provider call completes, so request latency cannot satisfy the
 * required stability interval. Present/unknown evidence starts a new series.
 */
export function createVMReleaseConfirmer(
  policy: VMReleaseConfirmationPolicy,
  now: () => number = () => Date.now(),
): VMReleaseConfirmer {
  const normalized = normalizeVMReleaseConfirmationPolicy(policy);
  let successfulObservations = 0;
  let lastSuccessfulObservationAt: number | undefined;
  let confirmed = false;
  let inFlight: Promise<VMReleaseStatus> | undefined;

  const reset = () => {
    successfulObservations = 0;
    lastSuccessfulObservationAt = undefined;
    confirmed = false;
  };

  const nextObservationDelayMs = () =>
    lastSuccessfulObservationAt === undefined
      ? 0
      : Math.max(
          0,
          normalized.minObservationIntervalMs -
            (now() - lastSuccessfulObservationAt),
        );

  const runObservation = async (
    observeOnce: () => Promise<VMReleaseObservation>,
  ): Promise<VMReleaseStatus> => {
    if (confirmed) return VM_RELEASED;
    if (successfulObservations > 0 && nextObservationDelayMs() > 0) {
      return VM_RELEASE_CONFIRMING;
    }

    let observation: VMReleaseObservation;
    try {
      observation = await observeOnce();
    } catch (error) {
      reset();
      return vmReleaseUnknown(error);
    }

    if (observation.state !== VMReleaseState.Candidate) {
      reset();
      return observation;
    }

    // Completion time, deliberately not request start time.
    lastSuccessfulObservationAt = now();
    successfulObservations += 1;
    if (successfulObservations >= normalized.requiredReleaseObservations) {
      confirmed = true;
      return VM_RELEASED;
    }
    return VM_RELEASE_CONFIRMING;
  };

  return {
    observe: (observeOnce) => {
      if (inFlight) return inFlight;
      const pending = runObservation(observeOnce).finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
      inFlight = pending;
      return pending;
    },
    nextObservationDelayMs,
    reset,
  };
}

interface CloudComputePublic extends CloudBase {
  readonly vmType: string;
  /** Evidence required before one provider observation becomes `released`. */
  readonly releaseConfirmationPolicy: VMReleaseConfirmationPolicy;
  /**
   * Inspect the exact durable attempt identity before other recovery work can
   * fail. A null result means an authoritative lookup found no resource;
   * inconclusive reads throw ResourceStateIndeterminateError.
   */
  adoptProvisioningAttempt?(
    attempt: ProvisioningAttemptIdentity,
  ): Promise<CloudVM | null>;
  // Creates a new VM for the workload
  newVM(params: NewVMProps): Promise<CloudVM>;
  // Terminates VMs and their directly-attached resources (NICs, IPs, disks).
  // Returns the subset of input vmIds whose cloud-side resources are confirmed gone
  // (delete succeeded, or 404 — already deleted). Callers use the returned set to
  // mark `ended_at` in the local DB; vmIds omitted from the result stay live so
  // the reconciler's cleanup lane retries them. `onUnconfirmed` receives the
  // provider error for each omitted vmId that failed; a VM still shutting down
  // when the confirmation window ends is omitted without one.
  terminateVMs(
    vmIds: string[],
    onUnconfirmed?: (vmId: string, error: unknown) => void,
  ): Promise<string[]>;
  // Deletes workload-scoped networking resources (firewalls, NSGs, VNets).
  // Called only during final teardown, not during retry cleanup.
  terminateNetworking(workloadId: string): Promise<void>;
  getAllVMs(): Promise<GatewayVM[]>;
  // Upserts firewall for each cloud (idempotent — safe to call on retries).
  // For AWS and GCP will add the self reference to the firewall so VMs can talk each other.
  // On Azure, we will create a common vnet.
  upsertFirewall(
    ipWhiteList: string[],
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<void>;
  // Prepare provider networking for the requested ingress. Callers express
  // ingress requirements here; gateways apply cloud primitives without
  // workload product semantics like "job" or "service".
  prepareNetwork?(
    spec: IngressSpec,
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<CloudNetworkHandle | undefined>;
  // Whether service workloads on this substrate get a public endpoint
  // (<id>.anycloud.sh DNS + TLS). Absent means yes; only substrates whose
  // workloads are reachable solely from the API host answer false.
  publishesPublicEndpoint?(): boolean;
  // Take exactly one provider-specific release observation. A release
  // candidate is intentionally not final: callers must apply
  // releaseConfirmationPolicy through createVMReleaseConfirmer or
  // confirmVMRelease before closing a durable row or launching replacement
  // work. `unknown` remains distinct from authoritative presence. Preemption
  // is separate.
  observeVMReleaseOnce(
    cloudId: string,
    options?: VMReleaseObservationOptions,
  ): Promise<VMReleaseObservation>;
}

interface ResourceScopedProvisioningAttemptIdentity
  extends Omit<
    ProvisioningAttemptIdentity,
    'workloadId' | 'resourceScope' | 'userId'
  > {
  scope: CloudResourceScope;
}

interface ResourceScopedNewVMProps
  extends Omit<NewVMProps, 'workloadId' | 'userId' | 'resourceScope'> {
  scope: CloudResourceScope;
}

/** The instance-metadata address on AWS, Azure and GCP. */
export const INSTANCE_METADATA_CIDR = '169.254.169.254/32';

/**
 * Asks the AWS, GCP and Azure metadata services in turn for the VM's public
 * IPv4; each answers only on its own cloud, and none on Lambda.
 */
const METADATA_EXTERNAL_IP_DISCOVERY = `TOKEN="$(curl -sf -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
EXTERNAL_IP="$(curl -sf -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
[ -n "$EXTERNAL_IP" ] || EXTERNAL_IP="$(curl -sf -m 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)"
[ -n "$EXTERNAL_IP" ] || EXTERNAL_IP="$(curl -sf -m 2 -H 'Metadata: true' 'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' || true)"`;

/** What a node pool provider gives the shared join script (RFC 0044 B5, B6). */
export interface NodePoolBootInputs {
  /** Host-only addresses: the Node drops Pod traffic to them. */
  readonly hostOnlyCidrs: readonly [string, ...string[]];
  /** The Node resolves names through one of them, so their port 53 stays open. */
  readonly resolvesThroughHostOnly: boolean;
  /** Bash that sets `EXTERNAL_IP` to the VM's public IPv4, or null for none. */
  readonly externalIpDiscovery: string | null;
  /** Sizes without raw NVMe keep kubelet and containerd on Azure's resource disk. */
  readonly resourceDiskStore: boolean;
}

/**
 * AWS's and Lambda's boot inputs, which GCP and Azure extend. Both inputs are
 * trusted gateway code that runs as root at first boot, never values from a
 * provider API.
 */
export const METADATA_NODE_POOL_BOOT: NodePoolBootInputs = {
  hostOnlyCidrs: [INSTANCE_METADATA_CIDR],
  resolvesThroughHostOnly: false,
  externalIpDiscovery: METADATA_EXTERNAL_IP_DISCOVERY,
  resourceDiskStore: false,
};

/**
 * Optional compute capability for durable owners that are not workloads.
 * The gateway receives only an opaque naming/tagging scope and network intent.
 */
interface CloudResourceComputePublic {
  nodePoolBoot: NodePoolBootInputs;
  prepareResourceNetwork(
    spec: IngressSpec,
    scope: CloudResourceScope,
    version: string,
  ): Promise<CloudNetworkHandle | undefined>;
  adoptResourceProvisioningAttempt?(
    attempt: ResourceScopedProvisioningAttemptIdentity,
  ): Promise<CloudVM | null>;
  newResourceVM(params: ResourceScopedNewVMProps): Promise<CloudVM>;
  /** The scope's VMs that still exist, stopped included. */
  listResourceVMs?(scope: CloudResourceScope): Promise<ResourceVM[]>;
  terminateResourceNetwork(scope: CloudResourceScope): Promise<void>;
  /** Idempotently delete all a gone scope VM's launch created besides it. */
  terminateResourceVMLeftovers?(cloudId: string): Promise<void>;
}

interface CloudResourceComputeOps {
  nodePoolBoot: NodePoolBootInputs;
  prepareResourceNetwork(
    spec: IngressSpec,
    scope: CloudResourceScope,
    version: string,
  ): Promise<CloudNetworkHandle | undefined>;
  adoptResourceProvisioningAttempt?(
    attempt: ResourceScopedProvisioningAttemptIdentity,
  ): Promise<GatewayVM | null>;
  newResourceVM(params: ResourceScopedNewVMProps): Promise<GatewayVM>;
  listResourceVMs?(scope: CloudResourceScope): Promise<ResourceVM[]>;
  terminateResourceNetwork(scope: CloudResourceScope): Promise<void>;
  terminateResourceVMLeftovers?(cloudId: string): Promise<void>;
}

/**
 * Refuse a cluster's management VM scope, `anycloud-cluster-<id>`
 * (clusters-domain.ts), on a provider that can't host one. A node pool id has
 * at most a 9-character name prefix, so it never starts that way.
 */
export function refuseClusterScope(
  cloud: CloudType,
  scope: CloudResourceScope,
): void {
  if (scope.id.startsWith('anycloud-cluster-')) {
    throw new Error(
      `${cloud} can't host a cluster's management VM; use AWS, GCP or Azure`,
    );
  }
}

const cloudResourceComputeBrand: unique symbol = Symbol('CloudResourceCompute');

export type CloudResourceCompute = CloudResourceComputePublic & {
  readonly [cloudResourceComputeBrand]: true;
};

export function canManageCloudResources(
  gateway: object,
): gateway is CloudCompute & CloudResourceCompute {
  return Boolean(
    (gateway as Partial<CloudResourceCompute>)[cloudResourceComputeBrand],
  );
}

export type CloudCompute = CloudComputePublic & {
  readonly [cloudComputeBrand]: true;
};

/**
 * Confirm one VM release using the compute provider's declared policy. This is
 * for one-shot callers that can wait between observations; periodic monitors
 * should retain a createVMReleaseConfirmer instance across their own polls.
 */
export async function confirmVMRelease(
  compute: CloudCompute,
  cloudId: string,
  options: VMReleaseObservationOptions = {},
): Promise<VMReleaseStatus> {
  const confirmer = createVMReleaseConfirmer(compute.releaseConfirmationPolicy);
  let status = await confirmer.observe(() =>
    compute.observeVMReleaseOnce(cloudId, options),
  );
  while (status.state === VMReleaseState.Confirming) {
    try {
      await sleep(confirmer.nextObservationDelayMs(), options.signal);
    } catch (error) {
      return vmReleaseUnknown(error);
    }
    status = await confirmer.observe(() =>
      compute.observeVMReleaseOnce(cloudId, options),
    );
  }
  return status;
}

interface CloudUploadSourceBuffer {
  readonly kind: 'buffer';
  readonly bytes: Buffer;
  readonly contentLength: number;
}

interface CloudUploadSourceFile {
  readonly kind: 'file';
  readonly path: string;
  readonly contentLength: number;
}

interface CloudUploadSourceFactory {
  readonly kind: 'factory';
  readonly open: () => Readable;
  readonly contentLength?: number;
}

export type CloudUploadSource =
  | CloudUploadSourceBuffer
  | CloudUploadSourceFile
  | CloudUploadSourceFactory;

export interface CloudUploadRequest {
  readonly bucketName: string;
  readonly remotePath: string;
  readonly source: CloudUploadSource;
}

export interface CloudDownload {
  stream: Readable;
  contentLength?: number;
}

export function openCloudUploadSource(source: CloudUploadSource): Readable {
  switch (source.kind) {
    case 'buffer':
      return Readable.from(source.bytes);
    case 'file':
      return createReadStream(source.path);
    case 'factory':
      return source.open();
    default:
      source satisfies never;
      throw new Error('Unsupported cloud upload source');
  }
}

type BucketVersioning = 'enabled' | 'disabled';

export interface CloudStorageOperationOptions {
  /** Cancel this caller's wait; coordinated provider work keeps its own lifecycle. */
  signal?: AbortSignal;
}

interface CloudStoragePublic {
  readonly type: CloudType;
  readonly region: string;
  readonly storageAccountName?: string;
  // The S3 endpoint rclone must use, for S3-compatible stores other than AWS.
  readonly s3Endpoint?: string;
  // Returns the bucket/container's actual storage region when the provider can
  // discover it. Undefined means the bucket is missing or discovery is not
  // supported.
  getBucketRegion?(
    bucketName: string,
    options?: CloudStorageOperationOptions,
  ): Promise<string | undefined>;
  // Checks if a bucket/container exists.
  hasBucket(
    bucketName: string,
    options?: CloudStorageOperationOptions,
  ): Promise<boolean>;
  // Whether object versioning is enabled on the bucket/container. The API
  // database backup relies on it for history (one fixed key, many versions).
  getBucketVersioning?(
    bucketName: string,
    options?: CloudStorageOperationOptions,
  ): Promise<BucketVersioning>;
  // Turn object versioning on (idempotent). Used for Anycloud-managed
  // checkpoint buckets; user-supplied buckets are never reconfigured.
  enableBucketVersioning?(
    bucketName: string,
    options?: CloudStorageOperationOptions,
  ): Promise<void>;
  // Upserts a bucket/container (idempotent — skips if exists). Used for
  // AnyCloud-created output and implicit spot-checkpoint buckets.
  upsertBucket(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
    options?: CloudStorageOperationOptions,
  ): Promise<void>;
  // Creates a bucket a workload owns by name, or reuses one this credential's
  // own account or project already holds, and returns its region. It creates
  // first and reads the create's answer, never a probe, so a name another
  // owner holds throws BucketNameTakenError and is never adopted (RFC 0043
  // D-managed). A provider without global names upserts.
  createOwnedBucket(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
  ): Promise<string>;
  // Deletes bucket/container and all its contents. Idempotent - no-op if bucket doesn't exist.
  deleteBucket(
    bucketName: string,
    options?: CloudStorageOperationOptions,
  ): Promise<void>;
  // Delete one object/blob/key from a bucket. Idempotent - no-op if the object doesn't exist.
  deleteObject(
    bucketName: string,
    remotePath: string,
    options?: CloudStorageOperationOptions,
  ): Promise<void>;
  // Upload an object from a replayable source. The source must be reusable because
  // shared storage retry may call provider raw operations more than once.
  // Throws BucketNotFoundError when the bucket does not exist.
  uploadObject(
    bucketName: string,
    remotePath: string,
    source: CloudUploadSource,
    options?: CloudStorageOperationOptions,
  ): Promise<void>;
  // Stream an object out of a bucket. contentLength is populated when the
  // provider returns it (useful for CLI progress display). Throws
  // BucketNotFoundError or ObjectNotFoundError for an absent target.
  downloadObject(
    bucketName: string,
    remotePath: string,
    options?: CloudStorageOperationOptions,
  ): Promise<CloudDownload>;
  // Reports a provider failure shaped like an IAM propagation delay after the
  // provider's bounded recovery was exhausted.
  isCredentialNotReady?(error: unknown): boolean;
  classifyStorageFailure?: CloudStorageOps['classifyStorageFailure'];
}

/**
 * A storage failure anycloud reports as itself instead of an internal error,
 * with the provider's own error code for the message.
 */
export interface StorageFailure {
  kind: 'bucket-missing' | 'object-missing' | 'denied' | 'throttled';
  code: string;
}

export interface CloudListPageOptions {
  pageSize: number;
  cursor?: string;
}

export interface CloudObjectListOptions extends CloudListPageOptions {
  prefix: string;
  recursive: boolean;
}

/** Optional capability for providers that can enumerate their bucket namespace. */
export interface CloudBucketLister {
  listBuckets(
    options: CloudListPageOptions,
    operationOptions?: CloudStorageOperationOptions,
  ): Promise<BucketListPage>;
}

/**
 * Optional capability for providers that can enumerate objects within a
 * bucket. Throws BucketNotFoundError when the bucket does not exist.
 */
export interface CloudObjectLister {
  listObjects(
    bucketName: string,
    options: CloudObjectListOptions,
    operationOptions?: CloudStorageOperationOptions,
  ): Promise<BucketEntryPage>;
}

// Optional capability: mint scoped, short-lived credentials for VM bucket
// sync. Only clouds that can issue scoped, short-lived tokens implement it
// (AWS S3 via STS, Cloudflare R2 via temporary credentials, Azure via a
// container SAS, GCP via Credential Access Boundaries). Callers mint one token
// per bucket; AWS and GCP also accept several same-provider grants in one
// token, R2 and Azure do not. Any credentials that ride a VM must be
// bucket-scoped and short-lived, never a standing key. Source credential shape
// is provider-specific and validated by the implementation. Local does not
// implement it.
export interface ScopedStorageToken {
  credentials: ScopedStorageCredentials;
  /** Actual provider expiration, in epoch milliseconds. */
  expiresAt: number;
}

export interface ScopedStorageTokenMinter {
  // Validate that this storage provider's source credentials are allowed to
  // mint scoped storage tokens. This must be local/no-network and should throw
  // a user-facing DeployError when a credential shape cannot mint.
  validateScopedStorageTokenSource(): void;

  // Mint a scoped, short-lived credential whose policy covers exactly the given
  // grants: 'read' = sync-down only (never Put/Delete on the user's source data),
  // 'readwrite' = read + Put/Delete. Returns undefined for an empty grant list.
  // Implementations must throw rather than return standing credentials.
  // `lifetimeMs` is a request: a provider may return another expiry, and the
  // caller schedules renewal from `expiresAt`.
  mintScopedStorageToken(
    grants: ScopedStorageGrant[],
    options?: { lifetimeMs?: number },
  ): Promise<ScopedStorageToken | undefined>;
}

export interface ScopedStorageGrant {
  bucket: string;
  /**
   * Ends in `/`: the grant reads, writes and lists only objects under it.
   * Azure, AWS and GCP honor it (RFC 0043 O26); R2 ignores it until CF3, so
   * the pool Job minter refuses R2.
   */
  prefix?: string;
  mode: 'read' | 'readwrite';
  /**
   * The grant overwrites but never deletes where the backend can overwrite
   * without delete (Azure, S3); elsewhere (GCS) it deletes only inside its
   * prefix, or its bucket when it has none (RFC 0043 § The minter).
   */
  noDelete?: true;
}

/** STS refuses a session policy over 2,048 characters; this says so first. */
export class ScopedStoragePolicyTooLargeError extends Error {
  constructor(readonly length: number) {
    super(
      `These grants need a ${length}-character AWS session policy, over STS's 2,048; ask for fewer grants or shorter bucket and prefix names.`,
    );
    this.name = 'ScopedStoragePolicyTooLargeError';
  }
}

const cloudStorageBrand: unique symbol = Symbol('CloudStorage');

export type CloudStorage = CloudStoragePublic & {
  readonly [cloudStorageBrand]: true;
};

type CloudStorageBuilder = {
  -readonly [Key in keyof CloudStoragePublic]: CloudStoragePublic[Key];
} & Partial<ScopedStorageTokenMinter> &
  Partial<CloudBucketLister> &
  Partial<CloudObjectLister>;

export interface CloudStorageRetryPolicy {
  maxAttempts?: number;
  waitMs?: number;
  maxWaitMs?: number;
  exponentialBackoff?: boolean;
  jitter?: boolean | ((error: unknown) => boolean);
  shouldRetry(error: unknown): boolean;
  beforeRetry?(error: unknown, attempt: number, maxAttempts: number): void;
  /** The error a failed operation reports, given the retried ones before it. */
  reportedError?(final: unknown, earlier: readonly unknown[]): unknown;
}

export interface CloudStorageOps extends Partial<ScopedStorageTokenMinter> {
  readonly type: CloudType;
  readonly region: string;
  readonly storageAccountName?: string;
  readonly s3Endpoint?: string;
  readonly retryPolicy?: CloudStorageRetryPolicy;
  // Some coordinated upserts need a long transport-recovery window while a
  // provider-specific condition uses the ordinary bounded operation policy.
  readonly coordinatedUpsertShouldRetry?: (error: unknown) => boolean;
  readonly rawBucketCoordinationKey?: (bucketName: string) => string;
  rawGetBucketRegion?(bucketName: string): Promise<string | undefined>;
  rawGetBucketVersioning?(bucketName: string): Promise<BucketVersioning>;
  rawEnableBucketVersioning?(bucketName: string): Promise<void>;
  rawHasBucket(bucketName: string): Promise<boolean>;
  rawUpsertBucketUncoordinated(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
  ): Promise<void>;
  rawCreateOwnedBucket?(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
  ): Promise<string>;
  rawDeleteBucket(bucketName: string): Promise<void>;
  rawDeleteObject(bucketName: string, remotePath: string): Promise<void>;
  rawUploadObject(request: CloudUploadRequest): Promise<void>;
  rawDownloadObject(
    bucketName: string,
    remotePath: string,
  ): Promise<CloudDownload>;
  rawListBuckets?(
    options: CloudListPageOptions,
    signal?: AbortSignal,
  ): Promise<BucketListPage>;
  rawListObjects?(
    bucketName: string,
    options: CloudObjectListOptions,
    signal?: AbortSignal,
  ): Promise<BucketEntryPage>;
  isNotFound?(error: unknown): boolean;
  // Classifies a failure from the provider's own status and code fields,
  // never its message. Narrower than isNotFound: a credential, account or
  // permission failure is never missing. remotePath is set only for a
  // download, the one operation whose not-found can name a missing object.
  classifyStorageFailure?(
    error: unknown,
    bucketName?: string,
    remotePath?: string,
  ): Promise<StorageFailure | undefined>;
  isCredentialNotReady?(error: unknown): boolean;
}

async function runCloudStorageOperation<T>(
  ops: CloudStorageOps,
  operationName: string,
  operation: () => Promise<T>,
  options: {
    notFoundIsSuccess?: boolean;
    retryPolicy?: CloudStorageRetryPolicy | null;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const run = async (): Promise<T> => {
    options.signal?.throwIfAborted();
    try {
      const result = await operation();
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (options.notFoundIsSuccess && ops.isNotFound?.(error)) {
        log.debug(`${operationName} target already absent`);
        return undefined as T;
      }
      throw error;
    }
  };

  const retryPolicy =
    options.retryPolicy === null
      ? undefined
      : (options.retryPolicy ?? ops.retryPolicy);
  if (!retryPolicy) return run();

  const earlier: unknown[] = [];
  const operationWithRetry = withRetry(run, operationName, {
    maxAttempts: retryPolicy.maxAttempts,
    waitMs: retryPolicy.waitMs,
    maxWaitMs: retryPolicy.maxWaitMs,
    exponentialBackoff: retryPolicy.exponentialBackoff,
    jitter: retryPolicy.jitter,
    signal: options.signal,
    shouldRetry: (error) => {
      if (options.notFoundIsSuccess && ops.isNotFound?.(error)) return false;
      return retryPolicy.shouldRetry(error);
    },
    onRetry: (attempt, maxAttempts, error) => {
      earlier.push(error);
      retryPolicy.beforeRetry?.(error, attempt, maxAttempts);
      log.info(`Retrying ${operationName} (${attempt}/${maxAttempts})`, {
        error: error,
      });
    },
  });
  const { reportedError } = retryPolicy;
  if (!reportedError) return operationWithRetry;
  return operationWithRetry.catch((error: unknown) => {
    throw reportedError(error, earlier);
  });
}

/** Rethrow a provider absence as BucketNotFoundError or ObjectNotFoundError. */
async function throwMissingTarget(
  ops: CloudStorageOps,
  error: unknown,
  bucketName: string,
  remotePath?: string,
): Promise<never> {
  // A classification that itself fails keeps the provider's own error.
  const failure = await ops
    .classifyStorageFailure?.(error, bucketName, remotePath)
    .catch(() => undefined);
  if (failure?.kind === 'bucket-missing') {
    throw new BucketNotFoundError(bucketName, error);
  }
  if (failure?.kind === 'object-missing' && remotePath !== undefined) {
    throw new ObjectNotFoundError(bucketName, remotePath, error);
  }
  throw error;
}

export function createCloudStorage(ops: CloudStorageOps): CloudStorage {
  const storage: CloudStorageBuilder = {
    type: ops.type,
    region: ops.region,
    hasBucket: (
      bucketName: string,
      operationOptions?: CloudStorageOperationOptions,
    ) => {
      const checkBucket = (signal?: AbortSignal) =>
        runCloudStorageOperation(
          ops,
          `${ops.type} check bucket ${bucketName}`,
          () => ops.rawHasBucket(bucketName),
          { signal },
        );
      const coordinationKey = ops.rawBucketCoordinationKey?.(bucketName);
      if (coordinationKey) {
        return coordinatedBucketExists(
          coordinationKey,
          () => checkBucket(),
          operationOptions?.signal,
        );
      }
      return checkBucket(operationOptions?.signal);
    },
    upsertBucket: (
      bucketName: string,
      version: string,
      workloadId: string,
      userId: string,
      operationOptions?: CloudStorageOperationOptions,
    ) => {
      const rawUpsert = () =>
        ops.rawUpsertBucketUncoordinated(
          bucketName,
          version,
          workloadId,
          userId,
        );
      const coordinationKey = ops.rawBucketCoordinationKey?.(bucketName);
      if (coordinationKey) {
        const boundedUpsert = ops.coordinatedUpsertShouldRetry
          ? () =>
              runCloudStorageOperation(
                ops,
                `${ops.type} upsert bucket ${bucketName}`,
                rawUpsert,
              )
          : rawUpsert;
        return coordinatedBucketUpsert(
          coordinationKey,
          boundedUpsert,
          ops.retryPolicy
            ? coordinatedBucketTransientRetryOptions(
                ops.coordinatedUpsertShouldRetry ?? ops.retryPolicy.shouldRetry,
              )
            : undefined,
          operationOptions?.signal,
        );
      }
      return runCloudStorageOperation(
        ops,
        `${ops.type} upsert bucket ${bucketName}`,
        rawUpsert,
        { signal: operationOptions?.signal },
      );
    },
    createOwnedBucket: async (bucketName, version, workloadId, userId) => {
      if (!ops.rawCreateOwnedBucket) {
        await storage.upsertBucket(bucketName, version, workloadId, userId);
        return ops.region;
      }
      const region = await runCloudStorageOperation(
        ops,
        `${ops.type} create owned bucket ${bucketName}`,
        () =>
          ops.rawCreateOwnedBucket!(bucketName, version, workloadId, userId),
      );
      const coordinationKey = ops.rawBucketCoordinationKey?.(bucketName);
      if (coordinationKey) invalidateBucketExists(coordinationKey);
      return region;
    },
    deleteBucket: async (
      bucketName: string,
      operationOptions?: CloudStorageOperationOptions,
    ) => {
      const coordinationKey = ops.rawBucketCoordinationKey?.(bucketName);
      let deleteSucceeded = false;
      try {
        await runCloudStorageOperation(
          ops,
          `${ops.type} delete bucket ${bucketName}`,
          () => ops.rawDeleteBucket(bucketName),
          {
            notFoundIsSuccess: true,
            signal: operationOptions?.signal,
          },
        );
        deleteSucceeded = true;
      } finally {
        // A provider delete can finish after its caller is cancelled. Its result
        // is then ambiguous to this wrapper, so force the next caller to probe.
        if (
          coordinationKey &&
          (deleteSucceeded || operationOptions?.signal?.aborted)
        ) {
          invalidateBucketExists(coordinationKey);
        }
      }
    },
    deleteObject: (
      bucketName: string,
      remotePath: string,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} delete object ${bucketName}/${remotePath}`,
        () => ops.rawDeleteObject(bucketName, remotePath),
        {
          notFoundIsSuccess: true,
          signal: operationOptions?.signal,
        },
      ),
    uploadObject: (
      bucketName: string,
      remotePath: string,
      source: CloudUploadSource,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} upload object ${bucketName}/${remotePath}`,
        () => ops.rawUploadObject({ bucketName, remotePath, source }),
        { signal: operationOptions?.signal },
      ).catch((error: unknown) => throwMissingTarget(ops, error, bucketName)),
    downloadObject: (
      bucketName: string,
      remotePath: string,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} download object ${bucketName}/${remotePath}`,
        () => ops.rawDownloadObject(bucketName, remotePath),
        { signal: operationOptions?.signal },
      ).catch((error: unknown) =>
        throwMissingTarget(ops, error, bucketName, remotePath),
      ),
  };

  if (ops.storageAccountName) {
    storage.storageAccountName = ops.storageAccountName;
  }
  if (ops.s3Endpoint) storage.s3Endpoint = ops.s3Endpoint;

  if (ops.rawGetBucketVersioning) {
    storage.getBucketVersioning = (
      bucketName: string,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} get bucket versioning ${bucketName}`,
        () => ops.rawGetBucketVersioning!(bucketName),
        { signal: operationOptions?.signal },
      );
  }

  if (ops.rawEnableBucketVersioning) {
    storage.enableBucketVersioning = (
      bucketName: string,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} enable bucket versioning ${bucketName}`,
        () => ops.rawEnableBucketVersioning!(bucketName),
        { signal: operationOptions?.signal },
      );
  }

  if (ops.rawGetBucketRegion) {
    storage.getBucketRegion = (
      bucketName: string,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} get bucket region ${bucketName}`,
        () => ops.rawGetBucketRegion!(bucketName),
        {
          notFoundIsSuccess: true,
          signal: operationOptions?.signal,
        },
      );
  }

  if (ops.rawListBuckets) {
    storage.listBuckets = (
      options: CloudListPageOptions,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} list buckets`,
        () => ops.rawListBuckets!(options, operationOptions?.signal),
        { signal: operationOptions?.signal },
      );
  }

  if (ops.rawListObjects) {
    storage.listObjects = (
      bucketName: string,
      options: CloudObjectListOptions,
      operationOptions?: CloudStorageOperationOptions,
    ) =>
      runCloudStorageOperation(
        ops,
        `${ops.type} list objects in ${bucketName}`,
        () =>
          ops.rawListObjects!(bucketName, options, operationOptions?.signal),
        { signal: operationOptions?.signal },
      ).catch((error: unknown) => throwMissingTarget(ops, error, bucketName));
  }

  if (ops.isCredentialNotReady) {
    storage.isCredentialNotReady = ops.isCredentialNotReady.bind(ops);
  }

  if (ops.classifyStorageFailure) {
    storage.classifyStorageFailure = ops.classifyStorageFailure.bind(ops);
  }

  if (ops.validateScopedStorageTokenSource) {
    storage.validateScopedStorageTokenSource =
      ops.validateScopedStorageTokenSource.bind(ops);
  }

  if (ops.mintScopedStorageToken) {
    storage.mintScopedStorageToken = ops.mintScopedStorageToken.bind(ops);
  }

  Object.defineProperty(storage, cloudStorageBrand, {
    value: true,
    enumerable: false,
  });

  return storage as CloudStorage;
}

export function canMintScopedStorageToken(
  storage: CloudStorage,
): storage is CloudStorage & ScopedStorageTokenMinter {
  return (
    typeof (storage as Partial<ScopedStorageTokenMinter>)
      .mintScopedStorageToken === 'function' &&
    typeof (storage as Partial<ScopedStorageTokenMinter>)
      .validateScopedStorageTokenSource === 'function'
  );
}

export function canListBuckets(
  storage: CloudStorage,
): storage is CloudStorage & CloudBucketLister {
  return (
    typeof (storage as Partial<CloudBucketLister>).listBuckets === 'function'
  );
}

export function canListObjects(
  storage: CloudStorage,
): storage is CloudStorage & CloudObjectLister {
  return (
    typeof (storage as Partial<CloudObjectLister>).listObjects === 'function'
  );
}

// Spot is three optional capabilities (RFC 0044, decision 33). Spot launch:
// `newResourceVM` honours the config's `spot`. Stopped-VM observation, the
// pool's: an exact-ID read, true if the VM is stopped or stopping, false if
// running or not found. Stopped-VM restart, VM spot Jobs': their own stopped
// read, and starting the VM in place, returning its new public IP, or null if
// that failed. No pool needs restart.
interface StoppedVmObservationOps {
  observeStoppedVm(cloudId: string): Promise<boolean>;
}
interface StoppedVmRestartOps {
  verifyVMPreemption(cloudId: string): Promise<boolean>;
  startVM(cloudId: string): Promise<string | null>;
}

const spotLaunchBrand: unique symbol = Symbol('SpotLaunch');
const stoppedVmObservationBrand: unique symbol = Symbol('StoppedVmObservation');
const stoppedVmRestartBrand: unique symbol = Symbol('StoppedVmRestart');

export type SpotLaunch = { readonly [spotLaunchBrand]: true };
export type StoppedVmObservation = StoppedVmObservationOps & {
  readonly [stoppedVmObservationBrand]: true;
};
type StoppedVmRestart = StoppedVmRestartOps & {
  readonly [stoppedVmRestartBrand]: true;
};
export type Preemptible = StoppedVmObservation & StoppedVmRestart;

const hasBrand = (gateway: object, brand: symbol) =>
  Boolean((gateway as Record<symbol, unknown>)[brand]);

export function canObserveStoppedVms(
  gateway: object,
): gateway is CloudCompute & StoppedVmObservation {
  return hasBrand(gateway, stoppedVmObservationBrand);
}

/** VM spot Jobs observe a stopped VM and restart it in place. */
export function isPreemptible(
  gateway: object,
): gateway is CloudCompute & Preemptible {
  return (
    canObserveStoppedVms(gateway) && hasBrand(gateway, stoppedVmRestartBrand)
  );
}

/** A Spot pool replaces a stopped VM instead of restarting it. */
export function canLaunchSpotPools(
  gateway: object,
): gateway is CloudCompute & SpotLaunch & StoppedVmObservation {
  return canObserveStoppedVms(gateway) && hasBrand(gateway, spotLaunchBrand);
}

// Optional capability: the cloud can determine whether it supports requested
// ingress before provisioning starts. prepareNetwork() remains the apply path;
// this capability is only for submit-time and runtime target filtering.
interface IngressSupportOps {
  supportsIngress(spec: IngressSpec): boolean;
  // Whether Service workloads here get a public endpoint published (DNS + TLS).
  // Omitted means yes — every cloud VM substrate publishes one.
  publishesPublicEndpoint?(): boolean;
}

const ingressSupportBrand: unique symbol = Symbol('IngressSupport');

export type IngressSupport = IngressSupportOps & {
  readonly [ingressSupportBrand]: true;
};

export function canSupportIngress(
  gateway: object,
): gateway is CloudCompute & IngressSupport {
  return Boolean((gateway as Partial<IngressSupport>)[ingressSupportBrand]);
}

// CloudStorage is branded: public storage objects must come from
// createCloudStorage(), not from structural method matching on a provider class.
export function isCloudStorage(gateway: object): gateway is CloudStorage {
  return Boolean((gateway as Partial<CloudStorage>)[cloudStorageBrand]);
}

// Optional capability: the cloud can assess exact (vmType, region) candidates
// before a provisioning attempt is spent. Only provider-native snapshots are
// cached; candidate assessments are projected on demand so their freshness can
// never outlive the snapshot that supports them.
export interface CandidateRegion {
  vmType: string;
  region: string;
  availabilityZone?: string;
}

export const CandidateRegionAvailability = {
  Verified: 'verified',
  Unknown: 'unknown',
  Unavailable: 'unavailable',
} as const;

export type CandidateRegionAvailability =
  (typeof CandidateRegionAvailability)[keyof typeof CandidateRegionAvailability];

type CandidateRegionEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

export class CandidateEligibilityExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateEligibilityExhaustedError';
  }
}

export interface CandidateRegionFilterOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

interface CandidateRegionFilterInput {
  candidates: CandidateRegion[];
  spot: boolean;
  workloadId: string;
}

export interface CandidateRegionSnapshotInput
  extends CandidateRegionFilterInput {
  signal: AbortSignal;
  deadlineAt: number;
}

/**
 * How a preflight snapshot classified each candidate. `ordered` is what
 * provisioning consumes; `verified` is only meaningful on a provider whose
 * `Verified` means live inventory rather than entitlement — see
 * `providesLiveCapacitySignal`.
 */
interface CandidateRegionClassification {
  verified: CandidateRegion[];
  unknown: CandidateRegion[];
  ordered: CandidateRegion[];
}

interface CandidateRegionFilterPublic {
  filterCandidateRegions(
    candidates: CandidateRegion[],
    spot: boolean,
    workloadId: string,
    options?: CandidateRegionFilterOptions,
  ): Promise<CandidateRegion[]>;
  classifyCandidateRegions(
    candidates: CandidateRegion[],
    spot: boolean,
    workloadId: string,
    options?: CandidateRegionFilterOptions,
  ): Promise<CandidateRegionClassification>;
  /**
   * Whether this provider's `Verified` assessment reflects capacity that
   * exists right now, rather than entitlement to ask for it. Defaults to
   * false, which is the safe direction: entitlement-based signals (a region
   * being enabled, a quota above zero, a machine type existing in the catalog)
   * do not correlate with whether a launch will succeed.
   */
  readonly providesLiveCapacitySignal: boolean;
}

const candidateRegionFilterBrand: unique symbol = Symbol(
  'CandidateRegionFilter',
);

export type CandidateRegionFilter = CandidateRegionFilterPublic & {
  readonly [candidateRegionFilterBrand]: true;
};

const CANDIDATE_AVAILABILITY_SNAPSHOT_TTL_MS = 60_000;
const CANDIDATE_AVAILABILITY_SHARED_FETCH_TIMEOUT_MS = 30_000;
const CANDIDATE_AVAILABILITY_SHARE_GRACE_MS = 5_000;
const CANDIDATE_AVAILABILITY_DEADLINE_RESERVE_MS = 2_000;
const DEFAULT_CANDIDATE_AVAILABILITY_WAIT_MS = 25_000;

export interface CandidateRegionFilterOps<
  TSnapshot,
  TAssessmentContext = undefined,
> {
  cache: CandidatePreflightCache<TSnapshot>;
  cacheKey(input: CandidateRegionFilterInput): string;
  assessLocalEligibility?(
    candidate: CandidateRegion,
  ): CandidateRegionEligibility;
  runPreflight(input: CandidateRegionSnapshotInput): Promise<TSnapshot>;
  assess(
    snapshot: TSnapshot,
    candidate: CandidateRegion,
    input: CandidateRegionFilterInput,
    assessmentContext: TAssessmentContext | undefined,
  ): CandidateRegionAvailability | undefined;
  /**
   * Capture uncached local/account state once after the cached provider read.
   * Use this when assessment combines a reusable remote sweep with a cheaper
   * independently changing signal that must not churn the remote cache key.
   */
  createAssessmentContext?(
    input: CandidateRegionFilterInput,
  ): TAssessmentContext;
  isComplete?(snapshot: TSnapshot): boolean;
  operationName?(input: CandidateRegionFilterInput): string;
  /** See CandidateRegionFilterPublic.providesLiveCapacitySignal. */
  providesLiveCapacitySignal?: boolean;
}

export function candidateRegionKey(candidate: CandidateRegion): string {
  return JSON.stringify([
    candidate.vmType,
    candidate.region,
    candidate.availabilityZone ?? null,
  ]);
}

export function exactCandidatePairsKey(
  candidates: readonly CandidateRegion[],
): string {
  return JSON.stringify(
    [...new Set(candidates.map(candidateRegionKey))].sort(),
  );
}

function uniqueCandidateRegions(
  candidates: readonly CandidateRegion[],
): CandidateRegion[] {
  const unique = new Map<string, CandidateRegion>();
  for (const candidate of candidates) {
    const key = candidateRegionKey(candidate);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function isCandidateRegionAvailability(
  value: unknown,
): value is CandidateRegionAvailability {
  return (
    value === CandidateRegionAvailability.Verified ||
    value === CandidateRegionAvailability.Unknown ||
    value === CandidateRegionAvailability.Unavailable
  );
}

async function runSharedCandidatePreflight<TSnapshot>(
  input: CandidateRegionFilterInput,
  runPreflight: (input: CandidateRegionSnapshotInput) => Promise<TSnapshot>,
): Promise<TSnapshot> {
  const controller = new AbortController();
  const deadlineAt =
    Date.now() + CANDIDATE_AVAILABILITY_SHARED_FETCH_TIMEOUT_MS;
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          'The candidate availability snapshot deadline elapsed',
          'TimeoutError',
        ),
      ),
    CANDIDATE_AVAILABILITY_SHARED_FETCH_TIMEOUT_MS,
  );
  (timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

  try {
    return await runPreflight({
      ...input,
      signal: controller.signal,
      deadlineAt,
    });
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) {
      controller.abort(
        new DOMException(
          'The candidate availability snapshot fetch finished',
          'AbortError',
        ),
      );
    }
  }
}

export function createCandidateRegionFilter<TSnapshot, TAssessmentContext>(
  ops: CandidateRegionFilterOps<TSnapshot, TAssessmentContext>,
): CandidateRegionFilter {
  const noSignal = (
    ordered: CandidateRegion[],
  ): CandidateRegionClassification => ({
    verified: [],
    unknown: ordered,
    ordered,
  });

  const filter: CandidateRegionFilterPublic = {
    providesLiveCapacitySignal: ops.providesLiveCapacitySignal ?? false,
    filterCandidateRegions: async (...args) =>
      (await filter.classifyCandidateRegions(...args)).ordered,
    classifyCandidateRegions: async (
      candidates,
      spot,
      workloadId,
      options = {},
    ) => {
      if (candidates.length === 0) return noSignal([]);

      const rejectionReasons: string[] = [];
      const eligibleCandidates = ops.assessLocalEligibility
        ? candidates.filter((candidate) => {
            const eligibility = ops.assessLocalEligibility!(candidate);
            if (eligibility.eligible) return true;
            rejectionReasons.push(eligibility.reason);
            return false;
          })
        : candidates;
      if (eligibleCandidates.length === 0) {
        throw new CandidateEligibilityExhaustedError(rejectionReasons[0]!);
      }

      const exactEligibleCandidates =
        uniqueCandidateRegions(eligibleCandidates);

      const deadlineAt =
        options.deadlineAt ??
        Date.now() + DEFAULT_CANDIDATE_AVAILABILITY_WAIT_MS;
      const waitTimeoutMs = Math.floor(
        deadlineAt - CANDIDATE_AVAILABILITY_DEADLINE_RESERVE_MS - Date.now(),
      );
      if (waitTimeoutMs <= 0 || options.signal?.aborted) {
        log.warn(
          'Candidate availability deadline exhausted — proceeding with locally eligible candidates',
          { id: workloadId },
        );
        return noSignal(eligibleCandidates);
      }

      const input = {
        candidates: exactEligibleCandidates,
        spot,
        workloadId,
      };
      const isComplete = (snapshot: TSnapshot): boolean =>
        ops.isComplete?.(snapshot) ?? true;
      const snapshot = await ops.cache.get(
        ops.cacheKey(input),
        ops.operationName?.(input) ??
          `read candidate availability snapshot for ${workloadId}`,
        () => runSharedCandidatePreflight(input, ops.runPreflight),
        {
          ttlMs: CANDIDATE_AVAILABILITY_SNAPSHOT_TTL_MS,
          maxPendingShareMs:
            CANDIDATE_AVAILABILITY_SHARED_FETCH_TIMEOUT_MS +
            CANDIDATE_AVAILABILITY_SHARE_GRACE_MS,
          waitTimeoutMs,
          signal: options.signal,
          shouldCache: (value) => value !== null && isComplete(value),
          onFailOpen: (error) => {
            log.warn(
              'Candidate availability snapshot failed or timed out — proceeding with locally eligible candidates',
              {
                id: workloadId,
                error: error,
              },
            );
          },
        },
      );
      if (snapshot === null) return noSignal(eligibleCandidates);

      let assessmentContext: TAssessmentContext | undefined;
      try {
        assessmentContext = ops.createAssessmentContext?.(input);
      } catch (error) {
        log.warn(
          'Candidate assessment context failed — continuing without it',
          { id: workloadId, error },
        );
      }

      const verified: CandidateRegion[] = [];
      const unknown: CandidateRegion[] = [];
      let unavailable = 0;
      for (const candidate of eligibleCandidates) {
        let availability: CandidateRegionAvailability =
          CandidateRegionAvailability.Unknown;
        try {
          const assessed = ops.assess(
            snapshot,
            candidate,
            input,
            assessmentContext,
          );
          if (isCandidateRegionAvailability(assessed)) {
            availability = assessed;
          }
        } catch (error) {
          log.warn(
            'Candidate availability assessment failed — treating candidate as unknown',
            {
              id: workloadId,
              vmType: candidate.vmType,
              region: candidate.region,
              error: error,
            },
          );
        }

        if (availability === CandidateRegionAvailability.Verified) {
          verified.push(candidate);
        } else if (availability === CandidateRegionAvailability.Unavailable) {
          unavailable += 1;
        } else {
          unknown.push(candidate);
        }
      }

      log.info('Candidate availability filter classified candidates', {
        id: workloadId,
        verified: verified.length,
        unknown: unknown.length,
        unavailable,
        complete: isComplete(snapshot),
      });
      return { verified, unknown, ordered: [...verified, ...unknown] };
    },
  };

  Object.defineProperty(filter, candidateRegionFilterBrand, {
    value: true,
    enumerable: false,
  });
  return filter as CandidateRegionFilter;
}

export function canFilterCandidateRegions(
  gateway: object,
): gateway is CloudCompute & CandidateRegionFilter {
  return Boolean(
    (gateway as Partial<CandidateRegionFilter>)[candidateRegionFilterBrand],
  );
}

// Optional capability: the cloud can tell a *terminal* auth failure — a
// genuinely invalid/expired/wrong stored secret that re-fails until a human
// fixes it — apart from a *transient* one (host clock skew, a stale/expired
// token), both of which its classifyError() lumps into BadCredential. Used to
// decide whether an auth failure durably marks the credential invalid
// (terminal) or follows the ordinary retry policy (transient). Clouds that
// cannot distinguish simply do not implement it, so every BadCredential is
// treated as transient.
interface TerminalAuthErrorClassifierOps {
  isTerminalAuthError(error: unknown): boolean;
}

const terminalAuthErrorClassifierBrand: unique symbol = Symbol(
  'TerminalAuthErrorClassifier',
);

export type TerminalAuthErrorClassifier = TerminalAuthErrorClassifierOps & {
  readonly [terminalAuthErrorClassifierBrand]: true;
};

export function canClassifyTerminalAuthError(
  gateway: object,
): gateway is CloudCompute & TerminalAuthErrorClassifier {
  return Boolean(
    (gateway as Partial<TerminalAuthErrorClassifier>)[
      terminalAuthErrorClassifierBrand
    ],
  );
}

type CloudComputeBuilder = {
  -readonly [Key in keyof CloudComputePublic]: CloudComputePublic[Key];
} & Partial<StoppedVmObservationOps> &
  Partial<StoppedVmRestartOps> &
  Partial<IngressSupportOps> &
  Partial<CandidateRegionFilterPublic> &
  Partial<TerminalAuthErrorClassifierOps> &
  Partial<CloudResourceComputePublic>;

export interface CloudComputeOps {
  readonly type: CloudType;
  readonly region: string;
  readonly spot?: boolean;
  readonly vmType: string;
  rawValidateCredentials(): Promise<void>;
  credentialValidationRetryPolicy?: CredentialValidationRetryPolicy;
  isCredentialValidationRetryable?(error: unknown): boolean;
  rawClassifyError(error: unknown): CloudFailureDiagnosis;
  permissionDenial?(error: unknown): PermissionDenial | undefined;
  rawAdoptProvisioningAttempt?(
    attempt: ProvisioningAttemptIdentity,
  ): Promise<GatewayVM | null>;
  rawNewVM(params: NewVMProps): Promise<GatewayVM>;
  rawRequestVMTermination(vmId: string): Promise<void>;
  rawTerminateNetworking(workloadId: string): Promise<void>;
  rawGetAllVMs(): Promise<GatewayVM[]>;
  rawUpsertFirewall(
    ipWhiteList: string[],
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<void>;
  rawPrepareNetwork?(
    spec: IngressSpec,
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<CloudNetworkHandle | undefined>;
  observeVMReleaseOnce(
    cloudId: string,
    options?: VMReleaseObservationOptions,
  ): Promise<VMReleaseObservation>;
  isPlaceholderVMId?(vmId: string): boolean;
  terminateVMsConcurrency?: number;
  // Override the post-request release poll (default: 4 attempts, 2s apart).
  releaseConfirmMaxAttempts?: number;
  releaseConfirmWaitMs?: number;
  releaseConfirmationPolicy?: VMReleaseConfirmationPolicy;
  spotLaunch?: true;
  stoppedVmObservation?: StoppedVmObservationOps;
  stoppedVmRestart?: StoppedVmRestartOps;
  ingressSupport?: IngressSupportOps;
  candidateRegionFilter?: CandidateRegionFilter;
  terminalAuthErrorClassifier?: TerminalAuthErrorClassifierOps;
  resourceScoped?: CloudResourceComputeOps;
}

/**
 * The longest a normal VM release takes, from its removal claim to its row
 * ending. AWS confirms in one pass: tagging, the Spot request cancel, the
 * terminate waiter (180 s, which resolves at its cap), then one describe that
 * counts `shutting-down` as released. Lambda's 30 × 10 s confirmation can end
 * before the instance is gone, so its bound is two such passes 30 s apart. GCP
 * and Azure confirm in one pass of no fixed length (GCP's delete operation,
 * Azure's VM, disk, NIC and IP deletes); their bound is a generous ceiling, not
 * a measurement. Cloudflare runs no VMs, and local machines stop in seconds.
 */
export const USUAL_VM_RELEASE_SECONDS: Record<CloudType, number> = {
  [CloudType.AWS]: 210,
  [CloudType.GCP]: 630,
  [CloudType.Azure]: 630,
  [CloudType.Lambda]: 630,
  [CloudType.Cloudflare]: 60,
  [CloudType.Local]: 60,
};

const DEFAULT_TERMINATE_VMS_CONCURRENCY = 20;
const DEFAULT_RELEASE_CONFIRM_MAX_ATTEMPTS = 4;
const DEFAULT_RELEASE_CONFIRM_WAIT_MS = 2_000;

export function createCloudCompute(ops: CloudComputeOps): CloudCompute {
  const releaseConfirmationPolicy = normalizeVMReleaseConfirmationPolicy(
    ops.releaseConfirmationPolicy,
  );
  const compute: CloudComputeBuilder = {
    type: ops.type,
    region: ops.region,
    spot: ops.spot,
    vmType: ops.vmType,
    releaseConfirmationPolicy,
    validateCredentials: () => ops.rawValidateCredentials(),
    credentialValidationRetryPolicy: ops.credentialValidationRetryPolicy,
    isCredentialValidationRetryable: ops.isCredentialValidationRetryable,
    classifyError: (error: unknown) => ops.rawClassifyError(error),
    permissionDenial: ops.permissionDenial,
    newVM: (params: NewVMProps) => {
      const rejection = acceleratorRuntimeRejectionMessage(
        ops.type,
        params.gpuRuntime,
      );
      if (rejection) return Promise.reject(new DeployError(rejection, 400));
      return ops.rawNewVM(params).then(resolveGatewayVM);
    },
    terminateVMs: async (
      vmIds: string[],
      onUnconfirmed?: (vmId: string, error: unknown) => void,
    ) => {
      if (vmIds.length === 0) return [];
      const results = await pAllSettledLimit(
        vmIds,
        ops.terminateVMsConcurrency ?? DEFAULT_TERMINATE_VMS_CONCURRENCY,
        async (vmId) => {
          if (ops.isPlaceholderVMId?.(vmId)) return vmId;
          await ops.rawRequestVMTermination(vmId);
          // A non-throwing rawRequestVMTermination only means the request was accepted,
          // not that the cloud confirms this vmId is gone (some providers
          // return ok without the id actually disappearing). Verify through
          // the same release check every gateway implements. If
          // it never confirms within this short bounded window, leave the vmId
          // out of the returned (deleted) list — it stays live in the DB and
          // the reconcile monitor's 5-minute retry is the real backstop.
          const confirmer = createVMReleaseConfirmer(releaseConfirmationPolicy);
          let last: VMReleaseStatus | undefined;
          try {
            await retryUntil(
              async () =>
                (last = await confirmer.observe(() =>
                  ops.observeVMReleaseOnce(vmId),
                )),
              (status) => status.state === VMReleaseState.Released,
              `confirm release of ${vmId}`,
              {
                maxAttempts:
                  ops.releaseConfirmMaxAttempts ??
                  DEFAULT_RELEASE_CONFIRM_MAX_ATTEMPTS,
                waitMs:
                  ops.releaseConfirmWaitMs ?? DEFAULT_RELEASE_CONFIRM_WAIT_MS,
              },
            );
          } catch {
            // A failed provider read is an error to report; a VM still
            // shutting down when the window ends is not.
            if (last?.state === VMReleaseState.Unknown) {
              throw new Error(last.error);
            }
            return null;
          }
          return vmId;
        },
      );
      // Dropping an unconfirmed vmId silently is what made a fleet-wide
      // teardown regression unattributable: the row stays live and the
      // workload keeps billing, with nothing recording whether the terminate
      // request was rejected or merely not yet reflected by the provider.
      vmIds.forEach((vmId, i) => {
        const result = results[i]!;
        if (result.status === 'fulfilled' && result.value !== null) return;
        // Keyed 'system' per the logger's id convention; cloudId is what joins
        // this to the deferral line completeWorkloadCleanup emits, which
        // carries the workload.
        log.warn('VM termination unconfirmed — row stays live for retry', {
          id: 'system',
          cloudId: vmId,
          provider: ops.type,
          error:
            result.status === 'rejected' ? result.reason : 'still releasing',
        });
        if (result.status === 'rejected') onUnconfirmed?.(vmId, result.reason);
      });
      return vmIds.filter((_, i) => {
        const result = results[i]!;
        return result.status === 'fulfilled' && result.value !== null;
      });
    },
    terminateNetworking: (workloadId: string) =>
      ops.rawTerminateNetworking(workloadId),
    getAllVMs: () => ops.rawGetAllVMs(),
    upsertFirewall: (
      ipWhiteList: string[],
      workloadId: string,
      version: string,
      userId: string,
    ) => ops.rawUpsertFirewall(ipWhiteList, workloadId, version, userId),
    observeVMReleaseOnce: (
      cloudId: string,
      options?: VMReleaseObservationOptions,
    ) => ops.observeVMReleaseOnce(cloudId, options),
  };

  if (ops.rawPrepareNetwork) {
    compute.prepareNetwork = (
      spec: IngressSpec,
      workloadId: string,
      version: string,
      userId: string,
    ) => ops.rawPrepareNetwork!(spec, workloadId, version, userId);
  }
  if (ops.rawAdoptProvisioningAttempt) {
    compute.adoptProvisioningAttempt = async (attempt) => {
      const vm = await ops.rawAdoptProvisioningAttempt!(attempt);
      return vm ? resolveGatewayVM(vm) : null;
    };
  }

  const brand = (key: symbol) =>
    Object.defineProperty(compute, key, { value: true, enumerable: false });
  if (ops.spotLaunch) brand(spotLaunchBrand);
  const { stoppedVmObservation, stoppedVmRestart } = ops;
  if (stoppedVmObservation) {
    compute.observeStoppedVm = (cloudId: string) =>
      stoppedVmObservation.observeStoppedVm(cloudId);
    brand(stoppedVmObservationBrand);
  }
  if (stoppedVmRestart) {
    compute.verifyVMPreemption = (cloudId: string) =>
      stoppedVmRestart.verifyVMPreemption(cloudId);
    compute.startVM = (cloudId: string) => stoppedVmRestart.startVM(cloudId);
    brand(stoppedVmRestartBrand);
  }

  if (ops.ingressSupport) {
    compute.supportsIngress = (spec: IngressSpec) =>
      ops.ingressSupport!.supportsIngress(spec);
    compute.publishesPublicEndpoint = () =>
      ops.ingressSupport!.publishesPublicEndpoint?.() ?? true;
    Object.defineProperty(compute, ingressSupportBrand, {
      value: true,
      enumerable: false,
    });
  }

  const candidateRegionFilter = ops.candidateRegionFilter;
  if (candidateRegionFilter) {
    compute.filterCandidateRegions = (candidates, spot, workloadId, options) =>
      candidateRegionFilter.filterCandidateRegions(
        candidates,
        spot,
        workloadId,
        options,
      );
    compute.classifyCandidateRegions = (
      candidates,
      spot,
      workloadId,
      options,
    ) =>
      candidateRegionFilter.classifyCandidateRegions(
        candidates,
        spot,
        workloadId,
        options,
      );
    Object.defineProperty(compute, 'providesLiveCapacitySignal', {
      value: candidateRegionFilter.providesLiveCapacitySignal,
      enumerable: false,
    });
    Object.defineProperty(compute, candidateRegionFilterBrand, {
      value: true,
      enumerable: false,
    });
  }

  if (ops.terminalAuthErrorClassifier) {
    compute.isTerminalAuthError = (error: unknown) =>
      ops.terminalAuthErrorClassifier!.isTerminalAuthError(error);
    Object.defineProperty(compute, terminalAuthErrorClassifierBrand, {
      value: true,
      enumerable: false,
    });
  }

  if (ops.resourceScoped) {
    compute.nodePoolBoot = ops.resourceScoped.nodePoolBoot;
    const poolsOnly = PROVIDER_DATA[ops.type].compute?.poolsOnly;
    const refuse = (scope: CloudResourceScope) => {
      if (poolsOnly) refuseClusterScope(ops.type, scope);
    };
    compute.prepareResourceNetwork = async (spec, scope, version) => {
      refuse(scope);
      return ops.resourceScoped!.prepareResourceNetwork(spec, scope, version);
    };
    if (ops.resourceScoped.adoptResourceProvisioningAttempt) {
      compute.adoptResourceProvisioningAttempt = async (attempt) => {
        refuse(attempt.scope);
        const vm =
          await ops.resourceScoped!.adoptResourceProvisioningAttempt!(attempt);
        return vm ? resolveGatewayVM(vm) : null;
      };
    }
    compute.newResourceVM = async (params) => {
      refuse(params.scope);
      const rejection = acceleratorRuntimeRejectionMessage(
        ops.type,
        params.gpuRuntime,
      );
      if (rejection) return Promise.reject(new DeployError(rejection, 400));
      return ops.resourceScoped!.newResourceVM(params).then(resolveGatewayVM);
    };
    if (ops.resourceScoped.listResourceVMs) {
      compute.listResourceVMs = (scope) =>
        ops.resourceScoped!.listResourceVMs!(scope);
    }
    compute.terminateResourceNetwork = (scope) =>
      ops.resourceScoped!.terminateResourceNetwork(scope);
    if (ops.resourceScoped.terminateResourceVMLeftovers) {
      compute.terminateResourceVMLeftovers = (cloudId) =>
        ops.resourceScoped!.terminateResourceVMLeftovers!(cloudId);
    }
    Object.defineProperty(compute, cloudResourceComputeBrand, {
      value: true,
      enumerable: false,
    });
  }

  Object.defineProperty(compute, cloudComputeBrand, {
    value: true,
    enumerable: false,
  });

  return compute as CloudCompute;
}
