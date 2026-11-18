import { test, expect } from '../../../fixture.js';

test('azure satisfies the host-recovery Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'host-recovery',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'host-recovery', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
