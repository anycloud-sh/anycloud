/**
 * Format and classify errors for user-facing display.
 * Converts technical error objects into actionable messages.
 * Classifies errors as user-input vs infrastructure (isUserError).
 */

import { CloudType } from './cloud.js';
import { DeployError } from './errors.js';
import type { ImageArchitecture } from './image.js';

/**
 * Standard Error with optional code property
 * Used for errors that need to convey a specific error code (e.g., KEY_CREATION_DISABLED)
 */
export interface ErrorWithCode extends Error {
  code?: string;
}

interface AWSError {
  message?: string;
  Code?: string;
  name?: string;
  $metadata?: {
    httpStatusCode?: number;
    requestId?: string;
  };
  $fault?: string;
}

interface AzureError {
  message?: string;
  code?: string;
  statusCode?: number;
  name?: string;
}

interface GCPError {
  message?: string;
  code?: number | string; // gRPC code (number) or string
  statusCode?: number;
  name?: string;
}

/**
 * AWS error codes mapped to user-friendly messages
 * Only include errors where we want custom messages better than AWS's
 */
const AWS_ERROR_MESSAGES: Record<string, string> = {
  // IAM/Auth errors
  AccessDenied:
    'Access denied. Check your AWS credentials have required permissions.',
  UnauthorizedOperation:
    'Unauthorized. Your AWS credentials lack permissions for this operation.',
  InvalidClientTokenId: 'Invalid AWS credentials. Check your access key ID.',
  SignatureDoesNotMatch:
    'Invalid AWS credentials. Check your secret access key.',
  ExpiredToken: 'AWS credentials expired. Refresh your session token.',
  RequestExpired:
    'AWS request expired. Check your system clock and credentials.',
  InvalidClientToken: 'Invalid AWS credentials. Check your access key.',

  // EC2 errors
  InvalidParameterValue: 'Invalid parameter value.',
  InvalidParameterCombination: 'Invalid parameter combination.',
  InstanceLimitExceeded:
    'Instance limit exceeded. Request a quota increase or use a different region.',
  InsufficientInstanceCapacity:
    'Insufficient capacity. Try a different instance type or region.',
  VcpuLimitExceeded:
    'vCPU limit exceeded. Request a quota increase or use fewer/smaller instances.',
  InvalidAMIID: 'Invalid AMI ID. Check the AMI exists in your region.',
  InvalidKeyPair: 'Invalid key pair. Check the key pair name is correct.',
  InvalidGroup: 'Invalid security group. Check the security group exists.',
  InvalidSubnet: 'Invalid subnet. Check the subnet exists in your VPC.',
  InvalidInstanceType:
    'Invalid instance type. Check the type is available in your region.',

  // Spot instance errors
  SpotMaxPriceTooLow:
    'Spot bid too low. Increase max price or use on-demand instances.',
  InsufficientSpotCapacity:
    'No spot capacity available. Try a different instance type or region.',
  SpotInstanceCountExceeded:
    'Spot instance limit exceeded. Request quota increase or reduce spot instances.',

  // Marketplace errors
  MarketplacePurchaseEligibilityFailed:
    'AWS Marketplace terms not accepted. Visit AWS Marketplace to accept terms for this AMI.',
  OptInRequired:
    'Marketplace subscription required. Subscribe to this product in AWS Marketplace.',

  // S3 errors
  NoSuchBucket: 'Bucket does not exist.',
  BucketAlreadyExists: 'Bucket name already taken globally.',
  BucketAlreadyOwnedByYou: 'Bucket already exists in your account.',
  InvalidBucketName: 'Invalid bucket name. Check S3 naming requirements.',
  NoSuchKey: 'S3 object does not exist.',

  // Network/capacity errors
  NetworkInterfaceLimitExceeded:
    'Network interface limit exceeded. Delete unused interfaces or request quota increase.',
  InsufficientFreeAddressesInSubnet:
    'No free IP addresses in subnet. Try a different region or clean up unused network interfaces.',
  InvalidVPC: 'Invalid VPC. Check the VPC exists.',
  InvalidAvailabilityZone:
    'Invalid availability zone. Check the zone is valid for your region.',
};

/**
 * Azure error codes mapped to user-friendly messages
 * Only include errors where we want custom messages better than Azure's
 */
