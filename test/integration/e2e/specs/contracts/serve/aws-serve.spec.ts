import { test, expect } from '../../../fixture.js';

test('AWS satisfies the Serve contract', async ({ e2e }) => {
  const result = await e2e.contracts.serve('aws');
  expect(result).toEqual({
    contract: 'serve',
    qualification: 'conclusive',
    target: 'aws',
    satisfied: true,
  });
});
