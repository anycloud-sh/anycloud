import { describe, expect, it } from 'vitest';
import {
  FIRST_BACKUP_BUDGET_MS,
  createFirstBackupCheck,
  startBackups,
} from '../../../src/api/services/first-backup.js';

/** A clock that advances only when the check sleeps. */
function check(budgetMs: number, failures: number) {
  let now = 0;
  let attempts = 0;
  const warnings: string[] = [];
  const first = createFirstBackupCheck({
    budgetMs,
    backup: {
      run: async () => {
        attempts += 1;
        if (attempts <= failures) throw new Error('AccessDenied');
        return '2026-11-07T00:00:00.000Z';
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: { warn: (message) => warnings.push(message) },
  });
  return { first, attempts: () => attempts, elapsed: () => now, warnings };
}

describe('first backup through the VM identity', () => {
  it('reports pending, then landed once IAM has propagated', async () => {
    const { first, attempts } = check(FIRST_BACKUP_BUDGET_MS.GCP, 3);
    expect(first.status()).toEqual({
      state: 'pending',
      attempts: 0,
      lastError: null,
    });
    await first.start();
    expect(first.status()).toEqual({
      state: 'landed',
      backedUpAt: '2026-11-07T00:00:00.000Z',
    });
    expect(attempts()).toBe(4);
  });

  it.each(['AWS', 'GCP', 'Azure'] as const)(
    'fails within %s’s budget, naming the last refusal',
    async (cloud) => {
      const { first, elapsed, warnings } = check(
        FIRST_BACKUP_BUDGET_MS[cloud],
        Number.POSITIVE_INFINITY,
      );
      await first.start();
      expect(first.status()).toEqual({
        state: 'failed',
        lastError: 'AccessDenied',
      });
      expect(elapsed()).toBeLessThanOrEqual(FIRST_BACKUP_BUDGET_MS[cloud]);
      expect(warnings).toEqual(['The first API database backup did not land']);
    },
  );

  it('gives GCP and Azure longer than AWS, and runs once', async () => {
    expect(FIRST_BACKUP_BUDGET_MS.GCP).toBeGreaterThan(
      FIRST_BACKUP_BUDGET_MS.AWS,
    );
    expect(FIRST_BACKUP_BUDGET_MS.Azure).toBeGreaterThan(
      FIRST_BACKUP_BUDGET_MS.GCP,
    );
    const { first, attempts } = check(FIRST_BACKUP_BUDGET_MS.AWS, 0);
    await Promise.all([first.start(), first.start()]);
    expect(attempts()).toBe(1);
  });

  it('starts the hourly timer once the first backup has settled', async () => {
    const started: string[] = [];
    const timer = {
      start: async () => {
        started.push('timer');
        return true;
      },
    };
    const landing = check(FIRST_BACKUP_BUDGET_MS.Azure, 2);
    await expect(startBackups(landing.first, timer)).resolves.toBe(true);
    expect(landing.attempts()).toBe(3);
    expect(started).toEqual(['timer']);
    // A first backup that failed still leaves the hourly timer to try.
    const never = check(FIRST_BACKUP_BUDGET_MS.AWS, Number.POSITIVE_INFINITY);
    await expect(startBackups(never.first, timer)).resolves.toBe(true);
    expect(never.first.status().state).toBe('failed');
    expect(started).toEqual(['timer', 'timer']);
    await expect(startBackups(null, timer)).resolves.toBe(true);
    expect(started).toEqual(['timer', 'timer', 'timer']);
  });
});
