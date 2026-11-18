import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSpendControlsStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';

describe('SpendControlsStore', () => {
  beforeEach(() => {
    // Both repositories share the DB and reset as one persistence unit.
    resetPersistence();
  });

  describe('throttles', () => {
    it('upserts on conflicting scope and keeps a single row per scope', async () => {
      const store = getSpendControlsStore();
      await store.setThrottle('account', 10);
      await store.setThrottle('account', 25); // upsert

      const rows = await store.listThrottles();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scope: 'account', capUsd: 25 });
    });

    it('keeps account and agent-session as independent rows', async () => {
      const store = getSpendControlsStore();
      await store.setThrottle('account', 20);
      await store.setThrottle('agent-session', 5);

      const rows = await store.listThrottles();
      expect(rows).toHaveLength(2);
      const byScope = Object.fromEntries(rows.map((r) => [r.scope, r.capUsd]));
      expect(byScope).toEqual({ account: 20, 'agent-session': 5 });
    });

    it('returns true on delete of existing throttle, false on missing', async () => {
      const store = getSpendControlsStore();
      await store.setThrottle('account', 10);

      expect(await store.deleteThrottle('account')).toBe(true);
      expect(await store.deleteThrottle('account')).toBe(false);
      expect(await store.listThrottles()).toEqual([]);
    });
  });

  describe('budgets', () => {
    it('upserts on conflicting (period, scope) and keeps a single row', async () => {
      const store = getSpendControlsStore();
      await store.setBudget('day', 'account', 50);
      await store.setBudget('day', 'account', 100); // upsert

      const rows = await store.listBudgets();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        period: 'day',
        scope: 'account',
        capUsd: 100,
      });
    });

    it('treats every (period, scope) pair as its own row', async () => {
      const store = getSpendControlsStore();
      await store.setBudget('day', 'account', 100);
      await store.setBudget('day', 'agent-session', 50);
      await store.setBudget('month', 'account', 2000);

      const rows = await store.listBudgets();
      expect(rows).toHaveLength(3);
    });

    it('delete is idempotent and returns whether it removed a row', async () => {
      const store = getSpendControlsStore();
      await store.setBudget('month', 'account', 1000);

      expect(await store.deleteBudget('month', 'account')).toBe(true);
      expect(await store.deleteBudget('month', 'account')).toBe(false);
      expect(await store.listBudgets()).toEqual([]);
    });
  });

  describe('block alerts', () => {
    const dailyAccountBudget = {
      kind: 'budget' as const,
      scope: 'account' as const,
      sessionId: null,
      period: 'day' as const,
      windowResetAt: 3000,
    };
    const accountThrottle = {
      kind: 'throttle' as const,
      scope: 'account' as const,
      sessionId: null,
      period: null,
      windowResetAt: null,
    };

    it('returns null when a cap has never alerted', async () => {
      const store = getSpendControlsStore();
      expect(await store.lastBlockAlertAt(dailyAccountBudget)).toBeNull();
    });

    it('returns the most recent sent_at for a cap', async () => {
      const store = getSpendControlsStore();
      await store.recordBlockAlert(dailyAccountBudget, 2000);
      await store.recordBlockAlert(dailyAccountBudget, 1000); // older
      await store.recordBlockAlert(accountThrottle, 5000); // other cap

      expect(await store.lastBlockAlertAt(dailyAccountBudget)).toBe(2000);
      expect(await store.lastBlockAlertAt(accountThrottle)).toBe(5000);
    });

    it('treats separate budget reset windows as distinct caps', async () => {
      const store = getSpendControlsStore();
      const nextWindow = { ...dailyAccountBudget, windowResetAt: 4000 };

      await store.recordBlockAlert(dailyAccountBudget, 2000);

      expect(await store.lastBlockAlertAt(nextWindow)).toBeNull();
    });
  });
});
