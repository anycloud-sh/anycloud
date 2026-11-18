import { test, expect } from '../../../fixture.js';

test('AWS satisfies the storage tokens contract', async ({ e2e }) => {
  const result = await e2e.contracts.storageTokens('aws');
  expect(result).toEqual({
    contract: 'storage-tokens',
    qualification: 'conclusive',
    target: 'aws',
    satisfied: true,
  });
});
