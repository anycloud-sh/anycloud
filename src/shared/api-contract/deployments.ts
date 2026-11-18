import { authenticatedEndpoints } from './base.js';
import {
  deploymentPathInputSchema,
  deploymentResponseSchema,
  createDeploymentInputSchema,
  listDeploymentsInputSchema,
  listDeploymentsResponseSchema,
  updateDeploymentInputSchema,
} from './deployments-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Deployments');

const errors = {
  DEPLOYMENT_INVALID: {
    status: 400,
    message: 'Invalid Deployment request',
  },
  DEPLOYMENT_NOT_FOUND: {
    status: 404,
    message: 'Deployment not found',
  },
  DEPLOYMENT_CONFLICT: {
    status: 409,
    message: 'Deployment conflict',
  },
  DEPLOYMENT_UNAVAILABLE: {
    status: 503,
    message: 'Deployment runtime unavailable',
  },
} as const;

const create = authenticated
  .command(
    {
      method: 'POST',
      path: '/deployments',
      operationId: 'createDeployment',
      summary: 'Create a jobs Deployment on a node pool',
      successStatus: 202,
    },
    { timeoutMs: 60_000 },
  )
  .input(createDeploymentInputSchema)
  .output(deploymentResponseSchema)
  .errors(errors);

const list = authenticated
  .query({
    method: 'GET',
    path: '/deployments',
    operationId: 'listDeployments',
    summary: 'List Deployments',
    inputStructure: 'detailed',
  })
  .input(listDeploymentsInputSchema)
  .output(listDeploymentsResponseSchema)
  .errors({ DEPLOYMENT_INVALID: errors.DEPLOYMENT_INVALID });

const get = authenticated
  .query({
    method: 'GET',
    path: '/deployments/{id}',
    operationId: 'getDeployment',
    summary: 'Get Deployment status',
    inputStructure: 'detailed',
  })
  .input(deploymentPathInputSchema)
  .output(deploymentResponseSchema)
  .errors(errors);

const update = authenticated
  .command(
    {
      method: 'PATCH',
      path: '/deployments/{id}',
      operationId: 'updateDeployment',
      summary: 'Update a jobs Deployment',
      inputStructure: 'detailed',
      successStatus: 202,
    },
    { timeoutMs: 60_000 },
  )
  .input(updateDeploymentInputSchema)
  .output(deploymentResponseSchema)
  .errors(errors);

const remove = authenticated
  .command(
    {
      method: 'DELETE',
      path: '/deployments/{id}',
      operationId: 'deleteDeployment',
      summary: 'Drain and delete a jobs Deployment',
      inputStructure: 'detailed',
      successStatus: 202,
    },
    { timeoutMs: 60_000 },
  )
  .input(deploymentPathInputSchema)
  .output(deploymentResponseSchema)
  .errors(errors);

export const deploymentsContract = {
  create,
  list,
  get,
  update,
  delete: remove,
};
