import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import {
  createNodePoolInputSchema,
  listNodePoolsInputSchema,
  listNodePoolsResponseSchema,
  nodePoolResponseSchema,
} from './node-pools-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Node pools');

const nodePoolPathInputSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
});

const notFound = {
  NODE_POOL_NOT_FOUND: {
    status: 404,
    message: 'Node pool not found',
  },
} as const;

const clusterNotFound = {
  CLUSTER_NOT_FOUND: {
    status: 404,
    message: 'Cluster not found',
  },
} as const;

const create = authenticated
  .command(
    {
      method: 'POST',
      path: '/node-pools',
      operationId: 'createNodePool',
      summary: 'Create a node pool in the cluster',
      successStatus: 202,
    },
    { timeoutMs: 60_000 },
  )
  .input(createNodePoolInputSchema)
  .output(nodePoolResponseSchema)
  .errors({
    NODE_POOLS_UNAVAILABLE: {
      status: 400,
      message: 'This Anycloud API has no running cluster',
    },
    NODE_POOL_INVALID: {
      status: 400,
      message: 'Invalid node pool request',
    },
    NODE_POOL_CREDENTIAL_NOT_FOUND: {
      status: 400,
      message: 'Node pool credential not found',
    },
    ...clusterNotFound,
    CLUSTER_NOT_ACCEPTING: {
      status: 409,
      message: 'Cluster does not accept node pools',
    },
    NODE_POOL_ALREADY_EXISTS: {
      status: 409,
      message: 'Node pool already exists',
    },
  });

const list = authenticated
  .query({
    method: 'GET',
    path: '/node-pools',
    operationId: 'listNodePools',
    summary: 'List node pools',
    inputStructure: 'detailed',
  })
  .input(listNodePoolsInputSchema)
  .output(listNodePoolsResponseSchema)
  .errors(clusterNotFound);

const get = authenticated
  .query({
    method: 'GET',
    path: '/node-pools/{id}',
    operationId: 'getNodePool',
    summary: 'Get node pool status',
    inputStructure: 'detailed',
  })
  .input(nodePoolPathInputSchema)
  .output(nodePoolResponseSchema)
  .errors(notFound);

const remove = authenticated
  .command(
    {
      method: 'DELETE',
      path: '/node-pools/{id}',
      operationId: 'deleteNodePool',
      summary: 'Delete a node pool after its references are released',
      inputStructure: 'detailed',
      successStatus: 202,
    },
    { timeoutMs: 60_000 },
  )
  .input(nodePoolPathInputSchema)
  .output(nodePoolResponseSchema)
  .errors({
    ...notFound,
    NODE_POOL_REFERENCED: {
      status: 409,
      message: 'Node pool still has live references',
    },
  });

export const nodePoolsContract = { create, list, get, delete: remove };
