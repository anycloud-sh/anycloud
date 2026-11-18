import { beforeEach, describe, expect, it } from 'vitest';
import {
  getDeploymentStore,
  resetPersistence,
  getWorkloadQueryStore as queries,
  getWorkloadSpendStore,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import {
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy.js';
import { aggregateDigest } from '../../../src/api/services/notifications-digest.js';
import { formatDigestNotification } from '../../../src/api/services/notifications-digest-format.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  seedDigestNodePoolVm,
  seedDigestDeployment,
  seedDigestTargetedJob,
} from '../../helpers/deployment-digest.js';
import {
  seedTestWorkload,
  provisionTestVm,
  walkToState,
} from '../../helpers/workload-store.js';

const startMs = 1_000;
const endMs = 2_000;

beforeEach(() => resetPersistence());

async function digest() {
  const store = queries();
  const rows = await store.listTerminalWorkloadsByDateRange(startMs, endMs);
  const starts = await getWorkloadSpendStore().summarizeWorkloadStartsInWindow(
    startMs,
    endMs,
  );
  const metadata = await getDeploymentStore().listDigestMetadataInWindow(
    startMs,
    endMs,
  );
  const summary = aggregateDigest(rows, starts, metadata);
  const spend = await getWorkloadSpendStore().sumVmSpendInWindow(
    startMs,
    endMs,
  );
  return {
    summary,
    spend,
    message: formatDigestNotification('2026-09-19', summary, spend),
  };
}

describe('Deployment digest inventory', () => {
  it('reconstructs day-end inventory and independent lifecycle events at UTC boundaries', async () => {
    for (const input of [
      { id: 'existing', createdAt: 500 },
      { id: 'created-at-start', createdAt: startMs },
      { id: 'created-at-end', createdAt: endMs },
      {
        id: 'deleted-at-start',
        createdAt: 500,
        deletionRequestedAt: 700,
        deletedAt: startMs,
      },
      {
        id: 'deleted-at-end',
        createdAt: 500,
        deletionRequestedAt: 1_500,
        deletedAt: endMs,
      },
      { id: 'deleted-before-day', createdAt: 500, deletedAt: startMs - 1 },
      { id: 'same-day', createdAt: 1_100, deletedAt: 1_500 },
      { id: 'pending-deletion', createdAt: 500, deletionRequestedAt: 1_500 },
    ]) {
      await seedDigestDeployment(input);
    }
    const rows = await getDeploymentStore().listDigestMetadataInWindow(
      startMs,
      endMs,
    );
    expect(
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            present: row.presentAtEnd,
            created: row.createdInWindow,
            deleted: row.deletedInWindow,
          },
        ]),
      ),
    ).toEqual({
      existing: { present: true, created: false, deleted: false },
      'created-at-start': { present: true, created: true, deleted: false },
      'deleted-at-start': { present: false, created: false, deleted: true },
      'deleted-at-end': { present: true, created: false, deleted: false },
      'same-day': { present: false, created: true, deleted: true },
      'pending-deletion': { present: true, created: false, deleted: false },
    });
    const { summary } = await digest();
    expect(summary.users[0].deployments).toEqual({
      presentAtEnd: 4,
      created: 2,
      deleted: 2,
      hasActivity: true,
    });
  });

  it.each([
    { name: 'live capacity', vmCreated: 500, expected: true },
    {
      name: 'capacity that scaled to zero during the day',
      vmCreated: 500,
      vmEnded: 1_600,
      expected: true,
    },
    {
      name: 'capacity removed after the reported day',
      vmCreated: 500,
      vmEnded: endMs + 100,
      expected: true,
    },
    {
      name: 'removal requested but not confirmed',
      vmCreated: 500,
      removalRequested: 900,
      expected: true,
    },
    {
      name: 'provisioning placeholder',
      vmCreated: 500,
      provisioned: false,
      expected: false,
    },
    {
      name: 'ended at the start boundary',
      vmCreated: 500,
      vmEnded: startMs,
      expected: false,
    },
    { name: 'created at the end boundary', vmCreated: endMs, expected: false },
    {
      name: 'zero-duration attempt',
      vmCreated: 1_200,
      vmEnded: 1_200,
      expected: false,
    },
    {
      name: 'capacity ended before Deployment creation',
      vmCreated: 500,
      vmEnded: 1_200,
      deploymentCreated: 1_300,
      expected: false,
    },
    {
      name: 'capacity started after Deployment deletion',
      vmCreated: 1_600,
      deploymentDeleted: 1_500,
      expected: false,
    },
  ])('qualifies VM usage for $name', async (scenario) => {
    await seedDigestDeployment({
      id: 'model',
      createdAt: scenario.deploymentCreated ?? 500,
      deletedAt: scenario.deploymentDeleted,
    });
    await seedDigestNodePoolVm({
      id: 'node',
      createdAt: scenario.vmCreated,
      endedAt: scenario.vmEnded,
      removalRequestedAt: scenario.removalRequested,
      provisioned: scenario.provisioned,
    });
    const [metadata] = await getDeploymentStore().listDigestMetadataInWindow(
      startMs,
      endMs,
    );
    expect(metadata.hasVmUsage).toBe(scenario.expected);
  });

  it('ignores other node pools and API-host VMs when qualifying idle inventory', async () => {
    await seedDigestDeployment({ id: 'idle', createdAt: 500 });
    await seedDigestDeployment({
      id: 'other',
      nodePoolId: 'other-pool',
      createdAt: 500,
    });
    await seedDigestNodePoolVm({
      id: 'other-node',
      nodePoolId: 'other-pool',
      createdAt: 500,
    });
    await seedTestWorkload({
      id: 'api-host',
      userId: 'owner',
      workloadType: 'service',
      state: WorkloadState.Provisioning,
    });
    await provisionTestVm('api-host', {
      ip: '192.0.2.2',
      cloudId: 'host-vm',
    });
    await walkToState('api-host', WorkloadState.Running);
    await getDB().query(
      'UPDATE vms SET created_at = 500 WHERE workload_id = ?',
      ['api-host'],
    );
    const rows = await getDeploymentStore().listDigestMetadataInWindow(
      startMs,
      endMs,
    );
    expect(rows.find((row) => row.id === 'idle')?.hasVmUsage).toBe(false);
    expect(rows.find((row) => row.id === 'other')?.hasVmUsage).toBe(true);
  });

  it('resolves account IDs from local identity metadata without reading container secrets', async () => {
    await upsertApiAccessOwner('alice-renamed', '77');
    await upsertApiAccessUser({ userId: '77', username: 'alice-old' });
    await upsertApiAccessUser({ userId: '88', username: 'bob-renamed' });
    for (const ownerUserId of ['77', '88', '99']) {
      await seedDigestDeployment({
        id: `owner-${ownerUserId}`,
        ownerUserId,
        createdAt: 1_100,
      });
    }
    await getDB().query(
      "UPDATE container_specs SET env = 'unreadable-ciphertext'",
    );
    const { summary, message } = await digest();
    expect(summary.users.map((user) => user.userId)).toEqual([
      'alice-renamed',
      'bob-renamed',
      'GitHub user 99',
    ]);
    expect(message.text).not.toContain('unreadable-ciphertext');
    expect(message.text).not.toContain('alice-old');
  });

  it('keeps different owners distinct when display usernames collide', async () => {
    await upsertApiAccessUser({ userId: '77', username: 'same-name' });
    await upsertApiAccessUser({ userId: '88', username: 'same-name' });
    await seedDigestDeployment({
      id: 'first',
      ownerUserId: '77',
      createdAt: 1_100,
    });
    await seedDigestDeployment({
      id: 'second',
      ownerUserId: '88',
      createdAt: 1_100,
    });
    const { summary, message } = await digest();
    expect(
      summary.users.map((user) => ({
        id: user.ownerUserId,
        count: user.deployments.presentAtEnd,
      })),
    ).toEqual([
      { id: '77', count: 1 },
      { id: '88', count: 1 },
    ]);
    expect(message.text).toContain('👤 same-name (GitHub user 77)');
    expect(message.text).toContain('👤 same-name (GitHub user 88)');
  });
});

