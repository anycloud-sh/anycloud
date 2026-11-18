import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export interface AWSCallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

export interface ExplicitAWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const AWS_CREDENTIAL_READINESS_REQUEST_TIMEOUT_MS = 10_000;

function awsReadinessErrorDetails(error: unknown): {
  codes: string[];
  code: string;
  message: string;
  statusCode?: number;
  requestId?: string;
} {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    message?: unknown;
    requestId?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
  };
  const codes = [candidate?.Code, candidate?.code, candidate?.name].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const code = codes.find((value) => value !== 'Error') ?? codes[0] ?? '';
  const rawStatus = candidate?.$metadata?.httpStatusCode;
  const rawRequestId = candidate?.$metadata?.requestId ?? candidate?.requestId;
  return {
    codes,
    code,
    message:
      typeof candidate?.message === 'string'
        ? candidate.message
        : String(error),
    ...(typeof rawStatus === 'number' ? { statusCode: rawStatus } : {}),
    ...(typeof rawRequestId === 'string' ? { requestId: rawRequestId } : {}),
  };
}

function awsReadinessFailureLabel(error: unknown): string {
  const { code, message, statusCode, requestId } =
    awsReadinessErrorDetails(error);
  const details = [
    code || undefined,
    statusCode === undefined ? undefined : `HTTP ${statusCode}`,
    requestId ? `request ${requestId}` : undefined,
    message && message !== code ? message : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? details.join(', ') : 'an unexpected AWS error';
}

function explicitAWSClientConfig(
  credentials: ExplicitAWSCredentials,
  serviceEndpointEnv: string,
  region?: string,
) {
  const configuredEndpoint = process.env.AWS_ENDPOINT_URL;
  const serviceEndpoint = process.env[serviceEndpointEnv];
  return {
    credentials,
    region:
      region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      'us-east-1',
    maxAttempts: 1,
    ...(serviceEndpoint || configuredEndpoint
      ? { endpoint: serviceEndpoint || configuredEndpoint }
      : {}),
  };
}

/** Authenticate exactly the supplied AWS credential material. */
export async function validateAWSAccessCredentials(
  credentials: ExplicitAWSCredentials,
  region?: string,
): Promise<AWSCallerIdentity> {
  const sts = new STSClient(
    explicitAWSClientConfig(credentials, 'AWS_ENDPOINT_URL_STS', region),
  );
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(
        AWS_CREDENTIAL_READINESS_REQUEST_TIMEOUT_MS,
      ),
    });
    if (
      typeof identity.Account !== 'string' ||
      !/^\d{12}$/.test(identity.Account) ||
      typeof identity.Arn !== 'string' ||
      identity.Arn.length === 0 ||
      typeof identity.UserId !== 'string' ||
      identity.UserId.length === 0
    ) {
      throw new Error('AWS returned an incomplete STS identity.');
    }
    return {
      account: identity.Account,
      arn: identity.Arn,
      userId: identity.UserId,
    };
  } catch (error) {
    const authenticationError = new Error(
      `AWS credentials could not be authenticated (${awsReadinessFailureLabel(error)}).`,
    ) as Error & { cause?: unknown };
    authenticationError.cause = error;
    throw authenticationError;
  } finally {
    sts.destroy();
  }
}