const AZURE_ERROR_MESSAGES: Record<string, string> = {
  // Authorization errors
  AuthorizationFailed:
    'Access denied. Check your Azure credentials have required permissions.',
  InvalidAuthenticationToken:
    'Invalid Azure credentials. Check your authentication token.',
  InvalidAuthenticationTokenTenant:
    'Invalid Azure tenant. Check your tenant ID.',
  ExpiredAuthenticationToken:
    'Azure authentication expired. Re-authenticate with Azure.',
  InvalidSubscriptionId:
    'Invalid Azure subscription. Check your subscription ID.',

  // Quota/capacity errors
  QuotaExceeded:
    'Quota exceeded. Request a quota increase or use a different region.',
  SkuNotAvailable: 'VM size not available. Try a different size or region.',
  OperationNotAllowed:
    'Operation not allowed. Check resource state and permissions.',
  LocationNotAvailableForResourceType:
    'Resource type not available in this region. Try a different region.',
  AllocationFailed:
    'Azure allocation failed. Try a different VM size or region.',
  OverconstrainedAllocationRequest:
    'Azure allocation overconstrained. Try a different VM size or region.',
  ReadOnlyDisabledSubscription:
    'Azure subscription is disabled or read-only. Check your subscription status.',

  // Resource errors
  ResourceNotFound: 'Resource not found.',
  ResourceGroupNotFound: 'Resource group not found.',
  ConflictError: 'Resource conflict. It may already exist.',
  ResourceGroupBeingDeleted:
    'Resource group is being deleted. Wait or use a different group.',
  InvalidResourceName:
    'Invalid resource name. Azure names must only contain letters, numbers and hyphens, and must not start or end with a hyphen.',
  InvalidResourceType: 'Invalid resource type.',

  // Network errors
  NetworkInterfaceNotFound: 'Network interface not found.',
  PublicIPAddressNotFound: 'Public IP address not found.',
  SubnetNotFound: 'Subnet not found.',
  VirtualNetworkNotFound: 'Virtual network not found.',
  SecurityGroupNotFound: 'Security group (NSG) not found.',

  // Storage errors
  StorageAccountAlreadyExists: 'Storage account name already taken globally.',
  StorageAccountNotFound: 'Storage account not found.',
  InvalidStorageAccountName:
    'Invalid storage account name. Check Azure naming requirements.',
  ContainerNotFound: 'Storage container not found.',
};

/**
 * GCP error names/codes mapped to user-friendly messages
 * Only include errors where we want custom messages better than GCP's
 */
const GCP_ERROR_MESSAGES: Record<string, string> = {
  PERMISSION_DENIED:
    'Access denied. Check your GCP credentials have required permissions.',
  RESOURCE_EXHAUSTED: 'GCP quota exceeded. Request quota increase.',
  ZONE_RESOURCE_POOL_EXHAUSTED:
    'GCP zone capacity exhausted. Try a different zone or region.',
  INVALID_ARGUMENT: 'Invalid parameter. Check your request parameters.',
  NOT_FOUND: 'GCP resource not found.',
  ALREADY_EXISTS: 'GCP resource already exists.',
  UNAVAILABLE: 'GCP service unavailable. Try again in a few moments.',
};

/**
 * Generic HTTP status codes (used as last resort fallback)
 */
const HTTP_STATUS_MESSAGES: Record<number, string> = {
  301: 'Resource moved. This may indicate a region or configuration mismatch.',
  400: 'Bad request. Check workload parameters.',
  401: 'Authentication failed. Check your credentials.',
  403: 'Access denied. Check your permissions.',
  404: 'Resource not found.',
  409: 'Resource conflict. It may already exist.',
  429: 'Rate limited. Try again in a few moments.',
  500: 'Cloud provider error. Try again or contact support.',
  503: 'Service unavailable. Try again in a few moments.',
};

/**
 * Format AWS errors
 */
