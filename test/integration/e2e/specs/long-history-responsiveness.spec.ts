import { test, expect } from '../fixture.js';

test('long history preserves recovery, query, session and billing behavior', async ({
  e2e,
}) => {
  expect(await e2e.readModels.longHistory()).toEqual({
    historicalWorkloads: 3_700,
    sessionForms: 5,
    historyPreserved: true,
    billingResponsive: true,
  });
});
