import { test, expect } from '../../../fixture.js';

test('Local VM host loss', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVmHostLoss('local-smolvm');
  expect(result).toEqual({
    contract: 'persistent-vm-host-loss',
    qualification: 'conclusive',
    target: 'local-smolvm',
    satisfied: true,
  });
});
