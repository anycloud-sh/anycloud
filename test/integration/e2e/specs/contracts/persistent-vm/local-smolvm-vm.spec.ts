import { test, expect } from '../../../fixture.js';

test('local smolvm satisfies the persistent VM contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVm('local-smolvm');
  expect(result).toEqual({
    contract: 'persistent-vm',
    qualification: 'conclusive',
    target: 'local-smolvm',
    satisfied: true,
  });
});
