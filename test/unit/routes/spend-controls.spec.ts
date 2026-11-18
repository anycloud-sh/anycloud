import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { callApi } from '../helpers/api-test-helper';
import {
  getSpendControlsStore,
  resetPersistence,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { walkToState } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import config from '../../../src/api/config';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { runProvisioningSchedulerOnce } from '../../../src/api/services/monitor';
import {
  encryptCredential,
  hashCredential,
} from '../../../src/api/services/cloud-config';
import { TEST_LAMBDA_CRED } from '../helpers/fixtures';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

// The scheduler kicks off real deploy() calls; mock the cloud side so the
// in-process server never touches a real provider.
vi.mock(
  '../../../src/api/services/workload-workflows/vm-host-startup',
  async (importActual) => {
    const actual =
      await importActual<
        typeof import('../../../src/api/services/workload-workflows/vm-host-startup')
      >();
    return {
      ...actual,
      deploy: vi.fn().mockResolvedValue(undefined),
    };
  },
);

// Pin candidate pricing to $5/hr regardless of catalog state — lets the
// burst-serialization test below assert exact behavior without depending on
// the real catalog load.
vi.mock('../../../src/shared/catalog/index.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/shared/catalog/index.js')>();
  return {
    ...actual,
    resolveWorkloadPrice: vi.fn().mockReturnValue(5),
  };
});

const AUTH = { Authorization: 'Bearer mock-github-token' };

function putThrottle(scope: string, capUsd: unknown): Promise<Response> {
  return callApi(
    `http://example.com/v1/spend/throttles/${encodeURIComponent(scope)}`,
    {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capUsd }),
    },
  );
}

function putBudget(
  period: string,
  scope: string,
  capUsd: unknown,
): Promise<Response> {
  return callApi(
    `http://example.com/v1/spend/budgets/${encodeURIComponent(period)}/${encodeURIComponent(scope)}`,
    {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capUsd }),
    },
  );
}

