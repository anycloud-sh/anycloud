import { test, expect } from '../../../fixture.js';

test('gcp satisfies the GPU probe rerun Job contract', async ({ e2e }) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'gpu-probe-rerun',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'gpu-probe-rerun', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
