import { expect, test } from '../../../fixture.js';

test('Lambda satisfies the GPU Service contract', async ({ e2e }) => {
  const result = await e2e.contracts.gpuServe('lambda');
  expect(result).toEqual({
    contract: 'gpu-serve',
    qualification: 'conclusive',
    satisfied: true,
    target: 'lambda',
  });
});
