import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import { noContentSchema, noInputSchema } from './common-schemas.js';
import {
  apiAccessMemberSchema,
  apiAccessUserIdSchema,
  apiAccessUsersResponseSchema,
  apiTokenResponseSchema,
  grantApiAccessInputSchema,
} from './api-access-schemas.js';

const authenticated = authenticatedEndpoints({}, 'API Access');

const userPathInputSchema = z.object({
  params: z.object({ userId: apiAccessUserIdSchema }).strict(),
});

const noRequestSchema = z.object({});

const notHostedError = {
  API_ACCESS_NOT_HOSTED: {
    status: 400,
    message: 'API access sharing is only available on a hosted API',
  },
};

const ownerRequiredError = {
  API_ACCESS_OWNER_REQUIRED: {
    status: 403,
    message: 'Only the hosted API owner can grant or remove access',
  },
};

const list = authenticated
  .query({
    method: 'GET',
    path: '/api-access/users',
    operationId: 'listApiAccessUsers',
    summary: 'List hosted API users',
  })
  .input(noInputSchema)
  .output(apiAccessUsersResponseSchema)
  .errors(notHostedError);

const grant = authenticated
  .command({
    method: 'POST',
    path: '/api-access/users',
    operationId: 'grantApiAccessUser',
    summary: 'Grant hosted API access',
  })
  .input(grantApiAccessInputSchema)
  .output(apiAccessMemberSchema)
  .errors({
    ...notHostedError,
    ...ownerRequiredError,
    API_ACCESS_ACCOUNT_NOT_USER: {
      status: 400,
      message: 'GitHub account is not a user',
    },
    API_ACCESS_MANAGED_DEPLOYMENT: {
      status: 400,
      message: 'A managed Deployment cannot be registered',
    },
    API_ACCESS_NAME_TAKEN: {
      status: 400,
      message: 'A GitHub login with access has this name',
    },
  });

const revoke = authenticated
  .command({
    method: 'DELETE',
    path: '/api-access/users/{userId}',
    operationId: 'revokeApiAccessUser',
    summary: 'Revoke hosted API access',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(userPathInputSchema)
  .output(noContentSchema)
  .errors({
    ...notHostedError,
    ...ownerRequiredError,
    INVALID_GITHUB_USER_ID: {
      status: 400,
      message: 'Invalid GitHub user id',
    },
    API_ACCESS_OWNER_CANNOT_BE_REMOVED: {
      status: 400,
      message: 'The hosted API owner cannot be removed',
    },
  });

/** The bearer is a GitHub sign-in; served within the release window. */
const exchangeToken = authenticated
  .command(
    {
      method: 'POST',
      path: '/api-token',
      operationId: 'exchangeApiToken',
      summary: 'Exchange a GitHub sign-in for this API token',
      inputStructure: 'detailed',
    },
    { replay: 'safe' }, // the same token until it is rotated
  )
  .input(noRequestSchema)
  .output(apiTokenResponseSchema);

const rotateToken = authenticated
  .command({
    method: 'POST',
    path: '/api-token/rotate',
    operationId: 'rotateApiToken',
    summary: "Replace the caller's API token",
    inputStructure: 'detailed',
  })
  .input(noRequestSchema)
  .output(apiTokenResponseSchema)
  .errors(notHostedError);

export const apiAccessContract = {
  list,
  grant,
  revoke,
  exchangeToken,
  rotateToken,
};
