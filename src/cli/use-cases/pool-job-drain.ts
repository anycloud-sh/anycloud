import { setTimeout as sleep } from 'node:timers/promises';
import { ORPCError } from '@orpc/client';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';

const POLL_MS = 5_000;

/**
 * Decision 30: before an API is replaced, hold its pool Job claims and list
 * the pool Jobs in flight. A Job whose runner release the new release accepts
 * (`keep`, RFC 0049 C27) keeps running through the upgrade; the drain waits
 * for the rest, listing them as they change, or `force` stops them instead,
 * and each retries on the new release. Every poll renews the API's 10-minute
 * hold, so an interrupted upgrade resumes claims after it.
 */
export async function drainPoolJobs(
  release: Pick<ApiClient['systemRelease'], 'drain'>,
  force: boolean,
  report: (message: string) => void,
  options: {
    /** A hosted upgrade's image, which the API checks before it stops a Job. */
    image?: string;
    /** The new release's window: the runner releases it accepts. */
    keep?: readonly string[];
  } = {},
): Promise<void> {
  const { image, keep = [] } = options;
  let shown = '';
  let checked = false;
  let stopping = false;
  let listedContinuing = false;
  for (;;) {
    let jobs;
    try {
      // The first poll checks the release and lists before anything stops;
      // later ones renew the hold.
      ({ jobs } = await release.drain({
        force: stopping,
        // A Job claimed on a kept runner after the listing is spared too.
        ...(stopping && keep.length > 0 && { keep: [...keep] }),
        ...(image && !checked && { image }),
      }));
      checked = true;
    } catch (error) {
      // An API from before the drain has no route for it: a 404, or the
      // version check that answers its unmatched `/v1` paths first.
      if (
        error instanceof ORPCError &&
        (error.status === 404 || error.code === 'CLIENT_VERSION_MISMATCH')
      ) {
        return;
      }
      throw error;
    }
    const continuing = jobs.filter(
      (job) => !!job.runnerRelease && keep.includes(job.runnerRelease),
    );
    const waiting = jobs.filter((job) => !continuing.includes(job));
    if (continuing.length > 0 && !listedContinuing) {
      report(
        `${continuing.length} pool Job(s) keep running through the upgrade: ${listing(continuing)}`,
      );
      listedContinuing = true;
    }
    if (waiting.length === 0) return;
    if (force && !stopping) {
      stopping = true;
      continue;
    }
    const listed = listing(waiting);
    if (listed !== shown) {
      report(
        force
          ? `Stopping ${waiting.length} pool Job(s) so they retry after the upgrade: ${listed}`
          : `Waiting for ${waiting.length} pool Job(s) to finish before the upgrade (--force stops them to retry): ${listed}`,
      );
      shown = listed;
    }
    await sleep(POLL_MS);
  }
}

function listing(jobs: { id: string; state: string; nodePool: string }[]) {
  return jobs
    .map((job) => `${job.id} (${job.state} on ${job.nodePool})`)
    .join(', ');
}
