import { SecretInUseError } from '../../shared/errors.js';
import { declaredError, mapDeclaredErrors } from './errors.js';
import { authenticatedImplementation as authenticated } from './base.js';

export const secretsRouter = {
  list: authenticated.secrets.list.handler(({ context, signal }) =>
    context.domains.secrets.list(signal),
  ),
  save: authenticated.secrets.save.handler(
    async ({ context, input, signal }) => {
      await context.domains.secrets.save(input, signal);
    },
  ),
  delete: authenticated.secrets.delete.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.secrets.delete(
            input.params.name,
            input.query.force ?? false,
            signal,
          ),
        [
          declaredError(SecretInUseError, (error) =>
            errors.SECRET_IN_USE({
              message: error.message,
              data: {
                name: error.secretName,
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
