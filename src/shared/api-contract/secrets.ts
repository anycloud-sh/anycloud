import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import {
  booleanQueryValueSchema,
  noContentSchema,
  noInputSchema,
} from './common-schemas.js';
import {
  listSecretsResponseSchema,
  saveSecretRequestSchema,
  secretInUseDataSchema,
  secretNameSchema,
} from './secrets-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Secrets');

const deleteSecretRequestSchema = z.object({
  params: z.object({ name: secretNameSchema }).strict(),
  query: z.object({ force: booleanQueryValueSchema.optional() }).strict(),
});

const list = authenticated
  .query({
    method: 'GET',
    path: '/secrets',
    operationId: 'listSecrets',
    summary: 'List secret metadata',
  })
  .input(noInputSchema)
  .output(listSecretsResponseSchema);

const save = authenticated
  .command({
    method: 'PUT',
    path: '/secrets/{name}',
    operationId: 'saveSecret',
    summary: 'Create or replace a secret',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(saveSecretRequestSchema)
  .output(noContentSchema);

const remove = authenticated
  .command({
    method: 'DELETE',
    path: '/secrets/{name}',
    operationId: 'deleteSecret',
    summary: 'Delete a secret',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(deleteSecretRequestSchema)
  .output(noContentSchema)
  .errors({
    SECRET_IN_USE: {
      status: 409,
      message: 'Secret is in use',
      data: secretInUseDataSchema,
    },
  });

export const secretsContract = { list, save, delete: remove };