describe('Deployment Job breakdowns', () => {
  it.each([true, false])(
    'separates an owner from a same-named submitter and VM spender (Job activity: %s)',
    async (hasJobActivity) => {
      await upsertApiAccessUser({ userId: '77', username: 'same-name' });
      await upsertApiAccessUser({ userId: '88', username: 'same-name' });
      await seedDigestDeployment({ id: 'model', createdAt: 1_100 });
      if (hasJobActivity) {
        await seedDigestTargetedJob({
          id: 'submitted-by-88',
          deploymentId: 'model',
          userId: 'same-name',
          ownerUserId: '88',
          submittedAt: 1_100,
          state: WorkloadState.Completed,
          completedAt: 1_500,
          resubmittedAt: [1_200],
        });
      }
      for (const [ownerUserId, pricePerHour] of [
        ['77', 3_600],
        ['88', 7_200],
      ] as const) {
        const id = `service-${ownerUserId}`;
        await seedTestWorkload({
          id,
          userId: 'same-name',
          ownerUserId,
          workloadType: 'service',
          state: WorkloadState.Provisioning,
        });
        await provisionTestVm(
          id,
          { ip: '192.0.2.2', cloudId: id, createdAt: 1_100 },
          { pricePerHour },
        );
        await walkToState(id, WorkloadState.Running);
        await getDB().query(
          'UPDATE workloads SET submitted_at = 500, started_at = 500 WHERE id = ?',
          [id],
        );
        await getDB().query(
          'UPDATE vms SET ended_at = 1600 WHERE workload_id = ?',
          [id],
        );
      }

      const { summary, spend, message } = await digest();
      expect(summary.jobs).toMatchObject({
        initialSubmissions: Number(hasJobActivity),
        resubmissions: Number(hasJobActivity),
        completed: Number(hasJobActivity),
      });
      expect(
        summary.users.find((user) => user.ownerUserId === '77'),
      ).toMatchObject({ jobs: { total: 0 }, deployments: { presentAtEnd: 1 } });
      expect(
        spend.users.map((user) => ({
          id: user.ownerUserId,
          cost: user.services.runningCost,
        })),
      ).toEqual([
        { id: '77', cost: 0.5 },
        { id: '88', cost: 1 },
      ]);
      expect(spend.services.runningCost).toBe(1.5);
      const sections = message.text.split('\n\n');
      const owner = sections.find((section) =>
        section.startsWith('*👤 same-name (GitHub user 77)*'),
      );
      const submitter = sections.find((section) =>
        section.startsWith('*👤 same-name (GitHub user 88)*'),
      );
      expect(owner).toContain('☸️ Kubernetes Deployments');
      expect(owner).toContain('$0.50');
      expect(owner).not.toContain('📦 Jobs');
      expect(submitter).toContain('$1.00');
      expect(submitter).not.toContain('☸️ Kubernetes Deployments');
      expect(
        submitter?.includes(
          'model / digest-pool: 1 submitted · 1 resubmitted · 1 completed',
        ),
      ).toBe(hasJobActivity);
    },
  );

  it('joins renamed Workload activity and spend to the same account inventory', async () => {
    await upsertApiAccessOwner('alice-renamed', '77');
    await seedDigestDeployment({ id: 'model', createdAt: 500 });
    for (const userId of ['alice', 'alice-renamed']) {
      await seedDigestTargetedJob({
        id: `job-${userId}`,
        deploymentId: 'model',
        userId,
        submittedAt: 1_100,
        completedAt: 1_500,
        state: WorkloadState.Completed,
        resubmittedAt: [1_200],
      });
      const id = `service-${userId}`;
      await seedTestWorkload({
        id,
        userId,
        ownerUserId: '77',
        workloadType: 'service',
        state: WorkloadState.Provisioning,
      });
      await provisionTestVm(
        id,
        { ip: '192.0.2.2', cloudId: id, createdAt: 1_100 },
        { pricePerHour: 3_600 },
      );
      await walkToState(id, WorkloadState.Running);
      await getDB().query(
        'UPDATE workloads SET submitted_at = 500 WHERE id = ?',
        [id],
      );
      await getDB().query(
        'UPDATE vms SET ended_at = 1600 WHERE workload_id = ?',
        [id],
      );
    }

    const { summary, spend, message } = await digest();
    expect(summary.users).toHaveLength(1);
    expect(summary.users[0]).toMatchObject({
      userId: 'alice-renamed',
      ownerUserId: '77',
      deployments: { presentAtEnd: 1 },
    });
    expect(summary.users[0].deploymentJobs).toMatchObject([
      {
        deploymentId: 'model',
        initialSubmissions: 2,
        resubmissions: 2,
        completed: 2,
      },
    ]);
    expect(spend.users).toHaveLength(1);
    expect(spend.users[0]).toMatchObject({
      userId: 'alice',
      ownerUserId: '77',
      services: { runningCost: 1, activeVmCount: 2 },
    });
    expect(message.text.match(/👤/g)).toHaveLength(1);
    expect(message.text).toContain('👤 alice-renamed');
    expect(message.text).toContain('$1.00');
    expect(message.text).not.toContain('*👤 alice*');
  });

  it('does not assign legacy Workloads to a same-named current account', async () => {
    await upsertApiAccessOwner('same-name', '77');
    await seedDigestDeployment({ id: 'model', createdAt: 1_100 });
    await seedTestWorkload({
      id: 'legacy',
      userId: 'same-name',
      state: WorkloadState.Completed,
    });
    await getDB().query(
      'UPDATE workloads SET submitted_at = 1100, started_at = 1100, completed_at = 1500 WHERE id = ?',
      ['legacy'],
    );

    const { summary, message } = await digest();
    expect(summary.users).toHaveLength(2);
    expect(
      summary.users.find((user) => user.ownerUserId === '77'),
    ).toMatchObject({
      jobs: { initialSubmissions: 0, total: 0 },
      deployments: { presentAtEnd: 1 },
    });
    expect(
      summary.users.find((user) => user.ownerUserId === null),
    ).toMatchObject({
      jobs: { initialSubmissions: 1, completed: 1 },
      deployments: { presentAtEnd: 0 },
    });
    expect(message.text).toContain('👤 same-name (GitHub user 77)');
    expect(message.text).toContain('👤 same-name (account ID unavailable)');
  });

  it('keeps owner inventory separate from submitter activity and preserves aggregate counts and spend', async () => {
    await upsertApiAccessOwner('alice', '77');
    await seedDigestDeployment({
      id: 'shared',
      name: 'inference',
      createdAt: 500,
    });
    await seedDigestDeployment({
      id: 'unknown-owner',
      ownerUserId: '99',
      createdAt: 500,
    });
    await seedDigestTargetedJob({
      id: 'new',
      deploymentId: 'shared',
      userId: 'bob',
      ownerUserId: '88',
      submittedAt: 1_100,
    });
    await seedDigestTargetedJob({
      id: 'finished',
      deploymentId: 'shared',
      userId: 'bob',
      ownerUserId: '88',
      submittedAt: 500,
      state: WorkloadState.Completed,
      completedAt: 1_600,
    });
    await seedDigestTargetedJob({
      id: 'retried',
      deploymentId: 'shared',
      userId: 'bob',
      ownerUserId: '88',
      submittedAt: 500,
      state: WorkloadState.Failed,
      completedAt: 1_700,
      resubmittedAt: [999, 1_000, 1_500],
    });
    await seedDigestTargetedJob({
      id: 'invalid',
      deploymentId: 'unknown-owner',
      submittedAt: 1_100,
      state: WorkloadState.Invalid,
      completedAt: 1_200,
    });
    await seedTestWorkload({
      id: 'vm-job',
      userId: 'bob',
      ownerUserId: '88',
      state: WorkloadState.Provisioning,
    });
    await provisionTestVm(
      'vm-job',
      { ip: '192.0.2.2', cloudId: 'billed-vm' },
      { pricePerHour: 3_600 },
    );
    await walkToState('vm-job', WorkloadState.Completed);
    await getDB().query(
      'UPDATE workloads SET submitted_at = 1100, started_at = 1100, completed_at = 1600 WHERE id = ?',
      ['vm-job'],
    );
    await getDB().query(
      'UPDATE vms SET created_at = 1100, ended_at = 1600 WHERE workload_id = ?',
      ['vm-job'],
    );

    const { summary, spend, message } = await digest();
    expect(summary.jobs).toMatchObject({
      initialSubmissions: 3,
      resubmissions: 2,
      total: 4,
      completed: 2,
      failed: 1,
      invalid: 1,
    });
    const bob = summary.users.find((user) => user.userId === 'bob');
    expect(bob?.jobs).toMatchObject({
      initialSubmissions: 2,
      resubmissions: 2,
      total: 3,
    });
    expect(bob?.deployments.hasActivity).toBe(false);
    expect(bob?.deploymentJobs).toMatchObject([
      {
        deploymentId: 'shared',
        initialSubmissions: 1,
        resubmissions: 2,
        total: 2,
        completed: 1,
        failed: 1,
      },
    ]);
    expect(
      summary.users.find((user) => user.userId === 'alice')?.deployments,
    ).toEqual({
      presentAtEnd: 1,
      created: 0,
      deleted: 0,
      hasActivity: true,
    });
    expect(
      summary.users.find((user) => user.userId === 'GitHub user 99')
        ?.deployments.hasActivity,
    ).toBe(true);
    expect(spend.jobs.runningCost).toBeCloseTo(0.5);
    expect(spend.jobs.activeVmCount).toBe(1);
    expect(message.text).toContain(
      'inference / digest-pool: 1 submitted · 2 resubmitted · 1 completed · 1 failed',
    );

    const structuredLines = message.slack?.blocks.flatMap((block) =>
      block.type === 'rich_text'
        ? block.elements.flatMap((element) =>
            element.type === 'rich_text_section'
              ? element.elements
                  .map((part) => part.text)
                  .join('')
                  .split('\n')
              : element.elements.map((line) =>
                  line.elements.map((part) => part.text).join(''),
                ),
          )
        : [],
    );
    expect(structuredLines).toEqual(
      message.text
        .split('\n')
        .map((line) => line.trim().replace(/^\*|\*$/g, ''))
        .filter(Boolean),
    );
  });

  it('bounds detail by activity, disambiguates recreated names, and totals the remainder', async () => {
    await seedDigestDeployment({ id: 'old', name: 'same', createdAt: 500 });
    await seedDigestTargetedJob({
      id: 'old-job',
      deploymentId: 'old',
      submittedAt: 1_050,
      state: WorkloadState.Completed,
      completedAt: 1_100,
      resubmittedAt: [1_070, 1_080],
    });
    await getDB().query(
      'UPDATE deployments SET deletion_requested_at = 1200, deleted_at = 1200 WHERE id = ?',
      ['old'],
    );
    await seedDigestDeployment({ id: 'new', name: 'same', createdAt: 1_200 });
    await seedDigestTargetedJob({
      id: 'new-job',
      deploymentId: 'new',
      submittedAt: 1_250,
      state: WorkloadState.Errored,
      completedAt: 1_500,
      resubmittedAt: [1_350, 1_400],
    });
    for (const [index, name] of [
      'zulu',
      'alpha',
      'beta',
      'quiet-a',
      'quiet-b',
    ].entries()) {
      await seedDigestDeployment({ id: name, createdAt: 500 });
      await seedDigestTargetedJob({
        id: `${name}-job`,
        deploymentId: name,
        submittedAt: 1_250,
        state: index === 4 ? WorkloadState.Failed : WorkloadState.Terminated,
        completedAt: 1_500,
        resubmittedAt:
          index === 0
            ? [1_300, 1_350, 1_400, 1_450]
            : index < 3
              ? [1_350, 1_400]
              : [1_350],
      });
    }
    const { message, summary } = await digest();
    const lines = message.text.split('\n').map((line) => line.trim());
    const breakdown = lines.slice(
      lines.indexOf('By Kubernetes Deployment — included above') + 1,
    );
    expect(breakdown.slice(0, 6)).toEqual([
      'zulu / digest-pool: 1 submitted · 4 resubmitted · 1 terminated',
      'alpha / digest-pool: 1 submitted · 2 resubmitted · 1 terminated',
      'beta / digest-pool: 1 submitted · 2 resubmitted · 1 terminated',
      'same / digest-pool (new): 1 submitted · 2 resubmitted · 1 errored',
      'same / digest-pool (old): 1 submitted · 2 resubmitted · 1 completed',
      '2 other Deployments: 2 submitted · 2 resubmitted · 1 failed · 1 terminated',
    ]);
    expect(summary.jobs).toMatchObject({
      initialSubmissions: 7,
      resubmissions: 14,
      total: 7,
      completed: 1,
      failed: 1,
      errored: 1,
      terminated: 4,
    });
    expect(message.text).not.toContain('quiet-a /');
    expect(message.text).not.toContain('quiet-b /');
  });

  it('counts resubmissions without creating an initial submission in that window', async () => {
    await seedDigestDeployment({ id: 'model', createdAt: 500 });
    await seedDigestTargetedJob({
      id: 'retry',
      deploymentId: 'model',
      submittedAt: 600,
      resubmittedAt: [999, 1_000, 1_500, 2_000],
    });
    const { summary, message } = await digest();
    expect(summary.jobs).toMatchObject({
      initialSubmissions: 0,
      resubmissions: 2,
      total: 0,
    });
    expect(message.text).toContain('model / digest-pool: 2 resubmitted');
    expect(message.text).not.toContain('initial submission');
  });

  it('reports terminal-only Job activity and owner inventory without backing VMs', async () => {
    await upsertApiAccessOwner('alice', '77');
    await seedDigestDeployment({ id: 'model', createdAt: 500 });
    await seedDigestTargetedJob({
      id: 'finished',
      deploymentId: 'model',
      submittedAt: 600,
      state: WorkloadState.Completed,
      completedAt: 1_500,
    });

    const { summary, message } = await digest();
    expect(summary.jobs).toMatchObject({
      initialSubmissions: 0,
      resubmissions: 0,
      total: 1,
      completed: 1,
    });
    expect(summary.users[0].deployments).toEqual({
      presentAtEnd: 1,
      created: 0,
      deleted: 0,
      hasActivity: true,
    });
    expect(message.text).toContain('model / digest-pool: 1 completed');
    expect(message.text).toContain('☸️ Kubernetes Deployments');
    expect(message.text).not.toContain('initial submission');
    expect(message.text).not.toContain('Compute spend');
  });
});
