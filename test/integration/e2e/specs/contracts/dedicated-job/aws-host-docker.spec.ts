import { test, expect } from '../../../fixture.js';

test('aws satisfies the host-docker Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'host-docker',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'host-docker', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
