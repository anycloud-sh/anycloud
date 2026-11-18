import {
  ScopedStoragePolicyTooLargeError,
  type ScopedStorageGrant,
  type ScopedStorageToken,
} from './cloud.js';
import { JOB_HOST_DISK_GB } from '../job-host.js';
import {
  AuthorizeSecurityGroupIngressCommand,
  CancelSpotInstanceRequestsCommand,
  CreateSecurityGroupCommand,
  CreateTagsCommand,
  DeleteNetworkInterfaceCommand,
  DeleteSecurityGroupCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  type DescribeInstancesCommandInput,
  DescribeNetworkInterfacesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSpotInstanceRequestsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  type EC2Client,
  InstanceInterruptionBehavior,
  type Instance,
  type Image,
  MarketType,
  type Reservation,
  type ResourceType,
  type SpotInstanceRequest,
  RunInstancesCommand,
  RevokeSecurityGroupIngressCommand,
  StartInstancesCommand,
  SpotInstanceType,
  TerminateInstancesCommand,
  VolumeType,
  type _InstanceType,
  type IpPermission,
} from '@aws-sdk/client-ec2';
import {
  type S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
  GetObjectCommand,
  waitUntilBucketExists,
} from '@aws-sdk/client-s3';
import {
  nestedVirtualizationSupport,
  type ResolvedCloudConfig,
} from '../../../shared/cloud-config.js';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import {
  GetCallerIdentityCommand,
  GetFederationTokenCommand,
  type GetFederationTokenCommandOutput,
} from '@aws-sdk/client-sts';
import { createWaiter, WaiterState } from '@aws-sdk/util-waiter';

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
  type StorageFailure,
} from './cloud.js';
import { AwsQuotaProvider } from '../quota/aws.js';
import {
  CloudType,
  CloudFailureDiagnosis,
  DiskTier,
  AWSCreds,
  type AWSInstanceCreds,
  type AWSRoleCreds,
  GpuRuntime,
} from '../../../shared/cloud.js';
import {
  gp3MinimumSizeGb,
  gp3VolumePerformance,
  type Gp3Performance,
} from '../../../shared/gp3-performance.js';
import {
  PermissionDeniedError,
  type PermissionDenial,
} from '../../../shared/permission-denied.js';
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
  type GatewayVM,
  type CloudNetworkHandle,
  type CloudResourceScope,
  type ResourceVM,
  type IngressSpec,
  type NewVMProps,
  type ProvisioningAttemptIdentity,
} from '../entities.js';
import {
  BucketAccessDeniedError,
  BucketNameTakenError,
  DeployError,
  InvalidAnycloudConfigError,
  ResourceStateIndeterminateError,
} from '../../../shared/errors.js';
import { NEURON_RUNTIME_UNSUPPORTED_MESSAGE } from '../../../shared/providers.js';
import { log } from '../logger.js';
import { memoizeAsync, retryUntil, withRetry } from '../../../shared/utils.js';
import { buildJobIngressSpec, hasHttpIngress } from '../network.js';
import { numericRulePort, resolveFirewallPlan } from '../firewall-plan.js';

const AWS_FIREWALL_TRAITS = {
  emitsScopeDeny: false,
  splitsSourceRangesByIpFamily: false,
} as const;
import { CandidatePreflightCache } from '../candidate-preflight-cache.js';
import { OWNER_API_TAG, getApiIdentity } from '../api-identity.js';
import { storageCoordinationKey } from './storage-coordinator.js';
import {
  VMRestartAttempt,
  VM_RESTART_CONSECUTIVE_OBSERVATIONS,
} from './vm-restart.js';
import { VMCreationError } from '../codes.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  assumeAwsRole,
  awsClientCredentials,
  awsShortRoleSessionMessage,
  type AwsClientCredentials,
  createAwsEc2Client,
  createAwsGatewayClients,
  createAwsS3Client,
  createAwsStsClient,
} from '../provider-clients/aws.js';

/**
 * Shared security-group names. New workloads use the VM SG (SSH only). The
 * retired server SG name stays in the guard set so legacy shared resources are
 * not reaped accidentally.
 */
export const AWS_SHARED_VM_SG_NAME = 'anycloud-vm';
export const AWS_SHARED_SERVICE_SG_NAME = 'anycloud-server';
const AWS_BUCKET_CREATION_READINESS_MAX_WAIT_SECONDS = 30;
const AWS_SHARED_SG_NAMES = new Set<string>([
  AWS_SHARED_VM_SG_NAME,
  AWS_SHARED_SERVICE_SG_NAME,
]);

interface AwsCandidateAvailabilitySnapshot {
  enabled: Set<string>;
  zeroByVmType: Map<string, Set<string>>;
  unknownByVmType: Map<string, Set<string>>;
  complete: boolean;
}

const awsCandidatePreflightCache =
  new CandidatePreflightCache<AwsCandidateAvailabilitySnapshot>();

/** Test-only: clear the process-wide AWS candidate preflight cache. */
export function resetAwsCandidatePreflightCache(): void {
  awsCandidatePreflightCache.clear();
}

/**
 * A newly created access key is rejected until AWS propagates it: S3 says
 * InvalidAccessKeyId and STS says InvalidClientTokenId. Retry only that, with
 * at most 23s of backoff.
 */
const FRESH_KEY_RETRY = {
  maxAttempts: 6,
  waitMs: 1_000,
  maxWaitMs: 8_000,
  jitter: false,
  shouldRetry: (error: unknown) =>
    awsErrorCode(error) === 'InvalidClientTokenId',
} as const;
const CANCELABLE_SPOT_REQUEST_STATES = ['open', 'active', 'disabled'];

export interface ResolvedAwsAmi {
  imageId: string;
  rootDeviceName: string;
  rootVolumeSizeGb: number;
}

interface AwsBootDisk {
  VolumeSize?: number;
  Iops?: number;
  Throughput?: number;
}

function bootDiskFor(
  diskTier: DiskTier | undefined,
  requestedSizeGb: number | undefined,
  ami: ResolvedAwsAmi,
  minimumDefaultSizeGb = 0,
  own: Gp3Performance = {},
): AwsBootDisk {
  // A VM Job's own IOPS and MiB/s override its tier's.
  const performance = gp3VolumePerformance(diskTier, own);
  const performanceMinimumSizeGb =
    performance.Iops === undefined ? 0 : gp3MinimumSizeGb(performance.Iops);
  const minimumSizeGb = Math.max(
    ami.rootVolumeSizeGb,
    performanceMinimumSizeGb,
  );
  // A Job's own IOPS never grow its root: that would change its cost.
  if (
    own.diskIops !== undefined &&
    requestedSizeGb === undefined &&
    performanceMinimumSizeGb >
      Math.max(ami.rootVolumeSizeGb, minimumDefaultSizeGb)
  ) {
    throw new InvalidAnycloudConfigError(
      `${own.diskIops} IOPS needs a root volume of at least ${performanceMinimumSizeGb} GiB (500 IOPS per GiB); pass --disk-size ${performanceMinimumSizeGb} or more`,
    );
  }

  if (requestedSizeGb !== undefined && requestedSizeGb < minimumSizeGb) {
    throw new InvalidAnycloudConfigError(
      `AWS --disk-size must be at least ${minimumSizeGb} GB for AMI ` +
        `"${ami.imageId}" with ${
          own.diskIops !== undefined
            ? `--disk-iops ${own.diskIops}`
            : `--disk-tier ${diskTier ?? DiskTier.Medium}`
        } ` +
        `(got ${requestedSizeGb} GB).`,
    );
  }

  const defaultSizeGb = Math.max(
    performanceMinimumSizeGb,
    minimumDefaultSizeGb,
  );
  return {
    ...performance,
    ...(requestedSizeGb !== undefined
      ? { VolumeSize: requestedSizeGb }
      : defaultSizeGb > ami.rootVolumeSizeGb
        ? { VolumeSize: defaultSizeGb }
        : {}),
  };
}

function resolveAmiMetadata(
  image: Image,
  description: string,
  region: string,
): ResolvedAwsAmi {
  if (!image.ImageId) {
    throw new Error(
      `Found ${description} AMI in region ${region} but ImageId is missing`,
    );
  }
  const rootDeviceName = image.RootDeviceName;
  const rootVolumeSizeGb = image.BlockDeviceMappings?.find(
    (mapping) => mapping.DeviceName === rootDeviceName,
  )?.Ebs?.VolumeSize;
  if (!rootDeviceName || !rootVolumeSizeGb) {
    throw new Error(
      `Found ${description} AMI ${image.ImageId} in region ${region} but root disk metadata is missing`,
    );
  }

  return {
    imageId: image.ImageId,
    rootDeviceName,
    rootVolumeSizeGb,
  };
}

/** AWS implementation of the provider-neutral base-image lookup capability. */
export function createAwsBaseImageResolver(
  ec2client: EC2Client,
  region: string,
): CloudBaseImageResolver<ResolvedAwsAmi> {
  return createCloudBaseImageResolver({
    type: CloudType.AWS,
    rawResolveBaseImage: async ({ gpuRuntime, minimal }) => {
      // No NVIDIA base image fits AMD, Neuron, or an accelerator anycloud can't
      // yet image — fail clearly instead of silently booting the CUDA image.
      if (gpuRuntime === GpuRuntime.Rocm) {
        throw new DeployError(
          'AMD (ROCm) GPUs are not supported on AWS yet — anycloud has no ROCm base image for this instance type.',
          400,
        );
      }
      if (gpuRuntime === GpuRuntime.Neuron) {
        throw new DeployError(NEURON_RUNTIME_UNSUPPORTED_MESSAGE, 400);
      }
      if (gpuRuntime === GpuRuntime.Unsupported) {
        throw new DeployError(
          'This accelerator is recognized but not supported on AWS yet — anycloud has no compatible base image for it.',
          400,
        );
      }

      if (gpuRuntime === GpuRuntime.Cuda) {
        const gpuAmiType =
          'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*';
        const gpuAmiTypeRegex =
          /^Deep Learning Base OSS Nvidia Driver GPU AMI \(Ubuntu 24\.04\) [0-9]{8}$/;
        const output = await ec2client.send(
          new DescribeImagesCommand({
            Owners: ['amazon'],
            Filters: [{ Name: 'name', Values: [gpuAmiType] }],
          }),
        );
        const matchingImages = (output.Images ?? [])
          .filter((image) => image.Name?.match(gpuAmiTypeRegex))
          .sort((a, b) =>
            (a.CreationDate ?? '').localeCompare(b.CreationDate ?? ''),
          );
        if (matchingImages.length === 0) {
          throw new Error(
            `No GPU AMI found in region ${region}. The AWS Deep Learning AMI may not be available in this region. Try a different region or use a non-GPU instance.`,
          );
        }
        return resolveAmiMetadata(
          matchingImages[matchingImages.length - 1],
          'GPU',
          region,
        );
      }

      // Noble publishes gp3-rooted hvm-ssd-gp3 images. Keep the wildcard and
      // optional suffix so the lookup also tolerates the older naming shape.
      // service-terminology-ok: Canonical's AMI names say `server`
      const [prefix, kind] = minimal
        ? ['ubuntu-minimal', 'minimal']
        : ['ubuntu', 'server'];
      const amiType = `${prefix}/images/hvm-ssd*/ubuntu-noble-24.04-amd64-${kind}-*`;
      const amiTypeRegex = new RegExp(
        `${prefix}/images/hvm-ssd(-gp3)?/ubuntu-noble-24\\.04-amd64-${kind}-[0-9]{8}(\\.[0-9]+)?$`,
      );
      const output = await ec2client.send(
        new DescribeImagesCommand({
          Owners: ['099720109477'],
          Filters: [
            { Name: 'name', Values: [amiType] },
            { Name: 'state', Values: ['available'] },
            { Name: 'architecture', Values: ['x86_64'] },
          ],
        }),
      );
      const matchingImages = (output.Images ?? [])
        .filter((image) => image.Name?.match(amiTypeRegex))
        .sort((a, b) =>
          (a.CreationDate ?? '').localeCompare(b.CreationDate ?? ''),
        );
      if (matchingImages.length === 0) {
        throw new Error(
          `No Ubuntu 24.04 LTS AMI found in region ${region}. This is unexpected - please verify your AWS configuration.`,
        );
      }
      return resolveAmiMetadata(
        matchingImages[matchingImages.length - 1],
        'Ubuntu',
        region,
      );
    },
  });
}

/** Check if AWS error means resource is already deleted */
export const isAWSNotFound = (error: any): boolean =>
  error.name === 'ResourceNotFoundException' ||
  error.Code === 'InvalidInstanceID.NotFound' ||
  error.name === 'InvalidInstanceID.NotFound' ||
  error.Code === 'InvalidGroup.NotFound' ||
  error.name === 'InvalidGroup.NotFound' ||
  error.Code === 'InvalidAMIID.NotFound' ||
  error.name === 'InvalidAMIID.NotFound' ||
  error.$metadata?.httpStatusCode === 404;

/**
 * Match an AWS error by its service code, robust to AWS SDK v3 surfacing it as
 * either a modeled exception (`name: 'XException'`) or the schema-based base
 * error (`name: 'Error'` with the wire code in `Code`/`code`). A narrow
 * `name === 'XException'` check silently missed the latter and broke the
 * fresh-account IAM bootstrap — see aws-sad.spec.ts for the real-SDK contract.
 */
const isAWSErrorCode = (error: any, code: string): boolean =>
  error?.name === code ||
  error?.name === `${code}Exception` ||
  error?.Code === code ||
  error?.code === code;

function isAwsRestartRetryable(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
  return (
    isTransientTransportError(error) ||
    status === 429 ||
    (status !== undefined && status >= 500 && status < 600) ||
    [
      'IncorrectSpotRequestState',
      'IncorrectInstanceState',
      'InsufficientInstanceCapacity',
      'RequestLimitExceeded',
      'Throttling',
    ].some((code) => isAWSErrorCode(error, code))
  );
}

function awsErrorCode(error: any): string | undefined {
  return error?.Code ?? error?.code ?? error?.name;
}

function awsErrorMessage(error: any): string {
  return `${error?.message ?? ''} ${error?.Message ?? ''}`.trim();
}

/**
 * A denial of an authenticated key, naming the action as AWS does: "… is not
 * authorized to perform: ec2:RunInstances …". EC2's UnauthorizedOperation is
 * regional: an admin policy can limit EC2 to some regions
 * (aws:RequestedRegion). Its opt-in variant is a region the account has not
 * enabled, not a denial.
 */
function awsPermissionDenial(error: unknown): PermissionDenial | undefined {
  const code = awsErrorCode(error);
  const message = awsErrorMessage(error);
  const regional =
    code === 'UnauthorizedOperation' && !/opt.?in/i.test(message);
  const denied =
    regional || code === 'AccessDenied' || code === 'AccessDeniedException';
  if (!denied) return undefined;
  const action =
    message.match(/not authorized to perform:\s*([\w-]+:[\w*-]+)/)?.[1] ?? null;
  return { action, regional };
}

function isS3NotFound(error: any): boolean {
  return (
    isAWSErrorCode(error, 'NoSuchBucket') ||
    error?.name === 'NotFound' ||
    error?.$metadata?.httpStatusCode === 404
  );
}

/**
 * From S3's status and error code only. A key S3 cannot confirm absent
 * without ListBucket is AccessDenied, so it reads as denied, not missing.
 */
