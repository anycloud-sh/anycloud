import { authenticatedEndpoints } from './base.js';
import { noContentSchema, noInputSchema } from './common-schemas.js';
import {
  listBudgetsResponseSchema,
  listThrottlesResponseSchema,
  setBudgetRequestSchema,
  setThrottleRequestSchema,
  unsetBudgetRequestSchema,
  unsetThrottleRequestSchema,
} from './spend-controls-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Spend Controls');

const listThrottles = authenticated
  .query({
    method: 'GET',
    path: '/spend/throttles',
    operationId: 'listThrottles',
    summary: 'List throttles and current burn rate',
  })
  .input(noInputSchema)
  .output(listThrottlesResponseSchema);

const setThrottle = authenticated
  .command({
    method: 'PUT',
    path: '/spend/throttles/{scope}',
    operationId: 'setThrottle',
    summary: 'Set a throttle',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(setThrottleRequestSchema)
  .output(noContentSchema);

const unsetThrottle = authenticated
  .command({
    method: 'DELETE',
    path: '/spend/throttles/{scope}',
    operationId: 'unsetThrottle',
    summary: 'Remove a throttle',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(unsetThrottleRequestSchema)
  .output(noContentSchema);

const listBudgets = authenticated
  .query({
    method: 'GET',
    path: '/spend/budgets',
    operationId: 'listBudgets',
    summary: 'List budgets and current spend',
  })
  .input(noInputSchema)
  .output(listBudgetsResponseSchema);

const setBudget = authenticated
  .command({
    method: 'PUT',
    path: '/spend/budgets/{period}/{scope}',
    operationId: 'setBudget',
    summary: 'Set a budget',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(setBudgetRequestSchema)
  .output(noContentSchema);

const unsetBudget = authenticated
  .command({
    method: 'DELETE',
    path: '/spend/budgets/{period}/{scope}',
    operationId: 'unsetBudget',
    summary: 'Remove a budget',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(unsetBudgetRequestSchema)
  .output(noContentSchema);

export const spendControlsContract = {
  throttles: {
    list: listThrottles,
    set: setThrottle,
    unset: unsetThrottle,
  },
  budgets: {
    list: listBudgets,
    set: setBudget,
    unset: unsetBudget,
  },
};
