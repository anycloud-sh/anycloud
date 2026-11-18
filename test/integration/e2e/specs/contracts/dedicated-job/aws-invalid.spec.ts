import { test, expect } from '../../../fixture.js';

test('aws rejects invalid Job admission before provisioning', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'invalid-admission',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'invalid-admission', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
