import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  aggregateDigest,
  runNotificationsDigestOnce,
} from '../../../src/api/services/notifications-digest.js';
import { foldLocalApiOwners } from '../../../src/api/services/notifications-digest-owners.js';
import { formatDigestNotification } from '../../../src/api/services/notifications-digest-format.js';
import {
  getNotificationsStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  preemptTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';
import {
  type WorkloadTypeStarts,
  type UserWorkloadStarts,
} from '../../../src/api/services/repositories/workload-spend.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  WorkloadState,
  type WorkloadTypeValue,
} from '../../../src/shared/workload.js';
import config from '../../../src/api/config.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

// Seed the sentinel so runNotificationsDigestOnce skips its first-run guard
// and proceeds to post for yesterday. Use a date older than yesterday so the
// >= comparison treats yesterday as "needs posting."
async function seedSentinelOlderThanYesterday(): Promise<void> {
  await getNotificationsStore().writeReceipt('digest', '2020-01-01');
}

const TEST_WEBHOOK = 'https://hooks.slack.com/services/T/B/x';

// Configure a notification channel — the URL is never actually called (fetch
// is mocked); the monitor just needs a channel to load.
async function enableSlack(): Promise<void> {
  await getNotificationsStore().saveChannel('slack', {
    webhook: TEST_WEBHOOK,
  });
}

function row(overrides: {
  state: WorkloadState;
  workloadType?: WorkloadTypeValue;
  userId?: string;
  ownerUserId?: string;
  wasPreempted?: boolean;
  startedAt?: number;
  completedAt?: number | null;
}): {
  workloadType: WorkloadTypeValue;
  state: WorkloadState;
  userId: string;
  ownerUserId: string | null;
  wasPreempted: boolean;
  startedAt: number;
  completedAt: number | null;
} {
  return {
    workloadType: overrides.workloadType ?? 'job',
    state: overrides.state,
    userId: overrides.userId ?? 'alice',
    ownerUserId: overrides.ownerUserId ?? null,
    wasPreempted: overrides.wasPreempted ?? false,
    startedAt: overrides.startedAt ?? 0,
    completedAt: overrides.completedAt ?? null,
  };
}

const noStarts = (): WorkloadTypeStarts => ({
  initialSubmissions: 0,
  resubmissions: 0,
});

function starts(
  overrides: {
    jobs?: Partial<WorkloadTypeStarts>;
    services?: Partial<WorkloadTypeStarts>;
    vms?: Partial<WorkloadTypeStarts>;
    users?: Array<{
      userId: string;
      ownerUserId?: string;
      jobs?: Partial<WorkloadTypeStarts>;
      services?: Partial<WorkloadTypeStarts>;
      vms?: Partial<WorkloadTypeStarts>;
    }>;
  } = {},
): {
  jobs: WorkloadTypeStarts;
  services: WorkloadTypeStarts;
  vms: WorkloadTypeStarts;
  users: UserWorkloadStarts[];
} {
  const jobs = { ...noStarts(), ...overrides.jobs };
  const services = { ...noStarts(), ...overrides.services };
  const vms = { ...noStarts(), ...overrides.vms };
  const defaultUsers =
    jobs.initialSubmissions > 0 ||
    jobs.resubmissions > 0 ||
    services.initialSubmissions > 0 ||
    services.resubmissions > 0 ||
    vms.initialSubmissions > 0 ||
    vms.resubmissions > 0
      ? [
          {
            userId: 'alice',
            ownerUserId: null,
            jobs,
            services,
            vms,
          },
        ]
      : [];
  return {
    jobs,
    services,
    vms,
    users:
      overrides.users?.map((user) => ({
        userId: user.userId,
        ownerUserId: user.ownerUserId ?? null,
        jobs: { ...noStarts(), ...user.jobs },
        services: { ...noStarts(), ...user.services },
        vms: { ...noStarts(), ...user.vms },
      })) ?? defaultUsers,
  };
}

