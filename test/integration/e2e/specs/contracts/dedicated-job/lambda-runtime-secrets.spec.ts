import { test, expect } from '../../../fixture.js';

test('lambda satisfies the runtime-secret Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'runtime-secrets',
    target: 'lambda',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'runtime-secrets', target: 'lambda' },
    target: 'lambda',
    qualification: 'conclusive',
    satisfied: true,
  });
});
