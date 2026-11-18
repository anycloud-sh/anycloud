import type { Request, RequestHandler } from 'express';
import type { User } from '../services/entities.js';
import {
  bearerTokenFromAuthorization,
  classifyAuthenticationFailure,
  githubTokenFromHeader,
  type AuthenticateApiRequest,
} from '../services/api-authentication.js';
import { sendNativeApiError } from './native-validation.js';
import type { ApiRequestTracker } from '../services/http-shutdown.js';
import { awaitWithSignal } from '../services/request-budget.js';

/**
 * Express middleware that authenticates the Bearer token.
 * Sets req.user on success for downstream handlers.
 */
export function createAuthenticationMiddleware(
  requests: ApiRequestTracker,
  shutdownSignal: AbortSignal | undefined,
  authenticate: AuthenticateApiRequest,
): RequestHandler {
  return async (req, res, next) => {
    const token = bearerTokenFromAuthorization(req.headers.authorization);
    if (!token) {
      sendNativeApiError(res, 401, 'UNAUTHORIZED', 'Missing access token');
      return;
    }

    try {
      const authentication = requests.track('authentication', () =>
        authenticate(token, shutdownSignal, {
          host: req.headers.host,
          githubToken: githubTokenFromHeader(req.headers),
        }),
      );
      const user = await awaitWithSignal(authentication, shutdownSignal);
      if (res.destroyed) return;
      if (requests.draining) throw new Error('API server is shutting down');
      (req as Request & { user?: User }).user = user;
      next();
    } catch (error) {
      if (res.destroyed) return;
      if (requests.draining || shutdownSignal?.aborted) {
        res.setHeader('Connection', 'close');
        sendNativeApiError(
          res,
          503,
          'SERVICE_UNAVAILABLE',
          'API server is shutting down',
        );
        return;
      }
      const failure = classifyAuthenticationFailure(error);
      sendNativeApiError(res, failure.status, failure.code, failure.message);
    }
  };
}

export function authenticatedUser(req: Request): User {
  const user = (req as Request & { user?: User }).user;
  if (!user) throw new Error('Authentication middleware did not run');
  return user;
}
