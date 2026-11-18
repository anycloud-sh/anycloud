import { ApiAccessDeniedError } from '../../shared/errors.js';
import {
  ApiAccessAccountNotUserError,
  ApiAccessNameTakenError,
  ApiAccessNotHostedError,
  ApiAccessOwnerCannotBeRemovedError,
  ApiAccessOwnerRequiredError,
  ApiAccessServiceExistsError,
  ApiAccessServiceNotFoundError,
  InvalidGithubUserIdError,
} from '../services/api-access-domain.js';
import {
  declaredAs,
  mapDeclaredErrors,
  type DeclaredErrorMapping,
} from './errors.js';
import {
  authenticatedImplementation as authenticated,
  clientWindowAuthenticatedImplementation as clientWindow,
  releaseWindowExchangeImplementation as exchange,
} from './base.js';

type DeclaredErrorFactory = (options: {
  message: string;
  cause: Error;
}) => Error;

function notHosted(errors: {
  API_ACCESS_NOT_HOSTED: DeclaredErrorFactory;
}): DeclaredErrorMapping {
  return declaredAs(ApiAccessNotHostedError, errors.API_ACCESS_NOT_HOSTED);
}

export const apiAccessRouter = {
  list: authenticated.apiAccess.list.handler(({ context, signal, errors }) =>
    mapDeclaredErrors(
      () => context.domains.apiAccess.list(signal),
      [notHosted(errors)],
    ),
  ),
  grant: authenticated.apiAccess.grant.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () => context.domains.apiAccess.grant(context.actor, input, signal),
        [
          notHosted(errors),
          declaredAs(
            ApiAccessOwnerRequiredError,
            errors.API_ACCESS_OWNER_REQUIRED,
          ),
          declaredAs(
            ApiAccessAccountNotUserError,
            errors.API_ACCESS_ACCOUNT_NOT_USER,
          ),
        ],
      ),
  ),
  revoke: authenticated.apiAccess.revoke.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.apiAccess.revoke(
            context.actor,
            input.params.userId,
            signal,
          ),
        [
          notHosted(errors),
          declaredAs(
            ApiAccessOwnerRequiredError,
            errors.API_ACCESS_OWNER_REQUIRED,
          ),
          declaredAs(InvalidGithubUserIdError, errors.INVALID_GITHUB_USER_ID),
          declaredAs(
            ApiAccessOwnerCannotBeRemovedError,
            errors.API_ACCESS_OWNER_CANNOT_BE_REMOVED,
          ),
        ],
      );
    },
  ),
  issueServiceToken: authenticated.apiAccess.issueServiceToken.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.apiAccess.issueServiceToken(
            context.actor,
            input.name,
            signal,
          ),
        [
          notHosted(errors),
          declaredAs(
            ApiAccessOwnerRequiredError,
            errors.API_ACCESS_OWNER_REQUIRED,
          ),
          declaredAs(ApiAccessNameTakenError, errors.API_ACCESS_NAME_TAKEN),
          declaredAs(
            ApiAccessServiceExistsError,
            errors.API_ACCESS_SERVICE_EXISTS,
          ),
        ],
      ),
  ),
  rotateServiceToken: authenticated.apiAccess.rotateServiceToken.handler(
    async ({ context, input, signal, errors }) => ({
      token: await mapDeclaredErrors(
        () =>
          context.domains.apiAccess.rotateServiceToken(
            context.actor,
            input.params.name,
            signal,
          ),
        [
          notHosted(errors),
          declaredAs(
            ApiAccessOwnerRequiredError,
            errors.API_ACCESS_OWNER_REQUIRED,
          ),
          declaredAs(
            ApiAccessServiceNotFoundError,
            errors.API_ACCESS_SERVICE_NOT_FOUND,
          ),
        ],
      ),
    }),
  ),
  exchangeToken: exchange.apiAccess.exchangeToken.handler(({ context }) => ({
    token: context.apiToken,
  })),
  rotateToken: clientWindow.apiAccess.rotateToken.handler(
    async ({ context, signal, errors }) => ({
      token: await mapDeclaredErrors(
        () => context.domains.apiAccess.rotateToken(context.actor, signal),
        [notHosted(errors), declaredAs(ApiAccessDeniedError, errors.FORBIDDEN)],
      ),
    }),
  ),
};
