import { z } from 'zod';
import { CloudType, DiskTier } from '../cloud.js';
import { END_REASONS, WorkloadState } from '../workload.js';
import { ImageRuntime } from '../image.js';
import {
  ContainerState,
  WorkloadHealthStatus,
  ServiceState,
} from '../runtime.js';
import { messageResponseSchema } from './common-schemas.js';
import { credentialNameSchema } from './credentials-schemas.js';

const attributionSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().max(64));

const booleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const finiteNumberQuerySchema = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().finite());
const positiveNumberQuerySchema = finiteNumberQuerySchema.pipe(
  z.number().positive(),
);
const attributionFilterQueryShape = {
  session: attributionSchema.optional(),
  sessionExact: booleanQuerySchema.optional(),
  agent: attributionSchema.optional(),
  user: z.string().optional(),
};
export const workloadIdSchema = z.string().trim().min(1);
export const workloadPathParametersSchema = z
  .object({ id: workloadIdSchema })
  .strict();

export const exactWorkloadCostRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    query: z.object(attributionFilterQueryShape).strict(),
  })
  .transform(({ params, query }) => ({ ...params, ...query }));

export const aggregateWorkloadCostRequestSchema = z.object({
  query: z
    .object({
      ...attributionFilterQueryShape,
      sinceMs: finiteNumberQuerySchema,
    })
    .strict(),
});

export const workloadListRequestSchema = z.object({
  query: z
    .object({
      ...attributionFilterQueryShape,
      limit: positiveNumberQuerySchema.optional(),
      sinceMs: finiteNumberQuerySchema.optional(),
      stateClass: z.enum(['terminatable', 'resubmittable']).optional(),
      status: z.string().optional(),
      workloadType: z.enum(['job', 'service', 'vm']).optional(),
      deploymentId: workloadIdSchema.optional(),
      credentialName: credentialNameSchema.optional(),
      filter: z.string().optional(),
    })
    .strict(),
});

export const workloadTerminateRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    query: z.object({ session: attributionSchema.optional() }).strict(),
  })
  .transform(({ params, query }) => ({ ...params, ...query }));

/**
 * A status read returns the most recent events only: a long-lived workload's
 * history runs to thousands of rows (megabytes per read), while the CLI and
 * every monitor need the tail. `eventsLimit=all` asks for the whole history.
 */
export const DEFAULT_STATUS_EVENTS_LIMIT = 200;
const eventsLimitQuerySchema = z.union([
  z.literal('all'),
  finiteNumberQuerySchema.pipe(z.number().int().positive()),
]);

export const workloadStatusRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    query: z
      .object({
        verbose: booleanQuerySchema.optional(),
        eventsLimit: eventsLimitQuerySchema.optional(),
      })
      .strict(),
  })
  .transform(({ params, query }) => ({ ...params, ...query }));

export const workloadSshAccessRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    query: z.object({ mode: z.enum(['container', 'vm', 'snapshot']) }).strict(),
  })
  .transform(({ params, query }) => ({ ...params, ...query }));

export const workloadResubmitBodySchema = z
  .object({
    session: attributionSchema.optional(),
  })
  .strict();

export const workloadResubmitRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    body: workloadResubmitBodySchema,
  })
  .transform(({ params, body }) => ({ ...params, ...body }));

export const workloadResubmitResponseSchema = messageResponseSchema;

const stringOrStringsSchema = z.union([z.string(), z.array(z.string())]);

export const dockerOptionsSchema = z
  .object({
    privileged: z.boolean().optional(),
    shmSize: z.string().optional(),
    gpus: z.string().optional(),
    ipc: z.string().optional(),
    ulimits: z.array(z.string()).optional(),
    memory: z.string().optional(),
    cpus: z.string().optional(),
    runtime: z.string().optional(),
    binds: z.array(z.string()).optional(),
    network: z.string().optional(),
  })
  .strict();

const storedWorkloadSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    workloadType: z.enum(['job', 'service', 'vm']),
    image: z.string().nullable(),
    cloudProvider: z.enum(CloudType).nullable(),
    region: z.string().nullable(),
    vmType: stringOrStringsSchema.nullable(),
    gpuType: stringOrStringsSchema.nullable(),
    spot: z.boolean(),
    state: z.enum(WorkloadState),
    startedAt: z.number(),
    completedAt: z.number().nullable(),
    cleanedAt: z.number().nullable().optional(),
    /** Why cleanup is still pending: the last failed attempt's reason. Absent on older APIs. */
    cleanupError: z.string().nullable().optional(),
    /** Why it ended; null before a terminal state or if unrecorded. See `END_REASONS`. */
    endReason: z.enum(END_REASONS).nullable(),
    /** With `retries-exhausted`: what ended the final attempt, if known. */
    lastAttemptEndReason: z.enum(END_REASONS).nullable(),
    version: z.string().nullable(),
    dockerCommand: z.string(),
    inputBucket: z.string().nullable(),
    outputBucket: z.string().nullable(),
    checkpointBucket: z.string().nullable(),
    diskSizeGb: z.number().nullable(),
    diskTier: z.enum(DiskTier).nullable(),
    /** A VM Job's own AWS gp3 root volume IOPS and MiB/s, as requested. */
    diskIops: z.number().int().nullable(),
    diskThroughputMibps: z.number().int().nullable(),
    /** A VM Job's region allow-list, as requested. */
    regions: z.array(z.string()).nullable(),
    dockerOptions: dockerOptionsSchema.nullable(),
    availabilityZone: z.string().nullable(),
    vmCount: z.number().int().nonnegative(),
    credentialId: z.string().nullable(),
    inputStorageCredentialId: z.string().nullable(),
    inputStorageRegion: z.string().nullable(),
    outputStorageCredentialId: z.string().nullable(),
    outputStorageRegion: z.string().nullable(),
    checkpointStorageCredentialId: z.string().nullable(),
    checkpointStorageRegion: z.string().nullable(),
    command: z.array(z.string()).nullable(),
    imageDigest: z.string().nullable(),
    imageRuntime: z.enum(ImageRuntime).nullable(),
    vmDurationMs: z.number().nullable(),
    awaitingReleaseMs: z.number().nullable(),
    totalCost: z.number().nullable(),
    costSource: z.enum(['actual', 'estimated']).nullable(),
    dnsRecordId: z.string().nullable(),
    secretNames: z.array(z.string()).nullable(),
    session: z.string().nullable(),
    agent: z.string().nullable(),
    sessionLabel: z.string().nullable(),
    latestMessage: z.string().nullable(),
  })
  .strict();

/** Every Workload runs on a VM host from its own container image. */
function hasContainerImage(workload: { image: string | null }): boolean {
  return workload.image !== null;
}

const workloadListRowSchema = storedWorkloadSchema
  .extend({
    // Request-relative presentation metadata. This is computed from the
    // immutable owner id and never persisted as workload state.
    isOwnedByCaller: z.boolean(),
  })
  .strict()
  .refine(hasContainerImage, { message: 'A Workload has a container image' });

export const workloadListResponseSchema = z.array(workloadListRowSchema);

const costWorkloadTypeCountsShape = {
  jobs: z.number().int().nonnegative(),
  services: z.number().int().nonnegative(),
  vms: z.number().int().nonnegative(),
};

const workloadCostRowSchema = z
  .object({
    id: z.string(),
    workloadType: z.enum(['job', 'service', 'vm']),
    image: z.string().nullable(),
    cloudProvider: z.enum(CloudType).nullable(),
    region: z.string().nullable(),
    vmType: stringOrStringsSchema.nullable(),
    spot: z.boolean(),
    vmDurationMs: z.number().nullable(),
    awaitingReleaseMs: z.number().nullable(),
    totalCost: z.number().nullable(),
    costSource: z.enum(['actual', 'estimated']).nullable(),
    agent: z.string().nullable(),
  })
  .strict()
  .refine(hasContainerImage, { message: 'A Workload has a container image' });

