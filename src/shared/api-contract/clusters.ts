import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import { noInputSchema } from './common-schemas.js';
import {
  clusterResponseSchema,
  listClustersResponseSchema,
} from './clusters-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Clusters');

const clusterPathInputSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
});

const notFound = {
  CLUSTER_NOT_FOUND: {
    status: 404,
    message: 'Cluster not found',
  },
} as const;

// Create runs through the user's own cloud CLI (RFC 0049 C26 (e)): no API
// creates the cluster it would run in.

const list = authenticated
  .query({
    method: 'GET',
    path: '/clusters',
    operationId: 'listClusters',
    summary: 'List clusters',
  })
  .input(noInputSchema)
  .output(listClustersResponseSchema);

const get = authenticated
  .query({
    method: 'GET',
    path: '/clusters/{id}',
    operationId: 'getCluster',
    summary: 'Get cluster status',
    inputStructure: 'detailed',
  })
  .input(clusterPathInputSchema)
  .output(clusterResponseSchema)
  .errors(notFound);

export const clustersContract = {
  list,
  get,
};
