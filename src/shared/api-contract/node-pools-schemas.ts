import { z } from 'zod';
import { CloudType, DiskTier } from '../cloud.js';
import { NODE_POOL_WORKLOAD_STATE } from '../node-pools.js';
import { credentialNameSchema } from './credentials-schemas.js';

const vmCountSchema = z
  .number()
  .int()
  .min(0, 'VM counts must be non-negative integers')
  .max(Number.MAX_SAFE_INTEGER, 'VM counts must be safe integers');

/**
 * A pool scales between its bounds; equal bounds fix its size (RFC 0048),
 * and a minimum of 0 lets it reach zero Nodes when idle (RFC 0049 C22).
 */
export const NODE_POOL_BOUNDS_REASON =
  '--min-vms must be at most --max-vms, and --max-vms at least 1';

export const createNodePoolInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name is required')
      .max(64, 'name must be at most 64 characters'),
    /** Cluster ID or name. Optional: the installation has one cluster. */
    cluster: z.string().trim().min(1).optional(),
    credentialName: credentialNameSchema,
    /** Pins the pool; without it each VM launches in a catalog region. */
    region: z.string().trim().min(1).optional(),
    /** Requires `region`. */
    zone: z
      .string()
      .trim()
      .min(1)
      .max(63, 'zone must be at most 63 characters')
      .optional(),
    /** Ordered; every type must share one GPU kind and count. */
    vmTypes: z
      .array(z.string().trim().min(1))
      .min(1, 'at least one VM type is required'),
    minVmCount: vmCountSchema,
    maxVmCount: vmCountSchema,
    /** Omitted: the provider's default OS disk. */
    osDiskSizeGb: z.number().int().positive().optional(),
    osDiskTier: z.enum(DiskTier).optional(),
    /** Spot VMs, deleted on eviction; omitted: on-demand. */
    spot: z.boolean().optional(),
    /**
     * Admit pool Jobs' `--privileged` and `--bind`. A privileged Job is root
     * on its Node, so the pool must be single-tenant and trusted.
     * Deprecated; removed in the next release.
     */
    allowPrivilegedJobs: z.boolean().optional(),
    /**
     * Run every pool Job as root of its own user namespace (RFC 0049 C32).
     * CPU VM types only, and not with `allowPrivilegedJobs`.
     */
    userNamespaceJobs: z.boolean().optional(),
    /**
     * Keep only the VM types the catalog reports as supporting nested
     * virtualization, and launch them with it on; unknown counts as none.
     */
    requireNestedVirtualization: z.boolean().optional(),
  })
  .strict()
  .check((context) => {
    const { minVmCount, maxVmCount } = context.value;
    if (maxVmCount < 1 || minVmCount > maxVmCount) {
      context.issues.push({
        code: 'custom',
        input: context.value,
        path: ['minVmCount'],
        message: NODE_POOL_BOUNDS_REASON,
      });
    }
    // A privileged neighbour is root on the Node and would undo the option.
    if (context.value.allowPrivilegedJobs && context.value.userNamespaceJobs) {
      context.issues.push({
        code: 'custom',
        input: context.value,
        path: ['userNamespaceJobs'],
        message:
          '--user-namespace-jobs and --allow-privileged-jobs are exclusive: a privileged Job is root on its Node',
      });
    }
  });

export const listNodePoolsInputSchema = z
  .object({
    query: z
      .object({ cluster: z.string().trim().min(1).optional() })
      .strict()
      .optional(),
  })
  .optional();

