import type {
  ListBudgetsResponse,
  ListThrottlesResponse,
  SetBudgetInput,
  SetThrottleInput,
  UnsetBudgetInput,
  UnsetThrottleInput,
} from '../../shared/api-contract/spend-controls-schemas.js';
import type {
  Period,
  SpendControlsRepository,
} from './spend-controls-store.js';

/**
 * Stateful application boundary for the spend-control API. Transport code may
 * call this service, but must not reach into stores or spend queries directly.
 */
export interface SpendControlsDomain {
  listThrottles(): Promise<ListThrottlesResponse>;
  setThrottle(input: SetThrottleInput): Promise<void>;
  unsetThrottle(input: UnsetThrottleInput): Promise<void>;
  listBudgets(): Promise<ListBudgetsResponse>;
  setBudget(input: SetBudgetInput): Promise<void>;
  unsetBudget(input: UnsetBudgetInput): Promise<void>;
}

export interface SpendControlsDomainDependencies {
  store: Pick<
    SpendControlsRepository,
    | 'listThrottles'
    | 'setThrottle'
    | 'deleteThrottle'
    | 'listBudgets'
    | 'setBudget'
    | 'deleteBudget'
    | 'currentBurnRate'
    | 'currentBurnRateBySession'
    | 'computeSpend'
    | 'computeSpendBySession'
  >;
  periods: readonly Period[];
  now(): Date;
  calendarWindowStartMs(period: Period, now: Date): number;
  calendarWindowEndMs(period: Period, now: Date): number;
}

export function createSpendControlsDomain(
  dependencies: SpendControlsDomainDependencies,
): SpendControlsDomain {
  return {
    async listThrottles() {
      const store = dependencies.store;
      const entries = await store.listThrottles();
      const accountRate = await store.currentBurnRate({ sessionFilter: null });

      // Avoid an extra GROUP BY unless a per-session throttle makes the rows
      // meaningful to the CLI.
      const hasAgentSessionThrottle = entries.some(
        (throttle) => throttle.scope === 'agent-session',
      );
      const sessions = hasAgentSessionThrottle
        ? await store.currentBurnRateBySession()
        : undefined;

      return {
        entries,
        burnRate: {
          account: { currentUsd: accountRate },
          ...(sessions !== undefined && { sessions }),
        },
      };
    },

    async setThrottle(input) {
      await dependencies.store.setThrottle(input.scope, input.capUsd);
    },

    async unsetThrottle(input) {
      await dependencies.store.deleteThrottle(input.scope);
    },

    async listBudgets() {
      const store = dependencies.store;
      const entries = await store.listBudgets();
      const now = dependencies.now();
      const spend: ListBudgetsResponse['spend'] = [];

      for (const period of dependencies.periods) {
        const startMs = dependencies.calendarWindowStartMs(period, now);
        const endMs = dependencies.calendarWindowEndMs(period, now);
        const account = await store.computeSpend({
          windowStartMs: startMs,
          windowEndMs: endMs,
          sessionFilter: null,
        });

        const hasAgentSessionBudget = entries.some(
          (budget) =>
            budget.period === period && budget.scope === 'agent-session',
        );
        const sessions = hasAgentSessionBudget
          ? await store.computeSpendBySession({
              windowStartMs: startMs,
              windowEndMs: endMs,
            })
          : undefined;

        // Rows are grouped by (session, agent), so dedupe the session id when
        // reporting the distinct-session count.
        const agentSessionCount =
          sessions === undefined
            ? undefined
            : new Set(sessions.map((session) => session.session)).size;
        spend.push({
          period,
          scope: 'account',
          startMs,
          endMs,
          ...account,
          ...(agentSessionCount !== undefined && { agentSessionCount }),
          ...(sessions !== undefined && { sessions }),
        });
      }

      return { entries, spend };
    },

    async setBudget(input) {
      await dependencies.store.setBudget(
        input.period,
        input.scope,
        input.capUsd,
      );
    },

    async unsetBudget(input) {
      await dependencies.store.deleteBudget(input.period, input.scope);
    },
  };
}
