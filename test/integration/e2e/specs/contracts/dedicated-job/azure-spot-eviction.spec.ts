import { test, expect } from '../../../fixture.js';

test('azure satisfies the spot-eviction Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'spot-eviction',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'spot-eviction', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
