import { test, expect } from '../../../fixture.js';

test('Lambda satisfies the VM host-loss contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVmHostLoss('lambda');
  expect(result).toEqual({
    contract: 'persistent-vm-host-loss',
    qualification: 'conclusive',
    target: 'lambda',
    satisfied: true,
  });
});