function formatAWSError(err: AWSError): string {
  const code = err.Code;
  const httpStatus = err.$metadata?.httpStatusCode;

  // AWS SDK couldn't parse the error body — typical for S3/EC2 calls against
  // an opt-in region the account hasn't enabled, where the response isn't the
  // usual XML/JSON error format. The generic "Bad request. Check workload
  // parameters." HTTP-400 fallback is misleading here (parameters are fine —
  // the region just isn't enabled), so point at the actual likely cause.
  // Predicate mirrors classifyError in aws.ts so messaging and routing agree.
  const matchCode = err.Code ?? err.name;
  const message = err.message ?? '';
  if (
    httpStatus === 400 &&
    (matchCode === 'Unknown' ||
      matchCode === 'UnknownError' ||
      (matchCode === 'Error' && message.trim() === 'Unknown'))
  ) {
    const reqId = err.$metadata?.requestId;
    const idHint = reqId ? ` (request id: ${reqId})` : '';
    return `AWS returned HTTP 400 with an unparseable response${idHint}. Likely cause: region not opted in for this account, or a bucket-region mismatch. The optimizer will rotate to a different region.`;
  }

  // 1. Check if we have a custom message for this error code
  if (code && AWS_ERROR_MESSAGES[code]) {
    return AWS_ERROR_MESSAGES[code];
  }

  // 2. Use AWS's error message if available
  if (err.message && err.message !== 'UnknownError') {
    if (code) {
      return `${err.message} (${code})`;
    }
    if (httpStatus) {
      return `${err.message} (HTTP ${httpStatus})`;
    }
    return err.message;
  }

  // 3. Fallback to error code
  if (code) {
    return code;
  }

  // 4. Fallback to HTTP status
  if (httpStatus && HTTP_STATUS_MESSAGES[httpStatus]) {
    return HTTP_STATUS_MESSAGES[httpStatus];
  }
  if (httpStatus) {
    return `HTTP ${httpStatus}`;
  }

  // 5. Extract from nested Error object or Type field
  // Check for Error object
  const errorObj = (err as any).Error;
  if (errorObj && typeof errorObj === 'object') {
    const errorCode = errorObj.Code || errorObj.Type;
    const errorMessage = errorObj.Message || errorObj.message;
    if (errorMessage && errorCode) {
      return `${errorMessage} (${errorCode})`;
    }
    if (errorMessage) {
      return errorMessage;
    }
    if (errorCode) {
      return errorCode;
    }
  }

  // Check for Type field (e.g., "Sender", "Receiver")
  const errorType = (err as any).Type;
  if (errorType) {
    return `AWS error (Type: ${errorType})`;
  }

  // 6. Last resort: pretty-print error (strip SDK internal fields for readability)
  const cleanedError: Record<string, unknown> = {};
  for (const key in err) {
    // Skip AWS SDK internal fields ($metadata, $fault, $retryable, name)
    if (!key.startsWith('$') && key !== 'name') {
      cleanedError[key] = (err as any)[key];
    }
  }
  const stringified = JSON.stringify(cleanedError, null, 2);
  if (stringified && stringified !== '{}') {
    return stringified;
  }

  return 'AWS error';
}

/**
 * Format Azure errors
 */
function formatAzureError(err: AzureError): string {
  const code = err.code;
  const httpStatus = err.statusCode;
  let message = err.message;
  const err2 = err as any;

  // 1. Check for nested error structures FIRST (before checking code)
  // Check for error.error property (common in Azure REST errors)
  if (err2.error && typeof err2.error === 'object') {
    const nestedMessage = err2.error.message || err2.error.Message;
    const nestedCode = err2.error.code || err2.error.Code;
    if (nestedMessage && nestedCode) {
      return `${nestedMessage} (${nestedCode})`;
    }
    if (nestedMessage) {
      return nestedMessage;
    }
    if (nestedCode && AZURE_ERROR_MESSAGES[nestedCode]) {
      return AZURE_ERROR_MESSAGES[nestedCode];
    }
  }

  // Check for body.error property
  if (err2.body && typeof err2.body === 'object' && err2.body.error) {
    const bodyError = err2.body.error;
    const bodyMessage = bodyError.message || bodyError.Message;
    const bodyCode = bodyError.code || bodyError.Code;
    if (bodyMessage && bodyCode) {
      return `${bodyMessage} (${bodyCode})`;
    }
    if (bodyMessage) {
      return bodyMessage;
    }
    if (bodyCode && AZURE_ERROR_MESSAGES[bodyCode]) {
      return AZURE_ERROR_MESSAGES[bodyCode];
    }
  }

  // 2. Check if we have a custom message for this error code
  if (code && AZURE_ERROR_MESSAGES[code]) {
    return AZURE_ERROR_MESSAGES[code];
  }

  // 3. Azure sometimes wraps errors in JSON - extract the actual message
  if (message && message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message);
      // Rate limit format: {"Error":{"Details":[{"Message":"..."}]}}
      if (parsed.Error?.Details?.[0]?.Message) {
        message = parsed.Error.Details[0].Message;
      }
      // Other Azure error formats
      else if (parsed.Error?.Message) {
        message = parsed.Error.Message;
      } else if (parsed.message) {
        message = parsed.message;
      }
    } catch {
      // If parsing fails, use original message
    }
  }

  // 4. Use Azure's error message if available
  if (message && message !== 'UnknownError') {
    if (code) {
      return `${message} (${code})`;
    }
    if (httpStatus) {
      return `${message} (HTTP ${httpStatus})`;
    }
    return message;
  }

  // 5. Fallback to error code
  if (code) {
    return code;
  }

  // 6. Fallback to HTTP status
  if (httpStatus && HTTP_STATUS_MESSAGES[httpStatus]) {
    return HTTP_STATUS_MESSAGES[httpStatus];
  }
  if (httpStatus) {
    return `HTTP ${httpStatus}`;
  }

  // 7. Last resort: pretty-print error (strip SDK internal fields for readability)
  const cleanedError: Record<string, unknown> = {};
  for (const key in err2) {
    // Skip Azure SDK internal fields (request, response, stack, name)
    if (
      key !== 'name' &&
      key !== 'request' &&
      key !== 'response' &&
      key !== 'stack'
    ) {
      cleanedError[key] = err2[key];
    }
  }
  const stringified = JSON.stringify(cleanedError, null, 2);
  if (stringified && stringified !== '{}') {
    return stringified;
  }

  return 'Azure error';
}

