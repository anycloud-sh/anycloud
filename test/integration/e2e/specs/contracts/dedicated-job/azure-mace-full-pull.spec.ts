import { test, expect } from '../../../fixture.js';

test('azure completes pinned MACE CUDA inference and cleans its Job', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'mace-full-pull',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'mace-full-pull', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
