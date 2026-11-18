import { test, expect } from '../../../fixture.js';

test('Azure satisfies the storage tokens contract', async ({ e2e }) => {
  const result = await e2e.contracts.storageTokens('azure');
  expect(result).toEqual({
    contract: 'storage-tokens',
    qualification: 'conclusive',
    target: 'azure',
    satisfied: true,
  });
});
