export const POLICY = Object.freeze({
  version: 1,
  repetitions: 6,
  calibrationRatio: Object.freeze([0.95, 1.05]),
  controlRatio: 1.05,
  benefitRatio: 0.9,
  rateMarginPp: 1,
  workDeadlineMs: 15_000,
  healthDeadlineMs: 1000,
  healthIntervalMs: 100,
  drainMs: 20_000,
  maximumLagMs: 100,
  maximumInFlight: 128,
});

export function loadPhases(smoke) {
  return (smoke ? [2, 3, 3] : [30, 60, 90]).map((seconds, i) => ({
    name: ['normal', 'overload', 'recovery'][i],
    seconds,
    rate: [2.4, 8, 2.4][i],
  }));
}
