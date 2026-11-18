import { test, expect } from '../../../fixture.js';

test('GCP satisfies the Serve contract', async ({ e2e }) => {
  const result = await e2e.contracts.serve('gcp');
  expect(result).toEqual({
    contract: 'serve',
    qualification: 'conclusive',
    target: 'gcp',
    satisfied: true,
  });
});
