import { test, expect } from '../../../fixture.js';

test('gcp satisfies the spot-eviction Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'spot-eviction',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'spot-eviction', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
