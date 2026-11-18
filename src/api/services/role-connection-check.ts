import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type {
  RoleConnection,
  RoleConnectionRequest,
} from '../../shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../shared/cloud.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  RoleConnectionCheckError,
  RoleConnectionPendingError,
} from './credentials-domain.js';
import {
  assumeAwsRoleWithWebIdentity,
  awsShortRoleSessionMessage,
  createAwsStsClient,
} from './provider-clients/aws.js';
import {
  azureManagementScope,
  createAzureClientAssertionCredential,
  createAzureResourceManagementClient,
  isAzureAuthRefusal,
} from './provider-clients/azure.js';
import { createGcpRoleConnectionClient } from './provider-clients/gcp.js';

/** A token for one of the API's ServiceAccounts, bound to one audience. */
export type ServiceAccountTokens = (
  audience: string,
  signal?: AbortSignal,
) => Promise<string>;

/** Every AWS bucket token lasts 12 hours (RFC 0047 amendment 10). */
const AWS_ROLE_SESSION_SECONDS = 12 * 60 * 60;

/** STS's shortest session, should a trust wrongly accept a probe. */
const AWS_PROBE_SESSION_SECONDS = 15 * 60;

/** An audience no setup template trusts, for the audience probe. */
export const TRUST_PROBE_AUDIENCE = 'anycloud-trust-probe';

// The trial session can do nothing: it proves only the trust and the duration.
const DENY_ALL_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
});

/**
 * The audience each cloud's setup template trusts. GCP's assumes the
 * googleapis.com universe, as the setup template does.
 */
function roleConnectionAudience(request: RoleConnectionRequest): string {
  switch (request.cloudProvider) {
    case CloudType.AWS:
      return 'sts.amazonaws.com';
    case CloudType.GCP:
      return `https://iam.googleapis.com/${request.workloadIdentityProvider}`;
    case CloudType.Azure:
      return 'api://AzureADTokenExchange';
  }
}

/**
 * Saving a role connection performs its exchange once (RFC 0047 § Save-time
 * check) and records the issuer and subject the cloud now trusts. It then
 * proves the trust pins both: the cloud must refuse the trust probe's token
 * for the same audience, and the API's own token for another audience.
 */
export function createRoleConnectionCheck(dependencies: {
  tokens: ServiceAccountTokens;
  probeTokens: ServiceAccountTokens;
}): (
  request: RoleConnectionRequest,
  signal?: AbortSignal,
) => Promise<RoleConnection> {
  return async (request, signal) => {
    const audience = roleConnectionAudience(request);
    const token = () => dependencies.tokens(audience, signal);
    const first = await token();
    const trust = { audience, ...tokenTrust(first) };
    switch (request.cloudProvider) {
      case CloudType.AWS:
        await checkAws(request.roleArn, first, trust, signal);
        break;
      case CloudType.GCP:
        await checkGcp(request, token);
        break;
      case CloudType.Azure:
        await checkAzure(request, token, signal);
        break;
    }
    const probeToken = await dependencies.probeTokens(audience, signal);
    await requireRefusal(request, probeToken, signal, {
      claim: 'subject',
      accepted: tokenTrust(probeToken).subject,
      pinned: trust.subject,
    });
    await requireRefusal(
      request,
      await dependencies.tokens(TRUST_PROBE_AUDIENCE, signal),
      signal,
      { claim: 'audience', accepted: TRUST_PROBE_AUDIENCE, pinned: audience },
    );
    return { ...request, ...trust };
  };
}

/**
 * One probe exchange, which the cloud must refuse. Only the cloud's named
 * refusal counts. Any other failure (throttling, 5xx, network) proves nothing
 * about the trust, so it neither counts nor lets the save pass: the save asks
 * to be repeated, which the client does for about 2.5 minutes.
 */
async function requireRefusal(
  request: RoleConnectionRequest,
  token: string,
  signal: AbortSignal | undefined,
  probe: { claim: 'subject' | 'audience'; accepted: string; pinned: string },
): Promise<void> {
  const connection = connectionName(request);
  try {
    await probeExchange(request, token, signal);
  } catch (error) {
    if (isProbeRefusal(request.cloudProvider, probe.claim, error)) return;
    signal?.throwIfAborted();
    throw new RoleConnectionPendingError(
      `Could not finish checking that the trust of ${connection} pins its ${probe.claim}; trying again. Nothing is saved until the check completes. (${errorMessage(error)})`,
    );
  }
  throw new RoleConnectionCheckError(
    `The trust of ${connection} accepted a token with ${probe.claim} ${probe.accepted}, so it does not pin the ${probe.claim}. Limit it to ${probe.claim} ${probe.pinned}, as the setup template does.`,
  );
}

