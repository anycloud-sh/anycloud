import { InvalidDbQueryError } from '../services/database-domain.js';
import { declaredAs, mapDeclaredErrors } from './errors.js';
import { authenticatedImplementation as authenticated } from './base.js';

export const databaseRouter = {
  query: authenticated.database.query.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.database.query(
            context.actor,
            input.sql,
            context.clientVersion,
            signal,
          ),
        [declaredAs(InvalidDbQueryError, errors.DB_QUERY_INVALID)],
      ),
  ),
  schema: authenticated.database.schema.handler(({ context, input, signal }) =>
    context.domains.database.schema(
      context.actor,
      input.query.table?.trim() || undefined,
      context.clientVersion,
      signal,
    ),
  ),
};
