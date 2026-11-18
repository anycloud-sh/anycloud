import { AccountClient } from '@aws-sdk/client-account';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { EC2Client } from '@aws-sdk/client-ec2';
import { S3Client } from '@aws-sdk/client-s3';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import {
  AssumeRoleWithWebIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts';
import type {
  AWSCreds,
  AWSInstanceCreds,
  AWSRoleCreds,
} from '../../../shared/cloud.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { withRetry } from '../../../shared/utils.js';
import { apiServiceAccountToken } from '../kubernetes/service-account-token.js';

type AwsS3Credentials = NonNullable<
  NonNullable<ConstructorParameters<typeof S3Client>[0]>['credentials']
>;

interface AwsStaticCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** What an AWS client signs with: a key, or a role connection's sessions. */
export type AwsClientCredentials =
  | AwsStaticCredentials
  | (() => Promise<AwsStaticCredentials & { readonly expiration: Date }>);

interface AwsClientOptions {
  readonly region?: string;
  readonly maxAttempts?: number;
}

/**
 * The management VM's own stack, through its instance profile: the SDK's
 * default chain, never a stored key (RFC 0049 C26, seed design).
 */
export function createAwsInstanceCloudFormationClient(
  region: string,
): CloudFormationClient {
  return new CloudFormationClient({
    region,
    credentials: awsClientCredentials({ kind: 'instance' }),
  });
}

export function createAwsEc2Client(
  credentials: AwsClientCredentials,
  options: AwsClientOptions,
): EC2Client {
  return new EC2Client({ ...options, credentials });
}

export function createAwsGatewayClients(
  credentials: AwsClientCredentials,
  options: AwsClientOptions,
): {
  ec2: EC2Client;
  s3: S3Client;
} {
  return {
    ec2: createAwsEc2Client(credentials, options),
    s3: createAwsS3Client(credentials, options),
  };
}

export function createAwsS3Client(
  credentials: AwsS3Credentials,
  options: AwsClientOptions & { readonly followRegionRedirects?: boolean },
): S3Client {
  // Some HTTP intermediaries do not forward 100 Continue, leaving large
  // uploads waiting for a handshake while S3 waits for their request body.
  return new S3Client({ ...options, expectContinueHeader: false, credentials });
}

export function createAwsStsClient(
  credentials: AwsClientCredentials,
  options: AwsClientOptions,
): STSClient {
  return new STSClient({ ...options, credentials });
}

export function createAwsServiceQuotasClient(
  credentials: AwsClientCredentials,
  options: AwsClientOptions,
): ServiceQuotasClient {
  return new ServiceQuotasClient({ ...options, credentials });
}

export function createAwsAccountClient(
  credentials: AwsClientCredentials,
  options: AwsClientOptions,
): AccountClient {
  return new AccountClient({ ...options, credentials });
}

export function createAwsCostExplorerClient(
  credentials: AwsClientCredentials,
  options: AwsClientOptions,
): CostExplorerClient {
  return new CostExplorerClient({ ...options, credentials });
}

/**
 * One session for a role connection (RFC 0047 amendment 8). The role's trust
 * policy authorizes the call, so it is unsigned and needs no key.
 */
export async function assumeAwsRoleWithWebIdentity(
  input: {
    readonly roleArn: string;
    readonly webIdentityToken: string;
    readonly sessionName: string;
    readonly durationSeconds: number;
    readonly policy?: string;
  },
  options: AwsClientOptions,
  signal?: AbortSignal,
): Promise<AwsStaticCredentials & { readonly expiresAt: number }> {
  const { Credentials: c } = await new STSClient(options).send(
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: input.roleArn,
      WebIdentityToken: input.webIdentityToken,
      RoleSessionName: input.sessionName,
      DurationSeconds: input.durationSeconds,
      Policy: input.policy,
    }),
    { abortSignal: signal },
  );
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration)
    throw new Error(
      'STS AssumeRoleWithWebIdentity returned incomplete credentials',
    );
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiresAt: c.Expiration.getTime(),
  };
}

/**
 * A role whose MaxSessionDuration is below the 12 h a bucket token asks for:
 * STS answers a ValidationError naming it. Only the role's owner can fix it.
 */
export function awsShortRoleSessionMessage(
  roleArn: string,
  error: unknown,
): string | undefined {
  const detail = errorMessage(error);
  if (!/MaxSessionDuration/.test(detail)) return undefined;
  return `role ${roleArn} allows sessions shorter than 12 hours. Set its MaxSessionDuration to 43200 seconds. (${detail})`;
}

