import { test, expect } from '../fixture.js';

test('azure refuses a credential without a storage grant as BUCKET_ACCESS_DENIED', async ({
  e2e,
}) => {
  expect(await e2e.bucketAccess.denied('azure')).toEqual({
    scenario: 'bucket-access-denied',
    provider: 'azure',
    satisfied: true,
  });
});
