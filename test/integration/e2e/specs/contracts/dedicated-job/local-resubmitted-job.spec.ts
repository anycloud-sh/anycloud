import { expect, test } from '../../../fixture.js';

test('Local Job same-ID resubmission preserves configuration, storage and native cleanup', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'local-resubmitted',
    target: 'local-smolvm',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'local-resubmitted', target: 'local-smolvm' },
    target: 'local-smolvm',
    qualification: 'conclusive',
    satisfied: true,
  });
});
