import { test, expect } from '../../../fixture.js';

test('gcp rejects invalid Job admission before provisioning', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'invalid-admission',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'invalid-admission', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