const providerCostSummarySchema = z
  .object({
    ...costWorkloadTypeCountsShape,
    cost: z.number(),
    durationMs: z.number(),
    hasSpot: z.boolean(),
  })
  .strict();

const attributionCostSummarySchema = z
  .object({
    ...costWorkloadTypeCountsShape,
    cost: z.number(),
    durationMs: z.number(),
  })
  .strict();

export const workloadCostReportSchema = z
  .object({
    periodMs: z.number(),
    totalCost: z.number(),
    totalDurationMs: z.number(),
    totalJobs: z.number().int().nonnegative(),
    totalServices: z.number().int().nonnegative(),
    totalVms: z.number().int().nonnegative(),
    workloadsWithoutPrice: z.number().int().nonnegative(),
    byProvider: z.record(z.string(), providerCostSummarySchema),
    byAgent: z.record(z.string(), attributionCostSummarySchema),
    byUser: z.record(z.string(), attributionCostSummarySchema),
    // True when priced spend in this exact report includes work owned by an
    // account other than the authenticated caller.
    includesOtherUsers: z.boolean(),
  })
  .strict();

export const workloadCostRowsSchema = z.array(workloadCostRowSchema);

const statusWorkloadMetadataSchema = storedWorkloadSchema
  .omit({
    credentialId: true,
    inputStorageCredentialId: true,
    outputStorageCredentialId: true,
    checkpointStorageCredentialId: true,
    imageRuntime: true,
    latestMessage: true,
  })
  .refine(hasContainerImage, { message: 'A Workload has a container image' });

const workloadEventSchema = z
  .object({
    id: z.number().int(),
    workloadId: z.string(),
    state: z.union([z.enum(WorkloadState), z.literal('baking')]),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.number(),
  })
  .strict();

const serviceStatusSchema = z
  .object({
    status: z.enum(ServiceState),
    logs: z.string().optional(),
  })
  .strict();

const containerStatusSchema = z
  .object({
    state: z.enum(ContainerState),
    exitCode: z.number().optional(),
    oomKilled: z.boolean().optional(),
    logs: z.string().optional(),
    uptime: z.string().optional(),
  })
  .strict();

const checkpointHealthSchema = z
  .object({
    objects: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    lastModifiedAt: z.number().nullable(),
    /** True when the listing stopped at its page limit; counts are lower bounds. */
    truncated: z.boolean(),
  })
  .strict();

export type CheckpointHealth = z.output<typeof checkpointHealthSchema>;

/**
 * A GPU VM's NVIDIA GPU health (report only): `unhealthy` when a GPU needs a
 * reset or logged an Xid that means it does, or nvidia-smi hung; `unknown`
 * when it couldn't be read.
 */
