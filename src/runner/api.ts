import { readFile } from 'node:fs/promises';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../shared/api-version.js';
import type {
  WorkloadExecution,
  WorkloadRunnerReport,
} from '../shared/api-contract/deployment-workload-schemas.js';
import { retryAfterMs } from '../shared/retry-after.js';
import { withRetry } from '../shared/utils.js';

/** The API refused this execution (404 or 409): the runner no longer holds it. */
export class FenceError extends Error {}

interface Candidate {
  jobId: string;
  submissionRevision: number;
  previousExecutionId: string | null;
}

export type RunnerApi = ReturnType<typeof createRunnerApi>;

/** The claim-queue calls a runner makes, each retried until it succeeds. */
export function createRunnerApi(options: {
  apiUrl: string;
  deploymentId: string;
  tokenFile: string;
  release: string;
  log: (message: string) => void;
  fetch?: typeof fetch;
}) {
  const fetchImpl = options.fetch ?? fetch;
  const base = `${options.apiUrl.replace(/\/+$/, '')}/v1/deployments/${encodeURIComponent(options.deploymentId)}/jobs`;
  // API and connection errors retry with backoff and never end the runner;
  // only a fence refusal reaches the caller (RFC 0044).
  const call = (
    path: string,
    signal?: AbortSignal,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> =>
    withRetry(
      async () => {
        // Kubelet rotates the projected token, so read it for every call.
        const token = (await readFile(options.tokenFile, 'utf8')).trim();
        const response = await fetchImpl(`${base}${path}`, {
          method: body ? 'POST' : 'GET',
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            [ANYCLOUD_CLIENT_VERSION_HEADER]: options.release,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (response.status === 404 || response.status === 409) {
          throw new FenceError(await response.text());
        }
        if (!response.ok) {
          throw Object.assign(new Error(`HTTP ${response.status}`), {
            headers: response.headers,
          });
        }
        return response.status === 204 ? null : response.json();
      },
      'claim-queue call',
      {
        maxAttempts: Infinity,
        waitMs: 1_000,
        maxWaitMs: 30_000,
        signal,
        shouldRetry: (error) => !(error instanceof FenceError),
        retryDelayMs: (error) =>
          retryAfterMs((error as { headers?: Headers }).headers, Date.now(), {
            maxMs: 60_000,
          }),
        onRetry: (_attempt, _max, error) =>
          options.log(`API call failed, retrying: ${error}`),
      },
    );
  const job = (jobId: string) => `/${encodeURIComponent(jobId)}`;
  return {
    /** Long-polls for the next Job; null when none arrived in the wait. */
    candidate: (signal?: AbortSignal) =>
      call('/candidate?waitMs=20000', signal) as Promise<Candidate | null>,
    /** False when another replica won the Job or it changed. */
    claim: (candidate: Candidate, executionId: string): Promise<boolean> =>
      call(
        `${job(candidate.jobId)}/claim`,
        undefined,
        {
          submissionRevision: candidate.submissionRevision,
          previousExecutionId: candidate.previousExecutionId,
        },
        executionId,
      ).then(
        () => true,
        (error: unknown) => {
          if (error instanceof FenceError) return false;
          throw error;
        },
      ),
    execution: (jobId: string, executionId: string, signal?: AbortSignal) =>
      call(
        `${job(jobId)}/execution?executionId=${executionId}`,
        signal,
      ) as Promise<WorkloadExecution>,
    report: async (jobId: string, report: WorkloadRunnerReport) => {
      await call(`${job(jobId)}/report`, undefined, report);
    },
    /** Long-polls; true once the Job is terminated. */
    cancelled: async (
      jobId: string,
      executionId: string,
      signal?: AbortSignal,
    ) =>
      (
        (await call(
          `${job(jobId)}/cancellation?executionId=${executionId}&waitMs=20000`,
          signal,
        )) as { cancelled: boolean }
      ).cancelled,
    cleanup: async (jobId: string, executionId: string) => {
      await call(`${job(jobId)}/cleanup`, undefined, { executionId });
    },
  };
}
