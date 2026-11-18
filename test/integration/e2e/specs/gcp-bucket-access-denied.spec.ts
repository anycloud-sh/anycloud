import { test, expect } from '../fixture.js';

test('gcp refuses a credential without a storage grant as BUCKET_ACCESS_DENIED', async ({
  e2e,
}) => {
  expect(await e2e.bucketAccess.denied('gcp')).toEqual({
    scenario: 'bucket-access-denied',
    provider: 'gcp',
    satisfied: true,
  });
});
