import { expect, test } from '../fixture.js';

test('0044/S12 claim-queue burst of 1,000 pool Jobs and the in-flight cap on KWOK', async ({
  e2e,
}) => {
  const result = await e2e.contracts.claimBurst('e2e-claim-burst-local');
  expect(result).toEqual({
    contract: 'e2e-claim-burst-local',
    qualification: 'conclusive',
    target: 'e2e-claim-burst-local',
    satisfied: true,
  });
});
