import { OpenAPIHandler } from '@orpc/openapi/node';
import { StandardOpenAPIMatcher } from '@orpc/openapi/standard';
import { BodyLimitPlugin } from '@orpc/server/node';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import type { RequestHandler } from 'express';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../shared/api-version.js';
import { apiContractProcedurePolicy } from '../../shared/api-contract/inspection.js';
import {
  githubTokenFromHeader,
  type AuthenticateApiRequest,
} from '../services/api-authentication.js';
import { type ApiRpcDomains } from './context.js';
import { apiRouter } from './router.js';
import { API_REQUEST_BUDGET_MS, withRequestBudget } from './request-budget.js';
import { awaitWithSignal } from '../services/request-budget.js';
import type { ApiRequestTracker } from '../services/http-shutdown.js';

export const API_RPC_BODY_LIMIT_BYTES = 100 * 1024;

export interface ApiRpcMiddlewareOptions {
  requests?: ApiRequestTracker;
  shutdownSignal?: AbortSignal;
  authenticate: AuthenticateApiRequest;
  domains: ApiRpcDomains | (() => ApiRpcDomains);
}

/**
 * Give declared JSON procedures first refusal on the existing Express listener.
 * This middleware must be mounted before `express.json()` so oRPC can decode and
 * validate its own inputs. Unmatched native JSON and streaming routes continue
 * through to Express without their bodies being consumed.
 */
export function createApiRpcMiddleware(
  options: ApiRpcMiddlewareOptions,
): RequestHandler {
  // Match the canonical contract before oRPC reads a JSON body. Unbounded
  // admission and native streams retain their existing transport behavior.
  const bounded = new StandardOpenAPIMatcher({
    filter: ({ path }) =>
      apiContractProcedurePolicy(path).timeoutMs === API_REQUEST_BUDGET_MS,
  });
  bounded.init(apiRouter);
  const handler = new OpenAPIHandler(apiRouter, {
    plugins: [
      new BodyLimitPlugin({ maxBodySize: API_RPC_BODY_LIMIT_BYTES }),
      new ResponseHeadersPlugin(),
    ],
    interceptors: [
      async ({ request, context, prefix, next }) => {
        const path = request.url.pathname.slice(prefix?.length ?? 0);
        const match = await bounded.match(
          request.method,
          `/${path.replace(/^\/+/, '')}`,
        );
        if (!match) return next();
        return withRequestBudget(
          context,
          request.signal,
          apiContractProcedurePolicy(match.path),
          (operation) =>
            next({
              prefix,
              context: { ...context, operation },
              request: {
                ...request,
                signal: operation.signal,
                body: () => awaitWithSignal(request.body(), operation.signal),
              },
            }),
        );
      },
    ],
  });
  const { authenticate } = options;
  const configuredDomains = options.domains;
  const resolveDomains =
    typeof configuredDomains === 'function'
      ? configuredDomains
      : () => configuredDomains;

  return async (req, res, next) => {
    try {
      const { matched } = await handler.handle(req, res, {
        prefix: '/v1',
        context: {
          requests: options.requests,
          receivedAt: performance.now(),
          releaseIncompleteBody: () => {
            if (req.complete || req.destroyed) return;
            if (res.writableFinished) req.destroy();
            else res.once('finish', () => req.destroy());
          },
          shutdownSignal: options.shutdownSignal,
          authorization: req.headers.authorization,
          host: req.headers.host,
          githubToken: githubTokenFromHeader(req.headers),
          clientVersion: req.get(ANYCLOUD_CLIENT_VERSION_HEADER),
          authenticate,
          domains: resolveDomains(),
        },
      });
      if (!matched) next();
    } catch (error) {
      next(error);
    }
  };
}
