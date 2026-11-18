import { test, expect } from '../fixture.js';

test('Secret CRUD keeps values private and deletion idempotent', async ({
  e2e,
}) => {
  const result = await e2e.apiAuth.secretCrudPrivacy();
  expect(result).toEqual({ scenario: 'secret-crud-privacy', satisfied: true });
});