/**
 * Format GCP errors
 */
function formatGCPError(err: GCPError): string {
  const code = err.code;
  const httpStatus = err.statusCode;
  const name = err.name;
  const err2 = err as any;

  // 1. Check for errors array FIRST (GCP often includes detailed errors array)
  if (err2.errors && Array.isArray(err2.errors) && err2.errors.length > 0) {
    const firstError = err2.errors[0];
    const errorMessage = firstError.message || firstError.Message;
    const errorReason = firstError.reason;
    if (errorMessage && errorReason) {
      return `${errorMessage} (reason: ${errorReason})`;
    }
    if (errorMessage) {
      return errorMessage;
    }
    if (errorReason) {
      return `GCP error (reason: ${errorReason})`;
    }
  }

  // 2. Check for details array (gRPC-style errors)
  if (err2.details && Array.isArray(err2.details) && err2.details.length > 0) {
    const firstDetail = err2.details[0];
    if (typeof firstDetail === 'string') {
      return firstDetail;
    }
    if (firstDetail && typeof firstDetail === 'object') {
      const detailMessage =
        firstDetail.message || firstDetail.description || firstDetail.detail;
      if (detailMessage) {
        return detailMessage;
      }
    }
  }

  // 3. Check if we have a custom message for error name (e.g., PERMISSION_DENIED)
  if (
    name &&
    name !== 'Error' &&
    name !== 'UnknownError' &&
    GCP_ERROR_MESSAGES[name]
  ) {
    return GCP_ERROR_MESSAGES[name];
  }

  // 4. Check gRPC code (8 = RESOURCE_EXHAUSTED)
  const grpcCodeNames: Record<number, string> = {
    8: 'RESOURCE_EXHAUSTED',
  };
  if (typeof code === 'number' && grpcCodeNames[code]) {
    const codeName = grpcCodeNames[code];
    if (GCP_ERROR_MESSAGES[codeName]) {
      return GCP_ERROR_MESSAGES[codeName];
    }
  }

  // 5. Use GCP's error message if available
  if (err.message && err.message !== 'UnknownError') {
    if (name && name !== 'Error' && name !== 'UnknownError') {
      return `${err.message} (${name})`;
    }
    if (code) {
      return `${err.message} (code: ${code})`;
    }
    if (httpStatus) {
      return `${err.message} (HTTP ${httpStatus})`;
    }
    return err.message;
  }

  // 6. Fallback to error name or code
  if (name && name !== 'Error' && name !== 'UnknownError') {
    return name;
  }
  if (code) {
    return `GCP error code ${code}`;
  }

  // 7. Fallback to HTTP status
  if (httpStatus && HTTP_STATUS_MESSAGES[httpStatus]) {
    return HTTP_STATUS_MESSAGES[httpStatus];
  }
  if (httpStatus) {
    return `HTTP ${httpStatus}`;
  }

  // 8. Last resort: pretty-print the error object (strip response/errors for readability)
  const cleanedError: Record<string, unknown> = {};
  for (const key in err) {
    // Skip response object and errors array (already checked above)
    if (key !== 'response' && key !== 'errors') {
      cleanedError[key] = (err as any)[key];
    }
  }
  const stringified = JSON.stringify(cleanedError, null, 2);
  if (stringified && stringified !== '{}') {
    return stringified;
  }

  return 'GCP error';
}

