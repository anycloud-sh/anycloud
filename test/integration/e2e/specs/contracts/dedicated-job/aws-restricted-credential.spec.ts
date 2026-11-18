import { test, expect } from '../../../fixture.js';

test('0047/S1 0047/S2 0047/S3 aws satisfies the restricted-credential Job contract', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'restricted-credential',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'restricted-credential', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
