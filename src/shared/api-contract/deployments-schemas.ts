import { z } from 'zod';
import { WorkloadState } from '../workload.js';
import { dockerOptionsSchema } from './workload-management-schemas.js';
import { secretNameSchema } from './secrets-schemas.js';

const nameSchema = z.string().trim().min(1).max(64);
const positiveIntegerSchema = z.number().int().positive().safe();
const nonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const kubernetesEnvironmentVariableNameSchema = z
  .string()
  .regex(/^[\x20-\x3c\x3e-\x7e]+$/, {
    message:
      'Environment variable names must consist only of printable ASCII characters other than "="',
  });
const deploymentEnvironmentSchema = z.record(
  kubernetesEnvironmentVariableNameSchema,
  z.string(),
);
const deploymentSecretsSchema = z
  .array(secretNameSchema)
  .describe(
    'Named Secrets whose keys become environment variables. A later name wins a duplicate key; env wins over every Secret.',
  );

/** A replica's shutdown grace unless set: Kubernetes's own default. */
export const DEPLOYMENT_GRACE_PERIOD_SECONDS = 30;
/**
 * A managed Deployment's: AWS's spot notice, about 2 min. GCP and Azure give
 * less, and no grace outlives a spot reclaim.
 */
export const MANAGED_DEPLOYMENT_GRACE_PERIOD_SECONDS = 120;
const gracePeriodSchema = z
  .number()
  .int()
  .min(0)
  .max(3_600)
  .describe(
    "Seconds a replica gets between SIGTERM and SIGKILL, as the Pod's terminationGracePeriodSeconds.",
  );

