import { LOGS_CONTAINER_NOT_READY } from '../../../shared/api-contract/native-schemas.js';
import {
  LIVE_EXECUTION_STATES,
  isTerminalState,
} from '../../../shared/workload.js';
import {
  listReplicaPods,
  type DeploymentRuntimeResolver,
} from '../kubernetes/deployment-runtime.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { podLogs } from '../kubernetes/pod-logs.js';
import { KUBERNETES_DEPLOYMENT_CONTAINER } from '../kubernetes/pool-objects.js';
import type { PoolJobLogWindow } from '../repositories/pool-job-store.js';
import { refused, type JobLogsPreparation } from './operations.js';

/** How often a followed log checks whether its Job has ended. */
const END_POLL_MS = 2_000;

/**
 * `anycloud logs` for a pool Job (RFC 0044 § Logs): while it runs, its
 * replica's log from the claim on; once it ends, the tail kept then. Before
 * a runner claims it, or while it waits to retry, `LOGS_CONTAINER_NOT_READY`.
 */
export function createPoolJobLogs(deps: {
  window(jobId: string): Promise<PoolJobLogWindow | null>;
  runtimes: Pick<DeploymentRuntimeResolver, 'resolve'>;
}) {
  return async function prepare(
    jobId: string,
    follow: boolean,
  ): Promise<JobLogsPreparation | null> {
    const window = await deps.window(jobId);
    if (!window?.managed) return null;
    const { attempt, state } = window;
    const rejected = (clientError: string, final = false, status = 409) => ({
      ...refused(status, clientError),
      ...(final ? {} : { code: LOGS_CONTAINER_NOT_READY }),
      probeCount: 0,
    });
    if (isTerminalState(state)) {
      if (!attempt) return rejected(`Job ${jobId} never started.`, true);
      if (attempt.tail?.state !== 'captured') {
        return rejected(
          `The log of Job ${jobId} is unavailable: ${attempt.tail?.text ?? 'it was not kept.'}`,
          true,
        );
      }
      const text = Buffer.from(attempt.tail.text);
      return {
        ok: true,
        probeCount: 0,
        run: async (stream) => {
          await stream.onStdout(text);
          return 0;
        },
      };
    }
    if (!attempt || !LIVE_EXECUTION_STATES.includes(state)) {
      return rejected(
        `Job ${jobId} is ${state} and waits for a replica; check anycloud status ${jobId}.`,
      );
    }
    let replicas;
    try {
      replicas = await listReplicaPods(deps.runtimes, window);
    } catch (error) {
      return rejected(
        `Could not reach the cluster of Job ${jobId}: ${errorMessage(error)}.`,
        false,
        503,
      );
    }
    const { runtime, namespace, items } = replicas;
    const pod = items.find((item) => item.metadata?.uid === attempt.podUid)
      ?.metadata?.name;
    if (!pod) {
      return rejected(
        `Job ${jobId}'s replica is gone; its log is kept once the Job ends.`,
      );
    }
    return {
      ok: true,
      probeCount: 1,
      run: async (stream) => {
        // A followed log ends with the Job, and a line stamped after the
        // last read that saw the Job live waits for the next read, so the
        // next Job's lines never show.
        const ended = new AbortController();
        let end: number | null = null;
        let liveAt = 0;
        const until = async (latest: number) => {
          if (end === null && latest > liveAt) {
            const readAt = Date.now();
            const current = await deps.window(jobId);
            end = current?.attempt?.endedAt ?? null;
            liveAt = readAt;
            if (end !== null) setTimeout(() => ended.abort(), END_POLL_MS);
          }
          return end;
        };
        const poll = follow
          ? setInterval(
              () => void until(Infinity).catch(() => ended.abort()),
              END_POLL_MS,
            )
          : undefined;
        try {
          await podLogs(
            runtime.cluster,
            { namespace, pod, container: KUBERNETES_DEPLOYMENT_CONTAINER },
            {
              follow,
              signal: AbortSignal.any([stream.signal, ended.signal]),
              window: { from: attempt.openedAt, until },
            },
            stream.onStdout,
          );
        } catch (error) {
          if (!ended.signal.aborted) throw error;
        } finally {
          clearInterval(poll);
        }
        return 0;
      },
    };
  };
}
