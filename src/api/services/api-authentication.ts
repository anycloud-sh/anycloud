import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import Github from './gateways/github.js';
import type { User } from './entities.js';
import { getWorkloadApiUrl } from '../config.js';
import {
  assertApiAccess,
  findServiceTokenUser,
  listServiceAccountDeployments,
  type ServiceAccountDeployment,
} from './repositories/api-access-policy.js';
import {
  API_TOKEN_PREFIX,
  findApiTokenOwner,
} from './repositories/api-tokens.js';
import { GITHUB_TOKEN_HEADER, localApiTokenPath } from '../../shared/config.js';
import {
  DeployError,
  GithubSignInRequiredError,
  GithubUnavailableError,
} from '../../shared/errors.js';
import { log } from './logger.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { ClusterKubernetesClient } from './kubernetes/cluster-client.js';
import { getDefaultClusterRuntimeResolver } from './kubernetes/default-runtime.js';
import { kubernetesWorkloadResourceName } from './kubernetes/identity.js';
import { nodePoolNamespace } from './kubernetes/node-pool-scheduling.js';
import { ANYCLOUD_API_TOKEN_AUDIENCE } from './kubernetes/pool-objects.js';
import { reviewServiceAccountToken } from './kubernetes/token-review.js';

const LOCAL_API_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_OWNER_PREFIX = 'local:';

export function bearerTokenFromAuthorization(
  authorization: string | undefined,
): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1]?.trim() || undefined;
}

export function classifyAuthenticationFailure(error: unknown) {
  if (error instanceof GithubSignInRequiredError) {
    return {
      code: 'GITHUB_SIGN_IN_REQUIRED',
      status: 403,
      message: error.message,
    } as const;
  }
  if (error instanceof DeployError && error.statusCode === 403) {
    return {
      code: 'FORBIDDEN',
      status: 403,
      message: error.message,
    } as const;
  }
  if (error instanceof DeployError && error.statusCode === 503) {
    return {
      code: 'AUTHENTICATION_UNAVAILABLE',
      status: 503,
      message: error.message,
    } as const;
  }
  if (!(error instanceof Error)) {
    // Both callers send `message` to the client and keep nothing else, so this
    // is the only place the cause still exists. A rejection that is not an
    // Error is anomalous here; the client still gets a stable 401.
    log.warn('Authentication failed with a non-Error cause', { error });
    return {
      code: 'UNAUTHORIZED',
      status: 401,
      message: 'Authentication failed',
    } as const;
  }
  return {
    code: 'UNAUTHORIZED',
    status: 401,
    message: error.message,
  } as const;
}