describe('aggregateDigest', () => {
  it('returns empty summary on empty input', () => {
    const s = aggregateDigest([], starts());
    expect(s.jobs.initialSubmissions).toBe(0);
    expect(s.jobs.resubmissions).toBe(0);
    expect(s.jobs.total).toBe(0);
    expect(s.services.total).toBe(0);
    expect(s.users).toEqual([]);
    expect(s.jobs.p50RuntimeMs).toBeNull();
  });

  it('counts by state', () => {
    const s = aggregateDigest(
      [
        row({ state: WorkloadState.Completed }),
        row({ state: WorkloadState.Completed }),
        row({ state: WorkloadState.Failed }),
        row({ state: WorkloadState.Errored }),
        row({ state: WorkloadState.Terminated }),
        row({ state: WorkloadState.Invalid }),
      ],
      starts(),
    );
    expect(s.jobs.total).toBe(6);
    expect(s.jobs.completed).toBe(2);
    expect(s.jobs.failed).toBe(1);
    expect(s.jobs.errored).toBe(1);
    expect(s.jobs.terminated).toBe(1);
    expect(s.jobs.invalid).toBe(1);
    expect(s.services.total).toBe(0);
  });

  it('partitions rows and starts between jobs, services, and VMs', () => {
    const s = aggregateDigest(
      [
        row({ state: WorkloadState.Completed }),
        row({
          state: WorkloadState.Terminated,
          workloadType: 'service',
          wasPreempted: true,
          userId: 'bob',
        }),
        row({
          state: WorkloadState.Terminated,
          workloadType: 'vm',
          userId: 'carol',
        }),
      ],
      starts({
        jobs: { initialSubmissions: 2, resubmissions: 1 },
        services: { initialSubmissions: 1 },
        vms: { initialSubmissions: 3 },
        users: [
          {
            userId: 'alice',
            jobs: { initialSubmissions: 2, resubmissions: 1 },
          },
          { userId: 'bob', services: { initialSubmissions: 1 } },
          { userId: 'carol', vms: { initialSubmissions: 3 } },
        ],
      }),
    );
    expect(s.jobs.total).toBe(1);
    expect(s.jobs.completed).toBe(1);
    expect(s.jobs.initialSubmissions).toBe(2);
    expect(s.jobs.resubmissions).toBe(1);
    expect(s.jobs.preempted).toBe(0);
    expect(s.services.total).toBe(1);
    expect(s.services.terminated).toBe(1);
    expect(s.services.initialSubmissions).toBe(1);
    expect(s.services.preempted).toBe(1);
    expect(s.vms.total).toBe(1);
    expect(s.vms.terminated).toBe(1);
    expect(s.vms.initialSubmissions).toBe(3);
    expect(s.vms.resubmissions).toBe(0);
    expect(s.users.map((user) => user.userId)).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(s.users[0].jobs.initialSubmissions).toBe(2);
    expect(s.users[0].jobs.completed).toBe(1);
    expect(s.users[1].services.initialSubmissions).toBe(1);
    expect(s.users[1].services.terminated).toBe(1);
    expect(s.users[2].vms.initialSubmissions).toBe(3);
    expect(s.users[2].vms.terminated).toBe(1);
  });

  it('reports preempted workloads', () => {
    const s = aggregateDigest(
      [
        row({
          state: WorkloadState.Completed,
          wasPreempted: true,
        }),
        row({ state: WorkloadState.Completed }),
        row({
          state: WorkloadState.Completed,
          wasPreempted: true,
        }),
      ],
      starts({
        jobs: { initialSubmissions: 4, resubmissions: 2 },
      }),
    );
    expect(s.jobs.initialSubmissions).toBe(4);
    expect(s.jobs.resubmissions).toBe(2);
    expect(s.jobs.preempted).toBe(2);
    expect(s.users.map((user) => user.userId)).toEqual(['alice']);
    expect(s.users[0].jobs.preempted).toBe(2);
  });

  it('uses and sorts activity users when no workload ended', () => {
    const s = aggregateDigest(
      [],
      starts({
        jobs: { initialSubmissions: 1, resubmissions: 2 },
        users: [
          { userId: 'bob', jobs: { resubmissions: 2 } },
          { userId: 'alice', jobs: { initialSubmissions: 1 } },
        ],
      }),
    );
    expect(s.jobs.initialSubmissions).toBe(1);
    expect(s.jobs.resubmissions).toBe(2);
    expect(s.users.map((user) => user.userId)).toEqual(['alice', 'bob']);
    expect(s.users[0].jobs.initialSubmissions).toBe(1);
    expect(s.users[1].jobs.resubmissions).toBe(2);
  });

  it('computes p50 runtime from completedAt - startedAt', () => {
    const s = aggregateDigest(
      [
        row({
          state: WorkloadState.Completed,
          startedAt: 0,
          completedAt: 1000,
        }),
        row({
          state: WorkloadState.Completed,
          startedAt: 0,
          completedAt: 3000,
        }),
        row({
          state: WorkloadState.Completed,
          startedAt: 0,
          completedAt: 5000,
        }),
      ],
      starts(),
    );
    expect(s.jobs.p50RuntimeMs).toBe(3000);
  });

  it('ignores rows with no completedAt for p50', () => {
    const s = aggregateDigest(
      [row({ state: WorkloadState.Failed, startedAt: 0, completedAt: null })],
      starts(),
    );
    expect(s.jobs.p50RuntimeMs).toBeNull();
  });
});

