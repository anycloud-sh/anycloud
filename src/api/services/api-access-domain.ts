import type {
  ApiAccessMember,
  ApiAccessUsersResponse,
  GrantApiAccessInput,
  ServiceTokenIssued,
} from '../../shared/api-contract/api-access-schemas.js';
import { GithubSignInRequiredError } from '../../shared/errors.js';
import {
  GITHUB_LOGIN_SCOPES,
  normalizeUserId,
} from '../../shared/hosted-api.js';
import type { GithubSignIn, User } from './entities.js';
import { log } from './logger.js';
import {
  isServiceAccountUserId,
  isServiceUserId,
  serviceUserId,
  type ApiAccessPolicy,
  type ApiAccessUser as StoredApiAccessUser,
} from './repositories/api-access-policy.js';
import type { ApiTokenOwner } from './repositories/api-tokens.js';

export class ApiAccessNotHostedError extends Error {
  constructor() {
    super('API access sharing is only available on a hosted API');
    this.name = 'ApiAccessNotHostedError';
  }
}

export class ApiAccessAccountNotUserError extends Error {
  constructor(
    public readonly username: string,
    public readonly accountType: string,
  ) {
    super(
      `${username} is a GitHub ${accountType.toLowerCase()}, not a user account. Add its members individually.`,
    );
    this.name = 'ApiAccessAccountNotUserError';
  }
}

export class InvalidGithubUserIdError extends Error {
  constructor() {
    super('Invalid GitHub user id');
    this.name = 'InvalidGithubUserIdError';
  }
}

/** The exchange takes only the token `anycloud login` gets from GitHub. */
class ApiTokenExchangeRefusedError extends Error {
  constructor(reason: string) {
    super(
      `${reason} Sign in with \`anycloud login\`, which asks GitHub only for read:org and read:packages.`,
    );
    this.name = 'ApiTokenExchangeRefusedError';
  }
}

export class ApiAccessManagedDeploymentError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is a managed Deployment, whose replicas run pool Jobs; register a Deployment you created.`,
    );
    this.name = 'ApiAccessManagedDeploymentError';
  }
}

export class ApiAccessNameTakenError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is a GitHub login with access to this API; choose another name so listings can't confuse the two.`,
    );
    this.name = 'ApiAccessNameTakenError';
  }
}

export class ApiAccessServiceExistsError extends Error {
  constructor(name: string) {
    super(
      `Service "${name}" already has a token; replace it with \`anycloud api token rotate --service ${name}\`.`,
    );
    this.name = 'ApiAccessServiceExistsError';
  }
}

export class ApiAccessServiceNotFoundError extends Error {
  constructor(name: string) {
    super(
      `No service "${name}" has access; issue its token with \`anycloud api access add --service ${name}\`.`,
    );
    this.name = 'ApiAccessServiceNotFoundError';
  }
}

export class ApiAccessOwnerCannotBeRemovedError extends Error {
  constructor() {
    super('The hosted API owner cannot be removed');
    this.name = 'ApiAccessOwnerCannotBeRemovedError';
  }
}

export class ApiAccessOwnerRequiredError extends Error {
  constructor(owner: string) {
    super(
      `Only the owner of this hosted API, ${owner}, can grant or remove access`,
    );
    this.name = 'ApiAccessOwnerRequiredError';
  }
}

export interface ApiAccessDomain {
  list(signal?: AbortSignal): Promise<ApiAccessUsersResponse>;
  grant(
    actor: User,
    input: GrantApiAccessInput,
    signal?: AbortSignal,
  ): Promise<ApiAccessMember>;
  revoke(
    actor: User,
    userId: string,
    signal?: AbortSignal,
  ): Promise<StoredApiAccessUser | null>;
  /** Issues a service token, printed once: the API keeps only its hash. */
  issueServiceToken(
    actor: User,
    name: string,
    signal?: AbortSignal,
  ): Promise<ServiceTokenIssued>;
  rotateServiceToken(
    actor: User,
    name: string,
    signal?: AbortSignal,
  ): Promise<string>;
  exchangeToken(githubToken: string, signal?: AbortSignal): Promise<string>;
  rotateToken(actor: User, signal?: AbortSignal): Promise<string>;
}