const gpuHealthSchema = z
  .object({
    state: z.enum(['healthy', 'unhealthy', 'unknown']),
    gpus: z.array(
      z
        .object({
          /** nvidia-smi's index; null for a GPU it no longer lists. */
          index: z.number().int().nonnegative().nullable(),
          /** The GPU's PCI address, as nvidia-smi or the kernel names it. */
          pci: z.string(),
          resetRequired: z.boolean(),
          recoveryAction: z.string().nullable(),
          /** This boot's latest Xids on the GPU, newest last. */
          xids: z.array(
            z
              .object({
                code: z.number().int(),
                at: z.string().nullable(),
                message: z.string(),
                /** An Xid after which the GPU needs a reset or a new host. */
                resetNeeded: z.boolean(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    detail: z.string().optional(),
  })
  .strict();

export type GpuHealth = z.output<typeof gpuHealthSchema>;

const statusVmSchema = z
  .object({
    ip: z.string(),
    sshHost: z.string().optional(),
    sshPort: z.number().optional(),
    sshUsername: z.string().optional(),
    cloudId: z.string().optional(),
    region: z.string().nullable().optional(),
    availabilityZone: z.string().nullable().optional(),
    /** The VM type this VM launched as; the Workload's `vmType` is what was asked for. */
    vmType: z.string().optional(),
    endedAt: z.number().nullable(),
    container: containerStatusSchema.optional(),
    rclone: z
      .object({
        output: serviceStatusSchema.optional(),
        checkpoint: serviceStatusSchema.optional(),
      })
      .strict()
      .optional(),
    gpu: gpuHealthSchema.optional(),
  })
  .strict();

export const workloadStatusResponseSchema = z
  .object({
    workload: statusWorkloadMetadataSchema,
    /** The most recent `eventsLimit` events in chronological order. */
    events: z.array(workloadEventSchema),
    /** Every event the workload has; greater than `events.length` when truncated. */
    eventsTotal: z.number().int().nonnegative().optional(),
    status: z.enum(WorkloadHealthStatus),
    vms: z.array(statusVmSchema).optional(),
    /** While Retrying: the attempt and the window the next one is due in. */
    retry: z
      .object({
        attempt: z.number().int().positive(),
        earliestAt: z.number(),
        latestAt: z.number(),
      })
      .strict()
      .optional(),
    /** Checkpoint target; `health` is read from the bucket while live. */
    checkpoint: z
      .object({
        bucket: z.string(),
        mount: z.string(),
        /** False when cleanup deletes the bucket with the Workload. */
        retained: z.boolean(),
        health: checkpointHealthSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const workloadSshAccessResponseSchema = z
  .object({
    workloadId: z.string(),
    vmIp: z.string(),
    sshHost: z.string().optional(),
    sshPort: z.number().optional(),
    sshUsername: z.string().optional(),
    sshPrivateKey: z.string(),
  })
  .strict();

export const workloadActionResponseSchema = messageResponseSchema;

export type WorkloadResubmitResponse = z.output<
  typeof workloadResubmitResponseSchema
>;

export type WorkloadCostRequest = z.output<
  typeof exactWorkloadCostRequestSchema
>;
export type CostReportRequest = z.output<
  typeof aggregateWorkloadCostRequestSchema
>['query'];
export type WorkloadListInput = z.output<
  typeof workloadListRequestSchema
>['query'];
export type WorkloadTerminateInput = z.output<
  typeof workloadTerminateRequestSchema
>;
export type WorkloadStatusInput = z.output<typeof workloadStatusRequestSchema>;
export type WorkloadSshAccessInput = z.output<
  typeof workloadSshAccessRequestSchema
>;
export type WorkloadResubmitInput = z.output<
  typeof workloadResubmitRequestSchema
>;
export type WorkloadCostRow = z.output<typeof workloadCostRowSchema>;
export type WorkloadCostReport = z.output<typeof workloadCostReportSchema>;
export type CostProviderSummary = z.output<typeof providerCostSummarySchema>;
export type CostAttributionSummary = z.output<
  typeof attributionCostSummarySchema
>;
export type WorkloadListResponse = z.output<typeof workloadListResponseSchema>;
export type WorkloadListRow = WorkloadListResponse[number];
export type StatusWorkloadMetadata = z.output<
  typeof statusWorkloadMetadataSchema
>;
export type WorkloadEvent = z.output<typeof workloadEventSchema>;
export type SshAccessMode = WorkloadSshAccessInput['mode'];
export type WorkloadStatusResponse = z.output<
  typeof workloadStatusResponseSchema
>;
export type WorkloadSshAccessResponse = z.output<
  typeof workloadSshAccessResponseSchema
>;
export type WorkloadActionResponse = z.output<
  typeof workloadActionResponseSchema
>;
