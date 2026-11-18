import { test, expect } from '../../../fixture.js';

test('aws completes pinned MACE CUDA inference and cleans its Job', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'mace-full-pull',
    target: 'aws',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'mace-full-pull', target: 'aws' },
    target: 'aws',
    qualification: 'conclusive',
    satisfied: true,
  });
});
