import { test, expect } from '../../../fixture.js';

test('0047/S4 0047/S11 azure satisfies the restricted-credential Job contract', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'restricted-credential',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'restricted-credential', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
