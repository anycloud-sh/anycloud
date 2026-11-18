import { describe, expect, it } from 'vitest';
import { selectOnboardingSmokeBuckets } from '../../../ci/cleanup/gcp-onboarding-buckets';

describe('GCP onboarding smoke bucket sweep', () => {
  it('selects only onboarding smoke buckets older than an hour', () => {
    const now = Date.parse('2026-09-26T03:00:00Z');
    const at = (minutesAgo: number) =>
      new Date(now - minutesAgo * 60_000).toISOString();
    const buckets = [
      ['anycloud-onb-smoke-3616953949801-98a1c0443c824b25', at(90)],
      ['anycloud-onb-smoke-3620849079201-5b709a6f6a0a4ad8', at(60)],
      ['anycloud-onb-smoke-3621126980501-4c5d77e95c284cb3', at(59)],
      ['anycloud-onb-smoke-x-notahex', at(500)],
      ['anycloud-output-1234-deadbeef', at(500)],
      ['anycloud-onb-smoke-1-deadbeef', null],
      ['anycloud-onb-smoke-2-deadbeef', 'not a date'],
    ].map(([name, timeCreated]) => ({ name: name!, timeCreated }));
    expect(selectOnboardingSmokeBuckets(buckets, now)).toEqual([
      'anycloud-onb-smoke-3616953949801-98a1c0443c824b25',
      'anycloud-onb-smoke-3620849079201-5b709a6f6a0a4ad8',
    ]);
  });
});
