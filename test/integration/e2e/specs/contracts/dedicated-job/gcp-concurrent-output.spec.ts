import { test, expect } from '../../../fixture.js';

test('gcp satisfies the concurrent-output Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'concurrent-output',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'concurrent-output', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