describe('spend-controls HTTP', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
  });

  describe('throttles', () => {
    it('GET returns empty entries and zero account burn rate', async () => {
      const res = await callApi('http://example.com/v1/spend/throttles', {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual([]);
      expect(body.burnRate.account.currentUsd).toBe(0);
    });

    it('repeated PUT converges on one account throttle', async () => {
      const first = await putThrottle('account', 20);
      const replay = await putThrottle('account', 20);
      expect(first.status).toBe(204);
      expect(replay.status).toBe(204);

      const get = await callApi('http://example.com/v1/spend/throttles', {
        headers: AUTH,
      });
      const body = await get.json();
      expect(body.entries).toEqual([
        expect.objectContaining({ scope: 'account', capUsd: 20 }),
      ]);
    });

    it('PUT with invalid scope → 400', async () => {
      const res = await putThrottle('bogus', 20);
      expect(res.status).toBe(400);
    });

    it('PUT with non-positive capUsd → 400', async () => {
      for (const capUsd of [0, -5, 'abc']) {
        const res = await putThrottle('account', capUsd);
        expect(res.status).toBe(400);
      }
    });

    it('repeated DELETE leaves the throttle absent', async () => {
      await getSpendControlsStore().setThrottle('account', 20);
      const first = await callApi(
        'http://example.com/v1/spend/throttles/account',
        { method: 'DELETE', headers: AUTH },
      );
      const replay = await callApi(
        'http://example.com/v1/spend/throttles/account',
        { method: 'DELETE', headers: AUTH },
      );
      expect(first.status).toBe(204);
      expect(replay.status).toBe(204);
      const after = await getSpendControlsStore().listThrottles();
      expect(after).toEqual([]);
    });

    it('GET without auth → 401', async () => {
      const res = await callApi('http://example.com/v1/spend/throttles');
      expect(res.status).toBe(401);
    });
  });

  describe('budgets', () => {
    it('repeated PUT converges on one (period, scope) budget', async () => {
      const first = await putBudget('day', 'account', 100);
      const replay = await putBudget('day', 'account', 100);
      expect(first.status).toBe(204);
      expect(replay.status).toBe(204);

      const get = await callApi('http://example.com/v1/spend/budgets', {
        headers: AUTH,
      });
      const body = await get.json();
      expect(body.entries).toEqual([
        expect.objectContaining({
          period: 'day',
          scope: 'account',
          capUsd: 100,
        }),
      ]);
      // Spend always includes all three periods so the CLI show output is
      // consistent regardless of which budgets are configured.
      expect(
        body.spend.map((s: { period: string }) => s.period).sort(),
      ).toEqual(['day', 'month', 'week']);
    });

    it('PUT with invalid period → 400', async () => {
      const res = await putBudget('yearly', 'account', 100);
      expect(res.status).toBe(400);
    });

    it('repeated DELETE leaves the budget absent', async () => {
      await getSpendControlsStore().setBudget('day', 'account', 50);
      const first = await callApi(
        'http://example.com/v1/spend/budgets/day/account',
        { method: 'DELETE', headers: AUTH },
      );
      const replay = await callApi(
        'http://example.com/v1/spend/budgets/day/account',
        { method: 'DELETE', headers: AUTH },
      );
      expect(first.status).toBe(204);
      expect(replay.status).toBe(204);
      expect(await getSpendControlsStore().listBudgets()).toEqual([]);
    });

    it('agentSessionCount only appears when an agent-session budget exists', async () => {
      // With only an account-wide budget, the spend rows should omit it.
      await getSpendControlsStore().setBudget('day', 'account', 100);
      let res = await callApi('http://example.com/v1/spend/budgets', {
        headers: AUTH,
      });
      let body = await res.json();
      const day = body.spend.find(
        (s: { period: string }) => s.period === 'day',
      );
      expect(day.agentSessionCount).toBeUndefined();

      // Add an agent-session budget — now the count shows up.
      await getSpendControlsStore().setBudget('day', 'agent-session', 50);
      res = await callApi('http://example.com/v1/spend/budgets', {
        headers: AUTH,
      });
      body = await res.json();
      const day2 = body.spend.find(
        (s: { period: string }) => s.period === 'day',
      );
      expect(day2.agentSessionCount).toBe(0); // no workloads yet
    });
  });

  describe('per-session breakdown', () => {
    let credentialId: string;
    let sshPrivateKey: string;

    beforeAll(async () => {
      ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
    });

    beforeEach(async () => {
      resetPersistence();
      const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
      credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_LAMBDA_CRED),
        encryptedCred,
        CloudType.Lambda,
      );
    });

    async function seedRunningWithSession(
      id: string,
      pricePerHour: number,
      session: string,
      agent: string,
      sessionLabel?: string,
    ): Promise<void> {
      const now = Date.now();
      await createWorkload(getDB(), {
        id,
        userId: 'u',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a10',
        spot: false,
        dockerCommand: 'docker run alpine',
        sshPrivateKey,
        credentialId,
        session,
        agent,
        sessionLabel,
      });
      await walkToState(id, WorkloadState.Running);
      await getDB().query(
        `INSERT INTO vms (workload_id, ip, cloud_id, created_at, region, credential_id, price_per_hour)
         VALUES (?, '1.2.3.4', ?, ?, 'us-east-1', ?, ?)`,
        [id, `vm-${id}`, now - 30 * 60 * 1000, credentialId, pricePerHour],
      );
    }

    it('GET /v1/spend/throttles includes burnRate.sessions when agent-session cap is set', async () => {
      await getSpendControlsStore().setThrottle('agent-session', 100);
      await seedRunningWithSession('a1', 20, 'claude-abc', 'claude');
      await seedRunningWithSession('a2', 5, 'codex-xyz', 'codex');

      const res = await callApi('http://example.com/v1/spend/throttles', {
        headers: AUTH,
      });
      const body = await res.json();
      expect(body.burnRate.sessions).toBeDefined();
      const bySession = new Map<string, { rateUsd: number; agent: string }>(
        body.burnRate.sessions.map(
          (s: { session: string; rateUsd: number; agent: string }) => [
            s.session,
            { rateUsd: s.rateUsd, agent: s.agent },
          ],
        ),
      );
      expect(bySession.get('claude-abc')).toEqual({
        rateUsd: 20,
        agent: 'claude',
      });
      expect(bySession.get('codex-xyz')).toEqual({
        rateUsd: 5,
        agent: 'codex',
      });
    });

    it('GET /v1/spend/throttles surfaces sessionLabel in burnRate.sessions', async () => {
      await getSpendControlsStore().setThrottle('agent-session', 100);
      await seedRunningWithSession(
        'a1',
        20,
        'claude-abc',
        'claude',
        'Readable title',
      );

      const res = await callApi('http://example.com/v1/spend/throttles', {
        headers: AUTH,
      });
      const body = await res.json();
      const row = body.burnRate.sessions.find(
        (s: { session: string }) => s.session === 'claude-abc',
      );
      expect(row.sessionLabel).toBe('Readable title');
    });

    it('GET /v1/spend/throttles omits burnRate.sessions when no agent-session cap is set', async () => {
      await getSpendControlsStore().setThrottle('account', 100);
      await seedRunningWithSession('a1', 20, 'claude-abc', 'claude');

      const res = await callApi('http://example.com/v1/spend/throttles', {
        headers: AUTH,
      });
      const body = await res.json();
      expect(body.burnRate.sessions).toBeUndefined();
    });

    it('GET /v1/spend/budgets includes spend[].sessions per period when agent-session cap is set', async () => {
      await getSpendControlsStore().setBudget('day', 'agent-session', 500);
      await seedRunningWithSession('b1', 200, 'claude-abc', 'claude');
      await seedRunningWithSession('b2', 100, 'codex-xyz', 'codex');

      const res = await callApi('http://example.com/v1/spend/budgets', {
        headers: AUTH,
      });
      const body = await res.json();
      const day = body.spend.find(
        (s: { period: string }) => s.period === 'day',
      );
      expect(day.sessions).toBeDefined();
      expect(day.agentSessionCount).toBe(2);
      const bySession = new Map<string, { totalUsd: number; agent: string }>(
        day.sessions.map(
          (s: { session: string; totalUsd: number; agent: string }) => [
            s.session,
            { totalUsd: s.totalUsd, agent: s.agent },
          ],
        ),
      );
      // Each VM has been running for 30 min → expect ~half price_per_hour in spend.
      expect(bySession.get('claude-abc')?.agent).toBe('claude');
      expect(bySession.get('claude-abc')?.totalUsd).toBeGreaterThan(0);
      expect(bySession.get('codex-xyz')?.agent).toBe('codex');
      expect(bySession.get('codex-xyz')?.totalUsd).toBeGreaterThan(0);
      // Claude's $200/hr VM spent more than Codex's $100/hr VM.
      expect(bySession.get('claude-abc')!.totalUsd).toBeGreaterThan(
        bySession.get('codex-xyz')!.totalUsd,
      );
    });
  });

  // End-to-end: blocked queued workload → raise cap → dispatched.
  // Uses the real scheduler and real DB; deploy() is mocked so nothing
  // actually contacts a cloud.
  describe('end-to-end dispatch flow', () => {
    let credentialId: string;
    let sshPrivateKey: string;

    beforeAll(async () => {
      ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
    });

    beforeEach(async () => {
      resetPersistence();
      // Real encrypted credential so resolveProvisioningConfig() can deserialize
      // it during scheduler dispatch (Lambda has no region/zone gating, which
      // keeps the test focused on the spend-controls gate).
      const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
      credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_LAMBDA_CRED),
        encryptedCred,
        CloudType.Lambda,
      );
    });

    async function seedRunningWithSpend(
      id: string,
      pricePerHour: number,
      attribution?: { session: string; agent: string },
    ): Promise<void> {
      const now = Date.now();
      await createWorkload(getDB(), {
        id,
        userId: 'u',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a10',
        spot: false,
        dockerCommand: 'docker run alpine',
        sshPrivateKey,
        credentialId,
        ...(attribution && {
          session: attribution.session,
          agent: attribution.agent,
        }),
      });
      await walkToState(id, WorkloadState.Running);
      await getDB().query(
        `INSERT INTO vms (workload_id, ip, cloud_id, created_at, region, credential_id, price_per_hour)
         VALUES (?, '1.2.3.4', ?, ?, 'us-east-1', ?, ?)`,
        [id, `vm-${id}`, now - 30 * 60 * 1000, credentialId, pricePerHour],
      );
    }

    async function seedQueued(id: string): Promise<void> {
      await createWorkload(getDB(), {
        id,
        userId: 'u',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a10',
        spot: false,
        dockerCommand: 'docker run alpine',
        sshPrivateKey,
        credentialId,
      });
    }

    it('budget block over HTTP → raise via HTTP → dispatches on next tick', async () => {
      // Pin the clock to mid-day UTC. The daily budget window resets at 00:00
      // UTC, so the retro-dated 30-min VM spend only partly overlaps "today"
      // when this runs in the first 30 min after midnight, dropping under the
      // cap and dispatching instead of blocking (flaky). Fake only Date so the
      // real timers the scheduler relies on keep working.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-05-24T12:00:00Z'));
      try {
        // Seed: $100 spent in last 30m.
        await seedRunningWithSpend('big-spender', 200);

        // Set a $50/day budget over HTTP.
        const budget = await putBudget('day', 'account', 50);
        expect(budget.status).toBe(204);

        // Queue a new workload + run the scheduler.
        await seedQueued('blocked');
        await runProvisioningSchedulerOnce();

        const store = queries();
        let d = await store.getWorkload('blocked');
        expect(d?.state).toBe(WorkloadState.Queued);

        const events = await eventLog().getWorkloadEvents('blocked');
        const last = events[events.length - 1];
        expect(JSON.parse(last.metadata!).message).toContain('daily budget');

        // Raise the cap over HTTP, run scheduler again — should dispatch.
        const raise = await putBudget('day', 'account', 10_000);
        expect(raise.status).toBe(204);

        await runProvisioningSchedulerOnce();
        d = await store.getWorkload('blocked');
        expect(d?.state).toBe(WorkloadState.Provisioning);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throttle block over HTTP → end running VM → dispatches on next tick', async () => {
      // Seed: a $200/hr VM is in-flight → burn rate $200/hr.
      await seedRunningWithSpend('big-burner', 200);

      // Set an account throttle at $50/hr.
      const throttle = await putThrottle('account', 50);
      expect(throttle.status).toBe(204);

      // Queue a new candidate; scheduler must block it on the throttle.
      await seedQueued('blocked-by-throttle');
      await runProvisioningSchedulerOnce();

      const store = queries();
      let d = await store.getWorkload('blocked-by-throttle');
      expect(d?.state).toBe(WorkloadState.Queued);

      const events = await eventLog().getWorkloadEvents('blocked-by-throttle');
      expect(JSON.parse(events[events.length - 1].metadata!).message).toContain(
        'throttle',
      );

      // End the running VM — burn rate drops to 0 instantly (no trailing-1h
      // ghost). Next scheduler tick should dispatch the candidate.
      await getDB().query(`UPDATE vms SET ended_at = ? WHERE workload_id = ?`, [
        Date.now(),
        'big-burner',
      ]);
      await runProvisioningSchedulerOnce();
      d = await store.getWorkload('blocked-by-throttle');
      expect(d?.state).toBe(WorkloadState.Provisioning);
    });

    it('burst of queued candidates respects throttle cap end-to-end', async () => {
      // No in-flight VMs → burn rate $0. With resolveWorkloadPrice pinned
      // to $5/hr (module mock above) and a $15/hr throttle, only two
      // candidates should dispatch in one tick — the third's pre-charge
      // would push the rate to $15, hitting the >=-cap block.
      const throttle = await putThrottle('account', 15);
      expect(throttle.status).toBe(204);

      await seedQueued('c1');
      await seedQueued('c2');
      await seedQueued('c3');

      await runProvisioningSchedulerOnce();

      const store = queries();
      const states = await Promise.all(
        ['c1', 'c2', 'c3'].map(
          async (id) => (await store.getWorkload(id))?.state,
        ),
      );
      const dispatched = states.filter(
        (s) => s === WorkloadState.Provisioning,
      ).length;
      const blocked = states.filter((s) => s === WorkloadState.Queued).length;
      expect(dispatched).toBe(2);
      expect(blocked).toBe(1);
    });

    it('in-flight VM mid-window does not over-trip a calendar budget', async () => {
      // Regression for the computeSpend in-flight overcount: a $10/hr VM
      // running for 30 minutes has accrued ~$5. A $50/day budget must NOT
      // block a new candidate. Pre-fix this would block because the SQL
      // billed through end-of-day (~$10 × hours-until-midnight).
      const now = Date.now();
      await seedRunningWithSpend('mild-spender', 10);
      await getDB().query(
        `UPDATE vms SET created_at = ? WHERE workload_id = ?`,
        [now - 30 * 60 * 1000, 'mild-spender'],
      );

      const budget = await putBudget('day', 'account', 50);
      expect(budget.status).toBe(204);

      await seedQueued('candidate');
      await runProvisioningSchedulerOnce();

      const store = queries();
      const d = await store.getWorkload('candidate');
      expect(d?.state).toBe(WorkloadState.Provisioning);
    });
  });
});