/**
 * The answers each cloud gives a token its trust does not match: STS's denial
 * or audience rejection; GCP STS's 400 (audience, attribute condition) or
 * impersonation's 403 (binding), a refusal at either step; Entra ID's
 * AADSTS70021x, no matching federated identity record.
 */
function isProbeRefusal(
  cloud: RoleConnectionRequest['cloudProvider'],
  claim: 'subject' | 'audience',
  error: unknown,
): boolean {
  switch (cloud) {
    case CloudType.AWS: {
      const { name, message } = (error ?? {}) as Partial<Error>;
      if (name === 'AccessDenied') return true;
      // STS answers an audience missing from the OIDC provider's client IDs
      // with InvalidIdentityToken "The web identity token provided could not
      // be validated" in earlier spikes. It says the same for a missing provider,
      // an unregistered issuer or a forged signature, so it is the audience's
      // refusal only because this token differs from the one STS just
      // accepted, for this role, in its audience alone. The subject probe's
      // token has the trusted audience, so only AccessDenied refuses it. Any
      // other message, such as a failure to fetch the issuer's keys, says
      // nothing about the trust.
      return (
        claim === 'audience' &&
        name === 'InvalidIdentityTokenException' &&
        /could not be validated/i.test(message ?? '')
      );
    }
    case CloudType.GCP:
      return [400, 403].includes(
        (error as { response?: { status?: number } } | null)?.response
          ?.status ?? 0,
      );
    case CloudType.Azure:
      return (
        isAzureAuthRefusal(error) &&
        /AADSTS7002(1|11|12|13)\b/.test(errorMessage(error))
      );
  }
}

function connectionName(request: RoleConnectionRequest): string {
  switch (request.cloudProvider) {
    case CloudType.AWS:
      return `AWS role ${request.roleArn}`;
    case CloudType.GCP:
      return `GCP service account ${request.serviceAccountEmail} through ${request.workloadIdentityProvider}`;
    case CloudType.Azure:
      return `Azure application ${request.applicationId}`;
  }
}

/**
 * The exchange alone; anything an accepted probe yields is discarded. An AWS
 * session can do nothing and lasts STS's shortest time.
 */
async function probeExchange(
  request: RoleConnectionRequest,
  token: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  switch (request.cloudProvider) {
    case CloudType.AWS:
      await assumeAwsRoleWithWebIdentity(
        {
          roleArn: request.roleArn,
          webIdentityToken: token,
          sessionName: 'anycloud-trust-probe',
          durationSeconds: AWS_PROBE_SESSION_SECONDS,
          policy: DENY_ALL_POLICY,
        },
        { region: 'us-east-1' },
        signal,
      );
      return;
    case CloudType.GCP:
      // STS or impersonation: a refusal at either step counts.
      await createGcpRoleConnectionClient(
        request,
        async () => token,
      ).getAccessToken();
      return;
    case CloudType.Azure:
      await createAzureClientAssertionCredential(
        request,
        async () => token,
      ).getToken(azureManagementScope(), { abortSignal: signal });
      return;
  }
}

function tokenTrust(token: string): { issuer: string; subject: string } {
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { iss?: unknown; sub?: unknown };
  if (typeof claims.iss !== 'string' || typeof claims.sub !== 'string')
    throw new Error('The ServiceAccount token has no issuer or subject');
  return { issuer: claims.iss, subject: claims.sub };
}

async function checkAws(
  roleArn: string,
  token: string,
  trust: { issuer: string; audience: string; subject: string },
  signal: AbortSignal | undefined,
): Promise<void> {
  const options = { region: 'us-east-1' };
  try {
    const session = await assumeAwsRoleWithWebIdentity(
      {
        roleArn,
        webIdentityToken: token,
        sessionName: 'anycloud-connection-check',
        durationSeconds: AWS_ROLE_SESSION_SECONDS,
        policy: DENY_ALL_POLICY,
      },
      options,
      signal,
    );
    // Allowed under any policy, so it proves the session works.
    await createAwsStsClient(session, options).send(
      new GetCallerIdentityCommand({}),
      { abortSignal: signal },
    );
  } catch (error) {
    throw awsRefusal(error, roleArn, trust) ?? error;
  }
}

