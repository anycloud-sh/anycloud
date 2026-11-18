import { sleep } from '../../shared/utils.js';

export const DEFAULT_WATCH_INTERVAL_SECONDS = 5;
const MIN_WATCH_INTERVAL_SECONDS = 1;

export function parseWatchInterval(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WATCH_INTERVAL_SECONDS;
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < MIN_WATCH_INTERVAL_SECONDS) {
    throw new Error(
      `--interval must be a number >= ${MIN_WATCH_INTERVAL_SECONDS}`,
    );
  }
  return interval;
}

/**
 * Read until `done`, handing each read over: the loop behind `status --watch`
 * for Workloads and clusters.
 */
export async function watchUntil<T>(
  read: () => Promise<T>,
  options: {
    intervalSeconds: number;
    done: (value: T) => boolean;
    onRead: (value: T, iteration: number) => void;
    signal?: AbortSignal;
  },
): Promise<T> {
  for (let iteration = 0; ; iteration++) {
    const value = await read();
    options.onRead(value, iteration);
    if (options.done(value)) return value;
    await sleep(options.intervalSeconds * 1000, options.signal);
  }
}
