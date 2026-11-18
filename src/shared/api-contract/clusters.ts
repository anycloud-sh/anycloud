import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import { booleanQueryValueSchema, noInputSchema } from './common-schemas.js';
import {
  clusterResponseSchema,
  deleteClusterResponseSchema,
  forgetClusterResponseSchema,
  listClustersResponseSchema,
} from './clusters-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Clusters');

const clusterPathInputSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
});

const deleteClusterInputSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  /** RFC 0049 C28: delete the managed checkpoint bucket too; kept otherwise. */
  query: z
    .object({ deleteBuckets: booleanQueryValueSchema.optional() })
    .strict(),
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

/**
 * Independent infrastructure deletion. Runs on the API that created the
 * cluster; refused while node pools exist. The managed checkpoint bucket is
 * kept, after a final backup, unless `deleteBuckets` is set; on a destroyed
 * record that flag deletes only the kept bucket.
 */
const destroy = authenticated
  .command(
    {
      method: 'DELETE',
      path: '/clusters/{id}',
      operationId: 'destroyCluster',
      summary: 'Destroy the cluster and release its management VM',
      inputStructure: 'detailed',
      successStatus: 202,
    },
    // The final backup runs before it answers.
    { timeoutMs: 180_000 },
  )
  .input(deleteClusterInputSchema)
  .output(deleteClusterResponseSchema)
  .errors({
    ...notFound,
    CLUSTER_REFERENCED: {
      status: 409,
      message: 'cluster still has active node pools',
    },
    /** Restore the hosted API first, or clean up by hand and forget it. */
    CLUSTER_UNREACHABLE: {
      status: 409,
      message: 'The hosted API is unreachable; restore it or clean up by hand',
    },
    CLUSTER_BUSY: {
      status: 409,
      message: 'Cluster has an operation in progress',
    },
    /** The hosted API answered but refused this account or CLI version. */
    CLUSTER_INVALID: {
      status: 400,
      message: 'Cluster request is invalid',
    },
  });

/**
 * Delete the installer's record, and its DNS record, of a cluster whose hosted
 * API is unreachable and whose management VM is gone. Never touches the cloud
 * or the checkpoint bucket and its backups.
 */
const forget = authenticated
  .command({
    method: 'POST',
    path: '/clusters/{id}/forget',
    operationId: 'forgetCluster',
    summary: 'Forget a cluster whose hosted API is unreachable',
    inputStructure: 'detailed',
  })
  .input(clusterPathInputSchema)
  .output(forgetClusterResponseSchema)
  .errors({
    ...notFound,
    CLUSTER_REACHABLE: {
      status: 409,
      message: 'The hosted API is reachable; delete the cluster instead',
    },
    CLUSTER_VM_PRESENT: {
      status: 409,
      message: 'The management VM still exists or could not be checked',
    },
    CLUSTER_BUSY: {
      status: 409,
      message: 'Cluster has an operation in progress',
    },
  });

export const clustersContract = {
  list,
  get,
  destroy,
  forget,
};