function awsRefusal(
  error: unknown,
  roleArn: string,
  {
    issuer,
    audience,
    subject,
  }: Record<'issuer' | 'audience' | 'subject', string>,
): RoleConnectionCheckError | RoleConnectionPendingError | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
  if (status === undefined || status < 400 || status >= 500) return undefined;
  const detail = errorMessage(error);
  // A rate limit outlasting the SDK's retries is not a refusal.
  if (status === 429 || (error as { name?: unknown }).name === 'Throttling')
    return new RoleConnectionPendingError(
      `AWS is throttling the check of role ${roleArn}; trying again. (${detail})`,
    );
  const shortSession = awsShortRoleSessionMessage(roleArn, error);
  if (shortSession) return new RoleConnectionCheckError(shortSession);
  return new RoleConnectionCheckError(
    `AWS refused role ${roleArn} to a token from issuer ${issuer} with audience ${audience} and subject ${subject}. Check the role's IAM OIDC provider and trust policy. (${detail})`,
  );
}

/**
 * One exchange. GCP IAM took 61–91 s to admit a new impersonation binding in
 * the spikes, so a 403 asks the caller to repeat the save rather than
 * holding the request open.
 */
async function checkGcp(
  connection: { workloadIdentityProvider: string; serviceAccountEmail: string },
  token: () => Promise<string>,
): Promise<void> {
  try {
    await createGcpRoleConnectionClient(connection, token).getAccessToken();
  } catch (error) {
    const status = (error as { response?: { status?: number } } | null)
      ?.response?.status;
    if (status === undefined || status >= 500) throw error;
    if (status === 429)
      throw new RoleConnectionPendingError(
        `GCP is throttling the check of ${connection.serviceAccountEmail}; trying again. (${errorMessage(error)})`,
      );
    if (status === 403)
      throw new RoleConnectionPendingError(
        `Waiting for GCP IAM to let ${connection.serviceAccountEmail} be impersonated through ${connection.workloadIdentityProvider}; new bindings take up to about 2 minutes. (${errorMessage(error)})`,
      );
    // Only impersonation answers 403; STS refuses a bad token with 400.
    const body = (error as { response?: { data?: unknown } }).response?.data;
    throw new RoleConnectionCheckError(
      `GCP refused the token at ${connection.workloadIdentityProvider}. (${errorMessage(error)} ${JSON.stringify(body ?? '')})`,
    );
  }
}

/**
 * The client assertion, then one ARM read the published role grants. Azure
 * RBAC took from 6 s to over 10 minutes to admit a new role assignment in the
 * spikes, so a denial asks the caller to repeat the save.
 */
async function checkAzure(
  connection: {
    directoryId: string;
    applicationId: string;
    subscriptionId: string;
  },
  token: () => Promise<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const credential = createAzureClientAssertionCredential(connection, token);
  try {
    await credential.getToken(azureManagementScope(), { abortSignal: signal });
  } catch (error) {
    if (!isAzureAuthRefusal(error)) throw error;
    throw new RoleConnectionCheckError(
      `Azure refused the client assertion for application ${connection.applicationId}. (${errorMessage(error)})`,
    );
  }
  try {
    await createAzureResourceManagementClient(
      credential,
      connection.subscriptionId,
    )
      .resourceGroups.list({ top: 1, abortSignal: signal })
      .next();
  } catch (error) {
    const { code, statusCode } =
      (error as { code?: unknown; statusCode?: number } | null) ?? {};
    if (code !== 'AuthorizationFailed') {
      if (statusCode === undefined || statusCode < 400 || statusCode >= 500)
        throw error;
      throw new RoleConnectionCheckError(
        `Azure refused application ${connection.applicationId} on subscription ${connection.subscriptionId}. (${errorMessage(error)})`,
      );
    }
    throw new RoleConnectionPendingError(
      `Waiting for Azure permissions for application ${connection.applicationId} on subscription ${connection.subscriptionId}. Role assignments can take over 10 minutes to reach Azure; if this save stops waiting, run the same save again later. (${errorMessage(error)})`,
    );
  }
}
