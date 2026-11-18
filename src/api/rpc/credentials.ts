import {
  CredentialChangedError,
  CredentialInUseError,
  CredentialNameExistsError,
  CredentialsExistError,
} from '../../shared/errors.js';
import {
  CredentialNotFoundError,
  InvalidCredentialUpdateError,
  RoleConnectionPendingError,
  RoleConnectionRefusedError,
} from '../services/credentials-domain.js';
import {
  declaredError,
  mapDeclaredErrors,
  type DeclaredErrorMapping,
} from './errors.js';
import {
  authenticatedImplementation as authenticated,
  clientWindowAuthenticatedImplementation as clientWindow,
} from './base.js';

function credentialNotFound(errors: {
  CREDENTIAL_NOT_FOUND(options: {
    message: string;
    data: { name: string };
    cause: Error;
  }): Error;
}): DeclaredErrorMapping {
  return declaredError(CredentialNotFoundError, (error) =>
    errors.CREDENTIAL_NOT_FOUND({
      message: error.message,
      data: { name: error.credentialName },
      cause: error,
    }),
  );
}

function credentialsExist(errors: {
  CREDENTIALS_EXIST(options: {
    message: string;
    data: { name: string; existingName: string };
    cause: Error;
  }): Error;
}): DeclaredErrorMapping {
  return declaredError(CredentialsExistError, (error) =>
    errors.CREDENTIALS_EXIST({
      message: error.message,
      data: { name: error.credentialName, existingName: error.existingName },
      cause: error,
    }),
  );
}

export const credentialsRouter = {
  list: clientWindow.credentials.list.handler(({ context, signal }) =>
    context.domains.credentials.list(signal),
  ),
  get: clientWindow.credentials.get.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () => context.domains.credentials.get(input.params.name, signal),
        [credentialNotFound(errors)],
      ),
  ),
  save: authenticated.credentials.save.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () => context.domains.credentials.save(input, signal),
        [
          credentialsExist(errors),
          declaredError(CredentialNameExistsError, (error) =>
            errors.CREDENTIAL_NAME_EXISTS({
              message: error.message,
              data: { name: error.credentialName },
              cause: error,
            }),
          ),
          declaredError(RoleConnectionRefusedError, (error) =>
            errors.ROLE_CONNECTION_REFUSED({
              message: error.message,
              data: { name: error.credentialName },
              cause: error,
            }),
          ),
          declaredError(RoleConnectionPendingError, (error) =>
            errors.ROLE_CONNECTION_PENDING({
              message: error.message,
              data: { name: input.name },
              cause: error,
            }),
          ),
        ],
      );
    },
  ),
  update: authenticated.credentials.update.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () => context.domains.credentials.update(input, signal),
        [
          credentialNotFound(errors),
          credentialsExist(errors),
          declaredError(InvalidCredentialUpdateError, (error) =>
            errors.CREDENTIAL_UPDATE_INVALID({
              message: error.message,
              data: { name: error.credentialName },
              cause: error,
            }),
          ),
          declaredError(CredentialChangedError, (error) =>
            errors.CREDENTIAL_CHANGED({
              message: error.message,
              data: { name: error.credentialName },
              cause: error,
            }),
          ),
        ],
      );
    },
  ),
  delete: authenticated.credentials.delete.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.credentials.delete(
            input.params.name,
            input.query.force ?? false,
            signal,
          ),
        [
          declaredError(CredentialInUseError, (error) =>
            errors.CREDENTIAL_IN_USE({
              message: error.message,
              data: {
                name: error.credentialName,
                workloadIds: error.workloadIds,
              },
              cause: error,
            }),
          ),
        ],
      );
    },
  ),
};
