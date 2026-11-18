import { DeployError } from '../../shared/errors.js';
import { ClusterNotFoundError } from '../services/cluster-errors.js';
import {
  ClusterNotAcceptingError,
  NodePoolAlreadyExistsError,
  NodePoolCredentialNotFoundError,
  NodePoolNotFoundError,
  NodePoolReferencedError,
  NodePoolClusterIncompatibleError,
  NodePoolZoneInvalidError,
  NodePoolsUnavailableError,
} from '../services/node-pool-errors.js';
import {
  declaredAs,
  declaredError,
  mapDeclaredErrors,
  type DeclaredErrorMapping,
} from './errors.js';
import {
  authenticatedImplementation as authenticated,
  clientWindowAuthenticatedImplementation as clientWindow,
} from './base.js';

type DeclaredErrorFactory = (options: {
  message: string;
  cause: Error;
}) => Error;

function nodePoolNotFound(errors: {
  NODE_POOL_NOT_FOUND: DeclaredErrorFactory;
}): DeclaredErrorMapping {
  return declaredAs(NodePoolNotFoundError, errors.NODE_POOL_NOT_FOUND);
}

function clusterNotFound(errors: {
  CLUSTER_NOT_FOUND: DeclaredErrorFactory;
}): DeclaredErrorMapping {
  return declaredAs(ClusterNotFoundError, errors.CLUSTER_NOT_FOUND);
}

export const nodePoolsRouter = {
  create: authenticated.nodePools.create.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () => context.domains.nodePools.create(context.actor, input, signal),
        [
          declaredAs(NodePoolsUnavailableError, errors.NODE_POOLS_UNAVAILABLE),
          declaredAs(
            NodePoolCredentialNotFoundError,
            errors.NODE_POOL_CREDENTIAL_NOT_FOUND,
          ),
          clusterNotFound(errors),
          declaredAs(NodePoolZoneInvalidError, errors.NODE_POOL_INVALID),
          declaredAs(
            NodePoolClusterIncompatibleError,
            errors.NODE_POOL_INVALID,
          ),
          declaredAs(ClusterNotAcceptingError, errors.CLUSTER_NOT_ACCEPTING),
          declaredAs(
            NodePoolAlreadyExistsError,
            errors.NODE_POOL_ALREADY_EXISTS,
          ),
          declaredError(DeployError, (error) =>
            error.statusCode === 400
              ? errors.NODE_POOL_INVALID({
                  message: error.message,
                  cause: error,
                })
              : undefined,
          ),
        ],
      ),
  ),
  list: clientWindow.nodePools.list.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.nodePools.list(
            context.actor,
            input?.query?.cluster,
            signal,
          ),
        [clusterNotFound(errors)],
      ),
  ),
  get: clientWindow.nodePools.get.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.nodePools.get(context.actor, input.params.id, signal),
        [nodePoolNotFound(errors)],
      ),
  ),
  delete: authenticated.nodePools.delete.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.nodePools.delete(
            context.actor,
            input.params.id,
            signal,
          ),
        [
          nodePoolNotFound(errors),
          declaredAs(NodePoolReferencedError, errors.NODE_POOL_REFERENCED),
        ],
      ),
  ),
};