export interface ApiAccessDomainDependencies {
  policy: {
    get(): Promise<ApiAccessPolicy | null>;
    listUsers(): Promise<RegisteredUser[]>;
    upsertUser(user: StoredApiAccessUser): Promise<StoredApiAccessUser>;
    registerServiceAccount(
      deploymentName: string,
    ): Promise<RegisteredUser | { managedDeploymentId: string }>;
    removeUser(userId: string): Promise<RegisteredUser | null>;
    issueServiceToken(name: string): Promise<string | null>;
    rotateServiceToken(name: string): Promise<string | null>;
  };
  /** Rolls a live Deployment whose token mount a registration changed. */
  reconcileDeployment(deploymentId: string): void;
  resolveGithubUser(
    accessToken: string,
    username: string,
  ): Promise<{ id: string; username: string; type: string }>;
  authenticateGithub(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<GithubSignIn>;
  tokens: {
    exchange(owner: ApiTokenOwner): Promise<string>;
    rotate(userId: string): Promise<string>;
  };
}

/** A stored entry and the live Deployment a registered name is held by. */
type RegisteredUser = StoredApiAccessUser & { deploymentId: string | null };

function member(user: RegisteredUser): ApiAccessMember {
  if (isServiceAccountUserId(user.userId)) {
    return { kind: 'serviceaccount', ...user };
  }
  const kind = isServiceUserId(user.userId) ? 'service' : 'github';
  return { kind, userId: user.userId, username: user.username };
}

/** Listings name a creator by its name, as they do a GitHub login. */
async function assertNameFree(
  dependencies: ApiAccessDomainDependencies,
  policy: ApiAccessPolicy,
  name: string,
): Promise<void> {
  const logins = (await dependencies.policy.listUsers())
    .filter((user) => member(user).kind === 'github')
    .map((user) => user.username);
  if (
    [policy.ownerUser, ...logins].some(
      (login) => login.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new ApiAccessNameTakenError(name);
  }
}

function githubUserId(raw: string): string {
  try {
    return normalizeUserId(raw);
  } catch {
    throw new InvalidGithubUserIdError();
  }
}

async function requireHostedPolicy(dependencies: ApiAccessDomainDependencies) {
  const policy = await dependencies.policy.get();
  if (!policy?.ownerUserId) throw new ApiAccessNotHostedError();
  return { ...policy, ownerUserId: policy.ownerUserId };
}

/** Only the hosted API's owner changes who else is admitted. */
async function requireOwner(
  dependencies: ApiAccessDomainDependencies,
  actor: User,
) {
  const policy = await requireHostedPolicy(dependencies);
  if (actor.id !== policy.ownerUserId) {
    throw new ApiAccessOwnerRequiredError(policy.ownerUser);
  }
  return policy;
}

export function createApiAccessDomain(
  dependencies: ApiAccessDomainDependencies,
): ApiAccessDomain {
  return {
    async list(signal) {
      signal?.throwIfAborted();
      const policy = await requireHostedPolicy(dependencies);
      const users = (await dependencies.policy.listUsers()).filter(
        (user) => user.userId !== policy.ownerUserId,
      );
      signal?.throwIfAborted();
      return {
        owner: { userId: policy.ownerUserId, username: policy.ownerUser },
        users: users.map(member),
      };
    },

    async grant(actor, input, signal) {
      signal?.throwIfAborted();
      const policy = await requireOwner(dependencies, actor);
      if ('serviceAccount' in input) {
        await assertNameFree(dependencies, policy, input.serviceAccount);
        const registered = await dependencies.policy.registerServiceAccount(
          input.serviceAccount,
        );
        if ('managedDeploymentId' in registered) {
          throw new ApiAccessManagedDeploymentError(input.serviceAccount);
        }
        if (registered.deploymentId) {
          dependencies.reconcileDeployment(registered.deploymentId);
        }
        return member(registered);
      }
      // The owner is a GitHub account, whose sign-in the exchange stored.
      if (!actor.token)
        throw GithubSignInRequiredError.needs('Sharing an API needs');
      const identity = await dependencies
        .resolveGithubUser(actor.token, input.username)
        .catch((error: unknown) => {
          // The sign-in a hosted API stored at the exchange can go stale.
          throw GithubSignInRequiredError.fromGithub(error);
        });
      signal?.throwIfAborted();
      if (identity.type !== 'User') {
        throw new ApiAccessAccountNotUserError(
          identity.username,
          identity.type,
        );
      }
      const user = await dependencies.policy.upsertUser({
        userId: identity.id,
        username: identity.username,
      });
      return { kind: 'github', ...user };
    },

    async revoke(actor, rawUserId, signal) {
      signal?.throwIfAborted();
      const policy = await requireOwner(dependencies, actor);
      const userId =
        isServiceAccountUserId(rawUserId) || isServiceUserId(rawUserId)
          ? rawUserId
          : githubUserId(rawUserId);
      if (userId === policy.ownerUserId) {
        throw new ApiAccessOwnerCannotBeRemovedError();
      }
      const removed = await dependencies.policy.removeUser(userId);
      if (removed?.deploymentId) {
        dependencies.reconcileDeployment(removed.deploymentId);
      }
      signal?.throwIfAborted();
      return removed;
    },

    async issueServiceToken(actor, name, signal) {
      signal?.throwIfAborted();
      const policy = await requireOwner(dependencies, actor);
      await assertNameFree(dependencies, policy, name);
      const token = await dependencies.policy.issueServiceToken(name);
      if (!token) throw new ApiAccessServiceExistsError(name);
      log.info('Service token issued', { id: 'system', service: name });
      return {
        kind: 'service',
        userId: serviceUserId(name),
        username: name,
        token,
      };
    },

    async rotateServiceToken(actor, name, signal) {
      signal?.throwIfAborted();
      await requireOwner(dependencies, actor);
      const token = await dependencies.policy.rotateServiceToken(name);
      if (!token) throw new ApiAccessServiceNotFoundError(name);
      log.info('Service token rotated', { id: 'system', service: name });
      return token;
    },

    async exchangeToken(githubToken, signal) {
      await requireHostedPolicy(dependencies);
      // Only an OAuth app token can be anycloud's; skip GitHub for the rest.
      if (!githubToken.startsWith('gho_')) {
        throw new ApiTokenExchangeRefusedError(
          'This API exchanges only a GitHub OAuth sign-in, not a personal access token or a CI token.',
        );
      }
      const signIn = await dependencies
        .authenticateGithub(githubToken, signal)
        .catch((error: unknown) => {
          throw GithubSignInRequiredError.fromGithub(error);
        });
      if (
        signIn.scopes.length !== GITHUB_LOGIN_SCOPES.length ||
        !GITHUB_LOGIN_SCOPES.every((scope) => signIn.scopes.includes(scope))
      ) {
        throw new ApiTokenExchangeRefusedError(
          `This GitHub sign-in has the scopes ${signIn.scopes.join(', ') || 'none'}; it is not from \`anycloud login\`.`,
        );
      }
      signal?.throwIfAborted();
      const token = await dependencies.tokens.exchange({
        userId: signIn.id,
        username: signIn.username,
        githubToken,
      });
      log.info('API token exchanged', { id: 'system', userId: signIn.id });
      return token;
    },

    async rotateToken(actor, signal) {
      signal?.throwIfAborted();
      await requireHostedPolicy(dependencies);
      const token = await dependencies.tokens.rotate(actor.id);
      log.info('API token rotated', { id: 'system', userId: actor.id });
      return token;
    },
  };
}