function classifyS3Failure(error: unknown): StorageFailure | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
  const code = awsErrorCode(error) ?? `HTTP ${status}`;
  if (isAWSErrorCode(error, 'NoSuchBucket')) {
    return { kind: 'bucket-missing', code };
  }
  if (isAWSErrorCode(error, 'NoSuchKey')) {
    return { kind: 'object-missing', code };
  }
  if (status === 403 || isAWSErrorCode(error, 'ExpiredToken')) {
    return { kind: 'denied', code };
  }
  if (status === 429 || isAWSErrorCode(error, 'SlowDown')) {
    return { kind: 'throttled', code };
  }
  return undefined;
}

function normalizeBucketRegion(region: string | null | undefined): string {
  if (!region) return 'us-east-1';
  if (region === 'EU') return 'eu-west-1';
  return region;
}

function isS3BucketRegionRetryError(error: any): boolean {
  const code = awsErrorCode(error);
  const message = awsErrorMessage(error);
  const httpStatus = error?.$metadata?.httpStatusCode ?? error?.statusCode;
  if (httpStatus === 301) return true;
  if (
    code === 'PermanentRedirect' ||
    code === 'IllegalLocationConstraintException'
  ) {
    return true;
  }
  return (
    httpStatus === 400 &&
    (code === 'Unknown' ||
      code === 'UnknownError' ||
      (code === 'Error' && message.trim() === 'Unknown'))
  );
}

// ---------------------------------------------------------------------------
// Scoped storage credentials (ScopedStorageTokenMinter capability).
//
// The rule: storage creds on a provisioned box are minted, scoped to one
// bucket, and short-lived; a long-lived storage key is never baked anywhere.
// AWS VMs carry no instance identity, so every AWS bucket, same-account or
// cross-cloud, syncs with one of these. A key mints with STS
// GetFederationToken, which needs a long-term IAM-user key (the API refuses to
// save session credentials); a role connection mints with
// AssumeRoleWithWebIdentity (RFC 0047 amendment 8).
// ---------------------------------------------------------------------------

// Every AWS bucket token lasts at most 12 hours, for both connection kinds
// (RFC 0047 amendment 10). Running VM-host Jobs and Services renew against
// the actual expiration; VM finalization remints before its final copy.
// Native runtimes still require resubmission after expiry.
export const SCOPED_STORAGE_CRED_TTL_SECONDS = 43_200;
const AWS_SESSION_POLICY_MAX_CHARS = 2_048;

// A denied mint is a PermissionDeniedError: the Job may run on another cloud.
const USER_ACTIONABLE_STS_ERROR_CODES = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidAccessKeyId',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'InvalidToken',
  'InvalidTokenException',
  'SignatureDoesNotMatch',
  'UnrecognizedClientException',
  // The role does not trust the API's ServiceAccount token.
  'InvalidIdentityTokenException',
  'IDPRejectedClaimException',
]);

function isUserActionableStsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: unknown; code?: unknown; Code?: unknown };
  const candidates = [err.name, err.code, err.Code].filter(
    (v): v is string => typeof v === 'string',
  );
  return candidates.some((code) => USER_ACTIONABLE_STS_ERROR_CODES.has(code));
}

// Least-privilege S3 policy statements for one grant; effective perms are the
// intersection of the IAM user's own policy and these. 'read' = sync-down only;
// 'readwrite' adds Put and Delete, or with `noDelete` Put and aborting rclone's
// own unfinished multipart uploads, since a Put overwrites without Delete. A
// prefix limits the objects and, through `s3:prefix`, the listing (RFC 0043).
function s3BucketStatements({
  bucket,
  prefix,
  mode,
  noDelete,
}: ScopedStorageGrant) {
  const Action = ['s3:GetObject'];
  if (mode === 'readwrite') {
    Action.push(
      's3:PutObject',
      noDelete ? 's3:AbortMultipartUpload' : 's3:DeleteObject',
    );
  }
  return [
    prefix
      ? {
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: `arn:aws:s3:::${bucket}`,
          Condition: { StringLike: { 's3:prefix': [prefix, `${prefix}*`] } },
        }
      : {
          Effect: 'Allow',
          Action: ['s3:ListBucket', 's3:GetBucketLocation'],
          Resource: `arn:aws:s3:::${bucket}`,
        },
    {
      Effect: 'Allow',
      Action,
      Resource: `arn:aws:s3:::${bucket}/${prefix ?? ''}*`,
    },
  ];
}

// Mint a token for the given inline session policy, ≤12h. For a key, the
// caller must validate that it is a long-term IAM-user key first.
async function mintScopedS3Token(
  source: AWSCreds | AWSRoleCreds,
  region: string | undefined,
  grants: ScopedStorageGrant[],
  lifetimeMs?: number,
): Promise<ScopedStorageToken> {
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: grants.flatMap(s3BucketStatements),
  });
  if (policy.length > AWS_SESSION_POLICY_MAX_CHARS)
    throw new ScopedStoragePolicyTooLargeError(policy.length);
  // STS takes 900 s up to the 12 h cap.
  const durationSeconds = Math.min(
    Math.max(Math.round((lifetimeMs ?? Infinity) / 1000), 900),
    SCOPED_STORAGE_CRED_TTL_SECONDS,
  );
  const options = { region: region ?? 'us-east-1' };
  let c: GetFederationTokenCommandOutput['Credentials'];
  try {
    c =
      'kind' in source
        ? await assumeAwsRole(
            source,
            {
              // CloudTrail names each session after its grants, the first
              // first so truncation keeps it. A caller's
              // prefix may hold `/` and more, which STS's
              // `[\w+=,.@-]` refuses, so those become `-`.
              sessionName: `anycloud-${grants
                .map(({ bucket, prefix }) =>
                  prefix ? `${prefix.slice(0, -1)}@${bucket}` : bucket,
                )
                .join(',')}`
                .replace(/[^\w+=,.@-]/gu, '-')
                .slice(0, 64),
              durationSeconds,
              policy,
            },
            options,
          ).then(
            ({ accessKeyId, secretAccessKey, sessionToken, expiresAt }) => ({
              AccessKeyId: accessKeyId,
              SecretAccessKey: secretAccessKey,
              SessionToken: sessionToken,
              Expiration: new Date(expiresAt),
            }),
          )
        : (
            await createAwsStsClient(
              {
                accessKeyId: source.accessKeyId,
                secretAccessKey: source.secretAccessKey,
              },
              options,
            ).send(
              new GetFederationTokenCommand({
                Name: 'anycloud-bucket-sync',
                DurationSeconds: durationSeconds,
                Policy: policy,
              }),
            )
          ).Credentials;
  } catch (error) {
    const denial = awsPermissionDenial(error);
    if (denial)
      throw new PermissionDeniedError(CloudType.AWS, denial.action, error);
    // Renewal would otherwise retry a role the owner must change.
    const shortSession =
      'kind' in source && awsShortRoleSessionMessage(source.roleArn, error);
    if (shortSession) throw new DeployError(shortSession, 400);
    if (isUserActionableStsError(error)) {
      const message = errorMessage(error);
      throw new DeployError(
        `Failed to mint scoped S3 credentials with STS: ${message}`,
        400,
      );
    }
    throw error;
  }

  const expiresAt = c?.Expiration?.getTime();
  if (
    !c?.AccessKeyId ||
    !c.SecretAccessKey ||
    !c.SessionToken ||
    !Number.isFinite(expiresAt)
  ) {
    throw new Error(
      'STS returned incomplete credentials for a scoped S3 token',
    );
  }

  return {
    credentials: {
      cloudProvider: CloudType.AWS,
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
    expiresAt: expiresAt!,
  };
}

export class AWS {
  ec2client: EC2Client; // Public for testing
  s3client: S3Client; // Public for testing
  vmType: string;
  type: CloudType;
  region: string;
  spot?: boolean;
  diskSizeGb?: number;
  minimumDiskSizeGb?: number;
  diskTier?: DiskTier;
  private readonly gp3: Gp3Performance;
  // Memoized shared security groups, keyed by GroupName. Each shared SG is
  // created/looked-up once per gateway instance and reused by every VM.
  private sharedSecurityGroupReady = new Map<string, Promise<string>>();
  // Raw AWS storage creds, retained only for minting scoped cross-cloud sync
  // tokens exposed through the branded CloudStorage capability. The SDK clients
  // sign with `credentials`, built from them.
  private storageCreds: AWSCreds | AWSRoleCreds | AWSInstanceCreds;
  private credentials: AwsClientCredentials;
  // The key or role that identifies this account's credential.
  private credentialIdentity: string;
  private storageCoordinationPrefix: string;
  private computeProvider?: CloudCompute;
  private storageProvider?: CloudStorage;
  private sweeperProvider?: CloudResourceSweeper;
  private apiOwnershipProvider?: CloudApiOwnership;
  constructor(awsConfig: ResolvedCloudConfig) {
    this.type = CloudType.AWS;
    // vmType is collapsed to a scalar by completeCloudConfig before construction.
    this.vmType = Array.isArray(awsConfig.vmType)
      ? (awsConfig.vmType[0] ?? '')
      : (awsConfig.vmType ?? '');
    this.region = awsConfig.region ?? '';

    // Configure aggressive retries for transient errors (throttling, timeouts, etc.)
    const creds = awsConfig.credentials as
      | AWSCreds
      | AWSRoleCreds
      | AWSInstanceCreds;
    this.storageCreds = creds;
    this.credentials = awsClientCredentials(creds);
    // The management VM's identity is the account's one instance profile here.
    this.credentialIdentity = !('kind' in creds)
      ? creds.accessKeyId
      : creds.kind === 'instance'
        ? 'instance'
        : creds.roleArn;
    this.storageCoordinationPrefix = storageCoordinationKey([
      'aws',
      this.credentialIdentity,
    ]);
    const clientOptions = {
      region: awsConfig.region,
      maxAttempts: 10, // Retry up to 10 times (AWS SDK uses exponential backoff by default)
    };
    const clients = createAwsGatewayClients(this.credentials, clientOptions);
    this.ec2client = clients.ec2;
    this.s3client = clients.s3;
    this.spot = awsConfig.spot;
    this.diskSizeGb = awsConfig.diskSizeGb;
    this.minimumDiskSizeGb = awsConfig.minimumDiskSizeGb;
    this.diskTier = awsConfig.diskTier;
    this.gp3 = {
      diskIops: awsConfig.diskIops,
      diskThroughputMibps: awsConfig.diskThroughputMibps,
    };
  }

