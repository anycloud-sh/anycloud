import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * e2e-cluster-cloud runs concurrently, so a resource no run recorded may be a
 * live run's. Installation and node pool ids carry their creation time
 * (`<prefix>-<ms>-<rand>`, src/shared/id-generator.ts), and the longest job is
 * bounded to 130 minutes: an id older than this belongs to a finished run.
 */
export const STALE_AFTER_MS = 3 * 60 * 60_000;

/** The ids created more than {@link STALE_AFTER_MS} before `now`. */
export function staleIds(ids: readonly string[], now = Date.now()): string[] {
  return ids.filter((id) => {
    const created = /-(\d{13})-[0-9a-z]{4}$/u.exec(id)?.[1];
    return created !== undefined && now - Number(created) > STALE_AFTER_MS;
  });
}

// `… | npx tsx ci/cleanup/e2e-cluster-stale-ids.ts`: the stale ids of those
// on stdin (whitespace- or comma-separated), one per line.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const ids = readFileSync(0, 'utf8')
    .split(/[\s,]+/u)
    .filter(Boolean);
  for (const id of staleIds(ids)) console.log(id);
}
