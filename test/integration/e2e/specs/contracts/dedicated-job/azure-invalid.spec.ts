import { test, expect } from '../../../fixture.js';

test('azure rejects invalid Job admission before provisioning', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'invalid-admission',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'invalid-admission', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
