import { test, expect } from '../../../fixture.js';

test('lambda satisfies the GPU probe rerun Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'gpu-probe-rerun',
    target: 'lambda',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'gpu-probe-rerun', target: 'lambda' },
    target: 'lambda',
    qualification: 'conclusive',
    satisfied: true,
  });
});
