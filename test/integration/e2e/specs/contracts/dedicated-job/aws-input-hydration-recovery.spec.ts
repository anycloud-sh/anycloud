import { test, expect } from '../../../fixture.js';

test('aws satisfies the input-hydration-recovery Job contract', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'input-hydration-recovery',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'input-hydration-recovery', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
