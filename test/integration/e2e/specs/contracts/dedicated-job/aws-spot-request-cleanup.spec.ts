import { test, expect } from '../../../fixture.js';

test('aws satisfies the persistent Spot cleanup Job contract', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'spot-request-cleanup',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'spot-request-cleanup', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
