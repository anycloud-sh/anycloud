import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import { DeploymentDomainError } from '../services/deployment-errors.js';
import {
  throwDeclaredDeployError,
  throwDeclaredError,
  type DeclaredErrorCodes,
} from './errors.js';
import { clientWindowAuthenticatedImplementation as authenticated } from './base.js';

const CODES = {
  400: 'DEPLOYMENT_INVALID',
  404: 'DEPLOYMENT_NOT_FOUND',
  409: 'DEPLOYMENT_CONFLICT',
  503: 'DEPLOYMENT_UNAVAILABLE',
} satisfies DeclaredErrorCodes;

function throwDeploymentError(error: unknown): never {
  if (error instanceof DeploymentDomainError) {
    throwDeclaredError(error, error.statusCode, error.message, CODES);
  }
  if (error instanceof InvalidAnycloudConfigError) {
    throwDeclaredError(error, 400, error.message, CODES);
  }
  throwDeclaredDeployError(error, CODES);
}

export const deploymentsRouter = {
  create: authenticated.deployments.create.handler(
    async ({ context, input, signal }) => {
      try {
        return await context.domains.deployments.create(
          context.actor,
          input,
          signal,
        );
      } catch (error) {
        throwDeploymentError(error);
      }
    },
  ),
  list: authenticated.deployments.list.handler(
    async ({ context, input, signal }) => {
      try {
        const query = input?.query;
        return await context.domains.deployments.list(
          context.actor,
          query?.nodePool === undefined ? undefined : query,
          signal,
        );
      } catch (error) {
        throwDeploymentError(error);
      }
    },
  ),
  get: authenticated.deployments.get.handler(
    async ({ context, input, signal }) => {
      try {
        return await context.domains.deployments.get(
          context.actor,
          input.params.id,
          signal,
        );
      } catch (error) {
        throwDeploymentError(error);
      }
    },
  ),
  update: authenticated.deployments.update.handler(
    async ({ context, input, signal }) => {
      try {
        return await context.domains.deployments.update(
          context.actor,
          input.params.id,
          input.body,
          signal,
        );
      } catch (error) {
        throwDeploymentError(error);
      }
    },
  ),
  delete: authenticated.deployments.delete.handler(
    async ({ context, input, signal }) => {
      try {
        return await context.domains.deployments.delete(
          context.actor,
          input.params.id,
          signal,
        );
      } catch (error) {
        throwDeploymentError(error);
      }
    },
  ),
};
