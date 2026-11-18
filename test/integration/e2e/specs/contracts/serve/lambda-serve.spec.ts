import { test, expect } from '../../../fixture.js';

test('Lambda satisfies the Serve contract', async ({ e2e }) => {
  const result = await e2e.contracts.serve('lambda');
  expect(result).toEqual({
    contract: 'serve',
    qualification: 'conclusive',
    target: 'lambda',
    satisfied: true,
  });
});
