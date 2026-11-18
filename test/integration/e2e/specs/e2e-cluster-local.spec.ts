import { expect, test } from '../fixture.js';

test('local cluster recorded through the API, kept across an API restart, and the hosted chart repaired', async ({
  e2e,
}) => {
  const result = await e2e.contracts.clusterLocal('e2e-cluster-local');
  expect(result).toEqual({
    contract: 'e2e-cluster-local',
    qualification: 'conclusive',
    target: 'e2e-cluster-local',
    satisfied: true,
  });
});
