import { oc, type ErrorMap, type Route } from '@orpc/contract';
import type { OpenAPI } from '@orpc/openapi';
import { z } from 'zod';

export type ApiReplayGuarantee = 'safe' | 'never' | 'not-processed';

/** Runtime authority for the policy attached to every contract procedure. */
export const apiContractMetaSchema = z
  .object({
    /** A query observes; a command acts. Only a query may be cut off by a restart and retried. */
    kind: z.enum(['query', 'command']),
    replay: z.enum(['safe', 'never', 'not-processed']),
    timeoutMs: z.number().positive().nullable(),
    waitMsTimeout: z
      .object({
        minimumMs: z.number().positive(),
        graceMs: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ApiContractMeta = z.output<typeof apiContractMetaSchema>;

type QueryRoute = Omit<Route, 'method' | 'spec' | 'tags'> & {
  method: 'GET' | 'HEAD' | 'POST';
};

type CommandRoute = Omit<Route, 'method' | 'spec' | 'tags'> & {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
};

type ApiRoute = QueryRoute | CommandRoute;

export const USER_OPENAPI_SECURITY_SCHEME = 'userBearer';
export const CLIENT_VERSION_OPENAPI_PARAMETER = 'AnyCloudClientVersion';

interface CommonPolicy {
  timeoutMs?: number | null;
}

export type QueryPolicy = CommonPolicy & {
  /** Override the method-derived guarantee for a safe POST or no-retry read. */
  replay?: Extract<ApiReplayGuarantee, 'safe' | 'never'>;
  /** Derive the deadline from a conventional `waitMs` query parameter. */
  waitMsTimeout?: {
    minimumMs: number;
    graceMs: number;
  };
};

export type CommandPolicy = CommonPolicy & {
  /** Override the method-derived guarantee only when the server can prove it. */
  replay?: ApiReplayGuarantee;
};

const DEFAULT_TIMEOUT_MS = 6_000;
const initialMeta = {
  kind: 'command',
  replay: 'never',
  timeoutMs: DEFAULT_TIMEOUT_MS,
} satisfies ApiContractMeta;

function defaultReplay(
  method: NonNullable<Route['method']>,
): ApiReplayGuarantee {
  return ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method) ? 'safe' : 'never';
}

function endpointMeta(
  kind: ApiContractMeta['kind'],
  route: ApiRoute,
  policy: QueryPolicy | CommandPolicy,
): ApiContractMeta {
  if (
    'waitMsTimeout' in policy &&
    policy.waitMsTimeout &&
    !['GET', 'HEAD'].includes(route.method)
  ) {
    throw new Error('Only a safe HTTP read derives its deadline from waitMs');
  }
  return apiContractMetaSchema.parse({
    kind,
    replay: defaultReplay(route.method),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...policy,
  });
}

function omitNoContentSchema(
  operation: OpenAPI.OperationObject,
  successStatus: number | undefined,
): OpenAPI.OperationObject {
  if (successStatus !== 204) return operation;
  const response = operation.responses?.[204];
  if (!response || '$ref' in response) return operation;
  const { content: _content, ...noContentResponse } = response;
  return {
    ...operation,
    responses: {
      ...operation.responses,
      204: noContentResponse,
    },
  };
}

/** Attach wire-level policy once without changing the TypeScript input type. */
function openApiRoute(route: ApiRoute, tag: string): Route {
  return {
    ...route,
    tags: [tag],
    spec: (generated) => {
      const operation = omitNoContentSchema(generated, route.successStatus);
      return {
        ...operation,
        security: [{ [USER_OPENAPI_SECURITY_SCHEME]: [] }],
        parameters: [
          ...(operation.parameters ?? []),
          {
            $ref: `#/components/parameters/${CLIENT_VERSION_OPENAPI_PARAMETER}`,
          },
        ],
      };
    },
  };
}

/**
 * Answered while the API drains before a restart, before any route runs, so
 * it proves the request was not processed and every replayable route may retry;
 * also to a replay-safe query cut off by shutdown, which changed nothing.
 */
const restarting = {
  API_RESTARTING: {
    status: 503,
    message: 'API server is restarting',
  },
} as const;

// Authenticated is the default contract primitive. Public routes such as
// health and version remain native Express routes and are therefore explicit.
const authenticatedContract = oc.$meta<ApiContractMeta>(initialMeta).errors({
  CLIENT_VERSION_MISMATCH: {
    status: 400,
    message: 'Client/API version mismatch',
  },
  UNAUTHORIZED: {
    status: 401,
    message: 'Unauthorized',
  },
  FORBIDDEN: {
    status: 403,
    message: 'Forbidden',
  },
  /** The feature needs the caller's GitHub sign-in; `anycloud login` adds it. */
  GITHUB_SIGN_IN_REQUIRED: {
    status: 403,
    message: 'GitHub sign-in required',
  },
  AUTHENTICATION_UNAVAILABLE: {
    status: 503,
    message: 'Authentication service unavailable',
  },
  ...restarting,
});

/**
 * The only supported entry point for authenticated JSON routes. Replay safety
 * comes from the HTTP method unless an endpoint declares a real exception: a
 * safe POST, an explicit no-retry read, or a branded pre-side-effect rejection.
 * Attempt counts and backoff remain client-owned profiles, not endpoint knobs.
 */
export function authenticatedEndpoints<const TErrorMap extends ErrorMap>(
  errors: TErrorMap,
  tag: string,
) {
  const contract = authenticatedContract.errors(errors);
  return {
    query(route: QueryRoute, policy: QueryPolicy = {}) {
      return contract
        .route(openApiRoute(route, tag))
        .meta(endpointMeta('query', route, policy));
    },
    command(route: CommandRoute, policy: CommandPolicy = {}) {
      return contract
        .route(openApiRoute(route, tag))
        .meta(endpointMeta('command', route, policy));
    },
  };
}
