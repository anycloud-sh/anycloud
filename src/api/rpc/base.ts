import { implement, ORPCError } from '@orpc/server';
import { apiContract } from '../../shared/api-contract/contract.js';
import {
  ApiVersionMismatchError,
  GithubSignInRequiredError,
  GithubUnavailableError,
  SIGN_IN_INSTRUCTION,
} from '../../shared/errors.js';
import { log } from '../services/logger.js';
import { getWorkloadApiUrl } from '../config.js';
import {
  clientWindowVersionCheck,
  releaseWindowVersionCheck,
  versionCheck,
} from '../services/api-version.js';
import {
  bearerTokenFromAuthorization,
  classifyAuthenticationFailure,
  isLocalOwnerId,
} from '../services/api-authentication.js';
import type { ApiRpcContext } from './context.js';
import type { User } from '../services/entities.js';
import {
  assertRequestActive,
  awaitWithSignal,
} from '../services/request-budget.js';
import { withRequestBudget } from './request-budget.js';
import { apiContractProcedureMeta } from '../../shared/api-contract/inspection.js';

const implementation = implement(apiContract).$context<ApiRpcContext>();

// Root composition is used only to assemble the router. Every operational
// procedure is implemented through the authenticated base below.
export const routerImplementation = implementation;

const reportProcedureFailure = implementation.middleware(
  async ({ next, path, signal }) => {
    try {
      return await next();
    } catch (error) {
      if (
        !signal?.aborted &&
        (!(error instanceof ORPCError) || error.status >= 500) &&
        // The client repeats a save the cloud has not granted yet.
        !(
          error instanceof ORPCError && error.code === 'ROLE_CONNECTION_PENDING'
        )
      ) {
        log.error('API procedure failed', {
          id: 'system',
          procedure: path.join('.'),
          error: error,
        });
      }
      throw error;
    }
  },
);

const elapsedRequestBudget = implementation.middleware(
  ({ context, procedure, signal, next }) =>
    withRequestBudget(
      context,
      signal,
      apiContractProcedureMeta(procedure),
      (operation) => next({ context: { operation } }),
    ),
);

// Track the actual procedure inside the elapsed-budget race. Disconnecting its
// response must not let shutdown snapshot while an accepted mutation continues.
const trackAcceptedProcedure = implementation.middleware(
  ({ context, path, next }) =>
    context.requests
      ? context.requests.track(path.join('.'), async () => next())
      : next(),
);

/** Workload procedures authenticate their projected Pod token in-domain. */
export const workloadImplementation = implementation
  .use(reportProcedureFailure)
  .use(trackAcceptedProcedure);

/** Acquisition shares the elapsed budget with its domain cancellation fence. */
export const boundedWorkloadImplementation = implementation
  .use(reportProcedureFailure)
  .use(elapsedRequestBudget)
  .use(trackAcceptedProcedure);

function clientVersionMiddleware(
  check: (version: string | undefined) => asserts version is string,
) {
  return implementation.middleware(async ({ context, next }) => {
    try {
      check(context.clientVersion);
    } catch (error) {
      if (error instanceof ApiVersionMismatchError) {
        throw new ORPCError('CLIENT_VERSION_MISMATCH', {
          defined: true,
          status: 400,
          message: error.message,
          cause: error,
        });
      }
      throw error;
    }
    return next({ context: { clientVersion: context.clientVersion } });
  });
}

const requireCompatibleClientVersion = clientVersionMiddleware(versionCheck);
const requireClientWindowVersion = clientVersionMiddleware(
  clientWindowVersionCheck,
);
const requireReleaseWindowClientVersion = clientVersionMiddleware(
  releaseWindowVersionCheck,
);

async function authenticateApiContext<T>(
  context: ApiRpcContext,
  token: string | undefined,
  signal: AbortSignal | undefined,
  authenticate: (token: string, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!token) {
    throw new ORPCError('UNAUTHORIZED', {
      defined: true,
      status: 401,
      message: 'Missing access token',
    });
  }

  try {
    const authentication = context.requests
      ? context.requests.track('authentication', () =>
          authenticate(token, signal),
        )
      : authenticate(token, signal);
    return await awaitWithSignal(authentication, signal);
  } catch (error) {
    assertRequestActive(signal);
    const failure = classifyAuthenticationFailure(error);
    throw new ORPCError(failure.code, {
      defined: true,
      status: failure.status,
      message: failure.message,
      cause: error,
    });
  }
}

const requireAuthentication = implementation.middleware(
  async ({ context, next, signal }) => {
    const actor = await authenticateApiContext(
      context,
      bearerTokenFromAuthorization(context.authorization),
      context.operation?.signal ?? signal,
      (token, tokenSignal) => context.authenticate(token, tokenSignal, context),
    );
    try {
      return await next({ context: { actor } });
    } catch (error) {
      if (error instanceof GithubSignInRequiredError) {
        throw new ORPCError('GITHUB_SIGN_IN_REQUIRED', {
          defined: true,
          status: 403,
          // A hosted API keeps the sign-in from the caller's last login to it.
          message: isLocalOwnerId(actor.id)
            ? error.message
            : error.message.replace(
                SIGN_IN_INSTRUCTION,
                `Run \`anycloud login ${getWorkloadApiUrl()}\`, then retry.`,
              ),
          cause: error,
        });
      }
      // A feature reaching GitHub for the caller during an outage: retryable.
      if (error instanceof GithubUnavailableError) {
        throw new ORPCError('AUTHENTICATION_UNAVAILABLE', {
          defined: true,
          status: 503,
          message: error.message,
          cause: error,
        });
      }
      throw error;
    }
  },
);

/** The bearer is a GitHub sign-in, exchanged here for the caller's API token. */
const requireGithubSignIn = implementation.middleware(
  async ({ context, next, signal }) =>
    next({
      context: {
        apiToken: await authenticateApiContext(
          context,
          bearerTokenFromAuthorization(context.authorization),
          signal,
          (token, tokenSignal) =>
            context.domains.apiAccess.exchangeToken(token, tokenSignal),
        ),
      },
    }),
);

// Every contract procedure is authenticated unless it is deliberately built
// from a separate public base.
const reportedImplementation = implementation
  .use(reportProcedureFailure)
  .use(requireCompatibleClientVersion);

export const authenticatedImplementation = reportedImplementation
  .use(requireAuthentication)
  .use(trackAcceptedProcedure);

/**
 * Workload, Deployment, node-pool and credential read, quota status, cost and
 * token procedures: the client window.
 */
export const clientWindowAuthenticatedImplementation = implementation
  .use(reportProcedureFailure)
  .use(requireClientWindowVersion)
  .use(requireAuthentication)
  .use(trackAcceptedProcedure);

/** System release procedures: the CLI updating the API is ahead of it. */
export const releaseWindowAuthenticatedImplementation = implementation
  .use(reportProcedureFailure)
  .use(requireReleaseWindowClientVersion)
  .use(requireAuthentication)
  .use(trackAcceptedProcedure);

export const releaseWindowExchangeImplementation = implementation
  .use(reportProcedureFailure)
  .use(requireReleaseWindowClientVersion)
  .use(requireGithubSignIn)
  .use(trackAcceptedProcedure);

/** Bounded observation endpoints share one budget with operator authentication. */
export const boundedClientWindowImplementation = implementation
  .use(reportProcedureFailure)
  .use(requireClientWindowVersion)
  .use(elapsedRequestBudget)
  .use(requireAuthentication)
  .use(trackAcceptedProcedure);
