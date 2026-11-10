import { test, expect } from '../../../fixture.js';

test('lambda satisfies the GPU health fault Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'gpu-health-fault',
    target: 'lambda',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'gpu-health-fault', target: 'lambda' },
    target: 'lambda',
    qualification: 'conclusive',
    satisfied: true,
  });
});
