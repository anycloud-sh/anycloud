import { randomUUID } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { NodePoolState } from '../../../../../../src/shared/node-pools.js';

export const LOCAL_KUBERNETES_PROTOCOL_VERSION = 1 as const;

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: 'path must be absolute',
  });
const port = z.number().int().min(1).max(65_535);
const identity = z.string().min(1).max(200);

export const localKubernetesChildConfigSchema = z
  .object({
    version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
    apiPort: port,
    cipherKey: z.string().length(64),
    factsPort: port,
    factsToken: z.string().min(32),
    launchNonce: identity,
    projectRoot: absolutePath,
    readyPath: absolutePath,
    runId: z.string().regex(/^[a-z0-9]{6,32}$/u),
    stateRoot: absolutePath,
    workloadApiUrl: z.string().url(),
    /** The cluster record the child API writes before serving (installer kind). */
    cluster: z
      .object({
        name: identity,
        kubernetesIdentity: identity,
        connection: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .check((context) => {
    if (context.value.apiPort === context.value.factsPort) {
      context.issues.push({
        code: 'custom',
        input: context.value,
        path: ['factsPort'],
        message: 'factsPort must differ from apiPort',
      });
    }
  });

export type LocalKubernetesChildConfig = z.output<
  typeof localKubernetesChildConfigSchema
>;

export const localKubernetesReadyRecordSchema = z
  .object({
    version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
    launchNonce: identity,
    pid: z.number().int().positive(),
    port,
  })
  .strict();

export type LocalKubernetesReadyRecord = z.output<
  typeof localKubernetesReadyRecordSchema
>;

const requestBase = {
  version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
  requestId: identity,
};

export const localKubernetesFactRequestSchema = z.discriminatedUnion(
  'operation',
  [
    z
      .object({
        ...requestBase,
        operation: z.literal('node-pool'),
        nodePoolId: identity,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('reservation-put'),
        jobId: identity,
        behavior: z.enum([
          'hold',
          'hold-no-cancel',
          'complete',
          'error',
          'retry',
          'oom',
        ]),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('reservation'),
        jobId: identity,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('workload'),
        workloadId: identity,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('attempt-tails'),
        jobId: identity,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('drain'),
        force: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('claim-burst'),
        deploymentId: identity.nullable(),
        /** Start the next load window after this read. */
        closeWindow: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal('in-flight-cap'),
        cap: z.number().int().positive(),
      })
      .strict(),
  ],
);

export type LocalKubernetesFactRequest = z.output<
  typeof localKubernetesFactRequestSchema
>;

export const localKubernetesCapacityRowSchema = z
  .object({
    id: z.number().int().positive(),
    cloudId: identity,
    endedAt: z.number().int().nonnegative().nullable(),
    ip: z.string().min(1).nullable(),
  })
  .strict();

export type LocalKubernetesCapacityRow = z.output<
  typeof localKubernetesCapacityRowSchema
>;

/**
 * Durable node pool facts read straight from the API child's persistence:
 * the node pool row, its VM ledger and the cluster connection it joined.
 */
export const localKubernetesNodePoolFactsSchema = z
  .object({
    kind: z.literal('node-pool'),
    nodePoolId: identity,
    state: z.enum(NodePoolState).nullable(),
    clusterId: z.string().min(1).nullable(),
    kubernetesIdentity: z.string().min(1).nullable(),
    connectionRevision: z.number().int().positive().nullable(),
    capacityRows: z.array(localKubernetesCapacityRowSchema),
    failedLaunches: z.array(
      z
        .object({
          vmRowId: z.number().int(),
          region: z.string(),
          diagnosis: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type LocalKubernetesNodePoolFacts = z.output<
  typeof localKubernetesNodePoolFactsSchema
>;

export const localKubernetesDeploymentFactsSchema = z
  .object({
    kind: z.literal('workload'),
    workloadId: identity,
    persisted: z.boolean(),
  })
  .strict();

export type LocalKubernetesDeploymentFacts = z.output<
  typeof localKubernetesDeploymentFactsSchema
>;

export const localKubernetesReservationPutFactsSchema = z
  .object({
    kind: z.literal('reservation-put'),
    jobId: identity,
  })
  .strict();

export type LocalKubernetesReservationPutFacts = z.output<
  typeof localKubernetesReservationPutFactsSchema
>;

export const localKubernetesReservationFactsSchema = z
  .object({
    kind: z.literal('reservation'),
    jobId: identity,
    present: z.boolean(),
    lookupCount: z.number().int().nonnegative(),
  })
  .strict();

export type LocalKubernetesReservationFacts = z.output<
  typeof localKubernetesReservationFactsSchema
>;

/** Each attempt's stored log tail, as the Deployment owner kept it. */
export const localKubernetesAttemptTailsFactsSchema = z
  .object({
    kind: z.literal('attempt-tails'),
    jobId: identity,
    attempts: z.array(
      z
        .object({
          attempt: z.number().int().positive(),
          logTailState: z.string().nullable(),
          logTail: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type LocalKubernetesAttemptTailsFacts = z.output<
  typeof localKubernetesAttemptTailsFactsSchema
>;

/** The pool Jobs `api upgrade`'s drain still waits for (decision 30). */
export const localKubernetesDrainFactsSchema = z
  .object({
    kind: z.literal('drain'),
    jobs: z.array(z.object({ id: identity, state: z.string() }).strict()),
  })
  .strict();

export type LocalKubernetesDrainFacts = z.output<
  typeof localKubernetesDrainFactsSchema
>;

const spreadSchema = z
  .object({
    count: z.number().int().nonnegative(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number(),
    max: z.number(),
  })
  .strict();

/** The API process's load over one window (`api-load.ts`). */
const apiLoadSchema = z
  .object({
    windowMs: z.number().int().nonnegative(),
    cpuCores: z.number().nonnegative(),
    eventLoopP99Ms: z.number().nonnegative(),
    eventLoopMaxMs: z.number().nonnegative(),
    sqliteWaitMs: spreadSchema,
    routes: z.record(
      z.string(),
      spreadSchema.extend({
        errors: z.record(z.string(), z.number().int().nonnegative()),
      }),
    ),
  })
  .strict();

export type LocalKubernetesApiLoad = z.output<typeof apiLoadSchema>;

/**
 * S12: a managed Deployment's Jobs with every attempt and its slot
 * price, how often each Job's command ran, and the API's load since the
 * last read.
 */
export const localKubernetesClaimBurstFactsSchema = z
  .object({
    kind: z.literal('claim-burst'),
    jobs: z.array(
      z
        .object({
          id: identity,
          state: z.string(),
          session: z.string().nullable(),
          submittedAt: z.number(),
          /** The latest spend-cap reason it waited with, if any. */
          blocked: z.string().nullable(),
          runs: z.number().int().nonnegative(),
          attempts: z.array(
            z
              .object({
                executionId: identity,
                podUid: z.string().nullable(),
                openedAt: z.number(),
                endedAt: z.number().nullable(),
                slotUsd: z.number().nullable(),
                /** How the attempt ended, and why, as the API recorded it. */
                outcome: z.string().nullable(),
                reason: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    load: apiLoadSchema,
  })
  .strict();

export type LocalKubernetesClaimBurstFacts = z.output<
  typeof localKubernetesClaimBurstFactsSchema
>;

const inFlightCapFactsSchema = z
  .object({ kind: z.literal('in-flight-cap'), cap: z.number().int() })
  .strict();

export type LocalKubernetesInFlightCapFacts = z.output<
  typeof inFlightCapFactsSchema
>;

const factResultSchema = z.discriminatedUnion('kind', [
  localKubernetesClaimBurstFactsSchema,
  inFlightCapFactsSchema,
  localKubernetesNodePoolFactsSchema,
  localKubernetesDeploymentFactsSchema,
  localKubernetesReservationPutFactsSchema,
  localKubernetesReservationFactsSchema,
  localKubernetesAttemptTailsFactsSchema,
  localKubernetesDrainFactsSchema,
]);

export const localKubernetesFactResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
      requestId: identity,
      ok: z.literal(true),
      result: factResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
      requestId: identity,
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);

export type LocalKubernetesFactResponse = z.output<
  typeof localKubernetesFactResponseSchema
>;

export function parseLocalKubernetesReadyRecord(
  value: unknown,
  expected: {
    readonly launchNonce: string;
    readonly pid: number;
    readonly port: number;
  },
): LocalKubernetesReadyRecord {
  const record = localKubernetesReadyRecordSchema.parse(value);
  if (record.launchNonce !== expected.launchNonce) {
    throw new Error('Local Kubernetes child emitted a stale launch nonce');
  }
  if (record.pid !== expected.pid) {
    throw new Error(
      'Local Kubernetes child ready PID does not match its process',
    );
  }
  if (record.port !== expected.port) {
    throw new Error('Local Kubernetes child bound an unexpected API port');
  }
  return record;
}

export async function writeLocalKubernetesReadyRecord(
  readyPath: string,
  record: LocalKubernetesReadyRecord,
): Promise<void> {
  const canonical = localKubernetesReadyRecordSchema.parse(record);
  const temporaryPath = `${readyPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(canonical)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    // Hard-linking a complete same-directory file makes readiness visible in
    // one atomic operation and still fails closed if any writer already owns
    // the final path. A direct write lets the parent observe partial JSON.
    await link(temporaryPath, readyPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class LocalKubernetesFactsClient {
  readonly #token: string;
  readonly #url: string;
  #requestCount = 0;

  constructor(portNumber: number, token: string) {
    this.#url = `http://127.0.0.1:${portNumber}`;
    this.#token = token;
  }

  nodePool(nodePoolId: string): Promise<LocalKubernetesNodePoolFacts> {
    return this.#request({ operation: 'node-pool', nodePoolId });
  }

  workload(workloadId: string): Promise<LocalKubernetesDeploymentFacts> {
    return this.#request({ operation: 'workload', workloadId });
  }

  putReservation(
    jobId: string,
    behavior:
      | 'hold'
      | 'hold-no-cancel'
      | 'complete'
      | 'error'
      | 'retry'
      | 'oom',
  ): Promise<LocalKubernetesReservationPutFacts> {
    return this.#request({ operation: 'reservation-put', jobId, behavior });
  }

  reservation(jobId: string): Promise<LocalKubernetesReservationFacts> {
    return this.#request({ operation: 'reservation', jobId });
  }

  attemptTails(jobId: string): Promise<LocalKubernetesAttemptTailsFacts> {
    return this.#request({ operation: 'attempt-tails', jobId });
  }

  drain(force: boolean): Promise<LocalKubernetesDrainFacts> {
    return this.#request({ operation: 'drain', force });
  }

  claimBurst(
    deploymentId: string | null,
    closeWindow: boolean,
  ): Promise<LocalKubernetesClaimBurstFacts> {
    return this.#request({
      operation: 'claim-burst',
      deploymentId,
      closeWindow,
    });
  }

  inFlightCap(cap: number): Promise<LocalKubernetesInFlightCapFacts> {
    return this.#request({ operation: 'in-flight-cap', cap });
  }

  #request(request: {
    readonly operation: 'node-pool';
    readonly nodePoolId: string;
  }): Promise<LocalKubernetesNodePoolFacts>;
  #request(request: {
    readonly operation: 'workload';
    readonly workloadId: string;
  }): Promise<LocalKubernetesDeploymentFacts>;
  #request(request: {
    readonly operation: 'reservation-put';
    readonly jobId: string;
    readonly behavior:
      | 'hold'
      | 'hold-no-cancel'
      | 'complete'
      | 'error'
      | 'retry'
      | 'oom';
  }): Promise<LocalKubernetesReservationPutFacts>;
  #request(request: {
    readonly operation: 'reservation';
    readonly jobId: string;
  }): Promise<LocalKubernetesReservationFacts>;
  #request(request: {
    readonly operation: 'attempt-tails';
    readonly jobId: string;
  }): Promise<LocalKubernetesAttemptTailsFacts>;
  #request(request: {
    readonly operation: 'drain';
    readonly force: boolean;
  }): Promise<LocalKubernetesDrainFacts>;
  #request(request: {
    readonly operation: 'claim-burst';
    readonly deploymentId: string | null;
    readonly closeWindow: boolean;
  }): Promise<LocalKubernetesClaimBurstFacts>;
  #request(request: {
    readonly operation: 'in-flight-cap';
    readonly cap: number;
  }): Promise<LocalKubernetesInFlightCapFacts>;
  async #request(
    request:
      | { readonly operation: 'node-pool'; readonly nodePoolId: string }
      | { readonly operation: 'workload'; readonly workloadId: string }
      | {
          readonly operation: 'reservation-put';
          readonly jobId: string;
          readonly behavior:
            | 'hold'
            | 'hold-no-cancel'
            | 'complete'
            | 'error'
            | 'retry'
            | 'oom';
        }
      | { readonly operation: 'reservation'; readonly jobId: string }
      | { readonly operation: 'attempt-tails'; readonly jobId: string }
      | { readonly operation: 'drain'; readonly force: boolean }
      | {
          readonly operation: 'claim-burst';
          readonly deploymentId: string | null;
          readonly closeWindow: boolean;
        }
      | { readonly operation: 'in-flight-cap'; readonly cap: number },
  ): Promise<
    | LocalKubernetesNodePoolFacts
    | LocalKubernetesDeploymentFacts
    | LocalKubernetesReservationPutFacts
    | LocalKubernetesReservationFacts
    | LocalKubernetesAttemptTailsFacts
    | LocalKubernetesDrainFacts
    | LocalKubernetesClaimBurstFacts
    | LocalKubernetesInFlightCapFacts
  > {
    this.#requestCount += 1;
    const requestId = `facts-${this.#requestCount}`;
    const body = localKubernetesFactRequestSchema.parse({
      version: LOCAL_KUBERNETES_PROTOCOL_VERSION,
      requestId,
      ...request,
    });
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const value: unknown = await response.json();
    const parsed = localKubernetesFactResponseSchema.parse(value);
    if (parsed.requestId !== requestId) {
      throw new Error(
        'Local Kubernetes facts response used the wrong request ID',
      );
    }
    if (!parsed.ok) {
      throw new Error(`Local Kubernetes facts request failed: ${parsed.error}`);
    }
    if (parsed.result.kind !== request.operation) {
      throw new Error(
        'Local Kubernetes facts response used the wrong result kind',
      );
    }
    return parsed.result;
  }
}
