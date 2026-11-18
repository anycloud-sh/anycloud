/**
 * Base class for all workload errors.
 * Extends Error so it works with standard try/catch and instanceof checks.
 */
import { errorMessage } from './log-diagnostics.js';

export class DeployError extends Error {
  readonly statusCode: number;
  readonly isWarning: boolean;

  constructor(message: string, statusCode = 500, isWarning = false) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isWarning = isWarning;
    // Maintains proper stack trace in V8 environments
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// Client errors (4XX)

/** The provider reported the bucket itself absent, never a missing prefix or object. */
export class BucketNotFoundError extends DeployError {
  readonly cause: unknown;

  constructor(bucketName: string, cause: unknown) {
    super(`Bucket not found: ${bucketName}`, 404, true);
    this.cause = cause;
  }
}

/** The bucket exists but holds no object at this key. */
export class ObjectNotFoundError extends DeployError {
  readonly cause: unknown;

  constructor(bucketName: string, remotePath: string, cause: unknown) {
    super(`Object not found: ${bucketName}/${remotePath}`, 404, true);
    this.cause = cause;
  }
}

/** A bucket name another account or project already holds (S3 and GCS names are global). */
export class BucketNameTakenError extends DeployError {
  readonly cause: unknown;

  constructor(bucketName: string, cause: unknown) {
    super(`Bucket name "${bucketName}" is taken by another owner.`, 409);
    this.cause = cause;
  }
}

/** The cloud provider refused a bucket action for this credential. */
export class BucketAccessDeniedError extends DeployError {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message, 403, true);
    this.cause = cause;
  }
}

/** The cloud provider throttled a bucket action; retrying later can succeed. */
export class BucketThrottledError extends DeployError {
  readonly cause: unknown;

  constructor(
    message: string,
    cause: unknown,
    /** Sent as `Retry-After`. */
    readonly retryAfterSeconds: number,
  ) {
    super(message, 503, true);
    this.cause = cause;
  }
}

export class ApiVersionMismatchError extends DeployError {
  readonly clientVersion: string | undefined;
  readonly apiVersion: string;

  constructor(
    clientVersion: string | undefined,
    apiVersion: string,
    reason?: string,
  ) {
    const mismatch = clientVersion
      ? `Client version ${clientVersion} must exactly match API version ${apiVersion}.`
      : `The request is missing the AnyCloud-Client-Version header required by API version ${apiVersion}.`;
    super(
      `Client/API version mismatch. ${mismatch}${reason ? ` ${reason}` : ''} Run 'anycloud update' to update the CLI and local API. If the active API is hosted, then run 'anycloud api upgrade' to upgrade it.`,
      400,
    );
    this.clientVersion = clientVersion;
    this.apiVersion = apiVersion;
  }
}

export class MissingRequiredFieldsError extends DeployError {
  constructor(missingFields: string[]) {
    super(
      `Missing one or more required field(s) (${missingFields.join(', ')}).`,
      400,
    );
  }
}

export class InvalidAnycloudConfigError extends DeployError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class CatalogUnavailableError extends DeployError {
  constructor(message: string) {
    super(message, 503, true);
  }
}

export class InvalidWorkloadIdError extends DeployError {
  /** `problem` is `workloadIdProblem`'s predicate. */
  constructor(id: string, problem: string) {
    super(`Workload ID${id ? ` "${id}"` : ''} ${problem}`, 400);
  }
}

export class WorkloadIdExistsError extends DeployError {
  constructor() {
    super('App name already exists.', 409, true);
  }
}

/**
 * A deterministic provider identity exists but is owned by another actor.
 * Callers must not issue cleanup against that identity.
 */
export class ResourceOwnershipError extends DeployError {
  constructor(message: string) {
    super(message, 409);
  }
}

/**
 * A provider mutation may have succeeded, but the current process could not
 * establish the resource's existence or ownership. Callers must preserve the
 * durable attempt and retry observation before issuing another create or delete.
 */
export class ResourceStateIndeterminateError extends DeployError {
  constructor(message: string, originalError: unknown) {
    const reason = errorMessage(originalError);
    super(`${message}: ${reason}`, 503);
  }
}

export class SecretInUseError extends DeployError {
  constructor(
    public readonly secretName: string,
    public readonly workloadIds: string[],
  ) {
    const ids = workloadIds.join(', ');
    super(
      `Secret "${secretName}" is in use by ${workloadIds.length} non-terminal workload(s) or Deployment(s): ${ids}. Rerun with --force to delete anyway.`,
      409,
      true,
    );
  }
}

