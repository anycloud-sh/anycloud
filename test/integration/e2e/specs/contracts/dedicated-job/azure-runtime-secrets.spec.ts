import { test, expect } from '../../../fixture.js';

test('azure satisfies the runtime-secret Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'runtime-secrets',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'runtime-secrets', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
