import { expect, test } from '../../../fixture.js';

test('GCP satisfies the GPU Service contract', async ({ e2e }) => {
  const result = await e2e.contracts.gpuServe('gcp');
  expect(result).toEqual({
    contract: 'gpu-serve',
    qualification: 'conclusive',
    satisfied: true,
    target: 'gcp',
  });
});
