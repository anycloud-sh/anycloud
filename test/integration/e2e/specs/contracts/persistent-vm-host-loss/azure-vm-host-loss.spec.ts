import { test, expect } from '../../../fixture.js';

test('Azure VM host loss', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVmHostLoss('azure');
  expect(result).toEqual({
    contract: 'persistent-vm-host-loss',
    qualification: 'conclusive',
    target: 'azure',
    satisfied: true,
  });
});
