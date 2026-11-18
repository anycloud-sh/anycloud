import { expect, test } from 'vitest';
import {
  STALE_AFTER_MS,
  staleIds,
} from '../../../ci/cleanup/e2e-cluster-stale-ids';
import {
  generateClusterId,
  generateNodePoolId,
} from '../../../src/shared/id-generator';

test('selects only ids older than the longest e2e-cluster-cloud job', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const at = (prefix: string, msAgo: number) => `${prefix}-${now - msAgo}-a1b2`;
  // 130 minutes is the longest job's bound; the margin keeps it clear.
  expect(STALE_AFTER_MS).toBeGreaterThan(130 * 60_000);
  expect(
    staleIds(
      [
        at('e2e-clust', 0),
        at('e2e-clust', STALE_AFTER_MS),
        at('e2e-clust', STALE_AFTER_MS + 1),
        at('p', STALE_AFTER_MS + 1),
        at('anycloud-cluster-e2e-clust', STALE_AFTER_MS + 1),
        'e2e-clust-notatime-a1b2',
        'p-1',
      ],
      now,
    ),
  ).toEqual([
    at('e2e-clust', STALE_AFTER_MS + 1),
    at('p', STALE_AFTER_MS + 1),
    at('anycloud-cluster-e2e-clust', STALE_AFTER_MS + 1),
  ]);
});

test('reads the creation time the product embeds in its ids', () => {
  for (const id of [
    generateClusterId('e2e-cluster-abcdef0123'),
    generateNodePoolId('p-abcdef0123'),
  ]) {
    const created = Number(id.split('-').at(-2));
    expect(staleIds([id], created + STALE_AFTER_MS)).toEqual([]);
    expect(staleIds([id], created + STALE_AFTER_MS + 1)).toEqual([id]);
  }
});