// AWS reads the issuer's discovery document at each exchange; a failed read is
// transient.
const IDP_COMMUNICATION_RETRY = {
  maxAttempts: 4,
  waitMs: 1_000,
  jitter: false,
  shouldRetry: (error: unknown) =>
    (error as { name?: unknown } | null)?.name ===
    'IDPCommunicationErrorException',
} as const;

/** A role connection's session, from a newly read ServiceAccount token. */
export function assumeAwsRole(
  role: AWSRoleCreds,
  input: {
    readonly sessionName: string;
    readonly durationSeconds: number;
    readonly policy?: string;
  },
  options: AwsClientOptions = { region: 'us-east-1' },
): Promise<AwsStaticCredentials & { readonly expiresAt: number }> {
  return withRetry(
    async () =>
      assumeAwsRoleWithWebIdentity(
        {
          ...input,
          roleArn: role.roleArn,
          webIdentityToken: await apiServiceAccountToken(role.audience),
        },
        options,
      ),
    'AWS AssumeRoleWithWebIdentity',
    IDP_COMMUNICATION_RETRY,
  );
}

const COMPUTE_SESSION_SECONDS = 60 * 60;
// The SDK also renews a session this long before it expires.
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;

// One provider per role and trust: node pools rebuild gateways on every
// 30 s pass, and each would otherwise make its own exchange.
const roleSessions = new Map<string, AwsClientCredentials>();
/** The instance profile's sessions, shared by every client in this process. */
let instanceSession: AwsClientCredentials | undefined;

/**
 * A key as is, or a role connection's compute sessions (RFC 0047 amendment 8):
 * one session per role in this process, shared by every client and renewed
 * before it expires.
 */
export function awsClientCredentials(
  creds: AWSCreds | AWSRoleCreds | AWSInstanceCreds,
): AwsClientCredentials {
  if (!('kind' in creds)) return creds;
  if (creds.kind === 'instance')
    return (instanceSession ??= awsInstanceCredentials());
  const key = JSON.stringify([creds.roleArn, creds.audience, creds.issuer]);
  let provider = roleSessions.get(key);
  if (!provider) roleSessions.set(key, (provider = roleSessionProvider(creds)));
  return provider;
}

function roleSessionProvider(role: AWSRoleCreds): AwsClientCredentials {
  type Session = AwsStaticCredentials & { readonly expiration: Date };
  let session: Promise<Session> | undefined;
  return async () => {
    const pending = session;
    const current = await pending?.catch(() => undefined);
    if (
      current &&
      current.expiration.getTime() - Date.now() > RENEW_BEFORE_EXPIRY_MS
    )
      return current;
    // Concurrent callers share one renewal.
    if (session === pending)
      session = assumeAwsRole(role, {
        sessionName: 'anycloud-api',
        durationSeconds: COMPUTE_SESSION_SECONDS,
      }).then(({ expiresAt, ...credentials }) => ({
        ...credentials,
        expiration: new Date(expiresAt),
      }));
    return session!;
  };
}

const IMDS = 'http://169.254.169.254/latest';

/**
 * The management VM's own instance profile (RFC 0049 C26 (e), owner question
 * 10), read through IMDSv2 for the hosted API's backups: the one credential
 * an API holds that no user selected. The VM's role allows only the
 * checkpoint bucket; every other Pod is kept off the metadata service.
 */
export function awsInstanceCredentials(
  fetchImpl: typeof fetch = fetch,
): AwsClientCredentials {
  return async () => {
    const token = await (
      await fetchImpl(`${IMDS}/api/token`, {
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' },
        signal: AbortSignal.timeout(5_000),
      })
    ).text();
    const read = async (path: string) => {
      const response = await fetchImpl(`${IMDS}/meta-data/${path}`, {
        headers: { 'X-aws-ec2-metadata-token': token },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error(`IMDS ${path} answered ${response.status}`);
      return response.text();
    };
    const role = (await read('iam/security-credentials/'))
      .trim()
      .split('\n')[0];
    if (!role) throw new Error('This instance has no instance profile role');
    const session = JSON.parse(
      await read(`iam/security-credentials/${role}`),
    ) as {
      AccessKeyId: string;
      SecretAccessKey: string;
      Token: string;
      Expiration: string;
    };
    return {
      accessKeyId: session.AccessKeyId,
      secretAccessKey: session.SecretAccessKey,
      sessionToken: session.Token,
      expiration: new Date(session.Expiration),
    };
  };
}
