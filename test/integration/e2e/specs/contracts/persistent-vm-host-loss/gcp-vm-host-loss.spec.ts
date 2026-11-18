import { test, expect } from '../../../fixture.js';

test('GCP satisfies the persistent VM host-loss contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVmHostLoss('gcp');
  expect(result).toEqual({
    contract: 'persistent-vm-host-loss',
    qualification: 'conclusive',
    target: 'gcp',
    satisfied: true,
  });
});