export const deploymentReadinessProbeSchema = z
  .object({
    exec: z
      .object({
        command: z
          .array(z.string().max(4096))
          .min(1)
          .max(128)
          .refine((command) => (command[0]?.trim().length ?? 0) > 0, {
            message: 'The readiness executable must not be empty',
          }),
      })
      .strict(),
    initialDelaySeconds: z.number().int().min(0).max(86_400).optional(),
    periodSeconds: z.number().int().min(1).max(3_600).optional(),
    timeoutSeconds: z.number().int().min(1).max(3_600).optional(),
    successThreshold: z.number().int().min(1).max(100).optional(),
    failureThreshold: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .describe(
    'Native Kubernetes exec readiness probe. Arguments execute directly; use an explicit shell when needed. Omitted timing fields use Kubernetes defaults.',
  );

const deploymentTemplateInputSchema = z
  .object({
    image: z.string().trim().min(1),
    command: z.array(z.string()).optional(),
    env: deploymentEnvironmentSchema.optional(),
    secrets: deploymentSecretsSchema.optional(),
    dockerOptions: dockerOptionsSchema.optional(),
    readinessProbe: deploymentReadinessProbeSchema.nullable().optional(),
    gracePeriodSeconds: gracePeriodSchema.optional(),
  })
  .strict();

export const createDeploymentInputSchema = deploymentTemplateInputSchema
  .extend({
    name: nameSchema,
    /** Target node pool on the cluster (id or name). */
    nodePool: z.string().trim().min(1),
    maxConcurrentJobsPerReplica: positiveIntegerSchema.default(1),
    /** Replica Pods scale between these on queued plus held Jobs. */
    minReplicas: positiveIntegerSchema.optional(),
    /** Defaults to `minReplicas`. */
    maxReplicas: positiveIntegerSchema.optional(),
  })
  .strict();

export const deploymentDockerOptionsUpdateSchema = z
  .object({
    privileged: dockerOptionsSchema.shape.privileged.nullable(),
    shmSize: dockerOptionsSchema.shape.shmSize.nullable(),
    gpus: dockerOptionsSchema.shape.gpus.nullable(),
    memory: dockerOptionsSchema.shape.memory.nullable(),
    cpus: dockerOptionsSchema.shape.cpus.nullable(),
    runtime: dockerOptionsSchema.shape.runtime.nullable(),
    binds: dockerOptionsSchema.shape.binds.nullable(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'At least one container option is required',
    },
  )
  .describe(
    'Update only supplied container options. Omission preserves a setting; null removes it. Arrays replace the entire array. Only a supplied gpus field recomputes the admitted GPU allocation.',
  );

export const updateDeploymentBodySchema = z
  .object({
    image: z.string().trim().min(1).optional(),
    command: z.array(z.string()).nullable().optional(),
    env: deploymentEnvironmentSchema.nullable().optional(),
    secrets: deploymentSecretsSchema
      .nullable()
      .optional()
      .describe(
        'Omission preserves the references; null removes them; an array replaces them.',
      ),
    dockerOptions: deploymentDockerOptionsUpdateSchema
      .nullable()
      .optional()
      .describe(
        'Update only supplied container options. Null clears all options and resolves GPU defaults again.',
      ),
    maxConcurrentJobsPerReplica: positiveIntegerSchema.optional(),
    minReplicas: positiveIntegerSchema.optional(),
    maxReplicas: positiveIntegerSchema.optional(),
    readinessProbe: deploymentReadinessProbeSchema
      .nullable()
      .optional()
      .describe(
        'Omission preserves the probe; null removes it; an object replaces it.',
      ),
    gracePeriodSeconds: gracePeriodSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'At least one Deployment field is required',
    },
  );

export const deploymentPathInputSchema = z.object({
  params: z.object({ id: z.string().trim().min(1) }).strict(),
});

export const listDeploymentsInputSchema = z
  .object({
    query: z
      .object({
        nodePool: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .optional();

export const updateDeploymentInputSchema = z.object({
  params: z.object({ id: z.string().trim().min(1) }).strict(),
  body: updateDeploymentBodySchema,
});

const deploymentJobCountsSchema = z
  .object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
    terminal: z.number().int().nonnegative(),
    unreleased: z.number().int().nonnegative(),
  })
  .strict();

const deploymentWorkloadObservationSchema = z
  .object({
    observedGeneration: z.number().int().positive().nullable(),
    podName: z.string().nullable(),
    podUid: z.string().nullable(),
    containerId: z.string().nullable(),
    containerReady: z.boolean(),
    pendingReason: z.string().nullable(),
  })
  .strict();

/** Kubernetes's Pod phase for a runtime that can't be read or identified. */
const DEPLOYMENT_UNKNOWN_STATE = 'unknown';

export const deploymentStatusSchema = z
  .object({
    state: z.enum([
      WorkloadState.Starting,
      WorkloadState.Running,
      WorkloadState.Failed,
      WorkloadState.Terminated,
      DEPLOYMENT_UNKNOWN_STATE,
    ]),
    /** Terminated, but its Pod is still finishing or releasing Jobs. */
    releasing: z.boolean(),
    /** The Pod on the requested revision is ready and can take Jobs. */
    ready: z.boolean(),
    /** The latest rollout; N is the generation minus the create. */
    upgrade: z
      .object({
        number: positiveIntegerSchema,
        state: z.enum([
          WorkloadState.Starting,
          WorkloadState.Running,
          WorkloadState.Failed,
        ]),
      })
      .strict()
      .nullable(),
    reason: z.string(),
    requestedGeneration: positiveIntegerSchema,
    appliedGeneration: positiveIntegerSchema.nullable(),
    podGeneration: positiveIntegerSchema.nullable(),
    podName: z.string().nullable(),
    podUid: z.string().nullable(),
    containerId: z.string().nullable(),
    containerReady: z.boolean().nullable(),
    /** Replicas Kubernetes reports ready; null when it isn't observed. */
    readyReplicas: nonnegativeIntegerSchema.nullable(),
    applicationReady: z.boolean().nullable(),
    probeConfigured: z.boolean().nullable(),
    observation: z.enum(['observed', 'unavailable', 'not-requested']),
    observedAt: z.number().int().nonnegative().nullable(),
    observationError: z.string().nullable(),
    blockingJobs: z
      .object({
        total: nonnegativeIntegerSchema,
        jobs: z
          .array(
            z
              .object({
                id: z.string().min(1),
                executionId: z.string().nullable(),
                generation: positiveIntegerSchema.nullable(),
                state: z.enum(WorkloadState),
              })
              .strict(),
          )
          .max(10),
      })
      .strict(),
  })
  .strict();

/**
 * One target per Deployment record, fixed for its whole life. The `kind`
 * discriminator stays on the wire so the shape can grow without breaking.
 */
const deploymentTargetSchema = z
  .discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('nodePool'), nodePoolId: z.string().min(1) })
      .strict(),
  ])
  .describe('Where the Deployment runs: a node pool on the cluster.');

export const deploymentSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    nodePoolId: z.string().min(1).describe('Target node pool id.'),
    /** anycloud runs `job --node-pool` on it; read-only (RFC 0044). */
    managed: z.boolean(),
    /**
     * Its containers run privileged (deprecated), so the next release's
     * upgrade refuses until it is moved (RFC 0049 C32).
     */
    privileged: z.boolean(),
    target: deploymentTargetSchema,
    image: z.string().min(1),
    command: z.array(z.string()).nullable(),
    readinessProbe: deploymentReadinessProbeSchema.nullable(),
    gracePeriodSeconds: gracePeriodSchema,
    gpuCount: nonnegativeIntegerSchema,
    envKeys: z.array(z.string()),
    secretNames: z.array(z.string()),
    maxConcurrentJobsPerReplica: positiveIntegerSchema,
    /** Replica Pods scale between these on queued plus held Jobs. */
    minReplicas: nonnegativeIntegerSchema,
    maxReplicas: positiveIntegerSchema,
    generation: positiveIntegerSchema,
    deletionRequestedAt: z.number().int().nonnegative().nullable(),
    deletedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    jobs: deploymentJobCountsSchema,
    workload: deploymentWorkloadObservationSchema.nullable(),
    status: deploymentStatusSchema.nullable(),
    /**
     * Replica time from bind and its share of the Node VMs' price; busy is
     * covered by a Job's attempt, idle is the rest. Only on show.
     */
    usage: z
      .object({
        replicaHours: z.number().nonnegative(),
        busyHours: z.number().nonnegative(),
        costUsd: z.number().nonnegative(),
        busyCostUsd: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((summary) => summary.nodePoolId === summary.target.nodePoolId, {
    message: 'Deployment target and nodePoolId must name the same node pool',
  });

export const deploymentResponseSchema = z
  .object({ deployment: deploymentSummarySchema })
  .strict();

export const listDeploymentsResponseSchema = z
  .object({ deployments: z.array(deploymentSummarySchema) })
  .strict();

export type CreateDeploymentRequest = z.output<
  typeof createDeploymentInputSchema
>;
export type UpdateDeploymentRequest = z.output<
  typeof updateDeploymentBodySchema
>;
export type DeploymentSummary = z.output<typeof deploymentSummarySchema>;
export type DeploymentReadinessProbe = z.output<
  typeof deploymentReadinessProbeSchema
>;
export type DeploymentStatus = z.output<typeof deploymentStatusSchema>;
export type DeploymentResponse = z.output<typeof deploymentResponseSchema>;
export type ListDeploymentsResponse = z.output<
  typeof listDeploymentsResponseSchema
>;
