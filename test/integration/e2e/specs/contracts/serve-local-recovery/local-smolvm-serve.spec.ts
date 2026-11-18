import { test, expect } from '../../../fixture.js';

test('a Local Service survives losing its control plane', async ({ e2e }) => {
  const result = await e2e.contracts.serveLocalRecovery('local-smolvm');
  expect(result).toEqual({
    contract: 'serve-local-recovery',
    qualification: 'conclusive',
    target: 'local-smolvm',
    satisfied: true,
  });
});
