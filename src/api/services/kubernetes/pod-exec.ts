import { PassThrough, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { V1Status } from '@kubernetes/client-node';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { channelBoundCommand } from '../gateways/channel-bound-command.js';
import type { JobOperationStream } from '../job/operations.js';
import type { ClusterKubernetesClient } from './cluster-client.js';
import type { PodLogTarget } from './pod-logs.js';

const READY = 'anycloud-exec-ready\n';

/** A Kubernetes exec status's exit code; any other failure throws. */
export function execExitCode(status: V1Status): number {
  if (status.status === 'Success') return 0;
  const code = status.details?.causes?.find(
    (cause) => cause.reason === 'ExitCode',
  )?.message;
  if (code && /^\d+$/u.test(code)) return Number(code);
  throw new Error(status.message ?? 'exec failed');
}

function forward(write: (chunk: Buffer) => void | Promise<void>): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      Promise.resolve(write(chunk)).then(() => done(), done);
    },
  });
}

/**
 * Run `command` under `/bin/sh` in one container (`pods/exec`), as VM-host
 * exec runs it in `docker exec`: non-interactive, and bound to the exec
 * stream's stdin so a dropped client stops it.
 *
 * With `fence`, the command waits until the wrapper is running, then starts
 * only if `fence` returns no refusal. A pool Job's replica resets (kills every
 * process) between Jobs, after the Job's end is recorded, so a command that
 * was already running when the fence saw the Job live can never reach the
 * next Job: the reset kills it first.
 */
export async function podExec(
  cluster: Pick<ClusterKubernetesClient, 'exec'>,
  target: Omit<PodLogTarget, 'previous'>,
  command: string,
  stream: JobOperationStream,
  fence?: () => Promise<string | undefined>,
): Promise<number> {
  const script = fence
    ? `printf '${READY.trim()}\\n'; read -r go && [ "$go" = go ] || exit 125\n${channelBoundCommand(command)}`
    : channelBoundCommand(command);
  const stdin = new PassThrough();
  const failed = new AbortController();
  let failure: unknown;
  const sink = (write: (chunk: Buffer) => void | Promise<void>) =>
    forward(write).on('error', (error) => {
      failure ??= error;
      stdin.end();
      failed.abort();
    });
  let refusal: string | undefined;
  let pending = fence ? Buffer.alloc(0) : undefined;
  const stdout = sink(async (chunk) => {
    if (!pending) return stream.onStdout(chunk);
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < READY.length) return;
    const rest = pending.subarray(READY.length);
    refusal =
      pending.subarray(0, READY.length).toString() === READY
        ? await fence!().catch((error: unknown) => errorMessage(error))
        : 'the exec wrapper did not start';
    pending = undefined;
    if (refusal) return void stdin.end();
    stdin.write('go\n');
    if (rest.length > 0) await stream.onStdout(rest);
  });
  const stderr = sink(stream.onStderr);

  let status: V1Status | undefined;
  const ws = await cluster.exec
    .exec(
      target.namespace,
      target.pod,
      target.container,
      ['/bin/sh', '-c', script],
      stdout,
      stderr,
      stdin,
      false,
      (received) => {
        status = received;
      },
    )
    .catch((error: unknown) => {
      // A refused upgrade rejects with the WebSocket's ErrorEvent.
      throw error instanceof Error
        ? error
        : new Error(`exec failed: ${(error as { message?: string }).message}`);
    });
  const closed = new Promise((resolve) => ws.once('close', resolve));
  const stop = AbortSignal.any([stream.signal, failed.signal]);
  const abort = () => ws.close();
  stop.addEventListener('abort', abort, { once: true });
  if (stop.aborted) abort();
  try {
    await closed;
    if (failure) throw failure;
    if (refusal) throw new Error(refusal);
    if (!status) {
      throw new Error(
        stream.signal.aborted
          ? 'exec cancelled'
          : 'the exec stream closed before the command ended',
      );
    }
    await Promise.all([finished(stdout), finished(stderr)]);
    return execExitCode(status);
  } finally {
    stop.removeEventListener('abort', abort);
    stdin.end();
  }
}
