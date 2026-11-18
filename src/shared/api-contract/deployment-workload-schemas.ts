import { z } from 'zod';

const deploymentIdSchema = z.string().trim().min(1);
const jobIdSchema = z.string().trim().min(1);
const executionIdSchema = z.uuid();

const targetParamsSchema = z
  .object({ deploymentId: deploymentIdSchema })
  .strict();

const jobParamsSchema = targetParamsSchema
  .extend({ jobId: jobIdSchema })
  .strict();

const idempotencyHeadersSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value;
    return {
      'idempotency-key': (value as Record<string, unknown>)['idempotency-key'],
    };
  },
  z.object({ 'idempotency-key': executionIdSchema }).strict(),
);

export const selectedJobSchema = z
  .object({
    jobId: jobIdSchema,
    executionId: executionIdSchema,
  })
  .strict();

export const workloadJobCandidateSchema = z
  .object({
    jobId: jobIdSchema,
    submissionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    previousExecutionId: executionIdSchema.nullable(),
  })
  .strict();

export const workloadClaimJobBodySchema = workloadJobCandidateSchema.omit({
  jobId: true,
});

export const workloadCandidateInputSchema = z.object({
  params: targetParamsSchema,
  query: z
    .object({ waitMs: z.coerce.number().int().min(0).max(20_000).default(0) })
    .strict(),
});

export const workloadCandidateResponseSchema = z.union([
  z
    .object({ status: z.literal(200), body: workloadJobCandidateSchema })
    .strict(),
  z.object({ status: z.literal(204) }).strict(),
]);

export const workloadClaimJobInputSchema = z.object({
  params: jobParamsSchema,
  headers: idempotencyHeadersSchema,
  body: workloadClaimJobBodySchema,
});

export type WorkloadClaimJobBody = z.output<typeof workloadClaimJobBodySchema>;
export type WorkloadCandidateResponse = z.output<
  typeof workloadCandidateResponseSchema
>;

export const workloadCancellationInputSchema = z.object({
  params: jobParamsSchema,
  query: z
    .object({
      executionId: executionIdSchema,
      waitMs: z.coerce.number().int().min(0).max(20_000).default(0),
    })
    .strict(),
});

export const workloadCancellationResponseSchema = z
  .object({ cancelled: z.boolean() })
  .strict();

export const workloadOutcomeBodySchema = z
  .object({
    executionId: executionIdSchema,
    outcome: z.enum(['completed', 'errored', 'invalid', 'retryable']),
    message: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();

export const workloadOutcomeInputSchema = z.object({
  params: jobParamsSchema,
  body: workloadOutcomeBodySchema,
});

export const workloadCleanupBodySchema = z
  .object({ executionId: executionIdSchema })
  .strict();

export const workloadCleanupInputSchema = z.object({
  params: jobParamsSchema,
  body: workloadCleanupBodySchema,
});

export type WorkloadOutcome = z.output<
  typeof workloadOutcomeInputSchema
>['body'];

const executionQuerySchema = z
  .object({ executionId: executionIdSchema })
  .strict();

export const workloadExecutionInputSchema = z.object({
  params: jobParamsSchema,
  query: executionQuerySchema,
});

/** One storage role: an rclone path and the env that configures its remote. */
const storageGrantSchema = z
  .object({
    remote: z.string().min(1),
    env: z.record(z.string(), z.string()),
    expiresAt: z.number().int().positive(),
  })
  .strict();

/**
 * What a runner needs to start a claimed Job on a managed Deployment. A later
 * read behind the same execution fence renews the storage credentials.
 */
export const workloadExecutionSchema = z
  .object({
    command: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    timeLimitSeconds: z.number().int().positive().nullable(),
    storage: z
      .object({
        input: storageGrantSchema.optional(),
        output: storageGrantSchema.optional(),
        checkpoint: storageGrantSchema.optional(),
      })
      .strict(),
  })
  .strict();

const detail = z.string().trim().min(1).max(4_096);

/** Why a runner's attempt ended; the API maps it through the Job's policy. */
export const runnerCauseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('exit'),
      code: z.number().int().min(0).max(255),
      oom: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('deadline'), detail }).strict(),
  z.object({ kind: z.literal('disrupted'), detail }).strict(),
  z.object({ kind: z.literal('unrecoverable'), detail }).strict(),
  z.object({ kind: z.literal('transfer'), detail }).strict(),
]);

export const workloadRunnerReportBodySchema = z.union([
  z
    .object({
      executionId: executionIdSchema,
      phase: z.enum(['running', 'finalizing']),
    })
    .strict(),
  z
    .object({ executionId: executionIdSchema, cause: runnerCauseSchema })
    .strict(),
]);

export const workloadRunnerReportInputSchema = z.object({
  params: jobParamsSchema,
  body: workloadRunnerReportBodySchema,
});

export type WorkloadExecution = z.output<typeof workloadExecutionSchema>;
export type RunnerCause = z.output<typeof runnerCauseSchema>;
export type WorkloadRunnerReport = z.output<
  typeof workloadRunnerReportBodySchema
>;
