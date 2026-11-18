import { expect, test } from '../fixture.js';

test('Hosted API creation, VM Service and native teardown', async ({ e2e }) => {
  // The target is the management VM's cloud, as cluster_provider sets it.
  const { target, ...result } = await e2e.contracts.clusterCloud();
  expect(result).toEqual({
    contract: 'e2e-cluster-cloud',
    qualification: 'conclusive',
    satisfied: true,
  });
  expect(['aws', 'gcp', 'azure']).toContain(target);
});
