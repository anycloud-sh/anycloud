import { test, expect } from '../../../fixture.js';

test('GCP satisfies the storage tokens contract', async ({ e2e }) => {
  const result = await e2e.contracts.storageTokens('gcp');
  expect(result).toEqual({
    contract: 'storage-tokens',
    qualification: 'conclusive',
    target: 'gcp',
    satisfied: true,
  });
});
