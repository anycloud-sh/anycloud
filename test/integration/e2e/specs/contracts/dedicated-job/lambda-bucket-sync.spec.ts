import { test, expect } from '../../../fixture.js';

test('lambda satisfies the bucket-sync Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'bucket-sync',
    target: 'lambda',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'bucket-sync', target: 'lambda' },
    target: 'lambda',
    qualification: 'conclusive',
    satisfied: true,
  });
});
