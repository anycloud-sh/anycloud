import { test, expect } from '../../../fixture.js';

test('gcp satisfies the bucket-sync Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'bucket-sync',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'bucket-sync', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
