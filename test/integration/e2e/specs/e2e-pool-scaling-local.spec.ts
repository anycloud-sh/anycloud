import { expect, test } from '../fixture.js';

test('0048/S1 0048/S2 0048/S3 0048/S4 0048/S6 0048/S7 0048/S8 0044/S6 0044/S7 0044/S15 local node pool scales out on Pending pool Jobs and back in when idle', async ({
  e2e,
}) => {
  const result = await e2e.contracts.poolScalingLocal('e2e-pool-scaling-local');
  expect(result).toEqual({
    contract: 'e2e-pool-scaling-local',
    qualification: 'conclusive',
    target: 'e2e-pool-scaling-local',
    satisfied: true,
  });
});
