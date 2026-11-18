import { test, expect } from '../../../fixture.js';

// Qualification remains pending until this cloud-backed member actually passes.
test('0036/S9 AWS upgrades a plain Service to a new image, then restarts during a checkpointed upgrade and preserves checkpoint/URL', async ({
  e2e,
}) => {
  const result = await e2e.contracts.serveUpgrade('aws');
  expect(result).toEqual({
    contract: 'serve-upgrade',
    qualification: 'conclusive',
    target: 'aws',
    satisfied: true,
  });
});
