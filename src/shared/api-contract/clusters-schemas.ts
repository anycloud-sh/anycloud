import { z } from 'zod';
import { CloudType } from '../cloud.js';
import { CLUSTER_WORKLOAD_STATES } from '../clusters.js';
import {
  deletedResourceSchema,
  remainingResourceSchema,
} from './lifecycle-results-schemas.js';

export const clusterReleaseSummarySchema = z
  .object({
    apiVersion: z.string().min(1),
    apiImage: z.string().min(1),
    chartVersion: z.string().min(1),
  })
  .strict();

/**
 * The installation's one cluster. The installer's record carries the creation
 * facts. The hosted API's own record (written on its start, reached through
 * its in-cluster ServiceAccount) carries those bootstrap handed it in the
 * release values: the cloud and account, location, VM type, management VM,
 * network scope, K3s pin and bucket. Before 0.1.74 it carried none, so they
 * are nullable, and it reports only its address, its API version and its URL.
 */
export const clusterSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    state: z.enum(CLUSTER_WORKLOAD_STATES),
    /** The management VM and its resources are still being released. */
    releasing: z.boolean(),
    cloudProvider: z.enum(CloudType).nullable(),
    /**
     * AWS account, GCP project or Azure subscription of the management VM; on
     * the hosted API's record only, null on Lambda.
     */
    cloudAccount: z.string().min(1).nullable(),
    region: z.string().min(1).nullable(),
    zone: z.string().min(1).nullable(),
    vmType: z.string().min(1).nullable(),
    k3sVersion: z.string().min(1).nullable(),
    /** The management VM's provider id, once it exists. */
    managementVmId: z.string().min(1).nullable(),
    /** Name and tag of the cluster's network resources (`anycloud-cluster-<id>`). */
    networkScope: z.string().min(1).nullable(),
    /**
     * The hosted API's checkpoint bucket; `managed` ones are Anycloud's and
     * kept by `cluster delete` unless it is given `--delete-buckets`. Null
     * once a delete removed the bucket, and on a hosted API's record from
     * before 0.1.74.
     */
    checkpointBucket: z
      .object({ name: z.string().min(1), managed: z.boolean() })
      .strict()
      .nullable(),
    apiVersion: z.string().min(1).nullable(),
    apiImage: z.string().min(1).nullable(),
    chartVersion: z.string().min(1).nullable(),
    /** Set once the record holds a connection to the control plane. */
    connected: z.boolean(),
    kubernetesIdentity: z.string().min(1).nullable(),
    connectionRevision: z.number().int().positive(),
    activeNodePoolCount: z.number().int().nonnegative(),
    /** Public address of the management VM once it exists. */
    address: z.string().min(1).nullable(),
    /**
     * The API's public URL (`https://<id>.anycloud.sh`, through Cloudflare)
     * once its release is complete, and always on the hosted API's own
     * record; the target for `anycloud api use`.
     */
    managementApiUrl: z.string().min(1).nullable(),
    release: clusterReleaseSummarySchema.nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const clusterResponseSchema = z
  .object({ cluster: clusterSummarySchema })
  .strict();

/** What the delete releases (in the background) and what it keeps. */
export const deleteClusterResponseSchema = z
  .object({
    cluster: clusterSummarySchema,
    deleted: z.array(deletedResourceSchema),
    remaining: z.array(remainingResourceSchema),
  })
  .strict();

export const forgetClusterResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Cloud resources left for the operator to delete by hand. */
    leftovers: z.array(z.string()),
  })
  .strict();

export const listClustersResponseSchema = z
  .object({ clusters: z.array(clusterSummarySchema) })
  .strict();

export type ClusterSummary = z.output<typeof clusterSummarySchema>;
export type ClusterResponse = z.output<typeof clusterResponseSchema>;
export type DeleteClusterResponse = z.output<
  typeof deleteClusterResponseSchema
>;
export type ListClustersResponse = z.output<typeof listClustersResponseSchema>;
