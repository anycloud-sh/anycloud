import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { V1Pod } from '@kubernetes/client-node';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import type { ClusterKubernetesClient } from './cluster-client.js';

/** How much of a log a tail keeps: its last 1 MiB (RFC 0044). */
export const POD_LOG_TAIL_BYTES = 1024 * 1024;

export interface PodLogTarget {
  namespace: string;
  pod: string;
  container: string;
  /** The container's run before its latest restart. */
  previous?: boolean;
}

type PodLogClient = Pick<ClusterKubernetesClient, 'log'>;

/**
 * One pool Job's span of its replica's log (RFC 0044 § Logs): one Job per
 * replica at a time, so the claim (`from`) and the execution's end bound its
 * lines. `until` gets each batch's latest stamp and answers the end, or null
 * while the Job ran at least that long. The read asks for `timestamps=true`
 * from the second before, as `sinceTime` has one-second precision, and each
 * kept line loses its stamp.
 */
export interface LogWindow {
  from: number;
  until?: (latest: number) => Promise<number | null>;
}

function windowed(
  window: LogWindow,
  write: (chunk: Buffer) => void | Promise<void>,
) {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const emit = async (lines: string[]) => {
    const stamped = lines.map((line) => {
      const space = line.indexOf(' ');
      const at = Date.parse(
        line.slice(0, space).replace(/(\.\d{3})\d+/u, '$1'),
      );
      return { at, text: `${line.slice(space + 1)}\n` };
    });
    const latest = Math.max(...stamped.map(({ at }) => at || 0));
    const end = (await window.until?.(latest)) ?? null;
    const kept = stamped.filter(
      ({ at }) => at >= window.from && (end === null || at <= end),
    );
    if (kept.length > 0) {
      await write(Buffer.from(kept.map(({ text }) => text).join('')));
    }
  };
  return {
    write(chunk: Buffer) {
      const lines = (partial + decoder.write(chunk)).split('\n');
      partial = lines.pop()!;
      return emit(lines);
    },
    flush() {
      const rest = partial + decoder.end();
      partial = '';
      return emit(rest ? [rest] : []);
    },
  };
}

/**
 * Stream one container's log (`pods/log`) into `write`, honouring its
 * backpressure, until the log ends or `signal` aborts. Kubernetes merges the
 * container's stdout and stderr into this one stream.
 */
export function podLogs(
  cluster: PodLogClient,
  target: PodLogTarget,
  options: { follow: boolean; signal: AbortSignal; window?: LogWindow },
  write: (chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  const { signal, window } = options;
  const span = window && windowed(window, write);
  return new Promise((resolve, reject) => {
    let request: AbortController | undefined;
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      request?.abort();
      if (error) reject(error);
      else if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const onAbort = () => done();
    if (signal.aborted) return done();
    signal.addEventListener('abort', onAbort, { once: true });
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        Promise.resolve(span ? span.write(chunk) : write(chunk)).then(
          () => callback(),
          callback,
        );
      },
      final(callback) {
        Promise.resolve(span?.flush()).then(() => callback(), callback);
      },
    });
    sink.once('finish', () => done());
    sink.once('error', done);
    // `pipe` doesn't forward a source error: a dropped connection would hang.
    sink.once('pipe', (source) => source.once('error', done));
    cluster.log
      .log(target.namespace, target.pod, target.container, sink, {
        follow: options.follow,
        previous: target.previous === true,
        ...(window && {
          timestamps: true,
          sinceTime: new Date(
            Math.floor(window.from / 1000) * 1000,
          ).toISOString(),
        }),
      })
      .then((controller) => {
        request = controller;
        if (settled) controller.abort();
      }, done);
  });
}

/**
 * The last `limitBytes` of a container's log, or all of it when shorter.
 * Memory stays within `limitBytes` plus one chunk however long the log is.
 */
export async function tail(
  cluster: PodLogClient,
  target: PodLogTarget,
  limitBytes = POD_LOG_TAIL_BYTES,
  signal: AbortSignal = new AbortController().signal,
  window?: LogWindow,
): Promise<Buffer> {
  const kept: Buffer[] = [];
  let size = 0;
  await podLogs(cluster, target, { follow: false, signal, window }, (chunk) => {
    kept.push(chunk);
    size += chunk.length;
    while (kept.length > 1 && size - kept[0]!.length >= limitBytes) {
      size -= kept.shift()!.length;
    }
  });
  const log = Buffer.concat(kept);
  return log.subarray(Math.max(0, log.length - limitBytes));
}

/** A log tail as an attempt stores it, or why it couldn't be read. */
export type CapturedTail =
  | { state: 'captured'; text: string }
  | { state: 'unavailable'; text: string };

/**
 * The tail of one container instance, read before its Pod's finalizer is
 * released: its current log, or its previous run's once kubelet has
 * restarted it under `restartPolicy: Always`.
 */
export async function captureTail(
  cluster: PodLogClient,
  pod: V1Pod | undefined,
  container: string,
  containerId: string,
  /** A runner replica's: only the Job's span of it. */
  window?: LogWindow,
): Promise<CapturedTail> {
  if (!pod) {
    return {
      state: 'unavailable',
      text: 'Its Pod was gone before its log was read.',
    };
  }
  const status = pod.status?.containerStatuses?.find(
    (candidate) => candidate.name === container,
  );
  try {
    const log = await tail(
      cluster,
      {
        namespace: pod.metadata!.namespace!,
        pod: pod.metadata!.name!,
        container,
        previous: status?.containerID !== containerId,
      },
      undefined,
      AbortSignal.timeout(30_000),
      window,
    );
    return { state: 'captured', text: log.toString('utf8') };
  } catch (error) {
    return {
      state: 'unavailable',
      text: `Its log could not be read: ${errorMessage(error)}.`,
    };
  }
}
