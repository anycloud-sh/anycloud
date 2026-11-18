import { test, expect } from '../../../fixture.js';

test('lambda completes pinned MACE CUDA inference and cleans its Job', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'mace-full-pull',
    target: 'lambda',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'mace-full-pull', target: 'lambda' },
    target: 'lambda',
    qualification: 'conclusive',
    satisfied: true,
  });
});
