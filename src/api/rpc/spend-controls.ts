import { authenticatedImplementation as authenticated } from './base.js';

export const spendControlsRouter = {
  throttles: {
    list: authenticated.spend.throttles.list.handler(({ context }) =>
      context.domains.spendControls.listThrottles(),
    ),
    set: authenticated.spend.throttles.set.handler(({ context, input }) =>
      context.domains.spendControls.setThrottle(input),
    ),
    unset: authenticated.spend.throttles.unset.handler(
      async ({ context, input }) => {
        await context.domains.spendControls.unsetThrottle(input.params);
      },
    ),
  },
  budgets: {
    list: authenticated.spend.budgets.list.handler(({ context }) =>
      context.domains.spendControls.listBudgets(),
    ),
    set: authenticated.spend.budgets.set.handler(({ context, input }) =>
      context.domains.spendControls.setBudget(input),
    ),
    unset: authenticated.spend.budgets.unset.handler(
      async ({ context, input }) => {
        await context.domains.spendControls.unsetBudget(input.params);
      },
    ),
  },
};
