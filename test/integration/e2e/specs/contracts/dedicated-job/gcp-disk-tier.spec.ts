import { test, expect } from '../../../fixture.js';

test('gcp creates the seven boot disks and cleans every Job', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'disk-tier',
    target: 'gcp',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'disk-tier', target: 'gcp' },
    target: 'gcp',
    qualification: 'conclusive',
    satisfied: true,
  });
});
