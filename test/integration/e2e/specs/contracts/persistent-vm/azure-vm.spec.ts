import { test, expect } from '../../../fixture.js';

test('Azure satisfies the persistent VM contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVm('azure');
  expect(result).toEqual({
    contract: 'persistent-vm',
    qualification: 'conclusive',
    target: 'azure',
    satisfied: true,
  });
});
