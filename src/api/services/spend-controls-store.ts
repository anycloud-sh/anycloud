/**
 * Spend Controls Store
 *
 * CRUD for throttles (sliding 1h rate caps) and budgets (calendar-window
 * caps). Both are tiny lookup tables (max 2 throttles, max 6 budgets) keyed
 * by their natural dimensions — no names. Enforcement lives in the
 * provisioning scheduler (see workload-workflows/provisioning-scheduler.ts).
 */

import type { DB } from './repositories/db.js';
import {
  SESSION_BURN_SQL,
  windowedVmSpendSql,
} from './repositories/workload-spend.js';

export type Scope = 'account' | 'agent-session';
export type Period = 'day' | 'week' | 'month';

export const PERIODS: readonly Period[] = ['day', 'week', 'month'] as const;

export interface Throttle {
  scope: Scope;
  capUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface Budget {
  period: Period;
  scope: Scope;
  capUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface BlockAlertIdentity {
  kind: 'throttle' | 'budget';
  scope: Scope;
  sessionId: string | null;
  period: Period | null;
  windowResetAt: number | null;
}

export interface SpendBreakdown {
  actualUsd: number;
  estimatedUsd: number;
  totalUsd: number;
}

export interface SessionBurnRate {
  session: string;
  agent: string | null;
  sessionLabel: string | null;
  user: string | null;
  rateUsd: number;
}

export interface SessionSpendBreakdown extends SpendBreakdown {
  session: string;
  agent: string | null;
  sessionLabel: string | null;
  user: string | null;
}

export interface SpendControlsRepository {
  setThrottle(scope: Scope, capUsd: number): Promise<void>;
  listThrottles(): Promise<Throttle[]>;
  deleteThrottle(scope: Scope): Promise<boolean>;
  setBudget(period: Period, scope: Scope, capUsd: number): Promise<void>;
  listBudgets(): Promise<Budget[]>;
  deleteBudget(period: Period, scope: Scope): Promise<boolean>;
  currentBurnRate(opts: { sessionFilter?: string | null }): Promise<number>;
  computeSpend(opts: {
    windowStartMs: number;
    windowEndMs: number;
    sessionFilter?: string | null;
    nowMs?: number;
  }): Promise<SpendBreakdown>;
  /**
   * Per-session live burn rate: same SQL as `currentBurnRate`, grouped by
   * `d.session`. Surfaces one row per session under an agent-session throttle
   * in `anycloud spend show`. Rows with NULL session are omitted (those VMs
   * count against the account-wide throttle, not any per-session cap).
   */
  currentBurnRateBySession(): Promise<SessionBurnRate[]>;
  computeSpendBySession(opts: {
    windowStartMs: number;
    windowEndMs: number;
    nowMs?: number;
  }): Promise<SessionSpendBreakdown[]>;
  lastBlockAlertAt(identity: BlockAlertIdentity): Promise<number | null>;
  recordBlockAlert(identity: BlockAlertIdentity, sentAt: number): Promise<void>;
}

interface ThrottleRow {
  scope: Scope;
  cap_usd: number;
  created_at: number;
  updated_at: number;
}

interface BudgetRow {
  period: Period;
  scope: Scope;
  cap_usd: number;
  created_at: number;
  updated_at: number;
}

export class SpendControlsStore implements SpendControlsRepository {
  constructor(private readonly db: DB) {}

  async setThrottle(scope: Scope, capUsd: number): Promise<void> {
    const now = Date.now();
    await this.db.query(
      `INSERT INTO throttles (scope, cap_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET cap_usd = excluded.cap_usd, updated_at = excluded.updated_at`,
      [scope, capUsd, now, now],
    );
  }

  async listThrottles(): Promise<Throttle[]> {
    const rows = await this.db.query<ThrottleRow>(
      `SELECT scope, cap_usd, created_at, updated_at FROM throttles ORDER BY scope`,
    );
    return rows.map((r) => ({
      scope: r.scope,
      capUsd: r.cap_usd,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteThrottle(scope: Scope): Promise<boolean> {
    const before = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) as n FROM throttles WHERE scope = ?`,
      [scope],
    );
    await this.db.query(`DELETE FROM throttles WHERE scope = ?`, [scope]);
    return (before[0]?.n ?? 0) > 0;
  }

  async setBudget(period: Period, scope: Scope, capUsd: number): Promise<void> {
    const now = Date.now();
    await this.db.query(
      `INSERT INTO budgets (period, scope, cap_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(period, scope) DO UPDATE SET cap_usd = excluded.cap_usd, updated_at = excluded.updated_at`,
      [period, scope, capUsd, now, now],
    );
  }

  async listBudgets(): Promise<Budget[]> {
    const rows = await this.db.query<BudgetRow>(
      `SELECT period, scope, cap_usd, created_at, updated_at FROM budgets ORDER BY period, scope`,
    );
    return rows.map((r) => ({
      period: r.period,
      scope: r.scope,
      capUsd: r.cap_usd,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteBudget(period: Period, scope: Scope): Promise<boolean> {
    const before = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) as n FROM budgets WHERE period = ? AND scope = ?`,
      [period, scope],
    );
    await this.db.query(`DELETE FROM budgets WHERE period = ? AND scope = ?`, [
      period,
      scope,
    ]);
    return (before[0]?.n ?? 0) > 0;
  }

  /** Live hourly burn across running, priced VMs. */
  async currentBurnRate(opts: {
    sessionFilter?: string | null;
  }): Promise<number> {
    const session = opts.sessionFilter ?? null;
    const rows = await this.db.query<{ rate: number | null }>(
      session === null
        ? `SELECT COALESCE(SUM(v.price_per_hour), 0) AS rate
           FROM vms v INDEXED BY idx_vms_active
           WHERE v.ended_at IS NULL
             AND v.ip IS NOT NULL
             AND v.price_per_hour IS NOT NULL`
        : SESSION_BURN_SQL,
      session === null ? [] : [session],
    );
    return Math.max(0, rows[0]?.rate ?? 0);
  }

  /** Actual and estimated VM spend intersecting a calendar window. */
  async computeSpend(opts: {
    windowStartMs: number;
    windowEndMs: number;
    sessionFilter?: string | null;
    nowMs?: number;
  }): Promise<SpendBreakdown> {
    const { sessionFilter } = opts;
    const hasSession = sessionFilter !== undefined && sessionFilter !== null;
    const spend = windowedVmSpendSql({
      startMs: opts.windowStartMs,
      endMs: opts.windowEndMs,
      nowMs: opts.nowMs ?? Date.now(),
    });
    // Exact session checks stay workload-first because a session normally
    // has far fewer rows than the account-wide VM window. Each branch then
    // probes the workload_id VM index instead of materializing every account
    // VM first.
    const rows = await this.db.query<{
      actual_usd: number | null;
      estimated_usd: number | null;
    }>(
      `WITH ${
        hasSession
          ? `session_workloads AS (
         SELECT id
         FROM workloads
         WHERE session IS NOT NULL AND session = ?
       ),`
          : ''
      }
       overlapping_vms AS (
         ${spend.overlappingVms(
           hasSession
             ? `session_workloads scoped
         JOIN vms AS v ON v.workload_id = scoped.id`
             : undefined,
         )}
       )
       SELECT
         SUM(${spend.actualCost}) AS actual_usd,
         SUM(${spend.estimatedCost}) AS estimated_usd
       FROM overlapping_vms v`,
      hasSession ? [sessionFilter] : [],
    );

    const actualUsd = Math.max(0, rows[0]?.actual_usd ?? 0);
    const estimatedUsd = Math.max(0, rows[0]?.estimated_usd ?? 0);
    return {
      actualUsd,
      estimatedUsd,
      totalUsd: actualUsd + estimatedUsd,
    };
  }

  async currentBurnRateBySession(): Promise<SessionBurnRate[]> {
    const rows = await this.db.query<{
      session: string;
      agent: string | null;
      session_label: string | null;
      user_id: string | null;
      rate: number | null;
    }>(
      `SELECT d.session AS session, d.agent AS agent,
              MAX(d.session_label) AS session_label,
              MAX(d.user_id) AS user_id,
              COALESCE(SUM(v.price_per_hour), 0) AS rate
       FROM vms v INDEXED BY idx_vms_active
       JOIN workloads d ON d.id = v.workload_id
       WHERE v.ended_at IS NULL
         AND v.ip IS NOT NULL
         AND v.price_per_hour IS NOT NULL
         AND d.session IS NOT NULL
       GROUP BY d.session, d.agent`,
    );
    return rows.map((row) => ({
      session: row.session,
      agent: row.agent,
      sessionLabel: row.session_label,
      user: row.user_id,
      rateUsd: Math.max(0, row.rate ?? 0),
    }));
  }

  async computeSpendBySession(opts: {
    windowStartMs: number;
    windowEndMs: number;
    nowMs?: number;
  }): Promise<SessionSpendBreakdown[]> {
    const spend = windowedVmSpendSql({
      startMs: opts.windowStartMs,
      endMs: opts.windowEndMs,
      nowMs: opts.nowMs ?? Date.now(),
    });
    const rows = await this.db.query<{
      session: string;
      agent: string | null;
      session_label: string | null;
      user_id: string | null;
      actual_usd: number | null;
      estimated_usd: number | null;
    }>(
      `WITH overlapping_vms AS (
         ${spend.overlappingVms()}
       )
       SELECT
         d.session AS session,
         d.agent AS agent,
         MAX(d.session_label) AS session_label,
         MAX(d.user_id) AS user_id,
         SUM(${spend.actualCost}) AS actual_usd,
         SUM(${spend.estimatedCost}) AS estimated_usd
       FROM overlapping_vms v
       JOIN workloads d ON d.id = v.workload_id
       WHERE d.session IS NOT NULL
       GROUP BY d.session, d.agent`,
    );

    return rows.map((row) => {
      const actualUsd = Math.max(0, row.actual_usd ?? 0);
      const estimatedUsd = Math.max(0, row.estimated_usd ?? 0);
      return {
        session: row.session,
        agent: row.agent,
        sessionLabel: row.session_label,
        user: row.user_id,
        actualUsd,
        estimatedUsd,
        totalUsd: actualUsd + estimatedUsd,
      };
    });
  }

  /**
   * Timestamp of the most recent block-notification sent for a cap, or null if
   * none. The provisioning scheduler uses this to debounce: it re-notifies only
   * after the cooldown elapses while the same cap keeps blocking dispatch.
   */
  async lastBlockAlertAt(identity: BlockAlertIdentity): Promise<number | null> {
    const rows = await this.db.query<{ sent_at: number }>(
      `SELECT sent_at
       FROM spend_block_alerts
       WHERE kind = ?
         AND scope = ?
         AND session_id IS ?
         AND period IS ?
         AND window_reset_at IS ?
       ORDER BY sent_at DESC
       LIMIT 1`,
      [
        identity.kind,
        identity.scope,
        identity.sessionId,
        identity.period,
        identity.windowResetAt,
      ],
    );
    return rows[0]?.sent_at ?? null;
  }

  async recordBlockAlert(
    identity: BlockAlertIdentity,
    sentAt: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO spend_block_alerts (
         kind,
         scope,
         session_id,
         period,
         window_reset_at,
         sent_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        identity.kind,
        identity.scope,
        identity.sessionId,
        identity.period,
        identity.windowResetAt,
        sentAt,
      ],
    );
  }
}
