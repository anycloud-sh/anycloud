import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNotificationsStore,
  getProvisioningAttemptStore as ledger,
} from '../../../src/api/services/persistence.js';
import {
  runVmReleaseNotificationsOnce,
  VM_RELEASE_ALERT_COOLDOWN_MS,
  VM_RELEASE_ALERT_THRESHOLD_MS,
  VM_RELEASE_WORKLOAD_SAMPLE_LIMIT,
} from '../../../src/api/services/vm-release-notifications.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { log } from '../../../src/api/services/logger.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  installFakeSlack,
  TEST_SLACK_WEBHOOK,
  type FakeSlack,
} from '../../helpers/fake-slack.js';
import { createTestWorkload, resetTestStore } from '../utils.js';
import {
  provisionTestVm,
  releaseTestVms,
  walkToState,
} from '../../helpers/workload-store.js';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

async function overdueWorkload(
  id: string,
  options: { vmCount?: number; ip?: boolean } = {},
): Promise<string[]> {
  const vmCount = options.vmCount ?? 1;
  await createTestWorkload(id, 'alice');
  const cloudIds: string[] = [];
  for (let index = 0; index < vmCount; index += 1) {
    const cloudId = `${id}-vm-${index + 1}`;
    cloudIds.push(cloudId);
    if (options.ip === false) {
      await provisionTestVm(id, { cloudId }, { region: 'us-east-1' });
    } else {
      await provisionTestVm(id, {
        cloudId,
        ip: `192.0.2.${index + 10}`,
      });
    }
  }
  await walkToState(id, WorkloadState.Terminated);
  await ledger().claimVmRemoval(id, cloudIds);
  await getDB().query(
    `UPDATE vms SET removal_requested_at = ? WHERE workload_id = ?`,
    [NOW - VM_RELEASE_ALERT_THRESHOLD_MS, id],
  );
  return cloudIds;
}

async function configureSlack(): Promise<void> {
  await getNotificationsStore().saveChannel('slack', {
    webhook: TEST_SLACK_WEBHOOK,
  });
}

describe('VM release notifications', () => {
  let slack: FakeSlack;

  beforeEach(async () => {
    await resetTestStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('ANYCLOUD_API_LABEL', 'vm-release-tests');
    slack = installFakeSlack();
  });

  afterEach(() => {
    slack.restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('sends one aggregate initial alert and one reminder per cooldown', async () => {
    await overdueWorkload('release-alert-a', { vmCount: 2 });
    await overdueWorkload('release-alert-b', { ip: false });
    await configureSlack();

    await runVmReleaseNotificationsOnce();
    await runVmReleaseNotificationsOnce();

    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({
      url: TEST_SLACK_WEBHOOK,
      body: {
        text: expect.stringContaining('*anycloud: VM release delayed*'),
      },
    });
    expect(slack.posts[0].body.text).toContain(
      '3 VMs across 2 workloads remain unreleased',
    );
    expect(slack.posts[0].body.text).toContain('release-alert-a');
    expect(slack.posts[0].body.text).toContain('release-alert-b');
    expect(slack.posts[0].body.text).toContain('API: vm-release-tests');
    await expect(
      getNotificationsStore().readReceipt('vm-release-alert'),
    ).resolves.toBe(String(NOW));

    vi.setSystemTime(NOW + VM_RELEASE_ALERT_COOLDOWN_MS - 1);
    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(1);

    vi.setSystemTime(NOW + VM_RELEASE_ALERT_COOLDOWN_MS);
    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1].body.text).toContain(
      '*anycloud: VM release still delayed*',
    );
  });

  it('bounds the displayed workloads while preserving aggregate counts', async () => {
    const workloadCount = VM_RELEASE_WORKLOAD_SAMPLE_LIMIT + 3;
    for (let index = 0; index < workloadCount; index += 1) {
      await overdueWorkload(`release-alert-many-${index}`);
    }
    await configureSlack();

    await runVmReleaseNotificationsOnce();

    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0].body.text).toContain(
      `${workloadCount} VMs across ${workloadCount} workloads`,
    );
    expect(slack.posts[0].body.text).toContain('and 3 more workloads');
  });

  it('folds newly overdue VMs into the existing incident until its reminder', async () => {
    await overdueWorkload('release-alert-original');
    await configureSlack();
    await runVmReleaseNotificationsOnce();

    await overdueWorkload('release-alert-joined');
    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(1);

    vi.setSystemTime(NOW + VM_RELEASE_ALERT_COOLDOWN_MS);
    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1].body.text).toContain(
      '2 VMs across 2 workloads remain unreleased',
    );
  });

  it('silently resets after release so a later incident gets an initial alert', async () => {
    const [cloudId] = await overdueWorkload('release-alert-resolved');
    await configureSlack();
    await runVmReleaseNotificationsOnce();

    await releaseTestVms('release-alert-resolved', cloudId);
    await runVmReleaseNotificationsOnce();
    await runVmReleaseNotificationsOnce();

    expect(slack.posts).toHaveLength(1);
    await expect(
      getNotificationsStore().readReceipt('vm-release-alert'),
    ).resolves.toBeNull();

    await overdueWorkload('release-alert-later');
    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1].body.text).toContain(
      '*anycloud: VM release delayed*',
    );
    expect(slack.posts[1].body.text).not.toContain('still delayed');
  });

  it('honors Slack Retry-After without recording a successful alert', async () => {
    await overdueWorkload('release-alert-rate-limited');
    await configureSlack();
    slack.failNext(429, 'rate_limited', { 'Retry-After': '5' });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await runVmReleaseNotificationsOnce();
    await expect(
      getNotificationsStore().readReceipt('vm-release-alert'),
    ).resolves.toBeNull();
    expect(slack.posts).toHaveLength(1);

    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(1);
    expect(
      warn.mock.calls.filter(
        ([message]) => message === 'Notification send rate limited',
      ),
    ).toHaveLength(1);

    vi.setSystemTime(NOW + 5_001);
    await runVmReleaseNotificationsOnce();
    expect(slack.posts).toHaveLength(2);
    await expect(
      getNotificationsStore().readReceipt('vm-release-alert'),
    ).resolves.toBe(String(NOW + 5_001));
  });

  it('retries a rejected webhook without committing the cooldown', async () => {
    await overdueWorkload('release-alert-retry');
    await configureSlack();
    slack.failNext(500, 'try later');

    await runVmReleaseNotificationsOnce();
    await runVmReleaseNotificationsOnce();

    expect(slack.posts).toHaveLength(2);
    await expect(
      getNotificationsStore().readReceipt('vm-release-alert'),
    ).resolves.toBe(String(NOW));
  });

  it('does not open an incident without a configured notifier', async () => {
    await overdueWorkload('release-alert-unconfigured');

    await runVmReleaseNotificationsOnce();

    expect(slack.posts).toEqual([]);
    await expect(
      getNotificationsStore().readReceipt('vm-release-alert'),
    ).resolves.toBeNull();
  });
});
