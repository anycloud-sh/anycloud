import { test, expect } from '../../../fixture.js';

test('azure satisfies the concurrent-output Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'concurrent-output',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'concurrent-output', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
