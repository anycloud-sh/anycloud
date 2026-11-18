import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import { callApi } from '../helpers/api-test-helper';
import { createTestWorkload, resetTestStore } from '../utils';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { TEST_USER_ID } from '../../../src/api/services/test-identity.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy.js';
import {
  provisionTestVm,
  releaseTestVms,
  walkToState,
} from '../../helpers/workload-store.js';

describe('workload cost endpoints', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    await resetTestStore();
  });

  const get = (input: Record<string, unknown>) => {
    const { id, ...query } = input;
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) search.set(name, String(value));
    }
    const suffix = search.size === 0 ? '' : `?${search}`;
    const resource =
      id === undefined
        ? '/v1/workload-costs'
        : `/v1/workloads/${encodeURIComponent(String(id))}/cost`;
    return callApi(`https://example.com${resource}${suffix}`, {
      headers: { Authorization: 'Bearer mock-github-token' },
    });
  };

  const addVmLifetime = (
    workloadId: string,
    createdAt: number,
    endedAt: number,
  ) =>
    getDB().query(
      `INSERT INTO vms (
         workload_id, ip, cloud_id, created_at, ended_at, region,
         credential_id, price_per_hour, cost
       ) VALUES (?, '1.2.3.4', ?, ?, ?, 'us-east-1', ?, 1, NULL)`,
      [
        workloadId,
        `${workloadId}-vm`,
        createdAt,
        endedAt,
        'test-credential-id',
      ],
    );

  it('requires exactly one of id and sinceMs', async () => {
    const neither = await get({});
    expect(neither.status).toBe(400);
    await expect(neither.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: { issues: expect.any(Array) },
    });

    const both = await get({ id: 'workload', sinceMs: Date.now() - DAY });
    expect(both.status).toBe(400);
    await expect(both.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: { issues: expect.any(Array) },
    });
  });

  it('rejects a blank exact workload ID', async () => {
    const response = await get({ id: ' ' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [
          expect.objectContaining({
            code: 'too_small',
            path: ['params', 'id'],
          }),
        ],
      },
    });
  });

  it.each([
    ['zero days', Date.now()],
    ['more than 90 days', Date.now() - 91 * DAY],
    ['the Unix epoch', 0],
    ['a string cutoff', '30d'],
    ['a null cutoff', null],
  ])('rejects %s as a reporting window', async (_label, sinceMs) => {
    const response = await get({ sinceMs });
    expect(response.status).toBe(400);
    const error = await response.json();
    if (typeof sinceMs === 'number') {
      expect(error).toMatchObject({
        code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
        message: expect.stringContaining('between 1 and 90 days'),
      });
    } else {
      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        data: { issues: expect.any(Array) },
      });
    }
  });

  it.each([1, 30, 90])('accepts a %d-day reporting window', async (days) => {
    const response = await get({ sinceMs: Date.now() - days * DAY });
    expect(response.status).toBe(200);
    const report = (await response.json()) as Record<string, unknown>;
    expect(report).toMatchObject({
      totalCost: 0,
      totalDurationMs: 0,
      totalJobs: 0,
      totalServices: 0,
      totalVms: 0,
      workloadsWithoutPrice: 0,
      byProvider: {},
      byAgent: {},
      byUser: {},
    });
    expect(report.periodMs).toEqual(expect.any(Number));
    expect(report.periodMs as number).toBeGreaterThanOrEqual(days * DAY);
    expect(report.periodMs as number).toBeLessThan(days * DAY + 5_000);
  });

  it('selects by VM overlap and returns a compact clipped report', async () => {
    const now = Date.now();
    const start = now - DAY;
    await createTestWorkload(
      'route-cost-overlap',
      'test-user',
      WorkloadState.Completed,
    );
    await createTestWorkload(
      'route-cost-outside',
      'test-user',
      WorkloadState.Running,
    );
    await addVmLifetime('route-cost-overlap', start - HOUR, start + HOUR);
    await addVmLifetime('route-cost-outside', start - 3 * DAY, start - 2 * DAY);
    await getDB().query(`UPDATE workloads SET completed_at = ? WHERE id = ?`, [
      now + 30 * DAY,
      'route-cost-outside',
    ]);

    const response = await get({ sinceMs: start });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      totalCost: 1,
      totalDurationMs: HOUR,
      totalJobs: 1,
      totalServices: 0,
      totalVms: 0,
      byProvider: {
        AWS: {
          cost: 1,
          durationMs: HOUR,
          jobs: 1,
          services: 0,
          vms: 0,
          hasSpot: false,
        },
      },
    });
    expect(report).not.toHaveProperty('workloads');
    expect(report).not.toHaveProperty('userId');
  });

  it('charges through the VM spend cutoff instead of the earlier outcome timestamp', async () => {
    const store = queries();
    const id = 'route-terminal-vm-cost';
    await createTestWorkload(id, 'test-user', WorkloadState.Provisioning);

    const outcomeAt = Date.now() + 1_000;
    const vmStartedAt = outcomeAt - HOUR;
    const vmEndedAt = outcomeAt + 2 * HOUR;
    const cleanedAt = vmEndedAt + HOUR;
    await provisionTestVm(
      id,
      {
        ip: '1.2.3.4',
        cloudId: `${id}-vm`,
        createdAt: vmStartedAt,
      },
      { region: 'us-east-1', pricePerHour: 1 },
    );
    await walkToState(id, WorkloadState.Running);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(outcomeAt);
    try {
      await getWorkloadOutcomes().publishTerminalOutcome(
        id,
        WorkloadState.Completed,
        WorkloadState.Running,
        { metadata: { exitCode: 0 } },
      );
      expect(await store.getWorkload(id)).toMatchObject({
        state: WorkloadState.Completed,
        completedAt: outcomeAt,
      });

      nowSpy.mockReturnValue(vmEndedAt);
      await releaseTestVms(id, `${id}-vm`);
      const beforeCleanup = await get({ sinceMs: vmEndedAt - DAY });
      expect(beforeCleanup.status).toBe(200);
      expect(await beforeCleanup.json()).toMatchObject({
        totalDurationMs: 3 * HOUR,
        totalCost: 3,
        totalJobs: 1,
        byProvider: {
          AWS: {
            durationMs: 3 * HOUR,
            cost: 3,
          },
        },
      });
      expect(await store.getWorkload(id)).toMatchObject({
        state: WorkloadState.Completed,
        completedAt: outcomeAt,
      });

      nowSpy.mockReturnValue(cleanedAt);
      await expect(getWorkloadOutcomes().markCleanupComplete(id)).resolves.toBe(
        true,
      );

      const afterPublication = await get({ id });
      expect(afterPublication.status).toBe(200);
      expect(await afterPublication.json()).toEqual([
        expect.objectContaining({
          id,
          vmDurationMs: 3 * HOUR,
          totalCost: 3,
        }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }

    expect(await store.getWorkload(id)).toMatchObject({
      state: WorkloadState.Completed,
      completedAt: outcomeAt,
    });
    expect((await eventLog().getWorkloadEvents(id)).at(-1)).toMatchObject({
      state: WorkloadState.Completed,
      created_at: outcomeAt,
    });
  });

  it('applies session and agent attribution filters', async () => {
    const now = Date.now();
    for (const id of ['route-cost-claude', 'route-cost-codex']) {
      await createTestWorkload(id, 'test-user', WorkloadState.Completed);
      await addVmLifetime(id, now - 2 * HOUR, now - HOUR);
    }
    await getDB().query(
      `UPDATE workloads SET session = ?, agent = ? WHERE id = ?`,
      ['shared-session', 'claude', 'route-cost-claude'],
    );
    await getDB().query(
      `UPDATE workloads SET session = ?, agent = ? WHERE id = ?`,
      ['shared-session', 'codex', 'route-cost-codex'],
    );

    const response = await get({
      sinceMs: now - DAY,
      session: 'shared-session',
      sessionExact: true,
      agent: 'codex',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalCost: 1,
      totalJobs: 1,
      byAgent: {
        codex: { cost: 1, jobs: 1, services: 0, vms: 0 },
      },
      byUser: {},
      includesOtherUsers: false,
    });
  });

  it('reports when a shared cost window contains only another user’s spend', async () => {
    const now = Date.now();
    await upsertApiAccessOwner('original-owner', '77');
    await upsertApiAccessUser({
      userId: TEST_USER_ID,
      username: 'test-user',
    });
    await createTestWorkload(
      'route-cost-mine',
      'test-user',
      WorkloadState.Completed,
      false,
      TEST_USER_ID,
    );
    await createTestWorkload(
      'route-cost-teammate',
      'teammate',
      WorkloadState.Completed,
      false,
      '77',
    );
    await addVmLifetime('route-cost-mine', now - 2 * HOUR, now - HOUR);
    await addVmLifetime('route-cost-teammate', now - 2 * HOUR, now - HOUR);

    const mine = await get({ sinceMs: now - DAY, user: 'test-user' });
    expect(mine.status).toBe(200);
    await expect(mine.json()).resolves.toMatchObject({
      byUser: { 'test-user': { cost: 1 } },
      includesOtherUsers: false,
    });

    const teammate = await get({ sinceMs: now - DAY, user: 'teammate' });
    expect(teammate.status).toBe(200);
    await expect(teammate.json()).resolves.toMatchObject({
      byUser: { teammate: { cost: 1 } },
      includesOtherUsers: true,
    });
  });

  it('returns all-time totals for an exact historical workload ID', async () => {
    const now = Date.now();
    await createTestWorkload(
      'route-historical-cost',
      'test-user',
      WorkloadState.Completed,
    );
    await addVmLifetime(
      'route-historical-cost',
      now - 60 * DAY,
      now - 59 * DAY,
    );

    const response = await get({ id: 'route-historical-cost' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: 'route-historical-cost',
        vmDurationMs: DAY,
        totalCost: 24,
      }),
    ]);
  });
});
