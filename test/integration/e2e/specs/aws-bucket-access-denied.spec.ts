import { test, expect } from '../fixture.js';

test('aws refuses a credential without a storage grant as BUCKET_ACCESS_DENIED', async ({
  e2e,
}) => {
  expect(await e2e.bucketAccess.denied('aws')).toEqual({
    scenario: 'bucket-access-denied',
    provider: 'aws',
    satisfied: true,
  });
});
