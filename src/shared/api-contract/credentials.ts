import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import {
  booleanQueryValueSchema,
  noContentSchema,
  noInputSchema,
} from './common-schemas.js';
import {
  credentialErrorDataSchema,
  credentialInUseDataSchema,
  credentialListSchema,
  credentialsExistDataSchema,
  credentialNameSchema,
  redactedCredentialSchema,
  saveCredentialRequestSchema,
  updateCredentialRequestSchema,
} from './credentials-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Credentials');

const credentialPathInputSchema = z.object({
  params: z.object({ name: credentialNameSchema }).strict(),
});

const deleteCredentialRequestSchema = z.object({
  params: z.object({ name: credentialNameSchema }).strict(),
  query: z.object({ force: booleanQueryValueSchema.optional() }).strict(),
});

// The same material is saved under another name, named in `existingName`.
const credentialsExistError = {
  CREDENTIALS_EXIST: {
    status: 409,
    message: 'These credentials are already saved under another name',
    data: credentialsExistDataSchema,
  },
};

const notFoundError = {
  CREDENTIAL_NOT_FOUND: {
    status: 404,
    message: 'Credential not found',
    data: credentialErrorDataSchema,
  },
};

const list = authenticated
  .query({
    method: 'GET',
    path: '/credentials',
    operationId: 'listCredentials',
    summary: 'List redacted credentials',
  })
  .input(noInputSchema)
  .output(credentialListSchema);

const get = authenticated
  .query({
    method: 'GET',
    path: '/credentials/{name}',
    operationId: 'getCredential',
    summary: 'Get one redacted credential',
    inputStructure: 'detailed',
  })
  .input(credentialPathInputSchema)
  .output(redactedCredentialSchema)
  .errors(notFoundError);

const save = authenticated
  .command(
    {
      method: 'PUT',
      path: '/credentials/{name}',
      operationId: 'saveCredential',
      summary: 'Create or replace a credential',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    // A role connection's check makes one exchange with its cloud.
    { timeoutMs: 30_000 },
  )
  .input(saveCredentialRequestSchema)
  .output(noContentSchema)
  .errors({
    ...credentialsExistError,
    CREDENTIAL_NAME_EXISTS: {
      status: 409,
      message: 'Credential name already exists',
      data: credentialErrorDataSchema,
    },
    ROLE_CONNECTION_REFUSED: {
      status: 400,
      message: 'The role connection failed its check',
      data: credentialErrorDataSchema,
    },
    // Nothing was stored; the client repeats the save.
    ROLE_CONNECTION_PENDING: {
      status: 503,
      message:
        'Waiting for the cloud to grant or stop throttling the role connection',
      data: credentialErrorDataSchema,
    },
  });

const update = authenticated
  .command({
    method: 'PATCH',
    path: '/credentials/{name}',
    operationId: 'updateCredential',
    summary: 'Change some fields of a credential',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(updateCredentialRequestSchema)
  .output(noContentSchema)
  .errors({
    ...notFoundError,
    ...credentialsExistError,
    CREDENTIAL_UPDATE_INVALID: {
      status: 400,
      message: 'The fields do not apply to this credential',
      data: credentialErrorDataSchema,
    },
    CREDENTIAL_CHANGED: {
      status: 409,
      message: 'Credential changed during the edit',
      data: credentialErrorDataSchema,
    },
  });

const remove = authenticated
  .command({
    method: 'DELETE',
    path: '/credentials/{name}',
    operationId: 'deleteCredential',
    summary: 'Delete a credential',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(deleteCredentialRequestSchema)
  .output(noContentSchema)
  .errors({
    CREDENTIAL_IN_USE: {
      status: 409,
      message: 'Credential is in use',
      data: credentialInUseDataSchema,
    },
  });

export const credentialsContract = {
  list,
  get,
  save,
  update,
  delete: remove,
};
