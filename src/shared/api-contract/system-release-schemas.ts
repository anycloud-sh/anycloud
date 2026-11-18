import { z } from 'zod';
import { WorkloadState } from '../workload.js';

/**
 * An upgrade leaves the API `running`; the upgrade itself is `starting` until
 * the new release's ready check Job succeeds, then `running`, or `failed`.
 */
const SYSTEM_UPGRADE_STATES = [
  WorkloadState.Starting,
  WorkloadState.Running,
  WorkloadState.Failed,
] as const;

export const requestSystemReleaseInputSchema = z
  .object({
    /**
     * Official API image: `ghcr.io/anycloud-sh/api:<version>` (the API pins it
     * to the published digest) or a digest-pinned reference.
     */
    image: z.string().trim().min(1).max(512),
  })
  .strict();

/** Upgrade N of this API, shown in `status` like a Service's `Upgrade N`. */
export const systemUpgradeSchema = z
  .object({
    /** The bootstrap release is not an upgrade; the first upgrade is 1. */
    number: z.number().int().positive(),
    apiVersion: z.string().min(1),
    apiImage: z.string().min(1),
    state: z.enum(SYSTEM_UPGRADE_STATES),
    lastError: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const systemReleaseRolloutSchema = z
  .object({
    observedGeneration: z.number().int().nonnegative().nullable(),
    replicas: z.number().int().nonnegative(),
    updatedReplicas: z.number().int().nonnegative(),
    readyReplicas: z.number().int().nonnegative(),
    conditions: z.array(
      z
        .object({
          type: z.string(),
          status: z.string(),
          reason: z.string().nullable(),
          message: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * The K3s step of an upgrade (RFC 0049 C26 (b)): the hosted API labels the
 * management Node and rewrites K3s's server configuration from a host-step
 * Job, then waits for the Kubernetes API to be ready again.
 */
export const kubernetesStepSchema = z
  .object({
    /** The `api upgrade` run that started it. */
    id: z.string().min(1),
    state: z.enum(['running', 'succeeded', 'failed']),
    /** Whether it changed the configuration, which restarts K3s; null until it reports. */
    configuration: z.enum(['changed', 'current']).nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    /** Why it failed, or what a running step waits on (an image pull); null otherwise. */
    reason: z.string().nullable(),
  })
  .strict();
export type KubernetesStep = z.infer<typeof kubernetesStepSchema>;

/** A K3s step id: the host-step Job's name carries it. */
export const KUBERNETES_STEP_ID_PATTERN = /^[a-z0-9]{8,32}$/;

export const kubernetesStepInputSchema = z
  .object({
    /** One per `api upgrade` run: its polls observe the step it started. */
    id: z.string().regex(KUBERNETES_STEP_ID_PATTERN),
    image: requestSystemReleaseInputSchema.shape.image,
  })
  .strict();
export type KubernetesStepInput = z.infer<typeof kubernetesStepInputSchema>;

export const kubernetesStepResponseSchema = z
  .object({
    /** Null when the release already carries the image: nothing ran. */
    step: kubernetesStepSchema.nullable(),
  })
  .strict();
export type KubernetesStepResponse = z.infer<
  typeof kubernetesStepResponseSchema
>;

export const systemReleaseStatusSchema = z
  .object({
    /** Version this process serves; the schema version its database reached. */
    servedVersion: z.string().min(1),
    schemaVersion: z.string().nullable(),
    /** The latest upgrade, null before the first one. */
    upgrade: systemUpgradeSchema.nullable(),
    /** Native Deployment rollout, null when unobservable. */
    rollout: systemReleaseRolloutSchema.nullable(),
    /**
     * Whether the management Node carries the protected label the API and its
     * Traefik select, which install and the K3s step set. Omitted when
     * the API can't read the Node or isn't Helm-managed. Kept for the previous release's CLI, which
     * reads it; removed next release.
     */
    managementNodeLabelled: z.boolean().optional(),
    /**
     * The first database backup through the management VM's identity (RFC
     * 0049 C26 (e)), which `cluster create` waits for. Omitted without a
     * backup, and by APIs before it.
     */
    firstBackup: z
      .discriminatedUnion('state', [
        z
          .object({
            state: z.literal('pending'),
            attempts: z.number().int().nonnegative(),
            lastError: z.string().nullable(),
          })
          .strict(),
        z
          .object({ state: z.literal('landed'), backedUpAt: z.string() })
          .strict(),
        z
          .object({ state: z.literal('failed'), lastError: z.string() })
          .strict(),
      ])
      .optional(),
    /** The latest K3s step; omitted when none is kept or it is unreadable. */
    kubernetes: kubernetesStepSchema.optional(),
  })
  .strict();

export const systemReleaseResponseSchema = z
  .object({
    /** The API already runs the requested image: nothing was started. */
    unchanged: z.boolean(),
    /** Null only when unchanged and no upgrade in this database names the image (bootstrap image). */
    upgrade: systemUpgradeSchema.nullable(),
  })
  .strict();

/** `cluster delete`'s final backup: the manifest time of the backup taken. */
export const systemBackupResponseSchema = z
  .object({ backedUpAt: z.string().min(1) })
  .strict();

export type SystemBackupResponse = z.output<typeof systemBackupResponseSchema>;
export type RequestSystemReleaseInput = z.output<
  typeof requestSystemReleaseInputSchema
>;
export type SystemUpgrade = z.output<typeof systemUpgradeSchema>;
export type SystemReleaseRollout = z.output<typeof systemReleaseRolloutSchema>;
export type SystemReleaseStatus = z.output<typeof systemReleaseStatusSchema>;
export type SystemReleaseResponse = z.output<
  typeof systemReleaseResponseSchema
>;

export const drainPoolJobsInputSchema = z
  .object({
    /** Stop the pool Jobs in flight instead of waiting; each retries. */
    force: z.boolean(),
    /**
     * A hosted upgrade's image: a release `request` would refuse is refused
     * here, and one already carried drains nothing.
     */
    image: requestSystemReleaseInputSchema.shape.image.optional(),
    /**
     * Runner releases the new release accepts: with `force`, their Jobs keep
     * running instead of stopping (RFC 0049 C27).
     */
    keep: z.array(z.string().min(1)).max(2).optional(),
  })
  .strict();
export type DrainPoolJobsInput = z.infer<typeof drainPoolJobsInputSchema>;

/** The pool Jobs in flight; `api upgrade` waits for those outside `keep`. */
export const drainPoolJobsResponseSchema = z
  .object({
    jobs: z.array(
      z
        .object({
          id: z.string().min(1),
          state: z.string().min(1),
          nodePool: z.string().min(1),
          /** The release of the runner it runs on; null when unrecorded. */
          runnerRelease: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type DrainPoolJobsResponse = z.infer<typeof drainPoolJobsResponseSchema>;

/** `cluster delete` asks the hosted API to delete its installation, itself last (RFC 0049 C26, seed design). */
export const selfDeleteInputSchema = z
  .object({
    /** The cluster the caller means; refused unless it is this API's. */
    clusterId: z.string().min(1),
    /** Delete the managed checkpoint bucket too, ending any restore (C28). */
    deleteBuckets: z.boolean(),
  })
  .strict();
export type SelfDeleteInput = z.infer<typeof selfDeleteInputSchema>;

const sweptResourceSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
    location: z.string().min(1).nullable(),
    /** Why a pass failed, on a remaining entry. */
    error: z.string().min(1).optional(),
  })
  .strict();

/**
 * Where the self-delete is: `sweeping` its VM Jobs and buckets, `removing`
 * its own stack, group or instance (the API answers until it's gone), or
 * `failed` with the sweep's error, leaving everything else in place.
 */
export const selfDeleteStatusSchema = z
  .object({
    state: z.enum(['idle', 'sweeping', 'removing', 'failed']),
    /** Where the installation runs, for the CLI's follow-up through its cloud CLI. */
    installation: z
      .object({
        clusterId: z.string().min(1),
        cloud: z.enum(['aws', 'gcp', 'azure']),
        region: z.string().min(1),
        bucket: z
          .object({ name: z.string().min(1), managed: z.boolean() })
          .strict(),
      })
      .strict(),
    /** C28's final backup: `skipped` under `deleteBuckets`. */
    finalBackup: z.enum(['taken', 'failed', 'skipped']).nullable(),
    backedUpAt: z.string().min(1).nullable(),
    deleted: z.array(sweptResourceSchema),
    remaining: z.array(sweptResourceSchema),
    error: z.string().min(1).nullable(),
  })
  .strict();
export type SelfDeleteStatus = z.infer<typeof selfDeleteStatusSchema>;
