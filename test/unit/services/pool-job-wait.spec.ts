import { describe, expect, it } from 'vitest';
import { poolJobWait } from '../../../src/api/services/deployment-status.js';

describe("a queued pool Job's wait reason", () => {
  it('says why a queued pool Job waits', () => {
    const runtime = (
      podName: string | null,
      pendingReason: string | null = null,
      containerFailed = false,
    ): Parameters<typeof poolJobWait>[0] => ({
      workload: { podName, pendingReason },
      containerFailed,
    });
    expect(poolJobWait(runtime(null), null)).toBe('no replica yet');
    expect(poolJobWait(runtime(null), 'blocked by daily budget')).toBe(
      'no replica yet: blocked by daily budget',
    );
    expect(poolJobWait(runtime('r', 'Insufficient GPU'), null)).toBe(
      'its replica is Pending: Insufficient GPU',
    );
    expect(poolJobWait(runtime('r', null, true), null)).toBe(
      "its replica can't start",
    );
    expect(poolJobWait(runtime('r'), null)).toBe(
      'every replica is busy or starting',
    );
  });
});
