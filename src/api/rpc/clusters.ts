import {
  ClusterBusyError,
  HostedApiAccessError,
  ClusterDestroyFailedError,
  ClusterExistsError,
  ClusterInvalidError,
  ClusterNotFoundError,
  ClusterReferencedError,
  ClusterReachableError,
  ClusterUnavailableError,
  ClusterUnreachableError,
  ClusterVmPresentError,
} from '../services/cluster-errors.js';
import {
  declaredAs,
  mapDeclaredErrors,
  type DeclaredErrorMapping,
} from './errors.js';
import { authenticatedImplementation as authenticated } from './base.js';

type DeclaredErrorFactory = (options: {
  message: string;
  cause: Error;
}) => Error;

function notFound(errors: {
  CLUSTER_NOT_FOUND: DeclaredErrorFactory;
}): DeclaredErrorMapping {
  return declaredAs(ClusterNotFoundError, errors.CLUSTER_NOT_FOUND);
}

export const clustersRouter = {
  list: authenticated.clusters.list.handler(({ context, signal }) =>
    context.domains.clusters.list(context.actor, signal),
  ),
  get: authenticated.clusters.get.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.clusters.get(context.actor, input.params.id, signal),
        [notFound(errors)],
      ),
  ),
  destroy: authenticated.clusters.destroy.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.clusters.destroy(
            context.actor,
            input.params.id,
            { deleteBuckets: input.query.deleteBuckets === true },
            signal,
          ),
        [
          notFound(errors),
          declaredAs(ClusterReferencedError, errors.CLUSTER_REFERENCED),
          declaredAs(ClusterUnreachableError, errors.CLUSTER_UNREACHABLE),
          declaredAs(ClusterBusyError, errors.CLUSTER_BUSY),
          declaredAs(HostedApiAccessError, errors.CLUSTER_INVALID),
        ],
      ),
  ),
  forget: authenticated.clusters.forget.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.clusters.forget(
            context.actor,
            input.params.id,
            signal,
          ),
        [
          notFound(errors),
          declaredAs(ClusterReachableError, errors.CLUSTER_REACHABLE),
          declaredAs(ClusterVmPresentError, errors.CLUSTER_VM_PRESENT),
          declaredAs(ClusterBusyError, errors.CLUSTER_BUSY),
        ],
      ),
  ),
};
