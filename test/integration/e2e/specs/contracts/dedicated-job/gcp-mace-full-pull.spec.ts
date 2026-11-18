import { test, expect } from '../../../fixture.js';

test('gcp completes pinned MACE CUDA inference and cleans its Job', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'mace-full-pull',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'mace-full-pull', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
