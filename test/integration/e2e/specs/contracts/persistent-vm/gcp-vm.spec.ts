import { test, expect } from '../../../fixture.js';

test('GCP satisfies the persistent VM contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVm('gcp');
  expect(result).toEqual({
    contract: 'persistent-vm',
    qualification: 'conclusive',
    target: 'gcp',
    satisfied: true,
  });
});
