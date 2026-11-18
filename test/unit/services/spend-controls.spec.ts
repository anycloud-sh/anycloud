import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { randomBytes } from 'crypto';
import {
  BurnRateCache,
  blockAlertIdentity,
  calendarWindowEndMs,
  calendarWindowStartMs,
  computeSpendBySession,
  computeSpend,
  currentBurnRate,
  findBlockingCap,
  formatBlockReason,
  formatSpendBlockMessage,
  SpendCache,
  type CapBlock,
} from '../../../src/api/services/spend-controls';
import {
  getSpendControlsStore,
  getWorkloadSpendStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { walkToState } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import config from '../../../src/api/config';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { explainQueryPlan, searchesIndex } from '../helpers/query-plan';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

describe('calendar windows', () => {
  it('day starts at 00:00 UTC and ends 24h later', () => {
    const now = new Date('2026-05-24T15:30:00Z');
    expect(calendarWindowStartMs('day', now)).toBe(Date.UTC(2026, 4, 24));
    expect(calendarWindowEndMs('day', now)).toBe(Date.UTC(2026, 4, 25));
  });

  it('month starts at the 1st 00:00 UTC and ends at next 1st', () => {
    const now = new Date('2026-05-24T15:30:00Z');
    expect(calendarWindowStartMs('month', now)).toBe(Date.UTC(2026, 4, 1));
    expect(calendarWindowEndMs('month', now)).toBe(Date.UTC(2026, 5, 1));
  });

  it('week is Monday-anchored', () => {
    // 2026-05-24 is a Sunday — week start should be Monday 2026-05-18.
    const sunday = new Date('2026-05-24T12:00:00Z');
    expect(calendarWindowStartMs('week', sunday)).toBe(Date.UTC(2026, 4, 18));
    expect(calendarWindowEndMs('week', sunday)).toBe(Date.UTC(2026, 4, 25));

    // A Monday lands on its own start.
    const monday = new Date('2026-05-18T12:00:00Z');
    expect(calendarWindowStartMs('week', monday)).toBe(Date.UTC(2026, 4, 18));
    expect(calendarWindowEndMs('week', monday)).toBe(Date.UTC(2026, 4, 25));
  });
});

describe('computeSpend', () => {
  let credentialId: string;
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      ['spend-cred'],
    );
    credentialId = 'spend-cred';
  });

  async function seedWorkload(opts: {
    id: string;
    userId?: string;
    session?: string;
    vmCreatedAt: number;
    vmEndedAt: number | null;
    ip?: string | null;
    pricePerHour?: number | null;
    cost?: number | null;
  }): Promise<void> {
    await createWorkload(getDB(), {
      id: opts.id,
      userId: opts.userId ?? 'u',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
      session: opts.session,
    });
    await walkToState(opts.id, WorkloadState.Running);

    const db = getDB();
    await db.query(
      `INSERT INTO vms (workload_id, ip, cloud_id, created_at, ended_at, region, credential_id, price_per_hour, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.id,
        opts.ip === undefined ? '1.2.3.4' : opts.ip,
        `cloud-${opts.id}`,
        opts.vmCreatedAt,
        opts.vmEndedAt,
        'us-east-1',
        credentialId,
        opts.pricePerHour === undefined ? 1.0 : opts.pricePerHour,
        opts.cost ?? null,
      ],
    );
  }

  it('sums estimated cost from price_per_hour × elapsed when v.cost is null', async () => {
    const windowEnd = Date.UTC(2026, 4, 24, 12, 0, 0);
    const windowStart = windowEnd - 60 * 60 * 1000; // last 1h
    // VM ran the full hour, $1/hr → $1.00 estimated.
    await seedWorkload({
      id: 'd1',
      vmCreatedAt: windowStart,
      vmEndedAt: windowEnd,
      pricePerHour: 1.0,
    });

    const s = await computeSpend({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    expect(s.actualUsd).toBe(0);
    expect(s.estimatedUsd).toBeCloseTo(1.0, 6);
    expect(s.totalUsd).toBeCloseTo(1.0, 6);
  });

  it('uses actual v.cost prorated by the intersection when settled', async () => {
    const windowEnd = Date.UTC(2026, 4, 24, 12, 0, 0);
    const windowStart = windowEnd - 60 * 60 * 1000;
    // VM ran 2h total, half within window. cost=$10 → $5 attributed.
    await seedWorkload({
      id: 'd1',
      vmCreatedAt: windowEnd - 2 * 60 * 60 * 1000,
      vmEndedAt: windowEnd,
      pricePerHour: 5.0,
      cost: 10.0,
    });

    const s = await computeSpend({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    expect(s.actualUsd).toBeCloseTo(5.0, 6);
    expect(s.estimatedUsd).toBe(0);
  });

  it('filters by session when sessionFilter is provided', async () => {
    const windowEnd = Date.UTC(2026, 4, 24, 12, 0, 0);
    const windowStart = windowEnd - 60 * 60 * 1000;
    await seedWorkload({
      id: 'a',
      session: 'sess-A',
      vmCreatedAt: windowStart,
      vmEndedAt: windowEnd,
      pricePerHour: 2.0,
    });
    await seedWorkload({
      id: 'b',
      session: 'sess-B',
      vmCreatedAt: windowStart,
      vmEndedAt: windowEnd,
      pricePerHour: 3.0,
    });

    const all = await computeSpend({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    expect(all.totalUsd).toBeCloseTo(5.0, 6);

    const onlyA = await computeSpend({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
      sessionFilter: 'sess-A',
    });
    expect(onlyA.totalUsd).toBeCloseTo(2.0, 6);
  });

  it('excludes VMs whose lifetime does not intersect the window', async () => {
    const now = Date.UTC(2026, 4, 24, 12, 0, 0);
    // VM ran from 3h ago to 2h ago — outside the trailing 1h window.
    await seedWorkload({
      id: 'old',
      vmCreatedAt: now - 3 * 60 * 60 * 1000,
      vmEndedAt: now - 2 * 60 * 60 * 1000,
      pricePerHour: 1.0,
    });

    const s = await computeSpend({
      windowStartMs: now - 60 * 60 * 1000,
      windowEndMs: now,
    });
    expect(s.totalUsd).toBe(0);
  });

  it('keeps half-open window boundaries exact with the indexable overlap predicate', async () => {
    const windowStart = Date.UTC(2026, 4, 24, 12, 0, 0);
    const windowEnd = windowStart + 60 * 60 * 1000;
    await seedWorkload({
      id: 'ended-at-start',
      session: 'sess-boundary',
      vmCreatedAt: windowStart - 60 * 60 * 1000,
      vmEndedAt: windowStart,
      pricePerHour: 100,
    });
    await seedWorkload({
      id: 'starts-at-end',
      session: 'sess-boundary',
      vmCreatedAt: windowEnd,
      vmEndedAt: windowEnd + 60 * 60 * 1000,
      pricePerHour: 100,
    });
    await seedWorkload({
      id: 'inside',
      session: 'sess-boundary',
      vmCreatedAt: windowStart,
      vmEndedAt: windowEnd,
      pricePerHour: 2,
    });

    const all = await computeSpend({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    expect(all.totalUsd).toBeCloseTo(2, 6);

    const bySession = await computeSpendBySession({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    expect(bySession).toHaveLength(1);
    expect(bySession[0].session).toBe('sess-boundary');
    expect(bySession[0].totalUsd).toBeCloseTo(2, 6);
  });

  it('in-flight VM is charged up to now, not through end-of-window', async () => {
    // Regression: COALESCE(v.ended_at, windowEndMs) charges in-flight VMs as
    // if they had already run through the end of the calendar window.
    // 30 minutes of real runtime at $10/hr should be ~$5, not ~$10 × (hours
    // until midnight UTC + 0.5).
    const now = Date.now();
    await seedWorkload({
      id: 'in-flight',
      vmCreatedAt: now - 30 * 60 * 1000,
      vmEndedAt: null,
      pricePerHour: 10,
    });

    const windowStartMs = calendarWindowStartMs('day', new Date(now));
    const windowEndMs = calendarWindowEndMs('day', new Date(now));
    const s = await computeSpend({ windowStartMs, windowEndMs });

    // Real elapsed within window is ≤ 30 minutes since VM creation; cap at $6
    // (one minute of slack). Bug yields $10 × hours-remaining-in-day + $5.
    expect(s.estimatedUsd).toBeLessThan(6);
  });

  it('regroups live and ended branches without billing failed attempts or future live time', async () => {
    const windowStartMs = Date.UTC(2026, 4, 24, 12, 0, 0);
    const nowMs = windowStartMs + 30 * 60 * 1000;
    const windowEndMs = windowStartMs + 60 * 60 * 1000;
    await seedWorkload({
      id: 'split-ended',
      session: 'split-session',
      vmCreatedAt: windowStartMs,
      vmEndedAt: nowMs,
      pricePerHour: 2,
    });
    await seedWorkload({
      id: 'split-live',
      session: 'split-session',
      vmCreatedAt: windowStartMs,
      vmEndedAt: null,
      pricePerHour: 2,
    });
    await seedWorkload({
      id: 'split-placeholder',
      session: 'split-session',
      vmCreatedAt: windowStartMs,
      vmEndedAt: null,
      ip: null,
      pricePerHour: 100,
    });
    await seedWorkload({
      id: 'split-future',
      session: 'split-session',
      vmCreatedAt: nowMs + 1,
      vmEndedAt: null,
      pricePerHour: 100,
    });

    const account = await computeSpend({
      windowStartMs,
      windowEndMs,
      nowMs,
    });
    const [session] = await computeSpendBySession({
      windowStartMs,
      windowEndMs,
      nowMs,
    });

    expect(account.totalUsd).toBeCloseTo(2, 6);
    expect(session.session).toBe('split-session');
    expect(session.totalUsd).toBeCloseTo(2, 6);
  });

  it('carries the account that ran each session without splitting its row', async () => {
    const windowEnd = Date.UTC(2026, 4, 24, 12, 0, 0);
    const windowStart = windowEnd - 60 * 60 * 1000;
    await seedWorkload({
      id: 'owned-a',
      userId: 'teammate',
      session: 'shared-session',
      vmCreatedAt: windowStart,
      vmEndedAt: windowEnd,
      pricePerHour: 1,
    });
    await seedWorkload({
      id: 'owned-b',
      userId: 'teammate',
      session: 'shared-session',
      vmCreatedAt: windowStart,
      vmEndedAt: windowEnd,
      pricePerHour: 1,
    });

    const rows = await computeSpendBySession({
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });

    // One session, one row — the owner rides along without changing the
    // grouping the cap arithmetic depends on.
    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBe('teammate');
    expect(rows[0].totalUsd).toBeCloseTo(2, 6);
  });

  it.each([
    ['ends now', 0],
    ['ends after now', 2 * 60 * 60 * 1000],
  ])(
    "matches the cost report's per-user costs over live, reconciled and unreconciled VMs when the window %s",
    async (_label, pastNowMs) => {
      const nowMs = Date.UTC(2026, 4, 24, 12, 0, 0);
      const windowStartMs = nowMs - 60 * 60 * 1000;
      const windowEndMs = nowMs + pastNowMs;
      // 30 live minutes at $2/h: $1.
      await seedWorkload({
        id: 'live',
        userId: 'alice',
        vmCreatedAt: nowMs - 30 * 60 * 1000,
        vmEndedAt: null,
        pricePerHour: 2,
      });
      // Half of a reconciled $3 lifetime falls in the window: $1.50.
      await seedWorkload({
        id: 'reconciled',
        userId: 'alice',
        vmCreatedAt: nowMs - 90 * 60 * 1000,
        vmEndedAt: nowMs - 30 * 60 * 1000,
        pricePerHour: 100,
        cost: 3,
      });
      // 15 unreconciled minutes in the window at $4/h: $1.
      await seedWorkload({
        id: 'unreconciled',
        userId: 'bob',
        vmCreatedAt: nowMs - 2 * 60 * 60 * 1000,
        vmEndedAt: nowMs - 45 * 60 * 1000,
        pricePerHour: 4,
      });

      const cap = await computeSpend({ windowStartMs, windowEndMs, nowMs });
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      let report;
      try {
        report = await getWorkloadSpendStore().getCostReportInWindow(
          { kind: 'api' },
          windowStartMs,
          windowEndMs,
        );
      } finally {
        vi.restoreAllMocks();
      }

      expect(cap.totalUsd).toBeCloseTo(3.5, 6);
      expect(
        Object.values(report.byUser).reduce((sum, user) => sum + user.cost, 0),
      ).toBeCloseTo(cap.totalUsd, 6);
    },
  );

  it('windowed spend searches its intended indexes instead of scanning them', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { rmSync } = await import('fs');

    const dbFile = join(tmpdir(), `anycloud-spend-idx-${process.pid}.db`);
    rmSync(dbFile, { force: true });
    vi.stubEnv('SQLITE_PATH', dbFile);
    resetPersistence();
    try {
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
        ['spend-cred'],
      );
      const querySpy = vi.spyOn(getDB(), 'query');
      const windowStartMs = Date.UTC(2026, 4, 24, 12, 0, 0);
      const windowEndMs = Date.UTC(2026, 4, 24, 13, 0, 0);
      await computeSpend({ windowStartMs, windowEndMs, nowMs: windowEndMs });
      await computeSpend({
        windowStartMs,
        windowEndMs,
        nowMs: windowEndMs,
        sessionFilter: 'indexed-session',
      });
      await computeSpendBySession({
        windowStartMs,
        windowEndMs,
        nowMs: windowEndMs,
      });
      const calls = querySpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('overlapping_vms AS (') &&
          call[0].includes('actual_usd'),
      );
      expect(calls).toHaveLength(3);

      const accountPlan = explainQueryPlan(
        dbFile,
        calls[0][0],
        calls[0][1] ?? [],
      );
      expect(searchesIndex(accountPlan, 'idx_vms_spend_window')).toBe(true);
      expect(
        accountPlan.filter(
          (detail) =>
            detail.includes('SEARCH') &&
            detail.includes('idx_vms_spend_window'),
        ),
      ).toHaveLength(2);

      const exactSessionPlan = explainQueryPlan(
        dbFile,
        calls[1][0],
        calls[1][1] ?? [],
      );
      expect(searchesIndex(exactSessionPlan, 'idx_workloads_session')).toBe(
        true,
      );
      expect(searchesIndex(exactSessionPlan, 'idx_vms_workload_id')).toBe(true);
      expect(
        exactSessionPlan.some((detail) =>
          detail.includes('SCAN v USING INDEX idx_vms_workload_id'),
        ),
      ).toBe(false);

      const groupedPlan = explainQueryPlan(
        dbFile,
        calls[2][0],
        calls[2][1] ?? [],
      );
      expect(searchesIndex(groupedPlan, 'idx_vms_spend_window')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      resetPersistence();
      rmSync(dbFile, { force: true });
    }
  });
});

describe('findBlockingCap', () => {
  let credentialId: string;
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      ['c1'],
    );
    credentialId = 'c1';
  });

  async function seedRunning(
    id: string,
    pricePerHour: number,
    session?: string,
  ): Promise<void> {
    const now = Date.now();
    await createWorkload(getDB(), {
      id,
      userId: 'u',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
      session,
    });
    await walkToState(id, WorkloadState.Running);
    // In-flight VM (ended_at IS NULL) — contributes pricePerHour to burn rate.
    await getDB().query(
      `INSERT INTO vms (workload_id, ip, cloud_id, created_at, region, credential_id, price_per_hour)
       VALUES (?, '1.2.3.4', ?, ?, 'us-east-1', ?, ?)`,
      [id, `cloud-${id}`, now - 60 * 1000, credentialId, pricePerHour],
    );
  }

  function caches() {
    return { burn: new BurnRateCache(), spend: new SpendCache() };
  }

  it('blocks when current burn rate alone meets the cap', async () => {
    await seedRunning('hot', 15);
    await getSpendControlsStore().setThrottle('account', 10);
    const throttles = await getSpendControlsStore().listThrottles();

    const block = await findBlockingCap(
      { session: null },
      throttles,
      [],
      caches(),
    );
    expect(block?.kind).toBe('throttle');
    expect(block?.scope).toBe('account');
    expect(block?.capUsd).toBe(10);
    expect(block?.spentUsd).toBeCloseTo(15, 6);
  });

  it('blocks when candidate pre-charge pushes burn rate over cap', async () => {
    await seedRunning('warm', 7); // current burn $7/hr
    await getSpendControlsStore().setThrottle('account', 10);
    const throttles = await getSpendControlsStore().listThrottles();

    // Cheap candidate fits.
    const cleared = await findBlockingCap(
      { session: null, hourlyUsd: 2 },
      throttles,
      [],
      caches(),
    );
    expect(cleared).toBeNull();

    // Expensive candidate would push burn to $7 + $5 = $12 ≥ $10 cap → blocked.
    const blocked = await findBlockingCap(
      { session: null, hourlyUsd: 5 },
      throttles,
      [],
      caches(),
    );
    expect(blocked?.kind).toBe('throttle');
    expect(blocked?.spentUsd).toBeCloseTo(12, 6);
    expect(formatBlockReason(blocked!)).toBe(
      'blocked by throttle: projected rate $12.00/hr ≥ cap $10/hr',
    );
  });

  it('burst within one tick: pre-charge serializes candidates', async () => {
    await getSpendControlsStore().setThrottle('account', 20);
    const throttles = await getSpendControlsStore().listThrottles();
    const sharedCaches = caches();

    // No running VMs → burn rate $0.
    const first = await findBlockingCap(
      { session: null, hourlyUsd: 8 },
      throttles,
      [],
      sharedCaches,
    );
    expect(first).toBeNull(); // cache now $8

    const second = await findBlockingCap(
      { session: null, hourlyUsd: 8 },
      throttles,
      [],
      sharedCaches,
    );
    expect(second).toBeNull(); // cache now $16

    const third = await findBlockingCap(
      { session: null, hourlyUsd: 8 },
      throttles,
      [],
      sharedCaches,
    );
    expect(third?.kind).toBe('throttle'); // $16 + $8 = $24 ≥ $20
  });

  it('instantaneous: ending a VM drops the burn rate immediately', async () => {
    await seedRunning('big', 50);
    await getSpendControlsStore().setThrottle('account', 20);
    const throttles = await getSpendControlsStore().listThrottles();

    // While running, the candidate is blocked.
    const beforeEnd = await findBlockingCap(
      { session: null, hourlyUsd: 5 },
      throttles,
      [],
      caches(),
    );
    expect(beforeEnd?.kind).toBe('throttle');

    // End the VM — burn rate drops to 0 right away (no trailing-window ghost).
    await getDB().query(`UPDATE vms SET ended_at = ? WHERE workload_id = ?`, [
      Date.now(),
      'big',
    ]);

    const afterEnd = await findBlockingCap(
      { session: null, hourlyUsd: 5 },
      throttles,
      [],
      caches(),
    );
    expect(afterEnd).toBeNull();
  });

  it('agent-session throttle only sums VMs with matching session', async () => {
    await seedRunning('sA', 15, 'sess-A');
    await seedRunning('sB', 4, 'sess-B');
    await getSpendControlsStore().setThrottle('agent-session', 10);
    const throttles = await getSpendControlsStore().listThrottles();

    const blockA = await findBlockingCap(
      { session: 'sess-A' },
      throttles,
      [],
      caches(),
    );
    expect(blockA?.kind).toBe('throttle');
    expect(blockA?.scope).toBe('agent-session');

    const blockB = await findBlockingCap(
      { session: 'sess-B' },
      throttles,
      [],
      caches(),
    );
    expect(blockB).toBeNull();
  });

  it('skips agent-session caps for candidates with no session', async () => {
    await seedRunning('sA', 30, 'sess-A');
    await getSpendControlsStore().setThrottle('agent-session', 10);
    const throttles = await getSpendControlsStore().listThrottles();

    const block = await findBlockingCap(
      { session: null }, // interactive submit
      throttles,
      [],
      caches(),
    );
    expect(block).toBeNull();
  });

  it('concurrent candidates respect the throttle cap (no burst overshoot)', async () => {
    // Regression: BurnRateCache.charge() commits only after each candidate's
    // cap check returns, so under Promise.allSettled (how the scheduler
    // invokes findBlockingCap) concurrent candidates can read the same
    // pre-burst rate and all dispatch.
    await getSpendControlsStore().setThrottle('account', 20);
    const throttles = await getSpendControlsStore().listThrottles();
    const sharedCaches = caches();

    // No running VMs → burn rate $0. Three concurrent $8/hr candidates
    // against a $20/hr cap: at most two should clear ($16 ≤ $20), the third
    // must block ($16 + $8 = $24 ≥ $20).
    const results = await Promise.all([
      findBlockingCap(
        { session: null, hourlyUsd: 8 },
        throttles,
        [],
        sharedCaches,
      ),
      findBlockingCap(
        { session: null, hourlyUsd: 8 },
        throttles,
        [],
        sharedCaches,
      ),
      findBlockingCap(
        { session: null, hourlyUsd: 8 },
        throttles,
        [],
        sharedCaches,
      ),
    ]);
    const cleared = results.filter((r) => r === null).length;
    // Bug: all three see $0 and clear (totalling $24/hr, over cap).
    expect(cleared).toBeLessThanOrEqual(2);
  });

  it('budget blocks when calendar-window spend exceeds cap', async () => {
    // Pin the clock to mid-day UTC. The daily window resets at 00:00 UTC, so the
    // retro-dated 30-min VM lifetime only partly overlaps "today" when the suite
    // runs in the first 30 min after midnight, dropping spend under the cap
    // (flaky). Fake only Date so real timers keep async DB work flowing.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-24T12:00:00Z'));
    try {
      await seedRunning('big', 200); // $200/hr × 30m in window → $100 > $50 cap
      // Retro-date the VM so a deterministic 30 min of spend falls in the window.
      await getDB().query(
        `UPDATE vms SET created_at = ? WHERE workload_id = ?`,
        [Date.now() - 30 * 60 * 1000, 'big'],
      );
      await getSpendControlsStore().setBudget('day', 'account', 50);
      const budgets = await getSpendControlsStore().listBudgets();

      const block = await findBlockingCap(
        { session: null },
        [],
        budgets,
        caches(),
      );
      expect(block?.kind).toBe('budget');
      expect(block?.period).toBe('day');
      expect(block?.capUsd).toBe(50);
      expect(block?.resumesAtMs).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('currentBurnRate', () => {
  let credentialId: string;
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      ['burn-cred'],
    );
    credentialId = 'burn-cred';
  });

  async function seedVm(opts: {
    id: string;
    session?: string;
    pricePerHour: number | null;
    endedAt?: number | null;
    ip?: string | null;
  }): Promise<void> {
    await createWorkload(getDB(), {
      id: opts.id,
      userId: 'u',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
      session: opts.session,
    });
    await walkToState(opts.id, WorkloadState.Running);
    await getDB().query(
      `INSERT INTO vms (workload_id, ip, cloud_id, created_at, ended_at, region, credential_id, price_per_hour)
       VALUES (?, ?, ?, ?, ?, 'us-east-1', ?, ?)`,
      [
        opts.id,
        opts.ip === undefined ? '1.2.3.4' : opts.ip,
        `cloud-${opts.id}`,
        Date.now() - 60 * 1000,
        opts.endedAt ?? null,
        credentialId,
        opts.pricePerHour,
      ],
    );
  }

  it('sums price_per_hour across in-flight VMs', async () => {
    await seedVm({ id: 'a', pricePerHour: 3 });
    await seedVm({ id: 'b', pricePerHour: 5 });
    expect(await currentBurnRate({})).toBeCloseTo(8, 6);
  });

  it('excludes ended VMs', async () => {
    await seedVm({ id: 'live', pricePerHour: 4 });
    await seedVm({ id: 'dead', pricePerHour: 100, endedAt: Date.now() });
    expect(await currentBurnRate({})).toBeCloseTo(4, 6);
  });

  it('excludes failed-attempt placeholders (ip IS NULL)', async () => {
    await seedVm({ id: 'real', pricePerHour: 2 });
    await seedVm({ id: 'ghost', pricePerHour: 999, ip: null });
    expect(await currentBurnRate({})).toBeCloseTo(2, 6);
  });

  it('filters by session', async () => {
    await seedVm({ id: 'a', pricePerHour: 3, session: 'sess-A' });
    await seedVm({ id: 'b', pricePerHour: 5, session: 'sess-B' });
    expect(await currentBurnRate({ sessionFilter: 'sess-A' })).toBeCloseTo(
      3,
      6,
    );
  });

  it('currentBurnRate uses the live-VM partial index', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { rmSync } = await import('fs');

    const dbFile = join(tmpdir(), `anycloud-burn-idx-${process.pid}.db`);
    rmSync(dbFile, { force: true });
    vi.stubEnv('SQLITE_PATH', dbFile);
    resetPersistence();
    try {
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
        ['burn-cred'],
      );
      const querySpy = vi.spyOn(getDB(), 'query');
      await currentBurnRate({});
      const call = querySpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' && c[0].includes('SUM(v.price_per_hour)'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call!;

      {
        const details = explainQueryPlan(dbFile, sql, params ?? []).join('\n');
        expect(details).toContain('idx_vms_active');
      }
    } finally {
      vi.unstubAllEnvs();
      resetPersistence();
      rmSync(dbFile, { force: true });
    }
  });
});

describe('blockAlertIdentity', () => {
  it('distinguishes throttle vs budget on the same scope', () => {
    const throttle: CapBlock = {
      kind: 'throttle',
      scope: 'account',
      capUsd: 10,
      spentUsd: 12,
    };
    const budget: CapBlock = {
      kind: 'budget',
      scope: 'account',
      period: 'day',
      capUsd: 50,
      spentUsd: 60,
      resumesAtMs: 2000,
    };
    expect(blockAlertIdentity(throttle)).toEqual({
      kind: 'throttle',
      scope: 'account',
      sessionId: null,
      period: null,
      windowResetAt: null,
    });
    expect(blockAlertIdentity(budget)).toEqual({
      kind: 'budget',
      scope: 'account',
      sessionId: null,
      period: 'day',
      windowResetAt: 2000,
    });
    expect(blockAlertIdentity(throttle)).not.toEqual(
      blockAlertIdentity(budget),
    );
  });

  it('keys per session, per period, and per budget reset boundary', () => {
    const a: CapBlock = {
      kind: 'budget',
      scope: 'agent-session',
      period: 'week',
      sessionId: 'sess-A',
      capUsd: 20,
      spentUsd: 25,
      resumesAtMs: 2000,
    };
    const b: CapBlock = { ...a, sessionId: 'sess-B' };
    const c: CapBlock = { ...a, period: 'month' };
    const d: CapBlock = { ...a, resumesAtMs: 3000 };
    expect(blockAlertIdentity(a)).toEqual({
      kind: 'budget',
      scope: 'agent-session',
      sessionId: 'sess-A',
      period: 'week',
      windowResetAt: 2000,
    });
    expect(blockAlertIdentity(a)).not.toEqual(blockAlertIdentity(b));
    expect(blockAlertIdentity(a)).not.toEqual(blockAlertIdentity(c));
    expect(blockAlertIdentity(a)).not.toEqual(blockAlertIdentity(d));
  });
});

describe('formatSpendBlockMessage', () => {
  it('leads with a waiting-on-cap header and embeds the block reason', () => {
    const msg = formatSpendBlockMessage({
      kind: 'budget',
      scope: 'account',
      period: 'day',
      capUsd: 50,
      spentUsd: 60,
      resumesAtMs: Date.UTC(2026, 4, 31, 0, 0),
    });
    const lines = msg.split('\n');
    expect(lines[0]).toBe('*anycloud: workloads waiting on spend cap*');
    expect(lines[1]).toContain('blocked by daily budget');
    expect(lines[1]).toContain('$60.00 / $50');
  });

  const accountBlock = {
    kind: 'budget' as const,
    scope: 'account' as const,
    period: 'day' as const,
    capUsd: 50,
    spentUsd: 60,
    resumesAtMs: Date.UTC(2026, 4, 31, 0, 0),
  };

  it('names who is waiting and whose spend filled the cap', () => {
    const msg = formatSpendBlockMessage(accountBlock, {
      blockedUsers: ['octocat', 'teammate'],
      spendByUser: [
        { username: 'teammate', costUsd: 48.5 },
        { username: 'octocat', costUsd: 11.5 },
      ],
    });

    expect(msg.split('\n')).toEqual([
      '*anycloud: workloads waiting on spend cap*',
      expect.stringContaining('blocked by daily budget'),
      'waiting: octocat, teammate',
      'spend by user: teammate $48.50, octocat $11.50',
    ]);
  });

  it('names a single waiter when a different account filled the cap', () => {
    const msg = formatSpendBlockMessage(accountBlock, {
      blockedUsers: ['teammate'],
      spendByUser: [{ username: 'octocat', costUsd: 60 }],
    });

    expect(msg.split('\n')).toEqual([
      '*anycloud: workloads waiting on spend cap*',
      expect.stringContaining('blocked by daily budget'),
      'waiting: teammate',
      'spend by user: octocat $60.00',
    ]);
  });

  it('names multiple throttle waiters without a window spend breakdown', () => {
    const msg = formatSpendBlockMessage(
      {
        kind: 'throttle',
        scope: 'account',
        capUsd: 50,
        spentUsd: 60,
      },
      {
        blockedUsers: ['octocat', 'teammate'],
        spendByUser: [],
      },
    );

    expect(msg).toContain('waiting: octocat, teammate');
    expect(msg).not.toContain('spend by user:');
  });

  it('stays a two-line message when only one account is involved', () => {
    // A solo API gains nothing from naming its only user twice.
    const msg = formatSpendBlockMessage(accountBlock, {
      blockedUsers: ['octocat'],
      spendByUser: [{ username: 'octocat', costUsd: 60 }],
    });

    expect(msg.split('\n')).toHaveLength(2);
    expect(msg).not.toContain('waiting:');
    expect(msg).not.toContain('spend by user:');
  });

  it('adds thousands separators to spend and cap amounts', () => {
    const msg = formatSpendBlockMessage({
      kind: 'budget',
      scope: 'account',
      period: 'month',
      capUsd: 50_000,
      spentUsd: 60_000.5,
      resumesAtMs: Date.UTC(2026, 5, 1, 0, 0),
    });

    expect(msg).toContain('spent $60,000.50 / $50,000');
  });
});
