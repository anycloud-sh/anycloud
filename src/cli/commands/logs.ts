import { writeSync } from 'node:fs';
import { apiClient, nativeApiBearer } from '../services/auth.js';
import { Command } from 'commander';
import {
  ApiHttpError,
  streamWorkloadLogs,
  type ExecStreamHandlers,
} from '../../shared/services/api-client/native.js';
import { LOGS_CONTAINER_NOT_READY } from '../../shared/api-contract/native-schemas.js';
import { type ApiClient } from '../../shared/services/api-client/rpc.js';
import { sleep } from '../../shared/utils.js';
import { WorkloadState, isTerminalState } from '../../shared/workload.js';
import {
  SIGINT_EXIT_CODE,
  isInterrupted,
  runUntilInterrupted,
} from '../utils/interrupt.js';
import { printError } from '../utils/output.js';
import { resolveWorkloadId } from './shared.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

const LOGS_FOLLOW_LABEL = 'Log follow';

const SETUP_POLL_MS = 10_000;
const SETUP_HEARTBEAT_MS = 30 * 60_000;

/**
 * Write log output to its file descriptor directly: Bun's process streams drop
 * writes to a closed pipe without an EPIPE, so only an fd write tells
 * `logs -f | grep -m1` (or `2>&1 | grep -m1`) that its reader is gone.
 * Returns false once it is.
 */
async function writeFd(fd: 1 | 2, chunk: Buffer): Promise<boolean> {
  for (let offset = 0; offset < chunk.length; ) {
    try {
      offset += writeSync(fd, chunk, offset);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'EPIPE') return false;
      if (code !== 'EAGAIN') throw error;
      await sleep(10);
    }
  }
  return true;
}

/**
 * Follow a Workload's logs from submission: while the API says its container
 * is not running yet, repeat why (on change, and every 30 minutes) and connect
 * once it starts. The API stops saying so once the Workload has ended.
 */
async function followOnceRunning(
  accessToken: string,
  client: ApiClient,
  id: string,
  handlers: ExecStreamHandlers,
  signal: AbortSignal,
): Promise<number> {
  let shown: { message: string; at: number } | undefined;
  for (;;) {
    let code: number;
    try {
      code = await streamWorkloadLogs(
        accessToken,
        { id, follow: true },
        handlers,
        { signal },
      );
    } catch (error) {
      if (
        !(error instanceof ApiHttpError) ||
        error.code !== LOGS_CONTAINER_NOT_READY
      ) {
        throw error;
      }
      const now = Date.now();
      if (
        shown?.message !== error.message ||
        now - shown.at >= SETUP_HEARTBEAT_MS
      ) {
        process.stderr.write(`${error.message} Waiting…\n`);
        shown = { message: error.message, at: now };
      }
      await sleep(SETUP_POLL_MS, signal);
      continue;
    }
    if ((await afterContainerExit(client, id, signal)) === 'ended') return code;
  }
}

/**
 * A Job stays running or finalizing after its container exits until the API
 * records the exit and finishes any final artifact sync (on Spot about 2.5
 * min, while it rules out a reclaim). Hold `--follow` until the Job ends, so
 * a reconnect can't replay the whole log. If the Job leaves for another
 * attempt (recovering, retrying), reconnect only once it is running again:
 * until a new container replaces it, the API serves the exited one.
 * A Service's or VM's container restarts instead.
 */
async function afterContainerExit(
  client: ApiClient,
  id: string,
  signal: AbortSignal,
): Promise<'ended' | 'reconnect'> {
  let left = false;
  let shown: string | undefined;
  for (;;) {
    let workload;
    try {
      ({ workload } = await client.workloads.status(
        { params: { id }, query: {} },
        { signal },
      ));
    } catch (error) {
      if (signal.aborted) throw error;
      return 'ended';
    }
    if (workload.workloadType !== 'job' || isTerminalState(workload.state)) {
      // Reconnecting to an ended Job can fail after cleanup, so point to status.
      if (left)
        process.stderr.write(
          `Job is ${workload.state}; its last attempt ended between checks. See \`anycloud status ${id}\`.\n`,
        );
      return 'ended';
    }
    const current =
      workload.state === WorkloadState.Running ||
      workload.state === WorkloadState.Finalizing;
    if (current && left) return 'reconnect';
    if (!current) left = true;
    const line = current
      ? 'Container exited; waiting for the Job to finish…\n'
      : `Job is ${workload.state}; waiting for its next container…\n`;
    if (line !== shown) process.stderr.write((shown = line));
    await sleep(SETUP_POLL_MS, signal);
  }
}

export function createLogsCommand(): Command {
  return new Command('logs')
    .description('📜 View workload container logs')
    .argument('[id]', 'Workload ID (omit for interactive picker)')
    .option(
      '-f, --follow',
      'Follow log output, waiting through setup, until the stream ends',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud logs job-abc123
  $ anycloud logs job-abc123 --follow
  $ anycloud logs job-abc123 --follow | grep -m1 -E 'DONE|Traceback'

--follow started before the container exists waits for it, and for a Job it
ends when the Job does, not when its container exits. Logs stop at the
next output after the reader exits, or when a Job whose container has exited
ends, so the last example ends soon after the first match.

Prints workload stdout/stderr through the API. VM-host workloads use Docker.
`,
    )
    .action(async (id: string | undefined, options: { follow?: boolean }) => {
      // A reader that stops early (`| head`, `| grep -m1`) closes the pipe;
      // stop streaming instead of failing on the next write.
      const readerGone = new AbortController();
      try {
        const resolvedId = await resolveWorkloadId(id);
        const accessToken = await nativeApiBearer();
        const follow = options.follow === true;

        // Logs always stream through the API. VM-host credentials remain
        // server-side; the client never receives control credentials.
        const request = { id: resolvedId, follow };
        const handlers = {
          stdout: async (chunk: Buffer) => {
            if (!(await writeFd(1, chunk))) readerGone.abort();
          },
          stderr: async (chunk: Buffer) => {
            if (!(await writeFd(2, chunk))) readerGone.abort();
          },
        };
        const client = follow ? await apiClient() : undefined;
        const code = client
          ? await runUntilInterrupted(LOGS_FOLLOW_LABEL, (signal) =>
              followOnceRunning(
                accessToken,
                client,
                resolvedId,
                handlers,
                AbortSignal.any([signal, readerGone.signal]),
              ),
            )
          : await streamWorkloadLogs(accessToken, request, handlers, {
              signal: readerGone.signal,
            });

        if (code !== 0) {
          process.exitCode = code;
        }
      } catch (error) {
        if (readerGone.signal.aborted) return;
        if (isInterrupted(error)) {
          process.exitCode = SIGINT_EXIT_CODE;
          return;
        }
        printError(`Failed to fetch logs: ${errorMessage(error)}`);
        process.exit(1);
      }
    });
}