/**
 * Format error for user-facing display
 *
 * @param error The error object to format
 * @param cloud The cloud provider
 * @returns User-friendly error message
 */
export function formatErrorForUser(
  error: unknown,
  cloud: CloudType | null | undefined,
): string {
  // Handle string errors
  if (typeof error === 'string') {
    return error;
  }

  // Handle null/undefined
  if (!error) {
    return 'Unknown error';
  }

  // Handle error objects
  if (typeof error === 'object') {
    const err = error as any;

    // Priority 1: Container logs (most detailed, shows actual error output)
    if (err.logs && typeof err.logs === 'string') {
      const logs = err.logs.trim();
      if (logs && logs !== 'UnknownError') {
        return `[Errors in last 100 lines - may not be fatal]\n${logs}`;
      }
    }

    // Priority 2: Use cloud-specific formatter
    if (cloud === CloudType.AWS) {
      return formatAWSError(err);
    }
    if (cloud === CloudType.Azure) {
      return formatAzureError(err);
    }
    if (cloud === CloudType.GCP) {
      return formatGCPError(err);
    }
    // Generic fallback for any cloud without a dedicated formatter (Local,
    // Lambda) and for events with no resolved cloud (null).
    // Callers pass already-redacted error metadata (see redactValue at the event
    // boundary); the raw stringify must stay behind that precondition so a future
    // un-redacted caller can't surface credential fields here.
    if (err.message && err.message !== 'UnknownError') {
      return err.message;
    }
    const stringified = JSON.stringify(err, null, 2);
    if (stringified && stringified !== '{}') {
      return stringified;
    }
  }

  return 'Unknown error';
}

/**
 * If `text` is a Docker "no build for this platform" pull error, return
 * actionable rebuild guidance; otherwise null. A VM runs only its own
 * architecture's build: linux/amd64, or linux/arm64 on an arm64 type. The
 * exact wording varies by Docker version and image shape, so we match all
 * three known forms:
 *   "no matching manifest for linux/arm64/v8 in the manifest list entries" (manifest list)
 *   "... does not match the specified platform"                          (single-arch image)
 *   "no match for platform in manifest"
 *
 * Shared so the CLI pre-submit check, `anycloud status` (VM-pull failures), and
 * the server-side workload-admission check all emit identical guidance.
 */
export function archMismatchGuidance(
  text: string,
  image?: string,
  architecture: ImageArchitecture = 'amd64',
): string | null {
  const isPlatformMismatch =
    /no matching manifest|does not match the specified platform|no match for platform/i.test(
      text,
    );
  return isPlatformMismatch ? archMismatchMessage(image, architecture) : null;
}

/**
 * The rebuild-for-this-architecture guidance message. Use this directly when
 * the caller already knows the image lacks the VM's build (e.g. the
 * server-side manifest check); use `archMismatchGuidance` to
 * detect-then-message from a Docker error string.
 */
export function archMismatchMessage(
  image?: string,
  architecture: ImageArchitecture = 'amd64',
): string {
  const subject = image ?? 'This image';
  const ref = image ?? 'IMAGE';
  const platform = `linux/${architecture}`;
  return (
    `${subject} has no ${platform} build, which this VM type runs — ` +
    `rebuild and push a ${platform} (or multi-platform) image:\n` +
    `  docker buildx build --platform ${platform} -t ${ref} --push .`
  );
}

/**
 * Classify whether an error is a user-input mistake that should not be retried.
 * Used by runStep to transition to Invalid instead of Retrying.
 *
 * Cloud-specific error classification is handled by each gateway's classifyError() method.
 * This function only checks our own DeployError with 4xx status codes.
 */
export function isUserError(error: unknown): boolean {
  return error instanceof DeployError && error.statusCode < 500;
}
