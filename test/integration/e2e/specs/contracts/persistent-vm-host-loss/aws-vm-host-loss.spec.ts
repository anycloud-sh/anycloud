import { test, expect } from '../../../fixture.js';

test('AWS satisfies the persistent VM host-loss contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVmHostLoss('aws');
  expect(result).toEqual({
    contract: 'persistent-vm-host-loss',
    qualification: 'conclusive',
    target: 'aws',
    satisfied: true,
  });
});
