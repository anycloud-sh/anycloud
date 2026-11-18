import { test, expect } from '../../../fixture.js';

test('AWS satisfies the persistent VM contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVm('aws');
  expect(result).toEqual({
    contract: 'persistent-vm',
    qualification: 'conclusive',
    target: 'aws',
    satisfied: true,
  });
});
