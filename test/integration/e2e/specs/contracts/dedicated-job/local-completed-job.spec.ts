import { expect, test } from '../../../fixture.js';

test('Local Job natural completion preserves configuration, storage and native cleanup', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'local-completed',
    target: 'local-smolvm',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'local-completed', target: 'local-smolvm' },
    target: 'local-smolvm',
    qualification: 'conclusive',
    satisfied: true,
  });
});