  compute(): CloudCompute {
    this.computeProvider ??= createCloudCompute({
      type: this.type,
      region: this.region,
      spot: this.spot,
      vmType: this.vmType,
      rawValidateCredentials: () => this.validateCredentials(),
      rawClassifyError: (error) => this.classifyError(error),
      permissionDenial: (error) => awsPermissionDenial(error),
      rawAdoptProvisioningAttempt: (attempt) =>
        this.adoptProvisioningAttempt(attempt),
      rawNewVM: (params) => this.newVM(params),
      rawRequestVMTermination: (vmId) => this.terminateVM(vmId),
      // Jobs and Services attach the shared security group; they own no AWS networking.
      rawTerminateNetworking: async () => undefined,
      rawGetAllVMs: () => this.getAllVMs(),
      rawUpsertFirewall: (ipWhiteList, workloadId, version, userId) =>
        this.upsertFirewall(ipWhiteList, workloadId, version, userId),
      rawPrepareNetwork: (spec, workloadId, version, userId) =>
        this.prepareNetwork(spec, workloadId, version, userId),
      observeVMReleaseOnce: (cloudId, options) =>
        this.observeVMReleaseOnce(cloudId, options),
      isPlaceholderVMId: (vmId) => !vmId.startsWith('i-'),
      spotLaunch: true,
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
        adoptResourceProvisioningAttempt: ({ scope, ...attempt }) =>
          this.adoptProvisioningAttempt({
            ...attempt,
            workloadId: scope.id,
            userId: scope.tags.anycloud_user ?? 'unknown',
            resourceScope: scope,
          }),
        newResourceVM: ({ scope, ...params }) =>
          this.newVM({
            ...params,
            workloadId: scope.id,
            userId: scope.tags.anycloud_user ?? 'unknown',
            resourceScope: scope,
          }),
        listResourceVMs: (scope) => this.listResourceVMs(scope),
        terminateResourceNetwork: (scope) => this.removeFirewalls(scope.id),
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
      rawSweepLocations: async () => [
        ...(await new AwsQuotaProvider(this.credentials).getEnabledRegions()),
      ],
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
      rawGetBucketRegion: (bucketName) => this.getBucketRegion(bucketName),
      rawGetBucketVersioning: async (bucketName) =>
        (
          await this.s3client.send(
            new GetBucketVersioningCommand({ Bucket: bucketName }),
          )
        ).Status === 'Enabled'
          ? 'enabled'
          : 'disabled',
      rawEnableBucketVersioning: async (bucketName) => {
        await (
          await this.getS3ClientForBucket(bucketName)
        ).send(
          new PutBucketVersioningCommand({
            Bucket: bucketName,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        );
      },
      rawBucketCoordinationKey: (bucketName) =>
        this.bucketCoordinationKey(bucketName),
      rawHasBucket: (bucketName) => this.hasBucketUncoordinated(bucketName),
      rawUpsertBucketUncoordinated: (bucketName, version, workloadId, userId) =>
        this.upsertBucketUncoordinated(bucketName, version, workloadId, userId),
      rawCreateOwnedBucket: (bucketName, version, workloadId, userId) =>
        this.createOwnedBucket(bucketName, version, workloadId, userId),
      rawDeleteBucket: (bucketName) => this.deleteBucket(bucketName),
      rawDeleteObject: (bucketName, remotePath) =>
        this.deleteObject(bucketName, remotePath),
      rawUploadObject: ({ bucketName, remotePath, source }) =>
        this.uploadObject(bucketName, remotePath, source),
      rawDownloadObject: (bucketName, remotePath) =>
        this.downloadObject(bucketName, remotePath),
      rawListBuckets: (options, signal) => this.listBuckets(options, signal),
      rawListObjects: (bucketName, options, signal) =>
        this.listObjects(bucketName, options, signal),
      isNotFound: isS3NotFound,
      classifyStorageFailure: async (error) => classifyS3Failure(error),
      validateScopedStorageTokenSource: () =>
        this.validateScopedStorageTokenSource(),
      mintScopedStorageToken: (grants, options) =>
        this.mintScopedStorageToken(grants, options),
    });
    return this.storageProvider;
  }

  /**
   * Generate resource tags in AWS format
   */
  private getResourceTags(
    workloadId: string,
    version: string,
    userId: string,
    endedAt?: number,
    resourceScope?: CloudResourceScope,
  ): { Key: string; Value: string }[] {
    const tags = resourceScope
      ? Object.entries({
          ...resourceScope.tags,
          anycloud_resource: resourceScope.id,
          anycloud_version: version,
          [OWNER_API_TAG]: getApiIdentity(),
        }).map(([Key, Value]) => ({ Key, Value }))
      : [
          { Key: 'anycloud_deployment', Value: workloadId },
          { Key: 'anycloud_version', Value: version },
          { Key: 'anycloud_user', Value: userId },
          { Key: OWNER_API_TAG, Value: getApiIdentity() },
          // Note: anycloud_created_at intentionally omitted from tags to ensure idempotency
          // when retrying VM creation with the same ClientToken. AWS automatically tracks
          // LaunchTime anyway. Including Date.now() here would cause IdempotentParameterMismatch
          // errors on retries since the timestamp changes between attempts.
        ];
    if (endedAt !== undefined) {
      tags.push({ Key: 'anycloud_ended_at', Value: endedAt.toString() });
    }
    return tags;
  }

  private async backfillExactVmApiOwnership(
    target: ExactVmApiOwnership,
  ): Promise<ApiOwnershipBackfillResult> {
    let instance: Instance | undefined;
    try {
      const response = await this.ec2client.send(
        new DescribeInstancesCommand({ InstanceIds: [target.cloudId] }),
      );
      instance = response.Reservations?.flatMap(
        (reservation) => reservation.Instances ?? [],
      )[0];
    } catch (error) {
      if (isAWSNotFound(error)) {
        return ApiOwnershipBackfillResult.Missing;
      }
      throw error;
    }
    if (!instance) return ApiOwnershipBackfillResult.Missing;

    const tags = Object.fromEntries(
      (instance.Tags ?? []).flatMap((tag) =>
        tag.Key && tag.Value !== undefined ? [[tag.Key, tag.Value]] : [],
      ),
    );
    const decision = apiOwnershipTagDecision(tags, target);
    if (decision === 'already-owned') {
      return ApiOwnershipBackfillResult.AlreadyOwned;
    }
    await this.ec2client.send(
      new CreateTagsCommand({
        Resources: [target.cloudId],
        Tags: [{ Key: OWNER_API_TAG, Value: target.apiIdentity }],
      }),
    );
    return ApiOwnershipBackfillResult.Updated;
  }

  /**
   * Scope-tagged instances that still exist in any enabled region (a restore
   * may run in another region than the lost cluster); shutting-down counts as
   * released. One region that cannot be read fails the whole lookup.
   */
  private async listResourceVMs(
    scope: CloudResourceScope,
  ): Promise<ResourceVM[]> {
    const regions = await new AwsQuotaProvider(
      this.credentials,
    ).getEnabledRegions();
    const found = await Promise.all(
      [...regions].map((region) =>
        this.listRegionResourceVMs(
          createAwsEc2Client(this.credentials, { region, maxAttempts: 10 }),
          scope,
        ),
      ),
    );
    return found.flat();
  }

  private async listRegionResourceVMs(
    client: EC2Client,
    scope: CloudResourceScope,
  ): Promise<ResourceVM[]> {
    const vms: ResourceVM[] = [];
    let NextToken: string | undefined;
    do {
      const page = await client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:anycloud_resource', Values: [scope.id] },
            {
              Name: 'instance-state-name',
              Values: ['pending', 'running', 'stopping', 'stopped'],
            },
          ],
          NextToken,
        }),
      );
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (!instance.InstanceId) continue;
          vms.push({
            id: instance.InstanceId,
            stopped: instance.State?.Name === 'stopped',
          });
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return vms;
  }

  private async findRecoverableInstanceByClientToken(vmId: string) {
    try {
      const result = await this.ec2client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'client-token', Values: [vmId] },
            {
              Name: 'instance-state-name',
              Values: [
                'pending',
                'running',
                'stopping',
                'stopped',
                'shutting-down',
              ],
            },
          ],
        }),
      );
      const instances =
        result.Reservations?.flatMap(
          (reservation) => reservation.Instances ?? [],
        ) ?? [];
      if (instances.length > 1) {
        throw new ResourceStateIndeterminateError(
          `Could not select one EC2 resource for provisioning attempt ${vmId}`,
          new Error(`found ${instances.length} matching instances`),
        );
      }
      return instances[0];
    } catch (error) {
      if (error instanceof ResourceStateIndeterminateError) throw error;
      throw new ResourceStateIndeterminateError(
        `Could not inspect EC2 provisioning attempt ${vmId}`,
        error,
      );
    }
  }

  private async connectToProvisioningInstance(
    instance: Instance | undefined,
    fallbackImageId?: string,
  ): Promise<GatewayVM> {
    const instanceId = instance?.InstanceId;
    if (!instanceId) {
      throw new Error('EC2 launch did not return an instance ID');
    }
    const state = instance.State?.Name;
    if (
      state === 'stopping' ||
      state === 'stopped' ||
      state === 'shutting-down'
    ) {
      throw new VMCreationError(
        new Error(
          `EC2 provisioning attempt ${instanceId} is ${state}; cleanup must finish before retry`,
        ),
        [instanceId],
      );
    }

    try {
      const input = new DescribeInstancesCommand({
        InstanceIds: [instanceId],
      });
      await createWaiter<EC2Client, DescribeInstancesCommand>(
        {
          client: this.ec2client,
          // all in seconds
          maxWaitTime: 180,
          minDelay: 1,
          maxDelay: 4,
        },
        input,
        async (client, cmd) => {
          try {
            const data = await client.send(cmd);
            for (const reservation of data.Reservations ?? []) {
              for (const candidate of reservation.Instances ?? []) {
                if (candidate.PublicIpAddress === undefined)
                  return { state: WaiterState.RETRY };
              }
            }
            return { state: WaiterState.SUCCESS };
          } catch (e: any) {
            if (e.Code === 'InvalidInstanceID.NotFound')
              return { state: WaiterState.RETRY };
            throw e;
          }
        },
      );
      const data = await this.ec2client.send(input);
      const resolved = data.Reservations?.flatMap(
        (reservation) => reservation.Instances ?? [],
      )[0];
      if (!resolved?.PublicIpAddress) {
        throw new Error(`EC2 instance ${instanceId} did not become reachable`);
      }
      return {
        cloudId: instanceId,
        ip: resolved.PublicIpAddress,
        privateIp: resolved.PrivateIpAddress,
        baseImageId: resolved.ImageId ?? fallbackImageId,
        ...(resolved.LaunchTime instanceof Date &&
        Number.isFinite(resolved.LaunchTime.getTime())
          ? { createdAt: resolved.LaunchTime.getTime() }
          : {}),
        // Extract just the zone suffix (e.g., "a" from "us-east-1a") to match Azure/GCP pattern
        availabilityZone:
          resolved.Placement?.AvailabilityZone?.split('-').pop(),
      };
    } catch (error) {
      if (error instanceof VMCreationError) throw error;
      throw new VMCreationError(
        error instanceof Error ? error : new Error(String(error)),
        [instanceId],
      );
    }
  }

  private async adoptProvisioningAttempt(
    attempt: ProvisioningAttemptIdentity,
  ): Promise<GatewayVM | null> {
    const existing = await this.findRecoverableInstanceByClientToken(
      attempt.vmId,
    );
    if (!existing) return null;
    log.info('Adopting existing EC2 provisioning attempt', {
      vmId: attempt.vmId,
      workloadId: attempt.workloadId,
      instanceId: existing.InstanceId,
      state: existing.State?.Name,
    });
    return this.connectToProvisioningInstance(existing);
  }

  private async newVM(params: NewVMProps): Promise<GatewayVM> {
    const { startupScript, vmId, workloadId, gpuRuntime, version, userId } =
      params;

    const resolvedAmi = await this.resolveAmi(gpuRuntime, params.jobHost);
    const bootDisk = bootDiskFor(
      this.diskTier,
      this.diskSizeGb,
      resolvedAmi,
      params.jobHost
        ? Math.max(JOB_HOST_DISK_GB, this.minimumDiskSizeGb ?? 0)
        : this.minimumDiskSizeGb,
      this.gp3,
    );
    // Attach the shared anycloud security group prepared for this network
    // intent. It lives in the default VPC — the same VPC AWS auto-selects a
    // subnet from when no SubnetId is given — so SG and subnet always match.
    const securityGroupId =
      params.network?.securityGroupId ??
      (await this.ensureSharedSecurityGroup());
    const launchParams = {
      ImageId: resolvedAmi.imageId,
      InstanceType: this.vmType as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [securityGroupId],
      // The catalog publisher records EC2's per-region processor features, so
      // launches need no ec2:DescribeInstanceTypes grant. Unknown stays off.
      ...(nestedVirtualizationSupport(
        CloudType.AWS,
        this.vmType,
        this.region,
      ) && {
        CpuOptions: { NestedVirtualization: 'enabled' as const },
      }),
    };

    // Always override the root volume: Canonical's jammy AMIs are gp2-rooted,
    // so deferring to the AMI default would launch gp2 (slower than gp3, and
    // 25% pricier per GB).
    const blockDeviceMappings = {
      BlockDeviceMappings: [
        {
          DeviceName: resolvedAmi.rootDeviceName,
          Ebs: {
            ...bootDisk,
            VolumeType: VolumeType.gp3,
            DeleteOnTermination: true,
          },
        },
      ],
    };

    const instanceParams = {
      ...launchParams,
      TagSpecifications: [
        {
          ResourceType: 'instance' as ResourceType,
          Tags: [
            {
              Key: 'Name',
              Value: vmId,
            },
            ...this.getResourceTags(
              workloadId,
              version,
              userId,
              undefined,
              params.resourceScope,
            ),
          ],
        },
        {
          ResourceType: 'volume' as ResourceType,
          Tags: this.getResourceTags(
            workloadId,
            version,
            userId,
            undefined,
            params.resourceScope,
          ),
        },
        {
          // Persist ownership at launch: an orphaned interface must remain
          // discoverable after its instance record disappears, including when
          // the instance uses an account-wide shared security group.
          ResourceType: 'network-interface' as ResourceType,
          Tags: this.getResourceTags(
            workloadId,
            version,
            userId,
            undefined,
            params.resourceScope,
          ),
        },
        // Only tag spot instance requests when creating spot instances
        ...(this.spot
          ? [
              {
                ResourceType: 'spot-instances-request' as ResourceType,
                Tags: this.getResourceTags(
                  workloadId,
                  version,
                  userId,
                  undefined,
                  params.resourceScope,
                ),
              },
            ]
          : []),
      ],
      UserData: Buffer.from(startupScript).toString('base64'),
      // Keep the client token stable for this durable attempt. Reconciliation
      // inspects by token before deciding whether a create is still needed.
      ClientToken: vmId,
      ...blockDeviceMappings,
      // A Job's spot VM stops on interruption and restarts in place; a node
      // pool's (resource-scoped) is terminated and replaced by its pool.
      ...(this.spot && {
        InstanceMarketOptions: {
          MarketType: MarketType.spot,
          SpotOptions: params.resourceScope
            ? {
                SpotInstanceType: SpotInstanceType.one_time,
                InstanceInterruptionBehavior:
                  InstanceInterruptionBehavior.terminate,
              }
            : {
                SpotInstanceType: SpotInstanceType.persistent,
                InstanceInterruptionBehavior: InstanceInterruptionBehavior.stop,
              },
        },
      }),
    };

    let create;
    if (params.adoptExistingAttempt) {
      const existing = await this.findRecoverableInstanceByClientToken(vmId);
      if (existing) {
        create = { Instances: [existing] };
        log.info('Adopting existing EC2 provisioning attempt', {
          vmId,
          workloadId,
          instanceId: existing.InstanceId,
        });
      }
    }
    if (!create) {
      try {
        create = await this.ec2client.send(
          new RunInstancesCommand(instanceParams),
        );
      } catch (error: any) {
        if (
          // Handle concurrent VM creation: another upgrade attempt succeeded with same ClientToken
          error.name === 'IdempotentParameterMismatch' ||
          error.Code === 'IdempotentParameterMismatch'
        ) {
          log.info(
            'Concurrent VM creation detected - querying existing instance',
            {
              vmId,
              workloadId,
            },
          );

          const existing =
            await this.findRecoverableInstanceByClientToken(vmId);
          if (existing) {
            create = { Instances: [existing] };
            log.info('Found existing instance from concurrent creation', {
              vmId,
              instanceId: existing.InstanceId,
            });
          } else {
            throw new Error(
              `IdempotentParameterMismatch but instance not found for ClientToken ${vmId}. ` +
                `Instance may have been created then immediately deleted.`,
            );
          }
        } else {
          if ((error.Code ?? error.name) === 'VPCIdNotSpecified') {
            error.message = `${error.message} ${this.noDefaultVpcHint()}`;
          }
          throw error;
        }
      }
    }
    return this.connectToProvisioningInstance(
      create.Instances?.[0],
      resolvedAmi.imageId,
    );
  }

  private async getAllVMs(): Promise<GatewayVM[]> {
    const data = await this.ec2client.send(new DescribeInstancesCommand({}));
    const vms: GatewayVM[] = [];
    (data.Reservations ?? []).forEach((r) => {
      vms.push(...this.getVMsInfo(r));
    });
    return vms;
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

    // 1. Find and cleanup orphaned EC2 instances
    try {
      const instances = await this.ec2client.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'tag-key',
              Values: ['anycloud_deployment', 'anycloud_resource'],
            },
            {
              Name: 'instance-state-name',
              Values: ['running', 'stopped', 'stopping', 'pending'],
            },
          ],
        }),
      );

      // Collect all instances to delete
      const instanceDeletions = [];
      for (const reservation of instances.Reservations || []) {
        for (const instance of reservation.Instances || []) {
          const tags: Record<string, string> = {};
          for (const tag of instance.Tags || []) {
            if (tag.Key && tag.Value !== undefined) {
              tags[tag.Key] = tag.Value;
            }
          }

          const isOrphaned = isResourceSweepCandidate(
            {
              ...sweepOwner(tags),
              endedAt: tags.anycloud_ended_at,
              createdAt: instance.LaunchTime,
              // Starting and stopping count as running, as ResourceVM says.
              running: instance.State?.Name !== 'stopped',
              spare: { into: result, type: 'vm', id: instance.InstanceId },
            },
            options.policy,
          );

          if (isOrphaned && instance.InstanceId) {
            if (dryRun) {
              result.vmIds.push(instance.InstanceId);
            } else {
              instanceDeletions.push(
                (async () => {
                  try {
                    // Persistent Spot requests must be cancelled before their
                    // instances are terminated or AWS will launch replacements.
                    await this.cancelSpotRequestOf(instance);
                    await deleteWithRetry(
                      () =>
                        this.requestInstanceTermination(instance.InstanceId!),
                      `EC2 instance ${instance.InstanceId}`,
                      isAWSNotFound,
                    );
                    result.vmIds.push(instance.InstanceId!);
                    log.info('Cleaned up orphaned VM', {
                      instanceId: instance.InstanceId,
                      resourceOwner:
                        tags.anycloud_resource ?? tags.anycloud_deployment,
                    });
                  } catch (error) {
                    result.errors.push({
                      resourceType: 'vm',
                      resourceId: instance.InstanceId!,
                      error: (error as Error).message,
                    });
                  }
                })(),
              );
            }
          }
        }
      }

      // Delete all instances in parallel
      await Promise.allSettled(instanceDeletions);
    } catch (error) {
      log.error('Error listing EC2 instances for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'vm',
        resourceId: 'list-instances',
        error: (error as Error).message,
      });
    }

    // 1b. Find and cleanup untagged instances with anycloud security groups
    // These are likely from old code or failed tagging operations
    try {
      // Identify "ours" by the anycloud_deployment SG tag rather than by SG
      // name shape, so this cleanup path doesn't have to know integration-test
      // ID conventions (which change).
      const anycloudSGs = await this.ec2client.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            {
              Name: 'tag-key',
              Values: ['anycloud_deployment', 'anycloud_resource'],
            },
          ],
        }),
      );
      const anycloudSGIds = new Set(
        (anycloudSGs.SecurityGroups || [])
          .map((sg) => sg.GroupId)
          .filter((id): id is string => !!id),
      );
      // The shared anycloud SGs carry no anycloud_deployment tag, so add them
      // explicitly — an untagged instance using only the shared SG is still ours.
      const sharedSGs = await this.ec2client.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: 'group-name', Values: [...AWS_SHARED_SG_NAMES] }],
        }),
      );
      for (const sg of sharedSGs.SecurityGroups || []) {
        if (sg.GroupId) anycloudSGIds.add(sg.GroupId);
      }

      const allInstances = await this.ec2client.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'instance-state-name',
              Values: ['running', 'stopped', 'stopping', 'pending'],
            },
          ],
        }),
      );

      const untaggedDeletions = [];

      for (const reservation of allInstances.Reservations || []) {
        for (const instance of reservation.Instances || []) {
          // Skip if instance has anycloud tags (already handled above)
          const hasAnycloudTags = instance.Tags?.some((tag) =>
            tag.Key?.startsWith('anycloud_'),
          );
          if (hasAnycloudTags) continue;

          const securityGroups = instance.SecurityGroups || [];
          const hasAnycloudSG = securityGroups.some(
            (sg) => sg.GroupId && anycloudSGIds.has(sg.GroupId),
          );

          // An untagged instance is unowned, so the policy's unowned age rule
          // applies. This recovery path predates ownership tags.
          if (
            hasAnycloudSG &&
            isResourceSweepCandidate(
              { createdAt: instance.LaunchTime },
              options.policy,
            ) &&
            instance.InstanceId
          ) {
            if (dryRun) {
              result.vmIds.push(instance.InstanceId);
            } else {
              untaggedDeletions.push(
                (async () => {
                  try {
                    await this.cancelSpotRequestOf(instance);
                    await deleteWithRetry(
                      () =>
                        this.requestInstanceTermination(instance.InstanceId!),
                      `Untagged EC2 instance ${instance.InstanceId}`,
                      isAWSNotFound,
                    );
                    result.vmIds.push(instance.InstanceId!);
                    log.info('Cleaned up untagged VM with anycloud SG', {
                      instanceId: instance.InstanceId,
                      securityGroups: securityGroups.map((sg) => sg.GroupName),
                    });
                  } catch (error) {
                    result.errors.push({
                      resourceType: 'vm',
                      resourceId: instance.InstanceId!,
                      error: (error as Error).message,
                    });
                  }
                })(),
              );
            }
          }
        }
      }

      await Promise.allSettled(untaggedDeletions);
    } catch (error) {
      log.error('Error cleaning up untagged instances', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'vm',
        resourceId: 'cleanup-untagged',
        error: (error as Error).message,
      });
    }

    // 2. Find and cleanup orphaned Network Interfaces
    // This must happen after instance termination but before security group deletion
    // because ENIs can remain attached to security groups for several minutes after termination
    try {
      const networkInterfaces = await this.ec2client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [
            {
              Name: 'tag-key',
              Values: ['anycloud_deployment', 'anycloud_resource'],
            },
          ],
        }),
      );

      // Filter orphaned network interfaces
      const orphanedENIs = (networkInterfaces.NetworkInterfaces || [])
        .map((eni) => {
          const tags: Record<string, string> = {};
          for (const tag of eni.TagSet || []) {
            if (tag.Key && tag.Value !== undefined) {
              tags[tag.Key] = tag.Value;
            }
          }

          // A reclaimable owner's ENI is orphaned if:
          // 1. Tagged with ended_at (explicit termination marker)
          // 2. Not attached to any instance (available state)
          // 3. Attached to a terminated/terminating instance
          const isOrphaned = isResourceSweepCandidate(
            {
              ...sweepOwner(tags),
              endedAt: tags.anycloud_ended_at,
              spare: {
                into: result,
                type: 'networkInterface',
                id: eni.NetworkInterfaceId,
              },
              detached:
                eni.Status === 'available' ||
                eni.Attachment?.Status === 'detaching' ||
                eni.Attachment?.Status === 'detached',
            },
            options.policy,
          );

          return { eni, tags, isOrphaned };
        })
        .filter(({ isOrphaned }) => isOrphaned);

      if (orphanedENIs.length > 0) {
        log.info(
          `Found ${orphanedENIs.length} orphaned network interfaces to clean up`,
        );
      }

      // Delete network interfaces in parallel for faster cleanup
      const eniDeletions = orphanedENIs.map(async ({ eni, tags }) => {
        if (!eni.NetworkInterfaceId) return;

        if (dryRun) {
          result.otherResources.push({
            type: 'networkInterface',
            id: eni.NetworkInterfaceId,
          });
          return;
        }

        try {
          await deleteWithRetry(
            () =>
              this.ec2client.send(
                new DeleteNetworkInterfaceCommand({
                  NetworkInterfaceId: eni.NetworkInterfaceId,
                }),
              ),
            `Network interface ${eni.NetworkInterfaceId}`,
            isAWSNotFound,
          );
          result.otherResources.push({
            type: 'networkInterface',
            id: eni.NetworkInterfaceId,
          });
          log.info('Cleaned up orphaned network interface', {
            networkInterfaceId: eni.NetworkInterfaceId,
            resourceOwner: tags.anycloud_resource ?? tags.anycloud_deployment,
            status: eni.Status,
            attachmentStatus: eni.Attachment?.Status,
          });
        } catch (error: any) {
          // Extract detailed error information from AWS SDK error
          const errorCode = error.Code || error.name || 'Unknown';
          const errorMessage = error.message || String(error);
          const detailedError = `${errorCode}: ${errorMessage}`;

          log.error('Failed to delete network interface after retries', {
            id: 'system',
            error,
            networkInterfaceId: eni.NetworkInterfaceId,
            resourceOwner: tags.anycloud_resource ?? tags.anycloud_deployment,
            status: eni.Status,
            attachmentStatus: eni.Attachment?.Status,
            attachmentInstanceId: eni.Attachment?.InstanceId,
            errorCode,
            errorMessage,
            requestId: error.$metadata?.requestId,
            httpStatusCode: error.$metadata?.httpStatusCode,
          });

          result.errors.push({
            resourceType: 'networkInterface',
            resourceId: eni.NetworkInterfaceId,
            error: detailedError,
          });
        }
      });

      // Wait for all network interface deletions to complete (parallel execution)
      await Promise.allSettled(eniDeletions);

      // Give AWS a moment to propagate ENI deletions before attempting security group deletion
      // This reduces the likelihood of DependencyViolation errors on security groups
      if (orphanedENIs.length > 0 && !dryRun) {
        log.info(
          'Waiting 15 seconds for ENI deletion propagation before security group cleanup',
        );
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    } catch (error) {
      log.error('Error listing network interfaces for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'networkInterface',
        resourceId: 'list-network-interfaces',
        error: (error as Error).message,
      });
    }

    // 3. Find and cleanup orphaned Security Groups
    try {
      const securityGroups = await this.ec2client.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            {
              Name: 'tag-key',
              Values: ['anycloud_deployment', 'anycloud_resource'],
            },
          ],
        }),
      );

      // Filter orphaned security groups
      const orphanedSGs = (securityGroups.SecurityGroups || [])
        .map((sg) => {
          const tags: Record<string, string> = {};
          for (const tag of sg.Tags || []) {
            if (tag.Key && tag.Value !== undefined) {
              tags[tag.Key] = tag.Value;
            }
          }
          return { sg, tags };
        })
        .filter(
          ({ sg, tags }) =>
            // Never reap a shared anycloud SG. It carries no resource-owner
            // tag so the query above won't return it, but guard explicitly in
            // case one was ever tagged by hand.
            !AWS_SHARED_SG_NAMES.has(sg.GroupName ?? '') &&
            isResourceSweepCandidate(
              {
                ...sweepOwner(tags),
                endedAt: tags.anycloud_ended_at,
                createdAt: tags.anycloud_created_at,
                spare: { into: result, type: 'securityGroup', id: sg.GroupId },
              },
              options.policy,
            ),
        );

      if (orphanedSGs.length > 0) {
        log.info(
          `Found ${orphanedSGs.length} orphaned security groups to clean up`,
        );
      }

      // Delete security groups in parallel for faster cleanup
      const sgDeletions = orphanedSGs.map(async ({ sg, tags }) => {
        if (!sg.GroupId) return;

        if (dryRun) {
          result.otherResources.push({
            type: 'securityGroup',
            id: sg.GroupId,
          });
          return;
        }

        try {
          // Retry for security groups - should succeed quickly now that we clean up ENIs first
          // Still using extended retry as a safety net for race conditions or AWS eventual consistency
          await deleteWithRetry(
            () =>
              this.ec2client.send(
                new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }),
              ),
            `Security group ${sg.GroupName || sg.GroupId}`,
            isAWSNotFound,
            30, // 30 attempts × 10s = 5 minutes (safety net after ENI cleanup)
            10000,
          );
          result.otherResources.push({
            type: 'securityGroup',
            id: sg.GroupId,
          });
          log.info('Cleaned up orphaned security group', {
            groupId: sg.GroupId,
            groupName: sg.GroupName,
            resourceOwner: tags.anycloud_resource ?? tags.anycloud_deployment,
          });
        } catch (error: any) {
          // Extract detailed error information from AWS SDK error
          const errorCode = error.Code || error.name || 'Unknown';
          const errorMessage = error.message || String(error);
          const detailedError = `${errorCode}: ${errorMessage}`;

          log.error('Failed to delete security group after retries', {
            id: 'system',
            error,
            groupId: sg.GroupId,
            groupName: sg.GroupName,
            resourceOwner: tags.anycloud_resource ?? tags.anycloud_deployment,
            errorCode,
            errorMessage,
            // Include additional AWS error details if available
            requestId: error.$metadata?.requestId,
            httpStatusCode: error.$metadata?.httpStatusCode,
          });

          result.errors.push({
            resourceType: 'securityGroup',
            resourceId: sg.GroupId,
            error: detailedError,
          });
        }
      });

      // Wait for all security group deletions to complete (parallel execution)
      await Promise.allSettled(sgDeletions);
    } catch (error) {
      log.error('Error listing security groups for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'securityGroup',
        resourceId: 'list-security-groups',
        error: (error as Error).message,
      });
    }

    // 4. Find and cleanup orphaned EBS volumes
    try {
      const volumes = await this.ec2client.send(
        new DescribeVolumesCommand({
          Filters: [
            {
              Name: 'tag-key',
              Values: ['anycloud_deployment', 'anycloud_resource'],
            },
          ],
        }),
      );

      // Collect all volumes to delete
      const volumeDeletions = [];
      for (const volume of volumes.Volumes || []) {
        const tags: Record<string, string> = {};
        for (const tag of volume.Tags || []) {
          if (tag.Key && tag.Value !== undefined) {
            tags[tag.Key] = tag.Value;
          }
        }

        const isOrphaned = isResourceSweepCandidate(
          {
            ...sweepOwner(tags),
            endedAt: tags.anycloud_ended_at,
            createdAt: tags.anycloud_created_at ?? volume.CreateTime,
            detached: volume.State === 'available', // Not attached to any instance
            spare: { into: result, type: 'volume', id: volume.VolumeId },
          },
          options.policy,
        );

        if (isOrphaned && volume.VolumeId) {
          if (dryRun) {
            result.otherResources.push({
              type: 'disk',
              id: volume.VolumeId,
            });
          } else {
            volumeDeletions.push(
              (async () => {
                try {
                  await deleteWithRetry(
                    () =>
                      this.ec2client.send(
                        new DeleteVolumeCommand({ VolumeId: volume.VolumeId }),
                      ),
                    `EBS volume ${volume.VolumeId}`,
                    isAWSNotFound,
                  );
                  result.otherResources.push({
                    type: 'disk',
                    id: volume.VolumeId!,
                  });
                  log.info('Cleaned up orphaned EBS volume', {
                    volumeId: volume.VolumeId,
                    resourceOwner:
                      tags.anycloud_resource ?? tags.anycloud_deployment,
                  });
                } catch (error) {
                  result.errors.push({
                    resourceType: 'disk',
                    resourceId: volume.VolumeId!,
                    error: (error as Error).message,
                  });
                }
              })(),
            );
          }
        }
      }

      // Delete all volumes in parallel
      await Promise.allSettled(volumeDeletions);
    } catch (error) {
      log.error('Error listing EBS volumes for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'disk',
        resourceId: 'list-volumes',
        error: (error as Error).message,
      });
    }

    // S3 bucket cleanup is handled by the account-wide storage sweep
    // pass (called once from ci/cleanup/aws.ts), not per-region. Buckets
    // are global, so a per-region fan-out would have us calling each bucket
    // from 19 wrong-region endpoints — most of which return fast 400s, but
    // some opt-in regions (e.g. me-central-1) stall on the cross-region path
    // for ~5 min per attempt.

    // 5. Find and cleanup orphaned persistent spot instance requests
    // CRITICAL: Persistent spot requests remain active even after instances are terminated,
    // counting against AWS account limits. This cleanup prevents MaxSpotInstanceCountExceeded errors.
    try {
      const spotRequests = await this.ec2client.send(
        new DescribeSpotInstanceRequestsCommand({
          Filters: [
            {
              Name: 'tag-key',
              Values: ['anycloud_deployment'],
            },
            {
              Name: 'state',
              // A persistent request becomes disabled while its instance is
              // stopped. It is still cancelable and will reopen if that
              // instance is terminated.
              Values: CANCELABLE_SPOT_REQUEST_STATES,
            },
          ],
        }),
      );

      // Filter orphaned spot requests
      const orphanedRequests = (spotRequests.SpotInstanceRequests || [])
        .map((req) => {
          const tags: Record<string, string> = {};
          for (const tag of req.Tags || []) {
            if (tag.Key && tag.Value !== undefined) {
              tags[tag.Key] = tag.Value;
            }
          }

          // Request is orphaned if:
          // 1. Tagged with ended_at (workload ended)
          // 2. Empty user tag AND old enough to not belong to a concurrent CI run
          const isOrphaned = isResourceSweepCandidate(
            {
              ...sweepOwner(tags),
              endedAt: tags.anycloud_ended_at,
              createdAt: req.CreateTime,
              spare: {
                into: result,
                type: 'spotRequest',
                id: req.SpotInstanceRequestId,
              },
            },
            options.policy,
          );

          return { req, tags, isOrphaned };
        })
        .filter(({ isOrphaned }) => isOrphaned);

      if (orphanedRequests.length > 0) {
        log.info(
          `Found ${orphanedRequests.length} orphaned spot instance requests to clean up`,
        );
      }

      // Cancel orphaned spot requests in parallel
      const spotRequestCancellations = orphanedRequests.map(
        async ({ req, tags }) => {
          if (!req.SpotInstanceRequestId) return;

          if (dryRun) {
            result.otherResources.push({
              type: 'spotRequest',
              id: req.SpotInstanceRequestId,
            });
            if (req.InstanceId && !result.vmIds.includes(req.InstanceId)) {
              result.vmIds.push(req.InstanceId);
            }
            return;
          }

          try {
            await this.ec2client.send(
              new CancelSpotInstanceRequestsCommand({
                SpotInstanceRequestIds: [req.SpotInstanceRequestId],
              }),
            );
            result.otherResources.push({
              type: 'spotRequest',
              id: req.SpotInstanceRequestId,
            });
            // Cancelling leaves the request's instance running. An open
            // request EC2 refilled names an untagged instance no instance
            // sweep finds, so end it here, after the cancel. Re-read the
            // request: EC2 may have filled it after the listing.
            const instanceId = await this.spotRequestInstance(
              req.SpotInstanceRequestId,
              req.InstanceId,
            );
            if (instanceId) {
              await deleteWithRetry(
                () => this.requestInstanceTermination(instanceId),
                `EC2 instance ${instanceId}`,
                isAWSNotFound,
                undefined,
                undefined,
                (error) =>
                  !awsPermissionDenial(error) &&
                  !this.isTerminalAuthError(error),
              );
              if (!result.vmIds.includes(instanceId)) {
                result.vmIds.push(instanceId);
              }
            }
            log.info('Cleaned up orphaned spot instance request', {
              spotRequestId: req.SpotInstanceRequestId,
              instanceId: req.InstanceId,
              workload: tags.anycloud_deployment,
              state: req.State,
            });
          } catch (error: any) {
            const errorCode = error.Code || error.name || 'Unknown';
            const errorMessage = error.message || String(error);
            const detailedError = `${errorCode}: ${errorMessage}`;

            log.error('Failed to reclaim spot instance request', {
              id: 'system',
              error,
              spotRequestId: req.SpotInstanceRequestId,
              instanceId: req.InstanceId,
              workload: tags.anycloud_deployment,
              errorCode,
              errorMessage,
            });

            result.errors.push({
              resourceType: 'spotRequest',
              resourceId: req.SpotInstanceRequestId!,
              error: detailedError,
            });
          }
        },
      );

      await Promise.allSettled(spotRequestCancellations);
    } catch (error) {
      log.error('Error listing spot instance requests for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'spotRequest',
        resourceId: 'list-spot-requests',
        error: (error as Error).message,
      });
    }

    return result;
  }

  /**
   * Account-wide S3 bucket cleanup. S3 is global, so unlike VMs/ENIs/etc this
   * runs once per account, not per region. We list buckets globally, then
   * tag-read each one against this.s3client directly — on a cross-region
   * redirect we resolve the bucket's actual region via getS3ClientForBucket
   * and retry. Most buckets in the cleanup account live in this.region
   * (us-east-1), so the location lookup is paid only on the rare redirect
   * instead of once per bucket. Routing through region-correct clients also
   * avoids the cross-region stalls some opt-in regions exhibit that the
   * previous per-region fan-out produced.
   */
  private async sweepStorage(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult> {
    const dryRun = options.dryRun ?? false;
    const result: ResourceSweepResult = {
      vmIds: [],
      otherResources: [],
      errors: [],
    };

    let listBucketsResponse;
    try {
      listBucketsResponse = await this.s3client.send(
        new ListBucketsCommand({}),
      );
    } catch (error) {
      log.error('Error listing S3 buckets for cleanup', {
        id: 'system',
        error,
      });
      result.errors.push({
        resourceType: 'bucket',
        resourceId: 'list-buckets',
        error: (error as Error).message,
      });
      return result;
    }

    const bucketDeletions = (listBucketsResponse.Buckets || []).map(
      async (bucket) => {
        if (!bucket.Name) return;
        const bucketName = bucket.Name;
        // AWS SDK v3 puts the classifier in `Code`; `name` is often just
        // 'Error'. Check both.
        const errorCode = (error: any) => error?.Code ?? error?.name;
        // PermanentRedirect / IllegalLocationConstraintException mean the
        // bucket lives in a different region than this.s3client. Resolve
        // the location then retry against a region-correct client.
        const isRedirect = (code: string | undefined) =>
          code === 'PermanentRedirect' ||
          code === 'IllegalLocationConstraintException';
        // The managed checkpoint bucket is named for its installation, so an
        // installation sweep finds it even when its tags were never written
        // (CreateBucket and PutBucketTagging are separate calls).
        const named = bucketName === options.policy.installation?.clusterId;
        try {
          // An untagged bucket reads as an empty tag set.
          const readTags = async (client: S3Client) => {
            try {
              const response = await client.send(
                new GetBucketTaggingCommand({ Bucket: bucketName }),
              );
              return response.TagSet ?? [];
            } catch (error: any) {
              if (errorCode(error) === 'NoSuchTagSet') return [];
              throw error;
            }
          };
          let tagSet;
          try {
            tagSet = await readTags(this.s3client);
          } catch (error: any) {
            if (!isRedirect(errorCode(error))) throw error;
            tagSet = await readTags(
              await this.getS3ClientForBucket(bucketName),
            );
          }

          const tags: Record<string, string> = {};
          for (const tag of tagSet) {
            if (tag.Key && tag.Value !== undefined) {
              tags[tag.Key] = tag.Value;
            }
          }

          // Only inspect buckets that carry our tags.
          if (!tags.anycloud_deployment && !named) return;

          const isOrphaned = isResourceSweepCandidate(
            {
              ...sweepOwner(tags),
              endedAt: tags.anycloud_ended_at,
              createdAt: tags.anycloud_created_at ?? bucket.CreationDate,
              name: bucketName,
              spare: { into: result, type: 'bucket', id: bucketName },
            },
            options.policy,
          );
          if (!isOrphaned) return;

          if (dryRun) {
            result.otherResources.push({ type: 'bucket', id: bucketName });
            return;
          }

          try {
            await this.deleteBucket(bucketName);
            result.otherResources.push({ type: 'bucket', id: bucketName });
            log.info('Cleaned up orphaned S3 bucket', {
              bucketName,
              workload: tags.anycloud_deployment,
            });
          } catch (error) {
            result.errors.push({
              resourceType: 'bucket',
              resourceId: bucketName,
              error: (error as Error).message,
            });
          }
        } catch (error: any) {
          log.error(`Error checking bucket ${bucketName} for cleanup`, {
            id: 'system',
            bucketName,
            error,
          });
        }
      },
    );

    await Promise.allSettled(bucketDeletions);
    return result;
  }

  /**
   * Prove the secret is genuine without depending on the placement region or
   * any permission: STS GetCallerIdentity in us-east-1. STS rejects a key it
   * has not yet propagated and a deleted key alike, so InvalidClientTokenId
   * gets the same bounded backoff (about 23s) as listBuckets.
   */
  private async validateCredentials(): Promise<void> {
    const sts = createAwsStsClient(this.credentials, { region: 'us-east-1' });
    await withRetry(
      () => sts.send(new GetCallerIdentityCommand({})),
      'AWS validate credentials',
      FRESH_KEY_RETRY,
    );
  }

  // Mint one scoped, short-lived AWS STS token whose inline policy covers
  // exactly the given bucket grants. This is exposed to callers only through
  // storage() + canMintScopedStorageToken(storage), not the AWS provider class.
  private validateScopedStorageTokenSource(): void {
    // The VM identity backs the API up and tears it down; pools sync with a
    // saved credential.
    if ('kind' in this.storageCreds && this.storageCreds.kind === 'instance') {
      throw new DeployError(
        "The management VM's own identity does not mint bucket-sync tokens; save a credential for node pool storage.",
        400,
      );
    }
    if ('sessionToken' in this.storageCreds && this.storageCreds.sessionToken) {
      throw new DeployError(
        'AWS storage credentials with sessionToken cannot mint scoped bucket-sync tokens: STS GetFederationToken requires long-term IAM user credentials. Use long-term AWS IAM user storage credentials.',
        400,
      );
    }
  }

  private async mintScopedStorageToken(
    grants: ScopedStorageGrant[],
    options?: { lifetimeMs?: number },
  ): Promise<ScopedStorageToken | undefined> {
    if (grants.length === 0) return undefined;
    this.validateScopedStorageTokenSource();
    return mintScopedS3Token(
      this.storageCreds as AWSCreds | AWSRoleCreds,
      this.region,
      grants,
      options?.lifetimeMs,
    );
  }

  private async hasBucketUncoordinated(bucketName: string): Promise<boolean> {
    try {
      await this.s3client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return true;
    } catch (error: any) {
      // 301 means bucket exists in a different region — still accessible cross-region
      if (error.$metadata?.httpStatusCode === 301) return true;
      if (isS3NotFound(error)) {
        return false;
      }
      if (isS3BucketRegionRetryError(error)) {
        return this.hasBucketInDiscoveredRegion(bucketName, error);
      }
      throw error;
    }
  }

  private async listBuckets(
    options: CloudListPageOptions,
    signal?: AbortSignal,
  ): Promise<BucketListPage> {
    // Live generation reached this read before S3 recognized the saved IAM key.
    // Retry only that exact failure, with at most 23s of backoff inside the
    // caller's existing budget. AccessDenied stays terminal; mutations do not
    // share this policy. The same signal cancels SDK retries and our waits.
    const response = await withRetry(
      () =>
        this.s3client.send(
          new ListBucketsCommand({
            MaxBuckets: options.pageSize,
            ContinuationToken: options.cursor,
          }),
          { abortSignal: signal },
        ),
      'AWS list buckets',
      {
        ...FRESH_KEY_RETRY,
        signal,
        shouldRetry: (error) => awsErrorCode(error) === 'InvalidAccessKeyId',
      },
    );
    return {
      buckets: (response.Buckets ?? [])
        .filter((bucket): bucket is typeof bucket & { Name: string } =>
          Boolean(bucket.Name),
        )
        .map((bucket) => ({
          name: bucket.Name,
          region: bucket.BucketRegion ?? null,
          createdAt: bucket.CreationDate?.getTime() ?? null,
        })),
      nextCursor: response.ContinuationToken ?? null,
    };
  }

  private async listObjects(
    bucketName: string,
    options: CloudObjectListOptions,
    signal?: AbortSignal,
  ): Promise<BucketEntryPage> {
    const client = await this.getS3ClientForBucket(bucketName);
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: options.prefix || undefined,
        Delimiter: options.recursive ? undefined : '/',
        MaxKeys: options.pageSize,
        ContinuationToken: options.cursor,
      }),
      { abortSignal: signal },
    );
    const entries: BucketEntryPage['entries'] = [];
    for (const prefix of response.CommonPrefixes ?? []) {
      if (prefix.Prefix) entries.push({ kind: 'prefix', key: prefix.Prefix });
    }
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      entries.push({
        kind: 'object',
        key: object.Key,
        sizeBytes: object.Size ?? null,
        lastModifiedAt: object.LastModified?.getTime() ?? null,
      });
    }
    // Entries stay in provider order here; the route sorts each page once.
    return {
      entries,
      nextCursor: response.NextContinuationToken ?? null,
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
    // RFC 0043 D-managed creates first: a HEAD can't tell another account's
    // bucket (403, or 301 in another region) from ours.
    probe = true,
  ): Promise<void> {
    try {
      if (probe && (await this.hasBucketUncoordinated(bucketName))) {
        log.info(`S3 bucket ${bucketName} already exists, skipping creation`);
        return;
      }

      log.info(`Creating S3 bucket: ${bucketName} in ${this.region}`);

      const createParams: any = { Bucket: bucketName };
      if (this.region !== 'us-east-1') {
        createParams.CreateBucketConfiguration = {
          LocationConstraint: this.region,
        };
      }

      try {
        await this.s3client.send(new CreateBucketCommand(createParams));
      } catch (createErr: any) {
        // Many deploys share one output bucket and race HeadBucket/CreateBucket;
        // outside us-east-1 the loser gets BucketAlreadyOwnedByYou (us-east-1
        // CreateBucket is idempotent) — success for an upsert: the winner applies
        // the access-block + tags. Without this the loser fails to deploy and
        // churns in Retrying forever. BucketAlreadyExists is NOT our race: it means
        // a different account owns the name globally — let it throw (classifyError
        // maps it to InvalidRequest) rather than deploy against an unwritable bucket.
        const name = createErr?.Code ?? createErr?.name ?? '';
        if (name === 'BucketAlreadyOwnedByYou') {
          log.info(`S3 bucket ${bucketName} created concurrently, reusing`);
          return;
        }
        throw createErr;
      }

      await this.s3client.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      );

      await this.s3client.send(
        new PutBucketTaggingCommand({
          Bucket: bucketName,
          Tagging: {
            TagSet: [
              ...this.getResourceTags(workloadId, version, userId),
              { Key: 'anycloud_created_at', Value: Date.now().toString() },
            ],
          },
        }),
      );

      // CreateBucket and the configuration writes above can succeed before a
      // subsequent HeadBucket reaches a control-plane replica that recognizes
      // the bucket. Do not hand the bucket to immediate callers until the
      // SDK's bounded waiter observes it. Tagging precedes the waiter so a
      // timeout still leaves an identity that a resource sweep can discover.
      await waitUntilBucketExists(
        {
          client: this.s3client,
          maxWaitTime: AWS_BUCKET_CREATION_READINESS_MAX_WAIT_SECONDS,
          minDelay: 1,
          maxDelay: 5,
        },
        { Bucket: bucketName },
      );

      log.info(`S3 bucket ${bucketName} created successfully`);
    } catch (error) {
      if (error instanceof Error) {
        // The SDK reports "Unknown" when it cannot parse a failure, so the
        // message alone can carry nothing. Keep the code and HTTP status: they
        // are what separates a denied credential from an exhausted limit, and
        // without them a CI failure has no recoverable cause.
        const code = awsErrorCode(error);
        const status = (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        const detail = [
          error.message,
          code && code !== error.message ? `code ${code}` : undefined,
          status === undefined ? undefined : `HTTP ${status}`,
        ]
          .filter(Boolean)
          .join(', ');
        error.message = `Failed to create S3 bucket ${bucketName}: ${detail}`;
      }
      throw error;
    }
  }

  /**
   * RFC 0043 D-managed: create first, so BucketAlreadyExists, another
   * account's name, is refused; BucketAlreadyOwnedByYou reuses ours, in its
   * own region.
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
        false,
      );
    } catch (error) {
      if (awsErrorCode(error) === 'BucketAlreadyExists') {
        throw new BucketNameTakenError(bucketName, error);
      }
      if (awsPermissionDenial(error)) {
        throw new BucketAccessDeniedError(
          `Creating it needs s3:CreateBucket, s3:PutBucketPublicAccessBlock and s3:PutBucketTagging: ${awsErrorMessage(error)}`,
          error,
        );
      }
      throw error;
    }
    return (await this.getBucketRegion(bucketName)) ?? this.region;
  }

  /**
   * Discover a bucket's actual region. AWS returns null/empty for us-east-1.
   */
  private async getBucketRegion(
    bucketName: string,
  ): Promise<string | undefined> {
    try {
      const location = await this.s3client.send(
        new GetBucketLocationCommand({ Bucket: bucketName }),
      );
      return normalizeBucketRegion(location.LocationConstraint);
    } catch (error: any) {
      if (isS3NotFound(error)) return undefined;
      if (!isS3BucketRegionRetryError(error)) throw error;

      const fallbackClient = this.getS3ClientForRegion('us-east-1');
      try {
        const location = await fallbackClient.send(
          new GetBucketLocationCommand({ Bucket: bucketName }),
        );
        return normalizeBucketRegion(location.LocationConstraint);
      } catch (fallbackError: any) {
        if (isS3NotFound(fallbackError)) return undefined;
        throw fallbackError;
      }
    }
  }

  private async hasBucketInDiscoveredRegion(
    bucketName: string,
    originalError: any,
  ): Promise<boolean> {
    let bucketRegion: string | undefined;
    try {
      bucketRegion = await this.getBucketRegion(bucketName);
    } catch {
      throw originalError;
    }
    if (!bucketRegion) throw originalError;

    const client = this.getS3ClientForRegion(bucketRegion);
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return true;
    } catch (retryError: any) {
      if (isS3NotFound(retryError)) return false;
      throw retryError;
    }
  }

  private getS3ClientForRegion(region: string): S3Client {
    if (region === this.region) {
      return this.s3client;
    }
    log.info(`Using S3 client in ${region}, current region is ${this.region}`);
    return createAwsS3Client(this.s3client.config.credentials, {
      region,
      maxAttempts: 10,
    });
  }

  /**
   * Get an S3 client targeting the bucket's actual region.
   * After regional failover, a bucket may live in a different region than
   * this.region. S3 management APIs (tagging, delete) require the correct
   * regional endpoint, so we query GetBucketLocation first.
   */
  private async getS3ClientForBucket(bucketName: string): Promise<S3Client> {
    try {
      const bucketRegion = await this.getBucketRegion(bucketName);
      if (!bucketRegion) return this.s3client;
      return this.getS3ClientForRegion(bucketRegion);
    } catch (error: any) {
      // If bucket doesn't exist, just return the default client —
      // the caller will handle the 404 idempotently.
      if (isS3NotFound(error)) {
        return this.s3client;
      }
      // A credential scoped to objects may lack s3:GetBucketLocation; its own
      // call then decides, following S3's redirect to the bucket's region.
      // The SDK rewrites a redirecting client's region in place, so this
      // client is never shared.
      if (isAWSErrorCode(error, 'AccessDenied')) {
        return createAwsS3Client(this.s3client.config.credentials, {
          region: this.region,
          maxAttempts: 10,
          followRegionRedirects: true,
        });
      }
      throw error;
    }
  }

  private async deleteBucket(bucketName: string): Promise<void> {
    const client = await this.getS3ClientForBucket(bucketName);

    // Tag bucket with ended_at before deletion
    await this.tagBucketForDeletion(bucketName, client);

    try {
      // First, delete every object version (a versioned bucket keeps
      // noncurrent versions and delete markers that block DeleteBucket).
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      do {
        const listResponse = await client.send(
          new ListObjectVersionsCommand({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        );
        const objects = [
          ...(listResponse.Versions ?? []),
          ...(listResponse.DeleteMarkers ?? []),
        ].map((entry) => ({ Key: entry.Key, VersionId: entry.VersionId }));
        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: { Objects: objects },
            }),
          );
          log.info(
            `Deleted ${objects.length} object versions from S3 bucket ${bucketName}`,
          );
        }
        keyMarker = listResponse.IsTruncated
          ? listResponse.NextKeyMarker
          : undefined;
        versionIdMarker = listResponse.IsTruncated
          ? listResponse.NextVersionIdMarker
          : undefined;
      } while (keyMarker || versionIdMarker);

      // Now delete the empty bucket
      await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
      log.info(`S3 bucket ${bucketName} deleted successfully`);

      // Wait for deletion to propagate (S3 is eventually consistent)
      await retryUntil(
        async () => {
          try {
            await client.send(new HeadBucketCommand({ Bucket: bucketName }));
            // Bucket still exists, retry
            throw new Error('Bucket still exists');
          } catch (error: any) {
            // NoSuchBucket or 404 means deletion propagated
            if (
              error.name === 'NoSuchBucket' ||
              error.$metadata?.httpStatusCode === 404
            ) {
              return { deleted: true };
            }
            throw error;
          }
        },
        (result) => result.deleted === true,
        `S3 bucket ${bucketName} deletion propagation`,
        { maxAttempts: 10, waitMs: 1000 }, // 10 seconds max
      );
      log.info(`S3 bucket ${bucketName} deletion confirmed`);
    } catch (error: any) {
      // Idempotent - if bucket doesn't exist, that's fine
      if (
        error.name === 'NoSuchBucket' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        log.info(`S3 bucket ${bucketName} already deleted or doesn't exist`);
        return;
      }
      if (error instanceof Error) {
        error.message = `Failed to delete S3 bucket ${bucketName}: ${error.message}`;
      }
      throw error;
    }
  }

  private async uploadObject(
    bucketName: string,
    remotePath: string,
    source: CloudUploadSource,
  ): Promise<void> {
    // lib-storage's Upload reads from the stream and chooses single-PUT vs
    // multipart based on actual byte count, so a fixed ContentLength is
    // redundant and risks confusing the SDK on the multipart path.
    const client = await this.getS3ClientForBucket(bucketName);
    const upload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: remotePath,
        Body: openCloudUploadSource(source),
      },
    });
    await upload.done();
  }

  private async deleteObject(
    bucketName: string,
    remotePath: string,
  ): Promise<void> {
    const client = await this.getS3ClientForBucket(bucketName);
    await client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: remotePath }),
    );
  }

  private async downloadObject(
    bucketName: string,
    remotePath: string,
  ): Promise<{ stream: Readable; contentLength?: number }> {
    const client = await this.getS3ClientForBucket(bucketName);
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: remotePath }),
    );
    if (!response.Body) {
      throw new Error(
        `Empty response body for s3://${bucketName}/${remotePath}`,
      );
    }
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
    };
  }

  // Private methods

  // AMI ids and root-disk metadata are region-specific.
  async resolveAmi(
    gpuRuntime?: GpuRuntime | null,
    minimal = false,
  ): Promise<ResolvedAwsAmi> {
    return createAwsBaseImageResolver(
      this.ec2client,
      this.region,
    ).resolveBaseImage({ gpuRuntime, minimal });
  }

  // Ensure the shared anycloud VM security group exists.
  private async upsertFirewall(
    ipWhitelist: string[],
    id: string,
    version: string,
    userId: string,
  ): Promise<void> {
    await this.prepareNetwork(
      buildJobIngressSpec(ipWhitelist),
      id,
      version,
      userId,
    );
  }

  private async prepareNetwork(
    spec: IngressSpec,
    workloadId: string,
    version: string,
    userId: string,
    resourceScope?: CloudResourceScope,
  ): Promise<CloudNetworkHandle> {
    // A resource scope always gets its own security group, even with an empty
    // allow list — the empty scoped group is AWS "no public ingress". Falling
    // back to the shared group would attach public SSH from other workloads.
    if (resourceScope) {
      return {
        securityGroupId: await this.ensureScopedSecurityGroup(
          spec,
          resourceScope,
          version,
          userId,
        ),
      };
    }
    const name = hasHttpIngress(spec)
      ? AWS_SHARED_SERVICE_SG_NAME
      : AWS_SHARED_VM_SG_NAME;
    const securityGroupId = await this.ensureSharedSecurityGroup(name, spec);
    return { securityGroupId };
  }

  private async ensureScopedSecurityGroup(
    spec: IngressSpec,
    scope: CloudResourceScope,
    version: string,
    userId: string,
  ): Promise<string> {
    const vpcId = await this.getDefaultVpcId();
    const existing = await this.getSecurityGroupByNameInVpc(scope.id, vpcId);
    let securityGroupId = existing?.GroupId;
    if (!securityGroupId) {
      try {
        const created = await this.ec2client.send(
          new CreateSecurityGroupCommand({
            Description: `Anycloud resource scope ${scope.id}`,
            GroupName: scope.id,
            VpcId: vpcId,
            TagSpecifications: [
              {
                ResourceType: 'security-group' as ResourceType,
                Tags: this.getResourceTags(
                  scope.id,
                  version,
                  userId,
                  undefined,
                  scope,
                ),
              },
            ],
          }),
        );
        securityGroupId = created.GroupId;
      } catch (error: any) {
        if (
          error.Code !== 'InvalidGroup.Duplicate' &&
          error.name !== 'InvalidGroup.Duplicate'
        ) {
          throw error;
        }
        securityGroupId = (
          await this.getSecurityGroupByNameInVpc(scope.id, vpcId)
        )?.GroupId;
      }
    }
    if (!securityGroupId) {
      throw new Error(`AWS did not return a security group for ${scope.id}`);
    }

    // Transcribe the shared plan rule-for-rule; the security-group substrate
    // is default-deny, so the plan emits no deny pair and no family split.
    const permissions: IpPermission[] = resolveFirewallPlan(
      spec,
      AWS_FIREWALL_TRAITS,
    ).flatMap((rule): IpPermission[] =>
      rule.sourceRanges.map((sourceRange) =>
        this.generateFirewallRuleByIP(
          sourceRange,
          numericRulePort(rule.port),
          rule.protocol,
        ),
      ),
    );
    for (const permission of permissions) {
      try {
        await this.ec2client.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: securityGroupId,
            IpPermissions: [permission],
          }),
        );
      } catch (error: any) {
        if (
          error.Code !== 'InvalidPermission.Duplicate' &&
          error.name !== 'InvalidPermission.Duplicate'
        ) {
          throw error;
        }
      }
    }
    return securityGroupId;
  }

  /**
   * Ensure the shared anycloud VM security group exists in the default VPC and
   * return its id. Created once and reused by every workload — never deleted —
   * mirroring the shared IAM instance profile. Memoized per gateway so a
   * successful upsert runs once; a transient failure is evicted so the next
   * workload retries instead of failing for the gateway's lifetime.
   */
  async ensureSharedSecurityGroup(
    name = AWS_SHARED_VM_SG_NAME,
    spec: IngressSpec = buildJobIngressSpec(),
  ): Promise<string> {
    return memoizeAsync(this.sharedSecurityGroupReady, name, () =>
      this.upsertSharedSecurityGroup(name, spec),
    );
  }

  private async upsertSharedSecurityGroup(
    name: string,
    spec: IngressSpec,
  ): Promise<string> {
    const vpcId = await this.getDefaultVpcId();
    const existing = await this.getSecurityGroupByNameInVpc(name, vpcId);
    let securityGroupId = existing?.GroupId;
    if (!securityGroupId) {
      try {
        const created = await this.ec2client.send(
          new CreateSecurityGroupCommand({
            Description: 'Shared anycloud VM security group',
            GroupName: name,
            VpcId: vpcId,
            TagSpecifications: [
              {
                ResourceType: 'security-group' as ResourceType,
                // Intentionally NOT tagged anycloud_deployment: that tag is the
                // resource-sweep filter, and the shared SG must never be reaped.
                Tags: [
                  { Key: 'Name', Value: name },
                  { Key: 'anycloud_managed', Value: 'shared' },
                ],
              },
            ],
          }),
        );
        securityGroupId = created.GroupId!;
      } catch (err: any) {
        // Concurrent deploy created it between our lookup and create.
        if (
          err.Code === 'InvalidGroup.Duplicate' ||
          err.name === 'InvalidGroup.Duplicate'
        ) {
          securityGroupId = (await this.getSecurityGroupByNameInVpc(
            name,
            vpcId,
          ))!.GroupId!;
        } else {
          throw err;
        }
      }
    }

    if (hasHttpIngress(spec)) {
      await this.revokePublicHttpIngress(
        securityGroupId,
        existing?.IpPermissions,
      );
    }

    // AWS traits emit no deny pair (the security-group substrate is
    // default-deny), so the plan holds only public allows here; a deny would
    // fail loudly in numericRulePort rather than transcribe as an allow.
    const ipPermissions: IpPermission[] = resolveFirewallPlan(
      spec,
      AWS_FIREWALL_TRAITS,
    ).flatMap((rule) =>
      rule.sourceRanges.map((sourceRange) =>
        this.generateFirewallRuleByIP(
          sourceRange,
          numericRulePort(rule.port),
          rule.protocol,
        ),
      ),
    );
    for (const permission of ipPermissions) {
      try {
        await this.ec2client.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: securityGroupId,
            IpPermissions: [permission],
          }),
        );
      } catch (err: any) {
        // Rules already present (shared SG reused) — that is the desired state.
        if (
          err.Code !== 'IdempotentParameterMismatch' &&
          err.Code !== 'InvalidPermission.Duplicate' &&
          err.name !== 'IdempotentParameterMismatch' &&
          err.name !== 'InvalidPermission.Duplicate'
        ) {
          throw err;
        }
      }
    }
    return securityGroupId;
  }

  private async revokePublicHttpIngress(
    securityGroupId: string,
    permissions: IpPermission[] | undefined,
  ): Promise<void> {
    const staleRanges: IpPermission[] = [];
    for (const permission of permissions ?? []) {
      if (
        permission.IpProtocol !== 'tcp' ||
        permission.FromPort !== 80 ||
        permission.ToPort !== 80
      ) {
        continue;
      }

      const ipRanges = (permission.IpRanges ?? []).filter(
        (range) => range.CidrIp === '0.0.0.0/0',
      );
      const ipv6Ranges = (permission.Ipv6Ranges ?? []).filter(
        (range) => range.CidrIpv6 === '::/0',
      );
      if (ipRanges.length === 0 && ipv6Ranges.length === 0) continue;

      staleRanges.push({
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        ...(ipRanges.length > 0 ? { IpRanges: ipRanges } : {}),
        ...(ipv6Ranges.length > 0 ? { Ipv6Ranges: ipv6Ranges } : {}),
      });
    }

    for (const permission of staleRanges) {
      try {
        await this.ec2client.send(
          new RevokeSecurityGroupIngressCommand({
            GroupId: securityGroupId,
            IpPermissions: [permission],
          }),
        );
      } catch (err: any) {
        if (
          err.Code !== 'InvalidPermission.NotFound' &&
          err.name !== 'InvalidPermission.NotFound'
        ) {
          throw err;
        }
      }
    }
  }

  /**
   * Resolve the account's default VPC. RunInstances with no SubnetId auto-picks
   * a subnet from the default VPC, so anything attached to the VM (the shared
   * SG) must live there too. DescribeVpcs has no ordering guarantee, so prefer
   * the VPC flagged default; fall back to the first only when none is marked
   * default — a no-default-VPC account then fails downstream at RunInstances
   * with VPCIdNotSpecified (already classified InvalidTarget → rotate).
   */
  private async getDefaultVpcId(): Promise<string> {
    const vpcs = (await this.ec2client.send(new DescribeVpcsCommand({}))).Vpcs;
    if (!vpcs?.length) {
      throw Object.assign(
        new Error(
          `No VPCs in AWS region ${this.region}. ${this.noDefaultVpcHint()}`,
        ),
        { name: 'VPCIdNotSpecified', Code: 'VPCIdNotSpecified' },
      );
    }
    const defaultVpc = vpcs.find((v) => v.IsDefault);
    if (defaultVpc) return defaultVpc.VpcId!;
    const fallbackVpcId = vpcs[0].VpcId!;
    log.warn(
      `No default VPC in AWS region ${this.region}; using the first listed VPC ${fallbackVpcId} for security groups. ${this.noDefaultVpcHint()}`,
      { region: this.region, vpcId: fallbackVpcId },
    );
    return fallbackVpcId;
  }

  private noDefaultVpcHint(): string {
    return `Anycloud launches instances into the region's default VPC; create one with \`aws ec2 create-default-vpc --region ${this.region}\`.`;
  }

  private generateFirewallRuleByIP(
    cidrIp: string,
    port: number,
    protocol = 'tcp',
  ) {
    return {
      IpProtocol: protocol,
      FromPort: port,
      ToPort: port,
      ...(cidrIp.includes(':')
        ? { Ipv6Ranges: [{ CidrIpv6: cidrIp }] }
        : { IpRanges: [{ CidrIp: cidrIp }] }),
    };
  }

  private getVMsInfo(r: Reservation): GatewayVM[] {
    // Filter out shutting-down (32) and terminated (48) instances
    return (r.Instances ?? [])
      .filter((i) => i.State?.Code !== 32 && i.State?.Code !== 48)
      .map((i) => ({
        cloudId: i.InstanceId!,
        ip: i.PublicIpAddress!,
        privateIp: i.PrivateIpAddress,
        // Extract just the zone suffix (e.g., "a" from "us-east-1a") to match Azure/GCP pattern
        availabilityZone: i.Placement?.AvailabilityZone?.split('-').pop(),
      }));
  }

  async removeFirewalls(id: string) {
    // Get security group ID for tagging/deletion (id parameter is the group
    // name). GroupName-only APIs fail in accounts/regions without a default
    // VPC, so lookup by filter and delete by GroupId.
    const securityGroup = await this.getSecurityGroupByName(id);
    const securityGroupId = securityGroup?.GroupId;
    if (!securityGroupId) return;
    // Never delete a shared anycloud SG — it is reused across workloads. The
    // lookup is by scope id so it can't normally match a shared name, but
    // guard explicitly in case of a collision.
    if (AWS_SHARED_SG_NAMES.has(securityGroup.GroupName ?? '')) return;
    await this.tagSecurityGroupForDeletion(securityGroupId);

    await deleteWithRetry(
      () =>
        this.ec2client.send(
          new DeleteSecurityGroupCommand({ GroupId: securityGroupId }),
        ),
      `security group ${id}`,
      isAWSNotFound,
      30, // 30 attempts × 10s = 5 min (conservative buffer for NIC detachment)
      10000,
    );
  }

  private async getSecurityGroupByName(id: string) {
    try {
      const resp = await this.ec2client.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: 'group-name', Values: [id] }],
        }),
      );
      return resp.SecurityGroups?.[0];
    } catch (err: any) {
      if (isAWSNotFound(err)) return undefined;
      throw err;
    }
  }

  // VPC-scoped lookup for the shared SG. Group names are unique per VPC (not per
  // account), so the vpc-id filter avoids reusing a same-named SG from another
  // VPC.
  private async getSecurityGroupByNameInVpc(name: string, vpcId: string) {
    try {
      const resp = await this.ec2client.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: 'group-name', Values: [name] },
            { Name: 'vpc-id', Values: [vpcId] },
          ],
        }),
      );
      return resp.SecurityGroups?.[0];
    } catch (err: any) {
      if (isAWSNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * Tag EC2 instances with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagResourcesForDeletion(resourceIds: string[]): Promise<void> {
    if (resourceIds.length === 0) return;

    try {
      await withRetry(
        async () => {
          const endedAt = Date.now().toString();
          await this.ec2client.send(
            new CreateTagsCommand({
              Resources: resourceIds,
              Tags: [{ Key: 'anycloud_ended_at', Value: endedAt }],
            }),
          );
        },
        `tag resources ${resourceIds.join(', ')}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying resource tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged resources with ended_at: ${resourceIds.join(', ')}`);
    } catch (error) {
      log.error(
        `Failed to tag resources ${resourceIds.join(', ')} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', resourceIds, error },
      );
    }
  }

  /**
   * Tag security group with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagSecurityGroupForDeletion(
    securityGroupId: string,
  ): Promise<void> {
    try {
      await withRetry(
        async () => {
          const endedAt = Date.now().toString();
          await this.ec2client.send(
            new CreateTagsCommand({
              Resources: [securityGroupId],
              Tags: [{ Key: 'anycloud_ended_at', Value: endedAt }],
            }),
          );
        },
        `tag security group ${securityGroupId}`,
        {
          maxAttempts: 5,
          waitMs: 2000,
          onRetry: (attempt, max, error) =>
            log.info(
              `Retrying security group tagging (${attempt}/${max}): ${errorMessage(error)}`,
            ),
        },
      );
      log.info(`Tagged security group ${securityGroupId} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag security group ${securityGroupId} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', securityGroupId, error },
      );
    }
  }

  /**
   * Tag S3 bucket with ended_at timestamp before deletion.
   * Does not throw on failure to avoid blocking deletion.
   */
  private async tagBucketForDeletion(
    bucketName: string,
    client?: S3Client,
  ): Promise<void> {
    const s3 = client ?? this.s3client;
    try {
      await withRetry(
        async () => {
          const endedAt = Date.now().toString();

          // Get existing tags
          let existingTags: { Key: string; Value: string }[] = [];
          try {
            const taggingResult = await s3.send(
              new GetBucketTaggingCommand({ Bucket: bucketName }),
            );
            existingTags = (taggingResult.TagSet || []) as {
              Key: string;
              Value: string;
            }[];
          } catch (error: any) {
            // NoSuchTagSet means no tags exist yet
            if (error.name !== 'NoSuchTagSet') {
              throw error;
            }
          }

          // Add ended_at tag
          await s3.send(
            new PutBucketTaggingCommand({
              Bucket: bucketName,
              Tagging: {
                TagSet: [
                  ...existingTags,
                  { Key: 'anycloud_ended_at', Value: endedAt },
                ],
              },
            }),
          );
        },
        `Tag S3 bucket ${bucketName}`,
        {
          maxAttempts: 5,
          waitMs: 1000,
        },
      );
      log.info(`Tagged S3 bucket ${bucketName} with ended_at`);
    } catch (error) {
      log.error(
        `Failed to tag S3 bucket ${bucketName} after 5 retries (non-blocking): ${errorMessage(error)}`,
        { id: 'system', bucketName, error },
      );
    }
  }

  private async requestInstanceTermination(vmId: string): Promise<void> {
    await this.ec2client.send(
      new TerminateInstancesCommand({ InstanceIds: [vmId] }),
    );
  }

  private async terminateVM(vmId: string): Promise<void> {
    const instance = await this.describeInstanceForTermination(vmId);
    // Tag the spot request too, so the request sweep reclaims it if its
    // cancellation never succeeds.
    const spotRequestId = instance?.SpotInstanceRequestId;
    await this.tagResourcesForDeletion(
      spotRequestId ? [vmId, spotRequestId] : [vmId],
    );

    // A failed cancellation must block termination: otherwise AWS reopens the
    // request and launches a replacement instance outside Anycloud's control.
    if (instance) await this.cancelSpotRequestOf(instance);

    const terminatedCode = 48;
    await deleteWithRetry(
      async () => {
        await this.requestInstanceTermination(vmId);
        await createWaiter<EC2Client, DescribeInstancesCommandInput>(
          {
            client: this.ec2client,
            maxWaitTime: 180,
            minDelay: 1,
            maxDelay: 4,
          },
          { InstanceIds: [vmId] },
          async (client, cmd) => {
            const data = await client.send(new DescribeInstancesCommand(cmd));
            for (const reservation of data.Reservations ?? []) {
              for (const instance of reservation.Instances ?? []) {
                if (instance.State?.Code !== terminatedCode)
                  return { state: WaiterState.RETRY };
              }
            }
            return { state: WaiterState.SUCCESS };
          },
        );
      },
      `AWS instance ${vmId}`,
      isAWSNotFound,
      undefined,
      undefined,
      // A denied or revoked key re-fails every attempt; give the error to the
      // caller now instead of after the 5-minute retry chain.
      (error) =>
        !awsPermissionDenial(error) && !this.isTerminalAuthError(error),
    );
  }

  /** The instance a spot request names now, or `listed` if it can't be read. */
  private async spotRequestInstance(
    requestId: string,
    listed: string | undefined,
  ): Promise<string | undefined> {
    try {
      const data = await this.ec2client.send(
        new DescribeSpotInstanceRequestsCommand({
          SpotInstanceRequestIds: [requestId],
        }),
      );
      return data.SpotInstanceRequests?.[0]?.InstanceId ?? listed;
    } catch (error) {
      log.warn('Could not re-read spot request; using its listed instance', {
        requestId,
        error,
      });
      return listed;
    }
  }

  /**
   * The instance by ID, or undefined once AWS no longer knows it. An instance
   * launched seconds ago can read NotFound until DescribeInstances catches up;
   * concluding it is gone then would skip its termination and leave it
   * running. AWS lists a terminated instance for about an hour, so only an
   * instance it forgot long ago spends the ~30 s of retries.
   */
  private async describeInstanceForTermination(
    vmId: string,
  ): Promise<Instance | undefined> {
    try {
      return await withRetry(
        async () => {
          const data = await this.ec2client.send(
            new DescribeInstancesCommand({ InstanceIds: [vmId] }),
          );
          return data.Reservations?.flatMap((r) => r.Instances ?? [])[0];
        },
        `lookup of AWS instance ${vmId}`,
        // Waits of 1, 2, then 4 s: about 30 s in all.
        {
          maxAttempts: 10,
          waitMs: 1000,
          maxWaitMs: 4000,
          jitter: false,
          shouldRetry: isAWSNotFound,
        },
      );
    } catch (error) {
      if (isAWSNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Cancel a spot instance's persistent request by the request ID the instance
   * itself carries. Searching requests by the `instance-id` filter misses a
   * request for about 30 s after launch, and terminating the instance then
   * reopens the request: EC2 relaunches an untagged replacement.
   */
  private async cancelSpotRequestOf(instance: Instance): Promise<void> {
    if (instance.InstanceLifecycle !== 'spot') return;
    const requestId = instance.SpotInstanceRequestId;
    if (!requestId) {
      throw new Error(
        `Spot instance ${instance.InstanceId} names no spot request to cancel`,
      );
    }
    log.info('Canceling persistent spot instance request', {
      requestId,
      instanceId: instance.InstanceId,
    });
    await this.ec2client.send(
      new CancelSpotInstanceRequestsCommand({
        SpotInstanceRequestIds: [requestId],
      }),
    );
  }

  async getInstance(name: string): Promise<GatewayVM> {
    const data = await this.ec2client.send(
      new DescribeInstancesCommand({
        Filters: [
          {
            Name: 'tag:Name',
            Values: [name],
          },
        ],
      }),
    );
    const vms: GatewayVM[] = [];
    (data.Reservations ?? []).forEach((r) => {
      vms.push(...this.getVMsInfo(r));
    });
    const vm = vms.pop();
    if (!vm) {
      throw new Error(`Instance ${name} not found`);
    }
    return vm;
  }

  /** Report region opt-in and zero-quota facts for exact candidate pairs. */
  private createCandidateRegionFilter() {
    return createCandidateRegionFilter({
      cache: awsCandidatePreflightCache,
      cacheKey: ({ candidates, spot }) =>
        JSON.stringify([
          this.credentialIdentity,
          spot,
          exactCandidatePairsKey(candidates),
        ]),
      operationName: ({ workloadId }) =>
        `read AWS candidate availability for ${workloadId}`,
      runPreflight: ({ candidates, spot, workloadId, signal }) =>
        this.runCandidatePreflight(candidates, spot, workloadId, signal),
      isComplete: (snapshot) => snapshot.complete,
      assess: (snapshot, candidate) => {
        if (!snapshot.enabled.has(candidate.region)) {
          return CandidateRegionAvailability.Unavailable;
        }
        if (
          snapshot.unknownByVmType.get(candidate.vmType)?.has(candidate.region)
        ) {
          return CandidateRegionAvailability.Unknown;
        }
        if (
          snapshot.zeroByVmType.get(candidate.vmType)?.has(candidate.region)
        ) {
          return CandidateRegionAvailability.Unavailable;
        }
        return CandidateRegionAvailability.Verified;
      },
    });
  }

  private async runCandidatePreflight(
    candidates: CandidateRegion[],
    spot: boolean,
    workloadId: string,
    signal: AbortSignal,
  ): Promise<AwsCandidateAvailabilitySnapshot> {
    const provider = new AwsQuotaProvider(this.credentials);

    const enabled = await withRetry(
      () => provider.getEnabledRegions(signal),
      'list AWS opted-in regions',
      {
        maxAttempts: 3,
        waitMs: 1000,
        exponentialBackoff: false,
        signal,
      },
    );

    // Build a per-vmType set of regions where vCPU quota is 0. Quota code is
    // constant across regions for a given (vmType, spot), so this is one
    // GetServiceQuota call per exact enabled pair the optimizer proposed.
    const enabledRegionsByVmType = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      if (!enabled.has(candidate.region)) continue;
      let regions = enabledRegionsByVmType.get(candidate.vmType);
      if (!regions) {
        regions = new Set<string>();
        enabledRegionsByVmType.set(candidate.vmType, regions);
      }
      regions.add(candidate.region);
    }

    const zeroByVmType = new Map<string, Set<string>>();
    const unknownByVmType = new Map<string, Set<string>>();
    let quotaComplete = true;
    await Promise.all(
      [...enabledRegionsByVmType].map(async ([vmType, regionSet]) => {
        const regions = [...regionSet];
        try {
          const zeroResult = await withRetry(
            () => provider.getZeroQuotaRegions(vmType, spot, regions, signal),
            `list AWS zero-quota regions for ${vmType}`,
            {
              maxAttempts: 3,
              waitMs: 1000,
              exponentialBackoff: false,
              signal,
            },
          );
          if (!zeroResult.complete) quotaComplete = false;
          zeroByVmType.set(vmType, zeroResult.zeroRegions);
          unknownByVmType.set(vmType, zeroResult.unknownRegions);
        } catch (err) {
          quotaComplete = false;
          unknownByVmType.set(vmType, new Set(regions));
          log.warn('Failed to query AWS service quotas for candidate VM type', {
            id: workloadId,
            vmType,
            error: err,
          });
        }
      }),
    );

    return {
      enabled,
      zeroByVmType,
      unknownByVmType,
      complete: quotaComplete,
    };
  }

  /**
   * Check if VM was spot-interrupted (stopped or stopping) and needs recovery.
   * Returns true only for stopped/stopping — states produced by spot interruption.
   * Returns false for shutting-down/terminated (instance was deleted, not interrupted).
   * Retries to handle API propagation delays when VM is being preempted.
   */
  private async verifyVMPreemption(cloudId: string): Promise<boolean> {
    // State codes: 16=running, 32=shutting-down, 48=terminated, 64=stopping, 80=stopped
    // Spot interruption with InstanceInterruptionBehavior:stop → stopping(64) → stopped(80).
    // shutting-down(32) and terminated(48) mean the instance was deleted — do NOT revive.
    const isPreempted = (stateCode: number | null | undefined) =>
      stateCode === 64 || stateCode === 80;
    try {
      const result = await withRetry(
        async () => {
          try {
            const response = await this.ec2client.send(
              new DescribeInstancesCommand({
                InstanceIds: [cloudId],
              }),
            );

            if (!response.Reservations || response.Reservations.length === 0) {
              return { found: false, stateCode: null, stateName: null };
            }

            const instance = response.Reservations[0].Instances?.[0];
            if (!instance) {
              return { found: false, stateCode: null, stateName: null };
            }

            const stateCode = instance.State?.Code;
            const stateName = instance.State?.Name;

            return { found: true, stateCode, stateName };
          } catch (error) {
            if (isAWSNotFound(error)) {
              return { found: false, stateCode: null, stateName: null };
            }
            throw error;
          }
        },
        `AWS VM preemption check for ${cloudId}`,
        { maxAttempts: 3, waitMs: 2000, exponentialBackoff: false },
      );

      if (!result.found) {
        log.warn('AWS instance not found (cannot verify preemption)', {
          cloudId,
        });
        return false;
      }

      if (isPreempted(result.stateCode)) {
        log.info('AWS VM is stopped (spot interrupted)', {
          cloudId,
          stateCode: result.stateCode,
          stateName: result.stateName,
        });
        return true;
      }

      log.info('AWS VM is running or terminated (not a spot interruption)', {
        cloudId,
        stateCode: result.stateCode,
        stateName: result.stateName,
      });
      return false;
    } catch (error) {
      log.error('AWS VM state check failed', {
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
    // State codes: 32=shutting-down, 48=terminated → irrecoverable
    // 64=stopping, 80=stopped → recoverable (preemption reconciliation handles these)
    const isTerminal = (stateCode: number | null | undefined) =>
      stateCode === 32 || stateCode === 48;
    let terminationObserved = false;
    try {
      const result = await withRetry(
        async () => {
          try {
            const response = await this.ec2client.send(
              new DescribeInstancesCommand({ InstanceIds: [cloudId] }),
              { abortSignal: options.signal },
            );
            if (!response.Reservations || response.Reservations.length === 0) {
              terminationObserved = true;
              return { found: false, stateCode: null, stateName: null };
            }
            const instance = response.Reservations[0].Instances?.[0];
            if (!instance) {
              terminationObserved = true;
              return { found: false, stateCode: null, stateName: null };
            }
            terminationObserved = isTerminal(instance.State?.Code);
            return {
              found: true,
              stateCode: instance.State?.Code,
              stateName: instance.State?.Name,
            };
          } catch (error) {
            if (isAWSNotFound(error)) {
              terminationObserved = true;
              return { found: false, stateCode: null, stateName: null };
            }
            throw error;
          }
        },
        `AWS VM terminated check for ${cloudId}`,
        {
          maxAttempts: 3,
          waitMs: 2000,
          exponentialBackoff: false,
          signal: options.signal,
        },
      );

      if (!result.found) {
        log.info('AWS instance not found (terminated)', { cloudId });
        return VM_RELEASE_CANDIDATE;
      }

      if (isTerminal(result.stateCode)) {
        log.info('AWS VM is in terminal state', {
          cloudId,
          stateCode: result.stateCode,
          stateName: result.stateName,
        });
        return VM_RELEASE_CANDIDATE;
      }

      return VM_PRESENT;
    } catch (error) {
      // Some SDK work cannot be interrupted immediately. Preserve definitive,
      // irreversible evidence returned just after the caller's deadline.
      if (terminationObserved) return VM_RELEASE_CANDIDATE;
      log.error('AWS VM terminated check failed', {
        id: cloudId,
        error: error,
      });
      return vmReleaseUnknown(error);
    }
  }

  private async startVM(cloudId: string): Promise<string | null> {
    const attempt = new VMRestartAttempt(`AWS VM restart for ${cloudId}`);
    let startAccepted = false;
    let consecutiveSettled = 0;
    let consecutiveReady = 0;
    let lastInstance: Instance | undefined;
    let lastRequest: SpotInstanceRequest | undefined;
    try {
      log.info('Attempting to start stopped AWS instance', { cloudId });
      while (Date.now() < attempt.deadlineAt) {
        try {
          const response = await attempt.run(() =>
            this.ec2client.send(
              new DescribeInstancesCommand({ InstanceIds: [cloudId] }),
              { abortSignal: attempt.signal },
            ),
          );
          lastInstance = response.Reservations?.[0]?.Instances?.[0];
          const state = lastInstance?.State?.Code;
          const ip = lastInstance?.PublicIpAddress;
          // Stopped is recoverable. Shutting down and terminated are not.
          if (state === 32 || state === 48) {
            throw new Error(
              `AWS VM ${cloudId} is ${lastInstance?.State?.Name}`,
            );
          }
          consecutiveReady = state === 16 && ip ? consecutiveReady + 1 : 0;
          let canStart = state === 80 && !startAccepted;
          if (
            canStart &&
            (this.spot || lastInstance?.InstanceLifecycle === 'spot')
          ) {
            canStart = false;
            const requestId = lastInstance?.SpotInstanceRequestId;
            if (requestId) {
              const requests = await attempt.run(() =>
                this.ec2client.send(
                  new DescribeSpotInstanceRequestsCommand({
                    SpotInstanceRequestIds: [requestId],
                  }),
                  { abortSignal: attempt.signal },
                ),
              );
              lastRequest = requests.SpotInstanceRequests?.[0];
              if (
                ['cancelled', 'closed', 'failed'].includes(
                  lastRequest?.State ?? '',
                )
              ) {
                throw new Error(
                  `AWS Spot request for ${cloudId} is ${lastRequest?.State}`,
                );
              }
              // A stopped VM can precede its request becoming restartable by
              // minutes. EC2 resumes service-interrupted requests itself; only
              // a settled user stop authorizes our explicit StartInstances.
              canStart =
                lastRequest?.InstanceId === cloudId &&
                lastRequest.State === 'disabled' &&
                lastRequest.Status?.Code === 'instance-stopped-by-user';
            }
          }
          consecutiveSettled = canStart ? consecutiveSettled + 1 : 0;
          log.info('AWS VM restart observation', {
            cloudId,
            elapsedMs: Date.now() - attempt.startedAt,
            state: lastInstance?.State,
            spotRequestState: lastRequest?.State,
            spotRequestStatus: lastRequest?.Status?.Code,
            startAccepted,
            consecutiveSettled,
            consecutiveReady,
          });
          attempt.remainingMs();
          if (consecutiveReady >= VM_RESTART_CONSECUTIVE_OBSERVATIONS) {
            return ip!;
          }
          if (consecutiveSettled >= VM_RESTART_CONSECUTIVE_OBSERVATIONS) {
            await attempt.run(() =>
              this.ec2client.send(
                new StartInstancesCommand({ InstanceIds: [cloudId] }),
                { abortSignal: attempt.signal },
              ),
            );
            startAccepted = true;
            consecutiveSettled = 0;
            // Stale stopped observations after acceptance do not authorize
            // another start or replacement; keep observing within this budget.
          }
        } catch (error) {
          attempt.remainingMs();
          if (
            !isAWSNotFound(error) &&
            !isAWSErrorCode(error, 'InvalidSpotInstanceRequestID.NotFound') &&
            !isAwsRestartRetryable(error)
          )
            throw error;
          consecutiveSettled = 0;
          consecutiveReady = 0;
          log.info('Retrying AWS VM restart recovery', {
            cloudId,
            elapsedMs: Date.now() - attempt.startedAt,
            error: errorMessage(error),
          });
        }
        await attempt.wait();
      }
      throw new Error(`AWS VM restart for ${cloudId} deadline exceeded`);
    } catch (error) {
      log.warn('Failed to start AWS instance', {
        cloudId,
        elapsedMs: Date.now() - attempt.startedAt,
        state: lastInstance?.State,
        spotRequestState: lastRequest?.State,
        spotRequestStatus: lastRequest?.Status?.Code,
        error,
      });
      return null;
    } finally {
      attempt.abort();
    }
  }

  // TerminalAuthErrorClassifier: only an unrecognized access key id (the stored
  // AKIA is deleted/wrong) re-fails until the secret is re-entered. Everything
  // else classifyError lumps into BadCredential is transient or not-a-secret —
  // SignatureDoesNotMatch/RequestExpired = clock skew, ExpiredToken* = expired
  // STS session, Blocked = account hold, AuthFailure = EC2 catch-all that also
  // fires on clock skew + new-key propagation — so those follow the ordinary
  // retry policy.
  private static readonly TERMINAL_INVALID_SECRET_CODES = new Set([
    'InvalidClientTokenId',
    'InvalidClientToken',
    // A role connection's trust refuses the API's token until it is fixed.
    'InvalidIdentityTokenException',
    'IDPRejectedClaimException',
  ]);

  isTerminalAuthError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as { Code?: unknown; code?: unknown; name?: unknown };
    // Same field precedence classifyError uses below.
    const code = err.Code ?? err.code ?? err.name;
    return (
      typeof code === 'string' && AWS.TERMINAL_INVALID_SECRET_CODES.has(code)
    );
  }

  private classifyError(error: unknown): CloudFailureDiagnosis {
    if (error instanceof InvalidAnycloudConfigError)
      return CloudFailureDiagnosis.InvalidRequest;
    if (!error || typeof error !== 'object')
      return CloudFailureDiagnosis.TemporaryProviderFailure;
    const err = error as any;
    const code = err.Code ?? err.code ?? err.name;
    if (typeof code !== 'string')
      return CloudFailureDiagnosis.TemporaryProviderFailure;
    const errMsg = err.message ?? err.Message ?? '';

    // Target-specific: VM type not available in region
    if (code === 'InvalidInstanceType' || code === 'Unsupported')
      return CloudFailureDiagnosis.InvalidTarget;

    // A nonexistent/typo'd instance type comes back under the generic
    // InvalidParameterValue code (not InvalidInstanceType). Match the message —
    // like GCP's "Invalid value for field 'resource.machineType'" — so a pinned
    // region escalates to terminal Invalid instead of retrying until timeout.
    //   "Invalid value 'totally_fake_nonexistent_vm' for InstanceType."
    if (errMsg.includes('for InstanceType'))
      return CloudFailureDiagnosis.InvalidTarget;

    // Some AWS accounts/regions do not have a default VPC. Treat that as a
    // target constraint so provisioning rotates instead of retrying until the
    // workload timeout.
    if (code === 'VPCIdNotSpecified')
      return CloudFailureDiagnosis.InvalidTarget;

    // Region not opted in on this account. Durable per-account — rotate away
    // for 6h (InvalidTarget) instead of terminating as invalid-request.
    if (
      code === 'OptInRequired' ||
      (code === 'UnauthorizedOperation' && /opt.?in/i.test(errMsg))
    )
      return CloudFailureDiagnosis.InvalidTarget;

    // S3 against a not-opted-in regional endpoint returns a body the SDK's
    // REST-XML protocol can't parse, so it throws an HTTP 400 with no Code.
    // Same root cause as OptInRequired but leaks through a different SDK path,
    // and the SDK surfaces it two ways: name "Unknown" / message "UnknownError"
    // (caught by the code check) and name "Error" / message "Unknown" (code
    // falls back to "Error", so the message must be checked too). Without this
    // it used to fall through to temporary-provider-failure. That made an
    // opaque provider rejection look like a retryable blip and could keep a
    // pinned workload in Retrying for the full generic retry budget.
    const httpStatus = err.$metadata?.httpStatusCode ?? err.statusCode;
    if (
      httpStatus === 400 &&
      (code === 'Unknown' ||
        code === 'UnknownError' ||
        (code === 'Error' && errMsg.trim() === 'Unknown'))
    )
      return CloudFailureDiagnosis.ProvisioningRejected;

    // Spot limit errors are account- and region-scoped quota failures, not
    // target-specific capacity failures.
    const spotAccountCodes = new Set([
      'SpotInstanceCountExceeded',
      'MaxSpotInstanceCountExceeded',
    ]);
    if (spotAccountCodes.has(code)) {
      return CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted;
    }

    // Account-level quota errors — `anycloud quota` CLI is the right next step.
    const quotaCodes = new Set([
      'InstanceLimitExceeded',
      'VcpuLimitExceeded',
      'NetworkInterfaceLimitExceeded',
    ]);
    if (quotaCodes.has(code)) {
      // Quota literally = 0 is ~permanent until the user files an increase,
      // so classify as InvalidTarget (6h block) instead of the 30-min generic
      // quota block. AWS surfaces the limit in the message, e.g.
      // "current vCPU limit of 0".
      if (/\blimit of 0\b/i.test(errMsg))
        return CloudFailureDiagnosis.InvalidTarget;
      return CloudFailureDiagnosis.QuotaExhaustedRegion;
    }

    // Capacity errors — AWS has no spare hardware right now. Same block +
    // region rotation as quota, but distinct so the status hint doesn't
    // mislead users into running `anycloud quota` (which can't help).
    const capacityCodes = new Set([
      'InsufficientInstanceCapacity',
      'InsufficientSpotCapacity',
      'InsufficientFreeAddressesInSubnet',
    ]);
    if (capacityCodes.has(code)) return CloudFailureDiagnosis.CapacityExhausted;

    // Region/AZ mismatch: AWS returns these under generic codes
    // (InvalidParameterValue, Unsupported) with a region-phrase message.
    // Match on message so the optimizer rotates regions instead of giving
    // up on the first attempt.
    //
    // Two tight patterns (no wildcard gaps — proximity-bounded) cover the
    // real-world strings we've seen. Keep this list as the spec when
    // editing; if a new phrasing shows up, add it here with an example.
    //
    // Forward: "… is not available in <the|your|your requested|a> <zone>"
    //   "The instance type 'p5.48xlarge' is not available in the Availability Zone us-east-1a."
    //   "The requested instance type is not supported in your requested Availability Zone us-east-1a."
    //
    // Reverse: "<zone> <token> does not support …"
    //   "Region us-east-2 does not support the specified instance type."
    //   "Availability Zone us-east-1a does not support c5.xlarge."
    //
    // Deliberately NOT matched:
    //   - "Service temporarily unavailable" / "currently unavailable"
    //     (temporary provider failure — retry with backoff)
    //   - "does not support tagging" / unrelated "not supported" phrases
    //     without an adjacent zone token (no wildcard gap)
    if (
      /(?:not available|not supported) in (?:the |your |your requested |a )?(?:availability zone|region|az)\b/i.test(
        errMsg,
      ) ||
      /\b(?:region|availability zone|az) \S+ (?:does not support|is not supported)\b/i.test(
        errMsg,
      )
    )
      return CloudFailureDiagnosis.InvalidTarget;

    if (awsPermissionDenial(error))
      return CloudFailureDiagnosis.PermissionDenied;

    // Auth-class errors: BadCredential. The workload terminates as Invalid
    // (same as invalid-request downstream).
    const authErrors = new Set([
      'InvalidClientTokenId',
      'SignatureDoesNotMatch',
      'ExpiredToken',
      'ExpiredTokenException',
      'RequestExpired',
      'InvalidClientToken',
      'AuthFailure',
      'Blocked',
      'InvalidIdentityTokenException',
      'IDPRejectedClaimException',
    ]);
    if (authErrors.has(code)) return CloudFailureDiagnosis.BadCredential;

    // Config / marketplace user errors — each code here must be
    // UNAMBIGUOUSLY a caller/config problem that cannot be fixed by
    // retrying in another region or rotating creds. Do NOT add generic
    // codes like 'InvalidParameterValue' or 'ValidationError' — AWS
    // reuses those for region/instance-type mismatch errors too, and
    // misclassifying one as invalid-request sends the workload to terminal
    // Invalid on the first attempt instead of letting the optimizer
    // rotate regions. If in doubt, leave the code out of this set —
    // temporary-provider-failure (the default) will retry with bounded attempts
    // and surface a clearer exhaustion error.
    const userErrors = new Set([
      'InvalidBucketName',
      'BucketAlreadyExists',
      'MarketplacePurchaseEligibilityFailed',
    ]);
    if (userErrors.has(code)) return CloudFailureDiagnosis.InvalidRequest;

    return CloudFailureDiagnosis.TemporaryProviderFailure;
  }
}
