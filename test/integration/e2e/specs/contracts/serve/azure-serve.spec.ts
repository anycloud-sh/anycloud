import { test, expect } from '../../../fixture.js';

test('Azure satisfies the Serve contract', async ({ e2e }) => {
  const result = await e2e.contracts.serve('azure');
  expect(result).toEqual({
    contract: 'serve',
    qualification: 'conclusive',
    target: 'azure',
    satisfied: true,
  });
});
