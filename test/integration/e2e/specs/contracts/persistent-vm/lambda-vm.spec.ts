import { test, expect } from '../../../fixture.js';

test('Lambda satisfies the persistent VM contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVm('lambda');
  expect(result).toEqual({
    contract: 'persistent-vm',
    qualification: 'conclusive',
    target: 'lambda',
    satisfied: true,
  });
});