export class CredentialInUseError extends DeployError {
  constructor(
    public readonly credentialName: string,
    public readonly workloadIds: string[],
  ) {
    const ids = workloadIds.join(', ');
    super(
      `Credential "${credentialName}" is in use by ${workloadIds.length} non-terminal workload(s) or active node pool(s): ${ids}. Rerun with --force to delete anyway.`,
      409,
      true,
    );
  }
}

/** Another write changed or removed the credential while it was being edited. */
export class CredentialChangedError extends DeployError {
  constructor(public readonly credentialName: string) {
    super(
      `Credentials "${credentialName}" changed while they were being edited. Run the edit again.`,
      409,
      true,
    );
  }
}

export class CredentialNameExistsError extends DeployError {
  constructor(public readonly credentialName: string) {
    super(
      `Credentials "${credentialName}" already exist. Pass --overwrite to replace them.`,
      409,
      true,
    );
  }
}

/** One saved credential holds one name, so the same material takes no second name. */
export class CredentialsExistError extends DeployError {
  constructor(
    public readonly credentialName: string,
    public readonly existingName: string,
  ) {
    super(
      `These credentials are already saved as "${existingName}". Use "${existingName}", or delete it before saving them as "${credentialName}".`,
      409,
      true,
    );
  }
}

export class NotificationChannelNotConfiguredError extends DeployError {
  constructor(public readonly channel: string) {
    super(
      `${channel} notifications are not configured on this API. Run \`anycloud notifications connect ${channel}\` first.`,
      404,
      true,
    );
  }
}

export class NotificationDeliveryError extends DeployError {
  constructor(
    public readonly channel: string,
    public readonly reason: string,
  ) {
    super(`${channel} rejected the test message: ${reason}`, 502, true);
  }
}

export class ApiAccessDeniedError extends DeployError {
  constructor() {
    super('API access denied', 403, true);
  }
}

// Server errors (5XX)

/**
 * A transient infrastructure failure the server couldn't get past on its own —
 * e.g. a clustered transport drop on a cloud token fetch that outlasts the
 * gateway's in-call retry. 503 means "not processed — retry": only throw this
 * BEFORE any persistent side effect, so a client re-submit is always safe.
 */
export class TransientInfraError extends DeployError {
  constructor(message: string) {
    super(message, 503, true);
  }
}

/**
 * GitHub's API was unreachable or returned a server-side failure while we
 * validated the caller's token — e.g. a 5xx, a transport drop, or (during a
 * GitHub incident) its HTML outage page instead of JSON. This is upstream and
 * transient: the token itself is fine, so a retry is always safe. Wrapping it
 * here stops GitHub's raw error page from leaking through to the caller.
 */
export class GithubUnavailableError extends DeployError {
  constructor(status?: number, cause: 'outage' | 'rate-limit' = 'outage') {
    const http = status ? ` (HTTP ${status})` : '';
    super(
      cause === 'rate-limit'
        ? `GitHub's API rate limit was reached${http}; your sign-in is fine. Retry in a few minutes.`
        : `GitHub is temporarily unavailable${http} — this is a GitHub-side issue, not your credentials. Please retry in a moment.`,
      503,
      true,
    );
  }
}

/** What a GitHub sign-in refusal tells a person to do. */
export const SIGN_IN_INSTRUCTION = 'Run `anycloud login`, then retry.';
/** The instruction with or without a hosted API's URL, which an agent relays instead. */
export const SIGN_IN_INSTRUCTION_PATTERN =
  /Run `anycloud login[^`]*`, then retry\./;

/** Every Service a pool or a cloud VM runs gets a public URL through GitHub. */
export const SERVICE_URL_NEEDS = "A Service's public URL needs";

/**
 * A feature that needs the caller's GitHub sign-in (private GHCR images aside,
 * which the image check reports): public Service URLs and clusters. Agents
 * branch on its code, `GITHUB_SIGN_IN_REQUIRED`, and hand the login to a human.
 */
export class GithubSignInRequiredError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = 'GithubSignInRequiredError';
  }

  /** A feature that needs a sign-in, such as "Clusters need". */
  static needs(subject: string): GithubSignInRequiredError {
    return new GithubSignInRequiredError(
      `${subject} GitHub sign-in. ${SIGN_IN_INSTRUCTION}`,
    );
  }

  /** GitHub refused the sign-in: expired or revoked. */
  static rejected(): GithubSignInRequiredError {
    return new GithubSignInRequiredError(
      `Your GitHub sign-in was rejected. ${SIGN_IN_INSTRUCTION}`,
    );
  }

  /** A GitHub call's failure, as `rejected()` when GitHub refused the token. */
  static fromGithub(error: unknown): unknown {
    if (error instanceof GithubUnavailableError) return error;
    const status = (error as { status?: unknown }).status;
    return status === 401 || status === 403
      ? GithubSignInRequiredError.rejected()
      : error;
  }
}
