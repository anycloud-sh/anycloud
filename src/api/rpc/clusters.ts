import { ClusterNotFoundError } from '../services/cluster-errors.js';
import { declaredAs, mapDeclaredErrors } from './errors.js';
import { authenticatedImplementation as authenticated } from './base.js';

export const clustersRouter = {
  list: authenticated.clusters.list.handler(({ context, signal }) =>
    context.domains.clusters.list(context.actor, signal),
  ),
  get: authenticated.clusters.get.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.clusters.get(context.actor, input.params.id, signal),
        [declaredAs(ClusterNotFoundError, errors.CLUSTER_NOT_FOUND)],
      ),
  ),
};
