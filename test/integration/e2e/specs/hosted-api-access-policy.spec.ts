import { test, expect } from '../fixture.js';

test('Hosted API access binds durable accounts and authorizes real callers', async ({
  e2e,
}) => {
  const result = await e2e.apiAuth.accessPolicy();
  expect(result).toEqual({
    scenario: 'hosted-api-access-policy',
    satisfied: true,
  });
});