export function githubTokenFromHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers[GITHUB_TOKEN_HEADER.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

/** What a request carries besides its bearer token. */
interface ApiRequestOrigin {
  host?: string;
  /** The caller's GitHub sign-in, sent to a local API alongside its token. */
  githubToken?: string;
}

export type AuthenticateApiRequest = (
  token: string,
  signal: AbortSignal | undefined,
  origin?: ApiRequestOrigin,
) => Promise<User>;

/** What a hosted API needs to admit a registered Deployment's token. */
export interface ServiceAccountAuthenticationDependencies {
  listServiceAccounts(): Promise<ServiceAccountDeployment[]>;
  clusters: {
    resolve(
      clusterId: string,
      signal?: AbortSignal,
    ): Promise<{ cluster: Pick<ClusterKubernetesClient, 'authentication'> }>;
  };
}

/** A projected ServiceAccount token is a JWT; nothing else is reviewed. */
const JWT_PATTERN = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;

/**
 * A registered Deployment's projected token (RFC 0049 C29): the cluster that
 * runs it must authenticate it for the `anycloud-api` audience, bound to a
 * Pod, as the ServiceAccount the renderer derives for that Deployment.
 */
async function authenticateServiceAccount(
  dependencies: ServiceAccountAuthenticationDependencies,
  token: string,
  signal: AbortSignal | undefined,
): Promise<User> {
  // Registrations are read on every request, so removal ends access at
  // once; a hosted API runs every Deployment on its one cluster.
  const registered = await dependencies.listServiceAccounts();
  const clusterId = registered[0]?.clusterId;
  let review = null;
  if (clusterId) {
    try {
      const runtime = await dependencies.clusters.resolve(clusterId, signal);
      review = await reviewServiceAccountToken(
        runtime.cluster,
        token,
        ANYCLOUD_API_TOKEN_AUDIENCE,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      throw new DeployError(
        `Could not verify the ServiceAccount token: ${errorMessage(error)}`,
        503,
      );
    }
  }
  if (review && !review.podUid) {
    throw new Error('This ServiceAccount token is bound to no Pod.');
  }
  const match =
    review &&
    registered.find(
      (row) =>
        review.username ===
        `system:serviceaccount:${nodePoolNamespace(row.nodePoolId)}:${kubernetesWorkloadResourceName('deployment', row.deploymentId)}`,
    );
  if (match) {
    signal?.throwIfAborted();
    return { id: match.userId, username: match.username, token: null };
  }
  throw new Error(
    'This ServiceAccount token belongs to no registered Deployment. The owner registers one with `anycloud api access add --service-account <deployment>`.',
  );
}

/**
 * A hosted API admits the API tokens it issues (a GitHub account's, or an
 * owner-issued service's) and registered Deployments' ServiceAccount tokens. The access policy is checked on every request, so
 * removal takes effect on the next one.
 */
export function createHostedApiAuthentication(
  dependencies: ServiceAccountAuthenticationDependencies,
): AuthenticateApiRequest {
  return async (token, signal) => {
    signal?.throwIfAborted();
    if (JWT_PATTERN.test(token)) {
      return authenticateServiceAccount(dependencies, token, signal);
    }
    const login = `run \`anycloud login ${getWorkloadApiUrl()}\``;
    if (!token.startsWith(API_TOKEN_PREFIX)) {
      throw new Error(
        `This hosted API takes only the API tokens it issues, not a GitHub token: update the CLI, then ${login}.`,
      );
    }
    const owner = await findApiTokenOwner(token);
    if (!owner) {
      // A service has no GitHub sign-in; its token row is its admission.
      const service = await findServiceTokenUser(token);
      if (service)
        return { id: service.userId, username: service.username, token: null };
      throw new Error(
        `This API token was rotated or removed: ${login} for the current one, or for a service token ask the API's owner to rotate it.`,
      );
    }
    const identity = { id: owner.userId, username: owner.username };
    await assertApiAccess(identity);
    signal?.throwIfAborted();
    return { ...identity, token: owner.githubToken };
  };
}

export const authenticateApiToken = createHostedApiAuthentication({
  listServiceAccounts: () => listServiceAccountDeployments(),
  clusters: {
    resolve: (clusterId, signal) =>
      getDefaultClusterRuntimeResolver().resolve(clusterId, signal),
  },
});

/** The owner of every record a local API creates, whoever is signed in to GitHub. */
export function localOwnerId(apiIdentity: string): string {
  return `${LOCAL_OWNER_PREFIX}${apiIdentity}`;
}

export function isLocalOwnerId(userId: string): boolean {
  return userId.startsWith(LOCAL_OWNER_PREFIX);
}

/** `api start` writes the token before the container starts; a local API has no other gate. */
export async function readLocalApiToken(
  path = localApiTokenPath(),
): Promise<string> {
  const token = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No local API token at ${path}; run \`anycloud api start\`.`,
      );
    }
    throw error;
  });
  if (!LOCAL_API_TOKEN_PATTERN.test(token.trim())) {
    throw new Error(
      `${path} is not a local API token; delete it and run \`anycloud api start\`.`,
    );
  }
  return token.trim();
}

/** The GitHub account a cluster's hosted API is bound to and its DNS record is published with. */
export interface GithubOwner {
  id: string;
  username: string;
  token: string;
}

/**
 * A hosted actor is a GitHub account already; a local API verifies the
 * caller's GitHub token here, the one place it needs the account behind it.
 */
export async function githubOwner(
  actor: User,
  subject: string,
  signal?: AbortSignal,
): Promise<GithubOwner> {
  if (!actor.token) throw GithubSignInRequiredError.needs(subject);
  if (!isLocalOwnerId(actor.id)) {
    return { id: actor.id, username: actor.username, token: actor.token };
  }
  try {
    const { id, username } = await Github.authenticate(actor.token, signal);
    return { id, username, token: actor.token };
  } catch (error) {
    throw GithubSignInRequiredError.fromGithub(error);
  }
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function requestHostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A local API admits the holder of its per-install token as its one owner.
 * The loopback port binding and the token keep other machines out; the Host
 * check adds a refusal for DNS-rebound pages and names the fix for a remote
 * URL. The GitHub token is passed through unverified for the features that
 * need GitHub.
 */
export function createLocalApiAuthentication(options: {
  token: string;
  ownerId: string;
}): AuthenticateApiRequest {
  const expected = tokenDigest(options.token);
  return async (token, signal, origin) => {
    signal?.throwIfAborted();
    if (!LOOPBACK_HOSTS.has(requestHostname(origin?.host) ?? '')) {
      throw new DeployError(
        'A local API accepts only clients on its own machine. Run the CLI on the machine that runs the local API, or use a hosted API for remote access.',
        403,
      );
    }
    if (!timingSafeEqual(tokenDigest(token), expected)) {
      throw new Error(
        'Invalid local API token. Run the CLI as the user who ran `anycloud api start`, with the same ANYCLOUD_DIR.',
      );
    }
    return {
      id: options.ownerId,
      username: 'local',
      token: origin?.githubToken?.trim() || null,
    };
  };
}