const nodePoolCapacitySchema = z
  .object({
    readyVmCount: z.number().int().nonnegative(),
    startingVmCount: z.number().int().nonnegative(),
    drainingVmCount: z.number().int().nonnegative(),
    /** Where each live VM runs. */
    locations: z.array(
      z
        .object({
          region: z.string().min(1),
          zone: z.string().min(1).nullable(),
          vmType: z.string().min(1),
          /** Set while the VM is being released (draining). */
          releasing: z
            .object({
              /** When release was requested, in epoch milliseconds. */
              since: z.number().int().nonnegative(),
              /** The longest a normal release takes on this cloud. */
              usuallyUnderSeconds: z.number().int().positive(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    /**
     * The last pass that bought VMs, absent until the API process serving
     * this status has seen one; a restart forgets it.
     */
    lastScaleOut: z
      .object({
        /** In epoch milliseconds. */
        at: z.number().int().nonnegative(),
        pendingPods: z.number().int().nonnegative(),
        /** Stopped VMs whose Nodes ran a Workload, replaced in that pass. */
        lostVms: z.number().int().nonnegative(),
        /** VMs the pass asked for beyond the live ones. */
        vms: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const nodePoolIngressReleaseSchema = z
  .object({
    state: z.enum(['absent', 'installing', 'installed', 'failed']),
    helmJob: z
      .object({ phase: z.string(), message: z.string().nullable() })
      .strict()
      .nullable(),
    daemonSet: z
      .object({
        desired: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        entryNodeReady: z.boolean(),
      })
      .strict()
      .nullable(),
    lastEvent: z.string().nullable(),
    /** IngressRoutes labelled for the pool — the Services its Traefik serves. */
    routes: z.number().int().nonnegative(),
  })
  .strict();

/** The pool's ingress entry and the cluster's view of its Traefik release. */
const nodePoolIngressSchema = z
  .object({
    entryIp: z.string().nullable(),
    /** Null for a pool that hosts no Service and elected no entry. */
    release: nodePoolIngressReleaseSchema.nullable(),
  })
  .strict();

const nodePoolRunnersSchema = z
  .object({
    busy: z.number().int().nonnegative(),
    idle: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    /** Why Pending replicas wait: pool capacity, a spend cap, an image pull. */
    reasons: z.array(z.string()),
  })
  .strict();
export type NodePoolRunners = z.infer<typeof nodePoolRunnersSchema>;

export const nodePoolSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    clusterId: z.string().min(1),
    state: z.enum(Object.values(NODE_POOL_WORKLOAD_STATE)),
    /** Terminated, but its VMs are still being deleted (and billed). */
    releasing: z.boolean(),
    cloudProvider: z.enum(CloudType),
    /** Null when unpinned. */
    region: z.string().min(1).nullable(),
    zone: z.string().min(1).nullable(),
    vmTypes: z.array(z.string().min(1)).min(1),
    minVmCount: z.number().int().nonnegative(),
    maxVmCount: z.number().int().nonnegative(),
    /** Null: the provider's default. */
    osDiskSizeGb: z.number().int().positive().nullable(),
    osDiskTier: z.enum(DiskTier).nullable(),
    spot: z.boolean(),
    allowPrivilegedJobs: z.boolean(),
    userNamespaceJobs: z.boolean(),
    requireNestedVirtualization: z.boolean(),
    capacity: nodePoolCapacitySchema,
    /** Replicas that run `job --node-pool`, on status only; null when the cluster can't be read. */
    runners: nodePoolRunnersSchema.nullable().optional(),
    /** Live Workloads and Deployments still referencing the pool; delete is refused above zero. */
    liveReferences: z.number().int().nonnegative(),
    /** Public IP of the pool's ingress entry Node; null until one is elected. */
    ingressEntryIp: z.string().nullable(),
    ingress: nodePoolIngressSchema,
    lastError: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const nodePoolResponseSchema = z
  .object({ nodePool: nodePoolSummarySchema })
  .strict();

export const listNodePoolsResponseSchema = z
  .object({ nodePools: z.array(nodePoolSummarySchema) })
  .strict();

export type NodePoolSummary = z.output<typeof nodePoolSummarySchema>;
export type CreateNodePoolRequest = z.output<typeof createNodePoolInputSchema>;
export type CreateNodePoolResponse = z.output<typeof nodePoolResponseSchema>;
export type ListNodePoolsResponse = z.output<
  typeof listNodePoolsResponseSchema
>;
export type GetNodePoolResponse = z.output<typeof nodePoolResponseSchema>;
export type DeleteNodePoolResponse = z.output<typeof nodePoolResponseSchema>;