describe('foldLocalApiOwners', () => {
  it('reports owners before and after local ownership as one local owner', () => {
    const localOwner = 'local:0123456789abcdef0123456789abcdef';
    const done = (userId: string, ownerUserId: string) =>
      row({ state: WorkloadState.Completed, userId, ownerUserId });
    const summary = aggregateDigest(
      [
        done('octocat', '583231'),
        done('local', localOwner),
        done('local', localOwner),
      ],
      starts(),
    );
    const spend = {
      runningCost: 0,
      costSource: 'actual' as const,
      activeVmCount: 0,
      unpricedVmCount: 0,
      durationMs: 0,
    };
    const folded = foldLocalApiOwners(summary, {
      jobs: spend,
      services: spend,
      vms: spend,
      users: [],
    });

    expect(folded.summary.users).toEqual([
      {
        userId: 'local',
        ownerUserId: localOwner,
        jobs: summary.jobs,
        services: summary.services,
        vms: summary.vms,
      },
    ]);
    expect(folded.summary.jobs.completed).toBe(3);
    const { text } = formatDigestNotification(
      '2026-11-04',
      folded.summary,
      folded.spend,
    );
    expect(text).not.toContain('👤');
  });
});

// End-to-end: seed through `createWorkload` with terminal-state rows that
// fall in yesterday's UTC range, point `fetch` at a capture mock, and call
// runNotificationsDigestOnce. Asserts the full SQL → aggregate → format →
// send pipeline.
describe('runNotificationsDigestOnce (end-to-end)', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  const fetchMock = vi.fn();

  beforeAll(() => {
    // Real cipher.key required so toStoredWorkload can decrypt secret fields.
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'anycloud-digest-e2e-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    resetPersistence();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('counts only spot workloads as preempted, not on-demand cloud stops', async () => {
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    for (const spot of [true, false]) {
      const id = `cloud-stopped-${spot ? 'spot' : 'on-demand'}`;
      await createWorkload(getDB(), {
        id,
        userId: 'alice',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.medium',
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'ssh-test-key',
        credentialId: 'cred-1',
        spot,
      });
      await provisionTestVm(id, { ip: '10.0.0.9', cloudId: `i-${id}` });
      await preemptTestVm(id, `i-${id}`);
      await walkToState(id, WorkloadState.Failed);
    }

    const rows = await queries().listTerminalWorkloadsByDateRange(
      0,
      Date.now() + 1,
    );

    expect(Object.fromEntries(rows.map((r) => [r.id, r.wasPreempted]))).toEqual(
      { 'cloud-stopped-spot': true, 'cloud-stopped-on-demand': false },
    );
  });

  it('aggregates yesterday and POSTs the digest', async () => {
    // Yesterday's UTC range — matches yesterdayUtcRange() in notifications-digest.ts.
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const startMs = endMs - 24 * 60 * 60 * 1000;
    const yesterdayMidday = startMs + 12 * 60 * 60 * 1000;

    // FK seed.
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    const baseInput = {
      userId: 'alice',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      version: '0.1.17',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
      spot: true,
    };

    // Seed three terminal-state workloads completed yesterday.
    await createWorkload(getDB(), { ...baseInput, id: 'd-completed' });
    await createWorkload(getDB(), { ...baseInput, id: 'd-failed' });
    await createWorkload(getDB(), {
      ...baseInput,
      id: 'd-other-completed',
      userId: 'bob',
    });
    // Seed VMs: one normal + one preempted on d-completed; both with price.
    const vms = [
      ['d-completed', '10.0.0.2', 'i-bbb', 0.05, 60],
      ['d-completed', '10.0.0.1', 'i-aaa', 0.05, 60],
      ['d-failed', '10.0.0.3', 'i-ccc', 0.1, 30],
      ['d-other-completed', '10.0.0.4', 'i-ddd', 0.2, 60],
    ] as const;
    for (const [id, ip, cloudId, pricePerHour] of vms) {
      await provisionTestVm(
        id,
        { ip, cloudId },
        { region: 'us-east-1', pricePerHour }, // $/hour
      );
      if (cloudId === 'i-bbb') {
        // Recovery replaces the preempted VM once it is gone.
        await preemptTestVm(id, cloudId);
        await releaseTestVms(id, cloudId);
        await walkToState(id, WorkloadState.Provisioning);
      }
    }
    for (const id of ['d-completed', 'd-failed', 'd-other-completed']) {
      await walkToState(
        id,
        id === 'd-failed' ? WorkloadState.Failed : WorkloadState.Completed,
      );
      // createWorkload and walkToState stamp today's times; pin both metrics
      // to yesterday's UTC reporting window.
      await getDB().query(
        `UPDATE workloads
         SET started_at = ?, submitted_at = ?, completed_at = ?
         WHERE id = ?`,
        [
          yesterdayMidday - 60_000,
          yesterdayMidday - 60_000,
          yesterdayMidday,
          id,
        ],
      );
    }

    // End every VM after its runtime so cost is deterministic.
    for (const [id, , cloudId, , minutes] of vms) {
      await releaseTestVms(id, cloudId);
      await getDB().query(
        `UPDATE vms SET created_at = ?, ended_at = ? WHERE cloud_id = ?`,
        [yesterdayMidday, yesterdayMidday + minutes * 60 * 1000, cloudId],
      );
    }

    await enableSlack();
    await seedSentinelOlderThanYesterday();

    await runNotificationsDigestOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/T/B/x');
    const body = JSON.parse((init as { body: string }).body);
    const text = body.text as string;
    const [block] = body.blocks;
    const lists = block.elements.filter(
      (element: { type: string }) => element.type === 'rich_text_list',
    );
    expect(lists.some((list: { indent: number }) => list.indent === 0)).toBe(
      true,
    );
    expect(lists.some((list: { indent: number }) => list.indent === 1)).toBe(
      true,
    );
    expect(text).toContain('*anycloud usage on ');
    expect(text).toContain('(UTC)*');
    expect(text).toContain('*👤 alice*');
    expect(text).toContain('*👤 bob*');
    const aliceStart = text.indexOf('*👤 alice*');
    const bobStart = text.indexOf('*👤 bob*');
    expect(aliceStart).toBeLessThan(bobStart);
    const aliceSection = text.slice(aliceStart, bobStart);
    const bobSection = text.slice(bobStart);
    expect(aliceSection).toContain('🚀 2 initial submissions');
    expect(aliceSection).toContain('🏁 2 ended');
    expect(aliceSection).toContain('✅ 1 completed');
    expect(aliceSection).toContain('❌ 1 failed');
    expect(aliceSection).toContain(
      '⚡ 1 was preempted at least once during its run (50%)',
    );
    expect(bobSection).toContain('🚀 1 initial submission');
    expect(bobSection).toContain('🏁 1 ended');
    expect(bobSection).toContain('✅ 1 completed');
    expect(bobSection).not.toContain('❌');
    expect(text).not.toContain('🔁');
    // d-completed: 2 VMs × 1h × $0.05 = $0.10. d-failed: 1 VM × 0.5h × $0.10 = $0.05.
    // d-other-completed: 1 VM × 1h × $0.20 = $0.20.
    // No v.cost on any VM → estimated.
    expect(text).toContain('💰 Compute spend: $0.35 (est.)');
    expect(aliceSection).toContain(
      '📦 Jobs — $0.15 (est.) · 2.5h across 3 VMs',
    );
    expect(bobSection).toContain('📦 Jobs — $0.20 (est.) · 1.0h across 1 VM');
    expect(text).not.toContain('🌐 Services');
  });

  it('reports a local API as one unnamed owner, including rows from before local ownership', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const yesterdayMidday = endMs - 12 * 60 * 60 * 1000;
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    const baseInput = {
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      version: '0.1.17',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    };
    const workloads = [
      ['before-local', 'octocat', '583231', 'i-github'],
      [
        'after-local',
        'local',
        'local:0123456789abcdef0123456789abcdef',
        'i-local',
      ],
    ] as const;
    for (const [id, userId, ownerUserId, cloudId] of workloads) {
      await createWorkload(getDB(), { ...baseInput, id, userId, ownerUserId });
      await provisionTestVm(
        id,
        { ip: '10.0.0.1', cloudId },
        { region: 'us-east-1', pricePerHour: 1 },
      );
      await walkToState(id, WorkloadState.Completed);
      await releaseTestVms(id, cloudId);
      await getDB().query(
        `UPDATE workloads SET started_at = ?, submitted_at = ?, completed_at = ?
         WHERE id = ?`,
        [
          yesterdayMidday - 60_000,
          yesterdayMidday - 60_000,
          yesterdayMidday,
          id,
        ],
      );
      await getDB().query(
        `UPDATE vms SET created_at = ?, ended_at = ? WHERE cloud_id = ?`,
        [yesterdayMidday, yesterdayMidday + 60 * 60 * 1000, cloudId],
      );
    }

    await enableSlack();
    await seedSentinelOlderThanYesterday();
    await runNotificationsDigestOnce();

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    const text = body.text as string;
    expect(text).not.toContain('👤');
    expect(JSON.stringify(body.blocks)).not.toContain('👤');
    expect(text).not.toContain('octocat');
    expect(text).toContain('🚀 2 initial submissions');
    expect(text).toContain('✅ 2 completed');
    expect(text).toContain('📦 Jobs — $2.00 (est.) · 2.0h across 2 VMs');
  });

  it('reports a terminal outcome exactly once at T1 before cleanup completes', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const startMs = endMs - 24 * 60 * 60 * 1000;
    const outcomeAt = startMs + 12 * 60 * 60 * 1000;
    const startedAt = outcomeAt - 60 * 60 * 1000;
    const vmEndedAt = outcomeAt + 2 * 60 * 60 * 1000;
    const cleanedAt = endMs + 60 * 60 * 1000;

    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'd-cleaning-outcome',
      userId: 'alice',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    await provisionTestVm(
      'd-cleaning-outcome',
      { ip: '10.0.0.10', cloudId: 'i-cleaning' },
      { region: 'us-east-1', pricePerHour: 1 },
    );
    await walkToState('d-cleaning-outcome', WorkloadState.Running);
    await getDB().query(
      `UPDATE workloads
       SET started_at = ?, submitted_at = ?
       WHERE id = ?`,
      [startedAt, startedAt, 'd-cleaning-outcome'],
    );
    await getDB().query(
      `UPDATE workload_events
       SET created_at = ?
       WHERE workload_id = ?`,
      [startedAt, 'd-cleaning-outcome'],
    );
    await getDB().query(
      `UPDATE vms SET created_at = ?, ended_at = NULL WHERE workload_id = ?`,
      [startedAt, 'd-cleaning-outcome'],
    );

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(outcomeAt);
    try {
      await getWorkloadOutcomes().publishTerminalOutcome(
        'd-cleaning-outcome',
        WorkloadState.Completed,
        WorkloadState.Running,
        { metadata: { exitCode: 0 } },
      );
      nowSpy.mockReturnValue(vmEndedAt);
      await releaseTestVms('d-cleaning-outcome', 'i-cleaning');
    } finally {
      nowSpy.mockRestore();
    }
    expect(await queries().getWorkload('d-cleaning-outcome')).toMatchObject({
      state: WorkloadState.Completed,
      completedAt: outcomeAt,
    });

    await enableSlack();
    await seedSentinelOlderThanYesterday();

    await runNotificationsDigestOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const text = (
      JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
        text: string;
      }
    ).text;
    expect(text).toContain('🚀 1 initial submission');
    expect(text).toContain('🏁 1 ended');
    expect(text).toContain('✅ 1 completed');
    expect(text).toContain('💰 Compute spend: $3.00 (est.)');

    const cleanupSpy = vi.spyOn(Date, 'now').mockReturnValue(cleanedAt);
    try {
      await expect(
        getWorkloadOutcomes().markCleanupComplete('d-cleaning-outcome'),
      ).resolves.toBe(true);
    } finally {
      cleanupSpy.mockRestore();
    }

    await runNotificationsDigestOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await queries().getWorkload('d-cleaning-outcome')).toMatchObject({
      state: WorkloadState.Completed,
      completedAt: outcomeAt,
    });
    await expect(
      queries().listTerminalWorkloadsByDateRange(cleanedAt, cleanedAt + 1),
    ).resolves.toEqual([]);
    expect(
      (await eventLog().getWorkloadEvents('d-cleaning-outcome')).at(-1),
    ).toMatchObject({
      state: WorkloadState.Completed,
      created_at: outcomeAt,
    });
  });

  it('omits (est.) when every VM has billed cost recorded', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const startMs = endMs - 24 * 60 * 60 * 1000;
    const yesterdayMidday = startMs + 12 * 60 * 60 * 1000;

    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'd-actual',
      userId: 'alice',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    await provisionTestVm(
      'd-actual',
      { ip: '10.0.1.1', cloudId: 'i-zzz' },
      { region: 'us-east-1', pricePerHour: 0.05 },
    );
    await walkToState('d-actual', WorkloadState.Completed);
    await getDB().query(
      `UPDATE workloads
       SET started_at = ?, submitted_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        yesterdayMidday - 60_000,
        yesterdayMidday - 60_000,
        yesterdayMidday,
        'd-actual',
      ],
    );
    // Populate v.cost with the actual billed amount — the formula must pick
    // v.cost over the price*duration fallback.
    await getDB().query(
      `UPDATE vms SET created_at = ?, ended_at = ?, cost = ? WHERE workload_id = ?`,
      [yesterdayMidday, yesterdayMidday + 60 * 60 * 1000, 0.42, 'd-actual'],
    );

    await enableSlack();
    await seedSentinelOlderThanYesterday();

    await runNotificationsDigestOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const text = (
      JSON.parse((init as { body: string }).body) as { text: string }
    ).text;
    expect(text).toContain('💰 Compute spend: $0.42');
    expect(text).not.toContain('(est.)');
  });

  it('posts a digest when a workload was submitted but has not provisioned or ended', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const yesterdayMidday = endMs - 12 * 60 * 60 * 1000;

    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'queued-1',
      userId: 'alice',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    await getDB().query(
      `UPDATE workloads SET started_at = ?, submitted_at = ? WHERE id = ?`,
      [yesterdayMidday, yesterdayMidday, 'queued-1'],
    );

    await enableSlack();
    await seedSentinelOlderThanYesterday();

    await runNotificationsDigestOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const text = (
      JSON.parse((init as { body: string }).body) as { text: string }
    ).text;
    expect(text).toContain('*👤 alice*');
    expect(text).not.toContain('💰 Compute spend');
    expect(text).toContain('📦 Jobs');
    expect(text).toContain('🚀 1 initial submission');
    expect(text).not.toContain('🔁');
    expect(text).not.toContain('🏁');
  });

  it('posts a digest for a resubmission without another initial submission', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const startMs = endMs - 24 * 60 * 60 * 1000;
    const yesterdayMidday = startMs + 12 * 60 * 60 * 1000;

    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'resubmitted-1',
      userId: 'alice',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    await walkToState('resubmitted-1', WorkloadState.Failed);
    expect(
      await getWorkloadOutcomes().markCleanupComplete('resubmitted-1'),
    ).toBe(true);
    await getDB().query(
      `UPDATE workloads SET submitted_at = ?, started_at = ? WHERE id = ?`,
      [startMs - 1, startMs - 1, 'resubmitted-1'],
    );

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(yesterdayMidday);
    try {
      await getWorkloadOutcomes().resubmitWorkload('resubmitted-1');
    } finally {
      nowSpy.mockRestore();
    }

    await enableSlack();
    await seedSentinelOlderThanYesterday();

    await runNotificationsDigestOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const text = (
      JSON.parse((init as { body: string }).body) as { text: string }
    ).text;
    expect(text).toContain('*👤 alice*');
    expect(text).toContain('📦 Jobs');
    expect(text).not.toContain('🚀');
    expect(text).toContain('🔁 1 resubmission');
    expect(text).not.toContain('🏁');
  });

  it('posts a digest for a running service even with no completions', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const startMs = endMs - 24 * 60 * 60 * 1000;

    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'service-1',
      userId: 'alice',
      workloadType: 'service',
      image: 'nginx:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run nginx',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    // A live VM that started 10 days ago and is still running (ended_at NULL),
    // priced at $1/h → the full day inside the window = $24.
    await provisionTestVm(
      'service-1',
      { ip: '10.0.2.1', cloudId: 'i-srv' },
      { region: 'us-east-1', pricePerHour: 1 },
    );
    await walkToState('service-1', WorkloadState.Running);
    await getDB().query(
      `UPDATE vms SET created_at = ?, ended_at = NULL WHERE workload_id = ?`,
      [startMs - 10 * 24 * 60 * 60 * 1000, 'service-1'],
    );

    await enableSlack();
    await seedSentinelOlderThanYesterday();

    await runNotificationsDigestOnce();

    // No workload completed yesterday, but the service accrued a full day.
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const text = (
      JSON.parse((init as { body: string }).body) as { text: string }
    ).text;
    expect(text).toContain('*👤 alice*');
    expect(text).toContain('💰 Compute spend: $24.00 (est.)');
    expect(text).toContain('🌐 Services — $24.00 (est.) · 24.0h across 1 VM');
    expect(text).not.toContain('📦 Jobs');
    expect(text).not.toContain('🚀');
    expect(text).not.toContain('🏁');
  });

  it('posts the day notifications were enabled at the next UTC midnight', async () => {
    // Slack is enabled 30 minutes into yesterday (UTC). The workload ran the
    // day before that, before the channel existed, and must not be posted.
    const now = new Date();
    const todayMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const enableDayMs = todayMs - 24 * 60 * 60 * 1000;
    const enableDayLabel = new Date(enableDayMs).toISOString().slice(0, 10);
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    for (const id of ['before-enable', 'enable-day']) {
      await createWorkload(getDB(), {
        id,
        userId: 'alice',
        workloadType: 'job' as const,
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.medium',
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'ssh-test-key',
        credentialId: 'cred-1',
      });
      await walkToState(id, WorkloadState.Completed);
    }
    await getDB().query(`UPDATE workloads SET completed_at = ? WHERE id = ?`, [
      enableDayMs - 12 * 60 * 60 * 1000,
      'before-enable',
    ]);
    await getDB().query(`UPDATE workloads SET completed_at = ? WHERE id = ?`, [
      enableDayMs + 12 * 60 * 60 * 1000,
      'enable-day',
    ]);
    await enableSlack();

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(enableDayMs + 30 * 60 * 1000);
      await runNotificationsDigestOnce();
      await runNotificationsDigestOnce();
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // First check after the enable day ends.
    await runNotificationsDigestOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body) as {
      text: string;
    };
    expect(payload.text).toContain(enableDayLabel);
    expect(payload.text).toContain('1 completed');
    await expect(getNotificationsStore().readReceipt('digest')).resolves.toBe(
      enableDayLabel,
    );

    await runNotificationsDigestOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a rejected digest and records delivery only after success', async () => {
    const now = new Date();
    const endMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'queued-1',
      userId: 'alice',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    await getDB().query(
      `UPDATE workloads SET started_at = ?, submitted_at = ? WHERE id = ?`,
      [endMs - 1, endMs - 1, 'queued-1'],
    );
    await enableSlack();
    await seedSentinelOlderThanYesterday();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'unavailable',
    });
    await runNotificationsDigestOnce();
    expect(await getNotificationsStore().readReceipt('digest')).toBe(
      '2020-01-01',
    );
    await runNotificationsDigestOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getNotificationsStore().readReceipt('digest')).toBe(
      new Date(endMs - 1).toISOString().slice(0, 10),
    );
  });

  it('skips POSTing when no notifications are configured', async () => {
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-1', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'd-1',
      userId: 'alice',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'cred-1',
    });
    await walkToState('d-1', WorkloadState.Completed);

    await runNotificationsDigestOnce();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
