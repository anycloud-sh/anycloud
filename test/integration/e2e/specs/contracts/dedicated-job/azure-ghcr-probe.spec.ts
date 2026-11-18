import { test, expect } from '../../../fixture.js';

test('azure verifies GHCR throughput, containerd visibility and cleanup', async ({
  e2e,
}) => {
  const result = await e2e.contracts.dedicatedJob({
    kind: 'ghcr-probe',
    target: 'azure',
  });
  expect(result).toEqual({
    contract: 'dedicated-job',
    member: { kind: 'ghcr-probe', target: 'azure' },
    target: 'azure',
    qualification: 'conclusive',
    satisfied: true,
  });
});
