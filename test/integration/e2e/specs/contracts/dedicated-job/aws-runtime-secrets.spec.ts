import { test, expect } from '../../../fixture.js';

test('aws satisfies the runtime-secret Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'runtime-secrets',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'runtime-secrets', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
