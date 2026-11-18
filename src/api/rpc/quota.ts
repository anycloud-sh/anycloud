import { DeployError } from '../../shared/errors.js';
import {
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

/** Provider and credential rejections surface as ordinary 400 DeployErrors. */
function badRequest(factory: DeclaredErrorFactory): DeclaredErrorMapping {
  return declaredError(DeployError, (error) =>
    error.statusCode === 400
      ? factory({ message: error.message, cause: error })
      : undefined,
  );
}

export const quotaRouter = {
  canceled: authenticated.quota.canceled.handler(({ context }) =>
    context.domains.quota.canceled(context.actor),
  ),
  status: clientWindow.quota.status.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.quota.status(
            context.actor,
            input.query,
            context.clientVersion,
            signal,
          ),
        [badRequest(errors.QUOTA_STATUS_INVALID)],
      ),
  ),
};
