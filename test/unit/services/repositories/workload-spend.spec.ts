import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { randomBytes } from 'crypto';
import {
  resetPersistence,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadSpendStore as spendStore,
  getWorkloadOutcomes as outcomes,
  getWorkloadLifecycle as lifecycle,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  preemptTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import type { CreateWorkloadInput } from '../../../../src/api/services/repositories/workload-creation.js';
import { explainQueryPlan, searchesIndex } from '../../helpers/query-plan.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import { MAX_LIST_LIMIT } from '../../../../src/shared/workload-list';
import type { WorkloadSpendStore } from '../../../../src/api/services/repositories/workload-spend.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import { seedWorkloadRows } from '../../helpers/seed-workload-rows.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

describe('WorkloadSpendStore', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES ('test-credential-id', '', 'AWS')`,
    );
  });

  describe('per-workload cost lookup', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    const MINUTE = 60_000;

    /** Place one priced VM row on an exact timeline. */
    const seedVm = async (
      id: string,
      cloudId: string,
      times: {
        createdAt: number;
        endedAt?: number | null;
        removalRequestedAt?: number | null;
      },
    ) => {
      await createWorkload(getDB(), { ...baseInput, id });
      await provisionTestVm(
        id,
        { ip: '1.2.3.4', cloudId },
        { region: 'us-east-1', pricePerHour: 3600 }, // $1/second
      );
      await getDB().query(
        `UPDATE vms SET created_at = ?, ended_at = ?, removal_requested_at = ?
         WHERE workload_id = ? AND cloud_id = ?`,
        [
          times.createdAt,
          times.endedAt ?? null,
          times.removalRequestedAt ?? null,
          id,
          cloudId,
        ],
      );
      return spendStore();
    };

    it('surfaces the same attribution through the per-workload cost lookup', async () => {
      const now = Date.now();
      const store = await seedVm('ar-cost', 'vm-cost', {
        createdAt: now - 60 * MINUTE,
        removalRequestedAt: now - 30 * MINUTE,
        endedAt: now - 4 * MINUTE,
      });

      const [row] = await store.listWorkloadCostsForId(
        scope('test-user'),
        'ar-cost',
      );
      expect(row.vmDurationMs).toBe(56 * MINUTE);
      expect(row.awaitingReleaseMs).toBe(26 * MINUTE);
    });
  });

  describe('cost and spend windows', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    // started_at is stamped at insert; backdate it directly so we can place a
    // workload on either side of a window boundary.
    const seedAt = async (
      id: string,
      startedAt: number,
      overrides: Partial<CreateWorkloadInput> = {},
    ) => {
      await createWorkload(getDB(), { ...baseInput, id, ...overrides });
      await walkToState(id, WorkloadState.Completed);
      await getDB().query(
        'UPDATE workloads SET started_at = ?, completed_at = ? WHERE id = ?',
        [startedAt, startedAt + 1000, id],
      );
    };

    const addVmLifetime = (
      workloadId: string,
      createdAt: number,
      endedAt: number,
      cost: number | null = null,
    ) =>
      getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES (?, '1.2.3.4', ?, ?, ?, 'us-east-1', ?, 1, ?)`,
        [
          workloadId,
          `${workloadId}-vm`,
          createdAt,
          endedAt,
          'test-credential-id',
          cost,
        ],
      );

    it('cost windows include a long-running service that started before the window', async () => {
      const now = Date.now();
      await seedAt('legacy-recent-terminal', now - HOUR);

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'legacy-old-service',
        workloadType: 'service',
      });
      await provisionTestVm(
        'legacy-old-service',
        {
          ip: '1.2.3.4',
          cloudId: 'legacy-old-service-vm',
          createdAt: now - 30 * DAY,
        },
        { region: 'us-east-1', pricePerHour: 1 },
      );
      await walkToState('legacy-old-service', WorkloadState.Running);
      await getDB().query('UPDATE workloads SET started_at = ? WHERE id = ?', [
        now - 30 * DAY,
        'legacy-old-service',
      ]);

      const report = await spendStore().getCostReportInWindow(
        scope('test-user'),
        now - DAY,
        now,
      );
      expect(report.totalJobs).toBe(0);
      expect(report.totalServices).toBe(1);
      expect(report.totalVms).toBe(0);
      expect(report.totalDurationMs).toBe(DAY);
      expect(report.totalCost).toBe(24);
    });

    it('selects and clips VM lifetimes to the cost window', async () => {
      const now = Date.now();
      const store = spendStore();
      await seedAt('period-started-inside', now - 20 * DAY);
      await seedAt('period-outside', now - 40 * DAY);
      await seedAt('period-overlap', now - 40 * DAY);
      await seedAt('period-overlap-actual', now - 40 * DAY);

      await addVmLifetime(
        'period-started-inside',
        now - 20 * DAY,
        now - 19 * DAY,
      );
      await addVmLifetime('period-outside', now - 40 * DAY, now - 39 * DAY);
      await addVmLifetime('period-overlap', now - 40 * DAY, now - 10 * DAY);
      await addVmLifetime(
        'period-overlap-actual',
        now - 40 * DAY,
        now - 10 * DAY,
        900,
      );

      const report = await store.getCostReportInWindow(
        scope('test-user'),
        now - 30 * DAY,
        now,
      );
      expect(report).toMatchObject({
        totalJobs: 3,
        totalServices: 0,
        totalVms: 0,
        totalDurationMs: 41 * DAY,
        totalCost: 24 + 20 * 24 + 600,
        workloadsWithoutPrice: 0,
      });
    });

    it('keeps selective session cost aggregation workload-driven', async () => {
      const store = spendStore();
      const query = vi.spyOn(getDB(), 'query');
      await store.getCostReportInWindow(
        scope('test-user'),
        Date.now() - 30 * DAY,
        Date.now(),
        { session: 'selective-session', sessionExact: true },
      );

      const [sql, params] = query.mock.calls.find(
        ([candidate]) =>
          typeof candidate === 'string' &&
          candidate.includes('workload_costs AS MATERIALIZED'),
      )!;
      expect(sql).toContain('FROM workloads d');
      expect(sql).toContain('owned_workloads d JOIN vms AS v');
      expect(sql).not.toContain('LIMIT ?');
      expect(params).toEqual(['selective-session']);
      const details = (
        await getDB().query<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${sql}`,
          params,
        )
      ).map(({ detail }) => detail);
      expect(
        searchesIndex(details, 'idx_workloads_session'),
        details.join('\n'),
      ).toBe(true);
      expect(searchesIndex(details, 'idx_vms_workload_id')).toBe(true);
    });

    it('returns exact totals beyond 1,000 workloads and counts retry VMs once per workload', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - HOUR;
      await seedWorkloadRows(
        `INSERT INTO workloads (
           id, user_id, workload_type, state, started_at,
           submitted_at, docker_command, ssh_private_key
         )
         WITH RECURSIVE n(value) AS (
           SELECT 0
           UNION ALL SELECT value + 1 FROM n WHERE value < ?
         )
         SELECT printf('cost-boundary-%04d', value), 'cost-boundary-user',
                'job', 'completed', ? + value, ? + value,
                'cmd', ''
         FROM n`,
        [MAX_LIST_LIMIT - 1, start, start],
        'img',
        ['cost-boundary-user'],
      );
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, price_per_hour
         )
         SELECT id, '192.0.2.1', id || '-vm', ?, ?, 1
         FROM workloads WHERE user_id = 'cost-boundary-user'`,
        [start, now],
      );
      // A second overlapping attempt must not consume a workload slot.
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, price_per_hour
         ) VALUES ('cost-boundary-0000', '192.0.2.2', 'retry-vm', ?, ?, 1)`,
        [start, now],
      );

      await seedWorkloadRows(
        `INSERT INTO workloads (
           id, user_id, workload_type, state, started_at,
           submitted_at, docker_command, ssh_private_key
         ) VALUES ('cost-boundary-overflow', 'cost-boundary-user', 'job',
                   'completed', ?, ?, 'cmd', '')`,
        [now, now],
        'img',
        ['cost-boundary-user'],
      );
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, price_per_hour
         ) VALUES ('cost-boundary-overflow', '192.0.2.3', 'overflow-vm', ?, ?, 1)`,
        [start, now],
      );
      const report = await store.getCostReportInWindow(
        scope('cost-boundary-user'),
        start,
        now,
      );
      expect(report.totalJobs).toBe(MAX_LIST_LIMIT + 1);
      expect(report.totalServices).toBe(0);
      expect(report.totalVms).toBe(0);
      expect(report.totalDurationMs).toBe((MAX_LIST_LIMIT + 2) * HOUR);
      expect(report.totalCost).toBe(MAX_LIST_LIMIT + 2);
    });

    it('uses indexed VM-window searches and one materialized workload rollup', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - DAY;
      const querySpy = vi.spyOn(getDB(), 'query');

      const planFor = async (
        filter?: Parameters<WorkloadSpendStore['getCostReportInWindow']>[3],
      ): Promise<string[]> => {
        const firstNewCall = querySpy.mock.calls.length;
        await store.getCostReportInWindow(
          scope('cost-plan-user'),
          start,
          now,
          filter,
        );
        const calls = querySpy.mock.calls
          .slice(firstNewCall)
          .filter(
            (candidate) =>
              typeof candidate[0] === 'string' &&
              candidate[0].includes('workload_costs AS MATERIALIZED'),
          );
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call[0]).toContain('UNION ALL');
        expect(call[0]).toContain('overlapping_vms AS NOT MATERIALIZED (');
        expect(call[0]).toContain('workload_costs AS MATERIALIZED');
        expect(call[0]).not.toContain('LIMIT ?');
        const plan = await getDB().query<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${call[0]}`,
          call[1],
        );
        return plan.map((row) => row.detail);
      };

      for (const filter of [undefined, { agent: 'codex' }]) {
        const details = await planFor(filter);
        expect(searchesIndex(details, 'idx_vms_spend_window')).toBe(true);
        expect(
          details.filter(
            (detail) =>
              detail.includes('SEARCH') &&
              detail.includes('idx_vms_spend_window'),
          ),
        ).toHaveLength(2);
        expect(
          details.some((detail) =>
            detail.includes('SCAN d USING INDEX sqlite_autoindex_workloads'),
          ),
          details.join('\n'),
        ).toBe(false);
        expect(
          details.some((detail) => detail.includes('idx_workloads_user')),
        ).toBe(false);
        expect(
          details.filter((detail) =>
            detail.includes('MATERIALIZE workload_costs'),
          ),
        ).toHaveLength(1);
        // Ownership has to stay an inline filter on a primary-key lookup here.
        // Routing it through a compound CTE instead makes SQLite buffer every
        // column of the owner's whole history and index it on the fly, which
        // reintroduces the history-depth cost this shape exists to avoid.
        expect(
          details.some((detail) =>
            detail.includes('SEARCH d USING INDEX sqlite_autoindex_workloads'),
          ),
          details.join('\n'),
        ).toBe(true);
        expect(
          details.filter((detail) => detail.startsWith('MATERIALIZE')),
          details.join('\n'),
        ).toEqual(['MATERIALIZE workload_costs']);
      }
    });

    it('filters and buckets aggregate cost by agent', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - DAY;
      await seedAt('cost-agent-old', start + HOUR);
      await seedAt('cost-agent-new', start + 2 * HOUR);
      await seedAt('cost-other-agent', start + 3 * HOUR);
      await addVmLifetime('cost-agent-old', start, now);
      await addVmLifetime('cost-agent-new', start, now);
      await addVmLifetime('cost-other-agent', start, now);
      await getDB().query(
        `UPDATE workloads
         SET agent = CASE
           WHEN id IN ('cost-agent-old', 'cost-agent-new') THEN 'codex'
           ELSE 'other'
         END
         WHERE id LIKE 'cost-%agent%'`,
      );

      const report = await store.getCostReportInWindow(
        scope('test-user'),
        start,
        now,
        { agent: 'codex' },
      );
      expect(report.totalJobs).toBe(2);
      expect(report.totalCost).toBe(48);
      expect(report.byAgent).toEqual({
        codex: {
          cost: 48,
          durationMs: 2 * DAY,
          jobs: 2,
          services: 0,
          vms: 0,
        },
      });
    });

    it('buckets aggregate cost by the account that created each workload', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - DAY;
      await seedAt('cost-user-mine', start + HOUR);
      await seedAt('cost-user-theirs', start + 2 * HOUR, {
        userId: 'teammate',
        ownerUserId: '77',
      });
      await addVmLifetime('cost-user-mine', start, now);
      await addVmLifetime('cost-user-theirs', start, now);

      // Team scope: one report covering both accounts, split by creator so the
      // total is never mistaken for one person's spend.
      const report = await store.getCostReportInWindow(
        { kind: 'api' },
        start,
        now,
      );
      expect(report.totalCost).toBe(48);
      expect(report.byUser).toEqual({
        'test-user': {
          cost: 24,
          durationMs: DAY,
          jobs: 1,
          services: 0,
          vms: 0,
        },
        teammate: { cost: 24, durationMs: DAY, jobs: 1, services: 0, vms: 0 },
      });
    });

    it('narrows cost to one account by username or by immutable id', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - DAY;
      await seedAt('cost-filter-mine', start + HOUR);
      await seedAt('cost-filter-theirs', start + 2 * HOUR, {
        userId: 'teammate',
        ownerUserId: '77',
      });
      await addVmLifetime('cost-filter-mine', start, now);
      await addVmLifetime('cost-filter-theirs', start, now);

      for (const value of ['teammate', '77']) {
        await expect(
          store.getCostReportInWindow({ kind: 'api' }, start, now, {
            user: value,
          }),
        ).resolves.toMatchObject({ totalCost: 24 });
      }
    });

    it('reaches a renamed account by id when the captured username is stale', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - DAY;
      await seedAt('cost-renamed', start + HOUR, {
        userId: 'old-handle',
        ownerUserId: '99',
      });
      await addVmLifetime('cost-renamed', start, now);
      // Submitted under the old handle; user_id is never rewritten, so only the
      // durable id still finds it.

      await expect(
        store.getCostReportInWindow({ kind: 'api' }, start, now, {
          user: 'new-handle',
        }),
      ).resolves.toMatchObject({ totalCost: 0 });
      await expect(
        store.getCostReportInWindow({ kind: 'api' }, start, now, {
          user: '99',
        }),
      ).resolves.toMatchObject({ totalCost: 24 });
    });

    it('reports a single creator so callers can drop the breakdown', async () => {
      const store = spendStore();
      const now = Date.now();
      const start = now - DAY;
      await seedAt('cost-solo', start + HOUR);
      await addVmLifetime('cost-solo', start, now);

      const report = await store.getCostReportInWindow(
        scope('test-user'),
        start,
        now,
      );
      expect(Object.keys(report.byUser)).toEqual(['test-user']);
    });

    it('counts persistent VM cost separately from jobs and services', async () => {
      const now = Date.now();
      const start = now - 2 * HOUR;
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'cost-persistent-vm',
        workloadType: WorkloadType.Vm,
        agent: 'codex',
      });
      await getDB().query(
        `UPDATE workloads SET requested_compute_provider = ? WHERE id = ?`,
        [CloudType.AWS, 'cost-persistent-vm'],
      );
      await addVmLifetime('cost-persistent-vm', start, now);

      const report = await spendStore().getCostReportInWindow(
        scope('test-user'),
        start,
        now,
      );
      expect(report).toEqual({
        periodMs: 2 * HOUR,
        totalCost: 2,
        totalDurationMs: 2 * HOUR,
        totalJobs: 0,
        totalServices: 0,
        totalVms: 1,
        workloadsWithoutPrice: 0,
        byProvider: {
          [CloudType.AWS]: {
            cost: 2,
            durationMs: 2 * HOUR,
            jobs: 0,
            services: 0,
            vms: 1,
            hasSpot: false,
          },
        },
        byAgent: {
          codex: {
            cost: 2,
            durationMs: 2 * HOUR,
            jobs: 0,
            services: 0,
            vms: 1,
          },
        },
        byUser: {
          'test-user': {
            cost: 2,
            durationMs: 2 * HOUR,
            jobs: 0,
            services: 0,
            vms: 1,
          },
        },
        includesOtherUsers: false,
      });
    });

    it('rolls up providers, agents, types, spot usage, and unpriced workloads', async () => {
      const now = Date.now();
      const start = now - DAY;
      for (const id of [
        'cost-rollup-aws-job',
        'cost-rollup-azure-service',
        'cost-rollup-unpriced',
      ]) {
        await seedAt(id, start, {
          workloadType:
            id === 'cost-rollup-azure-service'
              ? WorkloadType.Service
              : WorkloadType.Job,
        });
      }
      await getDB().query(
        `UPDATE workloads
         SET requested_compute_provider = ?, agent = ?
         WHERE id = 'cost-rollup-aws-job'`,
        [CloudType.AWS, 'claude'],
      );
      await getDB().query(
        `UPDATE workloads
         SET requested_compute_provider = ?, agent = ?,
             spot = 1
         WHERE id = 'cost-rollup-azure-service'`,
        [CloudType.Azure, 'cursor'],
      );
      await getDB().query(
        `UPDATE workloads SET agent = 'claude'
         WHERE id = 'cost-rollup-unpriced'`,
      );
      await addVmLifetime(
        'cost-rollup-aws-job',
        start + HOUR,
        start + 3 * HOUR,
      );
      await addVmLifetime(
        'cost-rollup-azure-service',
        start + HOUR,
        start + 4 * HOUR,
        6,
      );
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, price_per_hour
         ) VALUES ('cost-rollup-unpriced', '192.0.2.4', 'unpriced-vm', ?, ?, NULL)`,
        [start + HOUR, start + 2 * HOUR],
      );

      const report = await spendStore().getCostReportInWindow(
        scope('test-user'),
        start,
        now,
      );
      expect(report).toEqual({
        periodMs: DAY,
        totalCost: 8,
        totalDurationMs: 5 * HOUR,
        totalJobs: 1,
        totalServices: 1,
        totalVms: 0,
        workloadsWithoutPrice: 1,
        byProvider: {
          [CloudType.AWS]: {
            cost: 2,
            durationMs: 2 * HOUR,
            jobs: 1,
            services: 0,
            vms: 0,
            hasSpot: false,
          },
          [CloudType.Azure]: {
            cost: 6,
            durationMs: 3 * HOUR,
            jobs: 0,
            services: 1,
            vms: 0,
            hasSpot: true,
          },
        },
        byAgent: {
          claude: {
            cost: 2,
            durationMs: 2 * HOUR,
            jobs: 1,
            services: 0,
            vms: 0,
          },
          cursor: {
            cost: 6,
            durationMs: 3 * HOUR,
            jobs: 0,
            services: 1,
            vms: 0,
          },
        },
        byUser: {
          'test-user': {
            cost: 8,
            durationMs: 5 * HOUR,
            jobs: 1,
            services: 1,
            vms: 0,
          },
        },
        includesOtherUsers: false,
      });
    });

    it('returns a zero report for a window with no overlapping VMs', async () => {
      const now = Date.now();
      // An old workload still marked active (e.g. resubmitted) whose only VM
      // ran and ended entirely before the reporting window. A cost window must
      // report "nothing ran here" and must not resurrect it or over-report the
      // period based on workload metadata.
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'window-empty-active',
      });
      await walkToState('window-empty-active', WorkloadState.Running);
      await getDB().query('UPDATE workloads SET started_at = ? WHERE id = ?', [
        now - 60 * DAY,
        'window-empty-active',
      ]);
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES (?, '1.2.3.4', ?, ?, ?, 'us-east-1', ?, 1, NULL)`,
        [
          'window-empty-active',
          'window-empty-active-vm',
          now - 60 * DAY,
          now - 40 * DAY, // ended 40d ago — before a 30d window opens
          'test-credential-id',
        ],
      );

      const report = await spendStore().getCostReportInWindow(
        scope('test-user'),
        now - 30 * DAY,
        now,
      );
      expect(report).toEqual({
        periodMs: 30 * DAY,
        totalCost: 0,
        totalDurationMs: 0,
        totalJobs: 0,
        totalServices: 0,
        totalVms: 0,
        workloadsWithoutPrice: 0,
        byProvider: {},
        byAgent: {},
        byUser: {},
        includesOtherUsers: false,
      });
    });

    it('uses half-open VM boundaries and ignores provisioning placeholders', async () => {
      const now = Date.now();
      const start = now - DAY;
      const store = spendStore();
      for (const id of [
        'cost-ended-at-start',
        'cost-created-at-end',
        'cost-overlap-one-ms',
        'cost-placeholder',
      ]) {
        await seedAt(id, now - 10 * DAY);
      }
      await addVmLifetime('cost-ended-at-start', start - HOUR, start);
      await addVmLifetime('cost-created-at-end', now, now + HOUR);
      await addVmLifetime('cost-overlap-one-ms', start - HOUR, start + 1);
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES (?, NULL, ?, ?, ?, 'us-east-1', ?, 1, 99)`,
        [
          'cost-placeholder',
          'cost-placeholder-vm',
          start + HOUR,
          start + 2 * HOUR,
          'test-credential-id',
        ],
      );

      const report = await store.getCostReportInWindow(
        scope('test-user'),
        start,
        now,
      );
      expect(report.totalJobs).toBe(1);
      expect(report.totalDurationMs).toBe(1);
      expect(report.totalCost).toBeCloseTo(1 / 3_600_000, 12);
    });

    it('includes overlapping provisioned VMs even when no price is available', async () => {
      const now = Date.now();
      const start = now - DAY;
      const store = spendStore();
      await seedAt('cost-unpriced-overlap', start - DAY);
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES (?, '1.2.3.4', ?, ?, ?, 'us-east-1', ?, NULL, NULL)`,
        [
          'cost-unpriced-overlap',
          'cost-unpriced-overlap-vm',
          start + HOUR,
          start + 2 * HOUR,
          'test-credential-id',
        ],
      );

      const report = await store.getCostReportInWindow(
        scope('test-user'),
        start,
        now,
      );
      expect(report).toMatchObject({
        totalCost: 0,
        totalDurationMs: 0,
        totalJobs: 0,
        totalServices: 0,
        totalVms: 0,
        workloadsWithoutPrice: 1,
        byProvider: {},
        byAgent: {},
        byUser: {},
      });
    });

    it('uses VM lifetimes regardless of state, started_at, or completed_at', async () => {
      const now = Date.now();
      const start = now - DAY;
      const store = spendStore();
      await seedAt('cost-overlap-stale-metadata', now - 90 * DAY);
      await seedAt('cost-no-overlap-future-completion', now - HOUR);
      await addVmLifetime(
        'cost-overlap-stale-metadata',
        start - HOUR,
        start + HOUR,
      );
      await addVmLifetime(
        'cost-no-overlap-future-completion',
        start - 3 * DAY,
        start - 2 * DAY,
      );
      await getDB().query(
        `UPDATE workloads
         SET state = ?, completed_at = NULL
         WHERE id = ?`,
        [WorkloadState.Running, 'cost-overlap-stale-metadata'],
      );
      await getDB().query(
        `UPDATE workloads SET completed_at = ? WHERE id = ?`,
        [now + 30 * DAY, 'cost-no-overlap-future-completion'],
      );

      const report = await store.getCostReportInWindow(
        scope('test-user'),
        start,
        now,
      );
      expect(report.totalJobs).toBe(1);
      expect(report.totalDurationMs).toBe(HOUR);
      expect(report.totalCost).toBe(1);
    });

    it('returns exact all-time costs', async () => {
      const now = Date.now();
      await seedAt('historical-cost-id', now - 60 * DAY);
      await addVmLifetime('historical-cost-id', now - 60 * DAY, now - 59 * DAY);

      const [historical] = await spendStore().listWorkloadCostsForId(
        scope('test-user'),
        'historical-cost-id',
      );
      expect(historical.vmDurationMs).toBe(DAY);
      expect(historical.totalCost).toBe(24);
    });

    it('returns an existing exact workload without charging placeholders', async () => {
      const now = Date.now();
      await seedAt('cost-id-without-vm', now - 60 * DAY);
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES (?, NULL, ?, ?, ?, 'us-east-1', ?, 1, 99)`,
        [
          'cost-id-without-vm',
          'cost-id-placeholder',
          now - 60 * DAY,
          now - 59 * DAY,
          'test-credential-id',
        ],
      );

      const rows = await spendStore().listWorkloadCostsForId(
        scope('test-user'),
        'cost-id-without-vm',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'cost-id-without-vm',
        vmDurationMs: 0,
        totalCost: 0,
      });
    });

    const insertLiveVm = (id: string, createdAt: number) =>
      getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES (?, '1.2.3.4', ?, ?, NULL, 'us-east-1', 'test-credential-id', 1, NULL)`,
        [id, `${id}-vm`, createdAt],
      );

    it('sumVmSpendInWindow reports provisioned VM usage across the whole window', async () => {
      const now = Date.now();
      const start = now - 24 * HOUR;

      // Live service: created 10 days ago, still running, $1/h → the whole day
      // is in the window = $24 (estimated, not yet reconciled).
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'live-service',
        workloadType: 'service',
      });
      await walkToState('live-service', WorkloadState.Running);
      await insertLiveVm('live-service', now - 10 * DAY);

      // Never-provisioned placeholders do not represent VM usage.
      await createWorkload(getDB(), { ...baseInput, id: 'debris' });
      await getDB().query(
        `INSERT INTO vms (
           workload_id, ip, cloud_id, created_at, ended_at, region,
           credential_id, price_per_hour, cost
         ) VALUES ('debris', NULL, 'debris-vm', ?, NULL, 'us-east-1',
                   'test-credential-id', 5, 0.05)`,
        [start + HOUR],
      );

      const spend = await spendStore().sumVmSpendInWindow(start, now);
      expect(spend.services.runningCost).toBeCloseTo(24, 2);
      expect(spend.services.activeVmCount).toBe(1); // only the ip-bearing service
      expect(spend.services.unpricedVmCount).toBe(0);
      expect(spend.services.durationMs).toBe(24 * HOUR);
      expect(spend.services.costSource).toBe('estimated');
      expect(spend.jobs.activeVmCount).toBe(0);
      expect(spend.users.map((user) => user.userId)).toEqual(['test-user']);
      expect(spend.users[0].services.runningCost).toBeCloseTo(24, 2);
      expect(spend.users[0].services.durationMs).toBe(24 * HOUR);
      expect(spend.users[0].jobs.activeVmCount).toBe(0);
    });

    it('selects the terminal outcome at T1 while VM spend runs through T2', async () => {
      const id = 'terminal-outcome-and-spend';
      await createWorkload(getDB(), { ...baseInput, id });
      await walkToState(id, WorkloadState.Running);

      const outcomeAt = Date.now() + 1_000;
      const vmStartedAt = outcomeAt - HOUR;
      const vmEndedAt = outcomeAt + 2 * HOUR;
      const cleanedAt = vmEndedAt + HOUR;
      await insertLiveVm(id, vmStartedAt);

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(outcomeAt);
      try {
        expect(
          await outcomes().publishTerminalOutcome(
            id,
            WorkloadState.Completed,
            WorkloadState.Running,
            { metadata: { exitCode: 0 } },
          ),
        ).toBe(true);

        const pending = await queries().listTerminalWorkloadsByDateRange(
          outcomeAt,
          outcomeAt + 1,
        );
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          id,
          state: WorkloadState.Completed,
          completedAt: outcomeAt,
        });
        expect((await queries().getWorkload(id))?.state).toBe(
          WorkloadState.Completed,
        );

        // A live VM is charged only up to now, so read after its runtime.
        nowSpy.mockReturnValue(outcomeAt + HOUR / 2);
        const pendingCleanup = await spendStore().sumVmSpendInWindow(
          vmStartedAt,
          outcomeAt + HOUR / 2,
        );
        expect(pendingCleanup.jobs.durationMs).toBe(1.5 * HOUR);
        expect(pendingCleanup.jobs.runningCost).toBeCloseTo(1.5, 5);

        nowSpy.mockReturnValue(vmEndedAt);
        await releaseTestVms(id, `${id}-vm`);
        nowSpy.mockReturnValue(cleanedAt);
        await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const published = await queries().listTerminalWorkloadsByDateRange(
        outcomeAt,
        outcomeAt + 1,
      );
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        id,
        state: WorkloadState.Completed,
        completedAt: outcomeAt,
      });
      await expect(
        queries().listTerminalWorkloadsByDateRange(cleanedAt, cleanedAt + 1),
      ).resolves.toEqual([]);

      const afterCleanup = await spendStore().sumVmSpendInWindow(
        vmStartedAt,
        cleanedAt + HOUR,
      );
      expect(afterCleanup.jobs.durationMs).toBe(3 * HOUR);
      expect(afterCleanup.jobs.runningCost).toBeCloseTo(3, 5);
      expect((await eventLog().getWorkloadEvents(id)).at(-1)).toMatchObject({
        state: WorkloadState.Completed,
        created_at: outcomeAt,
      });
    });

    it('sumVmSpendInWindow bounds the scan and identifies unpriced VM usage', async () => {
      const now = Date.now();
      const start = now - HOUR;
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'unpriced-service',
        workloadType: 'service',
      });
      await provisionTestVm('unpriced-service', {
        ip: '1.2.3.5',
        cloudId: 'unpriced-vm',
        createdAt: start,
      });
      await walkToState('unpriced-service', WorkloadState.Running);

      const querySpy = vi.spyOn(getDB(), 'query');
      const spend = await spendStore().sumVmSpendInWindow(start, now);
      const call = querySpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('unpriced_vm_count'),
      );

      expect(spend.services.runningCost).toBe(0);
      expect(spend.services.activeVmCount).toBe(1);
      expect(spend.services.unpricedVmCount).toBe(1);
      expect(spend.services.durationMs).toBe(HOUR);
      expect(call?.[0]).toContain('WHERE v.ip IS NOT NULL');
      expect(call?.[0]).toContain('(v.ended_at IS NULL OR v.ended_at >');
    });

    it('sumVmSpendInWindow counts a VM restarted in place once', async () => {
      const now = Date.now();
      const start = now - HOUR;
      const id = 'restarted-job';
      await createWorkload(getDB(), { ...baseInput, id });
      await provisionTestVm(id, {
        ip: '1.2.3.6',
        cloudId: 'spot-vm',
        createdAt: start,
      });
      await preemptTestVm(id, 'spot-vm');
      expect(
        await lifecycle().finishPreemptionRecovery(
          id,
          WorkloadType.Job,
          'spot-vm',
          { ip: '1.2.3.6', cloudId: 'spot-vm' },
        ),
      ).toBe(true);
      const rows = await getDB().query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vms WHERE workload_id = ?`,
        [id],
      );
      expect(rows[0].n).toBe(2);

      const spend = await spendStore().sumVmSpendInWindow(start, Date.now());
      expect(spend.jobs.activeVmCount).toBe(1);
      expect(spend.jobs.unpricedVmCount).toBe(1);
    });

    it('sumVmSpendInWindow splits spend by workload type without losing user attribution', async () => {
      const now = Date.now();
      const start = now - HOUR;
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'alice-service',
        userId: 'alice',
        workloadType: 'service',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'bob-job',
        userId: 'bob',
      });
      await insertLiveVm('alice-service', start);
      await insertLiveVm('bob-job', start);

      const spend = await spendStore().sumVmSpendInWindow(start, now);
      expect(spend.services.runningCost).toBeCloseTo(1, 2);
      expect(spend.services.activeVmCount).toBe(1);
      expect(spend.services.durationMs).toBe(HOUR);
      expect(spend.jobs.runningCost).toBeCloseTo(1, 2);
      expect(spend.jobs.activeVmCount).toBe(1);
      expect(spend.jobs.durationMs).toBe(HOUR);
      expect(spend.users.map((user) => user.userId)).toEqual(['alice', 'bob']);
      expect(spend.users[0].services.runningCost).toBeCloseTo(1, 2);
      expect(spend.users[0].services.activeVmCount).toBe(1);
      expect(spend.users[0].jobs.activeVmCount).toBe(0);
      expect(spend.users[1].jobs.runningCost).toBeCloseTo(1, 2);
      expect(spend.users[1].jobs.activeVmCount).toBe(1);
      expect(spend.users[1].services.activeVmCount).toBe(0);
    });
  });

  // listVms returns both active and terminated VMs, ordered by created_at, so
  // /status can expose per-VM provisioning metadata even after VM cleanup has
  // flipped ended_at. Failed-provisioning rows (ip IS NULL) are excluded —
  // mirrors getVMs.
  describe('team-scoped cost', () => {
    const teamScope = { kind: 'api' as const };
    const baseInput = {
      workloadType: 'job' as const,
      image: 'alpine:latest',
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    const seedTwoMembers = async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'owner-workload',
        userId: 'owner',
        ownerUserId: '100',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'member-workload',
        userId: 'member',
        ownerUserId: '200',
      });
      return spendStore();
    };

    it('reports costs across every member', async () => {
      const store = await seedTwoMembers();
      const now = Date.now();
      for (const id of ['owner-workload', 'member-workload']) {
        await provisionTestVm(
          id,
          { ip: '1.2.3.4', cloudId: `${id}-vm`, createdAt: now - 3_600_000 },
          { region: 'us-east-1', pricePerHour: 1 },
        );
      }

      // The VM-driven branch filters ownership inline through
      // ownershipPredicate; the session filter below takes the
      // workload-driven branch, whose CTE arms come from ownershipBranches.
      await expect(
        store.getCostReportInWindow(teamScope, now - 7_200_000, now),
      ).resolves.toMatchObject({ totalJobs: 2 });
    });
  });
});

describe('spend query plans', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  it('workload start summaries search resubmits by created-at index', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { rmSync } = await import('fs');

    const dbFile = join(
      tmpdir(),
      `anycloud-start-summary-idx-spec-${process.pid}.db`,
    );
    rmSync(dbFile, { force: true });
    vi.stubEnv('SQLITE_PATH', dbFile);
    resetPersistence();
    try {
      const store = spendStore();
      const querySpy = vi.spyOn(getDB(), 'query');
      await store.summarizeWorkloadStartsInWindow(0, 1);
      const call = querySpy.mock.calls.find(
        (candidate) =>
          typeof candidate[0] === 'string' &&
          candidate[0].includes('WITH activity AS'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call!;

      const details = explainQueryPlan(dbFile, sql, params ?? []);
      expect(searchesIndex(details, 'idx_events_resubmit_created_at')).toBe(
        true,
      );
    } finally {
      vi.unstubAllEnvs();
      resetPersistence();
      rmSync(dbFile, { force: true });
    }
  });
});
